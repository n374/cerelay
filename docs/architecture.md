# Cerelay 技术架构 / Technical Architecture

> 本文档面向**贡献者 / 开发者**，自上而下介绍 Cerelay 的整体架构、技术选型与核心机制。用户视角的"我怎么跑起来"放在 [`README.md`](../README.md)，编辑器集成、容器部署等专题放在本目录下的子文档。
>
> Audience: contributors / developers. End-user "how do I run it" lives in [`README.md`](../README.md); per-feature deep-dives live alongside this file in `docs/`.

---

## 1. 概述 / Overview

**Cerelay**（cerebral + relay）把 Claude Code 拆成两端：

- **Server**：托管 Claude Code PTY 会话，通过 SDK / `claude` CLI 驱动推理；通过 `PreToolUse` hook 拦截工具调用、转发到 Client；为每个 session 提供独立的 mount namespace 与 FUSE 配置视图。
- **Client**：用户本机运行的 CLI / 编辑器集成；负责本地工具执行（`Read` / `Write` / `Edit` / `Bash` / `Grep` / `Glob` 等）、MCP server 代理、通过 WebSocket 把工具结果回传给 Server。
- **Web**（可选）：浏览器 UI，复用同一 WebSocket 协议。

工具调用必须在 Client 侧执行——Server 不持有用户文件系统、不直接读写用户磁盘。Server 的容器与 Client 的工作目录通过 hook + FUSE 协同得到一个**对齐的 cwd 视图**。

```text
┌──────────────────────────────────┐         ┌─────────────────────────────────────────┐
│ Client (TypeScript, 用户本机)     │         │ Server (TypeScript, 容器化)              │
│  ├─ CLI 入口 / ACP 编辑器集成      │  ws://  │  ├─ HTTP + WebSocket 服务               │
│  ├─ 工具执行（Read/Write/Bash...） │ ───────►│  ├─ Claude Code PTY 会话托管            │
│  ├─ MCP Runtime                  │ ◄─────── │  ├─ PreToolUse hook 桥接 (tool relay)   │
│  └─ 文件代理客户端 (FUSE 写穿透)   │         │  ├─ Mount namespace + FUSE 配置投影      │
└──────────────────────────────────┘         │  └─ Shadow MCP / 容器级 SOCKS5 代理     │
                                             └─────────────────────────────────────────┘
                                                              │
                                                              ▼
                                                  ┌─────────────────────┐
                                                  │   claude CLI (PTY)  │
                                                  └─────────────────────┘
```

---

## 2. 架构图 / Architecture Diagrams

### 2.1 三层分离

```text
Client (TypeScript CLI)     Server (TypeScript + SDK)    Claude Code CLI
  ├─ Executor               ├─ Session Manager           ├─ Reasoning
  ├─ Tools                  ├─ WebSocket Router          ├─ Tool Interception
  └─ Terminal UI            ├─ MCP Proxy                 └─ Output Stream
                            └─ Mount Namespace Runtime
```

### 2.2 通信时序

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server
    participant PTY as Claude Code PTY

    C->>S: WebSocket create_pty_session / prompt
    S->>PTY: spawn claude CLI in PTY
    PTY-->>S: pty_output / text stream
    S-->>C: pty_output / text_chunk
    PTY->>S: PreToolUse hook (tool_call)
    S-->>C: tool_call (Read/Write/Bash/...)
    C->>C: 本地执行工具
    C-->>S: tool_result
    S-->>PTY: hook result / pty_input
    PTY-->>S: pty_exit / session_end
    S-->>C: pty_exit / session_end
```

### 2.3 主路径

```
Client CLI ←→ WebSocket ←→ Server ←→ SDK query() ←→ Claude Code CLI
```

---

## 3. 关键组件 / Key Components

| 组件 / Component | 位置 / Location | 职责 / Responsibility |
|---|---|---|
| **Client** | `client/src/` | CLI 入口、本地工具执行、MCP runtime、文件代理客户端、终端交互 |
| **Server** | `server/src/` | HTTP / WebSocket 服务、SDK 集成、Session 管理、MCP 代理、PTY 运行时 |
| **Web** | `web/src/` | 可选浏览器 UI（复用 WebSocket 协议） |
| **Session Runtime** | `server/src/claude-session-runtime.ts` | 为每个 session 创建隔离的 mount namespace |
| **Tool Relay** | `server/src/session.ts` | SDK Hook 拦截 + Client 执行的工具回传管理 |
| **MCP Proxy** | `server/src/mcp-proxy.ts` | 代理 MCP Server 调用 |
| **MCP Shadow Tools** | `server/src/mcp-routed/`, `server/src/mcp-ipc-host.ts` | Plan D：用 MCP 工具替代被 disallow 的内置工具，绕开 hook deny 协议硬约束 |
| **FileAgent**（per-device 单例） | `server/src/file-agent/index.ts`（+ `store.ts` / `scope-adapter.ts` / `ttl-table.ts` / `inflight.ts` / `sync-coordinator.ts` / `client-protocol-v1.ts` / `prefetch.ts` / `gc.ts`） | Device 级单机文件代理底座；对外暴露 `read / stat / readdir / prefetch + ttlMs`，内部封装 manifest / blob / ledger / sync / TTL；双路写入（read miss 阻塞穿透 + watcher delta 推送）|
| **ConfigPreloader** | `server/src/config-preloader.ts` | 启动期同步阻塞预热 home + cwd 父链 CLAUDE.md；调一次 `fileAgent.prefetch`；同时提供 `getNamespaceMountPlan()` 给 session-runtime |
| **File Proxy** | `server/src/file-proxy-manager.ts`, `client/src/file-proxy.ts` | FUSE 配置投影；运行期 Client 穿透读 + cache 命中优先；与 FileAgent 共享 ClientCacheStore |

---

## 4. 通信流 / Communication Flow

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

**核心不变量 / Core invariants**：

- **PTY Hook 拦截**：Server 通过 Claude Code 的 `PreToolUse` hook 接管工具调用，转发到 Client 执行
- **cwd 对齐**：CC 启动后的 `cwd` 字符串必须等于 Client 启动目录；从 CC 与 Client 两侧看，当前目录路径应一致
- **Client 文件访问**：用户文件访问必须走被 hook 拦截的工具调用（`Bash`、`Read`、`Write`、`Edit`、`MultiEdit`、`Grep`、`Glob`），并在 Client 本机执行；不要通过 FUSE 把项目目录或 Client 根目录映射给 CC
- **FUSE 范围**：FUSE file proxy 只允许 Claude 配置范围（`~/.claude/`、`~/.claude.json`、`{cwd}/.claude/`）；项目源码、cwd 上级目录、系统其他路径的访问能力来自 Client-routed tools
- **凭证 shadow**：Server 侧凭证作为 `home-claude/.credentials.json` shadow file 暴露给 runtime，读写、truncate 都作用在 Server 侧本地凭证文件

---

## 5. 技术选型 / Technology Choices

| 决策点 | 选择 | 理由 |
|---|---|---|
| Server 框架 | TypeScript + Node.js | 直接集成 Claude Agent SDK |
| 通信协议 | WebSocket | 双向流式传输，长连接低延迟 |
| Tool Interception | SDK `PreToolUse` Hook | 官方 SDK 标准机制 |
| Runtime Isolation | Mount Namespace（`unshare` / `nsenter`） | Docker 内的隔离进程命名空间，无需启动新容器 |
| Session Management | Per-session Runtime | 每个 Session 独立 Claude 运行环境，避免状态污染 |
| Client CLI Framework | Commander.js | 轻量级命令行解析 |
| 包管理 | npm workspaces | 单仓库多 workspace（server / client / web） |
| 测试运行器 | Node.js 原生 `node --test` | 零额外依赖、ESM 友好 |
| FUSE | 自实现 file proxy daemon | 精确控制可见路径范围（不依赖系统 fuse mount） |
| 缓存 | 内容寻址 blob + manifest | 天然去重；按 deviceId 分桶（device-only，跨 cwd 共享） |

---

## 6. 核心机制 / Core Mechanisms

### 6.1 Mount Namespace 隔离

**文件**：`server/src/claude-session-runtime.ts`、`server/src/pty-session.ts`

- 默认启用（`CERELAY_ENABLE_MOUNT_NAMESPACE=true`）
- 为每个 Session 创建隔离的文件系统视图
- Claude 看到的 `HOME` 和 `cwd` 对齐 Client 上报的路径
- 使用 `unshare` / `nsenter` 实现

### 6.2 SDK Hook 拦截

**文件**：`server/src/claude-hook-injection.ts`、`server/src/session.ts`

- 通过 SDK `PreToolUse` callback 拦截工具调用
- 将调用转发到 Client 执行
- 等待 Client 返回结果后再反馈给 SDK

### 6.3 Shadow MCP Tools (Plan D)

**文件**：`server/src/mcp-routed/`、`server/src/mcp-ipc-host.ts`、`server/src/mcp-cc-injection.ts`

**目标**：绕开 PreToolUse hook 的协议硬约束（deny 分支必然 `tool_result.is_error: true`），让模型看到的工具结果 `is_error` 由 cerelay 显式控制。

**架构**：CC PTY → cerelay-routed 子进程（per-session）→ unix socket → MCPIpcHost（主进程）→ ToolRelay → WebSocket → Client。

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

完整设计与双路径 e2e 不变量见 [`plan-d-mcp-shadow-tools.md`](./plan-d-mcp-shadow-tools.md)。

### 6.4 PTY / Shell 支持

**文件**：`server/src/pty-session.ts`、`server/src/pty-host-script.ts`

- 为复杂 Shell 操作提供 PTY
- 支持交互式命令（如 `git`、`npm` 交互式提示）
- 通过 host script 与 Client 交互

### 6.5 FileAgent 底座 + ConfigPreloader / File Cache (FileAgent + ConfigPreloader)

> **架构（2026-05-02 起 device-only）**：缓存维度从 `(deviceId, cwd)` 收敛到 `deviceId`。详见 plan `docs/superpowers/plans/2026-05-02-file-agent-and-config-preloader.md`。

```
                  ┌──────────────────────┐
                  │   ConfigPreloader     │  启动期同步阻塞预热
                  └──────────┬───────────┘
                             │ fileAgent.prefetch(items, ttlMs)
                             ▼
   ┌──────────────────────────────────────────────────────────┐
   │   FileAgent（per-device 单例，plan §2 P6）                │
   │   ─────────────────────────────────────────────────       │
   │   对外: read / stat / readdir / prefetch + ttlMs          │
   │   内部: store + scope-adapter + ttl-table + inflight +    │
   │         sync-coordinator + client-protocol-v1 + prefetch  │
   │         + gc                                               │
   │   双路写入 manifest（plan §3.6）：                         │
   │     A. read miss → 阻塞穿透 client                         │
   │     B. watcher delta → 主动 apply（运行时增量）            │
   └──────────────────────────────────────────────────────────┘
                             │ WebSocket（cache_task_*）
                             ▼
                       ┌────────────┐
                       │  Client    │ 真实文件系统 + watcher
                       └────────────┘
```

**核心模块**：

| 模块 | 职责 |
|---|---|
| `file-agent/store.ts` | manifest（v3 schema，per-device）+ blob 池（device 全局，跨 cwd dedup）+ withManifestLock + gcOrphanBlobs |
| `file-agent/scope-adapter.ts` | absPath ↔ scope+rel 双向转换（保 P8：协议字段不新增） |
| `file-agent/ttl-table.ts` | 跟踪 `expiresAt = max(existing, now + ttlMs)`；ttlMs 必须有限正数 |
| `file-agent/inflight.ts` | 同 path 多并发 op miss 时通过 InflightMap 共享单次穿透（plan §3.4）|
| `file-agent/sync-coordinator.ts` | 双路写入中枢：fetchFile/fetchStat/fetchReaddir + applyWatcherDelta |
| `file-agent/client-protocol-v1.ts` | 协议消息构造（buildSinglePathFetchPlan 等）；与业务逻辑分离便于未来抽协议层（plan §2 P7）|
| `file-agent/prefetch.ts` | 批量预热：bounded concurrency 16 + dir-recursive maxDepth 8 + 失败收集 |
| `file-agent/gc.ts` | 周期 60s 清过期 entry + orphan blob；in-flight 跳过给缓刑 |

**ConfigPreloader**（`server/src/config-preloader.ts`）：

- 同步阻塞 session 启动（异步预热毫无意义；超时仅异常 fallback）
- 一次 `fileAgent.prefetch` 拉所有 PrefetchItem：
  - `homeDir/.claude` (dir-recursive)
  - `homeDir/.claude.json` (file)
  - ancestor chain × {CLAUDE.md, CLAUDE.local.md} (file)
- 同时提供 `getNamespaceMountPlan()` 给 `claude-session-runtime`，决定 bootstrap mount 哪些 ancestor

**关键不变量**：

- 缓存维度 = deviceId（不再含 cwd）；同 device 多 cwd 共享 manifest
- 跨 cwd blob 内容寻址 dedup（同 sha256 只存一份）
- TTL 必须有限正数；推荐 startupTtl=7d / runtimeTtl=10min
- 协议字段不新增（保现有 `cache_task_*` v1 协议；scope 适配在 FileAgent 内部）
- 双路写入 manifest（read miss 拉取 + watcher delta 推送）→ 最终一致性窗口 < 1s
- `file-proxy-manager` 与 FileAgent 共享同一 `ClientCacheStore`，命中事实上等价

**FUSE 读路径与 cache 协同**（`server/src/file-proxy-manager.ts`）：

- `create_pty_session` 把 Client 的 `deviceId` 带给 Server；server 通过 `getOrCreateFileAgent(deviceId, homeDir)` 拿 per-device 单例传给 FileProxyManager
- 启动期 ConfigPreloader 调 prefetch（同步阻塞），完成后 FUSE daemon 启动
- 启动 snapshot：`home-claude` / `home-claude-json` **优先从 cache 构造**，不再向 Client 发全量 snapshot 请求
- 运行时 read：先调 `tryServeReadFromCache` 命中 blob 直接写回 FUSE daemon；miss 或 skipped 文件 fallback 到原穿透路径

### 6.6 启动期进度 UI（Phase 抽象）

**文件**：`client/src/ui.ts`（`CacheSyncProgressView` + `Phase` 抽象）、`client/src/client.ts`（`beginStartupSpinner` / `endStartupSpinner` / `printAboveSyncProgress`）

启动期至少有 3 个进度场景（cache sync 扫描 / cache sync 上传 / PTY 启动），统一走 Phase 抽象。**这是项目级强制约束**，详见 [CLAUDE.md §架构特点 6](../CLAUDE.md#6-启动期进度-ui--startup-progress-ui)：

- 任何启动期 / 多阶段进度 UI 必须经由 Phase 子类渲染，禁止再写独立 setInterval + `\r\x1b[K` 单行覆写 spinner
- 通用不变量（100% 帧 / trailing `\n` / printPersistent / 单 phase 互斥 / TTY 隔离 / `isIdle` 守门）由 view 层一次性实现
- 同一时刻最多一个 phase 在写 stdout；并发 phase 走 `pendingPhase` 队列

### 6.7 容器级 SOCKS5 代理

**模式**：sing-box TUN + `nftables`，fail-closed。

- 启用：`CERELAY_SOCKS_PROXY=socks5://user:pass@host:port` 或紧凑格式 `host:port[:user:pass]`
- DNS：默认 TCP 上游解析（不依赖代理 UDP）；`CERELAY_SOCKS_UDP=block` 可严格 fail-closed
- 多账号：透明代理是**容器级**而非 session 级，多账号应部署多个并列容器（独立 `COMPOSE_PROJECT_NAME` + 独立 `cerelay-data` volume）
- 依赖 Linux 容器能力：`NET_ADMIN`、`/dev/net/tun`、`nftables`

容器化部署完整指南见 [`brain-docker.md`](./brain-docker.md)。

### 6.8 ACP 编辑器集成

**入口**：`cerelay acp --server <host:port> --cwd <project>`，stdio JSON-RPC 2.0 与编辑器通信。

完整协议定义、消息字段、Zed / VS Code 集成见 [`acp-editor-integration.md`](./acp-editor-integration.md)。

---

## 7. 项目结构 / Project Structure

```text
cerelay/
├── server/                          # Server（Claude Agent SDK 托管）
│   ├── src/
│   │   ├── index.ts                 # CLI 入口
│   │   ├── server.ts                # HTTP + WebSocket 服务
│   │   ├── session.ts               # query() 会话驱动 + 工具 relay
│   │   ├── claude-session-runtime.ts# 隔离运行时（mount namespace）
│   │   ├── claude-hook-injection.ts # SDK Hook 注入
│   │   ├── pty-session.ts           # PTY/Shell 会话管理
│   │   ├── mcp-proxy.ts             # MCP Server 代理
│   │   ├── mcp-routed/              # Plan D: shadow MCP server
│   │   ├── mcp-ipc-host.ts          # Plan D: per-session unix socket host
│   │   ├── mcp-cc-injection.ts      # Plan D: CC CLI flag 注入
│   │   ├── file-agent/              # FileAgent 底座（per-device 单例）：
│   │   │   ├── index.ts             #   主类（read/stat/readdir/prefetch + ttl）
│   │   │   ├── store.ts             #   manifest v3 + blob 池（device-only）
│   │   │   ├── scope-adapter.ts     #   absPath ↔ scope+rel 适配
│   │   │   ├── ttl-table.ts         #   expiresAt 跟踪
│   │   │   ├── inflight.ts          #   同 path 并发 op 去重
│   │   │   ├── sync-coordinator.ts  #   双路写入中枢
│   │   │   ├── client-protocol-v1.ts #  协议消息构造（与业务逻辑分离）
│   │   │   ├── prefetch.ts          #   批量预热（bounded concurrency）
│   │   │   └── gc.ts                #   TTL evict + orphan blob GC
│   │   ├── config-preloader.ts      # 启动期同步预热模块
│   │   ├── file-proxy-manager.ts    # FUSE 配置投影 daemon（与 FileAgent 共享 store）
│   │   ├── protocol.ts              # 消息类型定义
│   │   └── logger.ts
│   └── test/
├── client/                          # Client（用户交互 + 工具执行）
│   ├── src/
│   │   ├── index.ts                 # CLI 入口
│   │   ├── client.ts                # WebSocket 客户端
│   │   ├── executor.ts              # 工具分发器
│   │   ├── ui.ts                    # 启动期进度 UI（Phase 抽象）
│   │   ├── cache-sync.ts            # 启动期增量缓存同步
│   │   ├── cache-task-state-machine.ts
│   │   ├── tools/
│   │   │   ├── fs.ts                # Read / Write / Edit / MultiEdit
│   │   │   ├── bash.ts              # Bash 执行
│   │   │   └── search.ts            # Grep / Glob
│   │   ├── mcp/runtime.ts           # MCP Runtime 桥接
│   │   ├── file-proxy.ts            # 文件代理客户端
│   │   └── ...
│   └── test/
├── web/                             # 浏览器 UI（可选）
├── docs/                            # 技术文档
│   ├── architecture.md              # 本文档
│   ├── brain-docker.md              # 容器化部署
│   ├── acp-editor-integration.md    # 编辑器集成
│   ├── plan-d-mcp-shadow-tools.md   # Shadow MCP 设计
│   └── plan-acp-relay.md            # ACP relay 设计
├── docker-compose.yml
├── Dockerfile
└── docker-entrypoint.sh
```

---

## 8. 系统级环境变量 / System-level Environment Variables

> 用户使用相关的环境变量（如 `CERELAY_KEY`、`HTTP_PROXY`、`NO_PROXY`）见 [README.md](../README.md)。本节列举只有部署 / 调试 / 二次开发会用到的内部变量。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CERELAY_ENABLE_MOUNT_NAMESPACE` | `true` | 是否启用 mount namespace 隔离 |
| `CERELAY_ENABLE_SHADOW_MCP` | `true` | Plan D shadow MCP 总开关；显式 `false`/`0`/`no`/`off` 关闭后走 legacy hook 路径 |
| `CERELAY_SHADOW_MCP_SOCKET_DIR` | `${CERELAY_DATA_DIR}/sockets/` | shadow MCP unix socket 父目录 |
| `CERELAY_DATA_DIR` | `/var/lib/cerelay` | 容器内持久化数据目录（凭证 + Client 缓存 + sockets） |
| `CERELAY_DISABLE_INITIAL_CACHE_SYNC` | — | 测试用：跳过启动期缓存同步流程 |
| `CERELAY_SOCKS_DNS_SERVER` | `1.1.1.1` | TUN 模式下走代理解析的上游 DNS |
| `CERELAY_SOCKS_UDP` | `forward` | UDP 策略：`forward` 继续放行，`block` 显式拒绝非 DNS UDP |
| `CERELAY_SOCKS_TUN_ADDRESS` | `172.19.0.1/30` | sing-box TUN 地址段 |
| `CERELAY_SOCKS_TUN_MTU` | `9000` | sing-box TUN MTU |
| `LOG_LEVEL` | `info` | 日志级别（debug/info/warn/error） |
| `LOG_JSON` | — | 是否输出 JSON Lines 日志 |

---

## 9. 测试架构 / Testing Architecture

### 9.1 单元测试

- 位置：`**/test/*.test.ts`
- 运行：`npm test` 或 `npm run test:workspaces`
- 使用 Node.js 原生 `node --test` 运行器

### 9.2 E2E 集成测试

**关键文件**：`server/test/e2e-hand.test.ts`、`server/test/e2e-hand-mock-api.test.ts`、`server/test/e2e-mcp-shadow-bash.test.ts`、`server/test/e2e-real-claude-bash.test.ts`

- 启动真实 Server 和 Client（或 mock brain）
- 通过 WebSocket 交互
- 验证完整的工具执行流程
- **Plan D 双路径不变量**：`mcp__cerelay__*` 路径 `is_error === false`；legacy hook 路径 `is_error === true`（CC 协议硬约束）

### 9.3 烟测

```bash
npm run test:smoke
```

验证基础功能（build、typecheck、Docker entrypoint）。

### 9.4 并发约束

测试使用 `--test-concurrency=1` 防止并发干扰（PTY、unix socket、FUSE 等资源容易踩踏）。

---

## 10. 性能考虑 / Performance Considerations

1. **Session 隔离**：每个 Session 有独立的 Claude 运行时，避免状态污染
2. **流式传输**：WebSocket 流式传输文本和工具调用结果，避免大批量缓冲
3. **Cache 启动期 pipeline**：多个文件并行 in-flight，`MAX_INFLIGHT_BYTES = 16 MB` 流控；本地/局域网下基本不触发上限
4. **并发控制**：测试使用 `--test-concurrency=1` 防止资源竞争

---

## 11. 子文档索引 / Sub-documents Index

| 文档 | 内容 |
|---|---|
| [`brain-docker.md`](./brain-docker.md) | Docker 部署、`cerelay-data` volume、SOCKS5 代理细节 |
| [`acp-editor-integration.md`](./acp-editor-integration.md) | ACP stdio 模式协议、Zed / VS Code 集成 |
| [`plan-d-mcp-shadow-tools.md`](./plan-d-mcp-shadow-tools.md) | Shadow MCP 设计（绕开 PreToolUse deny 协议约束） |
| [`plan-acp-relay.md`](./plan-acp-relay.md) | ACP relay 设计 |
| [`superpowers/specs/2026-05-01-access-ledger-driven-cache-design.md`](./superpowers/specs/2026-05-01-access-ledger-driven-cache-design.md) | Access-Ledger 驱动的 Snapshot + 增量同步缓存重构设计（修复 phase_syncing 抢跑、持久化 missing 路径、扩展 cwd-ancestor `CLAUDE.md` 覆盖） |
| [`../CLAUDE.md`](../CLAUDE.md) | 项目级 AI 协作规范、架构特点详细约束 |

---

## 12. 文档维护原则 / Documentation Maintenance Principles

> 本节同步定义在 [`../CLAUDE.md`](../CLAUDE.md)（`文档结构与职责 / Documentation Structure & Responsibility`）。新增 / 修改文档时请遵循以下职责划分：

- [`README.md`](../README.md) — **用户视角**：能力总览、前置条件、快速开始、鉴权、代理、Web UI、license。**不放架构图、组件分层、env vars 全表、内部模块路径**
- [`docs/architecture.md`](./architecture.md)（本文档）— **贡献者视角**：架构总览 + 技术选型 + 核心机制 + 子文档索引。**专题深挖**（部署 / 编辑器集成 / Plan D 设计等）下沉到独立 `docs/<topic>.md`
- [`docs/<topic>.md`](.) — 单一专题深挖。新增专题文档必须从 architecture.md §11 子文档索引登记
- [`CLAUDE.md`](../CLAUDE.md) — **AI 协作规范 + 项目级强制约束**（如 Phase 抽象约束）。**不重复 architecture.md 已有的描述性内容**，但可定义 architecture.md 不便表达的"必须 / 禁止"规则
