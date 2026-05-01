# Access-Ledger 驱动的 Snapshot + 增量同步缓存设计 / Access-Ledger-Driven Snapshot & Delta Sync Cache Design

- **状态 / Status**: Implemented (master @ 1610514)
- **日期 / Date**: 2026-05-01
- **作者 / Author**: Claude (with @n374), peer-reviewed by Codex
- **实施总结 / Implementation Summary**: 全 7 个 Phase 落地完成, 见 [`docs/superpowers/plans/2026-05-01-access-ledger-driven-cache.md`](../plans/2026-05-01-access-ledger-driven-cache.md). 31 个 commit (`9aba1e2` → `1610514`), server 305 tests / 300 pass / 5 skipped. V2 候选 (cwd-ancestor `CLAUDE.md` / dirIndex / blob 跨 cwd 去重) 见 §11.
- **关联文档 / Related**: [`docs/architecture.md`](../../architecture.md) §11 子文档索引（已登记），[`CLAUDE.md`](../../../CLAUDE.md)

---

## 1. 背景与问题 / Background

### 1.1 现有两套子系统 / Current Two Subsystems

Cerelay 当前有**两套并存但耦合不充分**的"启动期文件加速"机制：

| 子系统 | 范围 | 持久化 | 触发 |
|---|---|---|---|
| **ClientCacheStore** (manifest + blob) | 写死整棵 `~/.claude/` + `~/.claude.json` | 跨 session 持久 | Client 建联时全量 walk + hash + diff，运行期 watcher 推 delta |
| **FUSE snapshot 预热** | per-session 选取 home-claude / home-claude-json / project-claude 三个 root | 进程内（daemon 退出即丢） | PTY session 启动时一次性扫整树灌进 daemon `_*_perm` 层 |

两子系统结合点：cache phase=`ready` 时 snapshot 直接从 manifest 反向构造，省 client RTT；否则 fallback 走 client 全量扫描。

### 1.2 已知缺陷 / Known Defects

**Defect 1 — `phase_syncing` 抢跑**：snapshot 收集发生在 cache task 进入 `ready` 之前（实测 660ms 时间差），导致即便 cache 已经持久化了 27556 个 entry，本次启动仍然走 client 全量扫描。日志体现为 `usedCacheSnapshot=false / cacheAvailability="phase_syncing" / cachedEntryCount=0`。

**Defect 2 — "不存在路径"的负缓存只能存活到 daemon 退出**：FUSE daemon 运行期 `put_negative` 进 in-memory dict（TTL 30s），daemon 退出即丢；当前持久化 negatives 仅覆盖**snapshot 期间发现的 broken symlink**（注释见 `server/src/file-proxy-manager.ts:490-491`）。CC 启动期常规探测的 ENOENT 路径（如 `plugins/cache/.../themes`、`output-styles`、`monitors`）每次启动都重新穿透 client。

**Defect 3 — 同步范围与访问行为脱节**：当前同步范围是写死的 `~/.claude/` 整棵 + `~/.claude.json`。CC 启动期实际访问的范围**远小于此**（用户 ~/.claude 中相当一部分是 plugins cache、todos、shell-snapshots 这些 CC 不在启动期读的），同步资源被浪费在 CC 永远不读的子树上。

### 1.3 用户的核心 Insight / User's Core Insight

> "缓存逻辑应当满足：默认情况下我们有类似白名单的机制；FUSE 能够知道 CC 访问了哪些文件以及哪些目录；通过这些访问信息对对应的文件做标记。下一次建联时只需要同步这些文件。如果之前是穿透的，那下次也完整地同步过来。"

总结为三条原则：

1. **同步范围由访问历史驱动，不是写死**
2. **FUSE 学到的"路径存在 / 不存在 / 内容 / 目录列表"必须跨 session 持久化**——至少存活到下次建联
3. **首次连接（且仅首次）使用一份固化白名单作为冷启动种子**

---

## 2. 目标 / 非目标 / Goals & Non-Goals

### 2.1 目标 / Goals

- **G1**：CC 启动期 FUSE 穿透次数收敛——稳态启动期穿透次数 < 5（当前实测 ~30+）
- **G2**：同步内容体积下降——稳态同步范围只覆盖 CC 实际启动期访问的子集（预计 < 现状的 30%）
- **G3**：跨 cwd 切换不重新扫整棵 ~/.claude——home scope 在 ledger 层跨 cwd 共享访问历史
- **G4**：修掉 Defect 1（snapshot 抢跑）和 Defect 2（负缓存不持久）

### 2.2 非目标 / Non-Goals

- **NG1**：不重写 `ClientCacheStore`（manifest + blob + 锁 + watcher + failover）—— 沿用作底层
- **NG2**：不重写 `cache_task` 状态机（idle/syncing/ready/degraded）—— 沿用
- **NG3**：不引入跨进程双向 IPC（保留 daemon stdin/stdout JSON-RPC + control pipe）
- **NG4**：**不在本期处理 cwd-ancestor `CLAUDE.md` 加载**。当前 namespace bootstrap (`server/src/claude-session-runtime.ts:240-265`) 只 mount 三个 root（home-claude / home-claude-json / project-claude），cwd 父链上的目录（如 `/Users/n374/Documents/`）根本不在 namespace 文件系统里 —— CC 直接 fs.readFile 也读不到。要让 CC 加载 ancestor `CLAUDE.md` 需要扩展 namespace mount 层，是独立子项目，本 spec 不涵盖
- **NG5**：不做"全 cwd 共享 cwd-local 内容"——只 home 跨 cwd 共享 ledger
- **NG6**：**不保留任何兼容老协议的代码路径**。当前服务尚未对外发布，所有协议变更直接 hard switch；不保留 capability 降级、不保留 fallback 到旧 walk，不保留旧 schema 反序列化
- **NG7**：**dirIndex（目录级 metadata 缓存）不在 v1 范围**。详见 §11
- **NG8**：不改变 `project-claude` root 当前不走 manifest+blob cache 的设计（频繁变更走穿透即可）。仅扩展它走 ledger（记 missing）

---

## 3. 设计概览 / Design Overview

### 3.1 三个核心抽象 / Three Core Abstractions

```
┌──────────────────────────────────────────────────────────────────────┐
│ AccessLedger (新增 / NEW)                                            │
│   - 跨 session 持久化"哪些路径被 CC 访问过"                          │
│   - 三类 entry: file_present / dir_present / missing                 │
│   - per-deviceId 一份, key 是绝对路径                                │
│     · home-scoped path 跨 cwd 自然共享 (key 一致)                    │
│     · cwd-local path 跨 cwd 自然隔离 (key 不冲突)                    │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              │ 反向构造同步范围
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ SyncPlan (新增 / NEW)                                                │
│   - 每次建联时根据 (deviceId, cwd) 动态计算"本次该同步什么"          │
│   - 输入: ledger + 种子白名单(ledger 空时 fallback)                  │
│   - 输出: 一组 path patterns (file or subtree+depth) 按 scope 分组   │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              │ 驱动
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ ClientCacheStore (沿用 / EXISTING)                                   │
│   - manifest.json + blobs/<sha256>                                   │
│   - 改造点: walk 范围由 SyncPlan 决定, 不再固定整棵 ~/.claude        │
│   - 维度仍是 (deviceId, cwd)；home scope 在 manifest 层仍 per-cwd    │
│     复制（接受重复存储），跨 cwd 共享只发生在 ledger 层（避免重复 walk）│
└──────────────────────────────────────────────────────────────────────┘
                              │
                              │ ready 后反向构造
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ FUSE Snapshot (扩展 / EXTENDED)                                      │
│   - file/dir entry: 来自 manifest + blob (沿用)                      │
│   - missing entry: 来自 ledger (新增, 仅本 session roots 范围内)     │
│   - daemon 三类 perm 全部预填: _stat_perm/_readdir_perm/_negative_perm│
│   - daemon `_negative_perm` 查询语义改为前缀匹配                     │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.2 数据流 / Data Flow

**冷启动 (ledger 完全空)**:

```
Client hello → Server 检查 ledger → 空 → 用 SeedWhitelist 作种子 plan
            ↓
Server 下发 cache_task_assignment(plan) → Client 按 plan walk + hash + diff
            ↓
Client push delta → ClientCacheStore 落 manifest+blob → cache_task ready
            ↓
[Defect 1 修复] Snapshot 收集阻塞等 ready (无超时, 仅 phase 不可达 ready 时 fallback)
            ↓
Snapshot 反向构造 = manifest(file/dir) + ledger.missing 投影到本 session roots
            ↓
CC 启动 → 高命中率, 低 RPC
            ↓
运行期穿透 → server 学习 → ledger 更新 + daemon 同步推 _negative_perm
```

**温启动 (ledger 已有数据)**:

```
Client hello → Server 检查 ledger → 命中 → 反向构造 SyncPlan (剔除大量未访问路径)
            ↓
后续流程同冷启动, cache_task delta 量极小, ready 在 < 1s 内达成
```

---

## 4. 数据模型 / Data Model

### 4.1 AccessLedger Schema

存储位置：`${CERELAY_DATA_DIR}/access-ledger/<deviceId>/ledger.json`

```typescript
interface AccessLedger {
  version: 1;
  deviceId: string;
  // 单调递增, 每次 flush 时 +1
  revision: number;
  // 主索引: 三类 entry, 全部用绝对路径作 key
  entries: Record<string /* absolutePath */, AccessLedgerEntry>;
}

type AccessLedgerEntry =
  | {
      kind: "file";
      lastAccessedAt: number;  // CC 最近一次 stat / read 的 unix ms
    }
  | {
      kind: "dir";
      lastAccessedAt: number;
      // 该目录是否被 readdir 过(true) 或仅 stat 过(false)
      // 决定 SyncPlan 是否要把整棵子树纳入
      readdirObserved: boolean;
    }
  | {
      kind: "missing";
      lastAccessedAt: number;
      // 必须是"最浅不存在祖先"(向上塌缩后的)
    };
```

**关键约束**：

- **绝对路径作 key**：天然带跨 cwd 隔离/共享语义
- **路径规范化**：写入 ledger 前所有 path 必须经过 `normalizeLedgerPath(absPath)`，规则见下方"路径规范化"小节
- **missing 必须是塌缩后的**：ledger 不允许同时存在 `/a/missing` 和 `/a/b/missing`——后者必须被前者吸收（写入时检查）
- **`kind` 互斥**：一个 path 不能既是 `file` 又是 `dir`；类型变化时由 invalidation 流程处理

#### 路径规范化 / Path Normalization

```typescript
// 启动时一次性 probe, 缓存全局
let _caseSensitive: boolean | null = null;

function probeCaseSensitivity(): boolean {
  // 在 ${CERELAY_DATA_DIR} 下创建 ".case-probe-Foo.tmp" 检查
  // ".case-probe-foo.tmp" 是否同一文件; case-insensitive 时同。
  // 仅在 server 启动期 probe 一次。
}

function normalizeLedgerPath(absPath: string): string {
  // 1. 父目录 realpath (resolve symlink), 文件 basename 保留原 case 检测
  const parent = path.dirname(absPath);
  const basename = path.basename(absPath);
  let resolvedParent: string;
  try {
    resolvedParent = realpathSync.native(parent);
  } catch {
    // 父目录不存在 - 也允许, 保留原 parent (不 resolve)
    // 这种情况通常是 missing entry 的 ancestor 链
    resolvedParent = parent;
  }

  // 2. case-insensitive fs: basename 归一化为 lower-case
  //    (parent realpath 已经从 fs 得到正确 case, 不需再降级)
  const fsCaseSensitive = _caseSensitive ?? probeCaseSensitivity();
  const normalizedBasename = fsCaseSensitive ? basename : basename.toLowerCase();

  return path.join(resolvedParent, normalizedBasename);
}
```

**Case-insensitive fs 上的接受代价**：basename 归小写后，`Foo.md` 和 `foo.md` 在 ledger 里是同一 key。原始 case 不在 ledger 内存——这是接受的：ledger 存在意义是"是否需要同步 / 是否 missing"，**不是文件名 display**。client 端 stat 时 fs 自己处理 case，server 推 daemon 的 path 也是规范化后的（daemon 在 case-insensitive fs 上同样按小写比对）。

### 4.2 物理布局与运行时索引 / Physical Layout & Runtime Indices

**磁盘布局**：

```
${CERELAY_DATA_DIR}/access-ledger/
├── <deviceId-1>/
│   ├── ledger.json           # 主 ledger
│   └── ledger.json.tmp-...   # 原子写临时文件
├── <deviceId-2>/
│   └── ledger.json
```

**Seed Whitelist**：编译期 ts const，详见 §10.2，**不写盘**。

**运行时二级索引**（in-memory, 从主索引派生）：

```typescript
class AccessLedgerRuntime {
  // 主索引: path → entry
  private entries: Map<string, AccessLedgerEntry>;

  // 二级索引 1: missing 路径专属 sorted array (字典序)
  // 用途: 写入 missing / 失效 missing / daemon 投影 都依赖前缀查询
  private missingSorted: string[];

  // 二级索引 2: 全部 path 的 sorted array (字典序)
  // 用途: 反向构造 plan 时按 root 前缀枚举 entries
  // 写入/删除 entry 时同步维护 (bisect.insort / .remove)
  private allPathsSorted: string[];

  // 二级索引 3: dir-readdir-observed 集合
  // 用途: plan 决定是否扫整棵子树
  private dirsReaddirObserved: Set<string>;
}
```

**典型操作复杂度**：

| 操作 | 复杂度 | 实现 |
|---|---|---|
| upsert file/dir | O(log N) | Map.set + bisect.insort allPathsSorted + Set.add(if dir+readdirObserved) |
| upsert missing (含吸收子 missing) | O(log N + k) | bisect 定位 missingSorted + 范围删除 + 同步 entries / allPathsSorted |
| invalidate missing on write (前缀清理) | O(depth × log N) | 沿父链向上 missingSorted bisect 清理 |
| daemon 投影时枚举所有 missing | O(N_missing) | 直接遍历 missingSorted |
| 反向构造 plan 时枚举 root prefix 内 entries | O(log N + k) | allPathsSorted bisect 定位前缀 + 顺序遍历直到出 prefix |
| 删除 entry (unlink/rmdir/aging) | O(log N) | Map.delete + bisect 删除（若 missing 也删 missingSorted） |

**索引一致性约束**：所有 mutation 操作必须在 per-deviceId mutex 内串行执行，保证主索引 + 三个二级索引同步更新。每个 mutation 方法内部按"先改主索引、再改二级索引"的固定顺序，crash 时 ledger.json 重 load 后从主索引重建二级索引。

**与 ClientCacheStore 的关系**：

| 组件 | 维度 | 职责 |
|---|---|---|
| ClientCacheStore (manifest + blob) | per-(deviceId, cwd) | "这些路径**是什么内容**" |
| AccessLedger | per-deviceId | "这些路径**该不该同步 / 是不是不存在**" |

两者**正交**：ledger 决定 plan，plan 决定 manifest 应该有哪些条目。

**接受的代价**：home scope 内容（blob）在 manifest 层仍按 (deviceId, cwd) 复制存储——同 device 下两个不同 cwd 的 ~/.claude 内容是两份 blob 副本。**跨 cwd 共享只发生在 ledger 层**（避免重复 walk + hash + 上传），blob 物理共享是后续优化项（dedup by sha256 across cwd manifests），不在本 spec。

### 4.3 访问事件类型 / Access Event Types

运行期 server 收到 client RPC response 后产生 `AccessEvent`：

```typescript
type AccessEvent =
  // ===== getattr =====
  // CC stat 一个文件/目录, 成功返回 stat
  | { op: "getattr"; path: string; result: "file" | "dir"; mtime: number }
  // CC stat 一个不存在的路径, client 顺便回报最浅不存在祖先
  | { op: "getattr"; path: string; result: "missing"; shallowestMissingAncestor: string }

  // ===== readdir =====
  // CC readdir 一个目录, 成功返回 entries; 标记 readdirObserved=true
  | { op: "readdir"; path: string; result: "ok" }
  // CC readdir 一个不存在的目录 (Codex 修正: 不能假设 getattr 路径会覆盖 ——
  // 协议层 client 也必须在 readdir ENOENT 时回报 shallowestMissingAncestor)
  | { op: "readdir"; path: string; result: "missing"; shallowestMissingAncestor: string }

  // ===== read =====
  // 注: read ok 不写 ledger —— CC read 一个文件之前必然 getattr 过, getattr 路径
  // 已经把 file_present 写进 ledger; read ok 不带 mtime 也无法生成完整 file entry。
  // 仅 read ENOENT 才有信号: client 也回报最浅不存在祖先 (虽极罕见, 完整起见纳入)
  | { op: "read"; path: string; result: "missing"; shallowestMissingAncestor: string }

  // ===== mutation (cache invalidation 触发) =====
  // 覆盖现有 CACHE_MUTATING_OPS (file-proxy-manager.ts:1309) 全部 9 个:
  //   write, create, unlink, mkdir, rmdir, rename, truncate, setattr, chmod
  | { op: "write" | "create" | "truncate" | "setattr" | "chmod"; path: string }
  | { op: "mkdir"; path: string }
  | { op: "rmdir" | "unlink"; path: string }
  | { op: "rename"; oldPath: string; newPath: string };
```

**事件→ledger 写入规则**：

| Event | Ledger 操作 |
|---|---|
| `getattr ok file` | upsert `{path, kind:file, lastAccessedAt:now}` |
| `getattr ok dir` | upsert `{path, kind:dir, readdirObserved: 保留旧值 \|\| false, lastAccessedAt:now}` |
| `readdir ok` | upsert `{path, kind:dir, readdirObserved:true, lastAccessedAt:now}` |
| `getattr/read/readdir missing + ancestor` | 调 `upsertMissing(ancestor)`：用二级索引前缀清理被吸收的子 missing，写入 ancestor 自身 |
| `write/create/truncate/setattr/chmod path` | `invalidateMissingPrefixes(path)` + 若 path 已在 ledger 就刷 lastAccessedAt（不改变 kind） |
| `mkdir path` | `invalidateMissingPrefixes(path)` + upsert `{path, kind:dir, readdirObserved:false, lastAccessedAt:now}` |
| `unlink path` | 移除 ledger 中 `path` 的 file entry（不写 missing —— 让下次 access 学习；避免我们误把临时文件写成持久 missing） |
| `rmdir path` | 移除 ledger 中 `path` 的 dir entry，**同时移除所有以 `path + "/"` 为前缀的 entries**（整棵子树清理） |
| `rename oldPath → newPath` | 把 oldPath 的 entry 搬到 newPath（含 dir 子树如果 oldPath 是 dir）；oldPath 上不写 missing |

### 4.4 Server 直接 cache hit 时的 lastAccessedAt 刷新

**场景**：当 manifest 命中、daemon 也命中时，请求不会穿透到 client，自然也不进入 `resolveResponse(resp)`。如果只在 RPC 响应里 hook，长期 hot path 的 `lastAccessedAt` 永远不刷新，30 天 aging 会误清。

**解决**：在 `tryServeReadFromCache` 命中路径同样产 `AccessEvent`（`{op:"read", path, result:"ok"}` 仅用于刷 lastAccessedAt，不改 kind / 不写新 entry）。daemon 内 `_stat_perm` / `_read_perm` 命中本来不经过 server，所以这部分仅靠 server-side cache hit 触发即可——daemon 内命中的路径假设它本来就在 ledger 里（snapshot 反向构造时灌入），**不会被错误 aging**：当 SyncPlan 计算时，aging 阈值前的 entry 仍保留。

实现：在 `FileProxyManager.tryServeReadFromCache` 命中分支增加 `this.recordCacheHitAccess(path)` 调用（per-path 防抖：同 path 5s 内只记一次，避免高频 hit 写穿）。

---

## 5. Scope 模型 / Scope Model

### 5.1 沿用现有 Scope 名 / Reuse Existing Scope Names

**保持当前命名一致**——避免引入新名字导致 `rootToCacheScope` / mutation hint / FUSE root 多处需要换名：

| FUSE root 名 | CacheScope 名（manifest+blob） | 说明 |
|---|---|---|
| `home-claude` | `claude-home` | `~/.claude/`，走 manifest+blob，跨 cwd 在 **ledger 层**共享访问历史，但 manifest+blob 仍 per-cwd 复制 |
| `home-claude-json` | `claude-json` | `~/.claude.json`，走 manifest+blob |
| `project-claude` | `null`（不走 manifest+blob） | `{cwd}/.claude/`，沿用现状不进 manifest+blob cache（频繁变更穿透即可），但**会进 ledger**——记 missing 路径以供 daemon 负缓存预热 |

**CacheScope type 不扩展**——仍是 `"claude-home" | "claude-json"`。

**ledger 覆盖范围 ≠ manifest 覆盖范围**：ledger 记三个 root 下所有访问历史；manifest+blob 只覆盖前两个。

### 5.2 cwd-ancestor `CLAUDE.md` 处理 / cwd-ancestor Handling

**显式声明本期不处理**（详见 §2.2 NG4）。如果将来要支持，需要在独立 spec 中解决：

1. namespace bootstrap 增加 cwd 父链 mount（可能需要 readonly bind mount）
2. 新增 FUSE root（如 `cwd-parents`）
3. client 端扩展 allowedPrefixes
4. 上述完成后再扩展本设计的 ledger / SyncPlan 覆盖

---

## 6. 协议变更 / Protocol Changes

### 6.1 `cache_task_assignment` 增加 SyncPlan

```typescript
interface CacheTaskAssignment {
  // ... 现有字段
  role: "active" | "inactive";
  reason: ...;

  // active 角色独有, inactive 时不带:
  manifest?: ServerManifestSnapshot;  // 现有
  // === 新增 / NEW: active 必填, hard switch 不留 optional 降级 ===
  syncPlan?: SyncPlan;
}

interface SyncPlan {
  scopes: {
    "claude-home"?: ScopeWalkInstruction;
    "claude-json"?: ScopeWalkInstruction;
  };
}

interface ScopeWalkInstruction {
  // 必扫的子树根
  subtrees: Array<{ relPath: string; maxDepth: number /* -1 = unlimited */ }>;
  // 必扫的单文件
  files: string[];
  // === knownMissing 详细语义见下文 ===
  knownMissing: string[];
}
```

**`knownMissing` 的语义** (Codex F2 提出, 必须澄清)：

`knownMissing` 是**对 client 端 walk 流程的优化提示**——告诉 client "这些路径上次确认不存在，这次 walk 时跳过 stat 即可"。它有两个用途：

1. **client walk 阶段跳过 stat**（节省启动期 syscall），等价于 client 提前知道结果是 ENOENT
2. **不替代** server 端 daemon `_negative_perm` 注入——daemon 的负缓存来自 ledger 反向投影（§7.4），跟 plan 相互独立

为什么两者都需要：plan 是"client 怎么 walk"的指令，daemon 投影是"CC 怎么探测"的预热。同一份 missing 数据用在两边：
- plan.knownMissing：影响 client walk 行为（不浪费 stat）
- daemon `_negative_perm`：影响 namespace 内 CC 探测行为（直接 ENOENT）

**示例**：温启动时 server 下发的 plan 长这样：

```json
{
  "scopes": {
    "claude-home": {
      "subtrees": [
        { "relPath": "skills", "maxDepth": 3 },
        { "relPath": "agents", "maxDepth": 2 },
        { "relPath": "commands", "maxDepth": 1 }
      ],
      "files": ["settings.json", "settings.local.json", "CLAUDE.md"],
      "knownMissing": [
        "plugins/cache/openai-codex/codex/1.0.4/themes",
        "plugins/cache/openai-codex/codex/1.0.4/output-styles"
      ]
    },
    "claude-json": {
      "subtrees": [{ "relPath": "", "maxDepth": 0 }],
      "files": [],
      "knownMissing": []
    }
  }
}
```

注意 `project-claude` 不出现在 plan 里（不走 manifest+blob cache，由 client 工具调用直接处理）。

### 6.2 `FileProxyResponse` 增加 `shallowestMissingAncestor`

```typescript
interface FileProxyResponse {
  // ... 现有字段
  reqId: string;
  error?: { code: number; message: string };

  // === 新增 / NEW ===
  // 适用 op: getattr / readdir / read
  // 仅当 error.code === ENOENT 时返回。
  // Client 在 ENOENT 响应时, 顺便 lstat 父链向上, 找到第一个不存在的祖先,
  // 把"最浅不存在祖先"的绝对路径返回。如果直接父目录也存在(只是该 path 不存在),
  // 字段等于 path 本身。
  // 失败/异常时 client 可不返回该字段, server 退化为用原 path 写 ledger。
  shallowestMissingAncestor?: string;
}
```

**Root-bound 限制**（Codex D1 提出）：

`shallowestMissingAncestor` 必须**位于本 session 配置的 FUSE root 之内**。client 计算时 cap 在 root：

```typescript
async function findShallowestMissingAncestor(
  path: string,
  rootPath: string  // session 对应的 FUSE root: ~/.claude / ~/.claude.json / {cwd}/.claude
): Promise<string> {
  // 从 path 向上一路 lstat, 直到找到第一个存在的目录或抵达 rootPath
  let current = path;
  let lastMissing = path;
  while (current !== rootPath && current !== "/") {
    const parent = path.dirname(current);
    if (parent === current) break;
    try {
      await lstat(parent);
      return lastMissing;  // parent 存在
    } catch (e) {
      if (e.code === "ENOENT") {
        lastMissing = parent;
        current = parent;
        continue;
      }
      return path;  // 其他错误不塌缩
    }
  }
  // 到达 rootPath 仍未找到存在的祖先 - 不太可能(root 本身应存在), 兜底返回原 path
  return lastMissing;
}
```

**Server 写 ledger 前再校验一次**：如果 `shallowestMissingAncestor` 落在 root 之外（client 实现 bug 或恶意），降级为用原 path 写 ledger。

### 6.3 ClientHello / ApplyDelta 等沿用 / Unchanged

- `ClientHello`、`CacheTaskHeartbeat`、`CacheTaskFault`、`CacheTaskDelta`、`CacheTaskDeltaAck`、`CacheTaskMutationHint`、`CacheTaskSyncComplete`：协议不变
- `CacheTaskAssignment.syncPlan` 在 active 角色下是**必填**——hard switch，server 不发就是 bug
- 不保留 `accessLedgerV1` capability flag——hard switch

---

## 7. 启动时序与 Daemon 协议 / Startup Timeline & Daemon Protocol

### 7.1 时序图 / Sequence Diagram

```
Client                  Server                          AccessLedger    FUSE Daemon
  │                       │                                  │              │
  │── client_hello ──────>│                                  │              │
  │                       │── load(deviceId) ───────────────>│              │
  │                       │<──── ledger or empty ────────────│              │
  │                       │                                  │              │
  │                       │── computeSyncPlan(ledger, cwd, seed)             │
  │                       │                                  │              │
  │<─ cache_task_assignment(role=active, plan) ──────────────│              │
  │                       │                                  │              │
  │── walkByPlan ──────────────────────                      │              │
  │── hashAndDiff ────────────────────                       │              │
  │── push delta(s) ─────>│                                  │              │
  │                       │── applyDelta to manifest         │              │
  │── sync_complete ─────>│                                  │              │
  │                       │── phase=ready                    │              │
  │                       │                                  │              │
  │                       │ << PTY session start (CC 启动) >>                │
  │                       │                                  │              │
  │                       │── waitForCacheReady (无超时)     │              │
  │                       │                                  │              │
  │                       │── buildSnapshot(manifest, ledger.missing within roots)
  │                       │── start daemon ────────────────────────────────>│
  │                       │                                  │  (snapshot 注入│
  │                       │                                  │   含 _negative_perm│
  │                       │                                  │   的全部 missing)│
  │                       │                                  │              │
  │                       │ << CC 探测 path 1 (daemon 命中) >>               │
  │                       │ << CC 探测 path 2 (穿透) >>                     │
  │<──── file_proxy_request ─────────────                    │              │
  │── file_proxy_response(+missing ancestor) ──>             │              │
  │                       │── recordAccessEvent ────────────>│              │
  │                       │ │ 1. 写 in-memory ledger buffer                 │
  │                       │ │ 2. control msg: put_negative_perm ───────────>│
  │                       │   (daemon 立即生效)              │              │
  │                       │                                  │              │
  │                       │── 5s timer 到期 → flush ledger ─>│              │
  │                       │                                  │              │
  │                       │ << session 结束 >>                              │
  │                       │── flushLedger ──────────────────>│              │
```

### 7.2 Defect 1 修复点 / Defect 1 Fix

**`server/src/file-proxy-manager.ts: collectAndWriteSnapshot`** 当前在 `phase=syncing` 时直接 fallback 走 client 全量扫描。改为：

```typescript
async function collectAndWriteSnapshot() {
  // === 新增: 阻塞等待 cache ready, 无超时 ===
  // 同步耗时本质上由 client 端 walk + hash + push delta 决定。设超时让一部分
  // entry 走 fallback 全量, 反而违背设计目的。改为纯阻塞 + 进度反馈。
  if (this.cacheTaskManager && this.deviceId) {
    while (true) {
      const state = this.cacheTaskManager.describeTaskState(this.deviceId, this.clientCwd);
      if (state.phase === "ready") break;
      if (state.phase === "degraded" || state.phase === "idle") {
        // task 不可能进 ready, 视为不可用 → 走 client 全量 fallback
        // (仅此一种 fallback, 也不在 syncing 中途超时退化)
        log.warn("cache task 不可达 ready, 退化全量 walk", { phase: state.phase });
        break;
      }
      await sleep(50);
    }
  }
  // ... 后续 snapshot 收集逻辑
}
```

**进度反馈**：cache sync 阶段（client walk + hash + push delta）已有 `CacheSyncEvent` + `CacheSyncProgressView`。snapshot collect 等 ready 就是等 cache sync 完成——`upload_done` 之后到 `pty-startup` phase 的间隙由现有 `pty-startup` spinner 覆盖，不加新通道。

### 7.3 Daemon `_negative_*` 重新设计 / Daemon Negative Cache Redesign

#### 7.3.1 移除 TTL 层

```python
# 删除 (废弃)
self._negative = {}        # 运行期 dict, TTL 30s
self._negative_ttl = 30.0

# 保留并扩展
self._negative_perm = ...  # 详见 7.3.2 数据结构
```

#### 7.3.2 数据结构改为支持前缀查询 / Prefix-Capable Negative Cache

**当前**：`self._negative_perm = set()`，`is_negative(path)` 是精确 `in` 匹配。

**改为**：用 sorted list + bisect 模块支持前缀查询。

```python
import bisect

class NegativeCache:
    def __init__(self):
        self._sorted = []  # sorted list of missing paths
        self._set = set()  # 同步维护, 用于精确成员检测
        self._lock = threading.Lock()

    def is_negative(self, path):
        """前缀匹配: 任何祖先在 _negative_perm 中, 当前 path 也算 missing"""
        with self._lock:
            # 二分查找: 第一个 >= path 的位置, 往前找前缀
            idx = bisect.bisect_right(self._sorted, path)
            # 检查 idx-1 是否是 path 的祖先
            if idx > 0:
                candidate = self._sorted[idx - 1]
                if path == candidate or path.startswith(candidate + "/"):
                    return True
            return False

    def put(self, missing_ancestor):
        """添加 missing entry, 同时吸收已有的子 missing 条目"""
        with self._lock:
            # 1. 移除所有以 missing_ancestor + "/" 为前缀的 existing entries
            prefix = missing_ancestor + "/"
            idx = bisect.bisect_left(self._sorted, missing_ancestor)
            # 删 missing_ancestor 自身重复条目 (如果有)
            while idx < len(self._sorted) and (
                self._sorted[idx] == missing_ancestor or self._sorted[idx].startswith(prefix)
            ):
                self._set.discard(self._sorted[idx])
                self._sorted.pop(idx)
            # 2. 插入 missing_ancestor (如果当前不在 set)
            bisect.insort(self._sorted, missing_ancestor)
            self._set.add(missing_ancestor)

    def invalidate_prefix(self, path):
        """write/create/mkdir 时调用: 移除所有"是 path 祖先"的 missing entries"""
        with self._lock:
            # path 落在哪个已存在的 missing 之下? 一路向上检查
            current = path
            while True:
                if current in self._set:
                    self._sorted.remove(current)  # 也可用 bisect 优化
                    self._set.discard(current)
                parent = os.path.dirname(current)
                if parent == current:
                    break
                current = parent
```

性能：`is_negative` O(log N)，`put` O(log N + k)（k = 被吸收的子 missing 数），`invalidate_prefix` O(depth × log N)。

#### 7.3.3 readdir ENOENT 处理修正 / readdir ENOENT Fix

**当前** (`fuse-host-script.ts:524-536`)：

```python
try:
    resp = send_request(...)
    entries = resp.get("entries", [])
except FuseOSError as e:
    if e.errno == errno.ENOENT:
        entries = []  # ← Codex D3: 把 ENOENT 转成"空目录", 与 missing 语义冲突
    else:
        raise
```

**改为**：先查 `is_negative`（前缀匹配），命中直接抛 ENOENT；穿透后 ENOENT 抛而不是 swallow。

```python
def readdir(self, path, fh):
    # ... 路径解析 ...
    hand_path = resolve_hand_path(...)

    # 1. 先查 _negative_perm (前缀匹配, 自动覆盖 missing 子树)
    if _negative_perm.is_negative(hand_path):
        raise FuseOSError(errno.ENOENT)

    # 2. 查 readdir 缓存
    cached = _cache.get_readdir(hand_path)
    if cached is not None:
        return [".", ".."] + list(cached)

    # 3. 穿透 client
    try:
        resp = send_request({...})
        entries = resp.get("entries", [])
    except FuseOSError as e:
        if e.errno == errno.ENOENT:
            # 不再 swallow 成空目录 - 抛出去让 caller 知道
            # 同时 client 已经在响应里附带 shallowestMissingAncestor,
            # server 端会写 ledger 并通过 control msg 推 _negative_perm
            raise
        raise

    # ... 后续 shadow file 注入 + 缓存
```

#### 7.3.4 Control Pipe 协议扩展 / Control Pipe Protocol Extension

**当前** (`fuse-host-script.ts:804-829`)：control pipe 只识别 `{"type":"shutdown"}`。

**新增 control message 类型**：

```python
def handle_control():
    global fuse_instance
    try:
        with os.fdopen(CONTROL_FD, "r", encoding="utf-8", buffering=1) as control:
            for line in control:
                if not line:
                    break
                try:
                    message = json.loads(line)
                except Exception:
                    continue

                msg_type = message.get("type")

                if msg_type == "shutdown":
                    # ... (现有逻辑)
                    break

                # === 新增 ===
                elif msg_type == "put_negative":
                    # server 实时推送学到的 missing entry
                    # message: {"type":"put_negative", "path":"<absolute-path>"}
                    path = message.get("path")
                    if isinstance(path, str) and path:
                        _negative_perm.put(path)

                elif msg_type == "invalidate_negative_prefix":
                    # server 推送: 某 path 被创建/写入, 清理祖先 missing
                    # message: {"type":"invalidate_negative_prefix", "path":"<absolute-path>"}
                    path = message.get("path")
                    if isinstance(path, str) and path:
                        _negative_perm.invalidate_prefix(path)

                elif msg_type == "invalidate_cache":
                    # server 推送: 某 path 缓存失效 (cache_task watcher delta 等)
                    # message: {"type":"invalidate_cache", "path":"<absolute-path>"}
                    path = message.get("path")
                    if isinstance(path, str) and path:
                        _cache.invalidate(path)

                # 未知 type: 忽略 (forward-compat)
    except OSError:
        pass
```

**协议规范**：

| msg type | 字段 | 触发时机 | 幂等性 |
|---|---|---|---|
| `shutdown` | (无) | shutdown 流程 | 是 |
| `put_negative` | `path: string` | server 学到新 missing 时 | 是（重复 put 等价单次） |
| `invalidate_negative_prefix` | `path: string` | server 收到 mutation event 时 | 是 |
| `invalidate_cache` | `path: string` | watcher delta / 显式失效 | 是 |

**未知 type forward-compat**：daemon 静默忽略，不抛错。

**为什么用 control pipe 而非主 stdin/stdout**：主 pipe 是 fuse RPC 的 request/response 协议，必须有 `reqId` 保证序对应；control 是单向 fire-and-forget，结构简单，错误不阻塞 RPC。

### 7.4 Snapshot 注入 missing entries / Snapshot Injection of Missing Entries

`FileProxyManager.collectAndWriteSnapshot` 反向构造 snapshot 时，在原有 `stats / readdirs / reads` 三类之外新增 `negatives` 投影：

```typescript
// 收集 ledger 中所有 missing 条目
const allMissing = ledger.queryAllMissing();

// 仅注入"位于本 session FUSE roots 内"的 missing
// (同 device 跨 cwd 共享 ledger, 但 daemon 只看到自己的 roots)
const sessionRoots = [
  this.roots["home-claude"],       // ~/.claude/
  this.roots["home-claude-json"],  // ~/.claude.json
  this.roots["project-claude"],    // {cwd}/.claude/
].filter(Boolean);

for (const missingPath of allMissing) {
  if (sessionRoots.some(root =>
    missingPath === root || missingPath.startsWith(root + "/")
  )) {
    snapshot.negatives.push(missingPath);
  }
}
```

注入到 daemon 后，daemon `NegativeCache.put()` 自动处理重复条目和子 missing 吸收。

---

## 8. 运行期 Access Tracking / Runtime Access Tracking

### 8.1 钩入点 / Hook Points

两个 hook 入口：

1. **`FileProxyManager.resolveResponse(resp)`**：穿透 client 的请求响应回到 server 时
2. **`FileProxyManager.tryServeReadFromCache` 命中分支** + **`handleFuseLine` 中 cache hit 命中分支**：server 端缓存直接命中（不穿透 client）时，刷 lastAccessedAt

每次产生 AccessEvent 后，**两条传播路径必须同时发生**：

1. **写 in-memory ledger buffer**（待落盘，§8.3）
2. **立即推 daemon 增量更新**（保证 namespace 内 CC 实时可见）：
   - 新 missing → daemon `put_negative`（control msg）
   - 新 file/dir present → 不必立即推（daemon 本来就会缓存这次 RPC 的成功结果到 `_stat`）
   - mutation 触发 missing 失效 → daemon `invalidate_negative_prefix`（control msg）

### 8.2 Event → Ledger 操作详细伪码 / Detailed Mapping Pseudocode

```typescript
class SessionAccessBuffer {
  private events: AccessEvent[] = [];

  recordEvent(event: AccessEvent): void {
    this.events.push(event);
  }

  async flush(ledger: AccessLedgerRuntime): Promise<void> {
    for (const ev of this.events) {
      const now = Date.now();
      switch (ev.op) {
        case "getattr":
          if (ev.result === "missing") {
            ledger.upsertMissing(ev.shallowestMissingAncestor);
            // 同步推 daemon (实时可见)
            await this.daemonControl.putNegative(ev.shallowestMissingAncestor);
          } else if (ev.result === "file") {
            ledger.upsertFilePresent(ev.path, now);
          } else if (ev.result === "dir") {
            ledger.upsertDirPresent(ev.path, now, /*readdirObserved*/ false);
          }
          break;

        case "readdir":
          if (ev.result === "ok") {
            ledger.upsertDirPresent(ev.path, now, /*readdirObserved*/ true);
          } else {
            // missing - readdir 不存在目录
            ledger.upsertMissing(ev.shallowestMissingAncestor);
            await this.daemonControl.putNegative(ev.shallowestMissingAncestor);
          }
          break;

        case "read":
          // read ok 不写 ledger (见 §4.3 注释), 仅 missing 处理
          if (ev.result === "missing") {
            ledger.upsertMissing(ev.shallowestMissingAncestor);
            await this.daemonControl.putNegative(ev.shallowestMissingAncestor);
          }
          break;

        case "write":
        case "create":
        case "truncate":
        case "setattr":
        case "chmod":
          ledger.invalidateMissingPrefixes(ev.path);
          await this.daemonControl.invalidateNegativePrefix(ev.path);
          // 仅在 path 已经在 ledger 时刷 lastAccessedAt, 不无中生有写新 entry
          ledger.touchIfPresent(ev.path);
          break;

        case "mkdir":
          ledger.invalidateMissingPrefixes(ev.path);
          await this.daemonControl.invalidateNegativePrefix(ev.path);
          ledger.upsertDirPresent(ev.path, now, /*readdirObserved*/ false);
          break;

        case "unlink":
          ledger.removeFilePresent(ev.path);
          // 不写 missing — 让下次 access 学习
          break;

        case "rmdir":
          ledger.removeDirSubtree(ev.path);  // 移除该 dir 自身和所有子 entries
          break;

        case "rename":
          ledger.renameSubtree(ev.oldPath, ev.newPath);
          // 同时 invalidate newPath 祖先链上的 missing
          ledger.invalidateMissingPrefixes(ev.newPath);
          await this.daemonControl.invalidateNegativePrefix(ev.newPath);
          break;
      }
    }
    ledger.bumpRevision();
    await persistLedger(ledger);
  }
}
```

### 8.3 落盘节奏 / Flush Cadence

| 时机 | 触发方式 | 强制级别 |
|---|---|---|
| Cache sync 全量同步完成（`cache_task_sync_complete`） | 事件触发 | 必 flush |
| 运行期定时（每 5s） | timer | 仅当 buffer 非空时 |
| Session 结束（PTY 退出 / WebSocket 断开） | 事件触发 | 必 flush |
| Server 优雅退出（`SIGTERM`） | 事件触发 | 必 flush |
| **启动期 ledger load 时**（Codex D4） | 加载后立即 | aging 扫描 + 必 flush（如果有过期清理） |

**5s 间隔取舍**：
- 太短（1s）：高频小写入消耗 IOPS，但 cache miss 是低频事件，写入量本来就小
- 太长（30s）：crash 后丢的 access 事件多
- **5s** 是合理折中

**Daemon 实时可见独立于落盘**：路径 2（推 daemon）每次 RPC 响应**立即**执行，不等 5s timer。落盘只影响"server 重启后 ledger 还在不在"，不影响"运行期 namespace 内 CC 看到的视图"。

**Crash 一致性**：5s 内未落盘的 events 丢失 → 下次启动重新学习（正确性不影响）。文件级原子写：`writeFile(tmp) + rename(tmp, final)` 保证不会写出半截 ledger。

**Daemon 持有 ledger 没记录的状态？**（Codex 提）：

会发生——比如路径 2 推 daemon 成功，然后 server 5s 内 crash，buffer 没落盘。下次启动 daemon 重启，没有这条 missing，daemon 恢复未学习状态。**这是接受的**——一致性保证是"ledger 落盘后 daemon 必然有"，反向不保证。下次会话会重新学，无功能损失。

---

## 9. Missing Entry 探测与失效 / Missing Detection & Invalidation

### 9.1 探测路径 / Detection Path

由 client 在 ENOENT 响应里顺便上报"最浅不存在祖先"（§6.2）。适用三个 op：`getattr`、`readdir`、`read`。client 端实现复杂度低（一路 `lstat` 父目录链 + root cap），无额外 RPC。

### 9.2 失效路径 / Invalidation Paths

需要清理 missing 条目的场景：

| 场景 | 清理范围 |
|---|---|
| `write/create/mkdir/truncate/setattr/chmod/rename(.newPath)` | newPath 所有祖先 missing 全部清掉 |
| Cache watcher 推 delta | 新增/变更 path 的所有祖先 missing 清掉，server 同时推 daemon `invalidate_negative_prefix` |
| 新 missing entry 写入 | 移除被新 ancestor 吸收的子 missing（NegativeCache.put 内部处理） |
| Aging（30 天未访问） | 启动期 + flush 时检查（§12） |

### 9.3 实现位置 / Implementation Locations

- **Server 端 ledger（绝对真相）**：`server/src/access-ledger.ts: invalidateMissingPrefixes`，用二级索引（sorted array）做 O(log N + k) 前缀清理
- **FUSE daemon 内 `_negative_perm`**：`server/src/fuse-host-script.ts: NegativeCache.invalidate_prefix`，由 server control msg 触发
- **Daemon 现有 `_cache.invalidate(path)` 扩展**（`fuse-host-script.ts:228`）：保持现有"精确匹配清理 stat/readdir/read 缓存"语义，**不**改成前缀匹配（这层是 path-precise 的，前缀清理交给 NegativeCache）

---

## 10. 跨 Device 借用与 Seed Whitelist / Cross-Device Borrow & Seed Whitelist

### 10.1 借用规则 / Borrow Rules

```
启动时 server 决定本 device 的 ledger 来源:

if exists(${CERELAY_DATA_DIR}/access-ledger/<deviceId>/ledger.json) and ledger.entries 非空:
    使用 per-device ledger        # 已建立工作集, 自给自足
else:
    使用 SeedWhitelist            # 冷启动, 借用全局种子
    [可选 V2] 用 union(其他 device 的 ledger 中跨用户共性条目) 增强
```

**关键**：一旦该 device 跑过任意一个 session 且产生过 access event flush，per-device ledger 就非空，之后**永远**只用自己的。

### 10.2 Seed Whitelist 来源 / Seed Whitelist Source

**Seed whitelist 是编译期静态常量**，运行时不读文件、不发请求、不做任何 IO 加载：

```typescript
// server/src/seed-whitelist.ts
// 由 capture 工具一次性产出, 直接 inline 进 ts 源码作为 const.
// 后续若需更新, 重跑 capture → 用产出覆写本文件 → commit.
export const SEED_WHITELIST: Readonly<SyncPlan> = Object.freeze({
  scopes: {
    "claude-home": Object.freeze({
      subtrees: [/* ... capture 实测填充 ... */] as const,
      files: [/* ... */] as const,
      knownMissing: [/* ... */] as const,
    }),
    // ...
  },
} as const);
```

**Capture 流程**（dev-time, 一次性）：

1. 加 capture 模式：`FileProxyManager` 加 `CERELAY_CAPTURE_SEED=path/to/output.json` 环境变量
2. capture 模式下：
   - **跳过 snapshot 反向构造**——不灌 daemon 任何 perm 缓存（避免命中后没 RPC，capture 不到该 path）
   - 所有 daemon 收到的 RPC path 全量记录写出 JSON
3. **使用真实 dev `~/.claude`** 跑 capture——不是干净环境（Codex F5）。理由：seed 的目标是覆盖**真实用户 warm-start 访问形态**（plugins cache、commands、agents 等），干净环境会漏掉这些场景
4. 跑常规 CC 启动 + 几个 prompt + `/agents` + `/commands` + 退出
5. 用 `scripts/seed-whitelist-codegen.ts` 把 capture JSON 转成 ts 源码，覆写 `server/src/seed-whitelist.ts`
6. **commit ts 文件** —— 之后运行时 `import { SEED_WHITELIST }` 是 v8 字面量，零 IO

**Fixture 内容预估**：

```
~150-300 个 path entries
~10-30 个 known-missing entries
ts 源码体积: < 50KB
```

---

## 11. 性能优化展望（V2）/ Performance Future Work (V2)

### 11.1 dirIndex 目录级 metadata 缓存（V2 future work）

**Codex 评审指出**当前 dirIndex 设计有以下未解决问题，**v1 不实现**：

1. **subtreeHash 递归依赖问题**：递归 hash 子目录的 subtreeHash 时，client 端温启动无变更场景仍需扫整棵子树才能 verify hash 没变——跟现状区别不大
2. **数据契约缺失**：`subtreeHash` 需要 children 的 `{name, type, size, mtime}`，但现有 manifest 只存文件 entries，不存目录元数据 / symlink 类型 / 空目录信息
3. **性能目标未验**：200-500ms 的目标依赖具体硬件 + ~/.claude 实际形态，必须基准测试后再设计
4. **跟 cache_task delta 的耦合**：每次 delta 触发祖先链 dirIndex 重算，可能成为新瓶颈

**V2 探索方向**（不在本期实施）：

- **方案 A**：用 mtime 聚合（`maxChildMtime` 递归向上）+ 直接子项 stat hash，不递归 hash 子目录的 hash
- **方案 B**：仅对"已知 read-only"子树（如 `plugins/cache/<vendor>/<plugin>/<version>/`）启用 dirIndex，CC 启动后该子树内容不变
- **方案 C**：让 client cache-sync 上传"目录级 metadata"（包括子目录 / symlink / 空目录），manifest 跟着扩展

实施 V2 时单独立 spec。**v1 性能基准实测后**再决定是否启动 V2。

### 11.2 cwd-ancestor `CLAUDE.md` / `CLAUDE.local.md` 加载（V2）

CC 启动期会沿 cwd 父链向上一路找到 homedir，加载每一级的 `CLAUDE.md` / `CLAUDE.local.md`（project memory）。当前 cerelay 架构下 CC **拿不到这些文件**——namespace bootstrap (`server/src/claude-session-runtime.ts:240-265`) 只 mount 三个 root，父链上的目录（如 `/Users/n374/Documents/`）根本不在 namespace 文件系统里，CC 直接 fs.readFile 也读 ENOENT。

**v1 不解决，作为 V2 候选独立 spec**。实施前置：

1. **namespace mount 层扩展**：增加 cwd 沿父链到 homedir 的 readonly bind mount，或设计一个新的 FUSE root（如 `cwd-ancestors`）覆盖父链
2. **client allowedPrefixes 扩展**：当前 `client/src/file-proxy.ts` 限定 client 只允许访问 `~/.claude` / `~/.claude.json` / `{cwd}/.claude` 三个前缀，需要扩展到允许父链 CLAUDE.md 文件
3. **本 spec 的 ledger / SyncPlan 扩展**：新 scope（`cwd-ancestor-md`）、SyncPlan 中动态枚举父链路径（`enumerateAncestorClaudeMd(cwd, homedir)`）、snapshot 反向构造覆盖到该 scope

**为什么 V2 而不是 v1**：v1 已经能搞定 home + project-claude 的核心机制（修 Defect 1/2/3 的主要价值）；ancestor 加载是 CC 的 **功能 gap**（不是 cache 优化），需要 namespace 层独立设计，跟 ledger 机制正交。先把 v1 跑通再处理。

### 11.3 Manifest blob 跨 cwd 内容寻址去重（V2）

当前 home scope 的 blob 在 `(deviceId, cwd)` 维度复制存储——同 device 下两个 cwd 的 ~/.claude 内容是两份。优化方向：让 blob 跨 cwd 共享（按 sha256 内容寻址 dedup）。

不在 v1 实施，因为：
- 节省的是磁盘空间（不是启动时间），收益有限
- 引入 manifest 跨 cwd 引用 blob 的 lifecycle 复杂度

---

## 12. Aging 策略 / Aging Strategy

### 12.1 规则 / Rule

**Aging 仅作用于 missing entries**——这是一个有意识的设计简化。

**Aging 规则**：

- `kind: "missing"` entry：`lastAccessedAt` 距今超过阈值（默认 30 天）→ 下次 ledger flush 时清理
- `kind: "file"` / `kind: "dir"` entry：**不被 aging 清理**——只能被 mutation invalidation（unlink/rmdir/rename）显式移除
- 阈值通过 env var `CERELAY_LEDGER_AGING_DAYS` 可调（默认 30）

**触发时机**：

- 启动期 ledger 加载后立即扫一次（保证长期不用的 server 重启时也能清掉历史包袱）
- 每次 flush 前顺便扫

**为什么 file/dir present 不 aging**：

| 担心 | 解释 |
|---|---|
| daemon perm hit 不刷 lastAccessedAt 导致 30 天后误清（Codex 新 F1） | file/dir present 不 aging，问题消失 |
| ledger 无界增长 | file/dir entry 受 mutation invalidation 自动收敛；user 实际访问过的路径数量有上限（一般几千到几万），ledger 体积可控（estimate < 5MB） |
| 已删除的文件/目录长期占 ledger | 由 mutation invalidation（`unlink` 移除 file entry，`rmdir` 移除整棵 dir 子树）+ cache_task watcher delta 处理；`rename` 也覆盖 |

**为什么 missing aging**：

| 原因 | 解释 |
|---|---|
| missing 是"否定证据"，可能因外部变更而变得错误（path 后来被创建） | watcher delta + write/create/mkdir invalidation 在 server 进程内能感知到的变更已经实时清理；30 天 aging 是兜底——给"server 长期没运行时外部建过文件再删"这种漏网场景 |
| 误清代价小 | 下次 access 重新学一次，一次 RPC 即恢复 |

### 12.2 边界 / Edge Cases

- **冷启动后立刻 flush**：missing 都很新，aging 不触发
- **长期不用**：超过 30 天没启动 server，第一次启动后 ledger 的 missing 大幅清空，file/dir 保留 → 退化为 SeedWhitelist + 重新学习 missing。**接受**
- **持续访问的 missing entry**：每次 access 都更新 `lastAccessedAt`，永远不会被 aging 误清
- **server cache hit 场景** + **daemon perm hit 场景**：file/dir present 不 aging，无须额外刷新机制。§4.4 的 `recordCacheHitAccess` 仅作为 lastAccessedAt 信号源（用于诊断 / 后续 V2 可能引入的 file aging），不影响 aging 决策

---

## 13. 边界 Case 与降级 / Edge Cases & Degradation

| 场景 | 行为 |
|---|---|
| ledger.json 损坏 / parse 失败 | 视为 ledger 不存在，走 SeedWhitelist。**同时清理对应 manifest+blob**（避免"ledger 空但 manifest 还在"的状态不一致），重新 cold-sync |
| ledger 写入失败（磁盘满 / 权限） | warn log，不阻塞；下次 session 用旧 ledger（最差只是没学到这次的新条目） |
| client 不发 syncPlan（hard switch 后视为 bug） | server 抛错并断开，要求重连——不静默降级 |
| client 上报 shallowestMissingAncestor 越界 root | server 校验后用原 path 写 ledger（§6.2） |
| missing 被 cache watcher 推回（外部创建） | 通过 §9.2 invalidation 路径清理，daemon 通过 control msg 失效本地 negative |
| 同 device 多 cwd 并发 session | ledger 写有 **per-deviceId mutex**（参考 `client-cache-store.ts: withManifestLock` 实现）。注意：mutex 是 per-deviceId 不是 per-(deviceId, cwd)——多 cwd 串行写避免主索引 + 二级索引一致性问题 |
| 用户切换 deviceId（删 `~/.config/cerelay/device-id`） | 视为新 device，走 SeedWhitelist。旧 ledger 留在磁盘，永不被使用，可手动清 |
| symlink 父链 / 大小写不敏感 fs（Codex D2） | 写入 ledger 前 path 规范化：`path.resolve(realpathSync.native(parent), basename)`（仅父目录 realpath），处理 macOS HFS+/APFS 大小写 + symlink resolve |
| readdir 不存在目录（旧 daemon 行为：转空目录）（Codex D3） | 新设计 daemon 不再 swallow ENOENT；若 client 端 readdir ENOENT 也带 shallowestMissingAncestor，server 走正常 missing 学习 |
| daemon control msg 丢失（OS pipe full / daemon 卡死） | server 写日志降级——不阻塞 RPC 响应。下次 daemon 重启后从 ledger 反向构造，自动恢复 |
| Aging 后 SyncPlan 缩到只有 SeedWhitelist | 接受——CC 启动后必读路径会立刻通过 access tracking 重新进 ledger |

---

## 14. 测试策略 / Test Strategy

### 14.1 单元测试 / Unit Tests

| 文件 | 覆盖 |
|---|---|
| `server/test/access-ledger.test.ts` | upsert / missing 塌缩 / 前缀 invalidation / aging / 持久化原子写 / parse 容错 / per-deviceId mutex / **二级索引（sorted array）正确性** |
| `server/test/sync-plan.test.ts` | 从 ledger 反向构造 plan / SeedWhitelist fallback / knownMissing 字段 / 去重 |
| `client/test/file-proxy-shallowest-ancestor.test.ts` | findShallowestMissingAncestor 正确性 / **root-cap 边界 / symlink / 大小写** / EACCES 不塌缩 |
| `server/test/file-proxy-manager-snapshot.test.ts` | snapshot 包含 ledger.missing 投影到本 session roots / 等 ready 阻塞行为 / phase=degraded 退化 |
| `server/test/fuse-negative-cache.test.ts` | **NegativeCache 前缀查询正确性** / put/invalidate_prefix / 子 missing 吸收 |
| `server/test/daemon-control-pipe.test.ts` | control msg 解析 / put_negative / invalidate_negative_prefix / 未知 type 静默忽略 |

### 14.2 集成测试 / Integration Tests

| 文件 | 场景 |
|---|---|
| `server/test/e2e-cache-cold-start.test.ts` | 冷启动: 空 ledger → seed plan → ready → snapshot 含 missing |
| `server/test/e2e-cache-warm-start.test.ts` | 温启动: 已有 ledger → plan 大幅缩窄 → ready < 1s |
| `server/test/e2e-cache-missing-invalidation.test.ts` | write 触发祖先 missing 清理（server 端 ledger + daemon `_negative_perm` 双侧） |
| `server/test/e2e-cache-cross-cwd.test.ts` | 同 device 切 cwd 时 ledger 共享、manifest 重新 sync |
| `server/test/e2e-mutation-ops-coverage.test.ts` | 9 种 mutation op (write/create/unlink/mkdir/rmdir/rename/truncate/setattr/chmod) 全部正确触发 ledger 更新 |

### 14.3 回归保护 / Regression Guard

- **defect 1 不复现**：`e2e-snapshot-waits-cache-ready.test.ts` 强制制造"snapshot 收集时机早于 cache ready"，验证现在会等
- **defect 2 不复现**：`e2e-runtime-negative-persisted.test.ts` 启动 → 探测某不存在路径 → flush ledger → 重启 → 同路径不再穿透 client
- **daemon negative prefix 命中**（Codex F4）：`e2e-daemon-negative-prefix.test.ts` 启动 → 注入 missing `/foo` → 探测 `/foo/bar/baz` 直接命中 ENOENT，**不**穿透
- **readdir ENOENT 不再被吃掉**：`e2e-readdir-enoent.test.ts` daemon 收到 ENOENT readdir 抛 ENOENT 而非空目录，client 也回报 missingAncestor

### 14.4 性能基准 / Performance Benchmark

实施后跑实测，目标：

| 指标 | 当前 | 目标 |
|---|---|---|
| 启动期 FUSE 穿透次数 | ~30+ | < 5 |
| 启动期 cache_task delta size (温) | ~MB 级 | < 100 KB |
| Snapshot collect 阶段耗时 | ~3s（含 client 全量 walk） | < 1s（温启动，plan 后 walk 极小） |
| 总启动期 (cache ready → CC 可用) | ~3.5s | < 2s |

---

## 15. 实施分阶段 / Implementation Phases

### Phase 1：基础设施

1. 新增 `server/src/access-ledger.ts` 模块（schema + 持久化 + 锁 + 二级索引 + aging）
2. 新增 `server/src/seed-whitelist.ts`（先放空 fixture，capture 后再填）
3. 新增 `server/src/sync-plan.ts` 模块（计算 plan，含 knownMissing 字段填充）
4. 单元测试覆盖以上三个模块（含二级索引正确性）

### Phase 2：协议同步扩展（两端必须一起改 - hard switch）

5. `server/src/protocol.ts` + `client/src/protocol.ts` 同步增加：
   - `SyncPlan` / `ScopeWalkInstruction`
   - `FileProxyResponse.shallowestMissingAncestor`
6. `cache_task_assignment` (server build + client receive) 携带 plan
7. `client/src/cache-sync.ts` 改造：从整树 walk 改为按 plan walk
8. `client/src/file-proxy.ts` 改造：ENOENT 响应顺带 `shallowestMissingAncestor`（带 root cap + path 规范化）
9. **不写 capability 降级路径**

### Phase 3：Daemon 协议扩展

10. `server/src/fuse-host-script.ts`：
    - 删除 `_negative` dict + TTL 相关代码
    - 新增 `NegativeCache` 类（前缀查询 / 前缀失效）
    - `is_negative` 改为前缀匹配
    - `readdir` ENOENT 不再 swallow 成空目录
    - `handle_control` 扩展三种新 msg type
11. 单元测试：NegativeCache 前缀查询 / control msg 解析

### Phase 4：Snapshot 整合

12. `FileProxyManager.collectAndWriteSnapshot` 改造：
    - 阻塞等 cache ready (无超时, Defect 1 修复)
    - snapshot 注入 ledger.missing（投影到本 session roots）
13. server → daemon 推送 control msg：把 ledger.missing 灌进 `_negative_perm`
14. 集成测试：冷启动 / 温启动 / 跨 cwd

### Phase 5：运行期 access tracking

15. `FileProxyManager.resolveResponse` 钩入 access event recording
16. `tryServeReadFromCache` 命中分支增加 `recordCacheHitAccess`（5s 防抖）
17. Session 结束 + 5s timer + sync_complete 三种 flush 触发
18. mutation ops 全覆盖（write/create/unlink/mkdir/rmdir/rename/truncate/setattr/chmod）
19. Aging（启动期 + flush 时）

### Phase 6：Seed Whitelist Capture

20. capture 模式开关（`CERELAY_CAPTURE_SEED=path`）+ 跳过 snapshot 反向构造
21. codegen 脚本 `scripts/seed-whitelist-codegen.ts`：JSON → ts const
22. 用 dev 真实 ~/.claude 跑 capture，commit `server/src/seed-whitelist.ts`
23. 性能基准实测，验证 §14.4 指标

### Phase 7：清理

24. 删除"phase=syncing 时直接 fallback 走 client 全量"的旧分支（仅 phase=degraded/idle 时才 fallback）
25. 删除 daemon Python 端 `_negative` dict + TTL 相关代码（`fuse-host-script.ts:80-86, 117-123, 126-130`）
26. 文档：本 spec 已在 [`docs/architecture.md`](../../architecture.md) §11 子文档索引登记

---

## 附录 A：与现状对比 / Appendix A: Diff vs Current

| 项 | 现状 | 新设计 |
|---|---|---|
| 同步范围 | 写死整棵 `~/.claude/` + `~/.claude.json` | 由 ledger 反向计算（home + json scope）；project-claude 沿用穿透 |
| 跨 cwd 切换 | 重新全量扫描 (~3s) | ledger 跨 cwd 共享访问历史 → walk 量极小；manifest+blob 仍 per-cwd 复制 |
| 不存在路径持久化 | 仅 broken symlink | 任何被探测过的 ENOENT，向上塌缩到最浅祖先 |
| Snapshot 与 cache 协调 | snapshot 抢跑导致 fallback | 阻塞等 ready，无超时 |
| Daemon 负缓存 | `_negative` TTL 30s + 进程内 + 精确匹配 | 无 TTL，从 ledger 持久投影 + 前缀匹配 |
| 跨 device 共享 | 无 | per-device 独立 ledger，冷启动用 SeedWhitelist 兜底 |
| Mutation ops 覆盖 | write/create/mkdir/rename | 现有 9 种 op（含 unlink/rmdir/truncate/setattr/chmod）全覆盖 |
| readdir ENOENT 处理 | swallow 成空目录 | 抛 ENOENT，触发 missing 学习 |
| cwd-ancestor `CLAUDE.md` | **不覆盖**（架构限制 - 不在 namespace mount 范围） | **v1 不处理**（NG4），列入 §11.2 V2 候选；待 namespace mount 层扩展后实施 |

## 附录 B：关键文件位置 / Appendix B: Key File Locations

| 文件 | 角色 |
|---|---|
| `server/src/access-ledger.ts` | **新增** AccessLedger 模块（schema / 持久化 / per-device 锁 / 二级索引 / aging） |
| `server/src/sync-plan.ts` | **新增** SyncPlan 计算（ledger 反向构造 + seed fallback） |
| `server/src/seed-whitelist.ts` | **新增** Seed fixture 静态 const（capture codegen 产物） |
| `server/src/file-proxy-manager.ts` | 改造：阻塞等 ready (无超时) / snapshot 注入 missing / access event recording / 实时推 daemon control msg / cache hit 刷 lastAccessedAt |
| `server/src/cache-task-manager.ts` | 改造：assignment 携带 plan |
| `server/src/client-cache-store.ts` | 改造：sync 范围由 plan 决定（manifest schema 不动） |
| `server/src/fuse-host-script.ts` | 改造：删 `_negative` + TTL；新增 `NegativeCache` 类（前缀语义）；readdir ENOENT 不再 swallow；control msg 扩展三种 type |
| `server/src/protocol.ts` | 改造：新协议字段 (SyncPlan / shallowestMissingAncestor) |
| `client/src/cache-sync.ts` | 改造：按 plan walk |
| `client/src/file-proxy.ts` | 改造：ENOENT 顺带 ancestor + root cap + path 规范化 |
| `client/src/cache-task-state-machine.ts` | 改造：处理 syncPlan |
| `client/src/protocol.ts` | 改造：新协议字段 |
| `scripts/seed-whitelist-codegen.ts` | **新增** capture JSON → ts const 转换器 |

## 附录 C：术语 / Appendix C: Glossary

- **AccessLedger**：跨 session 持久化的"路径访问历史"账本，三类 entry: file/dir/missing
- **SyncPlan**：每次建联根据 ledger 动态计算的"本次该同步什么"指令，按 scope 分组
- **Shallowest Missing Ancestor**：path ENOENT 时，沿父链向上找到的第一个不存在的目录（即"塌缩后的 missing"），cap 在本 session FUSE root 内
- **Seed Whitelist**：代码内置 ts const 的全局种子白名单，仅在 ledger 完全空时作为冷启动初始 plan
- **NegativeCache**：FUSE daemon 内 `_negative_perm` 的新数据结构，sorted list + bisect，支持前缀查询和前缀失效
- **Control Pipe**：FUSE daemon 启动时 server 给的 fd，用于 server → daemon 单向推送 fire-and-forget 指令（shutdown / put_negative / invalidate_negative_prefix / invalidate_cache）
- **Defect 1**：snapshot 收集发生在 cache ready 之前导致的"phase_syncing 抢跑"bug
- **Defect 2**：FUSE daemon 运行期负缓存仅进程内有效、不持久化的现状
