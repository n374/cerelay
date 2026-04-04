# Axon 执行规划

## 架构全景

```
┌──────────────────────────────────────────────────────────┐
│                      Hand 端                              │
│                                                          │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────────┐ │
│  │  Hand CLI   │  │  Hand Web   │  │  Editor (Zed等)  │ │
│  │  终端交互    │  │  浏览器交互  │  │                  │ │
│  │  本地工具执行│  │  本地工具执行│  │  ↕ ACP (stdio)   │ │
│  └──────┬──────┘  └──────┬──────┘  └────────┬─────────┘ │
│         │                │                   │           │
│         │                │          ┌────────▼────────┐  │
│         │                │          │  Hand CLI       │  │
│         │                │          │  (ACP Server)   │  │
│         │                │          └────────┬────────┘  │
│         └────────┬───────┘                   │           │
│                  │                           │           │
└──────────────────┼───────────────────────────┼───────────┘
                   │ HTTP 长连接                │
                   │ (双向: 聊天 + 工具调用)     │
┌──────────────────┼───────────────────────────┼───────────┐
│                  │        Brain 端 (容器)     │           │
│         ┌────────▼───────────────────────────▼────────┐  │
│         │           Axon HTTP Server                  │  │
│         │                                             │  │
│         │  ┌─ Session 管理 (创建/恢复/列表)           │  │
│         │  ├─ 聊天通道: Hand ↔ Claude Code            │  │
│         │  └─ 工具通道: Claude Code → Hand → 结果返回  │  │
│         └────────────────┬────────────────────────────┘  │
│                          │ ACP (JSON-RPC over stdio)     │
│                          │                               │
│         ┌────────────────▼────────────────────────────┐  │
│         │           Claude Code (子进程)               │  │
│         │                                             │  │
│         │  PreToolUse Hook → Proxy (工具调用拦截)      │  │
│         │  Proxy ──→ Axon Server ──→ Hand (远程执行)   │  │
│         │  Proxy ←── Axon Server ←── Hand (结果返回)   │  │
│         │                                             │  │
│         │  Fallback: Proxy 文件不存在 → 本地执行       │  │
│         └─────────────────────────────────────────────┘  │
│                                                          │
│  挂载点:                                                  │
│  - 用户 .claude/ 配置 (含 Plugin hooks 注入)              │
│  - 用户 CLAUDE.md 等                                      │
└──────────────────────────────────────────────────────────┘
```

## 交互时序

```
Hand CLI          Axon HTTP Server        Claude Code (容器内)
  │                     │                       │
  │ ── 连接 ──────────→ │                       │
  │ ← Session 列表 ──── │                       │
  │ ── 选择/新建 ──────→ │                       │
  │                     │ ── ACP initialize ──→ │
  │                     │ ← capabilities ────── │
  │                     │ ── session/new ─────→ │
  │                     │                       │
  │ ── 用户输入 ───────→ │                       │
  │                     │ ── session/prompt ──→ │
  │                     │                       │
  │                     │ ← session/update ─── │ (思考中...)
  │ ← 流式输出 ──────── │                       │
  │                     │                       │
  │                     │    Claude Code 决定调用 Bash("ls -la")
  │                     │                       │
  │                     │    PreToolUse Hook 触发
  │                     │    Proxy 拦截 → 发给 Axon Server
  │                     │                       │
  │ ← 工具调用请求 ──── │ ← 工具请求 ────────── │ (Proxy 阻塞等待)
  │                     │                       │
  │  [本地执行 ls -la]  │                       │
  │                     │                       │
  │ ── 执行结果 ───────→ │                       │
  │                     │ ── 结果 ────────────→ │ (Proxy 返回)
  │                     │                       │
  │                     │ ← session/update ─── │ (继续推理...)
  │ ← 流式输出 ──────── │                       │
  │                     │                       │
```

## 双通道设计

| 通道 | 协议 | 方向 | 用途 |
|------|------|------|------|
| **聊天通道** | ACP (stdio) + HTTP 长连接 | Hand → Brain → Claude Code → Brain → Hand | 用户输入、LLM 输出、思考过程 |
| **工具通道** | Hook/Proxy + HTTP 长连接 | Claude Code → Proxy → Brain → Hand → 执行 → 原路返回 | 工具调用的远程执行 |

两条通道共享同一条 HTTP 长连接，通过消息类型区分。

## Fallback 机制

Proxy 脚本在 hooks 中注册，指向容器内固定路径。行为分两种情况：

| 场景 | Proxy 文件 | 行为 |
|------|-----------|------|
| Brain 容器内启动 | 存在 | 拦截工具调用 → 转发到 Hand 远程执行 |
| 用户本地启动 | 不存在 | Hook 执行失败 → Claude Code 忽略 → 本地直接执行 |

用户安装 Plugin 后，hooks 配置始终存在，但 Proxy 脚本只在 Brain 容器中可用。这是零配置的优雅降级。

## 分阶段执行

### Phase 0: 基础设施 ✅ (已完成)

- [x] PreToolUse Hook 系统 (dispatch.sh)
- [x] 工具代理脚本框架 (*.sh.example)
- [x] 共享工具库 (lib.sh)
- [x] 审计日志系统

---

### Phase 1: Proxy v2 — 远程执行中继

**目标**: 将 Proxy 从安全过滤器改造为远程执行中继，通过 IPC 与 Axon Server 通信。

**交付物**:
- Proxy 脚本改造：工具调用 → 序列化请求 → 写入 Unix Socket → 阻塞等待结果 → 返回
- IPC 协议定义（Unix Domain Socket，JSON 消息）
- Fallback 逻辑：Socket 不可用时本地执行
- 保留现有安全过滤能力（可配置开关）

**关键决策**:
- Proxy 与 Axon Server 之间用 Unix Socket（同容器内，零网络开销）
- 请求/响应用 JSON，包含 request_id 以支持并发

**依赖**: 无（可独立开发）

---

### Phase 2: Axon HTTP Server — Brain 核心

**目标**: Brain 端的核心服务，桥接 Hand (HTTP) 和 Claude Code (ACP/stdio)。

**交付物**:
- HTTP Server，支持长连接（SSE 或 WebSocket）
- ACP Client：启动 Claude Code 子进程，通过 stdio JSON-RPC 通信
- Unix Socket Server：接收 Proxy 转发的工具调用
- 聊天通道：Hand 输入 → ACP session/prompt → Claude Code 输出 → SSE 推送到 Hand
- 工具通道：Proxy 请求 → HTTP 推送到 Hand → Hand 结果 → 返回 Proxy
- Session 管理：创建、列表、恢复、历史记录
- API 协议定义（Hand ↔ Axon Server）

**关键决策**:
- 技术栈选型（见下方讨论）
- HTTP 长连接方案：SSE（简单、单向推送 + POST 上行）vs WebSocket（全双工）
- Session 持久化方案

**依赖**: Phase 1（Proxy IPC 协议）

---

### Phase 3: Hand CLI — 基础版

**目标**: 命令行客户端，用户在此与 Brain 交互，工具在此执行。

**交付物**:
- 终端 UI（类似 Claude Code 的交互体验）
- HTTP 长连接客户端，连接 Axon Server
- 聊天功能：发送输入、接收流式输出
- 工具执行引擎：接收工具请求 → 本地执行 Bash/Read/Write/Grep/Glob/Edit → 返回结果
- Session 选择：连接时展示历史 Session 列表
- 连接管理：断线重连、心跳

**依赖**: Phase 2（Axon Server API）

---

### Phase 4: Brain 容器化

**目标**: 将 Brain 端打包为 Docker 容器，一键启动。

**交付物**:
- Dockerfile：极简 Linux + Claude Code CLI + Axon Server + Proxy v2
- 挂载点设计：
  - `/config/.claude/` → 用户的 Claude 配置
  - `/config/CLAUDE.md` → 用户的项目指令
- Plugin 安装脚本：自动向用户配置中注入 hooks
- docker-compose.yml（含环境变量、端口映射）
- 启动脚本：初始化 → 注入 hooks → 启动 Axon Server → 启动 Claude Code

**关键决策**:
- 基础镜像选择（Alpine vs Debian slim）
- Claude Code 安装方式（npm global vs 预装）
- API Key 传入方式（环境变量 vs 挂载文件）

**依赖**: Phase 2 + Phase 3（端到端可用后再容器化）

---

### Phase 5: Hand CLI — ACP Server

**目标**: Hand CLI 对外暴露 ACP 接口，让编辑器（Zed、VS Code 等）可以将其当作 Claude Code 使用。

**交付物**:
- ACP Server 实现（JSON-RPC over stdio）
- 支持 ACP 核心方法：initialize、session/new、session/prompt、session/update
- 工具请求处理：editor 发来的 fs/read、terminal/execute → 本地执行或转发给 Brain
- 编辑器集成文档

**效果**: 用户在 Zed/VS Code 中配置 Hand CLI 为 Agent，编辑器以为在和 Claude Code 交互，实际上 Hand CLI 将推理委托给远端 Brain。

**依赖**: Phase 3（Hand CLI 基础版）

---

### Phase 6: Hand Web

**目标**: 浏览器端的交互界面。

**交付物**:
- Web UI（聊天界面 + 工具执行状态展示）
- WebSocket 连接 Axon Server
- 工具执行：通过配套的本地 daemon 执行（或直接在 Web 服务器所在机器执行）
- Session 管理 UI

**依赖**: Phase 2（Axon Server API）

---

### Phase 7: 生产化

**目标**: 安全、可管理、可扩展。

#### 7.1 认证与安全

- **HTTP + Pre-shared Token**：Hand 连接时携带 Token 认证，Axon Server 校验
- **TLS 由外层反向代理（Nginx / Caddy）承担**，Axon Server 本身只处理 HTTP
- Token 生命周期管理：创建、吊销、过期策略

#### 7.2 管理后台（Brain Admin）

Brain 侧的 Web 管理后台，用于运维和管控：

**用户与 Token 管理**:
- 用户 CRUD（创建、查看、禁用）
- 为每个用户签发/吊销连接 Token
- Token 权限控制（可选：限制可用工具、Session 数上限等）

**连接状态**:
- 当前在线 Hand 列表（用户、连接时间、IP、活跃 Session）
- 实时连接/断开事件
- Hand 心跳状态

**用户统计**（取决于 ACP 协议支持程度）:
- Session 数量、消息轮次
- Token 用量（input/output tokens，需 ACP 在 session/update 中返回 usage 字段）
- 工具调用次数与类型分布
- 若 ACP 不暴露 token usage，则仅统计 Axon 可观测的指标（Session 数、消息数、工具调用数）

**技术方案**:
- 管理后台作为 Axon Server 的内置模块，共享同一进程，独立端口或路径前缀（`/admin`）
- 轻量前端（可选 React / 纯静态页面）
- 数据持久化：SQLite（单机）或 PostgreSQL（多实例部署）

#### 7.3 Multi-Hand 调度

- 多 Hand 同时连接时的任务分配
- Session Affinity（工具调用路由到正确的 Hand）

#### 7.4 可靠性

- 优雅关闭 / 断线恢复
- 监控与日志（结构化日志、Prometheus metrics）

**依赖**: Phase 1-6 全部完成

---

## 技术栈建议

| 组件 | 推荐 | 理由 |
|------|------|------|
| Axon Server | TypeScript (Node.js) | 与 Claude Code 生态一致；`@anthropic-ai/claude-code` SDK 原生 TS；ACP 适配器 `claude-agent-acp` 也是 TS |
| Hand CLI | TypeScript (Node.js) | 复用 Axon Server 的协议层代码；可共享 monorepo |
| Hand Web | TypeScript (React/Vue) | 前后端统一技术栈 |
| Proxy v2 | Bash (现有) + 轻量改造 | 保持与 Claude Code Hook 系统兼容，仅增加 Socket 通信 |
| 容器 | Docker (Alpine) | 极简，镜像小 |

**备选**: 如果追求单二进制部署和极致性能，Go 也是强选项。但会丧失与 Claude Code TS 生态的直接集成能力。

**建议**: 先用 TypeScript 跑通 Phase 1-4，验证架构可行性后再决定是否需要迁移。

## 里程碑

| 里程碑 | 包含 Phase | 交付标志 |
|--------|-----------|---------|
| **M1: 端到端 POC** | 1 + 2 + 3 | Hand CLI 输入 → Brain 思考 → Hand 执行 → 结果返回，完整闭环 |
| **M2: 可分发** | 4 | `docker run` 一键启动 Brain，Hand CLI 连接即用 |
| **M3: 编辑器集成** | 5 | Zed/VS Code 通过 ACP 连接 Hand CLI，体验等同本地 Claude Code |
| **M4: Web 端** | 6 | 浏览器中使用 Axon |
| **M5: 生产就绪** | 7 | 安全、多 Hand、可监控 |
