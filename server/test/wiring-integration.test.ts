// Plan §9.1 三处 wiring 接通的端到端测试。
//
// 闭环验证：
//   #1 dispatcher: server.ts 创建 FileAgent 时注入 SyncCoordinator + CacheTaskClientDispatcher
//   #2 FUSE IPC 命中通知 FileAgent: FileProxyManager.tryServeReadFromCache 命中后调
//      fileAgent.bumpTtlForExternalHit
//   #3 watcher delta 接 FileAgent: cache-task-manager.applyDelta 后回调 onDeltaApplied →
//      FileAgent.notifyWatcherDeltaApplied → TTL 续期 + telemetry

import assert from "node:assert";
import { test, describe } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { FileAgent, ScopeAdapter, InflightMap } from "../src/file-agent/index.js";
import { ClientCacheStore } from "../src/file-agent/store.js";
import { SyncCoordinator } from "../src/file-agent/sync-coordinator.js";
import { CacheTaskClientDispatcher } from "../src/file-agent/cache-task-dispatcher.js";

const DEVICE_ID = "device-wiring";
const HOME_DIR = "/home/u";

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

async function makeStore() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cerelay-wiring-"));
  return {
    dataDir,
    store: new ClientCacheStore({ dataDir }),
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}

describe("Wiring §9.1 #1: CacheTaskClientDispatcher 接 FileAgent", () => {
  test("FileAgent.read miss + dispatcher store hit → 返回 file kind（不抛 unavailable）", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    // active client 之前已经通过 cache_task_delta 推过这个 path
    const content = "pushed-by-active-client";
    await store.applyDelta(DEVICE_ID, [
      {
        kind: "upsert",
        scope: "claude-home",
        path: "x",
        size: content.length,
        mtime: 1,
        sha256: sha256(content),
        contentBase64: b64(content),
      },
    ]);

    // 装配链路：dispatcher → SyncCoordinator → FileAgent
    const scopeAdapter = new ScopeAdapter(HOME_DIR);
    const inflight = new InflightMap();
    const dispatcher = new CacheTaskClientDispatcher({
      deviceId: DEVICE_ID,
      store,
      scopeAdapter,
    });
    const syncCoord = new SyncCoordinator({
      deviceId: DEVICE_ID,
      store,
      scopeAdapter,
      inflight,
      dispatcher,
    });
    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
      fetcher: syncCoord,
      gcIntervalMs: 0,
    });
    t.after(() => agent.close());

    // FileAgent.read 直接命中 store（path 已在 manifest）
    const r = await agent.read(`${HOME_DIR}/.claude/x`, 1000);
    assert.equal(r.kind, "file");
    if (r.kind === "file") {
      assert.equal(r.content.toString("utf8"), content);
    }
  });

  test("FileAgent.read 真正 miss（manifest 也没）+ dispatcher 返 null → missing kind（不抛错）", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const scopeAdapter = new ScopeAdapter(HOME_DIR);
    const inflight = new InflightMap();
    const dispatcher = new CacheTaskClientDispatcher({
      deviceId: DEVICE_ID,
      store,
      scopeAdapter,
    });
    const syncCoord = new SyncCoordinator({
      deviceId: DEVICE_ID,
      store,
      scopeAdapter,
      inflight,
      dispatcher,
    });
    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
      fetcher: syncCoord,
      gcIntervalMs: 0,
    });
    t.after(() => agent.close());

    const r = await agent.read(`${HOME_DIR}/.claude/never`, 1000);
    assert.equal(r.kind, "missing", "dispatcher 返 null 时 FileAgent.read 返 missing，不抛 unavailable");
  });
});

describe("Wiring §9.1 #2: FileAgent.bumpTtlForExternalHit", () => {
  test("外部命中调 bumpTtlForExternalHit 后 TTL 表中该 path 有 expiresAt", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    let now = 1000;
    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
      gcIntervalMs: 0,
      now: () => now,
    });
    t.after(() => agent.close());

    const absPath = `${HOME_DIR}/.claude/external-hit`;
    agent.bumpTtlForExternalHit(absPath, 5000);
    assert.equal(agent.getTtlForTest(absPath), 6000);
  });

  test("非法 ttlMs 静默忽略（FUSE 路径调用频繁不抛错）", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
      gcIntervalMs: 0,
    });
    t.after(() => agent.close());

    // 不抛错
    agent.bumpTtlForExternalHit("/home/u/.claude/x", 0);
    agent.bumpTtlForExternalHit("/home/u/.claude/x", -1);
    agent.bumpTtlForExternalHit("/home/u/.claude/x", Infinity);
    agent.bumpTtlForExternalHit("/home/u/.claude/x", NaN);
    // 都不应有 ttl 记录
    assert.equal(agent.getTtlForTest("/home/u/.claude/x"), null);
  });

  test("不在已知 scope 内的 path 静默忽略", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
      gcIntervalMs: 0,
    });
    t.after(() => agent.close());

    agent.bumpTtlForExternalHit("/tmp/random", 5000);
    assert.equal(agent.getTtlForTest("/tmp/random"), null);
  });

  test("bumpTtlForExternalHit 后 GC 不会 evict 该 path", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const content = "external-hit-data";
    await store.applyDelta(DEVICE_ID, [
      {
        kind: "upsert",
        scope: "claude-home",
        path: "p",
        size: content.length,
        mtime: 1,
        sha256: sha256(content),
        contentBase64: b64(content),
      },
    ]);

    let now = 1000;
    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
      gcIntervalMs: 0,
      now: () => now,
    });
    t.after(() => agent.close());

    // FUSE 外部命中 → 续期 10 分钟
    agent.bumpTtlForExternalHit(`${HOME_DIR}/.claude/p`, 10 * 60 * 1000);

    // 推进时间 5 分钟（未到 10 分钟过期）
    now = 1000 + 5 * 60 * 1000;
    const result = await agent.runGcOnce();
    assert.equal(result.evicted, 0, "5 分钟时还未到 10 分钟过期，GC 不该清");
    const entry = await store.lookupEntry(DEVICE_ID, "claude-home", "p");
    assert.ok(entry, "manifest entry 仍在");
  });
});

describe("Wiring §9.1 #3: FileAgent.notifyWatcherDeltaApplied", () => {
  test("watcher delta 通知后受影响 path 续期 TTL", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    let now = 1000;
    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
      gcIntervalMs: 0,
      now: () => now,
    });
    t.after(() => agent.close());

    // 模拟 cache-task-manager.applyDelta 已经把这条 change 应用到 store；
    // 现在通知 FileAgent
    await agent.notifyWatcherDeltaApplied(
      [
        {
          kind: "upsert",
          scope: "claude-home",
          path: "watched.json",
          size: 5,
          mtime: 1,
          sha256: sha256("hello"),
          contentBase64: b64("hello"),
        },
      ],
      30_000, // 30s ttl
    );

    const absPath = `${HOME_DIR}/.claude/watched.json`;
    assert.equal(agent.getTtlForTest(absPath), 31_000);
  });

  test("notifyWatcherDeltaApplied 不重复 apply（依赖外部已 apply）", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
      gcIntervalMs: 0,
    });
    t.after(() => agent.close());

    // 不预先 apply 到 store
    await agent.notifyWatcherDeltaApplied([
      {
        kind: "upsert",
        scope: "claude-home",
        path: "not-yet-applied",
        size: 1,
        mtime: 1,
        sha256: sha256("x"),
        contentBase64: b64("x"),
      },
    ]);
    // store 应该没该 entry（FileAgent 没替外部 apply）
    const entry = await store.lookupEntry(DEVICE_ID, "claude-home", "not-yet-applied");
    assert.equal(entry, null);
  });

  test("delete change 也续期 TTL（防 race：watcher 删完后 FUSE 还在命中旧版）", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    let now = 1000;
    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
      gcIntervalMs: 0,
      now: () => now,
    });
    t.after(() => agent.close());

    await agent.notifyWatcherDeltaApplied(
      [{ kind: "delete", scope: "claude-home", path: "removed.json" }],
      5000,
    );
    assert.equal(agent.getTtlForTest(`${HOME_DIR}/.claude/removed.json`), 6000);
  });
});

describe("Wiring §9.1 #1+#2+#3 端到端", () => {
  test("装配链路：CacheTaskClientDispatcher → SyncCoordinator → FileAgent；外部命中 + watcher delta 都续期 TTL", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    let now = 1000;
    const scopeAdapter = new ScopeAdapter(HOME_DIR);
    const inflight = new InflightMap();
    const dispatcher = new CacheTaskClientDispatcher({
      deviceId: DEVICE_ID,
      store,
      scopeAdapter,
    });
    const syncCoord = new SyncCoordinator({
      deviceId: DEVICE_ID,
      store,
      scopeAdapter,
      inflight,
      dispatcher,
    });
    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
      fetcher: syncCoord,
      gcIntervalMs: 0,
      now: () => now,
    });
    t.after(() => agent.close());

    // 1. watcher 推 delta：cache-task-manager 落 store + 通知 FileAgent
    const v1 = "v1";
    await store.applyDelta(DEVICE_ID, [
      {
        kind: "upsert",
        scope: "claude-home",
        path: "wired",
        size: v1.length,
        mtime: 1,
        sha256: sha256(v1),
        contentBase64: b64(v1),
      },
    ]);
    await agent.notifyWatcherDeltaApplied(
      [
        {
          kind: "upsert",
          scope: "claude-home",
          path: "wired",
          size: v1.length,
          mtime: 1,
          sha256: sha256(v1),
          contentBase64: b64(v1),
        },
      ],
      60_000,
    );

    const absPath = `${HOME_DIR}/.claude/wired`;
    assert.equal(agent.getTtlForTest(absPath), 61_000);

    // 2. FileAgent.read miss 时（path 不在 store）→ dispatcher 查 store → null → missing
    const rMissing = await agent.read(`${HOME_DIR}/.claude/never`, 1000);
    assert.equal(rMissing.kind, "missing");

    // 3. FileAgent.read 命中已 watcher delta 推过的 path → 直接命中
    const rHit = await agent.read(absPath, 1000);
    assert.equal(rHit.kind, "file");
    if (rHit.kind === "file") {
      assert.equal(rHit.content.toString("utf8"), v1);
    }

    // 4. FUSE 外部命中通知 → 续期更长 ttl
    agent.bumpTtlForExternalHit(absPath, 600_000);
    assert.equal(agent.getTtlForTest(absPath), 601_000);
  });
});
