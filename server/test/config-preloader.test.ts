// ConfigPreloader 测试（Task 8）。

import assert from "node:assert";
import { test, describe } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { FileAgent } from "../src/file-agent/index.js";
import { ClientCacheStore } from "../src/file-agent/store.js";
import { ConfigPreloader } from "../src/config-preloader.js";
import type {
  FileAgentFetcher,
  PrefetchItem,
} from "../src/file-agent/types.js";

const DEVICE_ID = "device-cp";

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

async function makeStore() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cerelay-cp-"));
  return {
    dataDir,
    store: new ClientCacheStore({ dataDir }),
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}

function makeRecordingFetcher(): FileAgentFetcher & {
  prefetchItems: PrefetchItem[];
  fetchedPaths: string[];
} {
  const fetchedPaths: string[] = [];
  return {
    prefetchItems: [],
    fetchedPaths,
    fetchFile: async (absPath) => {
      fetchedPaths.push(absPath);
      return { kind: "missing" };
    },
    fetchStat: async () => ({ kind: "missing" }),
    fetchReaddir: async () => ({ kind: "missing" }),
  };
}

describe("ConfigPreloader（Task 8）", () => {
  test("preheat 调 fileAgent.prefetch 一次，items 含 home/.claude (dir-recursive) + .claude.json (file) + ancestor CLAUDE.md", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    let capturedItems: PrefetchItem[] | null = null;
    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: "/home/u",
      store,
      gcIntervalMs: 0,
    });

    // monkey-patch prefetch 来捕获参数
    const originalPrefetch = agent.prefetch.bind(agent);
    agent.prefetch = (async (items: PrefetchItem[], ttlMs: number) => {
      capturedItems = items;
      return {
        fetched: 0,
        alreadyHot: 0,
        missing: items.length,
        failed: [],
        durationMs: 1,
      };
    }) as typeof agent.prefetch;

    const preloader = new ConfigPreloader({
      homeDir: "/home/u",
      cwd: "/home/u/work/proj",
      fileAgent: agent,
      ttlMs: 7 * 24 * 3600 * 1000, // 7 天
    });

    await preloader.preheat();

    assert.ok(capturedItems);
    const items = capturedItems!;

    // home/.claude (dir-recursive)
    assert.ok(
      items.some((i) => i.kind === "dir-recursive" && i.absPath === "/home/u/.claude"),
      "应含 home/.claude dir-recursive 项",
    );
    // home/.claude.json (file)
    assert.ok(
      items.some((i) => i.kind === "file" && i.absPath === "/home/u/.claude.json"),
      "应含 home/.claude.json file 项",
    );
    // ancestor: /home/u/work/proj/CLAUDE.md, /home/u/work/proj/CLAUDE.local.md, /home/u/work/CLAUDE.md, /home/u/work/CLAUDE.local.md
    const expectedAncestor = [
      "/home/u/work/proj/CLAUDE.md",
      "/home/u/work/proj/CLAUDE.local.md",
      "/home/u/work/CLAUDE.md",
      "/home/u/work/CLAUDE.local.md",
    ];
    for (const expected of expectedAncestor) {
      assert.ok(
        items.some((i) => i.kind === "file" && i.absPath === expected),
        `ancestor 项 ${expected} 应在 prefetch items 中`,
      );
    }
    // 不应含 home 目录自身的 CLAUDE.md（因为 ancestor chain 不含 homeDir）
    assert.equal(
      items.some((i) => i.absPath === "/home/u/CLAUDE.md"),
      false,
    );
  });

  test("cwd === homeDir 时 ancestor 部分为空，仅含 home 两项", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    let capturedItems: PrefetchItem[] | null = null;
    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: "/home/u",
      store,
      gcIntervalMs: 0,
    });
    agent.prefetch = (async (items: PrefetchItem[]) => {
      capturedItems = items;
      return {
        fetched: 0,
        alreadyHot: 0,
        missing: 0,
        failed: [],
        durationMs: 0,
      };
    }) as typeof agent.prefetch;

    const preloader = new ConfigPreloader({
      homeDir: "/home/u",
      cwd: "/home/u",
      fileAgent: agent,
      ttlMs: 1000,
    });

    await preloader.preheat();
    assert.equal(capturedItems!.length, 2);
    assert.ok(capturedItems!.some((i) => i.absPath === "/home/u/.claude"));
    assert.ok(capturedItems!.some((i) => i.absPath === "/home/u/.claude.json"));
  });

  test("ttlMs 校验：拒绝 ≤0 / Infinity / NaN", () => {
    const dummyAgent = {} as FileAgent;
    assert.throws(
      () =>
        new ConfigPreloader({
          homeDir: "/h",
          cwd: "/h",
          fileAgent: dummyAgent,
          ttlMs: 0,
        }),
      RangeError,
    );
    assert.throws(
      () =>
        new ConfigPreloader({
          homeDir: "/h",
          cwd: "/h",
          fileAgent: dummyAgent,
          ttlMs: Infinity,
        }),
      RangeError,
    );
    assert.throws(
      () =>
        new ConfigPreloader({
          homeDir: "/h",
          cwd: "/h",
          fileAgent: dummyAgent,
          ttlMs: NaN,
        }),
      RangeError,
    );
  });

  test("preheat 透传 PrefetchResult 给调用方", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: "/home/u",
      store,
      gcIntervalMs: 0,
    });
    agent.prefetch = (async () => ({
      fetched: 5,
      alreadyHot: 3,
      missing: 2,
      failed: [{ absPath: "/x", reason: "test" }],
      durationMs: 42,
    })) as typeof agent.prefetch;

    const preloader = new ConfigPreloader({
      homeDir: "/home/u",
      cwd: "/home/u",
      fileAgent: agent,
      ttlMs: 1000,
    });

    const result = await preloader.preheat();
    assert.equal(result.fetched, 5);
    assert.equal(result.alreadyHot, 3);
    assert.equal(result.missing, 2);
    assert.equal(result.failed.length, 1);
  });

  test("getNamespaceMountPlan 返回 ancestor chain（不含 homeDir）", () => {
    const dummyAgent = {} as FileAgent;
    const preloader = new ConfigPreloader({
      homeDir: "/home/u",
      cwd: "/home/u/work/proj",
      fileAgent: dummyAgent,
      ttlMs: 1000,
    });
    const plan = preloader.getNamespaceMountPlan();
    assert.deepEqual(plan.ancestorDirs, ["/home/u/work/proj", "/home/u/work"]);
    assert.equal(plan.homeDir, "/home/u");
    assert.equal(plan.cwd, "/home/u/work/proj");
  });

  test("getNamespaceMountPlan 不含 fs root（cwd 在 homeDir 之外的兜底）", () => {
    const dummyAgent = {} as FileAgent;
    const preloader = new ConfigPreloader({
      homeDir: "/home/u",
      cwd: "/tmp/outside",
      fileAgent: dummyAgent,
      ttlMs: 1000,
    });
    const plan = preloader.getNamespaceMountPlan();
    assert.deepEqual(plan.ancestorDirs, ["/tmp/outside", "/tmp"]);
    assert.ok(!plan.ancestorDirs.includes("/"));
  });
});
