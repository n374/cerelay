<!-- doc-init template version: v1.0 -->
# Cerelay Glossary

> 术语表持续累积。任何新概念引入必须先在此注册（一行也行）。
> 本表初始只收录 Cerelay 特有 + 与通用术语易混淆的概念；通用 TS / Node / Docker / FUSE 术语不在此重复。

## 业务术语

| 术语 | 英文 | 定义 | 出处 |
|---|---|---|---|
| Server | Server | Cerelay 后端：托管 Claude Code PTY、SDK query()、PreToolUse hook、Mount namespace runtime | [architecture/README.md](../architecture/README.md) |
| Client | Client | 用户本机 CLI；执行本地工具（Read/Write/Bash/...）、通过 WebSocket 把结果回传 Server | [architecture/README.md](../architecture/README.md) |
| Hand | Hand | Client 的早期别名（已弃用，仍在历史文档与部分变量名残留） | [archive/2026-05-11-handover-go-era/](../archive/2026-05-11-handover-go-era/) |
| Brain | Brain | Server 的早期别名（已弃用） | [operations/brain-docker.md](../operations/brain-docker.md) |
| CC | CC | Claude Code（在 Server 容器内由 SDK 驱动的 `claude` CLI 进程） | [architecture/modules/session-runtime.md](../architecture/modules/session-runtime.md) |

## 技术术语

| 术语 | 英文 | 定义 | 出处 |
|---|---|---|---|
| Mount Namespace | mount namespace | Linux 内核功能，为每个 session 创建独立文件系统视图；CC 看到的 cwd/HOME 通过 `unshare`/`nsenter` 投影 | [architecture/modules/session-runtime.md](../architecture/modules/session-runtime.md) |
| FUSE Daemon | FUSE daemon | Server 侧自实现的文件代理 daemon，把 `~/.claude/`、`~/.claude.json`、`{cwd}/.claude/` 投影到 CC namespace | [architecture/modules/file-agent-cache.md](../architecture/modules/file-agent-cache.md) |
| Shadow MCP Tools | Shadow MCP Tools | Plan D：用 `mcp__cerelay__*` MCP 工具替代 SDK 内置工具（Bash/Read/Write/...），绕开 hook deny 必然 `is_error: true` 的协议硬约束 | [architecture/modules/shadow-mcp.md](../architecture/modules/shadow-mcp.md) |
| PreToolUse Hook | PreToolUse hook | SDK 暴露的工具调用拦截入口；legacy 路径用它把工具调用转发给 Client | [architecture/modules/shadow-mcp.md](../architecture/modules/shadow-mcp.md) |
| Tool Relay | tool relay | server.session 中转发 SDK tool_call → Client → tool_result 的机制 | [architecture/modules/shadow-mcp.md](../architecture/modules/shadow-mcp.md) |
| FileAgent | FileAgent | per-device 单例文件代理底座，对外暴露 `read/stat/readdir/prefetch + ttlMs` | [architecture/modules/file-agent-cache.md](../architecture/modules/file-agent-cache.md) |
| ConfigPreloader | ConfigPreloader | 启动期同步阻塞预热模块；调一次 `fileAgent.prefetch` 把 `~/.claude/` + cwd 父链 CLAUDE.md 提前拉好 | [architecture/modules/file-agent-cache.md](../architecture/modules/file-agent-cache.md) |
| Access Ledger | access ledger | per-device 持久化访问账本（file_present / dir_present / missing 三类 entry）；access-ledger-driven cache 的核心数据结构 | [archive/2026-05-01-access-ledger-driven-cache/](../archive/2026-05-01-access-ledger-driven-cache/) |
| Seed Whitelist | seed whitelist | 编译期静态 const；冷启动阶段用作 cache 启动种子的目录/文件白名单 | [archive/2026-04-26-client-scan-optimization/](../archive/2026-04-26-client-scan-optimization/) |
| Shadow File | shadow file | FUSE 出口把 Server 侧文件作为「`home-claude/<path>`」呈现给 CC namespace（凭证、settings.json redacted 等） | [architecture/modules/session-runtime.md](../architecture/modules/session-runtime.md) |
| Login-state Redaction | login-state redaction | Server → CC 出口对 `~/.claude/settings.json` 中的 4 个登录态字段做字段级过滤 | [archive/2026-04-30-shadow-claude-settings-redaction/](../archive/2026-04-30-shadow-claude-settings-redaction/) |
| Plan D | Plan D | Shadow MCP tools 落地方案的代号 | [architecture/modules/shadow-mcp.md](../architecture/modules/shadow-mcp.md) |
| Phase 抽象 | Phase abstraction | client 启动期进度 UI 的统一抽象（cache scan / upload / pty-startup 三 phase） | [architecture/modules/startup-progress-ui.md](../architecture/modules/startup-progress-ui.md) |

## 缩略语

| 缩略 | 全称 | 用法 |
|---|---|---|
| ACP | Agent Communication Protocol | 编辑器（Zed / VS Code）通过 stdio JSON-RPC 调用 Cerelay 的协议（当前主分支未启用） |
| SDK | Claude Agent SDK | `@anthropic-ai/claude-agent-sdk`，Server 用它驱动 `claude` CLI |
| PTY | pseudo terminal | Server 给 CC 进程创建的伪终端，支持交互式命令 |
| MCP | Model Context Protocol | Anthropic 定义的工具与上下文协议（Cerelay Shadow MCP 在此之上做工具替身） |
| TTL | time to live | FileAgent cache entry 的过期时长（必须为有限正数） |
| GC | garbage collection | FileAgent 周期清过期 entry + orphan blob |

## 易混淆术语对比

| 术语 A | 术语 B | 区别 |
|---|---|---|
| Server / Brain | Client / Hand | Server 跑 SDK + PTY；Client 在本机执行工具。Brain/Hand 是已废弃别名 |
| Plan D | Plan ACP Relay | Plan D 已落地（shadow MCP）；Plan ACP Relay 已归档为 deprecated（未落地） |
| FileAgent | FileProxy / ClientCacheStore | FileAgent 是上层抽象；FileProxyManager 是 FUSE daemon 一侧；ClientCacheStore 是底层 store（FileAgent 内部使用） |
| ConfigPreloader | FUSE Host | ConfigPreloader 启动期一次性同步预热；FUSE Host (`file-proxy-manager`) 运行期处理 FUSE op |
| PreToolUse Hook | Shadow MCP | Hook 是 SDK 原生 deny→is_error 的兜底路径；Shadow MCP 是绕开该协议硬约束的主路径 |
| spec / change / archive | superpowers/specs (历史) | 当前 spec = `docs/specs/<cap>/`，change = `docs/changes/<slug>/`，archive = `docs/archive/<dated>/`；`docs/superpowers/` 已全部归档进 archive |

## 修订历史

| 日期 | 变更 | 由谁 |
|---|---|---|
| 2026-05-11 | 初始建立 glossary（迁移 superpowers + 标准化 overview/ 时落地） | Tech Lead |
