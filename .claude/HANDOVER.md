# Axon 交接文档 / Handover Document

> 最后更新：2026-04-05
> 上一次 Session 的完整提交历史见 `git log --oneline`

## 一、项目概述

Axon 是 Claude Code 的分体式架构：Hand（用户交互+工具执行）↔ Axon Server（Brain）↔ claude CLI（LLM 推理）。

## 二、已完成的工作（5 次提交）

| Commit | 内容 |
|--------|------|
| `f3d7f22` | Phase 0 Bash Hook 安全过滤系统 + 安全评审修复 11 项 |
| `81bfbd8` | ACP 可行性 POC（TypeScript，验证 SDK query/hooks/远程执行） |
| `00b8eae` | Go 基础层：ACP 协议（JSON-RPC 2.0）+ WebSocket 协议定义 |
| `1a97a28` | Axon Server + Hand CLI 完整 Go 实现 + 交叉验证修复 |
| `bf3b273` | 12 个集成测试 + README 重写 |

## 三、核心架构决策：方案 B（Hook + HTTP 回调）

### 背景

ACP 协议的 client-side methods（`fs/read_text_file`, `terminal/create`）**不是** claude CLI 原生发出的——它们是 `claude-agent-acp`（Node.js 桥接层）内部用 SDK 的 `hooks.PreToolUse` 拦截后转换出来的。直接启动 `claude` CLI，它会在本地执行 Bash/Read 等工具，不会发 ACP 回调给我们。

### 方案 B 设计

```
Hand CLI ←── WebSocket ──→ Axon Server ←── HTTP 回调 ──→ Hook 脚本（Bash）
                                │
                                │ stdio (ACP / stream-json)
                                ↓
                          claude CLI 子进程
                                │
                                │ PreToolUse Hook 触发
                                ↓
                          dispatch.sh → 各工具 Proxy 脚本
                                │
                                │ HTTP POST 回调 Axon Server
                                ↓
                          Server 通过 WS 转发给 Hand
                          Hand 执行 → WS 返回结果 → Server
                                │
                                │ Hook 脚本收到 HTTP 响应
                                ↓
                          Hook 输出 JSON（allow+updatedInput / deny+additionalContext）
                          claude CLI 继续推理
```

### 关键要点

1. **claude CLI 通过 `--input-format stream-json --output-format stream-json` 启动**，Server 通过 stdin/stdout 发送 prompt 和接收流式输出

2. **PreToolUse Hook 通过 settings.json 配置**，指向 `dispatch.sh`（已有的 Phase 0 代码）

3. **Hook 脚本改造**：当前 Phase 0 的 Hook 脚本做本地安全过滤。方案 B 需要将它们改造为 HTTP 回调模式：
   - Hook 脚本拦截工具调用 JSON
   - HTTP POST 到 Axon Server 的内部端点（如 `http://localhost:${AXON_PORT}/internal/tool-call`）
   - **阻塞等待** HTTP 响应（curl 会阻塞直到 Server 返回）
   - 将 Server 返回的决策 JSON 输出到 stdout
   - Server 端收到工具调用后通过 WS 转发给 Hand，等 Hand 返回后回复 HTTP

4. **Session/Prompt 的消息流**：
   - Hand 发 WS `prompt` → Server 通过 stdin 发给 claude CLI
   - claude CLI 输出通过 stdout 流式到 Server → Server 通过 WS 发 `text_chunk` 给 Hand
   - claude CLI 触发工具调用 → Hook 脚本 HTTP → Server WS → Hand 执行 → WS → Server HTTP → Hook 脚本 → claude CLI

5. **两个通信端口**：
   - 外部端口（如 8765）：Hand WS 连接
   - 内部端口或 Unix Socket：Hook 脚本 HTTP 回调（应只允许本机访问）

## 四、需要改造的代码

### 4.1 需要新增/修改的 Server 端代码

| 文件 | 改动 |
|------|------|
| `internal/server/session.go` | 不再实现 `acp.Handler`。改为：通过 stdin/stdout 与 claude CLI 通信（stream-json 格式），生成 settings.json 配置 Hook |
| `internal/server/server.go` | 新增 `/internal/tool-call` HTTP 端点，接收 Hook 脚本的回调 |
| `internal/server/hookbridge.go`（新）| Hook HTTP 回调处理：接收工具调用 → ToolRelay.CreatePending → WS 转发 Hand → 等 Hand 返回 → HTTP 响应给 Hook 脚本 |

### 4.2 需要改造的 Hook 脚本

| 文件 | 改动 |
|------|------|
| `proxy/dispatch.sh` | 新增 HTTP 回调模式：检测环境变量 `AXON_CALLBACK_URL`，存在则走 HTTP 回调，不存在则走现有本地过滤逻辑 |
| `proxy/lib.sh` | 新增 `proxy_relay_to_server()` 函数：curl POST 到 Server，阻塞等待响应 |

### 4.3 Claude CLI 启动配置

Server 启动 claude CLI 时需要：
```bash
claude --input-format stream-json --output-format stream-json \
  --dangerously-skip-permissions
```

同时在会话目录下生成 `.claude/settings.local.json`：
```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": ".*",
      "hooks": [{
        "type": "command",
        "command": "AXON_CALLBACK_URL=http://localhost:${INTERNAL_PORT}/internal/tool-call AXON_SESSION_ID=${SESSION_ID} \"${PROXY_DIR}/dispatch.sh\""
      }]
    }]
  }
}
```

### 4.4 internal/acp/ 的变化

当前的 `internal/acp/` 包实现了完整的 ACP JSON-RPC Client，包含 Handler 接口。方案 B 下：
- `internal/acp/client.go` 的 Handler 机制**不再需要**（claude CLI 不会发 ACP 回调）
- 但 `jsonrpc.go` 的 Transport 和 `types.go` 的 SessionUpdate 类型仍然有用——claude CLI 的 `--output-format stream-json` 输出就是这些类型
- 需要简化：去掉 Handler 接口，改为纯 stdin writer + stdout reader

### 4.5 stream-json 格式

claude CLI 的 `--output-format stream-json` 输出的不是 ACP JSON-RPC，而是 SDK 定义的 `SDKMessage` 格式（POC 中验证过）：

```jsonl
{"type":"system","subtype":"init",...}
{"type":"assistant","message":{"content":[{"type":"text","text":"..."}]},...}
{"type":"result","subtype":"success","result":"..."}
```

`--input-format stream-json` 的输入格式：
```jsonl
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"用户输入"}]}}
```

这些不是 JSON-RPC，是独立的 NDJSON 消息。需要定义对应的 Go 类型。

## 五、不需要改动的代码

| 文件/目录 | 原因 |
|-----------|------|
| `internal/server/relay.go` | ToolRelay 的 CreatePending/Resolve/Reject 机制不变 |
| `internal/hand/` 全部 | Hand CLI 的 WS 客户端 + Executor + UI 不变 |
| `internal/protocol/messages.go` | WS 消息协议不变 |
| `cmd/hand/main.go` | 不变 |
| `proxy/lib.sh` | 在现有基础上扩展，不破坏本地过滤功能 |
| `proxy/dispatch.sh` | 在现有基础上扩展，不破坏本地过滤功能 |

## 六、测试 & 验证

- 现有 12 个测试需要适配 session.go 的改造
- 新增 hookbridge 的测试：模拟 Hook 脚本 HTTP 回调 → Server 处理 → 返回决策 JSON
- 端到端测试需要实际的 claude CLI

## 七、用量监控

5h 用量 API：
```
curl -s 'https://viewer.crs.nerd.moe/api/accounts/1/usage?key=3779cb69-8fbd-4f14-a299-1badccfd46c0'
```
返回 JSON `data.five_hour.utilization`（百分比），超过 90% 应 sleep 到 `remaining_seconds` 后重置。

## 八、工作规范

详见 `~/.claude/CLAUDE.md` 和 `~/.claude/rules/` 下的规则文件。关键：
- 中文思考/回复
- 使用 Codex 交叉评审（决策类场景）
- Git commit 格式：`<gitmoji> [中英双语简述]`
- Go 版本：使用 `/opt/homebrew/bin/go`（1.26.1）
