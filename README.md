# Cerelay

**Cerelay** (cerebral + relay) 是 Claude Code 的分体式架构实现。Server 端通过 Claude Agent SDK 驱动推理，Client 端在本地执行工具，两者通过 WebSocket 双向通信。

**Cerelay** is a split-architecture implementation of Claude Code. The Server drives reasoning via the Claude Agent SDK, the Client executes tools locally, and they communicate over WebSocket.

## 架构 / Architecture

```text
Client (TypeScript)  ←— WebSocket —→  Server (TypeScript)  ←→  Claude Agent SDK  ←→  claude CLI
  ├─ 本地工具执行                        ├─ Session 管理
  ├─ MCP Runtime                        ├─ Hook 拦截 + 工具转发
  └─ 终端 UI / ACP                      └─ MCP 代理
```

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server
    participant SDK as Claude Agent SDK

    C->>S: WebSocket prompt
    S->>SDK: query({ prompt, hooks })
    SDK-->>S: text / thinking stream
    S-->>C: text_chunk / thought_chunk
    SDK->>S: PreToolUse callback (tool_call)
    S-->>C: tool_call (Read/Write/Bash/...)
    C->>C: 本地执行工具
    C-->>S: tool_result
    S-->>SDK: hook result
    SDK-->>S: session_end
    S-->>C: session_end
```

**核心设计 / Key Design**:

- **SDK Hook 拦截**：Server 通过 `PreToolUse` callback 接管工具调用，转发到 Client 执行
- **Session Runtime**：Docker 下每个 session 有独立 mount namespace，Claude 看到的 `HOME`/`cwd` 对齐 Client 本地路径
- **MCP 代理**：Server 读取 Claude 的 MCP 配置下发给 Client，Client 负责连接 MCP Server 并执行工具
- **FUSE 文件代理**：容器内通过 FUSE 将文件读写请求转发到 Client 本地文件系统

## 前置条件 / Prerequisites

- **Node.js** >= 18
- **TypeScript**：编译依赖 `tsc`，已包含在 `devDependencies` 中，`npm install` 后即可用
- **Docker**（仅 Server 容器模式需要）
- **Claude CLI**（仅 Server 本地直跑模式需要，需已认证：`claude auth`）

## 快速开始 / Quick Start

### 安装依赖 / Install Dependencies

```bash
npm install
```

> `npm install` 会自动安装所有 workspace（server / client / web）的依赖，包括 TypeScript 编译器。
>
> 如需单独为某个 workspace 添加依赖 / To add a dependency to a specific workspace:
>
> ```bash
> npm install <package> -w client          # 生产依赖
> npm install <package> --save-dev -w client  # 开发依赖
> ```

### 启动 Server / Start the Server

#### Docker（推荐） / Docker (Recommended)

前置条件：Docker、`ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`。

```bash
npm run server:up          # 启动容器
npm run server:logs        # 查看日志
npm run server:down        # 停止容器
```

容器会自动挂载 `~/.claude/.credentials.json` 作为 Claude Code 登录态，并写入 onboarding 标记跳过首次向导。

也可通过环境变量覆盖：

```bash
cp .env.example .env       # 可选，按需修改
LOG_LEVEL=debug npm run server:up
```

#### 本地直跑 / Run Locally

需本机已安装并认证 `claude` CLI：

```bash
cd server && npm start -- --port 8765 --model claude-sonnet-4-20250514
```

### 安装 Client CLI / Install the Client CLI

将 `cerelay` 命令安装到 `~/.local/bin`，之后可在任意目录直接使用：

Install the `cerelay` command to `~/.local/bin` for use from any directory:

```bash
cd client && npm run install:global
```

确保 `~/.local/bin` 在你的 `PATH` 中。如未配置，在 `~/.zshrc` 或 `~/.bashrc` 中添加：

Make sure `~/.local/bin` is in your `PATH`. If not, add to `~/.zshrc` or `~/.bashrc`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

卸载 / Uninstall:

```bash
cd client && npm run uninstall:global
```

### 启动 Client / Start the Client

安装后可在任意目录直接启动，`--cwd` 默认为当前目录：

After installation, run from any directory (`--cwd` defaults to current directory):

```bash
cerelay --server localhost:8765
```

`--server` 支持多种格式 / `--server` accepts multiple formats:

```bash
cerelay --server localhost:8765            # ws://localhost:8765/ws
cerelay --server http://example.com        # ws://example.com/ws
cerelay --server https://example.com       # wss://example.com/ws（自动 TLS）
cerelay --server wss://example.com/prefix  # wss://example.com/prefix/ws
```

也可从源码启动 / Or run from source:

```bash
cd client && npm start -- --server localhost:8765 --cwd /path/to/project
```

查看 Client 日志 / View Client logs:

```bash
cerelay logs
```

### 启动 Web UI（可选） / Start the Web UI (Optional)

```bash
cd web && npm start -- --port 8766 --server localhost:8765
```

打开 http://localhost:8766。

## 鉴权 / Authentication

### CERELAY_KEY（简单共享密钥）

Server 通过 `CERELAY_KEY` 环境变量设置共享密钥，Client 连接时需匹配：

```bash
# Server 端
CERELAY_KEY=my-secret npm run server:up

# Client 端 / Client
CERELAY_KEY=my-secret cerelay --server localhost:8765
# 或 / or
cerelay --server localhost:8765 --key my-secret
```

建议将 `CERELAY_KEY` 写入 `~/.zshrc` 或 `~/.bashrc`，避免每次输入：

```bash
export CERELAY_KEY=my-secret
```

### Claude Code 登录态

容器内的 Claude Code 需要登录态才能工作。两种方式：

1. **文件挂载**（默认）：自动挂载 `~/.claude/.credentials.json` 到容器
2. **环境变量**：通过 `CLAUDE_CREDENTIALS` 传入凭证 JSON

```bash
# 方式 2：环境变量
CLAUDE_CREDENTIALS='{"claudeAiOauth":{...}}' npm run server:up
```

## 项目结构 / Project Structure

```text
cerelay/
├── server/                   # Server（Claude Agent SDK 集成）
│   └── src/
│       ├── server.ts         # HTTP + WebSocket + 工具转发
│       ├── session.ts        # SDK query() 会话驱动
│       ├── claude-session-runtime.ts  # Mount namespace 隔离
│       └── pty-session.ts    # PTY 终端会话
├── client/                   # Client（本地工具执行）
│   └── src/
│       ├── index.ts          # CLI 入口（默认 PTY 模式）
│       ├── client.ts         # WebSocket 客户端
│       ├── executor.ts       # 工具分发（Read/Write/Edit/Bash/Grep/Glob）
│       └── acp/              # ACP 模式（编辑器集成）
├── web/                      # 浏览器 UI（可选）
├── docker-compose.yml
├── Dockerfile
└── docker-entrypoint.sh
```

## 开发 / Development

### 构建 / Build

```bash
npm run test:workspaces       # 编译并测试所有 workspace
cd server && npm run build    # 单独编译
```

### 类型检查 / Type Check

```bash
cd server && npm run typecheck
cd client && npm run typecheck
```

### 测试 / Testing

```bash
npm test                      # 全部测试（smoke + workspaces）
npm run test:smoke            # 烟测（Docker entrypoint）
npm run test:workspaces       # 各 workspace 单元/集成测试

# 单个 workspace
cd server && npm test
cd client && npm test
cd web && npm test
```

## 环境变量 / Environment Variables

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CERELAY_KEY` | — | Client 连接共享密钥 |
| `SERVER_PORT` | `8765` | 容器内监听端口 |
| `SERVER_HOST_PORT` | `8765` | 宿主机映射端口 |
| `MODEL` | `claude-sonnet-4-20250514` | 默认 Claude 模型 |
| `LOG_LEVEL` | `info` | 日志级别 |
| `CERELAY_ENABLE_MOUNT_NAMESPACE` | `true` | 是否启用 mount namespace 隔离 |
| `CLAUDE_CREDENTIALS` | — | Claude Code 登录凭证 JSON（替代文件挂载） |
| `ANTHROPIC_API_KEY` | — | Claude API Key |

## License

MIT
