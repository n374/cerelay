import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AccessLedgerRuntime, AccessLedgerStore } from "../src/access-ledger.js";

/**
 * 验证 AccessLedgerStore.loadMissingForDevice 行为，作为 FileProxyManager
 * snapshot 注入 ledger.missing 的关键 input (spec §7.4 Defect 2 修复).
 *
 * 完整 e2e (FileProxyManager + spawn daemon + 验证 daemon snapshot 含 negatives)
 * 留到 Phase 7 一起跑。这里只测 store 一侧的契约。
 */

test("loadMissingForDevice 仅返回 missing entries (排除 file/dir)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ledger-"));
  const store = new AccessLedgerStore({ dataDir: dir });
  const runtime = new AccessLedgerRuntime("dev-A");
  runtime.upsertFilePresent("/Users/foo/.claude/settings.json", 1);
  runtime.upsertDirPresent("/Users/foo/.claude/skills", 2, true);
  runtime.upsertMissing("/Users/foo/.claude/plugins/themes", 3);
  runtime.upsertMissing("/Users/foo/.claude/output-styles", 4);
  await store.persist(runtime);

  const missing = await store.loadMissingForDevice("dev-A");
  assert.deepEqual(missing.sort(), [
    "/Users/foo/.claude/output-styles",
    "/Users/foo/.claude/plugins/themes",
  ]);
});

test("loadMissingForDevice 不存在的 deviceId 返回空数组 (不抛)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ledger-"));
  const store = new AccessLedgerStore({ dataDir: dir });
  const missing = await store.loadMissingForDevice("dev-NEW");
  assert.deepEqual(missing, []);
});

test("loadMissingForDevice 损坏 ledger.json 返回空数组 (不抛)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ledger-"));
  const corruptDir = path.join(dir, "access-ledger", "dev-CORRUPT");
  await mkdir(corruptDir, { recursive: true });
  const fs = await import("node:fs/promises");
  await fs.writeFile(path.join(corruptDir, "ledger.json"), "{not valid", "utf8");
  const store = new AccessLedgerStore({ dataDir: dir });
  const missing = await store.loadMissingForDevice("dev-CORRUPT");
  assert.deepEqual(missing, []);
});

test("loadMissingForDevice 跨 cwd 共享: 同 device 多次 missing 都被返回", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ledger-"));
  const store = new AccessLedgerStore({ dataDir: dir });
  const runtime = new AccessLedgerRuntime("dev-X");
  // 同 device 在两个不同 cwd 下都探测过 missing — ledger 是 per-deviceId, 共享
  runtime.upsertMissing("/Users/foo/.claude/skills/lark-base", 1);
  runtime.upsertMissing("/Users/foo/.claude/skills/lark-doc", 2);
  await store.persist(runtime);

  const missing = await store.loadMissingForDevice("dev-X");
  assert.equal(missing.length, 2);
});

test("loadDirsForDevice 返回 dir entries (含 readdirObserved=true / false), 排除 file/missing", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ledger-"));
  const store = new AccessLedgerStore({ dataDir: dir });
  const runtime = new AccessLedgerRuntime("dev-D");
  runtime.upsertDirPresent("/Users/foo/.claude/projects", 1, false);
  runtime.upsertDirPresent("/Users/foo/.claude/skills", 2, true);
  runtime.upsertFilePresent("/Users/foo/.claude/settings.json", 3);
  runtime.upsertMissing("/Users/foo/.claude/themes", 4);
  await store.persist(runtime);

  const dirs = await store.loadDirsForDevice("dev-D");
  assert.deepEqual(dirs.sort(), [
    "/Users/foo/.claude/projects",
    "/Users/foo/.claude/skills",
  ]);
});

test("loadDirsForDevice 不存在的 deviceId 返回空数组 (不抛)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ledger-"));
  const store = new AccessLedgerStore({ dataDir: dir });
  const dirs = await store.loadDirsForDevice("dev-NEW");
  assert.deepEqual(dirs, []);
});

test("loadMissingForDevice 返回的 path 可以被 FileProxyManager 投影按 root 过滤", async () => {
  // 模拟 FileProxyManager 的过滤逻辑: 仅注入位于本 session FUSE roots 内的 missing
  const dir = mkdtempSync(path.join(tmpdir(), "ledger-"));
  const store = new AccessLedgerStore({ dataDir: dir });
  const runtime = new AccessLedgerRuntime("dev-Y");
  runtime.upsertMissing("/Users/foo/.claude/themes", 1);
  runtime.upsertMissing("/Users/foo/some-other-app/missing", 2); // 不在 .claude 下
  await store.persist(runtime);

  const sessionRoots = ["/Users/foo/.claude", "/Users/foo/.claude.json"];
  const allMissing = await store.loadMissingForDevice("dev-Y");
  const filtered = allMissing.filter((p) =>
    sessionRoots.some((r) => p === r || p.startsWith(r + "/")),
  );
  assert.deepEqual(filtered, ["/Users/foo/.claude/themes"]);
});
