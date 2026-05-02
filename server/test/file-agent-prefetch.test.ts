// FileAgent.prefetch 测试（Task 6）。

import assert from "node:assert";
import { test, describe } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { FileAgent } from "../src/file-agent/index.js";
import { ClientCacheStore } from "../src/file-agent/store.js";
import {
  DEFAULT_PREFETCH_CONCURRENCY,
  DEFAULT_PREFETCH_MAX_DEPTH,
} from "../src/file-agent/prefetch.js";
import type {
  FileAgentFetcher,
  FileAgentReadResult,
  FileAgentReaddirResult,
  PrefetchItem,
} from "../src/file-agent/types.js";

const DEVICE_ID = "device-pref";
const HOME_DIR = "/home/u";

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

async function makeStore() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cerelay-pf-"));
  return {
    dataDir,
    store: new ClientCacheStore({ dataDir }),
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}

/** 用 mock fetcher 模拟 client：通过 fixture 表查 absPath → content / dir entries。 */
function makeMockFetcher(opts: {
  files?: Record<string, string>; // absPath → content（应 fetch 成功）
  dirs?: Record<string, string[]>; // absPath → entries（dir 列表）
  failures?: Set<string>; // absPath → 抛错
  /** 每次 fetch 调用前的延迟（ms），让 bounded concurrency 测试能观察并发数 */
  delayMs?: number;
  maxConcurrent?: { value: number };
  current?: { value: number };
}): FileAgentFetcher & { stats: { fileFetches: number; dirFetches: number } } {
  const stats = { fileFetches: 0, dirFetches: 0 };
  const f: FileAgentFetcher & {
    stats: { fileFetches: number; dirFetches: number };
  } = {
    stats,
    fetchFile: async (absPath) => {
      stats.fileFetches += 1;
      if (opts.current) {
        opts.current.value += 1;
        if (opts.maxConcurrent && opts.current.value > opts.maxConcurrent.value) {
          opts.maxConcurrent.value = opts.current.value;
        }
      }
      try {
        if (opts.failures?.has(absPath)) {
          throw new Error(`mock-failure: ${absPath}`);
        }
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
        } satisfies FileAgentReadResult;
      } finally {
        if (opts.current) opts.current.value -= 1;
      }
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
      stats.dirFetches += 1;
      const entries = opts.dirs?.[absDir];
      if (entries === undefined) return { kind: "missing" };
      return { kind: "dir", entries } satisfies FileAgentReaddirResult;
    },
  };
  return f;
}

describe("FileAgent.prefetch（Task 6）", () => {
  test("空 items → 立即返回 fetched=0", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);
    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
    });
    const r = await agent.prefetch([], 1000);
    assert.equal(r.fetched, 0);
    assert.equal(r.alreadyHot, 0);
    assert.equal(r.missing, 0);
    assert.deepEqual(r.failed, []);
    assert.ok(r.durationMs >= 0);
  });

  test("单 file item，path 已在 cache → alreadyHot=1, expiresAt 续期", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const content = "hello";
    await store.applyDelta(DEVICE_ID, [
      {
        kind: "upsert",
        scope: "claude-home",
        path: "settings.json",
        size: content.length,
        mtime: 1,
        sha256: sha256(content),
        contentBase64: b64(content),
      },
    ]);

    let now = 1_700_000_000_000;
    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
      now: () => now,
    });

    const absPath = `${HOME_DIR}/.claude/settings.json`;
    const r = await agent.prefetch(
      [{ kind: "file", absPath }],
      5000,
    );
    assert.equal(r.alreadyHot, 1);
    assert.equal(r.fetched, 0);
    assert.equal(r.missing, 0);
    assert.equal(agent.getTtlForTest(absPath), now + 5000);
  });

  test("单 file item，path 不在 cache + fetcher 返回内容 → fetched=1", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const absPath = `${HOME_DIR}/.claude/x`;
    const fetcher = makeMockFetcher({ files: { [absPath]: "hello" } });
    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
      fetcher,
    });

    const r = await agent.prefetch([{ kind: "file", absPath }], 1000);
    assert.equal(r.fetched, 1);
    assert.equal(r.alreadyHot, 0);
    assert.equal(r.missing, 0);
    assert.equal(fetcher.stats.fileFetches, 1);
  });

  test("单 file item，fetcher 返回 missing → missing=1", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const absPath = `${HOME_DIR}/.claude/never`;
    const fetcher = makeMockFetcher({ files: {} });
    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
      fetcher,
    });

    const r = await agent.prefetch([{ kind: "file", absPath }], 1000);
    assert.equal(r.missing, 1);
    assert.equal(r.fetched, 0);
  });

  test("dir-shallow item → 展开第一层子项作为 file 处理", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const root = `${HOME_DIR}/.claude/sub`;
    const fetcher = makeMockFetcher({
      dirs: { [root]: ["a", "b"] },
      files: {
        [`${root}/a`]: "A",
        [`${root}/b`]: "B",
      },
    });
    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
      fetcher,
    });

    const r = await agent.prefetch(
      [{ kind: "dir-shallow", absPath: root }],
      1000,
    );
    assert.equal(r.fetched, 2);
    assert.equal(r.alreadyHot, 0);
    assert.equal(r.missing, 0);
    assert.equal(fetcher.stats.dirFetches, 1, "dir-shallow 只 readdir 一次");
  });

  test("dir-recursive item → 递归 readdir + 每个文件 read", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const root = `${HOME_DIR}/.claude/sub`;
    const dirA = `${root}/a`;
    // 树形结构：sub → [a, b]; a → [x]; b 是文件
    const fetcher = makeMockFetcher({
      dirs: {
        [root]: ["a", "b"],
        [dirA]: ["x"],
      },
      files: {
        [`${dirA}/x`]: "X",
        [`${root}/b`]: "B",
      },
    });
    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
      fetcher,
    });

    const r = await agent.prefetch(
      [{ kind: "dir-recursive", absPath: root }],
      1000,
    );
    // 应处理 sub/a/x 和 sub/b 两个文件
    assert.equal(r.fetched, 2, "递归找到 2 个文件");
  });

  test("bounded concurrency：同时 in-flight ≤ concurrency 默认值", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const N = 100;
    const files: Record<string, string> = {};
    const items: PrefetchItem[] = [];
    for (let i = 0; i < N; i += 1) {
      const p = `${HOME_DIR}/.claude/f${i}`;
      files[p] = `c${i}`;
      items.push({ kind: "file", absPath: p });
    }
    const current = { value: 0 };
    const maxConcurrent = { value: 0 };
    const fetcher = makeMockFetcher({ files, delayMs: 5, current, maxConcurrent });

    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
      fetcher,
    });

    const r = await agent.prefetch(items, 1000);
    assert.equal(r.fetched, N);
    assert.ok(
      maxConcurrent.value <= DEFAULT_PREFETCH_CONCURRENCY,
      `预期 in-flight ≤ ${DEFAULT_PREFETCH_CONCURRENCY}，实际 ${maxConcurrent.value}`,
    );
    // 应该至少触发到接近 concurrency 上限（避免没并发的退化测试）
    assert.ok(
      maxConcurrent.value >= 2,
      `bounded concurrency 应允许并行；实际峰值 ${maxConcurrent.value}`,
    );
  });

  test("单项失败不阻塞其他项，进 failed[]", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const okPath = `${HOME_DIR}/.claude/ok`;
    const badPath = `${HOME_DIR}/.claude/bad`;
    const fetcher = makeMockFetcher({
      files: { [okPath]: "ok", [badPath]: "ignored" },
      failures: new Set([badPath]),
    });
    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
      fetcher,
    });

    const r = await agent.prefetch(
      [
        { kind: "file", absPath: okPath },
        { kind: "file", absPath: badPath },
      ],
      1000,
    );
    assert.equal(r.fetched, 1);
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0].absPath, badPath);
    assert.match(r.failed[0].reason, /mock-failure/);
  });

  test("prefetch 进行中并发 read 同 path 共享 inflight，不重复穿透", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const absPath = `${HOME_DIR}/.claude/shared`;
    const fetcher = makeMockFetcher({
      files: { [absPath]: "shared-content" },
      delayMs: 30,
    });
    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
      fetcher,
    });

    // 同时启动 prefetch + 多个 read
    const prefetchP = agent.prefetch([{ kind: "file", absPath }], 1000);
    // 让 prefetch 先进入 inflight
    await new Promise((r) => setTimeout(r, 5));
    const reads = await Promise.all([
      agent.read(absPath, 1000).catch((e) => e),
      agent.read(absPath, 1000).catch((e) => e),
    ]);
    const result = await prefetchP;

    assert.equal(fetcher.stats.fileFetches, 1, "prefetch + 2 reads 共享一次穿透");
    assert.equal(result.fetched, 1);
    for (const r of reads) {
      assert.ok(r && typeof r === "object" && "kind" in r && r.kind === "file");
    }
  });

  test("ttlMs 校验：非法 ttl → RangeError", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);
    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
    });
    await assert.rejects(() => agent.prefetch([], 0), RangeError);
    await assert.rejects(() => agent.prefetch([], -1), RangeError);
    await assert.rejects(() => agent.prefetch([], Infinity), RangeError);
  });

  test("DEFAULT_PREFETCH_MAX_DEPTH = 8（plan §10.2 决策）", () => {
    assert.equal(DEFAULT_PREFETCH_MAX_DEPTH, 8);
  });
});
