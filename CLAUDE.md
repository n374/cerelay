# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述 / Project Overview

**Cerelay** 是 Claude Code 的分体式架构实现。核心设计：用户在 Client 端交互，Hand 在本地执行工具，Server 端负责通过 Claude Agent SDK 驱动推理，并通过 WebSocket 将工具调用转发回 Client。

**Cerelay** is a split-architecture implementation of Claude Code. Core design: users interact on the Client side, Client executes tools locally, and the Server uses the Claude Agent SDK for reasoning while forwarding tool calls back to Client via WebSocket.

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
Client CLI ←→ WebSocket ←→ Server ←→ SDK query() ←→ Claude Code CLI
```

### 关键组件 / Key Components

| 组件 / Component | 位置 / Location | 职责 / Responsibility |
|---|---|---|
| **Hand** | `client/src/` | CLI 入口、本地工具执行 (Read/Write/Edit/Bash/Grep/Glob)、终端交互 |
| **Server** | `server/src/` | HTTP/WebSocket 服务、SDK 集成、Session 管理、MCP 代理、PTY 运行时 |
| **Web** | `web/src/` | 可选浏览器 UI |
| **Session Runtime** | `server/src/claude-session-runtime.ts` | 为每个 Session 创建隔离运行环境（mount namespace） |
| **Tool Relay** | `server/src/session.ts` | SDK Hook 拦截 + Client 执行的工具回传管理 |
| **MCP Proxy** | `server/src/mcp-proxy.ts` | 代理 MCP Server 调用 |

### 通信流 / Communication Flow

```
1. Client 发起 prompt → Server (WebSocket)
2. Server 调用 SDK query()
3. SDK 驱动 claude CLI 生成文本和工具调用
4. Server 通过 PreToolUse hook 拦截工具调用
5. Server 转发 tool_call → Client (WebSocket)
6. Client 本地执行工具
7. Client 返回 tool_result → Server (WebSocket)
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
npm run server:up          # 启动 Axon Server 容器
npm run server:logs        # 查看日志
npm run server:down        # 停止容器
```

环境配置文件：`.env.example` → `.env`（可选，使用默认值则不需要）

Key env vars:
- `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`：Claude 认证
- `SERVER_HOST_PORT`：宿主机端口（默认 8765）
- `LOG_LEVEL`：日志级别（debug/info/warn/error）
- `CERELAY_ENABLE_MOUNT_NAMESPACE`：是否启用隔离运行时（默认 true）

#### 方式 B：本地运行 / Local Run

需要本机已安装并认证 `claude` CLI：

```bash
cd server && npm start -- --port 8765 --model claude-sonnet-4-20250514
```

### 启动 Client / Start Client

在新终端中：

```bash
cd client && npm start -- --server localhost:8765 --cwd /path/to/project
```

### 启动 Web UI（可选） / Start Web UI (Optional)

```bash
cd web && npm start -- --port 8766 --server localhost:8765
```

然后打开 http://localhost:8766

## 常用命令 / Common Commands

### 构建 / Build

```bash
# 整个项目
npm run test:workspaces

# 单个工作空间
cd server && npm run build
cd client && npm run build
cd web && npm run build
```

### 类型检查 / Type Checking

```bash
npm run typecheck          # 所有工作空间
cd server && npm run typecheck
cd client && npm run typecheck
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
LOG_LEVEL=debug npm run server:up

# 查看实时日志
npm run server:logs

# 启用 JSON 日志
LOG_JSON=true npm run server:up
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
├── client/                            # 用户交互 CLI + 工具执行
│   ├── src/
│   │   ├── index.ts                # Client CLI 入口
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

- 默认启用（通过 `CERELAY_ENABLE_MOUNT_NAMESPACE=true`）
- 为每个 Session 创建隔离的文件系统视图
- Claude 看到的 `HOME` 和 `cwd` 对齐 Client 上报的路径
- 使用 `unshare` / `nsenter` 实现

**Filesystem access invariants**:

- CC 启动后的 `cwd` 字符串必须等于 Client 启动目录；从 CC 与 Client 两侧看，当前目录路径应一致。
- 用户文件访问必须走被 hook 拦截的工具调用（`Bash`、`Read`、`Write`、`Edit`、`MultiEdit`、`Grep`、`Glob`），并在 Client 本机执行；不要通过 FUSE 把项目目录或 Client 根目录映射给 CC。
- FUSE file proxy 只允许 Claude 配置范围：`~/.claude/`、`~/.claude.json`、`{cwd}/.claude/`。项目源码、cwd 上级目录、系统其他路径的访问能力来自 Client-routed tools。
- `settings.local.json` 必须继续作为项目级 hook 配置注入到 `{cwd}/.claude/settings.local.json`。
- Server 侧凭证必须作为 `home-claude/.credentials.json` shadow file 暴露给 runtime，且读写、truncate 都应作用在 Server 侧本地凭证文件。
- 凭证的真实存放位置为 `${CERELAY_DATA_DIR:-/var/lib/cerelay}/credentials/default/.credentials.json`（由 docker-compose 的 `cerelay-data` named volume 持久化）。首次启动文件不存在是允许的——CC `login` 会通过 FUSE create 创建该文件；shadow file 映射必须**总是注入**，不得因为文件不存在就跳过，否则写入会穿透到 Client 侧，违反隔离约束。
- Data 目录（`${CERELAY_DATA_DIR:-/var/lib/cerelay}`）还用于存放 Client 文件同步缓存（`client-cache/<deviceId>/<cwdHash>/`），禁止把业务数据写到容器根文件系统其他位置。

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

### 3. MCP Server 代理 / MCP Server Proxy

**文件**: `server/src/mcp-proxy.ts`, `server/src/claude-mcp-config.ts`

- Server 从 Claude 自己的配置读取 `mcpServers`
- 在 Server 侧代理 MCP 调用
- Client 不需要管理 MCP 连接

### 4. PTY/Shell 支持 / PTY/Shell Support

**文件**: `server/src/pty-session.ts`, `server/src/pty-host-script.ts`

- 为复杂 Shell 操作提供 PTY
- 支持交互式命令（如 `git`, `npm` 交互式提示）
- 通过 host script 与 Client 交互

### 5. Client 文件缓存 / Client File Cache

**文件**: `server/src/client-cache-store.ts`, `client/src/cache-sync.ts`, `client/src/device-id.ts`

- 目标：降低 Client 每次连接的启动开销，避免把 `~/.claude/` 整棵目录完整重传
- 存储：`${CERELAY_DATA_DIR}/client-cache/<deviceId>/<cwdHash>/`
  - `manifest.json`：按 scope（`claude-home` / `claude-json`）记录 `path → {size, mtime, sha256, skipped}`
  - `blobs/<sha256>`：实际内容，内容寻址、天然去重
- `deviceId`：Client 首次启动生成 UUIDv4，持久化到 `~/.config/cerelay/device-id`；Server 侧按 (deviceId, cwdHash) 隔离缓存，因此同一设备切换 cwd 不会互相污染
- 协议（见 `server/src/protocol.ts` 的 CacheTask* 类型）：
  1. Client → Server：`client_hello` 上报 `deviceId/cwd/capabilities`
  2. Server → Client：`cache_task_assignment` 指派 active/inactive 角色并携带 manifest 快照
  3. Active Client：发送 `cache_task_delta`，initial 完成后发 `cache_task_sync_complete`
  4. Server → Client：用 `cache_task_delta_ack` / `cache_task_mutation_hint` 协调 revision 与读穿透
- 大小限制：
  - 单文件 > 1MB（`MAX_FILE_BYTES`）：标记 `skipped`，仅同步元数据
  - 单 scope 累计 > 100MB（`MAX_SCOPE_BYTES`）：按 mtime 倒序截断，后面的文件完全丢弃，manifest 记录 `truncated: true` 用于诊断
- 失败策略：缓存同步失败不阻塞 PTY session 启动——降级为"无 Server 缓存"，FUSE 读请求仍可穿透回 Client
- Integration 测试通过 `CERELAY_DISABLE_INITIAL_CACHE_SYNC=true` 跳过该流程，避免 mock server 需要模拟该协议

**启动期同步进度 UI 与 pipeline / Initial cache sync progress & pipeline**（`client/src/cache-sync.ts` + `client/src/ui.ts` + `server/src/client-cache-store.ts`）：

- **Pipeline 发送**：每个有 content 的文件单独发一个 `cache_task_delta` change，发完不等 ack 立刻发下一个 batch；ack 通过 `batchId + appliedRevision` 异步匹配 in-flight 队列
- **流控水位**：`MAX_INFLIGHT_BYTES = 16 MB`。当 in-flight 字节累计超过该阈值时暂停 send，等任意 ack 释放配额后继续。本地/局域网下基本不触发，远程 RTT 200ms × 80MB/s ≈ 16MB 是流水线满载所需深度
- **协议批次标识**：`CacheTaskDelta.batchId` 必填；server 用 `cache_task_delta_ack` 回传 `appliedRevision`，pipeline 模式下靠 `batchId` 区分 in-flight 批次
- **Server 端 manifest 串行锁**（`client-cache-store.ts: withManifestLock`）：按 `(deviceId, cwd)` 维护 promise 链 mutex，串行化 `applyDelta` / `upsertEntry` / `removeEntry` 的 read-modify-write。**这是 pipeline 的硬性前提**：server 的 message handler 是并发的（`server.ts` 用 `void this.handleMessage()`），无锁状态下 manifest 写入会丢更新
- **元数据批**（deletes + skipped）：每 scope 第一发，等 ack 后再开始 pipeline。这部分占用 in-flight 但 size 记 0，不消耗流控配额
- **进度展示**（双行）：
  - line1 = 跨 scope 合并总进度（spinner + 进度条 + 百分比 + 已 ack 文件/字节），按 ack 字节**精确计算**
  - line2 = `→ 当前 ack 等待: <最早未 ack 的文件>  (in-flight K 文件 / X MB)`，无文件级进度条
- **没有单文件进度条**：pipeline 后多个文件的字节同时滞留 OS 发送缓冲，`ws.bufferedAmount` 反映的是 in-flight 集合的总残留，无法分离到单个文件，所以放弃单文件进度（之前的 `bufferedBaseline` 字段也已删除）
- 事件序列（`CacheSyncEvent`）：`skipped` | `scan_start` → `scan_done` → `upload_start` → 多对 `file_pushed` / `file_acked`（可乱序交叠）→ `upload_done`
- 渲染节拍固定 100ms（10Hz）；事件只更新内部状态，不直接写 stdout
- 仅 TTY 场景启用（`process.stdout.isTTY === true`）；非 TTY / CI 走纯 log，不输出 ANSI 控制序列

**FUSE 读路径与 cache 协同**（`server/src/file-proxy-manager.ts`）：

- `create_pty_session` 会把 Client 的 `deviceId` 带给 Server；`FileProxyManager` 收到 `cacheStore + deviceId` 后启用 cache 读优先
- 启动时 `collectAndWriteSnapshot` 对 `home-claude` / `home-claude-json` **优先从 cache 构造 snapshot**（`buildSnapshotFromManifest`），不再向 Client 发全量 snapshot 请求；`project-claude` 因为不在 cache 覆盖范围仍然穿透 Client
- 运行时 `handleFuseLine` 的 `read` op 会先调用 `tryServeReadFromCache`：命中 blob 直接写回 FUSE daemon；miss 或 skipped 文件 fallback 到原穿透路径
- cache 未启用（Client 未上报 deviceId / 未提供 cacheStore）时退化为纯穿透模式，行为与未接入 cache 时完全一致
- cache 新鲜度：短期内依赖"下次启动时的增量握手 push"来修正；未来若需要 session 运行期内双向同步（watcher + `cache_delta`）再扩展

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

### Client

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

1. **在 Client 中实现工具** (`client/src/tools/`)
   - 遵循现有工具的接口（返回 `ToolResult`）
   - 例如：`fs.ts` (Read/Write/Edit), `bash.ts` (Bash), `search.ts` (Grep/Glob)

2. **在 Executor 中注册** (`client/src/executor.ts`)
   - 在 `executeToolCall()` 中添加路由

3. **测试** (`client/test/`)
   - 为新工具编写单元测试

### 修改会话流 / Modifying Session Flow

**关键文件**: `server/src/session.ts`

- `createQuery()`: 构建 SDK query 请求
- `handleToolCall()`: 拦截 SDK 工具调用，转发到 Client
- `waitForToolResult()`: 等待 Client 执行结果

### 调试 WebSocket 通信 / Debugging WebSocket Communication

启用 debug 日志：

```bash
LOG_LEVEL=debug npm run server:up
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

- 启动真实 Server 和 Client
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

### Client 无法连接 Server / Client Cannot Connect to Server

检查：
1. Server 是否正在运行：`npm run server:logs`
2. 端口是否正确（默认 8765）
3. WebSocket 地址格式：`--server localhost:8765`

### Mount Namespace 相关错误 / Mount Namespace Errors

如果遇到 `unshare` 相关错误，可禁用隔离运行时：

```bash
CERELAY_ENABLE_MOUNT_NAMESPACE=false npm run server:up
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
2. **WebSocket 协议**: Client 和 Server 通过 `protocol.ts` 中定义的消息格式通信，修改时需同步两端
3. **工具执行**: Client 拥有完整的工具执行权，Server 不执行工具，只转发调用
4. **环境变量**: 区分宿主机环境变量和容器内环境变量，特别是路径相关的配置
