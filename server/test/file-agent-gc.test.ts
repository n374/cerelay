// FileAgent GC 测试（Task 7）。

import assert from "node:assert";
import { test, describe } from "node:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { FileAgent } from "../src/file-agent/index.js";
import { ClientCacheStore } from "../src/file-agent/store.js";
import { ScopeAdapter } from "../src/file-agent/scope-adapter.js";
import { TtlTable } from "../src/file-agent/ttl-table.js";
import { InflightMap, inflightKey } from "../src/file-agent/inflight.js";
import { GcRunner } from "../src/file-agent/gc.js";

const DEVICE_ID = "device-gc";
const HOME_DIR = "/home/u";

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

async function makeStore() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cerelay-gc-"));
  return {
    dataDir,
    store: new ClientCacheStore({ dataDir }),
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}

describe("GcRunner runOnce（Task 7）", () => {
  test("expiresAt < now 的 entry 被 evict（manifest 删除 + ttl 表 drop + blob 回收）", async (t) => {
    const { store, dataDir, cleanup } = await makeStore();
    t.after(cleanup);

    const adapter = new ScopeAdapter(HOME_DIR);
    let now = 1000;
    const ttl = new TtlTable({ now: () => now });
    const inflight = new InflightMap();

    const content = "data";
    const sha = sha256(content);
    await store.applyDelta(DEVICE_ID, [
      {
        kind: "upsert",
        scope: "claude-home",
        path: "x.txt",
        size: content.length,
        mtime: 1,
        sha256: sha,
        contentBase64: b64(content),
      },
    ]);
    const absPath = `${HOME_DIR}/.claude/x.txt`;
    ttl.bump(absPath, 100); // expiresAt = 1100

    const gc = new GcRunner({
      deviceId: DEVICE_ID,
      store,
      scopeAdapter: adapter,
      ttl,
      inflight,
      intervalMs: 1, // 不会用到（不 start）
    });

    // 推进时间使 entry 过期
    now = 2000;
    const result = await gc.runOnce();
    assert.equal(result.evicted, 1);
    assert.equal(result.skippedInflight, 0);
    assert.equal(result.deletedBlobs, 1, "对应 blob 被回收");

    // manifest 已无该 entry
    const m = await store.loadManifest(DEVICE_ID);
    assert.equal(m.scopes["claude-home"].entries["x.txt"], undefined);
    // blob 文件已删
    assert.equal(existsSync(path.join(dataDir, "client-cache", DEVICE_ID, "blobs", sha)), false);
    // ttl 表已 drop
    assert.equal(ttl.getExpiresAt(absPath), null);
  });

  test("expiresAt >= now 的 entry 不被 evict", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const adapter = new ScopeAdapter(HOME_DIR);
    const ttl = new TtlTable({ now: () => 1000 });
    const inflight = new InflightMap();

    const content = "stay";
    await store.applyDelta(DEVICE_ID, [
      {
        kind: "upsert",
        scope: "claude-home",
        path: "stay.txt",
        size: content.length,
        mtime: 1,
        sha256: sha256(content),
        contentBase64: b64(content),
      },
    ]);
    const absPath = `${HOME_DIR}/.claude/stay.txt`;
    ttl.bump(absPath, 10_000); // expiresAt = 11000，now = 1000，未过期

    const gc = new GcRunner({
      deviceId: DEVICE_ID,
      store,
      scopeAdapter: adapter,
      ttl,
      inflight,
      intervalMs: 1,
    });

    const result = await gc.runOnce();
    assert.equal(result.evicted, 0);

    const m = await store.loadManifest(DEVICE_ID);
    assert.ok(m.scopes["claude-home"].entries["stay.txt"]);
  });

  test("有 in-flight 的 path：跳过 evict，ttl 条目保留（下次 GC 重试）", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const adapter = new ScopeAdapter(HOME_DIR);
    let now = 1000;
    const ttl = new TtlTable({ now: () => now });
    const inflight = new InflightMap();

    const content = "data";
    await store.applyDelta(DEVICE_ID, [
      {
        kind: "upsert",
        scope: "claude-home",
        path: "x.txt",
        size: content.length,
        mtime: 1,
        sha256: sha256(content),
        contentBase64: b64(content),
      },
    ]);
    const absPath = `${HOME_DIR}/.claude/x.txt`;
    ttl.bump(absPath, 100); // expiresAt = 1100

    // 模拟 in-flight read
    let resolveInflight!: () => void;
    const inflightPromise = new Promise<number>((r) => {
      resolveInflight = () => r(42);
    });
    const dedupePromise = inflight.dedupe(inflightKey("read", absPath), () => inflightPromise);

    now = 2000;
    const gc = new GcRunner({
      deviceId: DEVICE_ID,
      store,
      scopeAdapter: adapter,
      ttl,
      inflight,
      intervalMs: 1,
    });

    const r1 = await gc.runOnce();
    assert.equal(r1.evicted, 0);
    assert.equal(r1.skippedInflight, 1);
    // ttl 条目保留
    assert.equal(ttl.getExpiresAt(absPath), 1100);
    // manifest 中 entry 未被删
    const m = await store.loadManifest(DEVICE_ID);
    assert.ok(m.scopes["claude-home"].entries["x.txt"]);

    // 解开 inflight，等 finally 微任务跑完再 GC
    resolveInflight();
    await dedupePromise;
    await new Promise((r) => setImmediate(r));

    const r2 = await gc.runOnce();
    assert.equal(r2.evicted, 1);
  });

  test("runOnce 重入保护：第二次并发调用不重复执行", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const adapter = new ScopeAdapter(HOME_DIR);
    const ttl = new TtlTable();
    const inflight = new InflightMap();
    const gc = new GcRunner({
      deviceId: DEVICE_ID,
      store,
      scopeAdapter: adapter,
      ttl,
      inflight,
      intervalMs: 1,
    });

    const [r1, r2] = await Promise.all([gc.runOnce(), gc.runOnce()]);
    // 至少一个 fast-path 返回 0（具体哪个不确定，但 evicted/deletedBlobs 都不应负或重复）
    assert.ok(r1.evicted === 0 && r2.evicted === 0);
  });
});

describe("FileAgent 启动期 GC（Task 7）", () => {
  test("默认配置启动周期 GC；close() 停止", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
      gcIntervalMs: 50, // 50ms 触发，便于测试
    });

    // 写一个会过期的 entry
    const content = "x";
    await store.applyDelta(DEVICE_ID, [
      {
        kind: "upsert",
        scope: "claude-home",
        path: "expire-me.txt",
        size: 1,
        mtime: 1,
        sha256: sha256(content),
        contentBase64: b64(content),
      },
    ]);
    const absPath = `${HOME_DIR}/.claude/expire-me.txt`;
    // 先 read 一次让 ttl 记录
    await agent.read(absPath, 5); // expiresAt = now + 5ms

    // 等待周期 GC 触发（intervalMs=50ms）
    await new Promise((r) => setTimeout(r, 200));

    const m = await store.loadManifest(DEVICE_ID);
    assert.equal(
      m.scopes["claude-home"].entries["expire-me.txt"],
      undefined,
      "周期 GC 应已清掉过期 entry",
    );

    await agent.close();
  });

  test("gcIntervalMs=0 → 不启动周期，但 runGcOnce() 可手动触发", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
      gcIntervalMs: 0,
    });

    const content = "hello";
    await store.applyDelta(DEVICE_ID, [
      {
        kind: "upsert",
        scope: "claude-home",
        path: "manual.txt",
        size: content.length,
        mtime: 1,
        sha256: sha256(content),
        contentBase64: b64(content),
      },
    ]);

    // 写 orphan blob
    const blobsDir = path.join(store.rootDir(), DEVICE_ID, "blobs");
    await writeFile(path.join(blobsDir, "orphan-aaaa"), "orphan", "utf8");

    const result = await agent.runGcOnce();
    assert.equal(result.deletedBlobs, 1, "orphan blob 被清");
    await agent.close();
  });
});
