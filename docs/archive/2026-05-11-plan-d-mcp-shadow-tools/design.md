# Plan D — MCP Shadow Tools 设计文档

> 状态：设计完成，待实施
> 关联 bug：PreToolUse hook 路径下 `tool_result.is_error: true` 导致模型误判工具失败
> 关联 commit：`3674836`（旧 fix，仅止住 content 丢失，未解决 is_error 问题）
> 关联调研：`.claude/acp-research.md`、本目录 `plan-acp-relay.md`

---

## 1. 背景与问题陈述

### 1.1 当前路径

cerelay 的 PTY 模式下，CC 在 namespace 内被拉起，它的工具调用通过我们注入的 `PreToolUse` hook 转发到 Client：

```
CC → PreToolUse hook → cerelay-server → WS → cerelay-client（执行）→ 结果 → 反向回传 → hook 返回 → CC
```

hook 通过 `permissionDecision: "deny"` + `permissionDecisionReason: <真实工具输出>` 把 Client 执行结果灌回 CC。

### 1.2 已实测的问题

用 **真实 CC 2.1.114 binary + mock Anthropic API 抓包**（probe 验证，详见会话历史）：

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_xxx",
  "content": "stdout:\ntotal 4\n... PROBE_MARKER.txt\n\nexit_code: 0",
  "is_error": true        // ★ 永远 true
}
```

CC binary 对 `permissionDecision: "deny"` 的处理是**协议硬编码**：发给 LLM 的 `tool_result` 一定是 `is_error: true`，跟 `permissionDecisionReason` 装什么无关。模型看到 `is_error: true` 就当工具失败，转去依赖 system reminder 中 CC 启动时写入的 cwd 目录列表（mount namespace 下 FUSE 只挂载了 `.claude/`），最终回答用户"目录基本为空，只有 settings.local.json"。

### 1.3 已排除的非根因

- 镜像未重建：用户 VPS 拉了最新 master，镜像确认有 fix 代码
- `permissionDecisionReason` 没装 content：probe 显示已正确装入
- e2e 测试未捕获 bug：`56de318` 的 e2e 只断言 `content.includes(marker)`，**漏了 `is_error === false` 的关键断言**

### 1.4 协议层硬约束（不要再走老路）

CC binary `--help` 与 strings 提取确认的 hook 协议能力：

| PreToolUse 输出 | 行为 |
|---|---|
| `permissionDecision: "allow"` | CC 本地执行原 / `updatedInput` 改后的工具 |
| `permissionDecision: "deny"` | tool_result `is_error: true`，content = reason |
| `permissionDecision: "ask"` | 弹用户确认（PTY/print 都没法用） |
| `defer` | "defer is print-mode only"，且不写 tool_result |

| PostToolUse 输出 | 行为 |
|---|---|
| `additionalContext` | 旁注，走 system reminder |
| `decision: "block"` | 让 LLM 重做，不能覆盖 tool_response |

**结论：原生 hook 协议下没有"我已执行完，这是结果，is_error: false"的语义**。

---

## 2. 设计目标

### 2.1 必须达成

- **G1** 模型收到的 `tool_result.is_error` **必须可控**（默认 false，仅在真实工具错误时为 true）
- **G2** 不破坏现有 PTY 模式 UX（CC TUI、resize、颜色、交互）
- **G3** 不复活已删除的 SDK 路径（commit `37e5797`）
- **G4** 工具集合可扩展（新加工具时按统一模式接入，不需 CC 内部反向工程）
- **G5** 失败模式可降级（MCP server 起不来时退回现行 hook 路径，**不阻塞 session 启动**）

### 2.2 非目标

- ❌ 不改 cerelay-client 的 UI / TUI 路径（这是 ACP relay 方案的范围）
- ❌ 不试图把 CC 内置 Bash/Read 等工具藏起来（那要 stream-json 模式，PTY 下做不到）
- ❌ 不替换 CC 的 system prompt（PTY 下 `--system-prompt` 整段替换会破坏 TUI 体验，只用 `--append-system-prompt` 软引导）

### 2.3 可靠性预期

PTY 模式下能拿到的可靠性上限约 **95-98%**——剩余 2-5% 来自模型偶尔忽略软引导、调用了内置工具的尾部场景。这部分用 `--disallowedTools` 做硬保险（runtime reject + 模型重试 mcp__cerelay__*），代价是浪费一轮但不会出错。

100% 可靠性需要 stream-json 模式（见 `plan-acp-relay.md`）。

---

## 3. 整体架构

```
                            cerelay-server (容器内)
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│   ┌──────────────────┐   stdio JSON-RPC   ┌─────────────────┐  │
│   │ cerelay-routed   │ ◀────────────────▶ │  CC (PTY mode)  │  │
│   │ MCP server       │   spawn 子进程      │  --mcp-config   │  │
│   │                  │                    │  --append-       │  │
│   │  tools/list      │                    │   system-prompt │  │
│   │  tools/call      │                    │  --disallowed   │  │
│   │     ↓            │                    │   Tools …       │  │
│   │  ToolRelay       │                    │                 │  │
│   │  (复用)          │                    └────────┬────────┘  │
│   └────┬─────────────┘                             │           │
│        │ Pending<request_id>                       │ PTY pipe  │
│        │                                           │           │
└────────┼───────────────────────────────────────────┼───────────┘
         │                                           │
   WS    │ tool_call / tool_result                   │ stdout/stdin
   ▼     ▼                                           ▼
┌────────────────────────┐                  ┌──────────────────┐
│   cerelay-client       │                  │  user terminal   │
│   ─ ToolExecutor       │                  │  (PTY rendered)  │
│   ─ Bash/Read/Edit/... │                  │                  │
└────────────────────────┘                  └──────────────────┘
```

**关键变化点**（vs 现状）：
- 现状：CC PreToolUse hook → HTTP bridge → cerelay-server → WS → client
- 新增：CC MCP client → stdio → cerelay-routed MCP server → ToolRelay → WS → client
- 旧路径**保留**作为 fallback（CC 没听话调了内置工具时仍然要兜住）

---

## 4. 组件设计

### 4.1 cerelay-routed MCP server

**位置**：`server/src/mcp-routed/` 新模块

**职责**：实现 MCP 协议（spec：https://modelcontextprotocol.io/），作为 CC 的子进程被拉起，提供 6 个对应内置工具的 shadow tool。

**通信方式**：MCP `stdio` transport——CC spawn 这个进程后通过 stdin/stdout 走 JSON-RPC 2.0。

**为什么是 stdio 不是 HTTP**：
- stdio MCP 不需要在 cerelay-server 主进程上额外开端口
- 子进程生命周期跟 PTY session 绑定，session 关闭自动清理
- 无需考虑跨进程鉴权（stdio 已经是独占信道）

**实现方式**：
- 新增依赖 `@modelcontextprotocol/sdk`（仓库已有 `^1.29.0`）
- 用 `Server` class + `StdioServerTransport`
- 启动时通过环境变量拿到 cerelay-server 主进程 IPC socket 路径，建立 IPC 链路（Unix socket 或 named pipe），把每个 `tools/call` 转换为 `ToolRelay` 请求并等结果

**进程模型**：
```
cerelay-server 主进程
  ├─ spawn CC PTY (per session)
  └─ CC 又 spawn cerelay-routed-mcp-server.js (per session)
        └─ 通过 unix socket 跟 cerelay-server 主进程通信
```

每个 session 有独立的 MCP server 子进程；socket 路径写在 session 启动 env 里，路径含 sessionId 防串扰。

### 4.2 工具集与 schema

**工具命名空间**：`mcp__cerelay__*`（CC 标准命名规则：`mcp__<server>__<tool>`）

| MCP tool 名 | 镜像内置工具 | input schema |
|---|---|---|
| `mcp__cerelay__bash` | Bash | `{command: string, description?: string, timeout?: number}` |
| `mcp__cerelay__read` | Read | `{file_path: string, offset?: number, limit?: number}` |
| `mcp__cerelay__write` | Write | `{file_path: string, content: string}` |
| `mcp__cerelay__edit` | Edit | `{file_path: string, old_string: string, new_string: string, replace_all?: boolean}` |
| `mcp__cerelay__multi_edit` | MultiEdit | `{file_path: string, edits: [{old_string, new_string, replace_all?}]}` |
| `mcp__cerelay__glob` | Glob | `{pattern: string, path?: string}` |
| `mcp__cerelay__grep` | Grep | `{pattern: string, path?: string, glob?: string, type?: string, output_mode?: string, ...}` |

**schema 一致性约束**：参考 CC 自己的 `sdk-tools.d.ts`（容器内 `/usr/local/lib/node_modules/@anthropic-ai/claude-code/sdk-tools.d.ts`）保证字段名、类型、必填项完全一致——否则模型按 Bash/Read 习惯调参数会触发 schema 错误。

**handler 实现统一模式**（伪代码）：
```typescript
async function bashHandler(input, context): Promise<CallToolResult> {
  // 1. 路径重写：复用 server/src/claude-tool-bridge.ts 的 rewriteToolInputForClient
  const rewritten = rewriteToolInputForClient("Bash", input, context.pathOptions);

  // 2. 走 ToolRelay 转发到 client
  const requestId = `mcp-${context.sessionId}-${randomUUID()}`;
  await context.transport.sendToolCall(context.sessionId, requestId, "Bash", undefined, rewritten);
  const result = await context.relay.createPending(requestId, "Bash");

  // 3. 渲染：复用 renderToolResultForClaude
  const content = renderToolResultForClaude("Bash", result);

  // 4. 构造 CallToolResult，is_error 由我们显式控制
  return {
    content: [{ type: "text", text: content }],
    isError: Boolean(result.error),  // ★ 关键：我们说了算
  };
}
```

每个工具一份 handler，逻辑高度同构——可以提取通用 wrapper 让真正的 per-tool 代码就是"工具名 + schema"两行。

### 4.3 注入入口（CLI flags）

修改 `server/src/pty-session.ts` 的 `buildClaudeCommandArgs(model)`，追加：

```typescript
function buildClaudeCommandArgs(model: string | undefined, sessionId: string, ipcSocketPath: string): string[] {
  const mcpConfig = JSON.stringify({
    mcpServers: {
      cerelay: {
        command: process.execPath,  // node 自身
        args: [resolveCerelayMcpEntrypoint()],  // dist/mcp-routed/index.js
        env: {
          CERELAY_MCP_SESSION_ID: sessionId,
          CERELAY_MCP_IPC_SOCKET: ipcSocketPath,
        },
      },
    },
  });

  return [
    resolveClaudeCodeExecutable(),
    ...(model ? ["--model", model] : []),
    "--mcp-config", mcpConfig,
    // 不加 --strict-mcp-config：要让用户自己的 MCP servers 也能正常加载
    "--append-system-prompt", buildSteeringPrompt(),
    // 硬保险：built-in 工具一律拒绝执行（forces model to use mcp__cerelay__*）
    "--disallowedTools", "Bash,Read,Write,Edit,MultiEdit,Grep,Glob",
  ];
}
```

**IPC socket 创建时机**：`ClaudePtySession.start()` 早于 spawn CC 时建立 Unix socket（路径形如 `/tmp/cerelay-mcp-<sessionId>.sock`），listen 后再启动 CC，session 关闭时 unlink。

### 4.4 软引导 system prompt

`buildSteeringPrompt()`（写入 `--append-system-prompt`，**追加**而非替换）：

```
<cerelay-tool-routing-policy>
This session runs in a sandboxed runtime. The standard built-in tools
(Bash, Read, Write, Edit, MultiEdit, Grep, Glob) are NOT available—calling
them will fail. Use the mcp__cerelay__* equivalents instead, which have
identical schemas and route to the user's actual workspace:

  Bash      → mcp__cerelay__bash
  Read      → mcp__cerelay__read
  Write     → mcp__cerelay__write
  Edit      → mcp__cerelay__edit
  MultiEdit → mcp__cerelay__multi_edit
  Glob      → mcp__cerelay__glob
  Grep      → mcp__cerelay__grep

User-installed MCP servers (mcp__<other>__*) work normally; do not
substitute them.
</cerelay-tool-routing-policy>
```

**为什么不用 `--system-prompt`（替换）**：替换会丢掉 CC 自带的 skills/permissions/UI hint，TUI 体验断裂。append 是 PTY 模式下能用的最强引导。

### 4.5 Fallback hook

**保留** `server/src/claude-hook-injection.ts` + `pty-session.ts` 的 `handleInjectedPreToolUse`。如果模型违反引导调了内置 Bash/Read 等：
- `--disallowedTools` 会让 CC 拒绝该工具
- CC 可能自己不走 hook 直接 reject，也可能走 hook（待 probe）
- 走 hook 的话，hook 仍然返回 deny + permissionDecisionReason，**附带强提示信息让模型改用 MCP 版本**：
  ```
  permissionDecisionReason: "Tool 'Bash' is not available. Use mcp__cerelay__bash instead, which has the same schema and routes to your actual workspace."
  ```
- 模型看到 is_error: true + 这条提示，下一轮一般会改用正确的 MCP 工具，仅浪费一轮

这条 fallback 路径同时也保护"用户配置了奇怪的 MCP server，模型调用了它"的场景——非 cerelay 的 MCP 工具仍走 client 转发的老路径（`isClientRoutedToolName` 已经覆盖 `mcp__*`）。

### 4.6 路径重写复用

复用 `server/src/claude-tool-bridge.ts` 现有的 `rewriteToolInputForClient` / `renderToolResultForClaude`。这俩函数本来就是为了把容器路径重写成 client 路径、把工具结果渲染成可读文本——MCP handler 直接调用即可。

⚠️ 一个细节：`renderToolResultForClaude` 当前对空字符串没特殊处理（commit `3674836` 在 PTY 路径加了 "Tool response ready" 占位）。MCP 这边**不需要这个 hack**——CallToolResult 只要 `content[]` 非空即可，长度 0 也合法（MCP 协议不要求 reason 非空，跟 hook deny 不一样）。

---

## 5. 端到端数据流（一次 ls 调用）

```
[1] 用户在 client 终端输入 "ls 当前目录"
[2] PTY 把字节透传到 server，server 写到 CC PTY stdin
[3] CC 给 LLM 发请求，LLM 返回 tool_use(name=mcp__cerelay__bash, input={command:"ls -la"})
[4] CC 通过 stdio JSON-RPC 给 cerelay-routed MCP server 发 tools/call
[5] MCP server handler:
    - rewriteToolInputForClient: 暂无重写（Bash 命令含路径才重写）
    - 通过 IPC 给 cerelay-server 主进程发 ToolRelayRequest{sessionId, toolName:"Bash", input}
[6] cerelay-server 主进程通过 WS 给 cerelay-client 发 tool_call
[7] cerelay-client 执行 Bash（client/src/tools/bash.ts），拿到 {stdout, stderr, exit_code}
[8] cerelay-client 通过 WS 回 tool_result
[9] cerelay-server 收到，通过 IPC 回给 MCP server 子进程
[10] MCP handler 渲染并构造 CallToolResult{content:[{type:"text", text:"stdout:\n... \nexit_code:0"}], isError:false}
[11] CC 收到 CallToolResult，发给 LLM 作为 tool_result（is_error:false）
[12] LLM 看到真实 stdout，正常回答
[13] CC 把回答字符流写到 PTY stdout，server 透传到 client，渲染给用户
```

**关键不变量**：
- 步骤 [11] 的 `tool_result.is_error: false`（除非 Client 真的报错）
- 步骤 [13] PTY 流不被 MCP 路径污染（MCP 走 stdio JSON-RPC 是 CC 的内部流，跟 PTY 输出无交集）

---

## 6. 与现有代码的集成点

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `server/src/mcp-routed/index.ts` | **新建** | MCP server 入口（被 CC spawn） |
| `server/src/mcp-routed/handlers/*.ts` | **新建** | 7 个工具的 handler |
| `server/src/mcp-routed/schemas.ts` | **新建** | 工具 input schemas，参照 sdk-tools.d.ts |
| `server/src/mcp-routed/ipc-client.ts` | **新建** | 跟主进程的 unix socket 链路 |
| `server/src/mcp-ipc-host.ts` | **新建** | 主进程侧的 unix socket listener |
| `server/src/pty-session.ts` | 修改 | `buildClaudeCommandArgs` 注入 `--mcp-config` 等；start() 启动 IPC socket 并 listen |
| `server/src/server.ts` | 修改 | 启动期初始化 `MCPIpcHost`；session 创建时把 ipcSocketPath 传给 ClaudePtySession |
| `server/src/claude-hook-injection.ts` | 修改 | hook fallback 时把 reason 改成"指引用 mcp__cerelay__*"的强提示 |
| `server/src/tool-routing.ts` | 不变 | `isMcpToolName` 已能识别 `mcp__*` |
| `server/src/relay.ts` | 不变 | `ToolRelay` 直接复用 |
| `server/src/claude-tool-bridge.ts` | 微调 | 暴露 `rewriteToolInputForClient` / `renderToolResultForClaude` 给 MCP handler 用（可能要去掉 `"Tool response ready"` fallback，或者只在 hook 路径用） |
| `server/package.json` | 微调 | 确认 `@modelcontextprotocol/sdk` 版本足够（^1.29.0 OK） |
| Dockerfile | 微调 | `dist/mcp-routed/` 也要 COPY 进 runner stage |

---

## 7. 测试策略

### 7.1 单元测试

`server/test/mcp-routed/`：
- `handlers-bash.test.ts`：mock IPC，验 Bash handler 正确组装 ToolCall 并返回 CallToolResult
- `handlers-read.test.ts`、`-edit.test.ts` 等：每个工具一个文件，覆盖正常/错误/路径重写
- `schemas.test.ts`：用 Anthropic SDK 的 tool schema 对照 `sdk-tools.d.ts`，断言每个 mcp__cerelay__* 的 schema 跟内置完全等价

### 7.2 集成测试

`server/test/mcp-routed-integration.test.ts`：
- 启动主进程的 IPC host
- spawn 真的 MCP server 子进程
- 通过 stdio 给 MCP 发 `tools/call`，断言 IPC 收到正确的 ToolRelayRequest
- mock relay 返回结果，断言 MCP 子进程返回正确的 CallToolResult

### 7.3 端到端守护（最关键）

**新建** `server/test/e2e-mcp-shadow-bash.test.ts`：
- 改造 `e2e-real-claude-bash.test.ts` 框架：mock Anthropic 让模型返回 `mcp__cerelay__bash` 的 tool_use（而不是 Bash）
- 启动真 CC binary + 真 MCP server 子进程 + 测试 transport 模拟 client 执行
- **核心断言**：
  ```typescript
  assert.equal(tr.is_error, false, "MCP shadow tool 必须以 is_error: false 返回");  // ★ 这条是 56de318 漏掉的
  assert.match(tr.content, /真实文件名/);
  ```

**改造** `server/test/e2e-real-claude-bash.test.ts`：
- 把 `tr.is_error` 的断言加上：`assert.equal(tr.is_error, true)` —— 这是老的 hook 路径，is_error 必然 true，固化这个事实
- 这条测试同时还能守护 fallback hook 的行为不退化

### 7.4 回归测试

现有 `server/test/pty-tool-relay-bug.test.ts` 全部保留并通过——它守护的是"hook fallback 路径仍然把内容装进 reason"，对应模型违反引导的兜底场景。

### 7.5 容器测试

`test/run-container-tests.sh` 增加一步：
```sh
echo "[container-tests] e2e mcp-shadow (PreToolUse → tool_result invariant)"
$compose_cmd run --rm \
  -e CERELAY_E2E_REAL_CLAUDE=true \
  -e CLAUDE_CODE_EXECUTABLE=/usr/local/bin/claude \
  --entrypoint sh test -lc 'cd /app/server && node --import tsx --test --test-concurrency=1 test/e2e-mcp-shadow-bash.test.ts'
```

---

## 8. 实现任务分解（建议 commit 顺序）

每个 commit 独立编译通过、独立可回滚。

### Phase 1：MCP server 骨架
1. `feat: scaffold cerelay-routed MCP server (stdio + IPC client stub)`
   - 新建 `mcp-routed/{index,ipc-client}.ts`，能跑通"启动 → 连接 IPC → echo tools/call"
   - 单测：`mcp-routed-skeleton.test.ts` 用 ChildProcess 起子进程跑 init handshake

2. `feat: add MCP IPC host on cerelay-server main process`
   - 新建 `server/src/mcp-ipc-host.ts`，主进程 listen unix socket
   - `server.ts` 启动时初始化
   - 单测：`mcp-ipc-host.test.ts`

### Phase 2：工具 handlers
3. `feat: implement mcp__cerelay__bash handler`
   - 新建 `mcp-routed/handlers/bash.ts` + `schemas.ts`
   - 从 ToolRelay 拿结果 → CallToolResult
   - 单测 + 集成测试

4. `feat: implement remaining mcp__cerelay__* handlers (Read/Write/Edit/MultiEdit/Glob/Grep)`
   - 一个 commit 把剩下 6 个加完，结构高度同构
   - 每个工具至少一条 happy-path 单测 + 一条错误路径

### Phase 3：CC 注入
5. `feat: inject --mcp-config and --disallowedTools into CC PTY launch`
   - 修改 `pty-session.ts` 的 `buildClaudeCommandArgs`
   - 修改 `start()` 启动 IPC socket
   - 集成测试：mock CC 子进程，断言 CLI 参数包含正确字段

6. `feat: add --append-system-prompt steering for mcp__cerelay__* routing`
   - 新建 `mcp-steering-prompt.ts` 导出 `buildSteeringPrompt()`
   - 单测：snapshot test

### Phase 4：Fallback 路径加固
7. `refactor: route fallback hook reason to suggest mcp__cerelay__* alternative`
   - `claude-hook-injection.ts` 的兜底 reason 文案改成强提示
   - 改 `pty-tool-relay-bug.test.ts` 对应断言

### Phase 5：E2E 守护
8. `test: e2e mcp shadow tool with real CC + mock Anthropic API`
   - 新建 `e2e-mcp-shadow-bash.test.ts`，断言 `is_error: false`
   - 容器 test runner 加一步

9. `test: assert is_error: true on legacy hook fallback path`
   - 改 `e2e-real-claude-bash.test.ts`，固化老路径的事实

### Phase 6：用户验收
10. `chore: enable Plan D by default in production server`
    - feature flag 默认开启（之前 phases 可以放在 `CERELAY_ENABLE_MCP_SHADOW=true` 里）
    - 文档：README 更新，`CLAUDE.md` 同步说明

---

## 9. 风险与回退

### 9.1 已识别风险

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| MCP server 子进程启动失败 | 低 | session 卡死 | start() 里加超时（5s），失败则退回纯 hook 路径 + warn |
| `--disallowedTools` 拦截太严，模型连一次都不试 mcp 版本 | 低 | 用户每条命令都被拒 | 保留 fallback hook 提示，最多浪费一轮 |
| 模型把 `mcp__cerelay__bash` 当成"用户配的 MCP"而疑虑 | 低 | 偶尔不调 | system prompt 文案明确说明这是必须用的 |
| MCP schema 跟 CC built-in 不一致，模型按错的 schema 调 | 中 | 工具调用报 schema 错 | 单测对照 `sdk-tools.d.ts`，在 CI 锁死 |
| CC 升级后 hook/MCP 协议变化 | 中长期 | 整体路径失效 | e2e 在 CI 跑，binary 升级前能发现 |

### 9.2 回退策略

每个 phase 独立可回滚。如果 Phase 5 e2e 测试发现 MCP 路径在某些场景比 hook 还差：
1. revert Phase 5/4/3 即可回到现行 hook 状态
2. 单测/集成测代码留着，不浪费

如果整套 Plan D 上线后用户报告 95% 以下的可靠性：
1. 启用 fallback hook 文案强化
2. 评估升级到 ACP relay（见 `plan-acp-relay.md`）

### 9.3 不变量守护

每次 PR 必须：
- 跑全套 server workspace 单测
- 跑 `e2e-real-claude-bash.test.ts`（老路径 `is_error: true`）
- 跑 `e2e-mcp-shadow-bash.test.ts`（新路径 `is_error: false`）

两条都过，才能 merge。

---

## 10. 不在范围内（明确划清边界）

- ❌ 改 cerelay-client 的工具实现（`client/src/tools/`）：MCP 路径仍然复用现有 ToolRelay，client 看到的协议不变
- ❌ Web UI 改造：`web/` 目录不动
- ❌ 改 `client-cache-store` / FUSE：mount namespace + cache 是正交基础设施
- ❌ 改 PTY 生命周期管理：`pty-host-script.ts` 等保持原样
- ❌ ACP 入口：见 `plan-acp-relay.md`，独立方案

---

## 11. 验收清单（implementation done 的标准）

- [ ] 所有 phases 的 commit 落地，CI 全绿
- [ ] `e2e-mcp-shadow-bash.test.ts` 在容器内能稳定通过 5 次/5 次
- [ ] `e2e-real-claude-bash.test.ts` 仍然通过（守护 fallback）
- [ ] 手工验收：用 cerelay-client 连接 server，跑下面三条命令，模型回答与真实文件系统一致：
  - `ls 当前目录有什么文件`
  - `读一下 README.md 前 50 行`
  - `用 grep 搜一下 "cerelay" 出现在哪些 ts 文件里`
- [ ] 在 docker logs 里能看到 `[mcp-routed]` 的日志，而不是大量 `[pty-session] PTY tool 收到 Client 结果`（后者只在 fallback 时出现）
- [ ] mock-anthropic-api 的 capture 显示 `tool_result.is_error === false`
- [ ] 用户复现的"目录基本为空"问题消失

---

## 附录 A：MCP 协议关键引用

- 协议：https://modelcontextprotocol.io/
- TS SDK：`@modelcontextprotocol/sdk`（仓库已依赖）
- CC 注册方式：`--mcp-config '{"mcpServers":{"<name>":{...}}}'`
- 工具命名规则：`mcp__<server-name>__<tool-name>`
- CallToolResult：`{ content: ContentBlock[], isError: boolean }`
- 我们关心的 transport：StdioServerTransport（最简单且不要端口）

## 附录 B：参考文件路径速查

```
server/src/
├── pty-session.ts             # 改 buildClaudeCommandArgs
├── claude-tool-bridge.ts      # 复用 rewrite/render
├── relay.ts                   # 复用 ToolRelay
├── tool-routing.ts            # isMcpToolName 已支持
├── claude-hook-injection.ts   # fallback hook 文案改造
├── server.ts                  # 启 MCPIpcHost
└── mcp-routed/                # 新建模块
    ├── index.ts
    ├── ipc-client.ts
    ├── schemas.ts
    └── handlers/
        ├── bash.ts
        ├── read.ts
        ├── write.ts
        ├── edit.ts
        ├── multi-edit.ts
        ├── glob.ts
        └── grep.ts

server/test/
├── e2e-real-claude-bash.test.ts        # 改：加 is_error 断言
├── e2e-mcp-shadow-bash.test.ts         # 新：核心守护
├── pty-tool-relay-bug.test.ts          # 改：fallback 文案
└── mcp-routed/                         # 新：单测
    ├── handlers-*.test.ts
    └── schemas.test.ts
```
