import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AccessLedgerRuntime, AccessLedgerStore } from "../src/access-ledger.js";
import { SessionAccessBuffer } from "../src/access-event-buffer.js";

/**
 * Plan §14.2 剩余 e2e 集成测试 (按用户要求"剩下的全部执行完"):
 *   - 跨 cwd: ledger 共享 home scope 学习历史 (避免重复扫)
 *   - 9 种 mutation op 全覆盖端到端 (write/create/truncate/setattr/chmod
 *     /mkdir/unlink/rmdir/rename) → ledger 状态正确
 *
 * 不依赖 spawn FUSE daemon, 直接用 SessionAccessBuffer + AccessLedgerStore
 * 模拟运行期 access tracking 链路.
 */

async function makeStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "cerelay-e2e-mut-"));
  return {
    dir,
    store: new AccessLedgerStore({ dataDir: dir }),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

// =============================================================================
// 跨 cwd 共享 home scope 学习
// =============================================================================

test("跨 cwd: 同 device 不同 cwd 共享 home scope 的 ledger", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  const DEVICE = "dev-cross-cwd";

  // session 1 在 cwd-A 下学到 home-claude/skills missing
  const ledger = new AccessLedgerRuntime(DEVICE);
  const buf1 = new SessionAccessBuffer();
  buf1.recordEvent({
    op: "getattr",
    path: "/Users/foo/.claude/skills",
    result: "missing",
    shallowestMissingAncestor: "/Users/foo/.claude/skills",
  });
  buf1.recordEvent({
    op: "readdir",
    path: "/Users/foo/.claude/projects",
    result: "ok",
  });
  await buf1.flush(ledger);
  await store.persist(ledger);

  // session 2 在 cwd-B 下启动 (同 device) → 应能复用 session 1 学到的内容
  const reloaded = await store.load(DEVICE);
  assert.equal(
    reloaded.toJSON().entries["/Users/foo/.claude/skills"]?.kind,
    "missing",
    "cwd 切换后 home scope missing 应仍在 (跨 cwd 共享)",
  );
  const projects = reloaded.toJSON().entries["/Users/foo/.claude/projects"];
  assert.ok(projects && projects.kind === "dir", "home scope dir entry 应共享");
  if (projects && projects.kind === "dir") {
    assert.equal(projects.readdirObserved, true);
  }
});

test("跨 cwd: 不同 cwd 的 cwd-local missing 自然隔离 (绝对路径作 key)", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  const DEVICE = "dev-cross-cwd";
  const ledger = new AccessLedgerRuntime(DEVICE);
  const buf = new SessionAccessBuffer();

  // cwd-A 下学到自己的 .claude/settings.json missing
  buf.recordEvent({
    op: "getattr",
    path: "/Users/foo/work-A/.claude/settings.json",
    result: "missing",
    shallowestMissingAncestor: "/Users/foo/work-A/.claude/settings.json",
  });
  // cwd-B 下学到自己的 .claude/settings.json (实际存在)
  buf.recordEvent({
    op: "getattr",
    path: "/Users/foo/work-B/.claude/settings.json",
    result: "file",
    mtime: Date.now(),
  });
  await buf.flush(ledger);
  await store.persist(ledger);

  const reloaded = await store.load(DEVICE);
  // 两个 cwd 的 entry 都在, 互不污染 (绝对路径自然隔离)
  assert.equal(
    reloaded.toJSON().entries["/Users/foo/work-A/.claude/settings.json"]?.kind,
    "missing",
  );
  assert.equal(
    reloaded.toJSON().entries["/Users/foo/work-B/.claude/settings.json"]?.kind,
    "file",
  );
});

// =============================================================================
// 9 种 mutation op 全覆盖端到端
// =============================================================================

async function flushToLedger(buf: SessionAccessBuffer, store: AccessLedgerStore, deviceId: string) {
  const ledger = await store.load(deviceId);
  await buf.flush(ledger);
  await store.persist(ledger);
  return store.load(deviceId);
}

test("mutation: write 触发 invalidateMissingPrefixes + touchIfPresent", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);
  const DEVICE = "dev-mut";

  // 预填 missing /foo + present file /foo/x
  const initial = new AccessLedgerRuntime(DEVICE);
  initial.upsertMissing("/foo", 1);
  initial.upsertFilePresent("/foo/x", 1);
  await store.persist(initial);

  // session 内: write /foo/x
  const buf = new SessionAccessBuffer();
  buf.recordEvent({ op: "write", path: "/foo/x" });
  const final = await flushToLedger(buf, store, DEVICE);

  // missing /foo 被前缀清; /foo/x 仍是 file 但 lastAccessedAt 更新
  assert.equal(final.toJSON().entries["/foo"], undefined);
  const x = final.toJSON().entries["/foo/x"];
  assert.ok(x && x.kind === "file");
});

test("mutation: create / truncate / setattr / chmod 等价于 write 的 ledger 行为", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);
  const DEVICE = "dev-mut2";

  for (const op of ["create", "truncate", "setattr", "chmod"] as const) {
    const initial = new AccessLedgerRuntime(DEVICE);
    initial.upsertMissing("/parent", 1);
    initial.upsertFilePresent(`/parent/${op}-target`, 1);
    await store.persist(initial);

    const buf = new SessionAccessBuffer();
    buf.recordEvent({ op, path: `/parent/${op}-target` });
    const final = await flushToLedger(buf, store, DEVICE);

    assert.equal(final.toJSON().entries["/parent"], undefined, `${op}: 父 missing 应清`);
    assert.ok(final.toJSON().entries[`/parent/${op}-target`], `${op}: file entry 应保留`);
  }
});

test("mutation: mkdir 清父 missing + 写 dir entry (readdirObserved=false)", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);
  const DEVICE = "dev-mkdir";

  const initial = new AccessLedgerRuntime(DEVICE);
  initial.upsertMissing("/parent", 1);
  await store.persist(initial);

  const buf = new SessionAccessBuffer();
  buf.recordEvent({ op: "mkdir", path: "/parent/new-dir" });
  const final = await flushToLedger(buf, store, DEVICE);

  assert.equal(final.toJSON().entries["/parent"], undefined);
  const dir = final.toJSON().entries["/parent/new-dir"];
  assert.ok(dir && dir.kind === "dir");
  if (dir && dir.kind === "dir") {
    assert.equal(dir.readdirObserved, false, "mkdir 不暗示 readdir, observed=false");
  }
});

test("mutation: unlink 移除 file entry, 不写 missing", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);
  const DEVICE = "dev-unlink";

  const initial = new AccessLedgerRuntime(DEVICE);
  initial.upsertFilePresent("/file-to-delete", 1);
  await store.persist(initial);

  const buf = new SessionAccessBuffer();
  buf.recordEvent({ op: "unlink", path: "/file-to-delete" });
  const final = await flushToLedger(buf, store, DEVICE);

  // file entry 不在了
  assert.equal(final.toJSON().entries["/file-to-delete"], undefined);
  // 不应当自动写 missing (避免临时文件被错误持久化为 missing)
  assert.equal(final.missingSortedSnapshot().length, 0);
});

test("mutation: rmdir 移除整棵子树 (file/dir/missing 都清)", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);
  const DEVICE = "dev-rmdir";

  const initial = new AccessLedgerRuntime(DEVICE);
  initial.upsertDirPresent("/dir", 1, true);
  initial.upsertFilePresent("/dir/a", 1);
  initial.upsertFilePresent("/dir/sub/b", 1);
  initial.upsertMissing("/dir/sub/missing-leaf", 1);
  initial.upsertFilePresent("/keep", 1); // 同 device 但不在 /dir 下
  await store.persist(initial);

  const buf = new SessionAccessBuffer();
  buf.recordEvent({ op: "rmdir", path: "/dir" });
  const final = await flushToLedger(buf, store, DEVICE);

  // /dir 整棵子树清
  assert.deepEqual(final.allPathsSortedSnapshot(), ["/keep"]);
});

test("mutation: rename 搬整棵子树 + 清新路径祖先 missing", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);
  const DEVICE = "dev-rename";

  const initial = new AccessLedgerRuntime(DEVICE);
  initial.upsertDirPresent("/old", 1, true);
  initial.upsertFilePresent("/old/leaf", 1);
  initial.upsertMissing("/new", 1); // 新路径祖先 missing
  await store.persist(initial);

  const buf = new SessionAccessBuffer();
  buf.recordEvent({ op: "rename", oldPath: "/old", newPath: "/new" });
  const final = await flushToLedger(buf, store, DEVICE);

  // /old 整棵搬到 /new
  assert.equal(final.toJSON().entries["/old"], undefined);
  assert.equal(final.toJSON().entries["/old/leaf"], undefined);
  // /new 的 missing 被清, /new 现在是 dir
  const newDir = final.toJSON().entries["/new"];
  assert.ok(newDir && newDir.kind === "dir");
  assert.ok(final.toJSON().entries["/new/leaf"]);
});

test("9 op 全覆盖串行: 模拟一个 session 内多种 mutation", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);
  const DEVICE = "dev-9-ops";

  const initial = new AccessLedgerRuntime(DEVICE);
  // 预填一些状态
  initial.upsertMissing("/foo", 1);
  initial.upsertFilePresent("/legacy", 1);
  await store.persist(initial);

  // 一个 session 内连续触发 9 种 op
  const buf = new SessionAccessBuffer();
  buf.recordEvent({ op: "write", path: "/foo/written" });
  buf.recordEvent({ op: "create", path: "/foo/created" });
  buf.recordEvent({ op: "truncate", path: "/foo/truncated" });
  buf.recordEvent({ op: "setattr", path: "/foo/attred" });
  buf.recordEvent({ op: "chmod", path: "/foo/chmodded" });
  buf.recordEvent({ op: "mkdir", path: "/foo/new-dir" });
  buf.recordEvent({ op: "unlink", path: "/legacy" });
  buf.recordEvent({ op: "rmdir", path: "/foo/new-dir" }); // 立刻删
  buf.recordEvent({ op: "rename", oldPath: "/foo/written", newPath: "/foo/renamed" });

  const final = await flushToLedger(buf, store, DEVICE);

  // /foo missing 应被清 (任何写入路径就清祖先)
  assert.equal(final.toJSON().entries["/foo"], undefined);
  // /legacy unlink 后不在
  assert.equal(final.toJSON().entries["/legacy"], undefined);
  // mkdir 又 rmdir → /foo/new-dir 不在
  assert.equal(final.toJSON().entries["/foo/new-dir"], undefined);
  // rename: /foo/written 搬到 /foo/renamed (但因 /foo missing 清的副作用, write event
  // 后 /foo/written 是 touchIfPresent — 实际只有当之前 ledger 有 /foo/written 才触发)
  // 在本测试 /foo/written 之前不存在, write event 走 touchIfPresent no-op, 没建 entry
  // 所以 rename 时 /foo/written 不存在, renameSubtree 也是 no-op. 这是接受的行为.
});
