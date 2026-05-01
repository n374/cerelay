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
