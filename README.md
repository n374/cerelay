# Axon

Claude Code 的分体式架构：用户在 Hand 端交互，Hand 将思考委托给 Brain，Brain 推理完成后由 Hand 执行。

Split architecture for Claude Code: users interact with Hand, Hand delegates thinking to Brain, Brain completes reasoning and Hand executes.

```
┌─────────┐  ┌─────────┐  ┌─────────┐
│  Hand 1 │  │  Hand 2 │  │ Hand N  │
│  终端交互│  │  终端交互│  │ 终端交互│
│  工具执行│  │  工具执行│  │ 工具执行│
└────┬─────┘  └────┬────┘  └────┬────┘
     │             │            │
     │  WebSocket  │  WebSocket │
     │             │            │
     └─────────┐   │   ┌───────┘
               ▼   ▼   ▼
         ┌─────────────────┐
         │   Axon Server   │
         │   (Brain 端)    │
         │                 │
         │  ACP ↔ claude   │
         │  CLI 子进程     │
         └─────────────────┘
```

## 概念 / Concepts

**Axon**（轴突）— 神经纤维，在大脑与肢体之间双向传导信号。

- **Hand 端**：用户的交互入口，也是工具的执行环境。连接 Server，接收工具调用请求，在本地执行
- **Brain 端**（Axon Server）：纯思考服务。通过 ACP 协议管理 claude CLI 子进程，将工具调用转发给 Hand
- **ACP**：Agent Communication Protocol，claude CLI 的标准通信协议（JSON-RPC 2.0 over stdio）

## 架构 / Architecture

```
Hand CLI                    Axon Server                 claude CLI (子进程)
  │                              │                              │
  │ ── WS: create_session ─────→ │ ── ACP: initialize ────────→ │
  │ ← WS: session_created ───── │ ← ACP: capabilities ──────── │
  │                              │ ── ACP: session/new ────────→ │
  │                              │                              │
  │ ── WS: prompt ─────────────→ │ ── ACP: session/prompt ────→ │
  │                              │                              │
  │ ← WS: text_chunk ────────── │ ← ACP: session/update ────── │
  │ ← WS: thought_chunk ─────── │   (agent_message_chunk)      │
  │                              │                              │
  │                              │     claude CLI 需要读文件     │
  │                              │ ← ACP: fs/read_text_file ─── │
  │ ← WS: tool_call ─────────── │                              │
  │                              │                              │
  │  [本地读取文件]              │                              │
  │                              │                              │
  │ ── WS: tool_result ────────→ │ ── ACP: response ──────────→ │
  │                              │                              │
  │                              │     claude CLI 需要执行命令   │
  │                              │ ← ACP: terminal/create ───── │
  │ ← WS: tool_call ─────────── │                              │
  │  [本地执行命令]              │                              │
  │ ── WS: tool_result ────────→ │ ── ACP: response ──────────→ │
  │                              │                              │
  │ ← WS: session_end ───────── │ ← ACP: prompt result ─────── │
```

**关键设计**：

- **ACP 原生回调**：claude CLI 通过 ACP 主动请求文件操作和终端命令，Axon Server 将这些请求透传给 Hand，不需要 Hook hack
- **WebSocket 全双工**：Hand ↔ Server 之间用 WebSocket，支持双向实时通信
- **Go 单二进制**：Server 和 Hand 各一个二进制，零运行时依赖

## 项目结构 / Project Structure

```
axon/
├── cmd/
│   ├── server/main.go       # Axon Server 入口
│   └── hand/main.go         # Hand CLI 入口
├── internal/
│   ├── acp/                  # ACP 协议实现
│   │   ├── jsonrpc.go        # JSON-RPC 2.0 NDJSON Transport
│   │   ├── types.go          # ACP 协议类型
│   │   └── client.go         # ACP Client（管理 claude CLI 子进程）
│   ├── server/               # Axon Server
│   │   ├── server.go         # HTTP + WebSocket 服务器
│   │   ├── session.go        # Brain 会话（实现 acp.Handler）
│   │   └── relay.go          # 工具调用中继
│   ├── hand/                 # Hand CLI
│   │   ├── client.go         # WebSocket 客户端
│   │   ├── executor.go       # 本地工具执行器
│   │   └── ui.go             # 终端 UI
│   └── protocol/             # Hand ↔ Server 消息协议
│       └── messages.go
├── proxy/                    # Phase 0: Bash Hook 安全过滤（独立可用）
└── poc/                      # ACP 可行性 POC（TS）
```

## 快速开始 / Quick Start

```bash
# 编译
go build -o bin/axon-server ./cmd/server
go build -o bin/axon-hand ./cmd/hand

# 启动 Server（Brain 端，需要 claude CLI 可用）
./bin/axon-server --port 8765

# 启动 Hand CLI（另一个终端）
./bin/axon-hand --server localhost:8765 --cwd /path/to/project
```

Hand CLI 启动后进入交互模式，输入 prompt 即可。

## 组件说明 / Components

### Axon Server (Brain 端)

- 监听 WebSocket 连接（`/ws`）
- 每个 Session 启动一个 claude CLI 子进程
- 通过 ACP 协议与 claude CLI 通信
- 将 claude CLI 的 ACP 回调（文件读写、终端命令、权限请求）转发给 Hand
- 工具调用超时 120 秒

```
axon-server [flags]

  -port int      监听端口 (默认 8765)
  -model string  默认模型
```

### Hand CLI (Hand 端)

- WebSocket 连接 Server
- 本地执行工具调用：
  - `fs/read_text_file` — 读取文件
  - `fs/write_text_file` — 写入文件
  - `terminal/create` — 启动子进程
  - `terminal/wait_for_exit` — 等待进程退出
  - `session/request_permission` — 权限请求（当前自动允许）
- 终端彩色输出

```
axon-hand [flags]

  -server string  Server 地址 (默认 localhost:8765)
  -cwd string     工作目录 (默认当前目录)
```

### Proxy Hook 系统 (Phase 0)

独立可用的 PreToolUse Hook 安全过滤层，详见 `proxy/README` 或项目根 README 的 Phase 0 部分。

## Roadmap

| 阶段 | 内容 | 状态 |
|------|------|------|
| **Phase 0** | Proxy Hook 安全过滤系统 | ✅ 已完成 |
| **Phase 1** | ACP 可行性 POC | ✅ 已完成 |
| **Phase 2** | Axon Server + Hand CLI (Go) | ✅ 已完成 |
| **Phase 3** | Brain 容器化（Docker） | 待开始 |
| **Phase 4** | Hand CLI ACP Server（编辑器集成） | 待开始 |
| **Phase 5** | Hand Web（浏览器端） | 待开始 |
| **Phase 6** | 生产化（TLS / 认证 / Multi-Hand） | 待开始 |

详细执行规划见 [.claude/ROADMAP.md](.claude/ROADMAP.md)

## License

MIT
