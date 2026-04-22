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

### Client 侧 / Client Side

Client 在用户本地机器运行，负责执行 Claude 的工具调用（Read/Write/Bash/Grep 等）。以下为 Client 侧的系统级依赖：

The Client runs on the user's local machine and executes Claude's tool calls (Read/Write/Bash/Grep, etc.). System-level dependencies for the Client:

| 依赖 / Dependency | 级别 / Level | 说明 / Description |
|---|---|---|
| **Node.js** >= 18 | 必须 / Required | 运行时环境，需要 `node` 和 `npm`。Node 18+ 内置 `fetch` API，供 WebFetch 工具使用 / Runtime, requires `node` and `npm`. Node 18+ provides built-in `fetch` API for WebFetch tool |
| **bash** | 必须 / Required | Bash 工具硬编码使用 `/bin/bash` 执行命令 / Bash tool uses `/bin/bash` (hardcoded path) to execute commands |
| **git** | 强烈推荐 / Strongly recommended | Claude Code 的大部分操作依赖 `git`（diff、blame、commit 等）/ Most Claude Code operations depend on `git` (diff, blame, commit, etc.) |
| **grep** | 推荐 / Recommended | Grep 工具优先调用系统 `grep -rn`，不可用时回退到纯 Node.js 实现 / Grep tool prefers system `grep -rn`, falls back to pure Node.js implementation |

> **编译工具链不是必须的 / Build toolchain is NOT required**：Client 的所有 npm 依赖（`ws`、`commander`、`@modelcontextprotocol/sdk`、`http-proxy-agent`、`https-proxy-agent`）均为纯 JavaScript 包，`npm install` 无需 `gcc`/`g++`/`make`/`python`。
>
> All npm dependencies are pure JavaScript — no native compilation toolchain (`gcc`/`g++`/`make`/`python`) is needed for `npm install`.

**macOS 安装示例 / macOS example**：

```bash
# Node.js（通过 nvm 或 Homebrew）
brew install node@20       # 或 nvm install 20

# Git（macOS 通常自带 Xcode Command Line Tools 中的 git）
xcode-select --install     # 如果还没装过 / if not installed yet
```

**Linux（Debian/Ubuntu）安装示例 / Linux (Debian/Ubuntu) example**：

```bash
# Node.js（通过 NodeSource）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 系统依赖 / System dependencies
sudo apt-get install -y git bash grep
```

### Server 侧 / Server Side

- **Docker**（仅 Server 容器模式需要 / required only for Docker mode）
- **Claude CLI**（仅 Server 本地直跑模式需要，需已认证：`claude auth` / required only for local mode, must be authenticated）
- **TypeScript**：编译依赖 `tsc`，已包含在 `devDependencies` 中，`npm install` 后即可用 / Build dependency, included in `devDependencies`

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

启用容器级透明 SOCKS5 代理（fail-closed）：

```bash
CERELAY_SOCKS_PROXY=socks5://user:pass@proxy.example.com:1080 npm run server:up
```

也支持紧凑格式：

```bash
CERELAY_SOCKS_PROXY=proxy.example.com:1080:user:pass npm run server:up
```

开启后，Server 容器及其内部启动的 PTY/Claude 子进程都会继承容器网络命名空间；代理异常或 `sing-box` 退出时，入口脚本会终止主进程，避免回退直连。

#### 本地直跑 / Run Locally

需本机已安装并认证 `claude` CLI：

```bash
cd server && npm start -- --port 8765 --model claude-sonnet-4-20250514
```

### 安装 Client CLI / Install the Client CLI

#### 方式 A：单文件 Bundle（推荐） / Single-file Bundle (Recommended)

通过 Docker 构建一个自包含的单文件，产物仅依赖 Node.js >= 18，不需要 `node_modules`：

Build a self-contained single file via Docker. The output only requires Node.js >= 18, no `node_modules` needed:

```bash
cd client && npm run bundle:docker
```

产物位于 `client/dist/cerelay-bundle.mjs`（约 1.2MB）。安装到系统：

Output is at `client/dist/cerelay-bundle.mjs` (~1.2MB). Install system-wide:

```bash
mkdir -p ~/.local/bin
cp client/dist/cerelay-bundle.mjs ~/.local/bin/cerelay.mjs
printf '#!/bin/sh\nexec node "$HOME/.local/bin/cerelay.mjs" "$@"\n' > ~/.local/bin/cerelay
chmod +x ~/.local/bin/cerelay
```

> 也可本地 bundle（需先 `npm install`）/ Local bundle (requires `npm install` first):
> ```bash
> cd client && npm run bundle
> ```

#### 方式 B：源码安装 / Source Install

将 `cerelay` 命令安装到 `~/.local/bin`（包含 `dist/` + `node_modules/`）：

Install the `cerelay` command to `~/.local/bin` (includes `dist/` + `node_modules/`):

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

### 通过代理连接 / Connecting Through a Proxy

Client 支持 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 环境变量，兼容 Caddy Forward Proxy 等 CONNECT 代理：

Client supports `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` environment variables, compatible with Caddy Forward Proxy and other CONNECT proxies:

```bash
# 通过 HTTP 代理连接 Server
HTTPS_PROXY=http://proxy.internal:8080 cerelay --server https://remote-server.example.com

# 跳过代理（直连）
NO_PROXY=localhost,127.0.0.1 cerelay --server localhost:8765
```

- `https://` 目标使用 `HTTPS_PROXY`，`http://` 目标使用 `HTTP_PROXY`
- `ALL_PROXY` 作为通用回退
- `NO_PROXY` 支持精确匹配、后缀匹配（`.example.com`）、端口匹配（`host:port`）和通配符（`*`）

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
| `CERELAY_SOCKS_PROXY` | — | 容器级透明 SOCKS5 代理，支持 `socks5://...` 或 `host:port[:user:pass]` |
| `CERELAY_SOCKS_DNS_SERVER` | `1.1.1.1` | TUN 模式上游 DNS |
| `CERELAY_SOCKS_TUN_ADDRESS` | `172.19.0.1/30` | sing-box TUN 地址段 |
| `CERELAY_SOCKS_TUN_MTU` | `9000` | sing-box TUN MTU |
| `CLAUDE_CREDENTIALS` | — | Claude Code 登录凭证 JSON（替代文件挂载） |
| `ANTHROPIC_API_KEY` | — | Claude API Key |
| `HTTP_PROXY` | — | Client 连接 ws:// 目标时使用的代理 |
| `HTTPS_PROXY` | — | Client 连接 wss:// 目标时使用的代理 |
| `ALL_PROXY` | — | 代理通用回退（优先级低于上面两个） |
| `NO_PROXY` | — | 不走代理的地址列表（逗号分隔） |

## License

MIT
