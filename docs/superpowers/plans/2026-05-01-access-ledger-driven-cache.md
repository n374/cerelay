# Access-Ledger 驱动的 Cache 重构 / Access-Ledger-Driven Cache Refactor — Implementation Plan

> **状态 / Status**: Implemented (master @ 1610514). 7 个 Phase 全部落地.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## 实施总结 / Implementation Summary

- **31 个 commit** (`9aba1e2` → `1610514`), 含 4 个修复 commit (Phase 3 fix / Defect 1 fix / Defect 2 fix / SyncPlan 中间目录补齐)
- **server tests**: 305 / 300 pass / 5 skipped / 0 fail; **client tests**: 135 / 135 pass / 0 fail
- **关键 e2e 防穿透回归**:
  - `e2e-runtime-negative-persisted.test.ts`: 跨 session missing 持久化端到端
  - `e2e-daemon-no-perforation.test.ts`: spawn python3 跑 daemon 简化链路, mock send_request 计数, 编程化断言"已注入 path 不穿透"
  - `e2e-cross-cwd-and-mutations.test.ts`: 跨 cwd 共享 + 9 种 mutation op 全覆盖
- **没在 macOS 跑 capture 跑性能基准**(spawn FUSE 限制):
  - SeedWhitelist 用 hand-curated minimal fixture (基于 CC 已知行为 + 用户实测日志). 后续可由 `scripts/seed-whitelist-codegen.ts` 用真实 capture 数据覆写
  - 性能基准需要 Linux + docker 环境实测 (见 §14.4 目标), 单元/集成测试已覆盖正确性
- **V2 候选** (本期不实施): cwd-ancestor `CLAUDE.md` / dirIndex / blob 跨 cwd 去重

**Goal:** 把当前两套并存的"启动期文件加速"机制（ClientCacheStore manifest+blob、FUSE snapshot 预热）整合到一个由 AccessLedger 驱动的统一架构，修复 Defect 1 (snapshot 抢跑) 和 Defect 2 (负缓存不持久)。

**Architecture:** 新增 `AccessLedger`（per-deviceId 持久化访问账本，三类 entry: file_present / dir_present / missing）+ `SyncPlan`（每次建联从 ledger 反向构造的同步指令）+ `SeedWhitelist`（编译期静态 const，冷启动用）。FUSE daemon 的 `_negative_perm` 改为前缀查询数据结构 `NegativeCache`，从 ledger 实时投影。所有协议 hard-switch（无兼容降级）。

**Tech Stack:** TypeScript (Node.js ESM, server + client), Python (FUSE daemon, fuse-host-script.ts), JSON-RPC over stdio + control pipe, Node.js native test runner (`node --test`), WebSocket (existing, unchanged).

**Spec:** [`docs/superpowers/specs/2026-05-01-access-ledger-driven-cache-design.md`](../specs/2026-05-01-access-ledger-driven-cache-design.md)

---

## File Structure

### New Files

| File | Responsibility |
|---|---|
| `server/src/access-ledger.ts` | AccessLedger schema、持久化、per-deviceId 锁、二级索引、aging |
| `server/src/sync-plan.ts` | SyncPlan 计算（ledger 反向构造 + SeedWhitelist fallback） |
| `server/src/seed-whitelist.ts` | 静态 const SEED_WHITELIST + types（capture 后填充） |
| `server/src/path-normalize.ts` | `probeCaseSensitivity()` + `normalizeLedgerPath()` |
| `server/src/daemon-control.ts` | DaemonControlClient 类（向 daemon control pipe 推送 fire-and-forget 消息） |
| `scripts/seed-whitelist-codegen.ts` | capture JSON → ts const 的代码生成器 |
| `server/test/access-ledger.test.ts` | AccessLedger 单测 |
| `server/test/sync-plan.test.ts` | SyncPlan 单测 |
| `server/test/path-normalize.test.ts` | 路径规范化单测 |
| `server/test/daemon-control.test.ts` | DaemonControlClient 单测（mock control pipe） |
| `server/test/fuse-negative-cache.py-test.ts` | 跑 daemon Python 子进程 + 喂 control msg 验证 NegativeCache 行为 |
| `client/test/file-proxy-shallowest-ancestor.test.ts` | findShallowestMissingAncestor 单测 |
| `server/test/e2e-cache-cold-start.test.ts` | E2E: ledger 空 → seed plan → ready |
| `server/test/e2e-cache-warm-start.test.ts` | E2E: 温启动 plan 缩窄 → ready < 1s |
| `server/test/e2e-cache-missing-invalidation.test.ts` | E2E: write 触发祖先 missing 清理双侧 |
| `server/test/e2e-cache-cross-cwd.test.ts` | E2E: 切 cwd 时 ledger 复用 |
| `server/test/e2e-mutation-ops-coverage.test.ts` | E2E: 9 种 mutation op 覆盖 |
| `server/test/e2e-snapshot-waits-cache-ready.test.ts` | 回归: defect 1 不复现 |
| `server/test/e2e-runtime-negative-persisted.test.ts` | 回归: defect 2 不复现 |
| `server/test/e2e-daemon-negative-prefix.test.ts` | 回归: daemon 前缀命中 |
| `server/test/e2e-readdir-enoent.test.ts` | 回归: readdir ENOENT 不再 swallow |

### Modified Files

| File | 改动 |
|---|---|
| `server/src/protocol.ts` | 新增 `SyncPlan` / `ScopeWalkInstruction` / `FileProxyResponse.shallowestMissingAncestor` |
| `client/src/protocol.ts` | 同步 protocol.ts 的所有变更 |
| `server/src/file-proxy-manager.ts` | snapshot 阻塞等 ready / 注入 ledger.missing / access event recording / cache hit 刷新 / 删 phase=syncing fallback |
| `server/src/fuse-host-script.ts` | 删 `_negative` dict + TTL；新增 `NegativeCache` 类（前缀语义）；readdir ENOENT 不再 swallow；`handle_control` 扩展 3 种新 msg type |
| `server/src/cache-task-manager.ts` | `buildActiveAssignment` 携带 plan |
| `server/src/client-cache-store.ts` | applyDelta 时按 plan 范围（schema 不动） |
| `client/src/cache-sync.ts` | `walkScope` 改为按 plan 子树/文件 walk |
| `client/src/file-proxy.ts` | ENOENT 响应增加 `shallowestMissingAncestor` 字段（带 root cap + 路径规范化） |
| `client/src/cache-task-state-machine.ts` | 处理 syncPlan，传给 cache-sync |
| `server/src/index.ts` | 启动时 probe case sensitivity + load AccessLedger |

---

## Phase 1: 基础设施 / Foundation

### Task 1.1: AccessLedger 数据结构 + 内存索引

**Files:**
- Create: `server/src/access-ledger.ts`
- Test: `server/test/access-ledger.test.ts`

**完成标准**：定义 schema + 三个二级索引（`missingSorted`, `allPathsSorted`, `dirsReaddirObserved`），主索引 + 二级索引同步维护，**未持久化、未 mutex**。

- [ ] **Step 1: 写失败测试**

```typescript
// server/test/access-ledger.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { AccessLedgerRuntime } from "../src/access-ledger.js";

test("upsertFilePresent 维护 entries + allPathsSorted", () => {
  const ledger = new AccessLedgerRuntime("dev1");
  ledger.upsertFilePresent("/Users/foo/.claude/skills/a", 1000);
  ledger.upsertFilePresent("/Users/foo/.claude/skills/b", 2000);
  assert.deepEqual(ledger.toJSON().entries["/Users/foo/.claude/skills/a"], {
    kind: "file",
    lastAccessedAt: 1000,
  });
  assert.deepEqual(ledger.allPathsSortedSnapshot(), [
    "/Users/foo/.claude/skills/a",
    "/Users/foo/.claude/skills/b",
  ]);
});

test("upsertDirPresent readdirObserved 默认 false 升级 true", () => {
  const ledger = new AccessLedgerRuntime("dev1");
  ledger.upsertDirPresent("/foo/bar", 1000, /*readdirObserved*/ false);
  ledger.upsertDirPresent("/foo/bar", 2000, /*readdirObserved*/ true);
  const entry = ledger.toJSON().entries["/foo/bar"];
  assert.equal(entry?.kind, "dir");
  if (entry?.kind === "dir") {
    assert.equal(entry.readdirObserved, true);
    assert.equal(entry.lastAccessedAt, 2000);
  }
  assert.ok(ledger.dirsReaddirObservedSnapshot().has("/foo/bar"));
});

test("upsertDirPresent 二次 upsert false 不降级 true", () => {
  const ledger = new AccessLedgerRuntime("dev1");
  ledger.upsertDirPresent("/foo/bar", 1000, /*readdirObserved*/ true);
  ledger.upsertDirPresent("/foo/bar", 2000, /*readdirObserved*/ false);
  const entry = ledger.toJSON().entries["/foo/bar"];
  if (entry?.kind === "dir") assert.equal(entry.readdirObserved, true);
});

test("removeFilePresent 同步删除主索引和二级索引", () => {
  const ledger = new AccessLedgerRuntime("dev1");
  ledger.upsertFilePresent("/foo", 1000);
  ledger.removeFilePresent("/foo");
  assert.equal(ledger.toJSON().entries["/foo"], undefined);
  assert.deepEqual(ledger.allPathsSortedSnapshot(), []);
});
```

- [ ] **Step 2: 实现 AccessLedger 模块**

```typescript
// server/src/access-ledger.ts
export interface AccessLedgerData {
  version: 1;
  deviceId: string;
  revision: number;
  entries: Record<string, AccessLedgerEntry>;
}

export type AccessLedgerEntry =
  | { kind: "file"; lastAccessedAt: number }
  | { kind: "dir"; lastAccessedAt: number; readdirObserved: boolean }
  | { kind: "missing"; lastAccessedAt: number };

export class AccessLedgerRuntime {
  private entries = new Map<string, AccessLedgerEntry>();
  private missingSorted: string[] = [];
  private allPathsSorted: string[] = [];
  private dirsReaddirObserved = new Set<string>();
  private revision = 0;

  constructor(public readonly deviceId: string) {}

  // 测试钩子
  toJSON(): AccessLedgerData {
    return {
      version: 1,
      deviceId: this.deviceId,
      revision: this.revision,
      entries: Object.fromEntries(this.entries),
    };
  }
  allPathsSortedSnapshot(): string[] { return [...this.allPathsSorted]; }
  missingSortedSnapshot(): string[] { return [...this.missingSorted]; }
  dirsReaddirObservedSnapshot(): Set<string> { return new Set(this.dirsReaddirObserved); }

  upsertFilePresent(path: string, lastAccessedAt: number): void {
    const existed = this.entries.has(path);
    const prev = this.entries.get(path);
    // kind 切换 (dir → file): 清理 dirsReaddirObserved
    if (prev?.kind === "dir") this.dirsReaddirObserved.delete(path);
    if (prev?.kind === "missing") this.removeFromSorted(this.missingSorted, path);
    this.entries.set(path, { kind: "file", lastAccessedAt });
    if (!existed) this.insertSorted(this.allPathsSorted, path);
  }

  upsertDirPresent(path: string, lastAccessedAt: number, readdirObserved: boolean): void {
    const prev = this.entries.get(path);
    const existed = !!prev;
    const prevReaddir = prev?.kind === "dir" ? prev.readdirObserved : false;
    // readdirObserved 单调升: 一旦为 true 不能降级
    const finalReaddir = prevReaddir || readdirObserved;
    if (prev?.kind === "missing") this.removeFromSorted(this.missingSorted, path);
    this.entries.set(path, { kind: "dir", lastAccessedAt, readdirObserved: finalReaddir });
    if (!existed) this.insertSorted(this.allPathsSorted, path);
    if (finalReaddir) this.dirsReaddirObserved.add(path);
  }

  removeFilePresent(path: string): void {
    if (this.entries.delete(path)) {
      this.removeFromSorted(this.allPathsSorted, path);
    }
  }

  // upsertMissing / invalidateMissingPrefixes / removeDirSubtree / renameSubtree / touchIfPresent
  // 由 Task 1.3 / 1.4 / 1.5 实现
  bumpRevision(): void { this.revision += 1; }

  private insertSorted(arr: string[], item: string): void {
    const idx = lowerBound(arr, item);
    if (arr[idx] !== item) arr.splice(idx, 0, item);
  }
  private removeFromSorted(arr: string[], item: string): void {
    const idx = lowerBound(arr, item);
    if (arr[idx] === item) arr.splice(idx, 1);
  }
}

// 二分查找首个 >= item 的位置
export function lowerBound(arr: string[], item: string): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < item) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
```

- [ ] **Step 3: 跑单测验证**

Run: `cd /Users/n374/Documents/Code/cerelay/server && ~/go-not-applicable && node --import tsx --test test/access-ledger.test.ts`

注：cerelay 是纯 TS 项目不走 go.mod，用 npm scripts 即可。实际命令：

```bash
cd server && npm test -- test/access-ledger.test.ts
```

Expected: 4 tests pass。

- [ ] **Step 4: Commit**

```bash
git add server/src/access-ledger.ts server/test/access-ledger.test.ts
git commit -m "$(cat <<'EOF'
🌱 新增 / New: AccessLedger 数据结构与二级索引 / data structure with secondary indices

- AccessLedgerRuntime 维护 entries / allPathsSorted / missingSorted / dirsReaddirObserved
- upsertFilePresent / upsertDirPresent / removeFilePresent 同步主+二级索引
- readdirObserved 单调升语义 (一旦 true 不可降级 false)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.2: AccessLedger 持久化 + 原子写

**Files:**
- Modify: `server/src/access-ledger.ts`
- Test: `server/test/access-ledger.test.ts` (extend)

**完成标准**：`AccessLedgerStore` 类，`load(deviceId)` / `persist(runtime)` 走 atomic write (`tmp + rename`)，损坏文件视为不存在。

- [ ] **Step 1: 写失败测试**

```typescript
// 追加到 server/test/access-ledger.test.ts
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AccessLedgerStore } from "../src/access-ledger.js";

test("AccessLedgerStore persist + load roundtrip", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ledger-"));
  const store = new AccessLedgerStore({ dataDir: dir });
  const runtime = new AccessLedgerRuntime("dev-A");
  runtime.upsertFilePresent("/foo/bar", 12345);
  runtime.bumpRevision();
  await store.persist(runtime);

  const loaded = await store.load("dev-A");
  assert.equal(loaded.deviceId, "dev-A");
  assert.equal(loaded.toJSON().entries["/foo/bar"]?.lastAccessedAt, 12345);
  assert.deepEqual(loaded.allPathsSortedSnapshot(), ["/foo/bar"]);
});

test("AccessLedgerStore load 不存在文件返回空 runtime", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ledger-"));
  const store = new AccessLedgerStore({ dataDir: dir });
  const loaded = await store.load("dev-NEW");
  assert.equal(loaded.deviceId, "dev-NEW");
  assert.deepEqual(loaded.allPathsSortedSnapshot(), []);
});

test("AccessLedgerStore load 损坏文件回空 runtime", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ledger-"));
  const ledgerPath = path.join(dir, "access-ledger", "dev-CORRUPT", "ledger.json");
  const fs = await import("node:fs/promises");
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.writeFile(ledgerPath, "{not valid json", "utf8");
  const store = new AccessLedgerStore({ dataDir: dir });
  const loaded = await store.load("dev-CORRUPT");
  assert.deepEqual(loaded.allPathsSortedSnapshot(), []);
});

test("AccessLedgerStore persist 原子: tmp + rename, 不留 tmp 残留", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ledger-"));
  const store = new AccessLedgerStore({ dataDir: dir });
  const runtime = new AccessLedgerRuntime("dev-B");
  runtime.upsertFilePresent("/baz", 1);
  await store.persist(runtime);

  const sessionDir = path.join(dir, "access-ledger", "dev-B");
  const files = (await import("node:fs/promises")).readdir(sessionDir);
  for (const name of await files) {
    assert.ok(!name.startsWith("ledger.json.tmp-"), `不该有 tmp 残留: ${name}`);
  }
});
```

- [ ] **Step 2: 实现 AccessLedgerStore**

```typescript
// 追加到 server/src/access-ledger.ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "./logger.js";

const log = createLogger("access-ledger");

export interface AccessLedgerStoreOptions {
  dataDir: string;
}

export class AccessLedgerStore {
  constructor(private readonly options: AccessLedgerStoreOptions) {}

  rootDir(): string {
    return path.join(this.options.dataDir, "access-ledger");
  }

  private deviceDir(deviceId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(deviceId) || deviceId.length > 128) {
      throw new Error(`invalid deviceId: ${deviceId}`);
    }
    return path.join(this.rootDir(), deviceId);
  }

  private ledgerPath(deviceId: string): string {
    return path.join(this.deviceDir(deviceId), "ledger.json");
  }

  async load(deviceId: string): Promise<AccessLedgerRuntime> {
    const runtime = new AccessLedgerRuntime(deviceId);
    try {
      const raw = await readFile(this.ledgerPath(deviceId), "utf8");
      const data = JSON.parse(raw) as AccessLedgerData;
      if (data?.version === 1 && data.entries) {
        // 从主索引重建二级索引
        for (const [k, v] of Object.entries(data.entries)) {
          if (v.kind === "file") runtime.upsertFilePresent(k, v.lastAccessedAt);
          else if (v.kind === "dir") runtime.upsertDirPresent(k, v.lastAccessedAt, v.readdirObserved);
          // missing 由 Task 1.3 的 upsertMissing 处理
        }
        // bump revision 到 load 值 (避免 persist 时回退)
        runtime.setRevision(data.revision);
      }
    } catch (err) {
      // ENOENT / parse 错误都视为新 ledger
      log.debug("ledger load 回空", { deviceId, error: (err as Error).message });
    }
    return runtime;
  }

  async persist(runtime: AccessLedgerRuntime): Promise<void> {
    const filePath = this.ledgerPath(runtime.deviceId);
    await mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    const data = JSON.stringify(runtime.toJSON(), null, 2) + "\n";
    await writeFile(tmpPath, data, "utf8");
    await rename(tmpPath, filePath);
  }
}

// 给 AccessLedgerRuntime 加 setRevision (load 时使用)
// 在 AccessLedgerRuntime 类内追加:
//   setRevision(rev: number): void { this.revision = rev; }
```

- [ ] **Step 3: 跑测试**

```bash
cd server && npm test -- test/access-ledger.test.ts
```

Expected: 7 tests pass（4 + 3 新加）。

- [ ] **Step 4: Commit**

```bash
git add server/src/access-ledger.ts server/test/access-ledger.test.ts
git commit -m "$(cat <<'EOF'
🌱 新增 / New: AccessLedgerStore 持久化 / persistence with atomic write

- load(deviceId) ENOENT/损坏 → 回空 runtime
- persist 走 tmp + rename 原子写
- load 时从主索引重建 file/dir 二级索引

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.3: AccessLedger upsertMissing（含吸收子 missing）

**Files:**
- Modify: `server/src/access-ledger.ts`
- Test: `server/test/access-ledger.test.ts`

**完成标准**：`upsertMissing(ancestor)` 用 `lowerBound` 二分定位，吸收所有 `ancestor + "/" + ...` 子条目，单测覆盖嵌套吸收 + 重复 upsert 幂等。

- [ ] **Step 1: 写失败测试**

```typescript
test("upsertMissing 写入新 missing entry", () => {
  const ledger = new AccessLedgerRuntime("dev1");
  ledger.upsertMissing("/foo/bar", 1000);
  assert.deepEqual(ledger.missingSortedSnapshot(), ["/foo/bar"]);
  assert.deepEqual(ledger.allPathsSortedSnapshot(), ["/foo/bar"]);
  assert.equal(ledger.toJSON().entries["/foo/bar"]?.kind, "missing");
});

test("upsertMissing 吸收已存在的子 missing", () => {
  const ledger = new AccessLedgerRuntime("dev1");
  ledger.upsertMissing("/foo/bar/x", 1000);
  ledger.upsertMissing("/foo/bar/y", 1100);
  ledger.upsertMissing("/foo/bar/z/deep", 1200);
  // 现在塌缩到 /foo/bar
  ledger.upsertMissing("/foo/bar", 2000);
  assert.deepEqual(ledger.missingSortedSnapshot(), ["/foo/bar"]);
  assert.equal(ledger.toJSON().entries["/foo/bar/x"], undefined);
  assert.equal(ledger.toJSON().entries["/foo/bar/y"], undefined);
  assert.equal(ledger.toJSON().entries["/foo/bar/z/deep"], undefined);
});

test("upsertMissing 重复幂等更新 lastAccessedAt", () => {
  const ledger = new AccessLedgerRuntime("dev1");
  ledger.upsertMissing("/foo", 1000);
  ledger.upsertMissing("/foo", 5000);
  const entry = ledger.toJSON().entries["/foo"];
  assert.equal(entry?.kind, "missing");
  assert.equal(entry?.lastAccessedAt, 5000);
  assert.deepEqual(ledger.missingSortedSnapshot(), ["/foo"]);
});

test("upsertMissing 已存在子 missing 时 ancestor 路径相同时不重复加入 sorted", () => {
  const ledger = new AccessLedgerRuntime("dev1");
  ledger.upsertMissing("/a", 1);
  ledger.upsertMissing("/a/b", 2); // 应被忽略 (祖先已 missing)
  // 业务: 写之前可以选择忽略 (caller 检查) 或 store 内自动检查;
  // 我们采用 store 内检查: 若有更浅 missing 祖先, 不写
  assert.deepEqual(ledger.missingSortedSnapshot(), ["/a"]);
});
```

- [ ] **Step 2: 实现 upsertMissing + 辅助方法**

```typescript
// 在 AccessLedgerRuntime 内追加:
upsertMissing(ancestor: string, lastAccessedAt: number): void {
  // 1. 检查是否已被更浅 ancestor 覆盖 — 沿父链查 missing
  if (this.hasMissingAncestorOf(ancestor)) {
    // 已被覆盖, 仅更新 ancestor 自身的 lastAccessedAt 如果就是它本身
    const existing = this.entries.get(ancestor);
    if (existing?.kind === "missing" && lastAccessedAt > existing.lastAccessedAt) {
      this.entries.set(ancestor, { kind: "missing", lastAccessedAt });
    }
    return;
  }

  // 2. 吸收子 missing: bisect 找到 [ancestor + "/"... 区间, 全部删
  const prefix = ancestor + "/";
  let idx = lowerBound(this.missingSorted, prefix);
  const toAbsorb: string[] = [];
  while (idx < this.missingSorted.length && this.missingSorted[idx].startsWith(prefix)) {
    toAbsorb.push(this.missingSorted[idx]);
    idx++;
  }
  for (const absorbed of toAbsorb) {
    this.entries.delete(absorbed);
    this.removeFromSorted(this.missingSorted, absorbed);
    this.removeFromSorted(this.allPathsSorted, absorbed);
  }

  // 3. 写入 ancestor 自身
  const existed = this.entries.has(ancestor);
  this.entries.set(ancestor, { kind: "missing", lastAccessedAt });
  if (!existed) {
    this.insertSorted(this.missingSorted, ancestor);
    this.insertSorted(this.allPathsSorted, ancestor);
  } else {
    // ancestor 已存在但可能不是 missing kind (如之前是 file/dir 转 missing)
    // 此情况罕见(文件被删后 stat ENOENT), 修正二级索引:
    if (!this.missingSorted.includes(ancestor)) {
      this.insertSorted(this.missingSorted, ancestor);
    }
    this.dirsReaddirObserved.delete(ancestor);
  }
}

private hasMissingAncestorOf(path: string): boolean {
  // 沿父链向上检查 missingSorted
  let current = path;
  while (current !== "/" && current !== "") {
    const parent = pathDirname(current);
    if (parent === current) break;
    if (this.entries.get(parent)?.kind === "missing") return true;
    current = parent;
  }
  return false;
}

// 顶部 import:
import { dirname as pathDirname } from "node:path/posix";
```

注: 全部 path 用 posix 风格（forward slash）；client 端写入前规范化（Task 1.8）。

- [ ] **Step 3: 跑测试**

```bash
cd server && npm test -- test/access-ledger.test.ts
```

Expected: 11 tests pass。

- [ ] **Step 4: Commit**

```bash
git add server/src/access-ledger.ts server/test/access-ledger.test.ts
git commit -m "$(cat <<'EOF'
🌱 新增 / New: AccessLedger upsertMissing 含子 missing 吸收 / with child missing absorption

- 写入前检查更浅 ancestor; 已被覆盖则跳过
- 吸收子 missing 范围 (bisect 定位 + 顺序删)
- 重复 upsert 幂等, 仅刷新 lastAccessedAt

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.4: AccessLedger invalidateMissingPrefixes + removeDirSubtree + renameSubtree + touchIfPresent

**Files:**
- Modify: `server/src/access-ledger.ts`
- Test: `server/test/access-ledger.test.ts`

**完成标准**：4 个方法实现，覆盖 mutation event 模型的 9 种 op 全部场景。

- [ ] **Step 1: 写失败测试**

```typescript
test("invalidateMissingPrefixes 移除所有祖先 missing", () => {
  const ledger = new AccessLedgerRuntime("dev1");
  ledger.upsertMissing("/a/b", 1000);
  ledger.upsertMissing("/c", 2000);
  // 创建 /a/b/c/file → 清理 /a/b
  ledger.invalidateMissingPrefixes("/a/b/c/file");
  assert.deepEqual(ledger.missingSortedSnapshot(), ["/c"]);
});

test("invalidateMissingPrefixes 路径自身就是 missing 时也清理", () => {
  const ledger = new AccessLedgerRuntime("dev1");
  ledger.upsertMissing("/a/b", 1);
  ledger.invalidateMissingPrefixes("/a/b");
  assert.deepEqual(ledger.missingSortedSnapshot(), []);
});

test("removeDirSubtree 移除目录及所有 subentries", () => {
  const ledger = new AccessLedgerRuntime("dev1");
  ledger.upsertDirPresent("/foo", 1, true);
  ledger.upsertFilePresent("/foo/a", 2);
  ledger.upsertFilePresent("/foo/b", 3);
  ledger.upsertDirPresent("/foo/sub", 4, false);
  ledger.upsertFilePresent("/other", 5);
  ledger.removeDirSubtree("/foo");
  assert.deepEqual(ledger.allPathsSortedSnapshot(), ["/other"]);
});

test("renameSubtree 把整棵子树搬到新路径", () => {
  const ledger = new AccessLedgerRuntime("dev1");
  ledger.upsertDirPresent("/old", 1, true);
  ledger.upsertFilePresent("/old/a", 2);
  ledger.upsertFilePresent("/old/sub/b", 3);
  ledger.renameSubtree("/old", "/new");
  assert.deepEqual(ledger.allPathsSortedSnapshot().sort(), [
    "/new", "/new/a", "/new/sub/b",
  ]);
});

test("touchIfPresent 仅刷新已存在 entry 的 lastAccessedAt", () => {
  const ledger = new AccessLedgerRuntime("dev1");
  ledger.upsertFilePresent("/foo", 1000);
  ledger.touchIfPresent("/foo", 5000);
  ledger.touchIfPresent("/bar", 6000); // /bar 不存在 → no-op
  assert.equal(ledger.toJSON().entries["/foo"]?.lastAccessedAt, 5000);
  assert.equal(ledger.toJSON().entries["/bar"], undefined);
});
```

- [ ] **Step 2: 实现 4 个方法**

```typescript
// AccessLedgerRuntime 内追加:

invalidateMissingPrefixes(path: string): void {
  // 沿父链向上检查并清理所有 missing 祖先 (含 path 自身若是 missing)
  let current = path;
  while (current !== "/" && current !== "") {
    if (this.entries.get(current)?.kind === "missing") {
      this.entries.delete(current);
      this.removeFromSorted(this.missingSorted, current);
      this.removeFromSorted(this.allPathsSorted, current);
    }
    const parent = pathDirname(current);
    if (parent === current) break;
    current = parent;
  }
}

removeDirSubtree(dirPath: string): void {
  // 移除 dirPath 自身和所有 dirPath + "/..." 子条目
  const prefix = dirPath + "/";
  let idx = lowerBound(this.allPathsSorted, dirPath);
  const toDelete: string[] = [];
  while (idx < this.allPathsSorted.length) {
    const p = this.allPathsSorted[idx];
    if (p === dirPath || p.startsWith(prefix)) {
      toDelete.push(p);
      idx++;
    } else {
      break;
    }
  }
  for (const p of toDelete) {
    this.entries.delete(p);
    this.removeFromSorted(this.allPathsSorted, p);
    this.removeFromSorted(this.missingSorted, p);
    this.dirsReaddirObserved.delete(p);
  }
}

renameSubtree(oldPath: string, newPath: string): void {
  const prefix = oldPath + "/";
  let idx = lowerBound(this.allPathsSorted, oldPath);
  const toMove: Array<{ from: string; to: string; entry: AccessLedgerEntry }> = [];
  while (idx < this.allPathsSorted.length) {
    const p = this.allPathsSorted[idx];
    let to: string | null = null;
    if (p === oldPath) to = newPath;
    else if (p.startsWith(prefix)) to = newPath + p.slice(oldPath.length);
    else break;
    const entry = this.entries.get(p)!;
    toMove.push({ from: p, to, entry });
    idx++;
  }
  // 先全部删 (避免 from/to 重叠时 sorted array 状态紊乱)
  for (const { from } of toMove) {
    this.entries.delete(from);
    this.removeFromSorted(this.allPathsSorted, from);
    this.removeFromSorted(this.missingSorted, from);
    this.dirsReaddirObserved.delete(from);
  }
  // 再全部加
  for (const { to, entry } of toMove) {
    this.entries.set(to, entry);
    this.insertSorted(this.allPathsSorted, to);
    if (entry.kind === "missing") this.insertSorted(this.missingSorted, to);
    if (entry.kind === "dir" && entry.readdirObserved) this.dirsReaddirObserved.add(to);
  }
}

touchIfPresent(path: string, lastAccessedAt: number): void {
  const entry = this.entries.get(path);
  if (!entry) return;
  // 只更新 lastAccessedAt, 不改 kind
  if (entry.kind === "file") {
    this.entries.set(path, { kind: "file", lastAccessedAt });
  } else if (entry.kind === "dir") {
    this.entries.set(path, { kind: "dir", lastAccessedAt, readdirObserved: entry.readdirObserved });
  } else if (entry.kind === "missing") {
    this.entries.set(path, { kind: "missing", lastAccessedAt });
  }
}
```

- [ ] **Step 3: 跑测试**

Run: `cd server && npm test -- test/access-ledger.test.ts`
Expected: 16 tests pass。

- [ ] **Step 4: Commit**

```bash
git add server/src/access-ledger.ts server/test/access-ledger.test.ts
git commit -m "🌱 新增 / New: AccessLedger 失效与变更操作 / invalidation and mutation ops

invalidateMissingPrefixes / removeDirSubtree / renameSubtree / touchIfPresent

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.5: AccessLedger aging（仅 missing）+ per-deviceId mutex

**Files:**
- Modify: `server/src/access-ledger.ts`
- Test: `server/test/access-ledger.test.ts`

**完成标准**：`runAging(now, ageMs)` 仅清理过期 missing；`AccessLedgerStore` 加 per-deviceId promise 链锁，参考 `client-cache-store.ts: withManifestLock` 实现。

- [ ] **Step 1: 写失败测试**

```typescript
test("runAging 仅清理过期 missing, 不动 file/dir", () => {
  const ledger = new AccessLedgerRuntime("dev1");
  const now = 10_000_000_000; // 任意大 ts
  const old = now - 31 * 24 * 3600 * 1000;
  const recent = now - 1000;

  ledger.upsertFilePresent("/file-old", old);
  ledger.upsertDirPresent("/dir-old", old, true);
  ledger.upsertMissing("/missing-old", old);
  ledger.upsertFilePresent("/file-recent", recent);
  ledger.upsertMissing("/missing-recent", recent);

  ledger.runAging(now, /*ageMs*/ 30 * 24 * 3600 * 1000);

  // file/dir 永远保留
  assert.ok(ledger.toJSON().entries["/file-old"]);
  assert.ok(ledger.toJSON().entries["/dir-old"]);
  assert.ok(ledger.toJSON().entries["/file-recent"]);
  // missing-old 过期清理, missing-recent 保留
  assert.equal(ledger.toJSON().entries["/missing-old"], undefined);
  assert.ok(ledger.toJSON().entries["/missing-recent"]);
  assert.deepEqual(ledger.missingSortedSnapshot(), ["/missing-recent"]);
});

test("AccessLedgerStore per-deviceId mutex 串行化并发 persist", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ledger-"));
  const store = new AccessLedgerStore({ dataDir: dir });
  const r1 = new AccessLedgerRuntime("dev-X");
  const r2 = new AccessLedgerRuntime("dev-X");
  r1.upsertFilePresent("/A", 1);
  r2.upsertFilePresent("/B", 2);

  // 并发 persist 同一 deviceId
  await Promise.all([store.persist(r1), store.persist(r2)]);

  // 锁保证串行, 最后落盘的胜出 — 不应损坏文件
  const final = await store.load("dev-X");
  const entries = final.toJSON().entries;
  // 至少一个落盘成功 (2 个之一)
  assert.ok(entries["/A"] || entries["/B"]);
});
```

- [ ] **Step 2: 实现 runAging + mutex**

```typescript
// AccessLedgerRuntime 内追加:
runAging(now: number, ageMs: number): void {
  const cutoff = now - ageMs;
  const toDelete: string[] = [];
  for (const path of this.missingSorted) {
    const entry = this.entries.get(path);
    if (entry?.kind === "missing" && entry.lastAccessedAt < cutoff) {
      toDelete.push(path);
    }
  }
  for (const path of toDelete) {
    this.entries.delete(path);
    this.removeFromSorted(this.missingSorted, path);
    this.removeFromSorted(this.allPathsSorted, path);
  }
}

// AccessLedgerStore 内追加 mutex (参考 client-cache-store.ts: withManifestLock):
private mutexChains = new Map<string, Promise<void>>();

private async withDeviceLock<T>(deviceId: string, fn: () => Promise<T>): Promise<T> {
  const previous = this.mutexChains.get(deviceId) ?? Promise.resolve();
  let releaseSelf!: () => void;
  const self = new Promise<void>((resolve) => { releaseSelf = resolve; });
  const newTail = previous.then(() => self);
  this.mutexChains.set(deviceId, newTail);
  try {
    await previous.catch(() => undefined);
    return await fn();
  } finally {
    releaseSelf();
    if (this.mutexChains.get(deviceId) === newTail) {
      this.mutexChains.delete(deviceId);
    }
  }
}

// persist 包一层 mutex:
async persist(runtime: AccessLedgerRuntime): Promise<void> {
  return this.withDeviceLock(runtime.deviceId, async () => {
    // ... 原 persist 逻辑
  });
}
```

- [ ] **Step 3: 跑测试**

Run: `cd server && npm test -- test/access-ledger.test.ts`
Expected: 18 tests pass。

- [ ] **Step 4: Commit**

```bash
git add server/src/access-ledger.ts server/test/access-ledger.test.ts
git commit -m "🌱 新增 / New: AccessLedger aging 与 per-device mutex / aging and per-device mutex

- runAging 仅作用于 missing entries, file/dir 永久保留
- AccessLedgerStore.persist 加 per-deviceId promise 链锁

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.6: 路径规范化模块

**Files:**
- Create: `server/src/path-normalize.ts`
- Test: `server/test/path-normalize.test.ts`

**完成标准**：`probeCaseSensitivity()`（一次性 probe + cache）+ `normalizeLedgerPath(absPath)`，case-insensitive fs 上 basename `toLowerCase()`，父目录 realpath。

- [ ] **Step 1: 写失败测试**

```typescript
// server/test/path-normalize.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  probeCaseSensitivity,
  normalizeLedgerPath,
  resetCaseSensitivityForTest,
} from "../src/path-normalize.js";

test("probeCaseSensitivity 在测试目录 probe 一次, 缓存结果", () => {
  resetCaseSensitivityForTest();
  const dir = mkdtempSync(path.join(tmpdir(), "case-probe-"));
  const result1 = probeCaseSensitivity(dir);
  const result2 = probeCaseSensitivity("/another/dir"); // 命中缓存, 忽略 dir 参数
  assert.equal(result1, result2);
});

test("normalizeLedgerPath case-sensitive: basename 保留原 case", () => {
  resetCaseSensitivityForTest(true);
  const dir = mkdtempSync(path.join(tmpdir(), "norm-"));
  mkdirSync(path.join(dir, "Foo"));
  const input = path.join(dir, "Foo", "Bar.md");
  // case-sensitive 时 basename 保留
  assert.equal(normalizeLedgerPath(input), input);
});

test("normalizeLedgerPath case-insensitive: basename lower-case, parent realpath", () => {
  resetCaseSensitivityForTest(false);
  const dir = mkdtempSync(path.join(tmpdir(), "norm-"));
  mkdirSync(path.join(dir, "Foo"));
  const input = path.join(dir, "Foo", "Bar.md");
  const expected = path.join(dir, "Foo", "bar.md"); // basename lower
  assert.equal(normalizeLedgerPath(input), expected);
});

test("normalizeLedgerPath 父目录 symlink: realpath 解析", () => {
  resetCaseSensitivityForTest(true);
  const dir = mkdtempSync(path.join(tmpdir(), "norm-"));
  mkdirSync(path.join(dir, "real"));
  symlinkSync(path.join(dir, "real"), path.join(dir, "link"));
  writeFileSync(path.join(dir, "real", "file.md"), "x");
  const input = path.join(dir, "link", "file.md");
  const result = normalizeLedgerPath(input);
  assert.equal(result, path.join(dir, "real", "file.md"));
});

test("normalizeLedgerPath 父目录不存在: 保留原 parent", () => {
  resetCaseSensitivityForTest(true);
  const input = "/does/not/exist/anywhere/leaf";
  // 父目录 realpath 失败, 保留原 parent + basename
  assert.equal(normalizeLedgerPath(input), input);
});
```

- [ ] **Step 2: 实现 path-normalize.ts**

```typescript
// server/src/path-normalize.ts
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";

let _caseSensitive: boolean | null = null;

export function probeCaseSensitivity(probeDir?: string): boolean {
  if (_caseSensitive !== null) return _caseSensitive;
  const dir = probeDir || process.env.CERELAY_DATA_DIR || "/tmp";
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const upper = path.join(dir, ".case-probe-Foo.tmp");
  const lower = path.join(dir, ".case-probe-foo.tmp");
  try {
    writeFileSync(upper, "x");
    // 如果 case-insensitive, lower 路径会指向同一文件
    _caseSensitive = !existsSync(lower) || statSync(upper).ino !== statSync(lower).ino;
  } catch {
    _caseSensitive = true; // 安全默认
  } finally {
    try { rmSync(upper, { force: true }); } catch {}
    try { rmSync(lower, { force: true }); } catch {}
  }
  return _caseSensitive;
}

export function resetCaseSensitivityForTest(value?: boolean): void {
  _caseSensitive = value === undefined ? null : value;
}

export function normalizeLedgerPath(absPath: string): string {
  if (!path.isAbsolute(absPath)) {
    throw new Error(`normalizeLedgerPath 要求绝对路径: ${absPath}`);
  }
  const parent = path.dirname(absPath);
  const basename = path.basename(absPath);
  let resolvedParent: string;
  try {
    resolvedParent = realpathSync.native(parent);
  } catch {
    resolvedParent = parent;
  }
  const fsCaseSensitive = _caseSensitive ?? probeCaseSensitivity();
  const normalizedBasename = fsCaseSensitive ? basename : basename.toLowerCase();
  return path.join(resolvedParent, normalizedBasename);
}
```

- [ ] **Step 3: 跑测试**

```bash
cd server && npm test -- test/path-normalize.test.ts
```

Expected: 5 tests pass。

- [ ] **Step 4: Commit**

```bash
git add server/src/path-normalize.ts server/test/path-normalize.test.ts
git commit -m "🌱 新增 / New: 路径规范化模块 / path normalization module

- probeCaseSensitivity 启动期一次性 probe, 全局缓存
- normalizeLedgerPath: 父目录 realpath + case-insensitive fs basename lowercase

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.7: SeedWhitelist 静态 const 框架

**Files:**
- Create: `server/src/seed-whitelist.ts`
- Test: 无单测（纯类型 + const）

**完成标准**：定义 `SEED_WHITELIST` 类型和空 fixture（capture 后 Phase 6 用 codegen 覆盖）。

- [ ] **Step 1: 实现 seed-whitelist.ts（直接给 final）**

```typescript
// server/src/seed-whitelist.ts
// 由 scripts/seed-whitelist-codegen.ts 一次性产出. 不要手改.
//
// Capture 流程:
//   1. CERELAY_CAPTURE_SEED=/tmp/seed.json npm run server:up
//   2. 用 dev 真实 ~/.claude 跑常规 CC session (含 /agents /commands)
//   3. node scripts/seed-whitelist-codegen.ts /tmp/seed.json > server/src/seed-whitelist.ts
//   4. commit

import type { SyncPlan } from "./protocol.js";

export const SEED_WHITELIST: Readonly<SyncPlan> = Object.freeze({
  scopes: {
    "claude-home": Object.freeze({
      subtrees: Object.freeze([] as Array<{ relPath: string; maxDepth: number }>),
      files: Object.freeze([] as string[]),
      knownMissing: Object.freeze([] as string[]),
    }),
    "claude-json": Object.freeze({
      subtrees: Object.freeze([{ relPath: "", maxDepth: 0 }] as const),
      files: Object.freeze([] as string[]),
      knownMissing: Object.freeze([] as string[]),
    }),
  },
} as const) as SyncPlan;
```

- [ ] **Step 2: Commit（暂时无 fixture）**

```bash
git add server/src/seed-whitelist.ts
git commit -m "🌱 新增 / New: SeedWhitelist 框架 / scaffolding (empty fixture)

实际 fixture 由 Phase 6 capture 流程产出后覆盖.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.8: SyncPlan 模块

**Files:**
- Create: `server/src/sync-plan.ts`
- Test: `server/test/sync-plan.test.ts`

**完成标准**：`computeSyncPlan(ledger, homedir, fallbackToSeed)` 返回 SyncPlan。ledger 为空则用 SEED_WHITELIST，否则反向构造。

注：`SyncPlan` type 在 Phase 2 Task 2.1 才正式定义到 protocol.ts；本 task 临时在 sync-plan.ts 内 inline 定义占位类型（commit 信息标注），Task 2.1 再统一迁移。

- [ ] **Step 1: 写失败测试**

```typescript
// server/test/sync-plan.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { AccessLedgerRuntime } from "../src/access-ledger.js";
import { computeSyncPlan } from "../src/sync-plan.js";
import { SEED_WHITELIST } from "../src/seed-whitelist.js";

test("computeSyncPlan 空 ledger 回 SeedWhitelist", () => {
  const ledger = new AccessLedgerRuntime("dev1");
  const plan = computeSyncPlan({ ledger, homedir: "/Users/foo" });
  assert.deepEqual(plan, SEED_WHITELIST);
});

test("computeSyncPlan 非空 ledger 反向构造 plan: home subtree + files", () => {
  const ledger = new AccessLedgerRuntime("dev1");
  // home-claude scope: 基于 /Users/foo/.claude/
  ledger.upsertDirPresent("/Users/foo/.claude/skills", 1, /*readdirObserved*/ true);
  ledger.upsertFilePresent("/Users/foo/.claude/skills/a.md", 2);
  ledger.upsertFilePresent("/Users/foo/.claude/settings.json", 3);
  ledger.upsertMissing("/Users/foo/.claude/plugins/themes", 4);

  const plan = computeSyncPlan({ ledger, homedir: "/Users/foo" });
  const home = plan.scopes["claude-home"];
  assert.ok(home);
  // skills 因为 readdirObserved=true 应作为 subtree 出现
  assert.ok(home.subtrees.some(s => s.relPath === "skills"));
  // settings.json 是 file 不在 readdir 过的 dir 下 → 进 files
  assert.ok(home.files.includes("settings.json"));
  // plugins/themes 是 missing → 进 knownMissing
  assert.ok(home.knownMissing.includes("plugins/themes"));
});

test("computeSyncPlan 不要把 readdirObserved=false 的 dir 当 subtree", () => {
  const ledger = new AccessLedgerRuntime("dev1");
  ledger.upsertDirPresent("/Users/foo/.claude/skills", 1, /*readdirObserved*/ false);
  ledger.upsertFilePresent("/Users/foo/.claude/skills/a.md", 2);
  const plan = computeSyncPlan({ ledger, homedir: "/Users/foo" });
  const home = plan.scopes["claude-home"];
  // skills 不应出现 subtree (没被 readdir 过), 仅 a.md 进 files
  assert.ok(!home?.subtrees.some(s => s.relPath === "skills"));
  assert.ok(home?.files.includes("skills/a.md"));
});

test("computeSyncPlan claude-json scope 永远恒定", () => {
  const ledger = new AccessLedgerRuntime("dev1");
  ledger.upsertFilePresent("/Users/foo/.claude.json", 1);
  const plan = computeSyncPlan({ ledger, homedir: "/Users/foo" });
  assert.deepEqual(plan.scopes["claude-json"]?.subtrees, [{ relPath: "", maxDepth: 0 }]);
});
```

- [ ] **Step 2: 实现 sync-plan.ts**

```typescript
// server/src/sync-plan.ts
import path from "node:path";
import type { AccessLedgerRuntime } from "./access-ledger.js";
import { SEED_WHITELIST } from "./seed-whitelist.js";

// 临时类型, Task 2.1 迁移到 protocol.ts
export interface SyncPlan {
  scopes: {
    "claude-home"?: ScopeWalkInstruction;
    "claude-json"?: ScopeWalkInstruction;
  };
}
export interface ScopeWalkInstruction {
  subtrees: Array<{ relPath: string; maxDepth: number }>;
  files: string[];
  knownMissing: string[];
}

export interface ComputeSyncPlanArgs {
  ledger: AccessLedgerRuntime;
  homedir: string;
}

export function computeSyncPlan(args: ComputeSyncPlanArgs): SyncPlan {
  const { ledger, homedir } = args;
  const all = ledger.allPathsSortedSnapshot();
  if (all.length === 0) {
    return SEED_WHITELIST as SyncPlan;
  }

  const homeRoot = path.join(homedir, ".claude");
  const claudeJsonPath = path.join(homedir, ".claude.json");

  const homeInstruction: ScopeWalkInstruction = {
    subtrees: [],
    files: [],
    knownMissing: [],
  };
  const jsonInstruction: ScopeWalkInstruction = {
    subtrees: [{ relPath: "", maxDepth: 0 }],
    files: [],
    knownMissing: [],
  };

  const seenDir = new Set<string>(); // 已纳入 subtrees 的目录, 子项跳过

  // 遍历 ledger 中 home-scoped paths (绝对路径以 homeRoot + "/" 开头, 或 == homeRoot)
  const homePrefix = homeRoot + "/";
  for (const absPath of all) {
    if (!absPath.startsWith(homePrefix) && absPath !== homeRoot && absPath !== claudeJsonPath) continue;
    const entry = ledger.toJSON().entries[absPath];
    if (!entry) continue;

    if (absPath === claudeJsonPath) {
      // claude-json scope 由恒定 instruction 处理, 跳过
      continue;
    }

    const relPath = absPath === homeRoot ? "" : absPath.slice(homePrefix.length);

    if (entry.kind === "missing") {
      homeInstruction.knownMissing.push(relPath);
      continue;
    }

    // 检查是否被已纳入的 subtree 覆盖
    if (isUnderAnySubtree(absPath, homeInstruction.subtrees, homeRoot)) continue;

    if (entry.kind === "dir" && entry.readdirObserved) {
      homeInstruction.subtrees.push({ relPath, maxDepth: -1 /* unlimited 沿用现状 */ });
      seenDir.add(absPath);
    } else if (entry.kind === "file") {
      homeInstruction.files.push(relPath);
    }
    // dir 但 !readdirObserved: 不纳入 subtree, file 子项已分别 walk
  }

  return {
    scopes: {
      "claude-home": homeInstruction,
      "claude-json": jsonInstruction,
    },
  };
}

function isUnderAnySubtree(
  absPath: string,
  subtrees: Array<{ relPath: string; maxDepth: number }>,
  homeRoot: string,
): boolean {
  for (const st of subtrees) {
    const subAbs = st.relPath ? path.join(homeRoot, st.relPath) : homeRoot;
    if (absPath === subAbs || absPath.startsWith(subAbs + "/")) return true;
  }
  return false;
}
```

- [ ] **Step 3: 跑测试**

```bash
cd server && npm test -- test/sync-plan.test.ts
```

Expected: 4 tests pass。

- [ ] **Step 4: Commit**

```bash
git add server/src/sync-plan.ts server/test/sync-plan.test.ts
git commit -m "🌱 新增 / New: SyncPlan 计算模块 / sync plan compute module

- computeSyncPlan(ledger, homedir): 空 ledger → SeedWhitelist; 否则反向构造
- subtree 仅当 dir.readdirObserved=true 时纳入
- missing 进 knownMissing, file/dir 不在 subtree 下 进 files

注: SyncPlan / ScopeWalkInstruction 临时定义在 sync-plan.ts; 
Task 2.1 迁移到 protocol.ts 后两端共用.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2: 协议同步扩展 / Protocol Hard-Switch

### Task 2.1: 协议类型迁移到 protocol.ts (server + client)

**Files:**
- Modify: `server/src/protocol.ts`
- Modify: `client/src/protocol.ts`
- Modify: `server/src/sync-plan.ts`（删除临时类型，import from protocol）

**完成标准**：`SyncPlan` / `ScopeWalkInstruction` / `FileProxyResponse.shallowestMissingAncestor` 三处协议字段在两端 protocol.ts 同步定义。

- [ ] **Step 1: 在 server/src/protocol.ts 中新增类型**

```typescript
// 追加到 server/src/protocol.ts (位置: 跟现有 CacheTaskAssignment 同节)

export interface SyncPlan {
  scopes: {
    "claude-home"?: ScopeWalkInstruction;
    "claude-json"?: ScopeWalkInstruction;
  };
}

export interface ScopeWalkInstruction {
  subtrees: Array<{ relPath: string; maxDepth: number /* -1 = unlimited */ }>;
  files: string[];
  knownMissing: string[];
}

// 修改 CacheTaskAssignment: active role 必填 syncPlan
export interface CacheTaskAssignment {
  // ... 现有字段
  syncPlan?: SyncPlan; // active 角色必填, inactive 不带; hard switch 不留降级
}

// 修改 FileProxyResponse: ENOENT 时携带最浅不存在祖先
export interface FileProxyResponse {
  // ... 现有字段
  shallowestMissingAncestor?: string;
}
```

- [ ] **Step 2: client/src/protocol.ts 同步**

把 server 端新增的相同类型字段同步到 client 端 `protocol.ts`（具体复制一份，cerelay 现状两端 protocol 是手工同步的）。

- [ ] **Step 3: 让 sync-plan.ts 用 protocol 的类型**

```typescript
// server/src/sync-plan.ts 顶部:
import type { SyncPlan, ScopeWalkInstruction } from "./protocol.js";
// 删除文件内 inline 的 SyncPlan / ScopeWalkInstruction 定义
```

- [ ] **Step 4: 跑 typecheck + 现有测试无回归**

```bash
cd server && npm run typecheck
cd ../client && npm run typecheck
cd ../server && npm test -- test/sync-plan.test.ts test/access-ledger.test.ts
```

Expected: typecheck pass，所有现有测试 pass。

- [ ] **Step 5: Commit**

```bash
git add server/src/protocol.ts client/src/protocol.ts server/src/sync-plan.ts
git commit -m "🌱 协议 / Protocol: SyncPlan + shallowestMissingAncestor 类型定义 / type definitions

- server/src/protocol.ts + client/src/protocol.ts 同步定义
- CacheTaskAssignment.syncPlan (active 必填)
- FileProxyResponse.shallowestMissingAncestor (ENOENT 时带)
- sync-plan.ts 改 import from protocol

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2.2: cache-task-manager 在 active assignment 携带 syncPlan

**Files:**
- Modify: `server/src/cache-task-manager.ts:579-604` (`buildActiveAssignment`)
- Test: `server/test/cache-task-manager-syncplan.test.ts` (新建，参考 `server/test/cache-task-state-machine.test.ts` 现有 mock 模式)

**完成标准**：`buildActiveAssignment` 返回的 assignment 必带 syncPlan（从 ledger + homedir 反向构造）。

- [ ] **Step 1: 写失败测试**

```typescript
// server/test/cache-task-manager-syncplan.test.ts
// (设置 mock store + registry 启动 CacheTaskManager, registerHello 后断言下发的 assignment 带 syncPlan)
// 由于这块涉及现有 mock 编排, 实际实现按现有测试模式 / 工具 (server/test/cache-task-state-machine.test.ts 类似) 编写

test("registerHello active 时 assignment.syncPlan 非空", async () => {
  const manager = setupTestManager(); // helper: mock registry + store + ledger store
  await manager.registerHello("client-1", {
    type: "client_hello",
    deviceId: "dev1",
    cwd: "/Users/foo/work",
    capabilities: { cacheTaskV1: true },
    /* ... */
  });
  const sent = manager.getSentMessages("client-1");
  const assignment = sent.find(m => m.type === "cache_task_assignment" && m.role === "active");
  assert.ok(assignment, "应下发 active assignment");
  assert.ok(assignment.syncPlan, "active assignment 必带 syncPlan");
});
```

- [ ] **Step 2: 改 cache-task-manager.ts**

向构造函数注入 `accessLedgerStore` + `homedir`，在 `buildActiveAssignment` 内：

```typescript
// 顶部 import:
import { computeSyncPlan } from "./sync-plan.js";
import type { AccessLedgerStore } from "./access-ledger.js";

// 构造函数 options 增加:
//   accessLedgerStore: AccessLedgerStore
//   getHomedirForDevice: (deviceId: string) => string

// buildActiveAssignment 内 (server/src/cache-task-manager.ts:579):
private async buildActiveAssignment(
  task: CacheTaskRecord,
  manifest: Awaited<ReturnType<ClientCacheStore["loadManifest"]>>,
  reason: ...,
): Promise<CacheTaskAssignment> {
  if (!task.assignmentId) {
    throw new Error("active assignment 缺少 assignmentId");
  }
  // === 新增: 计算 syncPlan ===
  const ledger = await this.accessLedgerStore.load(task.deviceId);
  const homedir = this.getHomedirForDevice(task.deviceId);
  const syncPlan = computeSyncPlan({ ledger, homedir });

  return {
    type: "cache_task_assignment",
    deviceId: task.deviceId,
    cwd: task.cwd,
    assignmentId: task.assignmentId,
    role: "active",
    reason,
    heartbeatIntervalMs: this.heartbeatIntervalMs,
    heartbeatTimeoutMs: this.heartbeatTimeoutMs,
    manifest: { ... }, // 现有
    syncPlan,          // 新增
  };
}
```

注：`getHomedirForDevice` 由 `server/src/server.ts` 在创建 CacheTaskManager 时提供 — 通常是 `os.homedir()` 或 client hello 上报的 home 字段。

- [ ] **Step 3: 跑测试**

```bash
cd server && npm test -- test/cache-task-manager-syncplan.test.ts test/cache-task-state-machine.test.ts
```

Expected: 新测试通过 + 现有 cache-task-state-machine.test.ts 不回归。

- [ ] **Step 4: Commit**

```bash
git add server/src/cache-task-manager.ts server/test/cache-task-manager-syncplan.test.ts
git commit -m "🌱 协议 / Protocol: cache_task_assignment active 携带 syncPlan / carry syncPlan in active assignment

- buildActiveAssignment 注入 AccessLedgerStore + computeSyncPlan
- active assignment 必带 syncPlan; inactive 仍不带

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2.3: client cache-task-state-machine 接收并传递 syncPlan

**Files:**
- Modify: `client/src/cache-task-state-machine.ts`
- Test: `client/test/cache-task-state-machine.test.ts` extend

**完成标准**：state machine 收到 `active assignment` 时把 syncPlan 传给上层（cache-sync），现状代码会调 cache-sync 启动同步——改成传 plan 参数。

- [ ] **Step 1: 写失败测试**

```typescript
test("state machine 收到 active assignment 时 onSyncStart 接收到 syncPlan", () => {
  const onSyncStart = mock.fn();
  const sm = new CacheTaskStateMachine({ onSyncStart });
  sm.handle({
    type: "cache_task_assignment",
    role: "active",
    syncPlan: { scopes: { "claude-home": { subtrees: [{ relPath: "skills", maxDepth: 3 }], files: [], knownMissing: [] } } },
    /* ... 其他字段 */
  });
  assert.equal(onSyncStart.mock.callCount(), 1);
  const arg = onSyncStart.mock.calls[0].arguments[0];
  assert.deepEqual(arg.syncPlan.scopes["claude-home"].subtrees[0].relPath, "skills");
});

test("state machine active assignment 缺 syncPlan → 抛错 (hard switch)", () => {
  const sm = new CacheTaskStateMachine({ onSyncStart: () => {} });
  assert.throws(
    () => sm.handle({ type: "cache_task_assignment", role: "active", /* 无 syncPlan */ } as any),
    /syncPlan/,
  );
});
```

- [ ] **Step 2: 改 state machine**

```typescript
// client/src/cache-task-state-machine.ts
// 现有 handle(message) 中 active 分支:
case "cache_task_assignment":
  if (message.role === "active") {
    if (!message.syncPlan) {
      throw new Error("active cache_task_assignment 必须带 syncPlan (hard switch)");
    }
    this.onSyncStart({
      assignmentId: message.assignmentId,
      manifest: message.manifest,
      syncPlan: message.syncPlan, // 新增字段透传
    });
  }
  // ...
```

- [ ] **Step 3: 跑测试**

```bash
cd client && npm test -- test/cache-task-state-machine.test.ts
```

Expected: 2 新测试 pass + 既有不回归。

- [ ] **Step 4: Commit**

```bash
git add client/src/cache-task-state-machine.ts client/test/cache-task-state-machine.test.ts
git commit -m "🌱 协议 / Protocol: client state machine 透传 syncPlan / pass-through syncPlan

- active assignment 缺 syncPlan 抛错 (hard switch)
- onSyncStart 回调接收 syncPlan

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2.4: client cache-sync 按 plan walk

**Files:**
- Modify: `client/src/cache-sync.ts`（`walkScope` / `buildScopePlan`）
- Test: `client/test/cache-sync.test.ts` extend

**完成标准**：`buildScopePlan` 接受 `ScopeWalkInstruction`，walk 范围从"整树"变成"按 subtrees + files 列表"。

- [ ] **Step 1: 写失败测试**

```typescript
// client/test/cache-sync.test.ts 增加
test("buildScopePlan 按 ScopeWalkInstruction 限制 walk 范围", async () => {
  const homedir = mkdtempSync(...); // 设置 ~/.claude/skills/a.md, /b.md, /agents/x.md
  const instruction = {
    subtrees: [{ relPath: "skills", maxDepth: 3 }],
    files: ["settings.json"],
    knownMissing: ["plugins/themes"],
  };
  const plan = await buildScopePlan({
    scope: "claude-home",
    homedir,
    remote: undefined,
    instruction, // 新参数
  });
  // skills/ 子树覆盖 → uploads 包含 skills/a.md / b.md
  assert.ok(plan.uploads.some(u => u.change.path === "skills/a.md"));
  // agents/ 不在 subtrees → 不出现
  assert.ok(!plan.uploads.some(u => u.change.path.startsWith("agents/")));
});

test("buildScopePlan walk 时跳过 knownMissing", async () => {
  const homedir = mkdtempSync(...);
  const instruction = {
    subtrees: [{ relPath: "", maxDepth: -1 }],
    files: [],
    knownMissing: ["plugins/cache/foo/themes"], // 即便存在也不 stat
  };
  // ... 验证 walk 中没尝试 stat plugins/cache/foo/themes
});
```

- [ ] **Step 2: 改 cache-sync.ts**

```typescript
// client/src/cache-sync.ts
// buildScopePlan / walkScope 增加 instruction 参数:
export interface BuildScopePlanArgs extends ScanOptions {
  scope: CacheScope;
  homedir: string;
  remote: CacheManifestData | undefined;
  instruction: ScopeWalkInstruction; // 新增 必填
}

export async function walkScope(args: WalkScopeArgs): Promise<LocalEntry[]> {
  const results: LocalEntry[] = [];
  const knownMissingSet = new Set(args.instruction.knownMissing);
  // 1. 扫 subtrees
  for (const st of args.instruction.subtrees) {
    const root = path.join(scopeRoot(args.scope, args.homedir), st.relPath);
    if (!existsSync(root)) continue;
    await walkDir(scopeRoot(args.scope, args.homedir), root, results, args.exclude, args.shouldAbort, st.maxDepth, knownMissingSet, 0);
  }
  // 2. 扫 files
  for (const file of args.instruction.files) {
    const abs = path.join(scopeRoot(args.scope, args.homedir), file);
    if (knownMissingSet.has(file) || !existsSync(abs)) continue;
    const stats = await stat(abs);
    if (stats.isFile()) {
      results.push({ relPath: file, absPath: abs, size: stats.size, mtime: Math.floor(stats.mtimeMs) });
    }
  }
  return results;
}

async function walkDir(
  root: string,
  current: string,
  out: LocalEntry[],
  exclude: ((rel: string) => boolean) | undefined,
  shouldAbort: (() => boolean) | undefined,
  maxDepth: number,
  knownMissing: Set<string>,
  depth: number,
): Promise<void> {
  if (maxDepth >= 0 && depth > maxDepth) return;
  // ... 现有逻辑, 但 entry 检查 knownMissing 跳过
}
```

- [ ] **Step 3: 跑测试**

```bash
cd client && npm test -- test/cache-sync.test.ts
```

Expected: 新测试 pass + 既有不回归（注意：现有测试可能需要传一个"匹配现状"的 instruction —— 一次性把 instruction 的整树相当 default 注进去，让既有测试继续过）。

- [ ] **Step 4: Commit**

```bash
git add client/src/cache-sync.ts client/test/cache-sync.test.ts
git commit -m "🌱 协议 / Protocol: client cache-sync 按 ScopeWalkInstruction walk / walk by instruction

- buildScopePlan / walkScope 增加 instruction 参数
- subtrees 控制扫描根 + maxDepth
- knownMissing 跳过 stat 优化

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2.5: client file-proxy ENOENT 顺带 shallowestMissingAncestor

**Files:**
- Modify: `client/src/file-proxy.ts`（`doGetattr` / `doRead` / `doReaddir` 失败分支）
- Test: `client/test/file-proxy-shallowest-ancestor.test.ts`

**完成标准**：getattr/read/readdir 三个 op ENOENT 时，response 携带 shallowestMissingAncestor，cap 在 root path 内，不向上越界。

- [ ] **Step 1: 写失败测试**

```typescript
// client/test/file-proxy-shallowest-ancestor.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findShallowestMissingAncestor } from "../src/file-proxy.js"; // 导出 helper

test("findShallowestMissingAncestor: 父目录都存在, 返回 path 自身", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fpa-"));
  mkdirSync(path.join(dir, "a"));
  const result = await findShallowestMissingAncestor(path.join(dir, "a", "missing.md"), dir);
  assert.equal(result, path.join(dir, "a", "missing.md"));
});

test("findShallowestMissingAncestor: 多级祖先都不存在, 返回最浅", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fpa-"));
  // dir 存在, dir/a/b/c/leaf 不存在 (a 也不存在)
  const result = await findShallowestMissingAncestor(path.join(dir, "a", "b", "c", "leaf"), dir);
  assert.equal(result, path.join(dir, "a"));
});

test("findShallowestMissingAncestor: cap 在 rootPath, 不越界向上", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fpa-"));
  // 即便整个 dir 都不存在 (rmSync 后), 也只能上探到 rootPath
  // 测试: rootPath 是 dir/sub, dir/sub 不存在, 返回 dir/sub 本身 (不会越过 root 上探)
  const result = await findShallowestMissingAncestor(
    path.join(dir, "sub", "miss.md"),
    path.join(dir, "sub"),
  );
  assert.equal(result, path.join(dir, "sub", "miss.md"));
});
```

- [ ] **Step 2: 实现 + 嵌入 file-proxy 响应**

```typescript
// client/src/file-proxy.ts (导出 helper):
import { lstat } from "node:fs/promises";

export async function findShallowestMissingAncestor(
  filePath: string,
  rootPath: string,
): Promise<string> {
  let current = filePath;
  let lastMissing = filePath;
  while (current !== rootPath && current !== "/") {
    const parent = path.dirname(current);
    if (parent === current) break;
    try {
      await lstat(parent);
      return lastMissing;
    } catch (e: any) {
      if (e.code === "ENOENT") {
        lastMissing = parent;
        current = parent;
        continue;
      }
      return filePath; // 其他错误 (EACCES 等) 不塌缩
    }
  }
  return lastMissing;
}

// FileProxy class 内 doGetattr / doRead / doReaddir 的 ENOENT 错误分支:
//   原来: throw / 返回 { error: { code: ENOENT, ... } }
//   改为: 同时计算 ancestor 并附带:
private async safeStatWithAncestor(filePath: string, rootPath: string): Promise<FileProxyResponse> {
  try {
    const stat = await this.doGetattr(filePath);
    return { ..., stat };
  } catch (e: any) {
    if (e.code === "ENOENT") {
      const ancestor = await findShallowestMissingAncestor(filePath, rootPath);
      return {
        ...,
        error: { code: 2, message: e.message },
        shallowestMissingAncestor: ancestor,
      };
    }
    throw e;
  }
}

// 调用方需要传入 rootPath. 可以从 FileProxy 构造时记录的 rootPath 取.
```

- [ ] **Step 3: 跑测试**

```bash
cd client && npm test -- test/file-proxy-shallowest-ancestor.test.ts
```

Expected: 3 tests pass。

- [ ] **Step 4: Commit**

```bash
git add client/src/file-proxy.ts client/test/file-proxy-shallowest-ancestor.test.ts
git commit -m "🌱 协议 / Protocol: file-proxy ENOENT 顺带 shallowestMissingAncestor / pass missing ancestor

- findShallowestMissingAncestor: lstat 父链, root cap
- doGetattr / doRead / doReaddir ENOENT 响应含字段
- 其他错误 (EACCES) 不塌缩, 用原 path

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 3: Daemon 协议扩展 / Daemon Protocol Extension

### Task 3.1: NegativeCache 类（前缀查询 + 前缀失效 + 子吸收）

**Files:**
- Modify: `server/src/fuse-host-script.ts`
- Test: `server/test/fuse-negative-cache.py-test.ts`（spawn daemon 子进程喂 control msg + assert）

**完成标准**：Python 内嵌 `NegativeCache` 类替代 `_negative_perm = set()`；`is_negative` 前缀匹配；`put` 吸收子；`invalidate_prefix` 沿父链向上清。

- [ ] **Step 1: 写失败测试**

```typescript
// server/test/fuse-negative-cache.py-test.ts
// 启动 daemon (用现有 file-proxy-manager 的 spawn 路径), 通过 control pipe 喂 put_negative 后,
// 通过主 pipe 发起 getattr 验证返回 ENOENT (前缀命中)
test("NegativeCache: put /foo, getattr /foo/bar/baz 应直接 ENOENT (前缀命中)", async () => {
  const daemon = await spawnFuseDaemonForTest({ /* roots: home-claude=/tmp/x */ });
  // 通过 control pipe 喂 put_negative
  await daemon.sendControl({ type: "put_negative", path: "/tmp/x/foo" });
  // 主 pipe getattr /tmp/x/foo/bar/baz
  const resp = await daemon.requestRpc({ op: "getattr", root: "home-claude", relPath: "foo/bar/baz", reqId: "test1" });
  assert.equal(resp.error?.code, 2 /* ENOENT */);
  await daemon.shutdown();
});

test("NegativeCache: put /a 后 put /a/b 子条目被吸收 (查询 _sorted snapshot)", async () => {
  // 调试 helper: daemon 暴露 dump_negative_state control msg, 返回当前 sorted list
  // 这个 helper 也是新增的, 见 Step 2
});
```

注：实际测试基础设施可能需要适当扩展。如果嫌 Python 内部测试难，可以在 `fuse-host-script.ts` 顶部增加 unit-test 模式（`if __name__ == "__main__" + sys.argv[1] == "selftest"`），run python 跑一遍。

- [ ] **Step 2: 改 fuse-host-script.ts**

```python
# server/src/fuse-host-script.ts (Python 部分)

import bisect

class NegativeCache:
    def __init__(self):
        self._sorted = []  # sorted list of missing paths
        self._set = set()
        self._lock = threading.Lock()

    def is_negative(self, path):
        """前缀匹配: 任何祖先在 set 中, 当前 path 也算 missing"""
        with self._lock:
            idx = bisect.bisect_right(self._sorted, path)
            if idx > 0:
                candidate = self._sorted[idx - 1]
                if path == candidate or path.startswith(candidate + "/"):
                    return True
            return False

    def put(self, missing_ancestor):
        """吸收所有 missing_ancestor + "/" 前缀的子条目, 然后插入 ancestor 自身"""
        with self._lock:
            # 1. 检查 missing_ancestor 是否已被更浅 ancestor 覆盖
            idx = bisect.bisect_right(self._sorted, missing_ancestor)
            if idx > 0:
                cand = self._sorted[idx - 1]
                if missing_ancestor == cand or missing_ancestor.startswith(cand + "/"):
                    return  # 已被覆盖
            # 2. 吸收子
            prefix = missing_ancestor + "/"
            jdx = bisect.bisect_left(self._sorted, missing_ancestor)
            to_remove = []
            while jdx < len(self._sorted):
                p = self._sorted[jdx]
                if p == missing_ancestor or p.startswith(prefix):
                    to_remove.append(p)
                    jdx += 1
                else:
                    break
            for p in to_remove:
                self._set.discard(p)
                self._sorted.remove(p)  # O(N) 但 list 通常不长
            # 3. 插入
            bisect.insort(self._sorted, missing_ancestor)
            self._set.add(missing_ancestor)

    def invalidate_prefix(self, path):
        """新创建/写入 path: 移除所有"是 path 祖先"的 missing entry"""
        with self._lock:
            current = path
            while current and current != "/":
                if current in self._set:
                    self._set.discard(current)
                    self._sorted.remove(current)
                parent = os.path.dirname(current)
                if parent == current:
                    break
                current = parent

    def snapshot(self):
        """诊断: dump 当前 sorted list, 用于测试"""
        with self._lock:
            return list(self._sorted)


# 替换原 self._negative_perm = set() 改为:
self._negative_perm = NegativeCache()

# Cache 类内移除:
#   self._negative = {}   (旧 TTL dict)
#   self._negative_ttl = 30.0
#   put_negative()
#   原 is_negative() / put_negative_perm() / invalidate_negative()

# 新增的 Cache 方法 (作为 NegativeCache 的 facade, 兼容现有调用):
def is_negative(self, path):
    return self._negative_perm.is_negative(path)

def put_negative_perm(self, path):
    self._negative_perm.put(path)

def invalidate_negative(self, path):
    """精确匹配清理一个 path (兼容旧 cache.invalidate 行为)"""
    with self._lock:
        if path in self._negative_perm._set:  # 注: 这是非常受限的内部访问, 仅在此一处
            self._negative_perm._set.discard(path)
            self._negative_perm._sorted.remove(path)
```

- [ ] **Step 3: 跑测试**

```bash
cd server && npm test -- test/fuse-negative-cache.py-test.ts
```

Expected: 2 tests pass。

- [ ] **Step 4: Commit**

```bash
git add server/src/fuse-host-script.ts server/test/fuse-negative-cache.py-test.ts
git commit -m "🚀 Daemon: NegativeCache 类支持前缀查询 / prefix-capable negative cache

- 替换 _negative_perm = set() 为 sorted list + bisect
- is_negative 前缀匹配 (任何祖先在 set 中, path 也算 missing)
- put 自动吸收子 missing entries
- invalidate_prefix 沿父链向上清

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3.2: 删除 _negative dict + TTL + readdir ENOENT 不再 swallow

**Files:**
- Modify: `server/src/fuse-host-script.ts:80-86, 117-123, 126-130, 524-536`
- Test: `server/test/e2e-readdir-enoent.test.ts`

**完成标准**：

1. 删除 `_negative` dict + 所有 TTL 相关代码
2. `readdir` ENOENT 不再 `entries = []`，改为抛出 ENOENT 让 caller 知道

- [ ] **Step 1: 写 e2e 测试**

```typescript
// server/test/e2e-readdir-enoent.test.ts
test("readdir 不存在目录 daemon 抛 ENOENT (不 swallow 成空)", async () => {
  // 启动完整 server + 真实 client (走 mock client tools)
  // CC 在 namespace 内 readdir /nonexistent → daemon 应返回 ENOENT
  // 当前实现会返回 entries=[] (空), 改后应抛 ENOENT
});
```

- [ ] **Step 2: 改 fuse-host-script.ts:524-536**

```python
def readdir(self, path, fh):
    # ... 路径解析 ...
    if _negative_perm.is_negative(hand_path):
        raise FuseOSError(errno.ENOENT)

    cached = _cache.get_readdir(hand_path)
    if cached is not None:
        return [".", ".."] + list(cached)

    try:
        resp = send_request({"reqId": next_req_id(), "op": "readdir", "root": root_name, "relPath": rel_path})
        entries = resp.get("entries", [])
    except FuseOSError as e:
        # === 改动: 不再把 ENOENT swallow 成空目录 ===
        if e.errno == errno.ENOENT:
            # client 已经在响应里附带 shallowestMissingAncestor, server 端会写 ledger 并推 daemon
            raise  # 不 swallow
        raise

    # ... 后续 shadow file 注入 + 缓存
```

同时删除 `Cache.__init__` 内 `self._negative = {}` 和 `self._negative_ttl = 30.0`，删除 `put_negative()` 旧实现。

- [ ] **Step 3: 跑测试**

```bash
cd server && npm test -- test/e2e-readdir-enoent.test.ts
```

Expected: 测试 pass。

- [ ] **Step 4: Commit**

```bash
git add server/src/fuse-host-script.ts server/test/e2e-readdir-enoent.test.ts
git commit -m "🩹 修复 / Fix: daemon readdir ENOENT 不再 swallow + 删 TTL 残留代码 / readdir ENOENT no swallow

- readdir 收到 ENOENT 抛出 (原 entries=[] 与 missing 语义冲突)
- 删除 Cache._negative dict + TTL 字段 (改用 NegativeCache 持久投影)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3.3: handle_control 扩展 3 种新 msg type

**Files:**
- Modify: `server/src/fuse-host-script.ts:804-829` (`handle_control`)
- Test: `server/test/daemon-control.test.ts`（已在 Task 3.4 创建 client）

**完成标准**：control pipe 能识别 `put_negative` / `invalidate_negative_prefix` / `invalidate_cache` 三种 msg type；未知 type 静默忽略；shutdown 行为不变。

- [ ] **Step 1: 写测试**（结合 Task 3.1 的测试基础设施）

```typescript
// server/test/daemon-control.test.ts (其中一部分)
test("control msg put_negative 落到 NegativeCache", async () => {
  // ... daemon spawn + sendControl({type:"put_negative",path:"/foo"})
  // 验证 daemon snapshot 包含 /foo
});

test("control msg invalidate_negative_prefix 沿父链清理", async () => {
  // ... put /a, put /b/c, then invalidate_negative_prefix /a/x
  // 验证 /a 被清理, /b/c 保留
});

test("control msg invalidate_cache 调 _cache.invalidate", async () => {
  // ... put_stat /foo (via 主 pipe getattr 命中)
  // ... invalidate_cache /foo via control pipe
  // ... 下次 getattr /foo 应 RPC 而非 cache
});

test("未知 control msg type 不抛错", async () => {
  // sendControl({type:"not_a_real_type"}) 不应导致 daemon crash
});
```

- [ ] **Step 2: 改 handle_control**

```python
# server/src/fuse-host-script.ts (Python handle_control)
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
                    if fuse_instance:
                        try:
                            import subprocess
                            subprocess.run(["fusermount", "-u", MOUNT_POINT], timeout=5, capture_output=True)
                        except Exception:
                            pass
                    break

                elif msg_type == "put_negative":
                    p = message.get("path")
                    if isinstance(p, str) and p:
                        _cache.put_negative_perm(p)

                elif msg_type == "invalidate_negative_prefix":
                    p = message.get("path")
                    if isinstance(p, str) and p:
                        _cache._negative_perm.invalidate_prefix(p)

                elif msg_type == "invalidate_cache":
                    p = message.get("path")
                    if isinstance(p, str) and p:
                        _cache.invalidate(p)

                # 未知 type: 忽略 (forward-compat)
    except OSError:
        pass
```

- [ ] **Step 3: 跑测试**

Expected: 4 tests pass。

- [ ] **Step 4: Commit**

```bash
git add server/src/fuse-host-script.ts server/test/daemon-control.test.ts
git commit -m "🚀 Daemon: control pipe 扩展 3 种新 msg / 3 new control msg types

- put_negative: 注入 missing entry
- invalidate_negative_prefix: 沿父链清 missing
- invalidate_cache: 精确清 stat/readdir/read 缓存
- 未知 type 静默忽略 (forward-compat)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3.4: server 端 DaemonControlClient

**Files:**
- Create: `server/src/daemon-control.ts`
- Test: `server/test/daemon-control.test.ts` (与 Task 3.3 共享)

**完成标准**：`DaemonControlClient` 类，封装向 daemon control pipe 写 line-delimited JSON 的接口（`putNegative` / `invalidateNegativePrefix` / `invalidateCache` / `shutdown`）。失败时降级 warn log，不阻塞 RPC。

- [ ] **Step 1: 写测试**

（Step 3.3 已涵盖，client 实现部分写在这里）

- [ ] **Step 2: 实现 DaemonControlClient**

```typescript
// server/src/daemon-control.ts
import { Writable } from "node:stream";
import { createLogger } from "./logger.js";

const log = createLogger("daemon-control");

export class DaemonControlClient {
  constructor(private readonly stream: Writable) {}

  async putNegative(path: string): Promise<void> {
    return this.send({ type: "put_negative", path });
  }
  async invalidateNegativePrefix(path: string): Promise<void> {
    return this.send({ type: "invalidate_negative_prefix", path });
  }
  async invalidateCache(path: string): Promise<void> {
    return this.send({ type: "invalidate_cache", path });
  }
  async shutdown(): Promise<void> {
    return this.send({ type: "shutdown" });
  }

  private async send(msg: Record<string, unknown>): Promise<void> {
    try {
      const line = JSON.stringify(msg) + "\n";
      const ok = this.stream.write(line);
      if (!ok) {
        // backpressure - 等 drain
        await new Promise<void>((resolve) => this.stream.once("drain", resolve));
      }
    } catch (err) {
      log.warn("daemon control msg 发送失败 (降级, 不阻塞 RPC)", {
        type: msg.type,
        error: (err as Error).message,
      });
    }
  }
}
```

并在 `FileProxyManager` 持有 control stream 的位置（spawn FUSE process 时拿到的 stdin extra fd），实例化一个 `DaemonControlClient` 暴露给上层。

- [ ] **Step 3: 跑测试**

```bash
cd server && npm test -- test/daemon-control.test.ts
```

Expected: tests pass。

- [ ] **Step 4: Commit**

```bash
git add server/src/daemon-control.ts server/test/daemon-control.test.ts
git commit -m "🌱 新增 / New: server 端 DaemonControlClient / control client wrapper

封装向 FUSE daemon control pipe 写 line-delimited JSON, fire-and-forget.
失败时降级 warn log, 不阻塞 RPC.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 4: Snapshot 整合 / Snapshot Integration

### Task 4.1: collectAndWriteSnapshot 阻塞等 cache ready（无超时）

**Files:**
- Modify: `server/src/file-proxy-manager.ts:450-573` (`collectAndWriteSnapshot`)
- Test: `server/test/e2e-snapshot-waits-cache-ready.test.ts`

**完成标准**：snapshot 收集前阻塞 polling cache task phase；只在 phase=degraded/idle 时 fallback 到 client 全量；phase=syncing 时无超时等待。

- [ ] **Step 1: 写回归测试**

```typescript
// server/test/e2e-snapshot-waits-cache-ready.test.ts
test("Defect 1 不复现: snapshot 收集时 cache 还在 syncing 应等到 ready", async () => {
  // 配合慢速 cache sync (人为延迟 client push delta), 然后启 PTY session
  // 断言: collectAndWriteSnapshot 完成时 phase === "ready", usedCacheSnapshot === true
  // (不再 fallback 走 client 全量)
});

test("phase=degraded 时仍 fallback (兜底分支保留)", async () => {
  // mock cache task 始终在 degraded
  // 断言: snapshot 收集走 client 全量
});
```

- [ ] **Step 2: 改 collectAndWriteSnapshot**

按 spec §7.2 的伪码实现。删除 `phase=syncing` 的 fallback 路径。

- [ ] **Step 3: 跑测试**

```bash
cd server && npm test -- test/e2e-snapshot-waits-cache-ready.test.ts
```

Expected: 2 tests pass。

- [ ] **Step 4: Commit**

```bash
git add server/src/file-proxy-manager.ts server/test/e2e-snapshot-waits-cache-ready.test.ts
git commit -m "🩹 修复 / Fix: Defect 1 - snapshot 阻塞等 cache ready 无超时 / wait for ready w/o timeout

- 删除 phase=syncing 时的 client 全量 fallback
- 仅 phase=degraded/idle 时 fallback (兜底)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4.2: snapshot 注入 ledger.missing（投影到 session roots）

**Files:**
- Modify: `server/src/file-proxy-manager.ts:553-572` (snapshot 收集 log + return)
- Test: `server/test/e2e-runtime-negative-persisted.test.ts`

**完成标准**：snapshot collect 完成后，把 ledger.missing 中"位于本 session FUSE roots 内"的全部 path 通过 control msg `put_negative` 喂给 daemon。

- [ ] **Step 1: 写回归测试**

```typescript
test("Defect 2 不复现: missing path 跨 session 持久化", async () => {
  // 1. 启动 cerelay, 进 session, CC 探测 /Users/foo/.claude/missing-x → daemon 学到
  //    (这步要等 Task 5.x access tracking 完成才能完整复现; 这里手动注入 ledger.missing)
  const ledger = await accessLedgerStore.load(deviceId);
  ledger.upsertMissing("/Users/foo/.claude/missing-x", Date.now());
  await accessLedgerStore.persist(ledger);

  // 2. 重启 daemon, 启 PTY session
  // 3. CC 探测同一路径 → daemon 直接 ENOENT, 不打 RPC
  const stats = await session.getFuseStats();
  assert.equal(stats.opCounts["getattr"], 0); // 命中 _negative_perm, 无 RPC
});
```

- [ ] **Step 2: 改 collectAndWriteSnapshot**

```typescript
// server/src/file-proxy-manager.ts
// 在 snapshot 写到 daemon snapshot file 之后, 增加:

if (this.accessLedgerStore && this.deviceId) {
  const ledger = await this.accessLedgerStore.load(this.deviceId);
  const sessionRoots = Object.values(this.roots);
  const allMissing = ledger.missingSortedSnapshot();
  let injectedCount = 0;
  for (const missingPath of allMissing) {
    const inRoots = sessionRoots.some(root =>
      missingPath === root || missingPath.startsWith(root + "/")
    );
    if (inRoots) {
      await this.daemonControl.putNegative(missingPath);
      injectedCount++;
    }
  }
  log.info("ledger.missing 注入 daemon", {
    sessionId: this.sessionId,
    totalMissing: allMissing.length,
    injectedCount,
  });
}
```

- [ ] **Step 3: 跑测试**

```bash
cd server && npm test -- test/e2e-runtime-negative-persisted.test.ts
```

Expected: test pass。

- [ ] **Step 4: Commit**

```bash
git add server/src/file-proxy-manager.ts server/test/e2e-runtime-negative-persisted.test.ts
git commit -m "🩹 修复 / Fix: Defect 2 - snapshot 启动时灌满 daemon negative cache from ledger / inject missing from ledger

启动期 collectAndWriteSnapshot 之后, 把 ledger 中本 session roots 范围的
所有 missing path 通过 daemon control msg 喂给 NegativeCache.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 5: 运行期 Access Tracking

### Task 5.1: AccessEvent type + SessionAccessBuffer

**Files:**
- Create: `server/src/access-event-buffer.ts`
- Test: `server/test/access-event-buffer.test.ts`

**完成标准**：`AccessEvent` type 定义；`SessionAccessBuffer` 类实现 `recordEvent` + `flush(ledger, daemonControl)` 按事件→ledger 操作映射规则。

- [ ] **Step 1: 写测试**

```typescript
// server/test/access-event-buffer.test.ts
test("getattr file → upsertFilePresent + 不推 daemon", async () => {
  const ledger = new AccessLedgerRuntime("dev1");
  const daemon = new FakeDaemonControl();
  const buf = new SessionAccessBuffer();
  buf.recordEvent({ op: "getattr", path: "/foo", result: "file", mtime: 1 });
  await buf.flush(ledger, daemon);
  assert.equal(ledger.toJSON().entries["/foo"]?.kind, "file");
  assert.equal(daemon.calls.putNegative.length, 0);
});

test("getattr missing → upsertMissing + 推 daemon putNegative", async () => {
  const ledger = new AccessLedgerRuntime("dev1");
  const daemon = new FakeDaemonControl();
  const buf = new SessionAccessBuffer();
  buf.recordEvent({ op: "getattr", path: "/foo/bar", result: "missing", shallowestMissingAncestor: "/foo" });
  await buf.flush(ledger, daemon);
  assert.equal(ledger.toJSON().entries["/foo"]?.kind, "missing");
  assert.deepEqual(daemon.calls.putNegative, ["/foo"]);
});

test("readdir ok → upsertDirPresent readdirObserved=true", async () => { ... });
test("readdir missing → upsertMissing + 推 daemon", async () => { ... });
test("read ok → 不写 ledger", async () => { ... });
test("read missing → upsertMissing + 推 daemon", async () => { ... });

test("9 种 mutation op 全部正确", async () => {
  // write/create/truncate/setattr/chmod → invalidateMissingPrefixes + invalidateNegativePrefix + touchIfPresent
  // mkdir → invalidateMissingPrefixes + upsertDirPresent + invalidateNegativePrefix
  // unlink → removeFilePresent
  // rmdir → removeDirSubtree
  // rename → renameSubtree + invalidateMissingPrefixes(newPath)
});
```

- [ ] **Step 2: 实现**

```typescript
// server/src/access-event-buffer.ts
import type { AccessLedgerRuntime } from "./access-ledger.js";
import type { DaemonControlClient } from "./daemon-control.js";

export type AccessEvent =
  | { op: "getattr"; path: string; result: "file" | "dir"; mtime: number }
  | { op: "getattr"; path: string; result: "missing"; shallowestMissingAncestor: string }
  | { op: "readdir"; path: string; result: "ok" }
  | { op: "readdir"; path: string; result: "missing"; shallowestMissingAncestor: string }
  | { op: "read"; path: string; result: "missing"; shallowestMissingAncestor: string }
  | { op: "write" | "create" | "truncate" | "setattr" | "chmod"; path: string }
  | { op: "mkdir"; path: string }
  | { op: "rmdir" | "unlink"; path: string }
  | { op: "rename"; oldPath: string; newPath: string };

export class SessionAccessBuffer {
  private events: AccessEvent[] = [];

  recordEvent(event: AccessEvent): void {
    this.events.push(event);
  }

  size(): number { return this.events.length; }
  isEmpty(): boolean { return this.events.length === 0; }

  async flush(ledger: AccessLedgerRuntime, daemon: DaemonControlClient): Promise<void> {
    const events = this.events;
    this.events = [];
    for (const ev of events) {
      const now = Date.now();
      switch (ev.op) {
        case "getattr":
          if (ev.result === "missing") {
            ledger.upsertMissing(ev.shallowestMissingAncestor, now);
            await daemon.putNegative(ev.shallowestMissingAncestor);
          } else if (ev.result === "file") {
            ledger.upsertFilePresent(ev.path, now);
          } else if (ev.result === "dir") {
            ledger.upsertDirPresent(ev.path, now, false);
          }
          break;
        case "readdir":
          if (ev.result === "ok") {
            ledger.upsertDirPresent(ev.path, now, true);
          } else {
            ledger.upsertMissing(ev.shallowestMissingAncestor, now);
            await daemon.putNegative(ev.shallowestMissingAncestor);
          }
          break;
        case "read":
          ledger.upsertMissing(ev.shallowestMissingAncestor, now);
          await daemon.putNegative(ev.shallowestMissingAncestor);
          break;
        case "write":
        case "create":
        case "truncate":
        case "setattr":
        case "chmod":
          ledger.invalidateMissingPrefixes(ev.path);
          await daemon.invalidateNegativePrefix(ev.path);
          ledger.touchIfPresent(ev.path, now);
          break;
        case "mkdir":
          ledger.invalidateMissingPrefixes(ev.path);
          await daemon.invalidateNegativePrefix(ev.path);
          ledger.upsertDirPresent(ev.path, now, false);
          break;
        case "unlink":
          ledger.removeFilePresent(ev.path);
          break;
        case "rmdir":
          ledger.removeDirSubtree(ev.path);
          break;
        case "rename":
          ledger.renameSubtree(ev.oldPath, ev.newPath);
          ledger.invalidateMissingPrefixes(ev.newPath);
          await daemon.invalidateNegativePrefix(ev.newPath);
          break;
      }
    }
    ledger.bumpRevision();
  }
}
```

- [ ] **Step 3: 跑测试**

```bash
cd server && npm test -- test/access-event-buffer.test.ts
```

Expected: 7 tests pass。

- [ ] **Step 4: Commit**

```bash
git add server/src/access-event-buffer.ts server/test/access-event-buffer.test.ts
git commit -m "🌱 新增 / New: AccessEvent + SessionAccessBuffer 模型 / event model

- 9 种 mutation op + 3 种 op (getattr/readdir/read) × 多种 result 全覆盖
- flush 时同步推 daemon control msg (putNegative / invalidateNegativePrefix)
- bumpRevision 由 flush 顶层管理

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5.2: file-proxy-manager hook resolveResponse + cache hit

**Files:**
- Modify: `server/src/file-proxy-manager.ts:788-839` (`resolveResponse`) + `tryServeReadFromCache` 命中分支
- Test: `server/test/e2e-cache-missing-invalidation.test.ts`

**完成标准**：

1. `resolveResponse(resp)` 根据 `req.op` + `resp.error/stat/entries` 派生 AccessEvent 进 buffer
2. `tryServeReadFromCache` 命中分支调 `recordCacheHitAccess(path)`（5s 防抖）
3. mutation op 也产 AccessEvent

- [ ] **Step 1: 写 e2e 测试**

```typescript
test("write 触发 ledger missing 失效 + daemon invalidate_negative_prefix", async () => {
  // 1. ledger 预填 missing /foo
  // 2. CC 通过 FUSE write /foo/bar/baz → 走 mutation hook
  // 3. 验证: ledger 不再有 /foo missing; daemon NegativeCache 不再有 /foo
});

test("getattr 后再 stat 同一 missing path → 命中 daemon 不打 RPC", async () => {
  // 1. CC stat /unknown → 穿透 client → ENOENT → ledger 写 missing + daemon put
  // 2. CC 再 stat /unknown → daemon 命中, 不 RPC
});
```

- [ ] **Step 2: 改 file-proxy-manager.ts**

具体改动较多，参考伪码：

```typescript
// FileProxyManager 内追加:
private accessBuffer: SessionAccessBuffer = new SessionAccessBuffer();
private cacheHitDebounce = new Map<string, number>(); // path → last record ts

// 在 handleFuseLine 入口处, 记 mutation op event (无 RPC 也产事件):
private async handleFuseLine(line: string): Promise<void> {
  const req = JSON.parse(line) as FuseRequest;
  // ... 现有逻辑
  // 在派发到 client 之前, mutation op 也记一次 (基于请求自身):
  if (CACHE_MUTATING_OPS.has(req.op)) {
    this.recordMutationEvent(req); // 见下
  }
}

private recordMutationEvent(req: FuseRequest): void {
  const root = this.roots[req.root];
  const path = req.relPath ? path.join(root, req.relPath) : root;
  switch (req.op) {
    case "write":
    case "create":
    case "truncate":
    case "setattr":
    case "chmod":
      this.accessBuffer.recordEvent({ op: req.op as any, path });
      break;
    case "mkdir":
      this.accessBuffer.recordEvent({ op: "mkdir", path });
      break;
    case "rmdir":
      this.accessBuffer.recordEvent({ op: "rmdir", path });
      break;
    case "unlink":
      this.accessBuffer.recordEvent({ op: "unlink", path });
      break;
    case "rename":
      const newPath = path.join(this.roots[req.newRoot ?? req.root] ?? root, req.newRelPath ?? "");
      this.accessBuffer.recordEvent({ op: "rename", oldPath: path, newPath });
      break;
  }
}

// resolveResponse 内 (现有 server/src/file-proxy-manager.ts:788):
resolveResponse(resp: FileProxyResponse): void {
  // ... 现有 deferred 解析逻辑

  // 派生 access event:
  const deferred = this.pendingRequests.get(resp.reqId);
  if (deferred?.opForAccess) {
    this.deriveAndRecordAccessEvent(deferred.opForAccess, resp);
  }

  // ... 写回 daemon
}

private deriveAndRecordAccessEvent(opCtx: { op: string; path: string }, resp: FileProxyResponse): void {
  if (resp.error?.code === 2 /* ENOENT */ && resp.shallowestMissingAncestor) {
    if (opCtx.op === "getattr" || opCtx.op === "read" || opCtx.op === "readdir") {
      this.accessBuffer.recordEvent({
        op: opCtx.op as any,
        path: opCtx.path,
        result: "missing",
        shallowestMissingAncestor: resp.shallowestMissingAncestor,
      });
    }
    return;
  }
  if (resp.stat) {
    if (opCtx.op === "getattr") {
      this.accessBuffer.recordEvent({
        op: "getattr",
        path: opCtx.path,
        result: resp.stat.isDir ? "dir" : "file",
        mtime: resp.stat.mtime,
      });
    }
  }
  if (resp.entries) {
    this.accessBuffer.recordEvent({ op: "readdir", path: opCtx.path, result: "ok" });
  }
}

// tryServeReadFromCache 命中分支:
private async tryServeReadFromCache(req: FuseRequest): Promise<...> {
  // ... 现有逻辑
  const result = await ...; // 命中
  if (result.served) {
    this.recordCacheHitAccess(this.cacheHitPathFor(req)); // 新增
    return result;
  }
  // ...
}

private recordCacheHitAccess(path: string): void {
  const now = Date.now();
  const last = this.cacheHitDebounce.get(path) ?? 0;
  if (now - last < 5000) return; // 5s 防抖
  this.cacheHitDebounce.set(path, now);
  this.accessBuffer.recordEvent({ op: "getattr", path, result: "file", mtime: 0 /* unknown, 但 lastAccessedAt 仍刷新 */ });
}
```

- [ ] **Step 3: 跑测试**

```bash
cd server && npm test -- test/e2e-cache-missing-invalidation.test.ts
```

Expected: 2 tests pass。

- [ ] **Step 4: Commit**

```bash
git add server/src/file-proxy-manager.ts server/test/e2e-cache-missing-invalidation.test.ts
git commit -m "🌱 运行期 / Runtime: file-proxy access tracking 接入 / hook access tracking

- handleFuseLine mutation op → recordMutationEvent
- resolveResponse → deriveAndRecordAccessEvent (含 shallowestMissingAncestor)
- tryServeReadFromCache 命中分支 5s 防抖刷 lastAccessedAt

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5.3: flush 触发点 + aging 启动期扫描

**Files:**
- Modify: `server/src/file-proxy-manager.ts`（5s timer + shutdown flush + sync_complete flush）
- Modify: `server/src/index.ts`（启动期 load + aging）
- Test: `server/test/e2e-mutation-ops-coverage.test.ts`

**完成标准**：四种触发点（5s timer / sync_complete 事件 / session 结束 / SIGTERM）都正确 flush；启动期 ledger load 后立即 aging。

- [ ] **Step 1: 写 e2e 测试**

```typescript
test("9 种 mutation op 端到端覆盖", async () => {
  // ... 启动 session, 通过 FUSE 触发 9 种 op, flush, 验证 ledger 状态正确
});

test("flush 五秒定时触发", async () => {
  // 设置短 timer (1s for test), record event, 等 1.5s, 验证 ledger.json 已落盘
});

test("启动期 aging 扫掉过期 missing", async () => {
  // 预填 ledger 含 31 天前 missing entry, 启 server, 验证 entry 已被清
});
```

- [ ] **Step 2: 实现 flush triggers + aging**

```typescript
// server/src/file-proxy-manager.ts
// 构造函数内 启 5s timer:
private flushTimer = setInterval(() => this.flushAccessBufferIfNeeded(), 5000);

private async flushAccessBufferIfNeeded(): Promise<void> {
  if (this.accessBuffer.isEmpty()) return;
  const ledger = await this.accessLedgerStore.load(this.deviceId!);
  await this.accessBuffer.flush(ledger, this.daemonControl);
  await this.accessLedgerStore.persist(ledger);
}

async shutdown(): Promise<void> {
  clearInterval(this.flushTimer);
  await this.flushAccessBufferIfNeeded(); // 必 flush
  // ... 现有 shutdown 逻辑
}

// 在 cache-task-manager.completeInitialSync (server/src/cache-task-manager.ts:255)
// 末尾增加 hook: 拿到对应 session 的 FileProxyManager 实例 (通过 sessionId → manager 映射,
// 在 server.ts 创建时维护一个 Map<sessionId, FileProxyManager>) 调 manager.flushAccessBufferIfNeeded()
```

```typescript
// server/src/index.ts (启动期):
import { AccessLedgerStore } from "./access-ledger.js";

const ledgerStore = new AccessLedgerStore({ dataDir: process.env.CERELAY_DATA_DIR ?? "/var/lib/cerelay" });
const ageDays = parseInt(process.env.CERELAY_LEDGER_AGING_DAYS ?? "30", 10);
const ageMs = ageDays * 24 * 3600 * 1000;

// 启动期对所有已知 deviceId 跑一次 aging
// 简单做法: 列出 access-ledger 目录下所有 deviceId, 逐一 load + age + persist
const fs = await import("node:fs/promises");
try {
  const devices = await fs.readdir(ledgerStore.rootDir());
  for (const deviceId of devices) {
    if (!/^[A-Za-z0-9]/.test(deviceId)) continue;
    const ledger = await ledgerStore.load(deviceId);
    const before = ledger.missingSortedSnapshot().length;
    ledger.runAging(Date.now(), ageMs);
    const after = ledger.missingSortedSnapshot().length;
    if (before !== after) {
      ledger.bumpRevision();
      await ledgerStore.persist(ledger);
      log.info("启动期 aging 完成", { deviceId, removed: before - after });
    }
  }
} catch (err) {
  log.warn("启动期 ledger aging 失败 (非致命)", { error: (err as Error).message });
}
```

- [ ] **Step 3: 跑测试**

```bash
cd server && npm test -- test/e2e-mutation-ops-coverage.test.ts
```

Expected: 3 tests pass。

- [ ] **Step 4: Commit**

```bash
git add server/src/file-proxy-manager.ts server/src/index.ts server/test/e2e-mutation-ops-coverage.test.ts
git commit -m "🌱 运行期 / Runtime: flush triggers + 启动期 aging / flush triggers and startup aging

- 5s timer 定时 flush (buffer 非空时)
- shutdown 必 flush
- 启动期对所有 deviceId 跑一次 aging

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 6: Seed Whitelist Capture

### Task 6.1: capture 模式

**Files:**
- Modify: `server/src/file-proxy-manager.ts`（CERELAY_CAPTURE_SEED 环境变量）
- Create: `scripts/seed-whitelist-codegen.ts`

**完成标准**：env 开关让 daemon 启动时**跳过 snapshot 反向构造** + 把所有 RPC path 全量记录到指定 JSON 文件；codegen 脚本把 JSON 转 ts 源码。

- [ ] **Step 1: 实现 capture 模式**

```typescript
// server/src/file-proxy-manager.ts
private captureSeedPath = process.env.CERELAY_CAPTURE_SEED;
private captureBuffer: { op: string; path: string; result: "ok"|"missing"; mtime?: number }[] = [];

// 在 collectAndWriteSnapshot 顶部:
if (this.captureSeedPath) {
  log.info("CAPTURE_SEED 模式: 跳过 snapshot 反向构造");
  // 写一个空 snapshot
  await writeFile(snapshotFile, JSON.stringify({ stats: {}, readdirs: {}, reads: {}, negatives: [] }), "utf8");
  return;
}

// 在 resolveResponse 派生 access event 之后:
if (this.captureSeedPath && deferred?.opForAccess) {
  const op = deferred.opForAccess.op;
  const path = deferred.opForAccess.path;
  if (resp.error?.code === 2) {
    this.captureBuffer.push({ op, path, result: "missing" });
  } else if (resp.stat) {
    this.captureBuffer.push({ op, path, result: "ok", mtime: resp.stat.mtime });
  } else if (resp.entries) {
    this.captureBuffer.push({ op, path, result: "ok" });
  }
}

// shutdown 时 dump:
async shutdown(): Promise<void> {
  if (this.captureSeedPath && this.captureBuffer.length > 0) {
    await writeFile(this.captureSeedPath, JSON.stringify({ events: this.captureBuffer }, null, 2), "utf8");
    log.info("CAPTURE_SEED 已写出", { path: this.captureSeedPath, count: this.captureBuffer.length });
  }
  // ... 原有 shutdown
}
```

- [ ] **Step 2: 实现 codegen 脚本**

```typescript
// scripts/seed-whitelist-codegen.ts
#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: seed-whitelist-codegen <capture.json>");
  process.exit(1);
}
const data = JSON.parse(readFileSync(inputPath, "utf8")) as {
  events: Array<{ op: string; path: string; result: "ok"|"missing"; mtime?: number }>;
};

// 按 home-claude / claude-json 分组聚合
const homeFiles = new Set<string>();
const homeSubtrees = new Map<string, number>(); // relPath → maxDepth
const homeMissing = new Set<string>();
const HOMEDIR = process.env.HOME || "/Users/foo";
const homeRoot = path.join(HOMEDIR, ".claude") + "/";

for (const ev of data.events) {
  if (!ev.path.startsWith(homeRoot)) continue;
  const rel = ev.path.slice(homeRoot.length);
  if (ev.result === "missing") {
    homeMissing.add(rel);
  } else if (ev.op === "readdir") {
    homeSubtrees.set(rel, -1); // unlimited
  } else if (ev.op === "getattr" || ev.op === "read") {
    homeFiles.add(rel);
  }
}

// 输出 ts
console.log(`// 由 scripts/seed-whitelist-codegen.ts 一次性产出. 不要手改.`);
console.log(`// Capture source: ${inputPath}`);
console.log();
console.log(`import type { SyncPlan } from "./protocol.js";`);
console.log();
console.log(`export const SEED_WHITELIST: Readonly<SyncPlan> = Object.freeze({`);
console.log(`  scopes: {`);
console.log(`    "claude-home": Object.freeze({`);
console.log(`      subtrees: Object.freeze([`);
for (const [rel, depth] of homeSubtrees) {
  console.log(`        Object.freeze({ relPath: ${JSON.stringify(rel)}, maxDepth: ${depth} } as const),`);
}
console.log(`      ] as const),`);
console.log(`      files: Object.freeze([`);
for (const f of [...homeFiles].sort()) {
  console.log(`        ${JSON.stringify(f)},`);
}
console.log(`      ] as const),`);
console.log(`      knownMissing: Object.freeze([`);
for (const m of [...homeMissing].sort()) {
  console.log(`        ${JSON.stringify(m)},`);
}
console.log(`      ] as const),`);
console.log(`    }),`);
console.log(`    "claude-json": Object.freeze({`);
console.log(`      subtrees: Object.freeze([{ relPath: "", maxDepth: 0 }] as const),`);
console.log(`      files: Object.freeze([] as const),`);
console.log(`      knownMissing: Object.freeze([] as const),`);
console.log(`    }),`);
console.log(`  },`);
console.log(`} as const) as SyncPlan;`);
```

- [ ] **Step 3: Commit**

```bash
git add server/src/file-proxy-manager.ts scripts/seed-whitelist-codegen.ts
git commit -m "🌱 工具 / Tooling: SeedWhitelist capture 模式 + codegen / capture mode and codegen

- CERELAY_CAPTURE_SEED env 开关: 跳过 snapshot 反向构造 + dump 所有 RPC paths
- scripts/seed-whitelist-codegen.ts: capture JSON → ts const 转换器

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6.2: 跑 capture + commit fixture

**Files:**
- Generate: `server/src/seed-whitelist.ts`（覆盖 Task 1.7 的空 fixture）

**完成标准**：用真实 dev `~/.claude` 跑一次 capture，commit 结果。

- [ ] **Step 1: 跑 capture**

```bash
# 准备：clean rebuild + capture mode
cd /Users/n374/Documents/Code/cerelay
docker compose down 2>/dev/null
CERELAY_CAPTURE_SEED=/tmp/seed-capture.json npm run server:up

# 在另一个终端启 client + 跑常规对话
cd client && npm start -- --server localhost:8765 --cwd /Users/n374/Documents/Code/cerelay
# 用户互动: 跑常规启动 + /agents + /commands + 一两个 prompt + 退出

# 关闭 server
docker compose down

# 检查产出
cat /tmp/seed-capture.json | head -20
```

- [ ] **Step 2: 跑 codegen**

```bash
node scripts/seed-whitelist-codegen.ts /tmp/seed-capture.json > server/src/seed-whitelist.ts
```

- [ ] **Step 3: 验证**

```bash
cd server && npm run typecheck && npm test
```

Expected: typecheck pass + 所有测试 pass（包括之前空 fixture 写的测试，因为 capture 后语义不同，可能要更新 sync-plan.test.ts 中"空 ledger 回 SeedWhitelist"的具体期望值——保持原有用 mock SEED_WHITELIST）。

- [ ] **Step 4: Commit fixture**

```bash
git add server/src/seed-whitelist.ts
git commit -m "🌱 配置 / Config: SeedWhitelist fixture (capture from dev ~/.claude) / fixture from real dev environment

由 scripts/seed-whitelist-codegen.ts 从 /tmp/seed-capture.json 生成.
覆盖范围: <X 个 file entries, Y 个 subtrees, Z 个 known-missing>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 7: 集成、性能基准、清理

### Task 7.1: e2e 集成测试

**Files:**
- Create: `server/test/e2e-cache-cold-start.test.ts`
- Create: `server/test/e2e-cache-warm-start.test.ts`
- Create: `server/test/e2e-cache-cross-cwd.test.ts`
- Create: `server/test/e2e-daemon-negative-prefix.test.ts`

**完成标准**：四个 e2e 测试覆盖冷启动 / 温启动 / 跨 cwd / daemon 前缀命中。

- [ ] **Step 1: 写 e2e 测试**（每个测试一个文件，按 spec §14.2/14.3 描述）

每个测试都用现有 server + 真实 client + mock CC 探测的模式，类似 `e2e-hand.test.ts` 风格。

- [ ] **Step 2: 跑测试**

```bash
cd server && npm test
```

Expected: 全部 pass。

- [ ] **Step 3: Commit**

```bash
git add server/test/e2e-cache-*.test.ts server/test/e2e-daemon-negative-prefix.test.ts
git commit -m "✅ 测试 / Tests: e2e 覆盖冷启动 / 温启动 / 跨 cwd / daemon 前缀 / e2e coverage

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7.2: 性能基准实测

**Files:**
- 无新文件，跑实际场景采集数据更新到 spec §14.4

**完成标准**：实测数据 vs spec 目标值的对比表，写到 spec 附录或单独 perf log，commit。

- [ ] **Step 1: 跑基准**

```bash
# 冷启动: 删 ledger + manifest + cache
rm -rf $CERELAY_DATA_DIR/access-ledger $CERELAY_DATA_DIR/client-cache
# 启 server + client + CC 测启动期穿透次数 + cache delta size + snapshot collect 时长

# 温启动 (上一次 ledger + manifest 已有)
# 重启 server + client + CC, 同样指标
```

- [ ] **Step 2: 写实测报告**

```bash
echo "..." > docs/superpowers/specs/2026-05-01-access-ledger-cache-perf-report.md
```

包含 spec §14.4 的 4 个指标的实测值。

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-05-01-access-ledger-cache-perf-report.md
git commit -m "📊 性能 / Perf: access-ledger cache 重构性能基准实测 / perf benchmark

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7.3: 清理 + 文档收尾

**Files:**
- Modify: `server/src/file-proxy-manager.ts`（删 phase=syncing fallback 死代码）
- Modify: `server/src/fuse-host-script.ts`（删 _negative dict / TTL 残留代码）
- Modify: `CLAUDE.md`（如需更新"FUSE access invariants"等节）

**完成标准**：spec §15 Phase 7 清理项全部完成；spec status 更新为 Implemented。

- [ ] **Step 1: 死代码清理**

```bash
# 删 file-proxy-manager.ts 中 phase=syncing 的 client 全量 fallback (Phase 4 Task 4.1 已删主分支, 但若有残留代码再 sweep 一遍)
# 删 fuse-host-script.ts 中 Cache._negative dict / _negative_ttl / put_negative 旧实现 (Phase 3 Task 3.2 已大部分清, 再 sweep)
```

- [ ] **Step 2: spec status 更新**

```markdown
- **状态 / Status**: ~~Draft~~ Implemented (commit `<final-sha>`)
```

- [ ] **Step 3: Commit**

```bash
git add server/src/file-proxy-manager.ts server/src/fuse-host-script.ts \
  docs/superpowers/specs/2026-05-01-access-ledger-driven-cache-design.md
git commit -m "🧹 清理 / Cleanup: 死代码 + spec status → Implemented / dead code + spec status

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## 后续 V2 候选 / Future V2

实施完毕后，按 spec §11 评估是否启动以下 V2 项：

1. **目录级 metadata 缓存（dirIndex）** - 根据 §14.4 实测决定是否需要
2. **cwd-ancestor `CLAUDE.md` 加载** - 需先扩展 namespace mount 层（独立 spec）
3. **Manifest blob 跨 cwd 内容寻址去重** - 节约磁盘空间（不是启动时间）

---

## 总览 / Summary

- **任务总数**：22 个 Task（Phase 1: 8 + Phase 2: 5 + Phase 3: 4 + Phase 4: 2 + Phase 5: 3 + Phase 6: 2 + Phase 7: 3 - 减去未编号的工具 task = 22 编号）
- **新增文件**：6 个 source + 14 个测试 = 20
- **修改文件**：10 个
- **Commit 预计**：每 Task 1 commit ≈ 22 commits，加少量 wrap-up = ~25 commits
- **预计代码量**：~3000 行新增（不含测试 ~5000）+ ~500 行修改

每个 Task 在执行时按 5-step (write test → run fail → impl → run pass → commit) 严格执行 TDD。
