# Axon 执行规划

## 架构全景

```text
┌──────────────────────────────────────────────────────────────┐
│                         Hand 端                              │
│                                                              │
│  ┌────────────────────┐      ┌────────────────────────────┐ │
│  │ Hand CLI (TS)      │      │ Hand Web / Editor (未来)   │ │
│  │ 用户交互            │      │ 复用同一协议                │ │
│  │ 本地工具执行        │      │                            │ │
│  └──────────┬─────────┘      └──────────────┬─────────────┘ │
│             │ WebSocket                      │               │
└─────────────┼────────────────────────────────┼───────────────┘
              │                                │
┌─────────────▼────────────────────────────────▼───────────────┐
│                    Axon Server (TypeScript)                  │
│                                                              │
│  - Session 管理                                               │
│  - `query()` 驱动 Claude Code                                │
│  - `hooks.PreToolUse` 工具拦截                               │
│  - 文本流 / 思考流 / 工具调用通过 WS 发给 Hand                │
└─────────────┬────────────────────────────────────────────────┘
              │ SDK 内部 spawn / stream
┌─────────────▼────────────────────────────────────────────────┐
│                        Claude Code CLI                       │
│                                                              │
│  - LLM 推理                                                   │
│  - 触发 Claude 原生工具调用                                   │
│  - 由 SDK hooks 在 Server 进程内拦截                          │
└──────────────────────────────────────────────────────────────┘

补充：
- 整个项目为纯 TypeScript（Node.js），使用 npm workspaces 管理
- `proxy/` 的 Axon relay 模式已实现，但不是主路径
```

## 交互时序

```text
Hand CLI (TS)         Axon Server (TS)            Claude Agent SDK / claude CLI
  │                           │                                 │
  │ ── WS create_session ───→ │                                 │
  │ ←─ WS session_created ─── │                                 │
  │                           │                                 │
  │ ── WS prompt ───────────→ │ ── query({ prompt, hooks }) ─→ │
  │                           │                                 │
  │ ←─ WS text_chunk ─────── │ ←──── assistant text stream ─── │
  │ ←─ WS thought_chunk ──── │ ←──── assistant thinking ────── │
  │                           │                                 │
  │ ←─ WS tool_call ──────── │ ←──── hooks.PreToolUse(...) ─── │
  │    [本地执行工具]          │                                 │
  │ ── WS tool_result ─────→ │ ── hook return / additionalContext →
  │                           │                                 │
  │ ←─ WS session_end ────── │ ←────────── final result ────── │
```

## 当前技术栈

| 组件 | 当前方案 | 说明 |
|------|----------|------|
| Axon Server | TypeScript (Node.js) | 当前主实现，直接使用 `@anthropic-ai/claude-agent-sdk` |
| Hand CLI | TypeScript (Node.js) | 终端交互与本地工具执行 |
| Hand Web | TypeScript (待定) | 后续浏览器端 |
| 编辑器集成 | ACP Server（规划中） | 预计由 Hand 侧暴露 |
| 工具拦截 | SDK `hooks.PreToolUse` | 进程内回调，不走 HTTP hookbridge |
| Server ↔ Hand | WebSocket | 全双工文本流与工具回传 |
| Proxy | Bash Hook 系统 | `proxy/` 独立可用，但非主路径 |

## 分阶段执行

### Phase 0: 基础设施 ✅ 已完成

- [x] PreToolUse Hook 系统（`proxy/dispatch.sh`）
- [x] 工具代理脚本框架（`*.sh.example`）
- [x] 共享工具库（`proxy/lib.sh`）
- [x] 审计日志系统

### Phase 1: SDK / ACP 可行性验证 ✅ 已完成

**目标**：确认 Claude Code 可被程序化驱动，并验证工具拦截的真实落点。

**完成内容**：
- [x] TypeScript POC 验证 `query()` 流式输出
- [x] 验证 `hooks.PreToolUse` 可截获 Claude 原生工具调用
- [x] 验证 ACP client-side methods 本质上是 SDK hooks 的包装，而非 claude CLI 原生输出
- [x] 形成选项 A/B/C 的对比结论，最终选择选项 C

### Phase 2: 选项 C 主链路 ✅ 已完成

**目标**：以最短路径打通 Hand ↔ Server ↔ Claude 的闭环，并完成 Hand 从 Go 到 TypeScript 的迁移。

**完成内容**：
- [x] 新建 `server/` TypeScript Server
- [x] `server/src/session.ts` 使用 `query()` 驱动 Claude Code
- [x] 在 `hooks.PreToolUse` 中将工具调用转发给 Hand
- [x] 新建 `hand/` TypeScript Hand CLI，支持 `Read`、`Write`、`Edit`、`MultiEdit`、`Bash`、`Grep`、`Glob`
- [x] WebSocket 文本流、思考流、工具调用、结果回传全部打通
- [x] 使用 npm workspaces 统一管理 server/ 和 hand/
- [x] 移除所有 Go 代码

### Phase 3: Brain 容器化

**目标**：将主路径打包成可分发的 Brain 运行环境。

**交付物**：
- Dockerfile：Node.js + Claude Code CLI + TypeScript Server
- 容器启动脚本：初始化认证、环境变量、启动 Server
- `docker-compose.yml`
- 文档：Hand 如何连接容器化 Brain

**依赖**：Phase 2

### Phase 4: Hand CLI — ACP Server

**目标**：Hand CLI 对外暴露 ACP 接口，让编辑器可把 Hand 当作 Claude Code 使用。

**交付物**：
- ACP Server（stdio）
- `initialize` / `session/new` / `session/prompt` / `session/update`
- 编辑器集成文档

**依赖**：Phase 2

### Phase 5: Hand Web

**目标**：提供浏览器端交互界面。

**交付物**：
- Web UI
- Session 管理
- 工具执行状态展示
- 与 Axon Server 的 WebSocket 集成

**依赖**：Phase 2

### Phase 6: 生产化

**目标**：安全、可管理、可扩展。

#### 6.1 认证与安全

- Token 认证
- TLS 由反向代理承担
- Token 生命周期管理

#### 6.2 管理后台

- 用户与 Token 管理
- 当前在线 Hand 列表
- Session 与工具调用统计
- 结构化日志与监控

#### 6.3 Multi-Hand 调度

- 多 Hand 同时连接时的任务分配
- Session Affinity

#### 6.4 可靠性

- 优雅关闭
- 断线恢复
- Prometheus metrics / tracing

**依赖**：Phase 3-5

## 里程碑

| 里程碑 | 包含 Phase | 交付标志 |
|--------|-----------|---------|
| **M1: 端到端主链路** | 1 + 2 | Hand CLI 输入 → TS Server 推理 → Hand 执行工具 → 结果返回 |
| **M2: 可分发 Brain** | 3 | `docker run` 一键启动 Brain |
| **M3: 编辑器集成** | 4 | Zed / VS Code 可通过 ACP 连接 Hand |
| **M4: Web 端** | 5 | 浏览器中使用 Axon |
| **M5: 生产就绪** | 6 | 安全、多 Hand、可监控 |
