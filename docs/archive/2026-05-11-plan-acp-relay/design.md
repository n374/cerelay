# Plan ACP Relay — IDE 直连 Cerelay 设计文档

> 状态：设计完成，待实施
> 关联文档：本目录 `plan-d-mcp-shadow-tools.md`、`.claude/acp-research.md`、`docs/acp-editor-integration.md`（已有但未实现）
> 目标场景：用户在 Zed / VS Code 里把 cerelay 当 ACP agent 用，工作流跟"本机装 CC"完全一样

---

## 1. 背景与定位

### 1.1 为什么要做

cerelay 当前的 PTY 模式给的是"远程 CC TUI"——用户开终端跟 CC 聊。但越来越多用户在 IDE 里用 ACP（Agent Client Protocol）协议接 agent（Zed 原生，VS Code 通过插件，JetBrains 在跟进）。这条用户路径下：

- 用户不想看 TUI，他要 IDE 里"侧边栏 chat + 主编辑区 diff 预览"
- 工具调用要被 IDE 拦截渲染（`session/notify` 里 `tool_call` 块带富信息）
- 文件读写直接落到 IDE 当前打开的工作区

cerelay 自己装上 ACP 入口后，**不依赖装 CC 的本地权重也能用 IDE 工作流**——所有推理 & 工具调度都在 server 侧 CC 上跑，IDE 看到的是无差别的 ACP agent。

### 1.2 与 Plan D 的关系

**两个方案是互补的，不是替代关系**：

| 方案 | 用户入口 | 推理在哪 | 工具拦截机制 |
|---|---|---|---|
| 现行 PTY 模式 | cerelay-client 终端 | server CC | PreToolUse hook |
| **Plan D**（升级现行 PTY 模式） | cerelay-client 终端 | server CC | **MCP shadow tools** |
| **ACP Relay**（新入口） | IDE / 编辑器 | server CC | **MCP shadow tools**（与 D 共享） |

ACP Relay 复用 Plan D 的 MCP shadow 基础设施——CC 怎么把工具调用送到 client 这件事，PTY 入口和 ACP 入口走同一条路（server 主进程的 ToolRelay）。差别只在"用户跟 CC 怎么交互"那一层。

**所以推荐先做 Plan D，再做 ACP Relay**。

### 1.3 协议事实清单（probe 验证过）

- **CC binary 不原生支持 ACP**——strings 里没有 `session/new`、`session/prompt` 等 ACP method 关键字，也不依赖 `@zed-industries/agent-client-protocol`
- **CC binary 原生支持 stream-json 协议**——`--input-format stream-json --output-format stream-json --verbose` 走 stdio，跟 Anthropic Agent SDK 用的是同一套
- **ACP 协议规范**：JSON-RPC 2.0 over NDJSON over stdio，由 Zed 主导，方法包括 `initialize`、`session/new`、`session/prompt`、`session/notify`、`fs/read_text_file`、`fs/write_text_file`、`session/cancel` 等

**所以"ACP 中转"的实质是**：cerelay-client 实现 ACP server（接 IDE），cerelay-server 把 CC 拉成 stream-json 模式（接 cerelay-server 自己），中间做协议转换。**不是透明 byte 转发**——两端协议不一样。

---

## 2. 设计目标

### 2.1 必须达成

- **G1** IDE 不需要装 CC——只配 cerelay-client 当 agent，所有推理走 server
- **G2** 文件读写发生在用户机器上（IDE 工作区 = cerelay-client 所在机器），不是 server
- **G3** 工具调用展示效果跟原生 CC-in-Zed 一致（流式、可中断、diff 预览）
- **G4** 复用 Plan D 的 MCP shadow tools，不重写工具转发逻辑
- **G5** 与现行 PTY 模式并存——用户可选 `cerelay-client tui` 或 `cerelay-client acp`

### 2.2 非目标

- ❌ 不实现完整 ACP 1.0 spec 所有 method（按 IDE 实际使用频次分阶段）
- ❌ 不在 cerelay-client 内嵌 IDE 编辑功能
- ❌ 不做 ACP authn/authz（IDE 跟 cerelay-client 之间是本地 stdio，CERELAY_KEY 仍管 client→server 段）

---

## 3. 整体架构

```
┌─────────────────┐
│   IDE / Editor  │
│  (Zed/VSCode)   │
│                 │
│  ACP Client     │
└────────┬────────┘
         │ stdio (NDJSON / JSON-RPC 2.0)
         │
┌────────▼─────────────────────────────────────────────┐
│  cerelay-client（用户机器，ACP 模式）                  │
│                                                      │
│  ┌──────────────────┐    ┌──────────────────────┐   │
│  │  ACP Server      │◄──►│  Local Tool Executor │   │
│  │  - initialize    │    │  - Bash / Read / ... │   │
│  │  - session/new   │    │  (复用现有 tools/)   │   │
│  │  - session/prompt│    └──────────────────────┘   │
│  │  - session/cancel│                               │
│  │  - fs/*          │                               │
│  └────────┬─────────┘                               │
│           │                                         │
│           │ ACP ↔ cerelay 协议适配                  │
│           ▼                                         │
│  ┌──────────────────┐                               │
│  │  Server Conn (WS)│                               │
│  └────────┬─────────┘                               │
└───────────┼─────────────────────────────────────────┘
            │ WebSocket（带 CERELAY_KEY 鉴权）
            │
┌───────────▼─────────────────────────────────────────┐
│  cerelay-server（容器内）                             │
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │  Session Manager                            │    │
│  │  - PTY session（旧入口仍支持）              │    │
│  │  - ACP session（本方案新增）                │    │
│  └────────────┬────────────────────────────────┘    │
│               │                                     │
│  ┌────────────▼─────────────────┐                   │
│  │  CC ACP Driver (stream-json) │                   │
│  │  - spawn claude --print      │                   │
│  │  --input-format stream-json  │                   │
│  │  --output-format stream-json │                   │
│  │  --mcp-config (Plan D 同款)  │                   │
│  └────────────┬─────────────────┘                   │
│               │ stdio JSON                          │
│               ▼                                     │
│  ┌──────────────────────────────┐                   │
│  │  CC subprocess               │                   │
│  │  + cerelay-routed MCP server │ ← Plan D 提供     │
│  └──────────────────────────────┘                   │
└─────────────────────────────────────────────────────┘
```

**关键设计**：
- **协议转换在 cerelay-client 做**——把 ACP 的 `session/prompt` 翻成 cerelay 内部协议，server 不感知 ACP
- **server 侧用 stream-json 驱动 CC**——比 PTY 模式更可控，能 100% 拿到结构化事件
- **MCP shadow 复用 Plan D**——工具拦截不需要重做

---

## 4. ACP 协议简述（实现需要的部分）

### 4.1 传输

- NDJSON over stdio（每行一个 JSON-RPC 2.0 消息）
- 客户端 → 服务端：`request` / `notification`
- 服务端 → 客户端：`response` / `notification`

### 4.2 必须实现的 method（v1）

| 方向 | Method | 用途 |
|---|---|---|
| Client→Server | `initialize` | 协议握手，交换 capabilities |
| Client→Server | `session/new` | 新会话，返回 sessionId |
| Client→Server | `session/prompt` | 用户发消息（含上下文 attachments） |
| Client→Server | `session/cancel` | 中断当前回合 |
| Server→Client | `session/notify` | 流式回传：思考块、文本块、tool_call、tool_result |
| Server→Client | `fs/read_text_file` | 让 IDE 读文件（IDE 知道哪些 buffer 有 unsaved changes） |
| Server→Client | `fs/write_text_file` | 让 IDE 写文件（IDE 渲染 diff 预览 + 用户确认） |

### 4.3 capabilities 协商

cerelay-client 在 `initialize` 响应里声明：
```json
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "promptCapabilities": {
      "image": true,
      "audio": false,
      "embeddedContext": true
    },
    "mcpCapabilities": {
      "http": false,
      "sse": false
    }
  }
}
```

具体能力清单参考 `.claude/acp-research.md` 第 3 节。

### 4.4 重要语义：fs/* 是 server→client 的请求

ACP 设计跟 LSP 一样**双向**：agent 想读文件，发 `fs/read_text_file` 给 IDE，IDE 返回内容（**包含 unsaved changes**）。这是 ACP 比"自己 fs 读"强的核心点——能拿到编辑器内的脏 buffer。

cerelay-client 实现 ACP server 时，要实现"agent 侧读写"的代理：
- agent 发起的 fs read → 转给 IDE 处理
- 但是 cerelay 侧的 MCP `mcp__cerelay__read` 是工具调用，**不应该**走 ACP fs 通道（工具调用是给模型展示用的，IDE 要看到这是一个工具调用而不是后台读文件）

详见第 6 节"协议映射"。

---

## 5. cerelay-client 改造

### 5.1 入口与子命令

新增子命令 `cerelay-client acp`：

```bash
# 启动 ACP server，stdio 接 IDE
cerelay-client acp \
  --server <host:port> \
  --key <CERELAY_KEY> \
  --cwd <project-root>

# IDE 配置示例（Zed agent_servers settings）
{
  "agent_servers": {
    "Cerelay": {
      "command": "cerelay-client",
      "args": ["acp", "--server", "cerelay.example.com:8765", "--key", "..."]
    }
  }
}
```

`--cwd` 由 IDE 启动时通过 ACP 协议传递（`session/new` 的 `cwd` 字段），如果 ACP 没传可降级用启动 flag。

### 5.2 模块划分

`client/src/acp/`（新建）：

```
client/src/acp/
├── index.ts             # 子命令入口（commander 注册）
├── server.ts            # ACP server 主循环（NDJSON 解析、JSON-RPC 路由）
├── methods/
│   ├── initialize.ts
│   ├── session-new.ts
│   ├── session-prompt.ts
│   ├── session-cancel.ts
│   ├── fs-read.ts       # 收到 IDE 的 fs/read 后再回应
│   └── fs-write.ts
├── notify-emitter.ts    # 把 cerelay server 来的事件包成 session/notify
└── translator.ts        # ACP ↔ cerelay 协议双向翻译
```

### 5.3 跟现有代码的关系

复用：
- `client/src/client.ts` 的 WebSocket 链路（同 PTY 模式一致）
- `client/src/protocol.ts` 的消息类型
- `client/src/tools/*` 的本地工具执行
- `client/src/cache-sync.ts` 的启动期缓存同步（ACP 模式同样需要）

不复用：
- `client/src/ui.ts`（ACP 模式没 TUI）
- `client/src/index.ts` 的 PTY tui 子命令路径（acp 是平级新子命令）

### 5.4 session 生命周期

```
IDE → initialize → cerelay-client（建 WS 到 server）
IDE → session/new {cwd, mcpServers?, model?} → cerelay-client
   ↓
   cerelay-client → server "create_acp_session" {cwd, model, mcpServers}
   ↓
   server 在容器里 spawn CC（stream-json + Plan D 的 mcp-config）
   ↓
   server 回 sessionId
   ↓
   cerelay-client 把 sessionId 透传给 IDE

IDE → session/prompt {sessionId, content[]} → cerelay-client
   ↓
   cerelay-client → server "acp_prompt" {sessionId, prompt}
   ↓
   server 把 prompt 写到 CC 的 stdin（stream-json 格式）
   ↓
   CC 流式回 turn events 到 server stdout
   ↓
   server 把每个 event 转成 cerelay 内部消息发给 client
   ↓
   cerelay-client translator 把 cerelay 消息翻成 ACP session/notify
   ↓
   IDE 渲染（思考块、文本流、工具调用、tool_result）
```

---

## 6. cerelay-server 改造

### 6.1 ACP session runtime

新建 `server/src/acp-session.ts`，跟 `pty-session.ts` 平级。

**职责**：
- spawn CC binary 用 `--print --input-format stream-json --output-format stream-json --verbose`
- spawn 时同样注入 Plan D 的 `--mcp-config`、`--append-system-prompt`、`--disallowedTools`
- 维护 stream-json 双向通道：
  - 接收 IDE 的 prompt（来自 cerelay-client 的 WS 消息）→ 写到 CC stdin（stream-json 格式）
  - 监听 CC stdout（stream-json events）→ 转成 cerelay 协议消息发给 client

**stream-json 协议**（详见 sdk.mjs，关键消息类型）：
```typescript
// CC stdout 输出的消息类型
type StreamJsonEvent =
  | { type: "system"; subtype: "init" | "session_state_changed" | ... }
  | { type: "assistant"; message: AnthropicMessage }
  | { type: "user"; message: AnthropicMessage }    // tool_result
  | { type: "result"; subtype: "success" | "error"; ... }
  | { type: "control_request"; ... }                // canUseTool 走这里
  | { type: "control_response"; ... }
  | { type: "keep_alive" };

// 我们写到 CC stdin 的消息类型
type StreamJsonInput =
  | { type: "user"; message: { content: Array<TextBlock | ImageBlock | ...> } }
  | { type: "control_response"; ... };
```

### 6.2 stream-json driver 实现

`server/src/cc-stream-json-driver.ts`（新建）：

```typescript
class StreamJsonDriver {
  spawn(options: SpawnOptions): void {
    this.process = runtime.spawn({
      command: claudeBin,
      args: ["--print", "--bare?",
             "--input-format", "stream-json",
             "--output-format", "stream-json",
             "--verbose",
             "--mcp-config", mcpConfigJson,
             "--disallowedTools", "Bash,Read,Write,...",
             "--append-system-prompt", steeringPrompt,
             "--model", model,
             "--permission-mode", "bypassPermissions",
             // 不加 --bare：会丢 skills、CLAUDE.md 自动加载等
            ],
      env: runtime.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // 解析 stdout NDJSON、emit events
  }

  sendUserMessage(text: string, attachments: Attachment[]): void {
    const input = { type: "user", message: { content: [...] } };
    this.process.stdin.write(JSON.stringify(input) + "\n");
  }

  on("event", (event: StreamJsonEvent) => ...);
  cancel(): void { this.process.stdin.write(JSON.stringify({type:"control_cancel"})+"\n"); }
}
```

### 6.3 协议映射

| ACP 消息（IDE 视角） | cerelay-client→server | server→CC stdin (stream-json) | CC→server stdout | server→cerelay-client | ACP 消息（IDE 视角） |
|---|---|---|---|---|---|
| `session/prompt` | `acp_prompt` | `{type:"user", message:...}` | | | |
| | | | `{type:"assistant", message:{content:[{type:"thinking",...}]}}` | `acp_event thinking` | `session/notify thinking_block` |
| | | | `{type:"assistant", message:{content:[{type:"text",...}]}}` | `acp_event text_chunk` | `session/notify text_block` |
| | | | `{type:"assistant", message:{content:[{type:"tool_use",...}]}}` | `acp_event tool_use` | `session/notify tool_call_block` |
| | | | `{type:"user", message:{content:[{type:"tool_result",...}]}}` | `acp_event tool_result` | `session/notify tool_call_update` |
| | | | `{type:"result", subtype:"success"}` | `acp_event end_of_turn` | `session/notify end_of_turn` |

工具调用本身（`mcp__cerelay__bash` 走到 client）走的还是 Plan D 的 ToolRelay 路径——跟 ACP 通道完全独立。

### 6.4 ACP `fs/*` 处理

ACP 设计里 IDE 要给 agent 提供 `fs/read_text_file`（拿 unsaved changes）。但我们的 agent（CC）不知道 ACP 协议，它只会调 MCP 工具。

所以 cerelay 的处理：
- **`mcp__cerelay__read` 工具**：走 ToolRelay 直接到 cerelay-client 的 `tools/fs.ts` 里读硬盘文件
- **不实现 agent 主动发起的 ACP `fs/read`**（暂时）：因为 CC 没这个能力
- **未来增强**（v2）：在 cerelay-client 的 `tools/fs.ts` 里加一个"如果 IDE 当前有 unsaved buffer 优先用 buffer 内容"的钩子，这条逻辑是 IDE-side 的——ACP server 知道当前 session 关联了哪个 IDE，可以查 IDE 的 buffer

---

## 7. 关键技术细节

### 7.1 stream-json 与 PTY 模式互斥

CC binary `--input-format stream-json` 的 doc 注明 "only works with --print"。所以 ACP session 启动的是 `claude --print ...`，**不会有 PTY**。这是 stream-json 模式的 inherent 特性，不是限制。

### 7.2 双模式并存

cerelay-server 同时支持 PTY session 和 ACP session：
- session 创建时由 client 上报 mode 字段（`pty` / `acp`）
- 不同 mode 走不同的 session runtime（`ClaudePtySession` vs `ClaudeAcpSession`）
- 工具转发的下游（ToolRelay、MCP）共用

### 7.3 MCP shadow 共用

Plan D 的 MCP shadow server（`mcp-routed/`）在 ACP 模式下**完全一样**——`--mcp-config` 注入参数相同，handler 不变，IPC 不变。这就是为什么必须先做 Plan D。

### 7.4 鉴权链

```
IDE ──stdio──> cerelay-client（无鉴权，本地进程间）
cerelay-client ──WS+CERELAY_KEY──> cerelay-server（鉴权点）
cerelay-server ──IPC──> MCP shadow server（同主机，unix socket，rwx 限本用户）
```

ACP 入口不引入新的鉴权挑战；CERELAY_KEY 仍是关键防线。

### 7.5 cwd 与 path translation

ACP 模式下 cwd 是 IDE 上报的本地路径（`/Users/.../project`）。server 容器里 mount namespace 仍然把 cwd 字符串维持一致（FUSE shadow），路径重写复用 Plan D 的 `rewriteToolInputForClient`。

### 7.6 cancel 语义

ACP `session/cancel` → cerelay-client → server → CC `control_cancel`（stream-json 通道）。CC 应该能优雅中止当前 turn，server 收到后续 `result.subtype: "interrupted"` 转成 ACP `session/notify cancelled`。

### 7.7 资源隔离

每个 ACP session 一个独立的 CC 子进程 + 独立的 mount namespace。session 关闭时按 PTY 模式同款清理流程走（`runtime.cleanup()`）。

---

## 8. 实现任务分解（建议 commit 顺序）

### Phase 0：等 Plan D 完成
ACP relay 的 MCP shadow 依赖来自 Plan D。**确保 Plan D Phase 1-5 完成且 e2e 绿**之后再启动 ACP。

### Phase 1：server 侧 stream-json driver
1. `feat: add CC stream-json driver scaffolding`
   - 新建 `server/src/cc-stream-json-driver.ts`
   - 单测：spawn 真 CC binary，发简单 prompt，验 events 能解析
2. `feat: implement ACP session runtime (skeleton)`
   - 新建 `server/src/acp-session.ts`
   - 跟 `pty-session.ts` 平级，复用 ClaudeSessionRuntime
   - 暂不接 client，只暴露 `prompt(text)` / `events()` 接口

### Phase 2：协议扩展
3. `feat: extend cerelay protocol with ACP session messages`
   - `server/src/protocol.ts` + `client/src/protocol.ts`：
     - `create_acp_session` / `acp_session_created`
     - `acp_prompt` / `acp_event` / `acp_cancel`
   - 单测：序列化/反序列化
4. `feat: route ACP messages in cerelay-server WS handler`
   - `server/src/server.ts`：识别 mode=acp 的 session，分发到 `ClaudeAcpSession`
   - 集成测试：mock client，验消息路由正确

### Phase 3：cerelay-client ACP 子命令
5. `feat: scaffold cerelay-client acp subcommand`
   - 新建 `client/src/acp/index.ts`：commander 注册 `acp` 子命令
   - 启动时建 WS 到 server，readline 读 stdin 解 NDJSON
   - 暂时只回 `initialize` 响应
6. `feat: implement session/new and session/prompt routing`
   - 翻 ACP `session/new` 成 cerelay `create_acp_session`
   - 翻 ACP `session/prompt` 成 cerelay `acp_prompt`
   - 翻 cerelay `acp_event` 成 ACP `session/notify`
   - 集成测试：mock IDE 发 NDJSON，断言 server 收到正确 cerelay 消息

### Phase 4：流式事件翻译
7. `feat: implement stream-json → ACP notify translator`
   - `client/src/acp/translator.ts`：每种 stream-json event 一个 case
   - 单测：覆盖 thinking、text、tool_use、tool_result、end_of_turn 等
8. `feat: handle session/cancel`
   - cerelay-client 把 ACP cancel 翻成 `acp_cancel`，server 写到 CC stdin

### Phase 5：fs 读写（最小子集）
9. `feat: implement ACP fs/read_text_file (no unsaved buffer support yet)`
   - cerelay-client 收到 IDE 的 fs/read，直接读硬盘
   - 注：当前 CC 不会主动发 fs/read，这里实现的是 IDE 主动 push（罕见但 spec 要求）
10. `feat: implement ACP fs/write_text_file`
    - 同上

### Phase 6：E2E
11. `test: e2e ACP session with real CC + mock IDE`
    - 模拟 IDE 发 ACP NDJSON，cerelay-client + cerelay-server + 真 CC binary 全跑通
    - 断言：tool_call 能到 client，is_error: false，end_of_turn 正确
12. `docs: update README with ACP integration guide`
    - 给出 Zed / VS Code 配置示例
    - 删除 / 重写 `docs/acp-editor-integration.md` 老文档

### Phase 7：可选增强
13. `feat: connect ACP fs/read to MCP shadow read for unsaved buffer fallback`
14. `feat: support ACP session/load (resume conversation)`
15. `feat: support multimodal (image attachments in session/prompt)`

---

## 9. 测试策略

### 9.1 单元测试

`client/src/acp/__test__/`：
- `translator.test.ts`：每条 stream-json event ↔ ACP notify 双向翻译，snapshot
- `session-new.test.ts`：mock server connection，验 cwd / model 透传

### 9.2 集成测试

`server/test/acp-session-integration.test.ts`：
- spawn 真 CC binary（stream-json mode），mock cerelay-client
- 发 prompt 走完整流程，断言事件序列正确

### 9.3 E2E

`server/test/e2e-acp-real-claude.test.ts`：
- mock IDE（写 NDJSON 到 stdin）
- 真 cerelay-client（通过 child_process spawn `cerelay-client acp`）
- 真 cerelay-server（已起容器）
- 真 CC binary
- mock Anthropic API（让模型调 `mcp__cerelay__bash`）
- 断言：
  - `session/notify` 收到 tool_call 事件
  - tool_result 是 is_error: false
  - 最终文本里包含真实文件名

### 9.4 IDE 实测（手工）

- Zed 配 cerelay 当 agent，跑下面三轮：
  1. 让它列当前目录
  2. 让它读一个文件并解释
  3. 让它写一个新文件（验 IDE diff 预览正常）
- VS Code 同上（如果有 ACP 客户端插件）

---

## 10. 风险与回退

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| stream-json 协议在 CC 升级中变化 | 中 | 整套 driver 失效 | E2E 在 CI 跑，CC 升级前能发现；driver 跟 SDK 同款，跟随官方 |
| ACP 协议 v1 → v2 不兼容 | 低 | translator 重写 | 跟随 Zed 主版本；目前 v1 稳定 |
| IDE 实现差异（Zed vs VS Code 插件） | 高 | 用户报"我这边显示不对" | 文档明确支持哪些 IDE；issue 模板要求贴 ACP 流量 |
| cerelay-client 没装时 IDE 拿不到错误提示 | 低 | UX 差 | ACP `initialize` 失败会有标准错误码，IDE 自己处理 |
| MCP shadow 在 stream-json 模式下行为差异 | 低 | 工具调用挂 | E2E 同时覆盖 PTY 和 ACP 两条路 |
| stream-json `--print` 没法接 PTY 交互式输入 | 必然 | ACP 模式无 TUI | 这是设计目标，不算风险 |

**回退策略**：ACP 入口是新增子命令，不影响 PTY 模式。任何 phase 出问题不发布即可。

---

## 11. 验收清单

- [ ] 所有 Phase 1-6 commit 落地，CI 全绿
- [ ] `e2e-acp-real-claude.test.ts` 在容器内能稳定通过 5 次/5 次
- [ ] 现行 PTY 模式所有 e2e 仍通过（不退化）
- [ ] 手工验收（Zed）：
  - [ ] `agent_servers.Cerelay` 配置后能在 chat 侧栏选中
  - [ ] 对话流式渲染正常（无明显延迟，事件顺序正确）
  - [ ] 工具调用块可展开看 input/output
  - [ ] Edit 工具触发 IDE diff 预览
  - [ ] cancel 中断起效
- [ ] 文档更新：README、docs/acp-editor-integration.md 重写
- [ ] 在 docker logs 能看到 `[acp-session]` 日志，与 `[pty-session]` 区分

---

## 12. 不在范围内（明确划清边界）

- ❌ 不实现 ACP `terminal/*` 方法（终端 PTY 转发）——cerelay 没那个使用场景，PTY 模式自己就有终端
- ❌ 不实现 ACP `agent/load_session` v1 spec 之外的部分
- ❌ 不在 cerelay-client 内做 IDE 检测/集成（让用户在 IDE 配置 agent_servers 即可）
- ❌ 不替换现行 PTY 模式（双模式并存）
- ❌ 不重写 `mcp-routed/`（来自 Plan D，本方案直接用）

---

## 附录 A：ACP 协议参考

- 官方 spec：https://github.com/zed-industries/agent-client-protocol
- TS SDK：`@zed-industries/agent-client-protocol`
- 现状调研：`.claude/acp-research.md`

## 附录 B：stream-json 协议参考

- 没有官方独立 spec，等同于 Anthropic Messages API streaming format 加上控制消息
- 实参证据：`node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`（仓库已有）
- 关键 flag：
  ```
  --print
  --input-format stream-json
  --output-format stream-json
  --verbose
  --mcp-config '{"mcpServers":{...}}'
  --append-system-prompt "..."
  --disallowedTools "Bash,Read,..."
  --permission-mode bypassPermissions
  --permission-prompt-tool stdio   # 如果要做 canUseTool
  ```

## 附录 C：与 Plan D 的依赖关系图

```
┌──────────────────────────────────┐
│  Plan D Phase 1-2                │
│  cerelay-routed MCP server +     │
│  IPC host                        │
└────────────┬─────────────────────┘
             │ 提供 mcp-routed/ 模块
             │
   ┌─────────┴─────────┐
   ▼                   ▼
┌─────────────┐    ┌─────────────────┐
│ Plan D      │    │  ACP Relay      │
│ Phase 3-6   │    │  Phase 1-6      │
│ (PTY 入口)  │    │  (IDE 入口)     │
└─────────────┘    └─────────────────┘
```

ACP Relay Phase 1-6 可在 Plan D Phase 1-2 完成后立即启动，无需等 PTY 入口的 Phase 3-6 完成。

## 附录 D：参考文件路径速查

```
client/src/
├── index.ts                  # 改：注册 acp 子命令
├── client.ts                 # 复用 WS 连接
├── tools/                    # 复用本地工具执行
├── cache-sync.ts             # 复用启动期同步
└── acp/                      # 新建模块
    ├── index.ts
    ├── server.ts
    ├── translator.ts
    ├── notify-emitter.ts
    └── methods/
        ├── initialize.ts
        ├── session-new.ts
        ├── session-prompt.ts
        ├── session-cancel.ts
        ├── fs-read.ts
        └── fs-write.ts

server/src/
├── server.ts                 # 改：识别 mode=acp 的 session
├── pty-session.ts            # 不变（PTY 入口保留）
├── acp-session.ts            # 新建
├── cc-stream-json-driver.ts  # 新建
├── protocol.ts               # 改：扩展 ACP session 消息
├── claude-session-runtime.ts # 复用
└── mcp-routed/               # 来自 Plan D，直接用

server/test/
├── acp-session-integration.test.ts   # 新
├── e2e-acp-real-claude.test.ts       # 新
└── e2e-real-claude-bash.test.ts      # 不动（守护 PTY 路径）
```
