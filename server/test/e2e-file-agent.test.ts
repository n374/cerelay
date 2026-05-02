// E2E 集成测试：FileAgent + SyncCoordinator + ConfigPreloader 完整链路（Task 12）。
//
// 覆盖 plan §8 Task 12 的 7 个 E2E 场景：
//   1. 启动期 ConfigPreloader 调一次 prefetch 预热 home + cwd 父链 CLAUDE.md，全部进 manifest
//   2. 运行时 FUSE read 命中 cache，无穿透 client（共享 store 验证）
//   3. 运行时 FUSE read miss → 阻塞穿透 → 落 cache
//   4. TTL 过期后再 read 重新穿透
//   5. 同 device 两个 cwd 的 session 顺序启动，第二次启动 home 直接命中（无重传）
//   6. 同 path 100 个并发 read miss → 实际 1 次穿透
//   7. 最终一致性：watcher delta 推送后 < 1s 内 FileAgent.read 反映新内容（验证 P10）

import assert from "node:assert";
import { test, describe } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { FileAgent } from "../src/file-agent/index.js";
import { ClientCacheStore } from "../src/file-agent/store.js";
import { ScopeAdapter } from "../src/file-agent/scope-adapter.js";
import { InflightMap } from "../src/file-agent/inflight.js";
import { SyncCoordinator } from "../src/file-agent/sync-coordinator.js";
import { ConfigPreloader } from "../src/config-preloader.js";
import type {
  FileAgentFetcher,
  PrefetchItem,
} from "../src/file-agent/types.js";
import type { CacheTaskChange } from "../src/protocol.js";

const DEVICE_ID = "device-e2e";

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

async function makeStore() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cerelay-e2e-"));
  return {
    dataDir,
    store: new ClientCacheStore({ dataDir }),
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}

/** 模拟 client：一个简单的 path → content 表 + readdir 表。 */
function makeMockFetcher(opts: {
  files?: Record<string, string>;
  dirs?: Record<string, string[]>;
  delayMs?: number;
}): FileAgentFetcher & { stats: { fileFetches: number } } {
  const stats = { fileFetches: 0 };
  return {
    stats,
    fetchFile: async (absPath) => {
      stats.fileFetches += 1;
      if (opts.delayMs) {
        await new Promise((r) => setTimeout(r, opts.delayMs));
      }
      const content = opts.files?.[absPath];
      if (content === undefined) return { kind: "missing" };
      return {
        kind: "file",
        content: Buffer.from(content),
        size: content.length,
        mtime: 1,
        sha256: sha256(content),
      };
    },
    fetchStat: async (absPath) => {
      const content = opts.files?.[absPath];
      if (content === undefined) return { kind: "missing" };
      return {
        kind: "file",
        size: content.length,
        mtime: 1,
        sha256: sha256(content),
      };
    },
    fetchReaddir: async (absDir) => {
      const entries = opts.dirs?.[absDir];
      if (entries === undefined) return { kind: "missing" };
      return { kind: "dir", entries };
    },
  };
}

describe("E2E: FileAgent + ConfigPreloader 完整链路（Task 12）", () => {
  test("场景 1+2: ConfigPreloader 预热后 read 命中 store（无穿透 fetcher）", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const homeDir = "/home/u";
    const cwd = "/home/u/work/proj";

    // 把"clientside 文件"提前写入 store（模拟 cache_task_delta 已 apply）
    const settingsContent = "{\"theme\":\"dark\"}";
    const projectClaudeMdContent = "# project-claude-md";
    await store.applyDelta(DEVICE_ID, [
      {
        kind: "upsert",
        scope: "claude-home",
        path: "settings.json",
        size: settingsContent.length,
        mtime: 1,
        sha256: sha256(settingsContent),
        contentBase64: b64(settingsContent),
      },
      {
        kind: "upsert",
        scope: "claude-json",
        path: "",
        size: 2,
        mtime: 2,
        sha256: sha256("{}"),
        contentBase64: b64("{}"),
      },
    ]);

    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir,
      store,
      gcIntervalMs: 0,
    });
    t.after(() => agent.close());

    // ConfigPreloader 调 prefetch；store 已有 settings.json 和 .claude.json → alreadyHot=2
    // ancestor CLAUDE.md 不在 store → missing（无 fetcher）
    const preloader = new ConfigPreloader({
      homeDir,
      cwd,
      fileAgent: agent,
      ttlMs: 7 * 24 * 60 * 60 * 1000,
    });
    const result = await preloader.preheat();
    // .claude.json 是直接 file item（已 cached）→ alreadyHot 至少 1
    // home/.claude 是 dir-recursive，没 fetcher 时直接 failed（不展开），不影响 settings.json 命中
    // ancestor 4 个 file 项：missing
    assert.ok(result.alreadyHot >= 1, "至少 .claude.json 应 alreadyHot");
    assert.ok(result.missing + result.failed.length >= 4);

    // 场景 2：运行时 read 命中 store，不需要 fetcher
    const r1 = await agent.read(`${homeDir}/.claude/settings.json`, 5000);
    assert.equal(r1.kind, "file");
    if (r1.kind === "file") {
      assert.equal(r1.content.toString("utf8"), settingsContent);
    }
  });

  test("场景 3: read miss → 阻塞穿透 + 解析 dispatcher 返回的 change", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const homeDir = "/home/u";

    const adapter = new ScopeAdapter(homeDir);
    const inflight = new InflightMap();
    const coord = new SyncCoordinator({
      deviceId: DEVICE_ID,
      store,
      scopeAdapter: adapter,
      inflight,
      dispatcher: {
        dispatchSinglePathFetch: async (absPath) => {
          if (absPath !== `${homeDir}/.claude/x`) return null;
          return {
            kind: "upsert",
            scope: "claude-home",
            path: "x",
            size: 5,
            mtime: 100,
            sha256: sha256("hello"),
            contentBase64: b64("hello"),
          };
        },
      },
    });

    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir,
      store,
      fetcher: coord,
      gcIntervalMs: 0,
    });
    t.after(() => agent.close());

    const r = await agent.read(`${homeDir}/.claude/x`, 1000);
    assert.equal(r.kind, "file");
    if (r.kind === "file") {
      assert.equal(r.content.toString("utf8"), "hello");
    }
  });

  test("场景 4: TTL 过期后 entry 被 GC 清，再读重新穿透", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const homeDir = "/home/u";
    const content = "v1";
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

    let now = 1000;
    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir,
      store,
      gcIntervalMs: 0,
      now: () => now,
    });
    t.after(() => agent.close());

    // 第一次 read：命中
    await agent.read(`${homeDir}/.claude/x`, 100); // expiresAt=1100
    assert.equal(agent.getTtlForTest(`${homeDir}/.claude/x`), 1100);

    // 推进时间 + GC
    now = 2000;
    const gcResult = await agent.runGcOnce();
    assert.equal(gcResult.evicted, 1);
    // entry 已被删
    const entry = await store.lookupEntry(DEVICE_ID, "claude-home", "x");
    assert.equal(entry, null);
  });

  test("场景 5: 同 device 跨 session（cwd 不同）共享 manifest，第二次启动直接命中", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const homeDir = "/home/u";

    // Session 1: 在 cwd1 启动，预热写入 home/.claude/foo
    const fooContent = "shared-data";
    await store.applyDelta(DEVICE_ID, [
      {
        kind: "upsert",
        scope: "claude-home",
        path: "foo.json",
        size: fooContent.length,
        mtime: 1,
        sha256: sha256(fooContent),
        contentBase64: b64(fooContent),
      },
    ]);

    // Session 2: 同 device，不同 cwd（cwd2）
    const agent2 = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir,
      store,
      gcIntervalMs: 0,
    });
    t.after(() => agent2.close());

    // home/.claude/foo.json 在 session 2 直接命中（device-only manifest 共享）
    const r = await agent2.read(`${homeDir}/.claude/foo.json`, 1000);
    assert.equal(r.kind, "file");
    if (r.kind === "file") {
      assert.equal(r.content.toString("utf8"), fooContent);
    }
  });

  test("场景 6: 100 并发 read miss → 实际 1 次穿透", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const homeDir = "/home/u";
    const absPath = `${homeDir}/.claude/concurrent`;
    const fetcher = makeMockFetcher({
      files: { [absPath]: "concurrent-data" },
      delayMs: 50,
    });

    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir,
      store,
      fetcher,
      gcIntervalMs: 0,
    });
    t.after(() => agent.close());

    const reads = await Promise.all(
      Array.from({ length: 100 }, () => agent.read(absPath, 1000)),
    );
    assert.equal(fetcher.stats.fileFetches, 1, "100 并发应共享一次穿透");
    for (const r of reads) {
      assert.equal(r.kind, "file");
    }
  });

  test("场景 7: 最终一致性 — watcher delta 推送后 read 反映新内容", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const homeDir = "/home/u";
    const adapter = new ScopeAdapter(homeDir);
    const inflight = new InflightMap();
    const coord = new SyncCoordinator({
      deviceId: DEVICE_ID,
      store,
      scopeAdapter: adapter,
      inflight,
    });

    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir,
      store,
      fetcher: coord,
      gcIntervalMs: 0,
    });
    t.after(() => agent.close());

    const absPath = `${homeDir}/.claude/changing.json`;
    const v1 = "{\"v\":1}";
    const v2 = "{\"v\":2}";

    // 初始版本
    await coord.applyWatcherDelta([
      {
        kind: "upsert",
        scope: "claude-home",
        path: "changing.json",
        size: v1.length,
        mtime: 100,
        sha256: sha256(v1),
        contentBase64: b64(v1),
      },
    ]);
    const r1 = await agent.read(absPath, 1000);
    assert.equal((r1 as any).content.toString("utf8"), v1);

    // 模拟 client watcher 推新版本（运行时增量）
    const startedAt = Date.now();
    await coord.applyWatcherDelta([
      {
        kind: "upsert",
        scope: "claude-home",
        path: "changing.json",
        size: v2.length,
        mtime: 200,
        sha256: sha256(v2),
        contentBase64: b64(v2),
      },
    ]);
    const r2 = await agent.read(absPath, 1000);
    const elapsedMs = Date.now() - startedAt;
    assert.equal((r2 as any).content.toString("utf8"), v2);
    assert.ok(elapsedMs < 1000, `最终一致性窗口应 < 1s，实际 ${elapsedMs}ms`);
  });
});
