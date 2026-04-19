# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述 / Project Overview

**Axon** 是 Claude Code 的分体式架构实现。核心设计：用户在 Hand 端交互，Hand 在本地执行工具，Server 端负责通过 Claude Agent SDK 驱动推理，并通过 WebSocket 将工具调用转发回 Hand。

**Axon** is a split-architecture implementation of Claude Code. Core design: users interact on the Hand side, Hand executes tools locally, and the Server uses the Claude Agent SDK for reasoning while forwarding tool calls back to Hand via WebSocket.

## 架构 / Architecture

### 三层分离 / Three-Tier Separation

```
Hand (TypeScript CLI)     Server (TypeScript + SDK)    Claude Code CLI
  ├─ Executor             ├─ Session Manager            ├─ Reasoning
  ├─ Tools                ├─ WebSocket Router           ├─ Tool Interception
  └─ Terminal UI          ├─ MCP Proxy                  └─ Output Stream
                          └─ Mount Namespace Runtime
```

**核心路径 / Primary Path**:
```
Hand CLI ←→ WebSocket ←→ Server ←→ SDK query() ←→ Claude Code CLI
```

### 关键组件 / Key Components

| 组件 / Component | 位置 / Location | 职责 / Responsibility |
|---|---|---|
| **Hand** | `hand/src/` | CLI 入口、本地工具执行 (Read/Write/Edit/Bash/Grep/Glob)、终端交互 |
| **Server** | `server/src/` | HTTP/WebSocket 服务、SDK 集成、Session 管理、MCP 代理、PTY 运行时 |
| **Web** | `web/src/` | 可选浏览器 UI |
| **Session Runtime** | `server/src/claude-session-runtime.ts` | 为每个 Session 创建隔离运行环境（mount namespace） |
| **Tool Relay** | `server/src/session.ts` | SDK Hook 拦截 + Hand 执行的工具回传管理 |
| **MCP Proxy** | `server/src/mcp-proxy.ts` | 代理 MCP Server 调用 |

### 通信流 / Communication Flow

```
1. Hand 发起 prompt → Server (WebSocket)
2. Server 调用 SDK query()
3. SDK 驱动 claude CLI 生成文本和工具调用
4. Server 通过 PreToolUse hook 拦截工具调用
5. Server 转发 tool_call → Hand (WebSocket)
6. Hand 本地执行工具
7. Hand 返回 tool_result → Server (WebSocket)
8. Server 通过 hook result 反馈给 SDK
9. 循环直到 Session 结束
```

## 快速开始 / Quick Start

### 安装 / Installation

```bash
npm install
```

### 启动服务 / Starting Services

#### 方式 A：Docker（推荐） / Docker (Recommended)

```bash
npm run brain:up          # 启动 Axon Server 容器
npm run brain:logs        # 查看日志
npm run brain:down        # 停止容器
```

环境配置文件：`.env.example` → `.env`（可选，使用默认值则不需要）

Key env vars:
- `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`：Claude 认证
- `BRAIN_HOST_PORT`：宿主机端口（默认 8765）
- `LOG_LEVEL`：日志级别（debug/info/warn/error）
- `AXON_ENABLE_MOUNT_NAMESPACE`：是否启用隔离运行时（默认 true）

#### 方式 B：本地运行 / Local Run

需要本机已安装并认证 `claude` CLI：

```bash
cd server && npm start -- --port 8765 --model claude-sonnet-4-20250514
```

### 启动 Hand / Start Hand

在新终端中：

```bash
cd hand && npm start -- --server localhost:8765 --cwd /path/to/project
```

### 启动 Web UI（可选） / Start Web UI (Optional)

```bash
cd web && npm start -- --port 8766 --brain localhost:8765
```

然后打开 http://localhost:8766

## 常用命令 / Common Commands

### 构建 / Build

```bash
# 整个项目
npm run test:workspaces

# 单个工作空间
cd server && npm run build
cd hand && npm run build
cd web && npm run build
```

### 类型检查 / Type Checking

```bash
npm run typecheck          # 所有工作空间
cd server && npm run typecheck
cd hand && npm run typecheck
cd web && npm run typecheck
```

### 测试 / Testing

```bash
# 运行所有测试（包括烟测和工作空间测试）
npm test

# 运行烟测
npm run test:smoke

# 运行工作空间测试
npm run test:workspaces

# 单个工作空间的单个测试文件
cd server && npm test -- test/session.test.ts

# Node.js 原生测试运行器的其他选项
cd server && node --import tsx --test --test-concurrency=1 test/**/*.test.ts
```

**注意 / Note**: 测试使用 `--test-concurrency=1` 防止并发干扰。

### 调试 / Debugging

```bash
# 启用 debug 日志
LOG_LEVEL=debug npm run brain:up

# 查看实时日志
npm run brain:logs

# 启用 JSON 日志
LOG_JSON=true npm run brain:up
```

## 项目结构 / Project Structure

```
axon/
├── server/                          # Brain Server（Claude Agent SDK）
│   ├── src/
│   │   ├── index.ts                # CLI 入口，解析 --port / --model
│   │   ├── server.ts               # HTTP + WebSocket 服务
│   │   ├── session.ts              # query() 会话驱动 + 工具 relay
│   │   ├── claude-session-runtime.ts # 隔离运行时（mount namespace）
│   │   ├── claude-hook-injection.ts  # SDK Hook 注入
│   │   ├── pty-session.ts          # PTY/Shell 会话管理
│   │   ├── mcp-proxy.ts            # MCP Server 代理
│   │   ├── protocol.ts             # 消息类型定义
│   │   ├── logger.ts               # 日志工具
│   │   └── ...
│   ├── test/                        # 集成和 e2e 测试
│   ├── tsconfig.json
│   └── package.json
├── hand/                            # 用户交互 CLI + 工具执行
│   ├── src/
│   │   ├── index.ts                # Hand CLI 入口
│   │   ├── client.ts               # WebSocket 客户端
│   │   ├── executor.ts             # 工具分发器
│   │   ├── protocol.ts             # 消息类型定义
│   │   ├── logger.ts               # 日志工具
│   │   ├── tools/
│   │   │   ├── fs.ts               # Read / Write / Edit / MultiEdit
│   │   │   ├── bash.ts             # Bash 执行
│   │   │   └── search.ts           # Grep / Glob
│   │   ├── ui.ts                   # 终端 UI 渲染
│   │   └── ...
│   ├── test/                        # 单元和集成测试
│   ├── tsconfig.json
│   └── package.json
├── web/                             # 浏览器 UI（可选）
│   ├── src/
│   ├── test/
│   └── package.json
├── docker-compose.yml               # Brain 容器编排
├── Dockerfile                       # Brain 镜像构建
├── docker-entrypoint.sh            # Brain 启动脚本
├── README.md                        # 项目文档
└── package.json                     # npm workspaces 根配置
```

## 核心技术决策 / Key Technology Choices

| 决策点 / Decision | 选择 / Choice | 理由 / Reason |
|---|---|---|
| Server 框架 | TypeScript + Node.js | 直接集成 Claude Agent SDK |
| 通信协议 | WebSocket | 双向流式传输 |
| Tool Interception | SDK `PreToolUse` Hook | 官方 SDK 标准机制 |
| Runtime Isolation | Mount Namespace | Docker 内的隔离进程命名空间 |
| Session Management | Per-session Runtime | 每个 Session 独立 Claude 运行环境 |
| CLI Framework | Commander.js (Hand) | 轻量级命令行解析 |

## 架构特点 / Architecture Highlights

### 1. Mount Namespace 隔离 / Mount Namespace Isolation

**文件**: `server/src/claude-session-runtime.ts`, `server/src/pty-session.ts`

- 默认启用（通过 `AXON_ENABLE_MOUNT_NAMESPACE=true`）
- 为每个 Session 创建隔离的文件系统视图
- Claude 看到的 `HOME` 和 `cwd` 对齐 Hand 上报的路径
- 使用 `unshare` / `nsenter` 实现

```typescript
// 关键调用位置：session.ts 中的 createSessionRuntime()
const runtime = new ClaudeSessionRuntime({
  cwd: request.cwd,
  home: request.home,
});
```

### 2. SDK Hook 拦截 / SDK Hook Interception

**文件**: `server/src/claude-hook-injection.ts`, `server/src/session.ts`

- 通过 SDK `PreToolUse` callback 拦截工具调用
- 将调用转发到 Hand 执行
- 等待 Hand 返回结果后再反馈给 SDK

```typescript
// sdk.query() 中的 hooks 参数
hooks: {
  onPreToolUse: async (toolCall) => {
    // 将 tool_call 转发到 Hand
    // 等待 Hand tool_result
    // 返回 SDK 期望的格式
  }
}
```

### 3. MCP Server 代理 / MCP Server Proxy

**文件**: `server/src/mcp-proxy.ts`, `server/src/claude-mcp-config.ts`

- Server 从 Claude 自己的配置读取 `mcpServers`
- 在 Server 侧代理 MCP 调用
- Hand 不需要管理 MCP 连接

### 4. PTY/Shell 支持 / PTY/Shell Support

**文件**: `server/src/pty-session.ts`, `server/src/pty-host-script.ts`

- 为复杂 Shell 操作提供 PTY
- 支持交互式命令（如 `git`, `npm` 交互式提示）
- 通过 host script 与 Hand 交互

## 依赖关系 / Dependencies

### Server

```json
{
  "@anthropic-ai/claude-agent-sdk": "latest",
  "@modelcontextprotocol/sdk": "^1.29.0",
  "ws": "^8.0.0"
}
```

- **claude-agent-sdk**: 核心依赖，驱动 Claude Code
- **mcp sdk**: 支持 MCP Server 集成
- **ws**: WebSocket 库

### Hand

```json
{
  "@modelcontextprotocol/sdk": "^1.29.0",
  "commander": "^12.0.0",
  "ws": "^8.0.0"
}
```

- **commander**: 命令行参数解析
- 其他同 Server

## 常见开发场景 / Common Development Scenarios

### 添加新工具 / Adding a New Tool

1. **在 Hand 中实现工具** (`hand/src/tools/`)
   - 遵循现有工具的接口（返回 `ToolResult`）
   - 例如：`fs.ts` (Read/Write/Edit), `bash.ts` (Bash), `search.ts` (Grep/Glob)

2. **在 Executor 中注册** (`hand/src/executor.ts`)
   - 在 `executeToolCall()` 中添加路由

3. **测试** (`hand/test/`)
   - 为新工具编写单元测试

### 修改会话流 / Modifying Session Flow

**关键文件**: `server/src/session.ts`

- `createQuery()`: 构建 SDK query 请求
- `handleToolCall()`: 拦截 SDK 工具调用，转发到 Hand
- `waitForToolResult()`: 等待 Hand 执行结果

### 调试 WebSocket 通信 / Debugging WebSocket Communication

启用 debug 日志：

```bash
LOG_LEVEL=debug npm run brain:up
```

日志会显示：
- WebSocket 连接/断开
- 收发消息详情
- 工具调用和结果的详细流程

## 测试策略 / Testing Strategy

### 单元测试 / Unit Tests

- 位置：`**/test/*.test.ts`
- 运行：`npm test` 或 `npm run test:workspaces`
- 使用 Node.js 原生 `node --test` 运行器

### E2E 集成测试 / E2E Integration Tests

**文件**: `server/test/e2e-hand.test.ts`, `server/test/e2e-hand-mock-api.test.ts`

- 启动真实 Server 和 Hand
- 通过 WebSocket 交互
- 验证完整的工具执行流程

### 烟测 / Smoke Tests

```bash
npm run test:smoke
```

验证基础功能（build、typecheck）。

## 常见问题排查 / Troubleshooting

### Server 无法连接 Claude / Server Cannot Connect to Claude

检查：
1. `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN` 是否设置
2. `claude` CLI 是否已认证：`claude auth`
3. Docker 容器是否正确挂载了 `~/.claude` 目录

### Hand 无法连接 Server / Hand Cannot Connect to Server

检查：
1. Server 是否正在运行：`npm run brain:logs`
2. 端口是否正确（默认 8765）
3. WebSocket 地址格式：`--server localhost:8765`

### Mount Namespace 相关错误 / Mount Namespace Errors

如果遇到 `unshare` 相关错误，可禁用隔离运行时：

```bash
AXON_ENABLE_MOUNT_NAMESPACE=false npm run brain:up
```

或在容器的 Docker Compose 配置中移除 `cap_add: [SYS_ADMIN]`。

## 代码风格 / Code Style

- **语言**: TypeScript
- **模块**: ESM (type: "module" in package.json)
- **工具**: `tsx` 用于开发，`tsc` 用于编译
- **测试**: Node.js 原生测试
- **日志**: 结构化日志（支持 JSON Lines 格式）

## 性能考虑 / Performance Considerations

1. **Session 隔离** / Session Isolation: 每个 Session 有独立的 Claude 运行时，避免状态污染
2. **流式传输** / Streaming: WebSocket 流式传输文本和工具调用结果，避免大批量缓冲
3. **并发控制** / Concurrency: 测试使用 `--test-concurrency=1` 防止资源竞争

## 相关文档 / Related Documentation

- `README.md`: 项目总体介绍和快速开始
- `.claude/ROADMAP.md`: 功能路线图
- `docker-compose.yml`: 容器配置详解
- `Dockerfile`: 镜像构建步骤

## 重点提示 / Key Reminders

1. **修改 SDK 集成**: 任何涉及 `query()` 或 Hook 的修改都应该先在 `server/test/` 中验证
2. **WebSocket 协议**: Hand 和 Server 通过 `protocol.ts` 中定义的消息格式通信，修改时需同步两端
3. **工具执行**: Hand 拥有完整的工具执行权，Server 不执行工具，只转发调用
4. **环境变量**: 区分宿主机环境变量和容器内环境变量，特别是路径相关的配置
