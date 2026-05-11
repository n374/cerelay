<!-- doc-init template version: v1.0 -->
# SDK Hook 拦截 + Shadow MCP Tools (Plan D)

> **Owner**: server 架构组
> **Reviewers**: 全员（涉及双路径不变量，需 e2e 守护）

本模块覆盖两个紧耦合主题：
1. SDK `PreToolUse` Hook 拦截（兜底路径）
2. Plan D Shadow MCP Tools（主路径）

完整设计与历史归档：[`../../archive/2026-05-11-plan-d-mcp-shadow-tools/design.md`](../../archive/2026-05-11-plan-d-mcp-shadow-tools/design.md)。
Living spec：[`../../specs/shadow-mcp-tools/spec.md`](../../specs/shadow-mcp-tools/spec.md)。

---

## 1. SDK Hook 拦截 / SDK Hook Interception

**文件**：`server/src/claude-hook-injection.ts`、`server/src/session.ts`

- 通过 SDK `PreToolUse` callback 拦截工具调用
- 将调用转发到 Client 执行
- 等待 Client 返回结果后再反馈给 SDK

```typescript
// sdk.query() 中的 hooks 参数
hooks: {
  onPreToolUse: async (toolCall) => {
    // 将 tool_call 转发到 Client
    // 等待 Client tool_result
    // 返回 SDK 期望的格式
  }
}
```

---

## 2. Shadow MCP Tools (Plan D)

**文件**：`server/src/mcp-routed/`、`server/src/mcp-ipc-host.ts`、`server/src/mcp-cc-injection.ts`

**目标**：绕开 PreToolUse hook 的协议硬约束（deny 分支必然 `tool_result.is_error: true`），让模型看到的工具结果 `is_error` 由 cerelay 显式控制。

### 2.1 架构

```
CC PTY ──stdio JSON-RPC──► cerelay-routed/index.ts (per-session 子进程)
                              │
                              │ unix socket
                              ▼
                          MCPIpcHost (主进程, per-session)
                              │
                              ▼
                          ClaudePtySession.dispatchToolToClient
                              │
                              ▼
                          ToolRelay → WebSocket → Client tool execution
```

### 2.2 注入入口

每个 PTY session 启动时，`pty-session.ts` 在 spawn CC 前：

1. 启动 `MCPIpcHost`（per-session unix socket，token 鉴权）
2. 给 CC 追加 CLI flags（`buildShadowMcpInjectionArgs`）：
   - `--mcp-config '<inline JSON>'`：让 CC spawn cerelay-routed 子进程
   - `--append-system-prompt <steering>`：软引导模型用 `mcp__cerelay__*` 替代内置工具
   - `--disallowedTools "Bash,Read,Write,Edit,MultiEdit,Glob,Grep"`：硬保险拒绝内置工具
3. cerelay-routed 子进程通过 IPC 把每次 `tools/call` dispatch 回主进程
4. 主进程用 `dispatchToolToClient` 复用 client-routed 转发链（路径重写 → ToolRelay → ws → client）

### 2.3 Shadow tools 清单

**Shadow tools**（7 个，与 client/src/tools 实现严格对齐）：

| MCP fully-qualified name | builtin name | 字段 |
|---|---|---|
| `mcp__cerelay__bash` | Bash | `command, timeout?(秒)` |
| `mcp__cerelay__read` | Read | `file_path, offset?(字符), limit?(字符)` |
| `mcp__cerelay__write` | Write | `file_path, content` |
| `mcp__cerelay__edit` | Edit | `file_path, old_string, new_string, replace_all?` |
| `mcp__cerelay__multi_edit` | MultiEdit | `file_path, edits[{old_string, new_string}]` |
| `mcp__cerelay__glob` | Glob | `pattern, path?` |
| `mcp__cerelay__grep` | Grep | `pattern, path?, glob?` |

### 2.4 双路径不变量（e2e 守护）

**e2e 守护文件**：`e2e-mcp-shadow-bash.test.ts` + `e2e-real-claude-bash.test.ts`

- `mcp__cerelay__*` 路径：`tool_result.is_error === false`
- legacy hook 路径（fallback / shadow MCP 关闭时）：`tool_result.is_error === true`（CC 协议硬约束）

### 2.5 Tool routing 互斥

`tool-routing.ts` 中 `mcp__cerelay__*` 一律不被视为 client-routed，避免跟 stdio MCP 路径双重执行。其他 `mcp__<other>__*` 工具仍然走 client routing（兼容用户自配 MCP server）。

### 2.6 Fallback 引导

当 shadow MCP 已启用但模型仍调用了被 disallowed 的内置工具，hook 路径返回 deny + reason `"Tool 'Bash' is not available... Use mcp__cerelay__bash instead..."`。模型下一轮自动改用 shadow 工具，仅浪费一次 round-trip。

### 2.7 Feature flag

- `CERELAY_ENABLE_SHADOW_MCP`：默认 `true`，仅显式 `false`/`0`/`no`/`off` 可关闭（用于回退到 legacy hook 路径排查问题）
- `CERELAY_SHADOW_MCP_SOCKET_DIR`：unix socket 父目录，默认 `${CERELAY_DATA_DIR}/sockets/`，缺省时兜底 `/tmp`
- 关闭 shadow MCP 后所有内置工具走原 client-routed hook 路径

### 2.8 降级语义

MCPIpcHost 启动失败时只 warn 不阻塞 session（保留原 hook 路径），符合 Plan §2 G5。

---

## 关联资源

- [Living spec: shadow-mcp-tools](../../specs/shadow-mcp-tools/spec.md)
- [历史设计归档: plan-d-mcp-shadow-tools](../../archive/2026-05-11-plan-d-mcp-shadow-tools/design.md)
- [架构总览](../README.md)
- [Session Runtime（Mount Namespace 隔离）](./session-runtime.md)
- [项目宪法](../../overview/constitution.md)
