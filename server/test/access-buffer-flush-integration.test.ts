import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AccessLedgerRuntime, AccessLedgerStore } from "../src/access-ledger.js";
import { SessionAccessBuffer } from "../src/access-event-buffer.js";

/**
 * 验证 Phase 5.3 flush 链路:
 * read-modify-write 周期 = load(deviceId) → buffer.flush(ledger) → store.persist(ledger)
 *
 * FileProxyManager.flushAccessBufferIfNeeded 调用此链 — 测试通过等价的独立流程
 * 验证 store contract.
 */

async function runFlushCycle(
  store: AccessLedgerStore,
  deviceId: string,
  buffer: SessionAccessBuffer,
): Promise<void> {
  if (buffer.isEmpty()) return;
  const ledger = await store.load(deviceId);
  await buffer.flush(ledger);
  await store.persist(ledger);
}

test("flush 周期: 空 buffer → no-op (不触碰 ledger 文件)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "flush-"));
  const store = new AccessLedgerStore({ dataDir: dir });
  const buffer = new SessionAccessBuffer();
  await runFlushCycle(store, "dev1", buffer);

  // ledger 应当不存在 (空 flush 不创建)
  const missing = await store.loadMissingForDevice("dev1");
  assert.deepEqual(missing, []);
});

test("flush 周期: events 落盘 + 重启后 ledger 仍包含", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "flush-"));
  const store = new AccessLedgerStore({ dataDir: dir });
  const buffer = new SessionAccessBuffer();
  buffer.recordEvent({
    op: "getattr",
    path: "/Users/foo/.claude/missing-x",
    result: "missing",
    shallowestMissingAncestor: "/Users/foo/.claude/missing-x",
  });
  await runFlushCycle(store, "dev1", buffer);

  // 重启 store, 重新 load
  const store2 = new AccessLedgerStore({ dataDir: dir });
  const missing = await store2.loadMissingForDevice("dev1");
  assert.deepEqual(missing, ["/Users/foo/.claude/missing-x"]);
});

test("多次 flush 累积写盘 (revision 单调递增)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "flush-"));
  const store = new AccessLedgerStore({ dataDir: dir });
  const buffer = new SessionAccessBuffer();

  buffer.recordEvent({ op: "getattr", path: "/foo", result: "file", mtime: 1 });
  await runFlushCycle(store, "dev1", buffer);
  const v1 = (await store.load("dev1")).toJSON().revision;

  buffer.recordEvent({ op: "getattr", path: "/bar", result: "file", mtime: 1 });
  await runFlushCycle(store, "dev1", buffer);
  const v2 = (await store.load("dev1")).toJSON().revision;

  assert.ok(v2 > v1, `revision 应单调递增: v1=${v1}, v2=${v2}`);
});

test("flush 跨多 batch 累加 (events 都落盘)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "flush-"));
  const store = new AccessLedgerStore({ dataDir: dir });
  const buffer = new SessionAccessBuffer();

  // batch 1: 5 个 events → flush
  for (let i = 0; i < 5; i++) {
    buffer.recordEvent({ op: "getattr", path: `/file-${i}`, result: "file", mtime: 1 });
  }
  await runFlushCycle(store, "dev1", buffer);
  assert.ok(buffer.isEmpty(), "flush 后 buffer 应清空");

  // batch 2: 又 5 个 events → flush (load 含 batch 1 + 新增)
  for (let i = 5; i < 10; i++) {
    buffer.recordEvent({ op: "getattr", path: `/file-${i}`, result: "file", mtime: 1 });
  }
  await runFlushCycle(store, "dev1", buffer);

  const ledger = await store.load("dev1");
  assert.equal(ledger.allPathsSortedSnapshot().length, 10, "10 个 events 全部累加进 ledger");
});

/**
 * 验证 Phase 5.3 启动期 aging 流程: AccessLedgerStore.load + runtime.runAging + persist.
 * 启动期触发逻辑应该在 server.ts 启动时跑, 这里测 store + runtime contract.
 */

test("启动期 aging: 30 天前的 missing 被清, file/dir 永久保留", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "flush-"));
  const store = new AccessLedgerStore({ dataDir: dir });
  const runtime = new AccessLedgerRuntime("dev-aging");

  const now = 10_000_000_000;
  const old = now - 31 * 24 * 3600 * 1000;
  const recent = now - 1000;

  runtime.upsertFilePresent("/file-old", old);
  runtime.upsertDirPresent("/dir-old", old, true);
  runtime.upsertMissing("/missing-old", old);
  runtime.upsertMissing("/missing-recent", recent);

  await store.persist(runtime);

  // 启动期模拟: 重新 load + runAging + persist
  const reloaded = await store.load("dev-aging");
  reloaded.runAging(now, 30 * 24 * 3600 * 1000);
  reloaded.bumpRevision();
  await store.persist(reloaded);

  // 重新 load 验证
  const final = await store.load("dev-aging");
  assert.ok(final.toJSON().entries["/file-old"], "file 永久保留");
  assert.ok(final.toJSON().entries["/dir-old"], "dir 永久保留");
  assert.equal(final.toJSON().entries["/missing-old"], undefined, "old missing 应被清");
  assert.ok(final.toJSON().entries["/missing-recent"], "recent missing 应保留");
});
