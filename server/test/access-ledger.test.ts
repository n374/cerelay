import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AccessLedgerRuntime, AccessLedgerStore } from "../src/access-ledger.js";

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
  ledger.upsertDirPresent("/foo/bar", 1000, false);
  ledger.upsertDirPresent("/foo/bar", 2000, true);
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
  ledger.upsertDirPresent("/foo/bar", 1000, true);
  ledger.upsertDirPresent("/foo/bar", 2000, false);
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
  assert.equal(loaded.toJSON().revision, 1);
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
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await writeFile(ledgerPath, "{not valid json", "utf8");
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
  const files = await readdir(sessionDir);
  for (const name of files) {
    assert.ok(!name.startsWith("ledger.json.tmp-"), `不该有 tmp 残留: ${name}`);
  }
});

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
  ledger.upsertMissing("/a/b", 2);
  assert.deepEqual(ledger.missingSortedSnapshot(), ["/a"]);
});

test("invalidateMissingPrefixes 移除所有祖先 missing", () => {
  const ledger = new AccessLedgerRuntime("dev1");
  ledger.upsertMissing("/a/b", 1000);
  ledger.upsertMissing("/c", 2000);
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
  ledger.upsertMissing("/foo/missing", 5);
  ledger.upsertFilePresent("/other", 6);
  ledger.removeDirSubtree("/foo");
  assert.deepEqual(ledger.allPathsSortedSnapshot(), ["/other"]);
  assert.deepEqual(ledger.missingSortedSnapshot(), []);
  assert.deepEqual([...ledger.dirsReaddirObservedSnapshot()], []);
});

test("renameSubtree 把整棵子树搬到新路径", () => {
  const ledger = new AccessLedgerRuntime("dev1");
  ledger.upsertDirPresent("/old", 1, true);
  ledger.upsertFilePresent("/old/a", 2);
  ledger.upsertFilePresent("/old/sub/b", 3);
  ledger.upsertMissing("/old/sub/missing", 4);
  ledger.renameSubtree("/old", "/new");
  assert.deepEqual(ledger.allPathsSortedSnapshot(), [
    "/new",
    "/new/a",
    "/new/sub/b",
    "/new/sub/missing",
  ]);
  assert.deepEqual(ledger.missingSortedSnapshot(), ["/new/sub/missing"]);
  assert.ok(ledger.dirsReaddirObservedSnapshot().has("/new"));
});

test("touchIfPresent 仅刷新已存在 entry 的 lastAccessedAt", () => {
  const ledger = new AccessLedgerRuntime("dev1");
  ledger.upsertFilePresent("/foo", 1000);
  ledger.touchIfPresent("/foo", 5000);
  ledger.touchIfPresent("/bar", 6000);
  assert.equal(ledger.toJSON().entries["/foo"]?.lastAccessedAt, 5000);
  assert.equal(ledger.toJSON().entries["/bar"], undefined);
});

test("runAging 仅清理过期 missing, 不动 file/dir", () => {
  const ledger = new AccessLedgerRuntime("dev1");
  const now = 10_000_000_000;
  const old = now - 31 * 24 * 3600 * 1000;
  const recent = now - 1000;

  ledger.upsertFilePresent("/file-old", old);
  ledger.upsertDirPresent("/dir-old", old, true);
  ledger.upsertMissing("/missing-old", old);
  ledger.upsertFilePresent("/file-recent", recent);
  ledger.upsertMissing("/missing-recent", recent);

  ledger.runAging(now, 30 * 24 * 3600 * 1000);

  assert.ok(ledger.toJSON().entries["/file-old"]);
  assert.ok(ledger.toJSON().entries["/dir-old"]);
  assert.ok(ledger.toJSON().entries["/file-recent"]);
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

  await Promise.all([store.persist(r1), store.persist(r2)]);

  const final = await store.load("dev-X");
  const entries = final.toJSON().entries;
  assert.ok(entries["/A"] || entries["/B"]);
});
