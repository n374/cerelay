import { test } from "node:test";
import assert from "node:assert/strict";
import { AccessLedgerRuntime } from "../src/access-ledger.js";
import { SessionAccessBuffer } from "../src/access-event-buffer.js";

test("getattr file → upsertFilePresent", async () => {
  const ledger = new AccessLedgerRuntime("dev1");
  const buf = new SessionAccessBuffer();
  buf.recordEvent({ op: "getattr", path: "/foo", result: "file", mtime: 1 });
  await buf.flush(ledger);
  assert.equal(ledger.toJSON().entries["/foo"]?.kind, "file");
});

test("getattr dir (无 readdir) → upsertDirPresent readdirObserved=false", async () => {
  const ledger = new AccessLedgerRuntime("dev1");
  const buf = new SessionAccessBuffer();
  buf.recordEvent({ op: "getattr", path: "/dir", result: "dir", mtime: 1 });
  await buf.flush(ledger);
  const entry = ledger.toJSON().entries["/dir"];
  assert.equal(entry?.kind, "dir");
  if (entry?.kind === "dir") assert.equal(entry.readdirObserved, false);
});

test("getattr missing → upsertMissing 用 shallowestMissingAncestor", async () => {
  const ledger = new AccessLedgerRuntime("dev1");
  const buf = new SessionAccessBuffer();
  buf.recordEvent({
    op: "getattr",
    path: "/foo/bar/leaf",
    result: "missing",
    shallowestMissingAncestor: "/foo",
  });
  await buf.flush(ledger);
  // 写入的是 ancestor /foo, 不是 /foo/bar/leaf
  assert.equal(ledger.toJSON().entries["/foo"]?.kind, "missing");
  assert.equal(ledger.toJSON().entries["/foo/bar/leaf"], undefined);
});

test("readdir ok → upsertDirPresent readdirObserved=true", async () => {
  const ledger = new AccessLedgerRuntime("dev1");
  const buf = new SessionAccessBuffer();
  buf.recordEvent({ op: "readdir", path: "/dir", result: "ok" });
  await buf.flush(ledger);
  const entry = ledger.toJSON().entries["/dir"];
  if (entry?.kind === "dir") assert.equal(entry.readdirObserved, true);
});

test("readdir missing → upsertMissing", async () => {
  const ledger = new AccessLedgerRuntime("dev1");
  const buf = new SessionAccessBuffer();
  buf.recordEvent({
    op: "readdir",
    path: "/x/y",
    result: "missing",
    shallowestMissingAncestor: "/x",
  });
  await buf.flush(ledger);
  assert.equal(ledger.toJSON().entries["/x"]?.kind, "missing");
});

test("read missing → upsertMissing (仅 missing case 进 ledger)", async () => {
  const ledger = new AccessLedgerRuntime("dev1");
  const buf = new SessionAccessBuffer();
  buf.recordEvent({
    op: "read",
    path: "/a/b",
    result: "missing",
    shallowestMissingAncestor: "/a/b",
  });
  await buf.flush(ledger);
  assert.equal(ledger.toJSON().entries["/a/b"]?.kind, "missing");
});

test("9 种 mutation op 全覆盖: write/create/truncate/setattr/chmod 触发 invalidateMissingPrefixes + touchIfPresent", async () => {
  const ledger = new AccessLedgerRuntime("dev1");
  const buf = new SessionAccessBuffer();
  // 预填 missing /foo + present file /foo/x
  ledger.upsertMissing("/foo", 1);
  ledger.upsertFilePresent("/foo/x", 1);

  buf.recordEvent({ op: "write", path: "/foo/x" });
  await buf.flush(ledger);

  // missing /foo 被前缀清理; /foo/x lastAccessedAt 被刷新 (touchIfPresent)
  assert.equal(ledger.toJSON().entries["/foo"], undefined);
  const x = ledger.toJSON().entries["/foo/x"];
  assert.ok(x && x.kind === "file");
  if (x && x.kind === "file") assert.ok(x.lastAccessedAt > 1);
});

test("mutation: mkdir → invalidateMissingPrefixes + upsertDirPresent", async () => {
  const ledger = new AccessLedgerRuntime("dev1");
  const buf = new SessionAccessBuffer();
  ledger.upsertMissing("/foo", 1);

  buf.recordEvent({ op: "mkdir", path: "/foo/new-dir" });
  await buf.flush(ledger);

  assert.equal(ledger.toJSON().entries["/foo"], undefined);
  assert.equal(ledger.toJSON().entries["/foo/new-dir"]?.kind, "dir");
});

test("mutation: unlink → removeFilePresent", async () => {
  const ledger = new AccessLedgerRuntime("dev1");
  const buf = new SessionAccessBuffer();
  ledger.upsertFilePresent("/file", 1);

  buf.recordEvent({ op: "unlink", path: "/file" });
  await buf.flush(ledger);

  assert.equal(ledger.toJSON().entries["/file"], undefined);
});

test("mutation: rmdir → removeDirSubtree", async () => {
  const ledger = new AccessLedgerRuntime("dev1");
  const buf = new SessionAccessBuffer();
  ledger.upsertDirPresent("/dir", 1, true);
  ledger.upsertFilePresent("/dir/a", 1);
  ledger.upsertFilePresent("/dir/sub/b", 1);

  buf.recordEvent({ op: "rmdir", path: "/dir" });
  await buf.flush(ledger);

  assert.deepEqual(ledger.allPathsSortedSnapshot(), []);
});

test("mutation: rename → renameSubtree + 清新路径祖先 missing", async () => {
  const ledger = new AccessLedgerRuntime("dev1");
  const buf = new SessionAccessBuffer();
  ledger.upsertFilePresent("/old/a", 1);
  ledger.upsertMissing("/new", 1); // 新路径祖先为 missing

  buf.recordEvent({ op: "rename", oldPath: "/old/a", newPath: "/new/a" });
  await buf.flush(ledger);

  // /old/a 搬到 /new/a; /new missing 被清
  assert.equal(ledger.toJSON().entries["/old/a"], undefined);
  assert.equal(ledger.toJSON().entries["/new/a"]?.kind, "file");
  assert.equal(ledger.toJSON().entries["/new"], undefined);
});

test("cache_hit → 仅 touchIfPresent (file/dir present 不被 aging 误清)", async () => {
  const ledger = new AccessLedgerRuntime("dev1");
  const buf = new SessionAccessBuffer();
  ledger.upsertFilePresent("/cached-file", 1);

  buf.recordEvent({ op: "cache_hit", path: "/cached-file" });
  await buf.flush(ledger);

  const entry = ledger.toJSON().entries["/cached-file"];
  assert.ok(entry && entry.kind === "file");
  if (entry && entry.kind === "file") assert.ok(entry.lastAccessedAt > 1);
});

test("cache_hit 对不在 ledger 的 path no-op (不无中生有)", async () => {
  const ledger = new AccessLedgerRuntime("dev1");
  const buf = new SessionAccessBuffer();
  buf.recordEvent({ op: "cache_hit", path: "/never-seen" });
  await buf.flush(ledger);
  assert.equal(ledger.toJSON().entries["/never-seen"], undefined);
});

test("flush 后 buffer 清空, isEmpty()=true; 二次 flush no-op", async () => {
  const ledger = new AccessLedgerRuntime("dev1");
  const buf = new SessionAccessBuffer();
  buf.recordEvent({ op: "getattr", path: "/x", result: "file", mtime: 1 });
  assert.equal(buf.size(), 1);
  await buf.flush(ledger);
  assert.ok(buf.isEmpty());
  await buf.flush(ledger); // 不应抛
  assert.ok(buf.isEmpty());
});

test("flush 调一次 bumpRevision (不是 per-event)", async () => {
  const ledger = new AccessLedgerRuntime("dev1");
  const beforeRev = ledger.toJSON().revision;
  const buf = new SessionAccessBuffer();
  buf.recordEvent({ op: "getattr", path: "/x", result: "file", mtime: 1 });
  buf.recordEvent({ op: "getattr", path: "/y", result: "file", mtime: 1 });
  buf.recordEvent({ op: "getattr", path: "/z", result: "file", mtime: 1 });
  await buf.flush(ledger);
  // 3 events 总共只 +1 revision
  assert.equal(ledger.toJSON().revision - beforeRev, 1);
});
