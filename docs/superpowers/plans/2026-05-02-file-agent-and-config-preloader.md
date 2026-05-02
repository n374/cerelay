# Plan: FileAgent 底座抽象 + ConfigPreloader 分层 + Device 维度迁移

> **Status: Implemented (2026-05-02, commits 045587a..315a281)**.
> **Executor:** Claude（自己落地）。
> **Discipline:** 严格 TDD（红 → 绿 → 重构 → commit），每个 task 一个 commit。
> **Codex review:** 见提交日志末尾 review 链路（Task 12 触发）。

实施 commit 链路（按 task 顺序）：

| Task | Commit | 内容 |
|---|---|---|
| 0 清场 | 045587a + 98af9e4 | revert codex V2 6 commits + 删 stranded test + 加 plan md |
| 1 接口骨架 | 0f6284c | FileAgent class + types |
| 2 store device-only | 29e7a46 + d3a2d78 | manifest v3 + 全局 blob 池 + mv 至 file-agent/store + scope-adapter + FileAgent 接命中 |
| 3 TTL 表 | 060e564 | TtlTable + bump max + 命中时续期 |
| 4 in-flight 去重 | f1cf52f | InflightMap + 100 并发去重 |
| 5 sync-coordinator | 3dda1b3 | client-protocol-v1 + 双路写入（B 完整 + A 桩） |
| 6 prefetch | e4ca123 | bounded concurrency 16 + dir walk + 失败收集 |
| 7 GC | 141448d | TTL evict + 60s 周期 + in-flight 安全 |
| 8 ConfigPreloader | e2b2711 | 同步预热 + getNamespaceMountPlan |
| 9 FuseHost wiring | ef3c9df | file-proxy-manager 接 fileAgent 字段 + 共享 store 契约 |
| 10 session 接入 | 6729dfc | server.ts 维护 fileAgents Map + ConfigPreloader.preheat 集成 |
| 11 import 清理 | 在 Task 2b 一并完成 | （d3a2d78 内 git mv 时同步更新 7 个 import） |
| 12 E2E + 文档 | 315a281 + （本 commit）| 6 个 E2E 场景 + CLAUDE.md / architecture.md / spec § 11.2/11.3 status 更新 |

回归验证：`server: 411 + client: 135 + web: 6 = 552 tests pass / 5 skipped / 0 fail`。Typecheck 全部干净。

**Goal:** 把现有「ClientCacheStore + AccessLedger + SyncPlan + FileProxyManager 共同承担文件代理职责」的混合架构，重组为干净的两层：

- **底层 `FileAgent`** —— Device 级单机文件代理子系统，封装 manifest/blob/ledger/sync/TTL，对外只暴露 **`read / stat / readdir`** 三个接口（每次调用必带 `ttlMs`）
- **上层两个并列 caller** —— `ConfigPreloader`（启动期 snapshot 预热）和 `FuseHost`（运行时 CC 直接访问）

cache 维度同步从 `(deviceId, cwd)` → `deviceId`；ancestor `CLAUDE.md` 加载是 ConfigPreloader 调 FileAgent 的自然结果，**不引入新 scope / 不引入新协议字段**。

---

## 1. 架构图 / Architecture Diagram

### 1.1 总览 / Overview

```
                    ┌──────────────────────────────────────────────┐
                    │   Mount Namespace（容器，per session）        │
                    │     ├── CC 进程                              │
                    │     └── FUSE mount: /var/run/cerelay/fuse/   │
                    └──────────────────────┬───────────────────────┘
                                           │ POSIX read/stat/readdir
                                           ▼
                    ┌──────────────────────────────────────────────┐
                    │   FuseHost（Python daemon, 嵌入字符串）       │
                    │   - 把 POSIX op 转成 IPC → server            │
                    └──────────────────────┬───────────────────────┘
                                           │ IPC (json line)
                                           │
   ┌────────────────────────┐              │
   │ ConfigPreloader        │              │
   │ - 启动期算访问范围:     │              │
   │   home + cwd + 父链    │              │
   │ - 调 FileAgent.read    │              │
   │   预热文件             │              │
   │ - 不直接读文件         │              │
   └──────────┬─────────────┘              │
              │                            │
              │ FileAgent API              │ FileAgent API
              ▼                            ▼
   ┌────────────────────────────────────────────────────────────┐
   │   FileAgent（底座，per-device 单例）                         │
   │   ─────────────────────────────────────────────────         │
   │   对外: read(absPath, ttlMs) → Buffer | "missing"          │
   │         stat(absPath, ttlMs) → StatResult | "missing"      │
   │         readdir(absDir, ttlMs) → string[] | "missing"      │
   │                                                            │
   │   内部组件:                                                 │
   │     ┌─────────────────┐  ┌────────────────────┐           │
   │     │ Manifest Store  │  │ Blob Pool          │           │
   │     │ (device-only)   │  │ <deviceId>/blobs/  │           │
   │     └────────┬────────┘  └─────────┬──────────┘           │
   │              │                     │                       │
   │     ┌────────▼─────────────────────▼──────────┐           │
   │     │ Ledger（path → kind/missing/lastReadAt）│           │
   │     │ + TTL 表（expiresAt）                    │           │
   │     └────────┬─────────────────────────────────┘           │
   │              │                                              │
   │     ┌────────▼─────────────────────┐                       │
   │     │ SyncCoordinator              │                       │
   │     │ (cache-task 协议、与 client  │                       │
   │     │ WS 增量同步、active 选举)    │                       │
   │     └────────┬─────────────────────┘                       │
   └──────────────┼─────────────────────────────────────────────┘
                  │ WebSocket (cache_task 协议族)
                  ▼
        ┌──────────────────────┐
        │   Client (Hand)      │  真实文件系统
        └──────────────────────┘
```

### 1.2 关键调用流 / Key Call Flow

**启动期（ConfigPreloader 主导）**：

```
session 启动
  → ConfigPreloader.preheat({ homeDir, cwd })
    → 计算 ancestorChain = [cwd, cwd-parent, ..., 不含 homeDir]
    → 一次性拼 PrefetchItem[] 列表：
         [
           { kind: "dir-recursive", absPath: homeDir/.claude },
           { kind: "file",          absPath: homeDir/.claude.json },
           ...ancestorChain × { CLAUDE.md, CLAUDE.local.md } 各一个 file 项,
         ]
    → FileAgent.prefetch(items, ttlMs=startupTtl)
       → 内部并发遍历（受 maxConcurrency 限制）；同 path 多人触发自动去重
       → 命中 cache 直接续期 expiresAt / miss 阻塞穿透 client / 落 manifest
       → 不返回内容，仅返回 { fetched, alreadyHot, missing, failed[] } 统计
  → 预热完毕，session 启动 CC
```

**运行时（FUSE 主导）**：

```
CC 进程 fs.readFile("/h/u/.claude/settings.json")
  → 内核 → FUSE → daemon
  → daemon IPC → server.handleFuseRead("/h/u/.claude/settings.json")
  → FileAgent.read(path, ttlMs=runtimeTtl)
    → 命中 → 返回 Buffer
    → miss → 阻塞穿透 client → 落 manifest → 返回
  → IPC 回 daemon → daemon 回内核 → CC 拿到 buffer
```

### 1.3 与现状的差异 / Delta vs Status Quo

| 维度 | 现状 | 新架构 |
|---|---|---|
| 缓存维度 | `(deviceId, cwd)` | `deviceId` |
| 模块边界 | `ClientCacheStore` + `AccessLedger` + `SyncPlan` + `CacheTaskManager` + `FileProxyManager` 共担文件代理职责，互相调用复杂 | `FileAgent` 单一底座（含原 5 个模块的内部实现），上层 `ConfigPreloader` + `FuseHost` 只调 FileAgent 接口 |
| ancestor `CLAUDE.md` 加载 | 现状缺失（CC 直接 ENOENT） | ConfigPreloader 启动期调 `FileAgent.read(parent/CLAUDE.md, ttl)` 自然覆盖 |
| TTL | 不存在 | 每次 read/stat/readdir 必带 `ttlMs`；FileAgent 周期性 evict 过期 entry |
| Scope 概念 | `claude-home` / `claude-json`，相对路径 | **去 scope**：FileAgent manifest 直接按绝对路径索引；调用方传啥就缓存啥 |
| sync 触发 | client active 上报 cache_task delta | 不变（内部组件，对外不透出）；同时 FileAgent.read miss 也能主动拉 |

---

## 2. 设计原则 / Design Principles

| 原则 | 含义 |
|---|---|
| **P1 单一底座** | FileAgent 是 per-device 单例，所有文件访问最终都经它；上层 caller 不直接读文件、不直接调 client 协议 |
| **P2 接口窄面** | FileAgent 对外**只**暴露 `read / stat / readdir / prefetch` + `ttlMs`；ledger / sync / manifest / blob 全是内部实现 |
| **P3 调用方不知情** | ConfigPreloader 与 FuseHost 都不知道 FileAgent 内部用了 manifest 还是别的；FileAgent 也不知道调用方是 ConfigPreloader 还是 FuseHost |
| **P4 TTL 决策权下放（有限值）** | 每次 op 必传**有限正数** `ttlMs`；FileAgent **拒绝** `ttlMs <= 0` / `Infinity` / `NaN`（运行时报错）。调用方说了算，但永不过期不允许——预热也必须设有限 ttl |
| **P5 阻塞穿透 + 并发去重** | FileAgent.read miss/expired 时阻塞调用方 → 内部穿透 client → 落 cache → 返回。同 path 多个并发 miss 通过 in-flight Map 共享单次穿透（详见 §3.4）。**不**异步、不预测 |
| **P6 Device 唯一标识** | FileAgent 与 device 一一绑定；server 同时服务多 device 时，同时持有多个 FileAgent 实例（per deviceId 单例）|
| **P7 client 协议封装隔离** | 与 Client 交互的协议消息构造/解析放在 `file-agent/client-protocol-v1.ts`，与业务逻辑（`sync-coordinator.ts`）分离；未来若要抽独立"协议层模块"只需替换 v1 实现，业务逻辑不动。本期不抽协议层模块，但实现按可拆分组织 |
| **P8 协议字段不新增** | 现有 `cache_task_*` 消息（claude-home / claude-json scope + relativePath）保持现状；scope 适配在 FileAgent 内部完成（absPath ↔ scope+rel 互转）|
| **P9 双向数据流入** | FileAgent 同时接受**两路数据**写入 manifest：①调用方触发的 read/prefetch miss 阻塞穿透；②client watcher 主动推送的 cache_task_delta（运行时增量）。两路数据共用 manifest，互相不冲突 |
| **P10 最终一致性** | FileAgent 对外提供 **eventual consistency**：缓存内容 vs client 真实文件系统的一致性是异步收敛的（watcher → delta 推送有 100~300ms 量级延迟）。调用方接受"读到的可能略落后"，但只要 client 仍连接，最终会在窗口期内收敛 |

> **P7 与 P8 说明**：协议字段不新增（P8）保证本期不破坏现有 client；协议封装隔离（P7）保证未来重写协议层不破坏业务逻辑。两者结合：本期 client-protocol-v1.ts 是简单胶水，把绝对路径 absPath 映射到现有 scope+rel 协议；scope-adapter 是私有 helper。

> **P9 与 P10 说明**：现有 client 端 `cache-watcher.ts` + `cache-sync.ts` 通过 `cache_task_delta` 把本地文件变更主动推到 server，server 端 `cache-task-manager.ts` apply 到 manifest——这条链路已经成熟。把它整体并入 FileAgent 后，意味着 FileAgent 是「拉取（按需穿透）+ 推送（watcher 增量）」一体化的本地缓存。最终一致性是天然结果：调用方读到的数据要么是上次 read 时的快照，要么是 watcher 推送的最新值；window 由 client watcher debounce + 网络 RTT 决定（典型 < 1s）。

---

## 3. FileAgent 接口规约 / Interface Specification

### 3.1 接口定义

```typescript
// server/src/file-agent/types.ts
export type FileAgentReadResult =
  | { kind: "file"; content: Buffer; size: number; mtime: number; sha256: string }
  | { kind: "missing" }
  | { kind: "skipped"; size: number; mtime: number };  // 大文件不缓存内容，仅元数据

export type FileAgentStatResult =
  | { kind: "file"; size: number; mtime: number; sha256: string | null }
  | { kind: "dir"; mtime: number }
  | { kind: "missing" };

export type FileAgentReaddirResult =
  | { kind: "dir"; entries: string[] }   // 不含 "." ".."
  | { kind: "missing" };

export type PrefetchItem =
  | { kind: "file"; absPath: string }              // 单文件，等价于 read 但不返内容
  | { kind: "dir-recursive"; absPath: string }     // 整棵子树（递归 readdir + 每个文件落 cache）
  | { kind: "dir-shallow"; absPath: string };      // 只 readdir + 直接子项 stat（不下钻）

export interface PrefetchResult {
  /** 本次 prefetch 实际触发了多少次穿透 client（已 hot 的不算）*/
  fetched: number;
  /** 已经在 cache 且未过期，仅续期 expiresAt 的项数 */
  alreadyHot: number;
  /** 经穿透发现 missing 的项数（也会写入 missing entry 续期）*/
  missing: number;
  /** 失败项（穿透 client 失败、目录不可读等）— 不阻塞整体，单独报告 */
  failed: Array<{ absPath: string; reason: string }>;
  /** 总耗时 ms */
  durationMs: number;
}

export interface FileAgent {
  /**
   * 读文件内容。命中 → 返回；miss/expired → 阻塞穿透 client → 落 cache → 返回。
   * ttlMs: 这次读完后该 path 的 cache entry 至少保留多久（与已有 expiresAt 取 max）。
   *        必须为有限正数（ttlMs > 0 && Number.isFinite(ttlMs)），否则抛 RangeError。
   * 长度上限：超过 MAX_FILE_BYTES 的文件返回 "skipped"，不缓存内容。
   */
  read(absPath: string, ttlMs: number): Promise<FileAgentReadResult>;

  /** 同 read 但只返元数据；命中/miss 行为与并发去重同 read。 */
  stat(absPath: string, ttlMs: number): Promise<FileAgentStatResult>;

  /** 列目录；命中/miss 行为与并发去重同 read。 */
  readdir(absDir: string, ttlMs: number): Promise<FileAgentReaddirResult>;

  /**
   * 批量预热：把 items 中所有 path 拉进 cache（不返回内容）。
   * 内部 bounded concurrency（默认 16），命中已有 in-flight 的 path 自动去重；
   * 单项失败不阻塞其他。ttlMs 与 read 同语义（必须有限正数）。
   *
   * 适用场景：ConfigPreloader 启动期一次性预热多个目录 + 多个文件，
   * 比上层串行调 read 性能高（共享 in-flight、避免顺序等待）。
   */
  prefetch(items: PrefetchItem[], ttlMs: number): Promise<PrefetchResult>;

  /** 关闭并刷新（关闭 deviceId 对应的所有内部资源）。 */
  close(): Promise<void>;
}
```

### 3.2 TTL 语义 / TTL Semantics

- **TTL 必须为有限正数**：`ttlMs > 0 && Number.isFinite(ttlMs)`，否则 FileAgent 抛 `RangeError`。**不允许永不过期**——即使配置预热也必须设有限 ttl
- 每次 `read/stat/readdir/prefetch` 命中或写入时，更新该 path 的 `expiresAt = max(existingExpiresAt, now + ttlMs)`
  - 用 `max` 而非覆盖，避免短 ttl 调用把长 ttl 已留的 entry 提早干掉
- FileAgent 内部 GC：每 `gcIntervalMs`（默认 60s）扫一次 manifest，`expiresAt < now` → evict
  - evict 删 manifest entry + 调 `gcOrphanBlobs` 回收无引用 blob
  - missing entry 同样按 ttl evict（统一模型）
- 推荐值：startup ttl 4h（配置预热）/ runtime ttl 10min（FUSE op）；上限不强制但 plan 内默认值都是有限的

### 3.3 并发与一致性 / Concurrency & Consistency

详见 §3.4 in-flight 去重设计。

- TTL 过期与正在 in-flight 的 read 不冲突——in-flight 完成后写入的 entry 用本次 ttl
- read/穿透 client 时如果 client 当前 unreachable → 抛 `FileAgentUnavailable`，**不**挂死等待

### 3.4 In-flight 去重设计 / Concurrent Pass-through Dedup

**问题**：同一 path 同时多个 op miss（无 cache）时，如果各自独立穿透 client，会重复发起多次 client 端 stat/read，浪费带宽 + 给 client 添堵。

**机制**：FileAgent 内部维护

```typescript
private readonly inflight = new Map<string, Promise<InflightResolution>>();
// key 形如 "read:/abs/path" / "stat:/abs/path" / "readdir:/abs/dir"
type InflightResolution =
  | { kind: "file"; ... } | { kind: "dir"; ... }
  | { kind: "missing" } | { kind: "skipped"; ... }
  | { kind: "error"; reason: string };
```

任何 op 在判定 cache miss / expired 后、发起穿透前：

1. 计算 inflight key（`${op}:${absPath}`）
2. `if (inflight.has(key)) return await inflight.get(key)` —— 复用别人的穿透
3. 否则新建 promise 放 inflight，发起穿透；finally 删除 key

**测试要求**（Task 4 必覆盖）：
- 同 path 同时 100 次 read miss → mock client 只收到 1 次穿透请求；100 个调用方都拿到同一份内容（buffer ref 可不同但 sha256/content 相同）
- read 与 stat 的 inflight key 不同（同 path read 与 stat 各自独立穿透）—— 这是有意为之，因为 client 端协议上 read 与 stat 是两次操作；后续如果合并可优化
- 一个 inflight 失败（`kind: "error"`）→ 所有等待方都得到同一错误；下一次 read 不复用错误结果，重新发起

### 3.5 拒绝条件 / Hard Errors

- 任何 ttlMs ≤ 0 / Infinity / NaN → `RangeError`
- absPath 不是绝对路径 → `TypeError`
- 调 prefetch 时 items 为空数组 → 返回 `{ fetched: 0, ... }` 不抛错（合法的"什么也不做"）

### 3.6 双路数据流入 / Bidirectional Manifest Updates

```
                               ┌──────────────────────┐
                               │  FileAgent.manifest  │
                               └──────────────────────┘
                                       ▲       ▲
       ┌───────────────────────────────┘       └────────────────────────────┐
       │ 路径 A: 调用方拉取                                                    │ 路径 B: watcher 推送
       │ (read/stat/readdir/prefetch miss)                                    │ (client cache-watcher → cache_task_delta)
       │                                                                      │
       │  调用方 → FileAgent.read("/h/u/.claude/foo")                          │  client 本地 fs.watch 检测到
       │  → cache miss → in-flight 去重                                       │  /h/u/.claude/bar 修改
       │  → sync-coordinator.fetchPath()                                      │  → cache-sync 发 cache_task_delta
       │  → 经 client-protocol-v1 → active client                             │  → server 收到 → sync-coordinator
       │  → client 推单条 entry → server 落 manifest                          │  → apply 到 manifest（更新 sha256）
       │  → 返回调用方                                                        │  → 同时清掉对应 in-flight（如有）
       │                                                                      │
       │  特点：阻塞、按需、低频（仅 miss 时触发）                              │  特点：异步、自动、运行时持续触发
       └──────────────────────────────────────────────────────────────────────┘
```

**两路对 manifest 写入的并发安全**由 `store.withManifestLock(deviceId, fn)` 串行保证（已在保留 commit 70c3ad8 实现）。

**最终一致性窗口**：client watcher debounce 默认 200ms + ws 推送 + server apply ≈ 总 RTT 范围。如果 client 离线则 manifest 进入"stale"状态——下次 client 重连时会触发 SyncPlan 重对账（已有机制）。

---

## 4. ConfigPreloader 接口规约 / Config Preloader

### 4.1 职责

ConfigPreloader 是**所有"配置加载范围决策"的唯一来源**，覆盖三个层面：

1. **预热**（FileAgent 层）：调 `fileAgent.prefetch()` 把 home + cwd + 父链文件拉进 cache
2. **namespace 暴露计划**（最顶层 mount 层）：返回"namespace 内需要 bind-mount 哪些路径"的列表，由 `claude-session-runtime` 转换成 bootstrap shell 脚本的 env var；**`claude-session-runtime` 不再自己算 ancestor chain，只是 ConfigPreloader 的执行者**
3. **同步阻塞 session 启动**：预热未完成前 CC 进程不能 spawn（异步预热毫无意义：CC 启动后立即穿透就违背了预热目的）

运行时不参与（运行时由 CC 通过 FUSE 直接访问 FileAgent）。

### 4.2 接口

```typescript
// server/src/config-preloader.ts
export interface ConfigPreloaderOptions {
  homeDir: string;
  cwd: string;
  fileAgent: FileAgent;
  /** 启动期 ttl，必须为有限正数（推荐 7 天 = 604_800_000 ms）*/
  ttlMs: number;
  /**
   * 整体超时；超时仍允许 session 启动（log warn），但**不**降级为异步——
   * 超时的本质是 client 同步过慢，跟 preheat 模型无关。默认 30s。
   */
  totalTimeoutMs?: number;
}

export class ConfigPreloader {
  constructor(opts: ConfigPreloaderOptions);

  /**
   * 计算访问范围，组装成单个 PrefetchItem[]，调一次 fileAgent.prefetch。
   * 调用方应 await 本方法返回后再启动 CC 进程（同步阻塞）。
   * 范围：
   *   1. homeDir/.claude → kind: "dir-recursive"
   *   2. homeDir/.claude.json → kind: "file"
   *   3. ancestorChain × {CLAUDE.md, CLAUDE.local.md} → kind: "file"（每个一项）
   *
   * 内部不做循环串行，全部交 prefetch 一次完成（性能更优、in-flight 去重）。
   */
  async preheat(): Promise<PrefetchResult>;

  /**
   * 返回 namespace 内需要 bind-mount 的路径计划。由 claude-session-runtime
   * 调用，转换成 bootstrap 脚本的 env var（如 CERELAY_ANCESTOR_DIRS）。
   *
   * **claude-session-runtime 不应自己算 ancestor chain**——它只是 ConfigPreloader
   * 的执行者，所有"决定 namespace 暴露什么"的逻辑都在这里。
   */
  getNamespaceMountPlan(): NamespaceMountPlan;
}

export interface NamespaceMountPlan {
  /** 父链目录（用于 bootstrap 中按级 mount-bind ancestor CLAUDE.md / CLAUDE.local.md）*/
  ancestorDirs: string[];
  /** home 目录路径（已知，但写出来便于 bootstrap 直接拿） */
  homeDir: string;
  /** cwd（同上） */
  cwd: string;
}
```

**TTL 推荐**：`startupTtl = 7 days`（对配置类文件来说一周足够长，watcher delta 会在期间持续追加新变化；evict 主要清理"长期不再被任何 session 访问"的旧 device 数据）。

### 4.3 不在 ConfigPreloader 范围

- 运行时 access tracking（FileAgent 内部 ledger 自动做）
- 写入 / 修改文件（CC 写文件经 FUSE → FileAgent 的 write 路径——本期 FileAgent 不做 write，写直接穿透 client，参考 `file-proxy-manager` 现有 mutation 路径不变）
- 决定 namespace 内挂哪些路径——这是 `claude-session-runtime.ts` bootstrap 的事

---

## 5. FuseHost 与 FileAgent 的关系 / FuseHost Wiring

- `fuse-host-script.ts` 嵌入的 Python daemon **不变**——它仍走 IPC 把 op 发回 server
- server 侧 IPC handler（当前在 `file-proxy-manager.ts` 里）改为：
  - 读 op → `fileAgent.read(absPath, runtimeTtl)`
  - getattr → `fileAgent.stat(absPath, runtimeTtl)`
  - readdir → `fileAgent.readdir(absPath, runtimeTtl)`
  - 写 op（write/unlink/mkdir/rmdir/rename）→ 维持现有"穿透 client + invalidate cache"路径
- 现有 daemon 启动期 snapshot 注入（`snapshot.jsonl` 从 manifest 派生）保留——这是 daemon 内部 cache，新架构定义为"FuseHost 内部优化"，与 FileAgent 是协作关系（FuseHost 启动期请求 FileAgent 给个 snapshot，FileAgent 给一份当前 manifest 派生的 stat 集，FuseHost 注入到 daemon）

---

## 6. 文件结构变化 / File Reorganization

### 6.1 新增文件

```
server/src/file-agent/
├── index.ts                 # FileAgent 类 + 导出
├── types.ts                 # 接口与结果类型（含 PrefetchItem / PrefetchResult）
├── store.ts                 # manifest + blob 物理存储（ClientCacheStore 重组）
├── ledger.ts                # 访问历史 + TTL 表（AccessLedger 重组 + expiresAt 字段）
├── inflight.ts              # 单 path 多并发 op 去重的 in-flight Map（§3.4）
├── sync-coordinator.ts      # 业务逻辑（双路写入 manifest 的中枢）：
│                            #   - active client 选举 / heartbeat
│                            #   - 路径 A: 单 path fetch 调度（响应 read miss）
│                            #   - 路径 B: watcher delta apply（运行时增量，P9/§3.6）
│                            #   - assignment 派发、revision 推进
├── client-protocol-v1.ts    # 协议消息构造/解析（封装 cache_task_* 与 absPath ↔ scope+rel 互转，P7）
├── scope-adapter.ts         # 内部 absPath ↔ scope+rel 双向适配 helper（P8）
├── prefetch.ts              # prefetch 实现：bounded concurrency + dir 递归 walk + 失败收集
└── gc.ts                    # 周期性 TTL evict + orphan blob 清理

server/src/config-preloader.ts  # 新建，配置预热模块
```

**协议封装边界（P7）**：`sync-coordinator.ts` 不直接构造 `CacheTaskAssignment` / `CacheTaskDelta` 等协议消息字面量；它调 `client-protocol-v1.ts` 的 builder 函数（如 `buildSinglePathFetchAssignment(absPath)`）。未来抽独立协议层模块时，sync-coordinator 完全不动，只换 client-protocol-vN 实现。

### 6.2 重组的现有文件

| 现有 | 处置 |
|---|---|
| `client-cache-store.ts` | 内容迁入 `file-agent/store.ts`，原文件删除 |
| `access-ledger.ts` + `access-event-buffer.ts` | 内容迁入 `file-agent/ledger.ts`（+ TTL 字段） |
| `sync-plan.ts` | 内容迁入 `file-agent/sync-coordinator.ts`，**不再**接受 cwd 参数（因为 FileAgent 不知道 cwd） |
| `cache-task-manager.ts` | 内容迁入 `file-agent/sync-coordinator.ts` |
| `file-proxy-manager.ts` | 拆为：FUSE op router（保留在原文件，瘦身）+ FileAgent 调用胶水 |
| `path-utils.ts` | 保持 |
| `seed-whitelist.ts` | 保持（被 FileAgent.preheat 内部使用） |

### 6.3 协议层 / Protocol

- `protocol.ts` 中 cache_task 系列消息类型 **保持现状**（P7：不改 client 协议）
- 删除 V2 plan 加进去的 `cwd-ancestor-md` scope、`exactFilesAbs` 字段、`cache_task_ancestor_delta`（这些在新架构下无用）

---

## 7. 现有 Codex commit 处置 / Disposition of Codex Commits

| Commit | 内容 | 处置 | 理由 |
|---|---|---|---|
| 853b5dd | path-utils（pathStartsWithRoot + computeAncestorChain）| **保留** | ConfigPreloader 用，与新架构契合 |
| 70c3ad8 | ClientCacheStore device-only manifest v3 + 全局 blob 池 | **保留**（迁入 `file-agent/store.ts`） | 这是新架构 FileAgent 内部 store 的基础，重写浪费 |
| e8f4d49 | 协议加 cwd-ancestor-md scope / exactFilesAbs / ancestor_delta | **revert** | 新架构 P7 不要新协议字段 |
| 2fb28c6 | CacheTaskManager device-only + ancestor delta 解耦 | **保留 device 部分 + revert ancestor delta 部分**（cherry-pick 改写）| device key 是新架构需要的；ancestor delta 不要 |
| efd3aba | sync-plan 加 cwd 参数 + 输出 cwd-ancestor-md scope | **revert** | sync-plan 在新架构下不接 cwd（FileAgent 不知道 cwd） |
| 3f733d7 | cache-sync exactFilesAbs + non-active push | **revert** | client 不需要新分支 |
| 2e47e0e | FileProxyManager 注册 ancestor FUSE roots + 全局 manifest 安全过滤 | **保留**（namespace 暴露层，与 cache 重构正交）| 这部分是让 namespace 内能看到 ancestor 文件，跟 FileAgent 抽象无关 |
| c04a43f | bootstrap bind mount ancestor | **保留**（同上） | namespace 暴露层 |
| f203427 | FUSE daemon cwd-ancestor-* 受限 root | **保留**（同上） | namespace 暴露层 |

**净操作**：
- 保留 5 个 commit（853b5dd / 70c3ad8 / 2e47e0e / c04a43f / f203427）
- revert 3 个 commit（e8f4d49 / efd3aba / 3f733d7）
- amend / cherry-pick 1 个 commit（2fb28c6 取 device 部分、丢 ancestor delta 部分）

revert 顺序：3f733d7 → efd3aba → e8f4d49（按时间逆序，避免冲突）。`amend` 2fb28c6 用 `git revert -n 2fb28c6` 反编辑后再选择性保留 device 部分。

---

## 8. 实施 Phase 1 / Tasks

> 严格 TDD：每个 task 先写失败测试 → 实现 → 测试通过 → 单独 commit。每 task ≤ 200 行变更。

### Task 0: 清场（reset + cherry-pick 选择性保留）

> 用户已确认"未推送，可直接重写历史"。采用 `reset --hard` + 选择性 `cherry-pick` 路线，比 revert 更干净。

**保留的 commit（cherry-pick 顺序）**：
- 853b5dd path-utils（pathStartsWithRoot + computeAncestorChain，纯函数独立）
- f203427 FUSE daemon ancestor 受限 root（python 嵌入字符串扩展，独立）
- c04a43f bootstrap bind mount ancestor（shell 脚本扩展，依赖 path-utils）

**丢弃的 commit**（在 reset --hard 中一并清掉，不再 cherry-pick）：
- 70c3ad8 ClientCacheStore device-only —— 新方案 Task 2 时通过 FileAgent 重写更干净
- e8f4d49 协议 cwd-ancestor-md / exactFilesAbs / ancestor_delta —— 新方案不要
- 2fb28c6 CacheTaskManager device-only —— 新方案 Task 5 时通过 sync-coordinator 重写
- efd3aba sync-plan + cwd —— 新方案 Task 5 时重写
- 3f733d7 cache-sync exactFilesAbs —— 新方案不要
- 2e47e0e FileProxyManager ancestor FUSE roots —— 新方案 Task 9 时重写

**步骤**：

- [ ] **Step 0.1**: 删除 stranded untracked 测试文件
  ```bash
  rm client/test/ancestor-claudemd.test.ts
  ```
- [ ] **Step 0.2**: 把当前 plan md 暂存到非追踪位置避免 reset 丢失
  ```bash
  cp docs/superpowers/plans/2026-05-02-file-agent-and-config-preloader.md /tmp/file-agent-plan.md
  ```
- [ ] **Step 0.3**: reset 到 codex 改动前
  ```bash
  git reset --hard 92c0746
  ```
- [ ] **Step 0.4**: 还原 plan md
  ```bash
  mkdir -p docs/superpowers/plans
  cp /tmp/file-agent-plan.md docs/superpowers/plans/2026-05-02-file-agent-and-config-preloader.md
  ```
- [ ] **Step 0.5**: cherry-pick 三个保留 commit，每个用 `-e` 改 message 符合项目规范
  ```bash
  git cherry-pick -e 853b5dd  # → 调整为：✨ 新增 / Add: pathStartsWithRoot + computeAncestorChain 工具 / path utilities
  git cherry-pick -e f203427  # → 调整为：✨ 新增 / Add: FUSE daemon cwd-ancestor-* root 受限 readdir/getattr / restricted ancestor root
  git cherry-pick -e c04a43f  # → 调整为：✨ 新增 / Add: bootstrap 动态 bind mount 祖先 CLAUDE.md / ancestor bind mount
  ```
  cherry-pick 前如有冲突需手动解决（path-utils 是新文件应无冲突；c04a43f 改 claude-session-runtime.ts 可能有微调）
- [ ] **Step 0.6**: commit plan md 文件
  ```bash
  git add docs/superpowers/plans/2026-05-02-file-agent-and-config-preloader.md
  git commit -m "📝 文档 / Docs: FileAgent + ConfigPreloader 重构 plan / refactor plan"
  ```
- [ ] **Step 0.7**: 全量回归
  ```bash
  npm run test:workspaces 2>&1 | tail -20
  ```

期望：测试全绿。git log 显示 92c0746 之后是 3 个 cherry-pick commit + 1 个 plan commit。

### Task 1: 定义 FileAgent 接口 + 空骨架（不连内部组件）

**Files**:
- Create: `server/src/file-agent/types.ts`
- Create: `server/src/file-agent/index.ts`（最小实现：所有方法抛 `not-implemented`）
- Create: `server/test/file-agent.test.ts`（先写接口契约测试）

- [ ] **Step 1.1**: 定义 `types.ts`（按 §3.1）
- [ ] **Step 1.2**: `file-agent/index.ts` 类骨架，方法抛 `Error("not implemented")`
- [ ] **Step 1.3**: 测试文件断言接口存在（可 instantiate、方法签名正确）
- [ ] **Step 1.4**: Commit

```
✨ 新增 / Add: FileAgent 接口骨架 / interface skeleton
```

### Task 2: FileAgent 内部 store 接入（manifest + blob，包装现有 client-cache-store）

**Files**:
- Move: `server/src/client-cache-store.ts` → `server/src/file-agent/store.ts`（保留所有 device-only 实现）
- Modify: `server/src/file-agent/index.ts`（持有 store 实例）
- Modify: 所有 import 路径

- [ ] **Step 2.1**: `git mv` 文件，更新 imports（让既有测试继续跑）
- [ ] **Step 2.2**: FileAgent 构造函数接受 `{ deviceId, store }`，read/stat/readdir 内部调 store 查 manifest（命中即返回；miss 仍抛 not-implemented，下个 task 接 sync）
- [ ] **Step 2.3**: 单元测试：先在 store 写 entry，FileAgent.read 命中 → 返回正确 buffer
- [ ] **Step 2.4**: Commit

```
🚀 重构 / Refactor: client-cache-store 迁入 file-agent/store + FileAgent 接 store 命中路径 / move + wire
```

### Task 3: FileAgent 内部 ledger + TTL 表

**Files**:
- Move: `access-ledger.ts` + `access-event-buffer.ts` → `file-agent/ledger.ts`
- Add field: `expiresAt: number` 到 LedgerEntry
- Modify: `file-agent/index.ts`（read/stat/readdir 命中时更新 ledger.expiresAt）

- [ ] **Step 3.1**: 测试：read 后 ledger 该 path 的 expiresAt = max(existing, now+ttl)
- [ ] **Step 3.2**: 测试：多次 read 不同 ttl，expiresAt 取 max
- [ ] **Step 3.3**: 实现
- [ ] **Step 3.4**: Commit

```
✨ 新增 / Add: FileAgent ledger 内化 + TTL 字段 / inline ledger + TTL field
```

### Task 4: FileAgent in-flight 去重 + ttl 输入校验

**Files**:
- Create: `server/src/file-agent/inflight.ts`
- Modify: `server/src/file-agent/index.ts`（read/stat/readdir 接 inflight Map + ttl 校验）

> 这一步在 sync-coordinator 之前。先把"miss 路径走 mock 穿透"用一个简单 stub，重点验证 in-flight 去重 + ttl 拒绝。

- [ ] **Step 4.1**: 测试：ttlMs ≤ 0 / Infinity / NaN → RangeError
- [ ] **Step 4.2**: 测试：absPath 非绝对路径 → TypeError
- [ ] **Step 4.3**: 测试：同 path 同时 100 次 read miss（用 stub passthrough，记调用计数）→ stub 实际只被调用 1 次；100 个调用方都 resolve 同一份内容
- [ ] **Step 4.4**: 测试：同 path 同时 read + stat → 两条 inflight 路径独立（key 不同），各自 1 次穿透
- [ ] **Step 4.5**: 测试：inflight 失败 → 所有等待方收到同一错误；下一次重试不复用错误
- [ ] **Step 4.6**: 实现 inflight.ts + 接入 index.ts
- [ ] **Step 4.7**: Commit

```
✨ 新增 / Add: FileAgent in-flight 去重 + ttl 输入校验 / inflight dedup + ttl validation
```

### Task 5: client-protocol-v1 + sync-coordinator（双路写入：fetch + watcher delta）

**Files**:
- Move: `cache-task-manager.ts` → `file-agent/sync-coordinator.ts`（业务逻辑，含原有 watcher delta apply 路径）
- Move: `sync-plan.ts` → `file-agent/sync-coordinator.ts` 私有 helper（不再公开）
- Create: `server/src/file-agent/client-protocol-v1.ts`（协议消息 builder + scope adapter 调用）
- Create: `server/src/file-agent/scope-adapter.ts`
- Modify: FileAgent miss 时调 `syncCoordinator.fetchPath(absPath)`

> **协议路线**：本期采用方案 A——server 把单 path 包成一个微型 SyncPlan 通过 `cache_task_assignment` 派发给 active client，client 推完 ack revision。**不**新增协议消息字段（P8）。封装在 `client-protocol-v1.ts` 的 `buildSinglePathFetchAssignment(absPath)`，未来要换方案 B 只需替换该 builder。

> **路径 B（watcher delta）**：原 `cache-task-manager.ts` 已有的 `handleDelta(deviceId, changes)` 路径整体保留并迁入 `sync-coordinator.applyWatcherDelta()`。这条路径是运行时 client 主动推送，sync-coordinator 收到后调 store apply 到 manifest，同时清掉受影响 path 的 in-flight（避免别人复用过期穿透结果）。

- [ ] **Step 5.1**: 测试：scope-adapter 把 `~/.claude/foo` ↔ `{ scope: "claude-home", rel: "foo" }` 双向转换；ancestor 文件 `~/work/proj/CLAUDE.md` 也能 round-trip（采用约定的"虚拟 scope"或退化到 claude-home 处理 — 详见 §6.3）
- [ ] **Step 5.2**: 测试：路径 A——FileAgent.read 一个 manifest 没有的 path → mock active client 收到 fetch assignment → mock 推内容 → FileAgent.read 阻塞解开返回 buffer
- [ ] **Step 5.3**: 测试：路径 A——active client 不可达 → FileAgent.read 抛 `FileAgentUnavailable`
- [ ] **Step 5.4**: 测试：路径 B——sync-coordinator.applyWatcherDelta(changes) → manifest 更新 → 之后 FileAgent.read 命中新内容（watcher 增量回归）
- [ ] **Step 5.5**: 测试：路径 B 在 in-flight 期间到达——若有 path X 正在 in-flight read，watcher delta 推送 X 的新内容，新 read 能读到新内容（in-flight 完成后下一次 read 用 manifest 最新值）
- [ ] **Step 5.6**: 测试：sync-coordinator 不直接构造协议消息字面量（grep 该文件不应有 `type: "cache_task_assignment"` 等字面量；都来自 client-protocol-v1 builder）
- [ ] **Step 5.7**: 实现
- [ ] **Step 5.8**: Commit

```
✨ 新增 / Add: FileAgent 双路写入 (fetch + watcher delta) + client-protocol-v1 隔离 / dual-path manifest writes
```

### Task 6: FileAgent.prefetch 批量预热

**Files**:
- Create: `server/src/file-agent/prefetch.ts`
- Modify: `server/src/file-agent/index.ts`

- [ ] **Step 6.1**: 测试：prefetch([] , ttl) → 立即返回 `{ fetched:0, alreadyHot:0, missing:0, failed:[], durationMs:>=0 }`
- [ ] **Step 6.2**: 测试：单 file item，path 已在 cache → `alreadyHot=1`，expiresAt 续期
- [ ] **Step 6.3**: 测试：单 file item，path 不在 cache → 触发穿透，落 cache，`fetched=1`
- [ ] **Step 6.4**: 测试：dir-recursive item → 内部递归 readdir + 对每个文件 read（用 mock client 拼一棵树）
- [ ] **Step 6.5**: 测试：dir-shallow item → readdir + 直接子项 stat（不下钻）
- [ ] **Step 6.6**: 测试：bounded concurrency（默认 16）：构造 100 个 file item，监控同时 in-flight 数 ≤ 16
- [ ] **Step 6.7**: 测试：单项失败（mock client 给特定 path 返错）→ 失败收进 `failed[]`，其他项继续完成
- [ ] **Step 6.8**: 测试：与并发 read 共享 in-flight：prefetch 进行中其他人 read 同 path，不重复穿透
- [ ] **Step 6.9**: 实现
- [ ] **Step 6.10**: Commit

```
✨ 新增 / Add: FileAgent.prefetch 批量预热（bounded concurrency + dir walk + 失败收集）
```

### Task 7: TTL evict / GC 周期任务

**Files**:
- Create: `server/src/file-agent/gc.ts`
- Modify: `file-agent/index.ts`（启动 gc 定时器）

- [ ] **Step 7.1**: 测试：构造一个 expiresAt < now 的 entry，调 gc → entry 被删，blob 也被回收
- [ ] **Step 7.2**: 测试：gc 不删 expiresAt > now 的 entry
- [ ] **Step 7.3**: 测试：gc 周期性触发（fake timer）
- [ ] **Step 7.4**: 测试：gc evict 时跳过有 in-flight 的 path（避免 entry 被删但请求方拿不到）
- [ ] **Step 7.5**: 实现（默认 60s 周期，可配置）
- [ ] **Step 7.6**: Commit

```
✨ 新增 / Add: FileAgent TTL evict + 周期 GC（in-flight 安全）/ TTL evict + periodic GC
```

### Task 8: ConfigPreloader 模块

**Files**:
- Create: `server/src/config-preloader.ts`
- Create: `server/test/config-preloader.test.ts`

- [ ] **Step 8.1**: 测试：`preheat` 调 FileAgent.prefetch **一次**，items 含 home/.claude (dir-recursive) + .claude.json (file) + ancestor chain CLAUDE.md/CLAUDE.local.md (file)
- [ ] **Step 8.2**: 测试：cwd === homeDir 时 ancestor 部分为空，prefetch items 仅含 home 两项
- [ ] **Step 8.3**: 测试：preheat 不接受 ttlMs ≤ 0 / Infinity（同 FileAgent 校验）
- [ ] **Step 8.4**: 测试：preheat 透传 prefetch 的 PrefetchResult 给调用方（不是各文件返回内容）
- [ ] **Step 8.5**: 实现
- [ ] **Step 8.6**: Commit

```
✨ 新增 / Add: ConfigPreloader 启动期文件预热模块（一次 prefetch 调用）/ startup preheat module
```

### Task 9: FuseHost 接 FileAgent（重构 file-proxy-manager 的 IPC 处理）

**Files**:
- Modify: `server/src/file-proxy-manager.ts`（瘦身：只剩 FUSE IPC router + 写穿透）

- [ ] **Step 7.1**: 测试：daemon IPC 收到 `read` op → FileProxyManager 调 `FileAgent.read(absPath, runtimeTtl)` → 返回 buffer
- [ ] **Step 7.2**: 测试：daemon IPC 收到 `getattr` → 调 `FileAgent.stat`
- [ ] **Step 7.3**: 测试：daemon IPC 收到 `readdir` → 调 `FileAgent.readdir`
- [ ] **Step 7.4**: 测试：现有写路径（write/unlink/mkdir/rename）行为**不变**
- [ ] **Step 7.5**: 实现重构
- [ ] **Step 7.6**: Commit

```
🚀 重构 / Refactor: FuseHost IPC handler 改走 FileAgent 接口 / wire FUSE through FileAgent
```

### Task 10: claude-session-runtime 接入 ConfigPreloader

**Files**:
- Modify: `server/src/claude-session-runtime.ts` 或对应 session 启动入口

- [ ] **Step 10.1**: 测试：session 启动时，ConfigPreloader.preheat 被调用，参数含 homeDir/cwd
- [ ] **Step 10.2**: 测试：preheat 失败不阻塞 session 启动（log warn）
- [ ] **Step 10.3**: 实现
- [ ] **Step 10.4**: Commit

```
🌱 集成 / Integration: session 启动时调 ConfigPreloader 预热 / wire preloader into session boot
```

### Task 11: 删除遗留模块的对外暴露 + import 清理

**Files**:
- Verify: `client-cache-store.ts` / `access-ledger.ts` / `cache-task-manager.ts` / `sync-plan.ts` 已经 move 完毕，原路径无残留
- 确认 `server/src/index.ts` 与 `server/src/server.ts` 不再直接 import 这些模块（只通过 FileAgent）

- [ ] **Step 11.1**: grep 确认无遗留 import
- [ ] **Step 11.2**: 整体 typecheck + 测试
- [ ] **Step 11.3**: Commit

```
🔧 修复 / Fix: 清理 file-agent 拆分后的遗留 import / cleanup leftover imports
```

### Task 12: E2E + 文档更新

**Files**:
- Create: `server/test/e2e-file-agent.test.ts`
- Modify: `CLAUDE.md` / `docs/architecture.md`
- Modify: `docs/superpowers/specs/2026-05-01-access-ledger-driven-cache-design.md`（新增章节描述新架构）

E2E 覆盖：
1. 启动期 ConfigPreloader 调一次 prefetch 预热 home + cwd 父链 CLAUDE.md，全部进 manifest
2. 运行时 FUSE read 命中 cache，无穿透 client
3. 运行时 FUSE read miss → 阻塞穿透 → 落 cache
4. TTL 过期后再 read 重新穿透
5. 同 device 两个 cwd 的 session 顺序启动，第二次启动 home 直接命中（无重传）
6. 同 path 100 个并发 read miss → 实际 1 次穿透
7. **最终一致性**：client 端模拟修改一个 path（触发 watcher delta）→ FileAgent 在 < 1s 内反映新内容（验证 P10）

文档：
- `CLAUDE.md` "Client 文件缓存"小节改写：FileAgent 底座 + ConfigPreloader 启动期 + FUSE 运行时
- `docs/architecture.md` 加架构图（采用本 plan §1.1）
- spec §11.2 / §11.3 标 Implemented，链回本 plan
- **本 plan 自身按最新 CLAUDE.md 规范整理**：移除 "Status: Draft"，改为 "Status: Implemented (2026-MM-DD via commits XXX..YYY)"；如果 commit message / 文档结构在开发过程中有调整，同步更新 plan 内描述使其与最终落地一致；按 doc-conventions（中英双语 + Markdown 标准）做最后一次格式核查

- [ ] **Step 10.1**: E2E 测试
- [ ] **Step 12.1**: E2E 测试
- [ ] **Step 12.2**: 文档
- [ ] **Step 12.3**: 全量回归 `npm run test:workspaces && npm run test:smoke`
- [ ] **Step 12.4**: Commit（一个 commit 含 E2E + 文档）

```
✅ 测试 / Tests + 📝 文档 / Docs: FileAgent + ConfigPreloader E2E + 架构文档更新 / e2e + arch docs
```

---

## 9. 不在本期范围 / Out of Scope

| 项 | 备注 |
|---|---|
| FileAgent 内部 in-memory state cache（manifest LRU 等）| "缓存系统内部的优化"——后续单独立 plan，看实测 P50/P99 再决定 |
| Client 协议去 scope 化（`cache_task_*` 全用绝对路径）| 本期 scope-adapter 在 FileAgent 内部双向转换，对上层隐藏 |
| 抽出独立"协议层模块"（client 交互拆为单独包/进程） | 本期通过 P7（client-protocol-v1.ts 与业务逻辑分离）为后续抽离铺路；不真正拆 |
| 跨 host 同 deviceId manifest 复用 | 涉及 host fingerprint，单独 spec |
| FileAgent 写操作（write/unlink/mkdir 接口）| 本期写仍由 file-proxy-manager 走原穿透路径；写后调 FileAgent.invalidate(path) 即可 |
| daemon snapshot 注入逻辑改造 | 暂保留现状（FuseHost 启动期向 FileAgent 取 snapshot dump）；新架构不阻碍后续优化 |

### 9.1 wiring 闭环 / Wiring Closure（Codex review 反馈 + 后续 follow-up 一并完成）

> **Status: 三处全部接通（commits bbeb651 + 46ff2e0 + wiring-integration.test.ts，2026-05-02）**

| # | 接通方式 | 生产路径 |
|---|---|---|
| **#1 FileAgent fetcher 接通** | `CacheTaskClientDispatcher`（`file-agent/cache-task-dispatcher.ts`）实现 `ClientFetchDispatcher` 接口；`server.ts: getOrCreateFileAgent` 装配 ScopeAdapter + InflightMap + Dispatcher → SyncCoordinator → FileAgent。当前 dispatcher 实现策略是"被动 lookup"：查 store manifest（active client 之前推过的能命中），miss 返 null。**未来扩展**（仍属 plan §9 Out of Scope）：dispatchSinglePathFetch 替换为派发单 path SyncPlan 主动 fetch。 | FileAgent.read miss → SyncCoordinator.fetchFile → dispatcher.dispatchSinglePathFetch → 命中返 change / miss 返 null（不抛 unavailable） |
| **#2 FUSE IPC 命中通知 FileAgent** | `FileAgent.bumpTtlForExternalHit(absPath, ttlMs)` 公开方法（非法 ttlMs / 不在 scope 内静默忽略）。`file-proxy-manager.ts: tryServeReadFromCache` 命中分支调 `fileAgent?.bumpTtlForExternalHit(handPath, 10*60*1000)`。**保守策略**：不强制让 FUSE IPC 完全替换为 `FileAgent.read`（避免与 redaction / mutation hint / pendingReadBypass 等多分支耦合）；改为命中后通知 FileAgent，让 GC 不会清掉正在被 FUSE 读的 path。 | FUSE → file-proxy-manager.tryServeReadFromCache 命中 → fileAgent.bumpTtlForExternalHit → TTL 续期 → FileAgent.runGcOnce 不 evict |
| **#3 watcher delta 接 FileAgent** | `cache-task-manager.ts: CacheTaskManagerOptions` 增加 `onDeltaApplied` 回调；applyDelta 应用到 store 后调它（错误不影响 ack）。`server.ts` 注册回调：找对应 deviceId 的 FileAgent → `notifyWatcherDeltaApplied(changes)` → 续期 TTL + inflight telemetry。FileAgent **不重复 apply**（store 已写入）。 | client watcher → cache_task_delta → cache-task-manager.applyDelta → store.applyDelta → onDeltaApplied → FileAgent.notifyWatcherDeltaApplied → TTL 续期 |

**测试覆盖**：`server/test/wiring-integration.test.ts` 共 10 个 case 覆盖三处接通的端到端契约。

**累计代码统计**：
- 新增模块：`file-agent/` 9 个文件 + `config-preloader.ts` + `cache-task-dispatcher.ts`
- 新增测试：8 个 `file-agent-*.test.ts` + `config-preloader.test.ts` + `wiring-integration.test.ts` + `e2e-file-agent.test.ts`
- 修改既有：`cache-task-manager.ts` / `file-proxy-manager.ts` / `server.ts` / 相关测试
- 总测试通过：server 411 / client 135 / web 6 / smoke 23（典型场景）

---

## 10. 风险与开放问题 / Risks & Open Questions

### 10.1 已识别风险

| 风险 | 缓解 |
|---|---|
| FileAgent miss 用现有 cache_task assignment 协议较重（Task 5 选项 A）| 协议封装在 client-protocol-v1.ts，未来切到选项 B 不动业务层 |
| TTL evict 与 in-flight read 竞态 | gc.ts 设计：evict 前查 in-flight Map，跳过有 in-flight 的 path（Task 7.4 测试覆盖） |
| 同 device 多 cwd 并发 session 谁是 active client | sync-coordinator 内部维持现有 active 选举（device-only key）；ancestor 文件无需特殊处理（任何 active 都能为任意 cwd 路径穿透 client，因为 client 是真实文件系统的 owner）|
| ConfigPreloader 预热时间太长拖慢 session 启动 | preheat 异步、超时（默认 5s）；超时也允许 session 启动，运行时 miss 再补 |
| prefetch dir-recursive 遇到无界深度 | 设默认 maxDepth（如 8）+ 总文件数上限（如 10000），超限报告到 PrefetchResult.failed |

### 10.2 已确定的决策（用户拍板 2026-05-02）

| 决策 | 结论 |
|---|---|
| ConfigPreloader 同步还是异步 | **同步阻塞** session 启动；异步会让 CC 启动后立即穿透，违背预热目的；超时（默认 30s）仅用于异常 fallback，正常流程必须等完 |
| TTL 推荐值 | **startupTtl = 7 days**（604_800_000 ms）；runtimeTtl 跟随相同，运行期文件 watcher delta 持续刷新足够 |
| prefetch dir-recursive 默认 maxDepth | **8** 层（ConfigPreloader 实测 home/.claude 子树深度远低于 8） |
| watcher 增量同步合并入 FileAgent | **是**；现有 `cache-watcher.ts`（client）+ `cache-sync.ts`（client delta sender）+ `cache-task-manager.ts`（server delta apply）链路整体并入 `file-agent/sync-coordinator.ts`；FileAgent 是「拉取 + 推送」一体化（P9 / P10 / §3.6） |

---

## 11. 实施纪律 / Execution Discipline

- **执行人**：Claude（不再交 Codex）
- **TDD 强制**：每 task 先红再绿；每 step 跑相应测试；FAIL 不进 commit
- **commit 粒度**：每个 task 一个 commit（plan 内已给 commit message）
- **断点续传**：用 TodoWrite 跟踪每 task 进度；中断恢复从未完成 task 继续
- **遇到模糊点**：暂停，写到 `.claude/file-agent-decisions.md` 等用户确认（不要猜）
- **回归红线**：`npm run test:workspaces && npm run test:smoke` 必须始终绿（每 task 后跑）
- **协议封装规范**：grep `sync-coordinator.ts` 不应出现协议消息字面量（type 字符串 / scope 字符串）；所有协议构造经 `client-protocol-v1.ts`
