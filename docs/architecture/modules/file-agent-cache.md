<!-- doc-init template version: v1.0 -->
# FileAgent 底座 + ConfigPreloader + FUSE Cache

> **Owner**: server 架构组
> **Reviewers**: 全员（涉及缓存一致性与启动期阻塞）

**文件**：`server/src/file-agent/`（FileAgent 底座 + ConfigPreloader 上层）, `client/src/cache-sync.ts`, `client/src/device-id.ts`

> **架构（2026-05-02 起 device-only）**：缓存维度从 `(deviceId, cwd)` 收敛到 `deviceId`。FileAgent（`server/src/file-agent/index.ts`）作为 per-device 单例底座，对外暴露 `read / stat / readdir / prefetch + ttlMs` 四个接口；ConfigPreloader（`server/src/config-preloader.ts`）作为启动期预热模块，FUSE Host（`server/src/file-proxy-manager.ts`）共享 store 命中。详见 plan [`../../archive/2026-05-02-file-agent-and-config-preloader/plan.md`](../../archive/2026-05-02-file-agent-and-config-preloader/plan.md)。

## 1. 架构图

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

## 2. 核心模块

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

## 3. ConfigPreloader

**文件**：`server/src/config-preloader.ts`

- 同步阻塞 session 启动（异步预热毫无意义；超时仅异常 fallback）
- 一次 `fileAgent.prefetch` 拉所有 PrefetchItem：
  - `homeDir/.claude` (dir-recursive)
  - `homeDir/.claude.json` (file)
  - ancestor chain × {CLAUDE.md, CLAUDE.local.md} (file)
- 同时提供 `getNamespaceMountPlan()` 给 `claude-session-runtime`，决定 bootstrap mount 哪些 ancestor

## 4. 关键不变量

- 目标：降低 Client 每次连接的启动开销 + 让同一 device 跨 cwd 共享 manifest 与 blob 池
- 存储：`${CERELAY_DATA_DIR}/client-cache/<deviceId>/`（device-only，**不再有 cwdHash 子目录**）
  - `manifest.json`：v3 schema，按 scope（`claude-home` / `claude-json`）记录 `path → {size, mtime, sha256, skipped, expiresAt?}`
  - `blobs/<sha256>`：device 全局 blob 池，跨 cwd 内容寻址 dedup
- `deviceId`：Client 首次启动生成 UUIDv4，持久化到 `~/.config/cerelay/device-id`；Server 侧按 deviceId 隔离缓存（同设备多 cwd 共享 manifest，**跨 cwd 数据不重复**）
- **隐私 call out**：device 全局 manifest 持久化所有访问过的 path（含 home 路径名），文件位置 `${CERELAY_DATA_DIR}/client-cache/<deviceId>/manifest.json`，不可逆；运维清理时整 device 目录删除即可
- **TTL 与 GC**：每次 `read / stat / readdir / prefetch` 命中或写入更新 `expiresAt = max(existing, now + ttlMs)`；FileAgent 周期 GC（默认 60s）清过期 entry + orphan blob；in-flight 期间跳过 evict 给缓刑
- **TTL 必须有限正数**：`ttlMs ≤ 0 / Infinity / NaN` → RangeError；推荐 startupTtl=7d (`ConfigPreloader`) / runtimeTtl=10min (`FUSE host`)
- 缓存维度 = deviceId（不再含 cwd）；同 device 多 cwd 共享 manifest
- 跨 cwd blob 内容寻址 dedup（同 sha256 只存一份）
- 协议字段不新增（保现有 `cache_task_*` v1 协议；scope 适配在 FileAgent 内部）
- 双路写入 manifest（read miss 拉取 + watcher delta 推送）→ 最终一致性窗口 < 1s
- `file-proxy-manager` 与 FileAgent 共享同一 `ClientCacheStore`，命中事实上等价
- 协议（见 `server/src/protocol.ts` 的 CacheTask* 类型；保持 v1 协议字段不变，scope 适配在 `file-agent/scope-adapter.ts` 内部完成）：
  1. Client → Server：`client_hello` 上报 `deviceId/cwd/capabilities`
  2. Server → Client：`cache_task_assignment` 指派 active/inactive 角色并携带 manifest 快照
  3. Active Client：发送 `cache_task_delta`，initial 完成后发 `cache_task_sync_complete`
  4. Server → Client：用 `cache_task_delta_ack` / `cache_task_mutation_hint` 协调 revision 与读穿透
- 大小限制：
  - 单文件 > 1MB（`MAX_FILE_BYTES`）：标记 `skipped`，仅同步元数据
  - 单 scope 累计 > 100MB（`MAX_SCOPE_BYTES`）：按 mtime 倒序截断，后面的文件完全丢弃，manifest 记录 `truncated: true` 用于诊断
- 失败策略：缓存同步失败不阻塞 PTY session 启动——降级为"无 Server 缓存"，FUSE 读请求仍可穿透回 Client
- Integration 测试通过 `CERELAY_DISABLE_INITIAL_CACHE_SYNC=true` 跳过该流程，避免 mock server 需要模拟该协议

## 5. 扫描范围（include_dirs 白名单 + exclude_dirs 黑名单）

**文件**：`client/src/config.ts`

> **2026-05-05 起语义反转**：默认配置由"列黑名单跳过若干目录"改为"列白名单只同步若干目录"。两个字段并存：先按 `include_dirs` 通过，再按 `exclude_dirs` 剪枝。

- `include_dirs` 默认列表：CC 启动期会 readdir/getattr 的顶级目录与单文件——`plugins`、`projects`、`sessions`、`backups`、`skills`、`commands`、`agents`、`shell-snapshots`、`session-env`、`file-history`、`paste-cache`、`cache`、`tasks`、`todos`、`telemetry`、`statsig`、`ide`、`settings.json`、`settings.local.json`、`CLAUDE.md`、`CLAUDE.local.md`、`.credentials.json`、`history.jsonl`。**该列表来自一次真实 CC 容器 capture（`CERELAY_CAPTURE_SEED` 模式）的访问名单**，避免凭印象 hand-curate；capture 数据归档于 `.claude/seed-capture-2026-05-05.json`
- `exclude_dirs` 默认空数组——黑名单语义保留，留给用户在 include 范围内补充剪枝（例如 `plugins/cache/old-stuff`）
- **空 include_dirs = 放行所有**：旧 toml（升级前没有 `include_dirs` 字段的 client）解析时 `includeDirs=[]`，过滤器视为不限制范围 → 行为与 v1 完全等价。新装/重置 toml 时才走默认白名单
- 过滤实现（`createScanFilter`）：dir/file 同一套规则——relPath 在某个 include prefix 之下、或者是某个 include prefix 的祖先（保证 walkDir 递归得进 include 子树），并且不在任何 exclude 子树之下，才被收录
- **决策依据**：F4 P2 之后排查启动期 readdir 穿透时发现，黑名单默认跳过 `projects/sessions/backups/tasks` 导致 daemon snapshot 缺这些 dir 的 readdir entry，CC 启动期一律穿透 client。反转为白名单后这些目录默认进 cache，启动期 readdir 由 `buildSnapshotFromManifest` 反推的 dir entry 直接命中 daemon perm cache

## 6. 启动期同步进度 UI 与 pipeline

**文件**：`client/src/cache-sync.ts` + `client/src/ui.ts` + `server/src/client-cache-store.ts`

- **Pipeline 发送**：每个有 content 的文件单独发一个 `cache_task_delta` change，发完不等 ack 立刻发下一个 batch；ack 通过 `batchId + appliedRevision` 异步匹配 in-flight 队列
- **流控水位**：`MAX_INFLIGHT_BYTES = 16 MB`。当 in-flight 字节累计超过该阈值时暂停 send，等任意 ack 释放配额后继续。本地/局域网下基本不触发，远程 RTT 200ms × 80MB/s ≈ 16MB 是流水线满载所需深度
- **协议批次标识**：`CacheTaskDelta.batchId` 必填；server 用 `cache_task_delta_ack` 回传 `appliedRevision`，pipeline 模式下靠 `batchId` 区分 in-flight 批次
- **Server 端 manifest 串行锁**（`file-agent/store.ts: withManifestLock`）：按 `deviceId` 维护 promise 链 mutex（device-only 化后同 device 任意 cwd 写入均互相串行；不同 device 仍并发），串行化 `applyDelta` / `upsertEntry` / `removeEntry` 的 read-modify-write。**这是 pipeline 的硬性前提**：server 的 message handler 是并发的（`server.ts` 用 `void this.handleMessage()`），无锁状态下 manifest 写入会丢更新
- **元数据批**（deletes + skipped）：每 scope 第一发，等 ack 后再开始 pipeline。这部分占用 in-flight 但 size 记 0，不消耗流控配额
- **进度展示**（双行）：
  - line1 = 跨 scope 合并总进度（spinner + 进度条 + 百分比 + 已 ack 文件/字节），按 ack 字节**精确计算**
  - line2 = `→ 当前 ack 等待: <最早未 ack 的文件>  (in-flight K 文件 / X MB)`，无文件级进度条
- **没有单文件进度条**：pipeline 后多个文件的字节同时滞留 OS 发送缓冲，`ws.bufferedAmount` 反映的是 in-flight 集合的总残留，无法分离到单个文件，所以放弃单文件进度（之前的 `bufferedBaseline` 字段也已删除）
- 事件序列（`CacheSyncEvent`）：`skipped` | `scan_start` → `scan_done` → `upload_start` → 多对 `file_pushed` / `file_acked`（可乱序交叠）→ `upload_done`
- 渲染节拍固定 100ms（10Hz）；事件只更新内部状态，不直接写 stdout
- 仅 TTY 场景启用（`process.stdout.isTTY === true`）；非 TTY / CI 走纯 log，不输出 ANSI 控制序列

## 7. FUSE 读路径与 cache 协同

**文件**：`server/src/file-proxy-manager.ts` + `server/src/file-agent/`

- `create_pty_session` 会把 Client 的 `deviceId` 带给 Server；server 通过 `getOrCreateFileAgent(deviceId, homeDir)` 拿到 per-device FileAgent 单例（plan §2 P6），传给 `FileProxyManager`；同时实例化 per-session `ConfigPreloader` 调 `preheat()`（同步阻塞，超时 10s）
- 启动期 `ConfigPreloader.preheat`：拼装 PrefetchItem[]（home/.claude dir-recursive + .claude.json file + ancestor × {CLAUDE.md, CLAUDE.local.md} files）→ 一次 `fileAgent.prefetch`，命中已有 cache 的 alreadyHot，未命中且 fetcher 配置时穿透 client
- 启动时 `collectAndWriteSnapshot` 对 `home-claude` / `home-claude-json` **优先从 cache 构造 snapshot**（`buildSnapshotFromManifest`），不再向 Client 发全量 snapshot 请求；`project-claude` 因为不在 cache 覆盖范围仍然穿透 Client
- 运行时 `handleFuseLine` 的 `read` op 先调用 `tryServeReadFromCache`：命中 blob 直接写回 FUSE daemon；miss 或 skipped 文件 fallback 到原穿透路径。**FileAgent 与 FileProxyManager 共享 store**——FileAgent.read 命中事实上等价于 FileProxyManager 命中
- cache 未启用（Client 未上报 deviceId / 未提供 cacheStore）时退化为纯穿透模式，行为与未接入 cache 时完全一致
- **双路写入 manifest**（plan §3.6）：路径 A（`SyncCoordinator.fetchFile`，被 FileAgent miss 时调，通过 `ClientFetchDispatcher` 派发单 path SyncPlan + 等 client 推 delta）+ 路径 B（`SyncCoordinator.applyWatcherDelta`，client 主动 push 的运行时增量）。两路共用 manifest，最终一致性窗口典型 < 1s
- cache 新鲜度：watcher delta 持续修正运行期内容；启动期 ConfigPreloader 预热 + ttl=7d 让长期留存的配置一直 warm

## 关联资源

- [Living spec: client-config-sync](../../specs/client-config-sync/spec.md)
- [Plan: file-agent-and-config-preloader](../../archive/2026-05-02-file-agent-and-config-preloader/plan.md)
- [Spec: access-ledger-driven-cache-design](../../archive/2026-05-01-access-ledger-driven-cache/design.md)
- [启动期进度 UI（Phase 抽象）](./startup-progress-ui.md)
- [架构总览](../README.md)
- [Session Runtime](./session-runtime.md)
