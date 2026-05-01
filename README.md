# Cerelay

**Cerelay**（cerebral + relay）让你在远端跑一个统一的 Claude Code 服务，本地用 `cerelay` CLI 接入；工具调用始终在本机执行，文件、shell、git 都用你本地的环境，远端只负责模型与 PTY。

**Cerelay** lets you run a centralized Claude Code service remotely, then connect to it from your local machine via the `cerelay` CLI. Tool calls always run locally — your files, shell, and git stay on your machine while the remote handles the model and PTY.

> 想了解 Cerelay 的内部架构、技术选型、核心机制？请看 [`docs/architecture.md`](./docs/architecture.md)。
>
> Looking for the internal architecture, technology choices, or implementation details? See [`docs/architecture.md`](./docs/architecture.md).

---

## 能做什么 / What You Get

- **远端托管 Claude Code**：API key、登录态、依赖都集中在 Server 端，本地只装一个 CLI。
- **工具调用在本机执行**：`Read` / `Write` / `Edit` / `Bash` / `Grep` / `Glob` 全部走你本地的真实文件系统，不需要把代码上传到远端。
- **多账号 / 多代理出口**：一个 Server 容器对应一套凭证 + 代理出口，账号之间用并列容器实例隔离。
- **代理穿透**：Client 支持 `HTTPS_PROXY` / `NO_PROXY`；Server 容器侧支持透明 SOCKS5（fail-closed）。
- **编辑器集成**：除了 CLI，还提供 ACP (stdio JSON-RPC) 模式，可被 Zed / VS Code 等编辑器作为 Claude Code 调用。
- **Web UI（可选）**：浏览器接入 Server，复用同一 WebSocket 协议。

---

## 前置条件 / Prerequisites

### Client 侧 / Client Side

Client 在你本机运行，下面这些是系统级依赖：

| 依赖 / Dependency | 级别 / Level | 说明 / Description |
|---|---|---|
| **Node.js** >= 18 | 必须 / Required | 运行时环境，需要 `node` 和 `npm`。Node 18+ 内置 `fetch` API |
| **bash** | 必须 / Required | Bash 工具硬编码使用 `/bin/bash` |
| **git** | 强烈推荐 / Strongly recommended | Claude Code 大量操作依赖 `git`（diff、blame、commit 等） |
| **grep** | 推荐 / Recommended | Grep 工具优先用系统 `grep -rn`，不可用则回退纯 Node 实现 |

> **不需要本地编译工具链**：Client 所有 npm 依赖均为纯 JavaScript 包，`npm install` 不依赖 `gcc`/`g++`/`make`/`python`。

**macOS**：

```bash
brew install node@20       # 或 nvm install 20
xcode-select --install     # 如未装过
```

**Linux (Debian/Ubuntu)**：

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git bash grep
```

### Server 侧 / Server Side

- **Docker**（容器模式，推荐）
- 或本地直跑：已安装并认证的 `claude` CLI（`claude auth`）

---

## 快速开始 / Quick Start

### 1. 安装依赖 / Install

```bash
npm install
```

> `npm install` 自动安装所有 workspace（server / client / web）的依赖。

### 2. 启动 Server / Start the Server

#### Docker（推荐） / Docker (Recommended)

```bash
npm run server:up          # 启动容器
npm run server:logs        # 查看日志
npm run server:down        # 停止容器
```

容器使用 `cerelay-data` named volume 持久化登录凭证。首次启动凭证为空，连上 Client 后执行 `claude login` 即可。

> 容器化部署的完整指南（卷映射、镜像构建、SOCKS5 代理细节）见 [`docs/brain-docker.md`](./docs/brain-docker.md)。

#### 本地直跑 / Run Locally

```bash
cd server && npm start -- --port 8765 --model claude-sonnet-4-20250514
```

### 3. 安装 Client CLI / Install the Client CLI

#### 方式 A：单文件 Bundle（推荐）

通过 Docker 构建一个自包含的单文件，产物仅依赖 Node.js >= 18：

```bash
cd client && npm run bundle:docker
```

产物位于 `client/dist/cerelay-bundle.mjs`（约 1.2MB）。安装到系统：

```bash
mkdir -p ~/.local/bin
cp client/dist/cerelay-bundle.mjs ~/.local/bin/cerelay.mjs
printf '#!/bin/sh\nexec node "$HOME/.local/bin/cerelay.mjs" "$@"\n' > ~/.local/bin/cerelay
chmod +x ~/.local/bin/cerelay
```

> 也可本地 bundle（需先 `npm install`）：`cd client && npm run bundle`

#### 方式 B：源码安装

```bash
cd client && npm run install:global
```

会把 `cerelay` 命令安装到 `~/.local/bin`（包含 `dist/` + `node_modules/`）。卸载：`cd client && npm run uninstall:global`。

确保 `~/.local/bin` 在 `PATH` 里（如未配置，加到 `~/.zshrc` / `~/.bashrc`）：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### 4. 启动 Client / Start the Client

安装后可在任意目录直接启动，`--cwd` 默认当前目录：

```bash
cerelay --server localhost:8765
```

`--server` 支持多种格式：

```bash
cerelay --server localhost:8765            # ws://localhost:8765/ws
cerelay --server http://example.com        # ws://example.com/ws
cerelay --server https://example.com       # wss://example.com/ws
cerelay --server wss://example.com/prefix  # wss://example.com/prefix/ws
```

也可从源码启动：`cd client && npm start -- --server localhost:8765 --cwd /path/to/project`。

查看 Client 日志：

```bash
cerelay logs
```

### 5. 启动 Web UI（可选） / Start the Web UI

```bash
cd web && npm start -- --port 8766 --server localhost:8765
```

打开 http://localhost:8766。

---

## 鉴权 / Authentication

### `CERELAY_KEY`（Server ↔ Client 共享密钥）

Server 通过 `CERELAY_KEY` 设置共享密钥，Client 连接时需匹配：

```bash
# Server
CERELAY_KEY=my-secret npm run server:up

# Client
CERELAY_KEY=my-secret cerelay --server localhost:8765
# 或 / or
cerelay --server localhost:8765 --key my-secret
```

建议写入 `~/.zshrc` / `~/.bashrc`：

```bash
export CERELAY_KEY=my-secret
```

### Claude Code 登录态

容器内 Claude Code 的凭证由 `cerelay-data` volume 持久化。

- **推荐**：首次启动容器 → 连接 Client → 执行 `claude login`，凭证写入 volume，重启不需重登。
- **可选 seed**：通过 `CLAUDE_CREDENTIALS` 一次性注入凭证 JSON：
  ```bash
  CLAUDE_CREDENTIALS='{"claudeAiOauth":{...}}' npm run server:up
  ```

### 多账号 / Multi-account

透明 SOCKS5 代理是**容器级**而非 session 级，多账号应部署多个并列容器实例：

```bash
# 账号 A
COMPOSE_PROJECT_NAME=cerelay-a \
SERVER_HOST_PORT=8765 \
CERELAY_SOCKS_PROXY=socks5://userA:passA@proxy-a.example.com:1080 \
npm run server:up

# 账号 B
COMPOSE_PROJECT_NAME=cerelay-b \
SERVER_HOST_PORT=8766 \
CERELAY_SOCKS_PROXY=socks5://userB:passB@proxy-b.example.com:1080 \
npm run server:up
```

每个实例都有独立的：Claude 凭证、宿主机端口、容器网络出口、Docker 生命周期。

---

## 通过代理连接 / Connecting Through a Proxy

### Client 侧（连接 Server）

Client 支持 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`，兼容 Caddy Forward Proxy 等 CONNECT 代理：

```bash
# 通过 HTTP 代理连接 Server
HTTPS_PROXY=http://proxy.internal:8080 cerelay --server https://remote-server.example.com

# 跳过代理（直连）
NO_PROXY=localhost,127.0.0.1 cerelay --server localhost:8765
```

- `https://` 目标用 `HTTPS_PROXY`，`http://` 目标用 `HTTP_PROXY`
- `ALL_PROXY` 作为通用回退
- `NO_PROXY` 支持精确匹配、后缀匹配（`.example.com`）、端口匹配（`host:port`）和通配符（`*`）

### Server 侧（容器透明 SOCKS5）

```bash
CERELAY_SOCKS_PROXY=socks5://user:pass@proxy.example.com:1080 npm run server:up
# 紧凑格式
CERELAY_SOCKS_PROXY=proxy.example.com:1080:user:pass npm run server:up
```

容器内所有公网出站流量都经由 sing-box TUN 走 SOCKS5；代理异常或 sing-box 退出时容器会自动断开，由 Docker 重启策略接管。依赖 Linux 容器能力（`NET_ADMIN`、`/dev/net/tun`、`nftables`）。

> 完整代理参数（DNS、UDP 策略、TUN 段等）见 [`docs/brain-docker.md`](./docs/brain-docker.md) 与 [`docs/architecture.md` §8](./docs/architecture.md#8-系统级环境变量--system-level-environment-variables)。

---

## 用户环境变量 / User-facing Environment Variables

> 这里只列与"使用 cerelay"直接相关的变量。系统级 / 部署调试相关变量见 [`docs/architecture.md` §8](./docs/architecture.md#8-系统级环境变量--system-level-environment-variables)。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CERELAY_KEY` | — | Client 连接 Server 的共享密钥 |
| `SERVER_PORT` | `8765` | 容器内 Server 监听端口 |
| `SERVER_HOST_PORT` | `8765` | Docker 映射到宿主机的端口 |
| `MODEL` | `claude-sonnet-4-20250514` | 默认 Claude 模型 |
| `ANTHROPIC_API_KEY` | — | Claude API Key |
| `ANTHROPIC_AUTH_TOKEN` | — | 可选：替代 API key 的 auth token |
| `CLAUDE_CREDENTIALS` | — | 可选：seed 登录凭证 JSON（写入 Data volume） |
| `CERELAY_SOCKS_PROXY` | — | 容器级透明 SOCKS5 代理 |
| `HTTP_PROXY` | — | Client 连 `ws://` 目标用的代理 |
| `HTTPS_PROXY` | — | Client 连 `wss://` 目标用的代理 |
| `ALL_PROXY` | — | 代理通用回退 |
| `NO_PROXY` | — | 不走代理的地址列表（逗号分隔） |

---

## 编辑器集成 / Editor Integration

`cerelay` 也可以作为 ACP（Agent Communication Protocol）stdio server 启动，被 Zed / VS Code 等编辑器作为 Claude Code 调用：

```bash
cerelay acp --server localhost:8765 --cwd /your/project
```

完整的协议字段、初始化握手、编辑器配置示例见 [`docs/acp-editor-integration.md`](./docs/acp-editor-integration.md)。

---

## 文档地图 / Documentation Map

| 文档 | 受众 | 内容 |
|---|---|---|
| `README.md`（本文档） | **用户** | 怎么跑、怎么连、鉴权、代理、能力总览 |
| [`docs/architecture.md`](./docs/architecture.md) | 贡献者 / 开发者 | 架构总览、技术选型、核心机制、系统级 env vars |
| [`docs/brain-docker.md`](./docs/brain-docker.md) | 部署者 | Docker 部署指南、卷与镜像、SOCKS5 代理细节 |
| [`docs/acp-editor-integration.md`](./docs/acp-editor-integration.md) | 编辑器集成者 | ACP stdio 协议、Zed / VS Code 配置 |
| [`docs/plan-d-mcp-shadow-tools.md`](./docs/plan-d-mcp-shadow-tools.md) | 贡献者 | Shadow MCP 设计（绕开 hook deny 协议约束） |
| [`docs/plan-acp-relay.md`](./docs/plan-acp-relay.md) | 贡献者 | ACP relay 设计 |
| [`CLAUDE.md`](./CLAUDE.md) | AI 协作 | 项目级 AI 协作规范、强制约束 |

---

## 许可证 / License

本项目采用 [PolyForm Noncommercial License 1.0.0](./LICENSE)。

This project is licensed under the [PolyForm Noncommercial License 1.0.0](./LICENSE).

**Copyright (c) 2026 n374**

简要说明（**以 LICENSE 全文为准**）：

- ✅ **允许 / Permitted**：个人学习、研究、教育、慈善、政府等任何 **非商业用途** 下的使用、修改、再分发
- ❌ **禁止 / Prohibited**：任何形式的商业用途
- ✍️ **必须保留署名 / Attribution required**：分发本项目（含修改版本与衍生作品）时必须保留版权声明、本许可证全文以及 `Required Notice: Copyright (c) 2026 n374`

如需商业授权，请联系作者 / For commercial licensing, please contact the author.
