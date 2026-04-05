# Axon

Claude Code 的分体式架构：用户在 Hand 端交互，Hand 在本地执行工具，Server 端负责调用 Claude Agent SDK 进行推理，并通过 WebSocket 将工具调用转发回 Hand。

Split architecture for Claude Code: users interact on Hand, Hand executes tools locally, and the Server uses the Claude Agent SDK for reasoning while forwarding tool calls back to Hand over WebSocket.

## 架构总览 / Architecture Overview

```mermaid
flowchart LR
    H1[Hand CLI / TypeScript<br/>用户交互 + 工具执行]
    HN[Hand N / Future]
    S[Axon Server / TypeScript<br/>query() + hooks.PreToolUse]
    C[Claude Code CLI<br/>spawned by SDK]

    H1 <-->|WebSocket| S
    HN -. optional .-> S
    S -->|SDK query stream| C
```

当前主路径是：

The primary path today is:

```text
Hand (TypeScript) ←→ WebSocket ←→ Server (TypeScript) ←→ Claude Agent SDK query() ←→ claude CLI
```

## 概念 / Concepts

- **Hand 端 / Hand**：用户交互入口，也是 Claude 原生工具的执行环境。当前实现为 TypeScript CLI，支持 `Read`、`Write`、`Edit`、`MultiEdit`、`Bash`、`Grep`、`Glob`。
- **Server 端 / Server**：Brain 端，位于 [`server/src`](./server/src)。使用 `@anthropic-ai/claude-agent-sdk` 的 `query()` 驱动 Claude Code，并通过 `hooks.PreToolUse` 在进程内拦截工具调用。
- **通信 / Transport**：Server 与 Hand 之间通过 WebSocket 全双工通信，文本流和工具调用共用一条连接。
- **Proxy / Hook 脚本**：[`proxy/`](./proxy) 中的 Axon relay 模式已实现，但不是主路径；主路径不依赖 HTTP hookbridge、`dispatch.sh` relay 或 `settings.local.json` 注入。

## 核心时序 / Core Sequence

```mermaid
sequenceDiagram
    participant H as Hand (TypeScript)
    participant S as Server (TypeScript)
    participant SDK as Claude Agent SDK
    participant C as claude CLI

    H->>S: WS prompt
    S->>SDK: query({ prompt, hooks.PreToolUse })
    SDK->>C: run prompt
    C-->>S: assistant text/thinking stream
    S-->>H: text_chunk / thought_chunk
    C->>S: hooks.PreToolUse(tool_name, tool_input)
    S-->>H: WS tool_call
    H->>H: execute Read/Write/Edit/MultiEdit/Bash/Grep/Glob
    H-->>S: WS tool_result
    S-->>C: hook return (deny + additionalContext)
    C-->>S: final result
    S-->>H: session_end
```

关键点：

Key points:

- **SDK 直接集成 / Direct SDK integration**：不再通过 ACP bridge 把工具调用转换成 client-side methods，而是直接使用 `query()` 和 `hooks.PreToolUse`。
- **进程内 Hook / In-process hooks**：工具拦截发生在 TypeScript Server 进程内，不需要额外的 HTTP bridge。
- **Hand 执行 Claude 原生工具 / Hand executes Claude-native tools**：Hand 按 Claude 工具语义执行本地操作，而不是 ACP 方法名。

## 项目结构 / Project Structure

```text
axon/
├── package.json              # npm workspaces 根配置
├── server/                   # TypeScript Axon Server（Claude Agent SDK）
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts          # Server CLI 入口，解析 --port / --model
│       ├── server.ts         # HTTP + WebSocket Server
│       ├── session.ts        # query() + hooks.PreToolUse 会话驱动
│       ├── relay.ts          # 工具调用 pending/result 管理
│       └── protocol.ts       # 消息类型定义
├── hand/                     # TypeScript Hand CLI
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts          # Hand CLI 入口
│       ├── client.ts         # WebSocket 客户端
│       ├── executor.ts       # 工具分发器
│       ├── protocol.ts       # 消息类型定义
│       ├── ui.ts             # 终端 UI
│       └── tools/
│           ├── fs.ts         # Read / Write / Edit / MultiEdit
│           ├── bash.ts       # Bash
│           └── search.ts     # Grep / Glob
└── proxy/                    # Phase 0 Hook 系统（bash，独立使用）
```

说明：

Notes:

- `server/` 与 `hand/` 是当前主实现，均为 TypeScript。
- `proxy/` 仍保留，作为独立 Hook/审计能力沉淀。

## 快速开始 / Quick Start

### 1. 安装依赖 / Install Dependencies

```bash
npm install
```

### 2. 启动 Server / Start the Server

```bash
cd server && npm start -- --port 8765 --model claude-sonnet-4-20250514
```

可选参数 / Optional flags：`--port`（默认 8765）、`--model`（默认使用 SDK 配置）

前置条件 / Prerequisites：

- 已安装 Node.js 与 npm
- 已安装并认证 `claude` CLI
- 当前环境可使用 `@anthropic-ai/claude-agent-sdk`

### 3. 启动 Hand / Start the Hand

在新终端中执行：

Run in a new terminal:

```bash
cd hand && npm start -- --server localhost:8765 --cwd /path/to/project
```

### 4. 交互 / Interact

Hand CLI 连接成功后会自动创建 session。输入 prompt，Server 会通过 SDK 发起一次 `query()`；当 Claude 调用工具时，Hand 在本地执行并把结果回传。

After Hand connects, it creates a session automatically. Each prompt triggers one SDK `query()` call; when Claude requests a tool, Hand executes it locally and returns the result.

## 组件说明 / Components

### TypeScript Server

- 位于 [`server/src`](./server/src)
- 使用 `@anthropic-ai/claude-agent-sdk`
- 通过 `query()` 获取流式输出
- 通过 `hooks.PreToolUse` 拦截工具调用
- 通过 WebSocket 将 `tool_call` / `tool_result` 与 Hand 关联
- 默认监听 `/ws` 和 `/health`

### Hand CLI

- 位于 [`hand/src`](./hand/src)
- 负责终端交互、Session 驱动和本地工具执行
- 当前支持的 Claude 原生工具：
  - `Read`
  - `Write`
  - `Edit`
  - `MultiEdit`
  - `Bash`
  - `Grep`
  - `Glob`

### Proxy Hook 系统 / Proxy Hook System

- 位于 [`proxy/`](./proxy)
- 包含 Phase 0 的安全过滤与审计能力
- 独立可用，不是主路径

## 技术选择 / Technology Choices

| 组件 / Component | 当前方案 / Current Choice | 说明 / Notes |
|---|---|---|
| Brain Server | TypeScript + Node.js | 直接接入 Claude Agent SDK |
| Hand CLI | TypeScript + Node.js | 轻量 CLI，本地执行 Claude 原生工具 |
| Server ↔ Hand | WebSocket | 双向流式输出与工具回传 |
| Tool interception | `hooks.PreToolUse` | SDK 进程内回调 |
| Claude driver | `query()` | 官方 SDK 主接口 |

## Roadmap

| 阶段 / Phase | 内容 / Scope | 状态 / Status |
|---|---|---|
| Phase 0 | Proxy Hook 安全过滤系统 | ✅ 已完成 |
| Phase 1 | SDK / ACP 可行性 POC | ✅ 已完成 |
| Phase 2 | TypeScript Server + SDK hooks + TypeScript Hand | ✅ 已完成 |
| Phase 3 | Brain 容器化（Docker） | ✅ 已完成 |
| Phase 4 | Hand CLI ACP Server（编辑器集成） | ✅ 已完成 |
| Phase 5 | Hand Web（浏览器端） | ✅ 已完成 |
| Phase 6 | 生产化（TLS / 认证 / Multi-Hand） | 🚧 进行中 |

当前未完成的高优先级项：

- Web/Hand 断线后的 session 恢复，而不只是重连后新建 session
- `query()` 权限策略从 `bypassPermissions` 收敛到更细粒度的 `canUseTool`
- 指标与 tracing（Prometheus / OpenTelemetry）
- 反向代理下的 TLS / 部署示例

详细规划见 [`.claude/ROADMAP.md`](./.claude/ROADMAP.md)。

See [`.claude/ROADMAP.md`](./.claude/ROADMAP.md) for the detailed plan.

## License

MIT
