# Plan: baseline-shadow-mcp-clientcache

> 位置：`docs/changes/baseline-shadow-mcp-clientcache/plan.md`
> 角色：记录反向生成两份 living spec 的方法、源文件、发现的技术债。
>
> **特殊性**：baseline change 不走「双人对齐」，因为它描述的是已经存在的代码现状而不是新设计。验收只对照"spec 是否如实反映代码"做检查，不评判设计好坏。

## 反向生成方法

按 `~/.claude/skills/spec-driven-docs/brownfield.md` 第 4 步：

1. **定位代码**：grep / Read 出与该 capability 相关的所有源文件
2. **提取 Requirements**：
   - 从代码逻辑反推业务规则（每个分支、每个校验、每个 error path 都是一条潜在 requirement）
   - 用 SHALL / MUST 句式描述
   - 描述**当前实际行为**，不是"应该的行为"（避免把 bug 当 spec）
3. **提取 Scenarios**：
   - 从测试用例提取（最高优先级，测试是行为契约）
   - 从代码分支提取（无测试覆盖的路径标注 `[no-test]`）
4. **写到 living spec**：直接写 `docs/specs/<capability>/spec.md`（baseline 是唯一可以直接写 living spec 的场景）

**版本基线**：本次反向生成基于 git commit `54f69d3`（批 1 完成后状态）。

## 覆盖范围

### Capability: shadow-mcp-tools

**职责**：在 cerelay-routed dispatcher 与每个 PTY session 之间建立 shadow MCP 通道，让模型看到的工具结果 `is_error` 由 cerelay 显式控制，绕开 PreToolUse hook 协议下 deny 分支必然 `is_error: true` 的硬约束。

**源文件清单**：

| 文件 | 角色 |
|---|---|
| `server/src/mcp-routed/index.ts` | cerelay-routed 子进程入口（CC spawn 后通过 stdio JSON-RPC 通信） |
| `server/src/mcp-ipc-host.ts` | 主进程 per-session unix socket host（接收 routed 子进程的 dispatch 请求） |
| `server/src/mcp-cc-injection.ts` | CC spawn 前的 CLI flags 注入（`--mcp-config` / `--append-system-prompt` / `--disallowedTools`） |
| `server/src/pty-session.ts` | PTY session 启动入口（注入 shadow MCP 与 hook fallback 的衔接） |
| `server/src/tool-routing.ts` | tool routing 互斥逻辑（`mcp__cerelay__*` 不被视为 client-routed） |
| `server/src/session.ts` | hook fallback 路径（fallback 引导 reason） |
| `client/src/tools/{fs,bash,search}.ts` | 7 个 shadow tool 在 client 侧的实现，作为 schema 对齐源 |
| `server/test/e2e-mcp-shadow-bash.test.ts` | 双路径不变量主守护测试 |
| `server/test/e2e-real-claude-bash.test.ts` | hook fallback 路径 is_error 守护测试 |
| `docs/plan-d-mcp-shadow-tools.md` | Plan D 完整设计文档（含协议硬约束证据） |

### Capability: client-config-sync

**职责**：把 Client 本机的 `~/.claude/`、`~/.claude.json`、`{cwd}/.claude/` 三个 scope 的配置以 device-only 维度同步到 Server，让 FUSE Host 读路径与 ConfigPreloader 启动期预热共享同一份 store，降低启动期开销并支持跨 cwd 共享 manifest。

**源文件清单**：

| 文件 | 角色 |
|---|---|
| `server/src/file-agent/index.ts` | per-device 单例底座（read / stat / readdir / prefetch + ttlMs 接口） |
| `server/src/file-agent/store.ts` | manifest 存储 + 串行锁（`withManifestLock`） |
| `server/src/file-agent/scope-adapter.ts` | scope（`claude-home` / `claude-json`）适配 |
| `server/src/config-preloader.ts` | 启动期预热（`preheat`） |
| `server/src/file-proxy-manager.ts` | FUSE Host（运行时穿透 + cache 命中分流） |
| `server/src/client-cache-store.ts` | Server 端 cache store + manifest delta 应用 |
| `server/src/protocol.ts` | `CacheTask*` 协议字段定义 |
| `client/src/cache-sync.ts` | Client 侧 manifest 计算与 pipeline 上传 |
| `client/src/device-id.ts` | deviceId 生成与持久化 |
| `client/src/ui.ts` | 双行进度 UI（`CacheSyncProgressView` + `Phase`） |
| `docs/archive/2026-05-02-file-agent-and-config-preloader/plan.md` | FileAgent + ConfigPreloader 设计文档 |

## 发现的债务

> 反向生成时发现的代码与文档描述不一致 / 隐含 bug / 缺测试覆盖 / 死代码。**不在本 change 修复**，由后续真实 change 处理。

| # | 类别 | 描述 | 处理方式 |
|---|---|---|---|
| BD-1 | 缺测试 | shadow-mcp-tools NFR-1 降级安全（MCPIpcHost 启动失败仅 warn 不阻塞 session）无显式 e2e 守护，依赖代码 try/catch 实现 | 同步到 `docs/project.md` §4 TD-5；后续 change 触达 mcp-ipc-host.ts 时补 e2e |
| BD-2 | 缺测试 | shadow-mcp-tools NFR-3 工具调用 hot path 性能未量化，依赖整体 e2e 耗时观察 | 同步到 `docs/project.md` §4 TD-6；待性能预算 change 启动时定基线 |
| BD-3 | 缺测试 | client-config-sync NFR-2 失败降级（缓存同步失败不阻塞 PTY session）无显式 e2e 守护，依赖代码 try/catch 实现 | 同步到 `docs/project.md` §4 TD-7；后续 change 触达 cache 启动路径时补 e2e |

## 归档动作

baseline change 不像普通 change 那样有 delta，它**直接生成 living spec**。归档时（按 brownfield.md 第 5 步）：

1. 验证 `docs/specs/shadow-mcp-tools/spec.md` 与 `docs/specs/client-config-sync/spec.md` 两份 living spec 已落盘
2. 把「发现的债务」清单同步到 `docs/project.md` §4
3. 移动 `docs/changes/baseline-shadow-mcp-clientcache/` → `docs/archive/2026-05-05-baseline-shadow-mcp-clientcache/`
4. commit message：`📦 archive / baseline-shadow-mcp-clientcache / Archive baseline for shadow-mcp-tools and client-config-sync`

## 跨 change 链接

- 后续真实 change `shadow-mcp-permission-integration` 的 spec delta 将基于本 change 产出的两份 living spec 写：
  - `docs/changes/shadow-mcp-permission-integration/specs/shadow-mcp-tools/spec.md`（MODIFIED）
  - `docs/changes/shadow-mcp-permission-integration/specs/client-config-sync/spec.md`（MODIFIED）
  - `docs/changes/shadow-mcp-permission-integration/specs/shadow-mcp-permission/spec.md`（ADDED）
