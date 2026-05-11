<!-- doc-init template version: v1.0 -->
# Capability: client-config-sync

> **Owner**: server 架构组
> **Reviewers**: 全员（修改 living spec 必须经 change archive 阶段）

> 位置：`docs/specs/client-config-sync/spec.md`
> 角色：本 capability 的 **living spec**（source of truth）。**只在归档阶段被修改**。
> 历史变更可在 [`../../archive/`](../../archive/) 中追溯。
>
> **Baseline 反向生成**于 2026-05-05，代码版本 `54f69d3`，由 change `baseline-shadow-mcp-clientcache` 产生（已归档于 [`../../archive/2026-05-05-baseline-shadow-mcp-clientcache/`](../../archive/2026-05-05-baseline-shadow-mcp-clientcache/)）。

## 概述

把 Client 本机的三个 Claude 配置 scope（`~/.claude/`、`~/.claude.json`、`{cwd}/.claude/`）以 device-only 维度同步到 Server，让 FUSE Host 读路径与 ConfigPreloader 启动期预热共享同一份 store；目的是降低启动期开销、跨 cwd 共享 manifest 与 blob 池，并保留缓存失败时的穿透降级路径。

**架构两层**（plan `docs/archive/2026-05-02-file-agent-and-config-preloader/plan.md`）：

- **底座 FileAgent**（per-device 单例）：对外暴露 `read / stat / readdir / prefetch + ttlMs` 四接口；持有 store + TTL 表 + GC 周期。
- **上层 ConfigPreloader**（per-session）：启动期一次性 prefetch home/.claude（dir-recursive）+ home/.claude.json + ancestor × {CLAUDE.md, CLAUDE.local.md}。

**对外暴露**：

- 协议消息：`client_hello` / `cache_task_assignment` / `cache_task_delta` / `cache_task_delta_ack` / `cache_task_mutation_hint` / `cache_task_sync_complete`（v1 协议字段）
- 存储位置：`${CERELAY_DATA_DIR}/client-cache/<deviceId>/{manifest.json, blobs/<sha256>}`
- Client 端 `deviceId`：`~/.config/cerelay/device-id`（首次启动 UUIDv4 持久化）
- 进度事件：`scan_start` / `scan_done` / `upload_start` / `upload_done` / `file_pushed` / `file_acked` / `skipped`

**内部依赖的其他 capability**：

- `file-proxy-fuse`（待 baseline 反向生成）：FUSE Host 在 read 路径上调用 `tryServeReadFromCache`，命中复用 cache，miss 穿透回 client。
- `pty-session`（待 baseline 反向生成）：`create_pty_session` 把 deviceId 上报；server 通过 `getOrCreateFileAgent(deviceId, homeDir)` 拿到 per-device FileAgent 单例。

## Requirements

### Requirement: Device-only 缓存维度

The system MUST 以 `deviceId` 为 cache 粒度——同 device 跨 cwd 共享 manifest 与 blob 池，**不再有 cwdHash 子目录**；不同 device 的 manifest 互相隔离。

#### Scenario: 同 device 跨 cwd 共享 manifest

- **GIVEN** 同一 deviceId
- **WHEN** 在 cwdA 写入若干 entry，再在 cwdB 写入若干 entry
- **THEN** 两批 entries 都进同一 manifest

**覆盖测试**: `server/test/file-agent-store.test.ts::跨 cwd 数据共享：同 device 的 entries 都进同一 manifest（device-only 核心特征）`

#### Scenario: 不同 device 的 manifest 互相隔离

- **GIVEN** deviceId A 与 deviceId B
- **WHEN** 各自写入 entries
- **THEN** 两份 manifest 完全隔离

**覆盖测试**: `server/test/file-agent-store.test.ts::不同 device 的 manifest 互相隔离`

#### Scenario: deviceId 字符串校验

- **WHEN** `sanitizeDeviceId(input)` 收到含非法字符的输入
- **THEN** 抛错或返回非法标记

**覆盖测试**: `server/test/file-agent-store.test.ts::sanitizeDeviceId 拒绝非法字符`

---

### Requirement: Manifest v3 schema 与 blob 内容寻址

The system MUST 使用 manifest v3 schema：按 scope（`claude-home` / `claude-json`）记录 `path → {size, mtime, sha256, skipped, expiresAt?}`；blob 以 sha256 为文件名存放在 `blobs/<sha256>`，**跨 cwd 内容相同的文件只写一份 blob**（内容寻址 dedup）。manifest v1 / v2 旧格式被视为空（不做迁移）。

#### Scenario: 新设备返回空 v3 manifest

- **WHEN** `loadManifest(deviceId)` 第一次被调用
- **THEN** 返回空的 v3 manifest

**覆盖测试**: `server/test/file-agent-store.test.ts::loadManifest 对新设备返回空 v3 manifest`

#### Scenario: 老 manifest 直接当空处理

- **WHEN** `loadManifest` 遇到 v1 / v2 manifest 文件
- **THEN** 当作空 manifest 处理，**不做迁移**

**覆盖测试**: `server/test/file-agent-store.test.ts::loadManifest 遇到老 v1/v2 manifest 直接当空处理（无迁移）`

#### Scenario: applyDelta 写 blob 并更新 manifest

- **WHEN** `applyDelta` 收到一组 changes
- **THEN** 各 blob 落盘到 `blobs/<sha256>`，manifest 同步更新；revision 递增；空批次也允许并递增 revision

**覆盖测试**: `server/test/file-agent-store.test.ts::applyDelta 写入 blob 并更新 manifest（device-only 路径）`、`server/test/file-agent-store.test.ts::applyDelta 接受 0 字节文件（contentBase64 为空字符串）`、`server/test/file-agent-store.test.ts::applyDelta 每次成功应用后 revision 递增`、`server/test/file-agent-store.test.ts::applyDelta 支持空变更批次并递增 revision`

#### Scenario: applyDelta 覆盖 delete / skipped / sha256 校验

- **WHEN** `applyDelta` 处理 delete change、skipped 标记、不一致的 sha256
- **THEN** 删除条目；skipped 不写 blob；sha256 不一致时拒绝

**覆盖测试**: `server/test/file-agent-store.test.ts::applyDelta 覆盖 delete、skipped 与 sha256 校验`

#### Scenario: blob 跨 cwd dedup

- **WHEN** 同 device 不同 cwd 写入相同内容（同 sha256）
- **THEN** `blobs/` 目录中只存一份 blob

**覆盖测试**: `server/test/file-agent-store.test.ts::blob 跨 cwd 内容寻址 dedup（同 sha 只写一份）`

---

### Requirement: TTL 必须有限正数

The system MUST 在 FileAgent 的所有写入与命中路径上对 `ttlMs` 做有限正数校验：`ttlMs ≤ 0 / Infinity / NaN` **必须抛 RangeError**，且不污染 TTL 表。

#### Scenario: bump 拒绝非法 ttl

- **WHEN** TTL 表 `bump(path, ttlMs)`，`ttlMs ∈ {0, -1, Infinity, NaN}`
- **THEN** 抛 RangeError

**覆盖测试**: `server/test/file-agent-ttl.test.ts::bump 拒绝 ttlMs ≤ 0 / Infinity / NaN`

#### Scenario: read / stat 时 ttl 非法 → 不污染 TTL 表

- **WHEN** `FileAgent.read(absPath, ttlMs)` 收到非法 ttlMs
- **THEN** 抛 RangeError，且 TTL 表保持原状

**覆盖测试**: `server/test/file-agent-ttl.test.ts::read 时 ttlMs 非法（≤0 / Infinity）→ RangeError，且不修改 TTL 表`

#### Scenario: bump 用 max 不缩短

- **WHEN** 同一 path 多次 bump，先长 ttl 再短 ttl
- **THEN** `expiresAt` 不被短 ttl 缩短（取 max）；多次 read 不同 ttl 同样取 max

**覆盖测试**: `server/test/file-agent-ttl.test.ts::bump 用 max 不覆盖：长 ttl 不被短 ttl 缩短`、`server/test/file-agent-ttl.test.ts::bump 用 max：短 ttl 后再来长 ttl 应延后`、`server/test/file-agent-ttl.test.ts::多次 read 不同 ttl，expiresAt 取 max`

---

### Requirement: GC 行为与 in-flight 跳过

The system SHALL 周期性 GC（默认 60s）清掉 `expiresAt < now` 的 entry 与 orphan blob；**有 in-flight 的 path 必须跳过 evict**，给缓刑；GC 必须重入保护，并发 `runOnce` 不重复执行；`gcIntervalMs=0` 时不启动周期但 `runGcOnce()` 可手动触发。

#### Scenario: 过期 entry 被 evict + blob 回收

- **WHEN** GC 跑过一轮，某 entry 的 `expiresAt < now`
- **THEN** entry 从 manifest 删、TTL 条目 drop、对应 blob 被 GC 回收

**覆盖测试**: `server/test/file-agent-gc.test.ts::expiresAt < now 的 entry 被 evict（manifest 删除 + ttl 表 drop + blob 回收）`、`server/test/file-agent-store.test.ts::gcOrphanBlobs 清掉未引用的 blob，保留 manifest 引用的`

#### Scenario: in-flight path 跳过 evict

- **WHEN** path 处于 in-flight 状态且过期
- **THEN** 该轮 GC 跳过 evict，TTL 条目保留，下次 GC 重试

**覆盖测试**: `server/test/file-agent-gc.test.ts::有 in-flight 的 path：跳过 evict，ttl 条目保留（下次 GC 重试）`

#### Scenario: GC 重入保护

- **WHEN** `runOnce` 并发被调多次
- **THEN** 第二次并发调用不重复执行

**覆盖测试**: `server/test/file-agent-gc.test.ts::runOnce 重入保护：第二次并发调用不重复执行`

#### Scenario: gcIntervalMs=0 时关闭周期但保留手动触发

- **WHEN** 配置 `gcIntervalMs=0`
- **THEN** 不启动周期 GC；`runGcOnce()` 仍可手动触发；`close()` 停止周期

**覆盖测试**: `server/test/file-agent-gc.test.ts::默认配置启动周期 GC；close() 停止`、`server/test/file-agent-gc.test.ts::gcIntervalMs=0 → 不启动周期，但 runGcOnce() 可手动触发`

#### Scenario: orphan blob GC 边界

- **WHEN** device 的 `blobs/` 目录不存在
- **THEN** `gcOrphanBlobs` 不报错

**覆盖测试**: `server/test/file-agent-store.test.ts::gcOrphanBlobs 对没有 blobs 目录的 device 不报错`

---

### Requirement: Manifest 串行锁（pipeline 硬前提）

The system MUST 用 `withManifestLock` 按 `deviceId` 维护 promise 链 mutex，串行化所有 read-modify-write 操作（`applyDelta` / `upsertEntry` / `removeEntry`）；不同 device 之间不互相阻塞；这是 pipeline 上传协议的硬前提（server message handler 是并发的）。

#### Scenario: 同 device 写入串行化

- **WHEN** 并发 `applyDelta` 同一 deviceId
- **THEN** 写入按提交顺序串行执行，无丢更新

**覆盖测试**: `server/test/file-agent-store.test.ts::withManifestLock 串行化并发 applyDelta，防止 manifest read-modify-write 丢更新`

#### Scenario: 不同 device 写入并发

- **WHEN** 并发 `applyDelta` 不同 deviceId
- **THEN** 互不阻塞

**覆盖测试**: `server/test/file-agent-store.test.ts::withManifestLock 不同 deviceId 之间不互相阻塞`

---

### Requirement: 协议字段（v1 不变）

The system SHALL 保持 v1 协议字段不变：`client_hello` 上报 `deviceId / cwd / capabilities`；server 用 `cache_task_assignment` 指派 active/inactive 角色 + manifest 快照；active client 发 `cache_task_delta`（每条含 `batchId`），initial 完成发 `cache_task_sync_complete`；server 用 `cache_task_delta_ack` 回 `appliedRevision`；用 `cache_task_mutation_hint` 协调读穿透。

#### Scenario: hello + assignment 双向握手

- **WHEN** active client `registerHello`
- **THEN** `assignment.syncPlan` 非空（指派 initial 同步任务）

**覆盖测试**: `server/test/cache-task-manager-syncplan.test.ts::registerHello active 时 assignment.syncPlan 非空`

#### Scenario: active 选举与故障切换

- **WHEN** 两个具备 `cacheTaskV1` capability 的 client 并发连接
- **THEN** per-key lock 内只选一个 active；缺 capability 的 legacy client **永远不被选**
- **WHEN** active client 心跳超时
- **THEN** 触发 failover 提升 standby
- **WHEN** active disconnect
- **THEN** standby 提升为 active

**覆盖测试**: `server/test/cache-task-manager.test.ts::elect active under per-key lock when two capable clients connect concurrently`、`server/test/cache-task-manager.test.ts::failover on heartbeat timeout`、`server/test/cache-task-manager.test.ts::active disconnect promotes standby to active`、`server/test/cache-task-manager.test.ts::legacy client without cacheTaskV1 capability is never elected`

#### Scenario: 拒绝陈旧 delta

- **WHEN** delta 的 `assignmentId` 或 `revision` 与当前不一致
- **THEN** server 拒绝该 delta

**覆盖测试**: `server/test/cache-task-manager.test.ts::reject stale delta by assignmentId`、`server/test/cache-task-manager.test.ts::reject stale delta by revision`

#### Scenario: sync_complete 推进状态机

- **WHEN** 收到 `cache_task_sync_complete`
- **THEN** 任务从 syncing → ready

**覆盖测试**: `server/test/cache-task-manager.test.ts::sync_complete moves task to ready`

#### Scenario: 重复 mutationId 直接 ack

- **WHEN** 同一 mutationId 的 delta 重复到达
- **THEN** server 直接 ack，不重复推进 revision

**覆盖测试**: `server/test/cache-task-manager.test.ts::重复 mutationId 的 delta 会直接 ack，不重复推进 revision`

---

### Requirement: 大小限制与扫描策略

The system SHALL 在扫描与上传阶段执行以下大小限制：

- 单文件 > `MAX_FILE_BYTES`（1MB）：标记 `skipped`，仅同步元数据，不上传 content
- 单 scope 累计 > `MAX_SCOPE_BYTES`（100MB）：按 mtime 倒序保留，超出部分**完全丢弃**，manifest 记 `truncated: true` 用于诊断
- skipped 文件不占预算
- 0 字节文件 `contentBase64=''`，**不**标记 skipped
- include / exclude matcher 与 `createScanFilter` 集成：白名单过滤 dir 子项；exclude 子树被剪枝

#### Scenario: 单文件 skipped 不占预算 + mtime 倒序截断

- **WHEN** 扫描产生超大文件 + 多个普通文件
- **THEN** 超大文件标记 skipped 不占预算；其他按 mtime 倒序填，超 budget 的截断

**覆盖测试**: `client/test/cache-sync.test.ts::applyScopeBudget 单文件 skipped 不占预算，按 mtime 截断其余项`

#### Scenario: 0 字节文件不被 skipped

- **WHEN** 扫描遇到 0 字节文件
- **THEN** 生成 `contentBase64=''`，**不**标记 skipped

**覆盖测试**: `client/test/cache-sync.test.ts::buildScopePlan 为 0 字节文件生成 contentBase64=''（不会标记 skipped）`

#### Scenario: include/exclude 过滤

- **WHEN** `buildScopePlan` 接受 `excludeMatcher` 或 `createScanFilter`
- **THEN** 被排除的路径不进 plan；include 范围内的 exclude 子树仍被剪枝；顶级文件默认放行

**覆盖测试**: `client/test/cache-sync.test.ts::buildScopePlan 接受 exclude matcher，被排除的路径不会进入 plan`、`client/test/cache-sync.test.ts::buildScopePlan 与 createScanFilter 集成：白名单过滤 dir 子项；顶级文件默认放行`、`client/test/cache-sync.test.ts::buildScopePlan 与 createScanFilter 集成：include 范围内 exclude 子树仍被剪枝`

#### Scenario: scanCache 复用 sha256

- **WHEN** `buildScopePlan` 接受 `scanCache`
- **THEN** 命中复用 sha256，miss 写回缓存

**覆盖测试**: `client/test/cache-sync.test.ts::buildScopePlan 接受 scanCache：命中时复用 sha256，并把 miss 写回缓存`

#### Scenario: walk_done 必须先于所有 hash_progress

- **WHEN** `walkScope` / `hashScope` 跑一轮
- **THEN** `walk_done` 事件必须在所有 `hash_progress` 事件之前

**覆盖测试**: `client/test/cache-sync.test.ts::walkScope/hashScope 中 walk_done 必须先于所有 hash_progress`

#### Scenario: walkScope abort 与 instruction 限制

- **WHEN** `walkScope` 触发 `shouldAbort`
- **THEN** 提前返回当前 partial 结果
- **WHEN** 按 `instruction` 限制 files / subtrees
- **THEN** 仅扫描指定范围；删除覆盖范围内缺失项；knownMissing 跳过 stat

**覆盖测试**: `client/test/cache-sync.test.ts::walkScope 在 shouldAbort 触发后提前返回当前 partial 结果`、`client/test/cache-sync.test.ts::walkScope 按 instruction 限制 files 与 subtrees`、`client/test/cache-sync.test.ts::buildScopePlan 按 instruction 删除覆盖范围内缺失项，knownMissing 跳过 stat`

---

### Requirement: Pipeline 上传与流控

The system MUST 用 pipeline 模式上传 initial delta：每个有 content 的文件单独发 `cache_task_delta`，发完不等 ack 立即发下一个；ack 通过 `batchId + appliedRevision` 异步匹配 in-flight 队列；`MAX_INFLIGHT_BYTES = 16MB` 流控水位，超水位暂停 send；元数据批（deletes + skipped）每 scope 第一发等 ack 后才进 pipeline。

#### Scenario: 多文件并发 in-flight

- **WHEN** initial 阶段 push 多个文件
- **THEN** 多个 delta 同时 in-flight；按预分配的 baseRevision 推进

**覆盖测试**: `client/test/cache-sync.test.ts::pushInitialDeltaBatches 保留 file_pushed/file_acked 事件契约并预分配 baseRevision`、`client/test/cache-sync.test.ts::pushInitialDeltaBatches 在 initial 阶段保留多文件并发 in-flight`

#### Scenario: capacity 水位前阻塞 push

- **WHEN** in-flight 字节累计接近 `MAX_INFLIGHT_BYTES`
- **THEN** 后续 push 被阻塞，等 ack 释放配额

**覆盖测试**: `client/test/cache-sync.test.ts::pushInitialDeltaBatches 在达到 capacity 水位前阻塞后续 push`

#### Scenario: abort 时清理 ack listener

- **WHEN** initial pipeline 被 abort
- **THEN** 抛 `InitialSyncAbortedError`，所有 ack listener 被清理；多 future 同时 reject 不留 unhandled rejection

**覆盖测试**: `client/test/cache-sync.test.ts::pushInitialDeltaBatches abort 时清理 ack listener 并抛 InitialSyncAbortedError`、`client/test/cache-sync.test.ts::pushInitialDeltaBatches: 多 future 同时被 reject 不留下 unhandled rejection`

---

### Requirement: FUSE 读路径与 cache 共享 store

The system SHALL 让 FUSE Host 与 FileAgent **共享同一份 store**：

- 启动时 `collectAndWriteSnapshot` 对 `home-claude` / `home-claude-json` **优先从 cache manifest 构造 snapshot**（`buildSnapshotFromManifest`），不再向 client 发全量 snapshot 请求
- 运行时 `handleFuseLine` 的 `read` op 先调 `tryServeReadFromCache`：命中 blob 直接写回 FUSE daemon；miss / skipped fallback 到原穿透路径
- `project-claude` 不在 cache 覆盖范围，仍穿透 client
- cache 未启用（无 deviceId / 无 cacheStore）时退化为纯穿透模式
- syncing 状态下 cache read 强制穿透；mutation hint 命中后读穿透，delta 应用后恢复 cache 命中

#### Scenario: snapshot 从 manifest 构造

- **WHEN** 启动期 `buildSnapshotFromManifest` 对 manifest 跑一轮
- **THEN** 生成目录 + 文件 + 嵌套子目录的 snapshot；skipped 文件只有 stat 无 data

**覆盖测试**: `server/test/file-proxy-cache-read.test.ts::buildSnapshotFromManifest 生成目录 + 文件 + 嵌套子目录`、`server/test/file-proxy-cache-read.test.ts::buildSnapshotFromManifest 对 skipped 文件只有 stat 无 data`

#### Scenario: phase=degraded 回退向 client 拉

- **WHEN** cache phase 为 degraded
- **THEN** `collectAndWriteSnapshot` 回退向 client 拉 home roots snapshot

**覆盖测试**: `server/test/file-proxy-cache-read.test.ts::phase=degraded 时 collectAndWriteSnapshot 会回退向 Client 拉 home roots snapshot`

#### Scenario: ready 状态下未注册 hint 的 read 走 cache

- **GIVEN** cache phase=ready 且 path 无 mutation hint
- **WHEN** FUSE handleFuseLine 处理 read op
- **THEN** 走 cache 命中路径

**覆盖测试**: `server/test/file-proxy-cache-read.test.ts::ready 状态下未注册 hint 的 read 走 cache`

#### Scenario: mutation hint 命中读穿透 + 应用 delta 后恢复

- **GIVEN** path 有 mutation hint
- **WHEN** FUSE 收到 read op
- **THEN** 强制穿透 client；delta 应用后 hint 失效，恢复 cache 命中
- **WHEN** mutation hint TTL 过期
- **THEN** `shouldBypassCacheRead` 返回 false（恢复 cache 命中）

**覆盖测试**: `server/test/file-proxy-cache-read.test.ts::mutation hint 命中后读穿透，delta 应用后恢复 cache 命中`、`server/test/cache-task-manager.test.ts::mutation hint TTL 过期后 shouldBypassCacheRead 返回 false`

#### Scenario: handleFuseLine 在转发写请求前注册 hint

- **WHEN** FUSE 收到写请求
- **THEN** 转发前先注册 mutation hint

**覆盖测试**: `server/test/file-proxy-cache-read.test.ts::handleFuseLine 在转发写请求前注册 mutation hint`

#### Scenario: skipped 文件 + project-claude root 不走 cache

- **WHEN** `tryServeReadFromCache` 收到 skipped 文件 / `project-claude` root 路径
- **THEN** 返回 false 让调用方穿透

**覆盖测试**: `server/test/file-proxy-cache-read.test.ts::tryServeReadFromCache 对 skipped 文件返回 false（让调用方穿透）`、`server/test/file-proxy-cache-read.test.ts::tryServeReadFromCache 对 project-claude root 返回 false（不走 cache）`

#### Scenario: cache 未启用时退化纯穿透

- **WHEN** cache 未启用（无 deviceId / 无 cacheStore）
- **THEN** `buildSnapshotFromManifest` 返回空；`tryServeReadFromCache` 返回 false

**覆盖测试**: `server/test/file-proxy-cache-read.test.ts::cache 未启用时 buildSnapshotFromManifest 返回空`、`server/test/file-proxy-cache-read.test.ts::cache 未启用（无 deviceId）时 tryServeReadFromCache 返回 false`

---

### Requirement: scope 适配与 FileAgent 接口

The system SHALL 通过 `scope-adapter` 把 FileAgent 的绝对路径接口（`absPath`）适配到 manifest 的 scope 维度：`~/.claude/<rel>` → `claude-home`；`~/.claude.json` → `claude-json`（relPath=''）；其他 → null。`toAbsPath` 反向转换。

#### Scenario: scope 识别

- **WHEN** `toScope(absPath)` 收到 `~/.claude/X` / `~/.claude.json` / 其他路径
- **THEN** 返回对应 scope 与 relPath；其他路径返回 null

**覆盖测试**: `server/test/file-agent.test.ts::absPath 在 ~/.claude/ 下 → scope=claude-home, relPath`、`server/test/file-agent.test.ts::absPath = ~/.claude.json → scope=claude-json, relPath=''`、`server/test/file-agent.test.ts::absPath 不在已知 scope 内 → null`、`server/test/file-agent.test.ts::toAbsPath 反向转换`

#### Scenario: FileAgent 接口与命中

- **WHEN** 在 store 写 entry，再 `FileAgent.read(absPath, ttlMs)` 命中
- **THEN** 返回正确 buffer
- **WHEN** read 命中 skipped 文件
- **THEN** 返回 skipped kind（无 content）
- **WHEN** stat 命中
- **THEN** 返回 file kind 元数据
- **WHEN** read miss（store 中无 entry）
- **THEN** 抛 not implemented（fetch 路径由 SyncCoordinator 接，见后续 change）

**覆盖测试**: `server/test/file-agent.test.ts::先在 store 写 entry，再 FileAgent.read 命中返回正确 buffer`、`server/test/file-agent.test.ts::read 命中 skipped 文件 → 返回 skipped kind（无 content）`、`server/test/file-agent.test.ts::stat 命中 → 返回 file kind 元数据`、`server/test/file-agent.test.ts::read miss（store 中没有 entry）→ 抛 not implemented（Task 5 接 sync）`

---

## 非功能需求

### NFR-1: 启动期同步进度 UI

- **目标**：TTY 场景下 cache sync 启动期与 PTY startup 共享一个 `CacheSyncProgressView`，phase 抽象统一管理 spinner / 进度条 / 持久行；非 TTY/CI 场景纯 log 不输出 ANSI 序列
- **测量方式**：`client/test/ui-cache-progress.test.ts` 的 phase 系列测试（pty-startup phase、scan/upload phase 并发、`printPersistent` 三步擦写）
- **当前覆盖**：`client/test/ui-cache-progress.test.ts`

### NFR-2: 失败降级

- **目标**：缓存同步失败不阻塞 PTY session 启动——降级为"无 server 缓存"模式，FUSE 读请求仍可穿透回 client
- **测量方式**：手动注入故障（manifest 写失败 / 协议中断）观察 PTY session 是否仍启动并完成工具调用
- **当前覆盖**：`[no-test]`，依赖代码 try/catch 实现。**已记入 baseline-shadow-mcp-clientcache 的「发现的债务」**

### NFR-3: 隐私 callout

- **目标**：device 全局 manifest 持久化所有访问过的 path（含 home 路径名），运维清理时整 device 目录删除即可
- **测量方式**：N/A（属于隐私声明，非功能性）
- **当前覆盖**：通过 `docs/overview/project.md` §2.5 与 `CLAUDE.md` §5 文档化

---

## 变更历史

| 日期 | Change | 变更摘要 |
|---|---|---|
| 2026-05-05 | [baseline-shadow-mcp-clientcache](../../archive/2026-05-05-baseline-shadow-mcp-clientcache/) | Baseline 反向生成首次创建 |

---

**首次创建**: 2026-05-05
**最后更新**: 2026-05-05（baseline-shadow-mcp-clientcache）
