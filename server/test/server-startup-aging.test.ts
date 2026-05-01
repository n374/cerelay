import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AccessLedgerRuntime, AccessLedgerStore } from "../src/access-ledger.js";

/**
 * 启动期 aging 集成: 模拟 server.ts 启动时对所有 deviceId 跑 aging.
 *
 * 实际 server.start() 会调 runLedgerAging() — 这里直接复制等价逻辑测 store +
 * runtime contract, 避免 spawn 整个 HTTP server.
 */

async function runLedgerAging(
  store: AccessLedgerStore,
  ageDays: number,
  now: number,
): Promise<{ totalCleaned: number; processedDevices: string[] }> {
  const ageMs = ageDays * 24 * 3600 * 1000;
  const fs = await import("node:fs/promises");
  let devices: string[];
  try {
    devices = await fs.readdir(store.rootDir());
  } catch {
    return { totalCleaned: 0, processedDevices: [] };
  }

  let totalCleaned = 0;
  const processed: string[] = [];
  for (const deviceId of devices) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(deviceId)) continue;
    const ledger = await store.load(deviceId);
    const before = ledger.missingSortedSnapshot().length;
    ledger.runAging(now, ageMs);
    const after = ledger.missingSortedSnapshot().length;
    if (before !== after) {
      ledger.bumpRevision();
      await store.persist(ledger);
      totalCleaned += before - after;
    }
    processed.push(deviceId);
  }
  return { totalCleaned, processedDevices: processed };
}

test("启动期 aging: 多 device 各自清自己的 missing", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aging-"));
  const store = new AccessLedgerStore({ dataDir: dir });
  const now = 10_000_000_000;
  const old = now - 31 * 24 * 3600 * 1000;
  const recent = now - 1000;

  // device A: 2 个 old missing, 1 个 recent missing
  const r1 = new AccessLedgerRuntime("dev-A");
  r1.upsertMissing("/a/old1", old);
  r1.upsertMissing("/a/old2", old);
  r1.upsertMissing("/a/recent", recent);
  r1.upsertFilePresent("/a/file", old); // file 永久保留
  await store.persist(r1);

  // device B: 全部 recent
  const r2 = new AccessLedgerRuntime("dev-B");
  r2.upsertMissing("/b/recent1", recent);
  r2.upsertMissing("/b/recent2", recent);
  await store.persist(r2);

  const result = await runLedgerAging(store, 30, now);

  assert.equal(result.totalCleaned, 2, "device A 清 2 个 old missing");
  assert.deepEqual(result.processedDevices.sort(), ["dev-A", "dev-B"]);

  // 验证最终状态
  const finalA = await store.load("dev-A");
  assert.deepEqual(finalA.missingSortedSnapshot(), ["/a/recent"]);
  assert.ok(finalA.toJSON().entries["/a/file"], "file 永久保留");

  const finalB = await store.load("dev-B");
  assert.equal(finalB.missingSortedSnapshot().length, 2);
});

test("启动期 aging: access-ledger 目录不存在时不抛", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aging-"));
  const store = new AccessLedgerStore({ dataDir: dir });
  const result = await runLedgerAging(store, 30, Date.now());
  assert.equal(result.totalCleaned, 0);
  assert.deepEqual(result.processedDevices, []);
});

test("启动期 aging: 跳过非法 deviceId 目录", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aging-"));
  const store = new AccessLedgerStore({ dataDir: dir });
  const r1 = new AccessLedgerRuntime("dev-valid");
  r1.upsertMissing("/x", Date.now() - 31 * 24 * 3600 * 1000);
  await store.persist(r1);

  // 创建非法目录 (不应被处理)
  const fs = await import("node:fs/promises");
  await fs.mkdir(path.join(store.rootDir(), ".hidden"), { recursive: true });
  await fs.mkdir(path.join(store.rootDir(), "../parent"), { recursive: true });

  const result = await runLedgerAging(store, 30, Date.now());
  assert.deepEqual(result.processedDevices, ["dev-valid"]);
});
