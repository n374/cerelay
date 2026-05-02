// SyncCoordinator 双路写入测试（Task 5）。

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
import {
  buildSinglePathFetchPlan,
  findChangeForAbsPath,
  projectChangeAbsPath,
} from "../src/file-agent/client-protocol-v1.js";
import type { CacheTaskChange } from "../src/protocol.js";

const DEVICE_ID = "device-sync";
const HOME_DIR = "/home/u";

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

async function makeStore() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cerelay-sc-"));
  return {
    dataDir,
    store: new ClientCacheStore({ dataDir }),
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}

describe("client-protocol-v1 builders（Task 5）", () => {
  test("buildSinglePathFetchPlan：~/.claude/foo → claude-home scope, files=[foo]", () => {
    const adapter = new ScopeAdapter(HOME_DIR);
    const plan = buildSinglePathFetchPlan(`${HOME_DIR}/.claude/foo`, adapter);
    assert.ok(plan);
    assert.deepEqual(plan.scopes["claude-home"], {
      subtrees: [],
      files: ["foo"],
      knownMissing: [],
    });
    assert.equal(plan.scopes["claude-json"], undefined);
  });

  test("buildSinglePathFetchPlan：~/.claude.json → claude-json scope, files=['']", () => {
    const adapter = new ScopeAdapter(HOME_DIR);
    const plan = buildSinglePathFetchPlan(`${HOME_DIR}/.claude.json`, adapter);
    assert.ok(plan);
    assert.deepEqual(plan.scopes["claude-json"], {
      subtrees: [],
      files: [""],
      knownMissing: [],
    });
  });

  test("buildSinglePathFetchPlan：不在已知 scope → null", () => {
    const adapter = new ScopeAdapter(HOME_DIR);
    assert.equal(buildSinglePathFetchPlan("/tmp/random", adapter), null);
  });

  test("findChangeForAbsPath：从 changes 列表里精确找出 path 的 change", () => {
    const adapter = new ScopeAdapter(HOME_DIR);
    const changes: CacheTaskChange[] = [
      {
        kind: "upsert",
        scope: "claude-home",
        path: "settings.json",
        size: 5,
        mtime: 1,
        sha256: sha256("hello"),
        contentBase64: b64("hello"),
      },
      {
        kind: "upsert",
        scope: "claude-home",
        path: "other.txt",
        size: 1,
        mtime: 2,
        sha256: sha256("o"),
        contentBase64: b64("o"),
      },
    ];
    const found = findChangeForAbsPath(
      changes,
      `${HOME_DIR}/.claude/settings.json`,
      adapter,
    );
    assert.ok(found);
    assert.equal(found.kind, "upsert");
    assert.equal(found.path, "settings.json");
  });

  test("projectChangeAbsPath：把 change 投影成 absPath", () => {
    const adapter = new ScopeAdapter(HOME_DIR);
    const change: CacheTaskChange = {
      kind: "upsert",
      scope: "claude-home",
      path: "x.txt",
      size: 1,
      mtime: 1,
      sha256: sha256("y"),
      contentBase64: b64("y"),
    };
    const proj = projectChangeAbsPath(change, adapter);
    assert.equal(proj.absPath, `${HOME_DIR}/.claude/x.txt`);
    assert.equal(proj.scope, "claude-home");
    assert.equal(proj.relPath, "x.txt");
  });
});

describe("SyncCoordinator 路径 B: watcher delta apply（Task 5）", () => {
  test("applyWatcherDelta apply 后 FileAgent.read 命中新内容", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const adapter = new ScopeAdapter(HOME_DIR);
    const inflight = new InflightMap();
    const coord = new SyncCoordinator({
      deviceId: DEVICE_ID,
      store,
      scopeAdapter: adapter,
      inflight,
    });

    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
    });

    const content = "watched-content";
    await coord.applyWatcherDelta([
      {
        kind: "upsert",
        scope: "claude-home",
        path: "settings.json",
        size: content.length,
        mtime: 1700000000000,
        sha256: sha256(content),
        contentBase64: b64(content),
      },
    ]);

    const r = await agent.read(`${HOME_DIR}/.claude/settings.json`, 1000);
    assert.equal(r.kind, "file");
    if (r.kind === "file") {
      assert.equal(r.content.toString("utf8"), content);
    }
  });

  test("applyWatcherDelta 空 changes 数组不操作", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);
    const adapter = new ScopeAdapter(HOME_DIR);
    const inflight = new InflightMap();
    const coord = new SyncCoordinator({
      deviceId: DEVICE_ID,
      store,
      scopeAdapter: adapter,
      inflight,
    });
    await coord.applyWatcherDelta([]);
    const m = await store.loadManifest(DEVICE_ID);
    assert.equal(m.revision, 0);
  });

  test("applyWatcherDelta 处理 delete change → manifest 中 entry 被移除", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    // 先写一个 entry
    const content = "hello";
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

    const adapter = new ScopeAdapter(HOME_DIR);
    const inflight = new InflightMap();
    const coord = new SyncCoordinator({
      deviceId: DEVICE_ID,
      store,
      scopeAdapter: adapter,
      inflight,
    });
    await coord.applyWatcherDelta([
      { kind: "delete", scope: "claude-home", path: "x" },
    ]);

    const m = await store.loadManifest(DEVICE_ID);
    assert.equal(m.scopes["claude-home"].entries["x"], undefined);
  });
});

describe("SyncCoordinator 路径 A: fetch（Task 5 stub，Task 9 接通）", () => {
  test("fetchFile 缺省 dispatcher → 抛 FileAgentUnavailable", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const adapter = new ScopeAdapter(HOME_DIR);
    const inflight = new InflightMap();
    const coord = new SyncCoordinator({
      deviceId: DEVICE_ID,
      store,
      scopeAdapter: adapter,
      inflight,
      // dispatcher 不传
    });

    await assert.rejects(
      () => coord.fetchFile(`${HOME_DIR}/.claude/x`),
      /FileAgent: client unavailable/,
    );
  });

  test("fetchFile 路径不在 scope 内 → 返回 missing（不抛错）", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const adapter = new ScopeAdapter(HOME_DIR);
    const inflight = new InflightMap();
    const coord = new SyncCoordinator({
      deviceId: DEVICE_ID,
      store,
      scopeAdapter: adapter,
      inflight,
    });

    const r = await coord.fetchFile("/tmp/some/path");
    assert.equal(r.kind, "missing");
  });

  test("fetchFile 有 dispatcher → dispatcher 返回的 change 转换为 read result", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const adapter = new ScopeAdapter(HOME_DIR);
    const inflight = new InflightMap();
    const coord = new SyncCoordinator({
      deviceId: DEVICE_ID,
      store,
      scopeAdapter: adapter,
      inflight,
      dispatcher: {
        dispatchSinglePathFetch: async (absPath, _timeoutMs) => {
          // mock：dispatcher 已 apply 到 manifest，仅返回 change
          assert.equal(absPath, `${HOME_DIR}/.claude/x`);
          return {
            kind: "upsert",
            scope: "claude-home",
            path: "x",
            size: 5,
            mtime: 1,
            sha256: sha256("hello"),
            contentBase64: b64("hello"),
          };
        },
      },
    });

    const r = await coord.fetchFile(`${HOME_DIR}/.claude/x`);
    assert.equal(r.kind, "file");
    if (r.kind === "file") {
      assert.equal(r.content.toString("utf8"), "hello");
    }
  });

  test("FileAgentFetcher 接口契约：SyncCoordinator 实现 fetchFile/fetchStat/fetchReaddir", () => {
    const adapter = new ScopeAdapter(HOME_DIR);
    const inflight = new InflightMap();
    const store = new ClientCacheStore({ dataDir: "/tmp/ignored" });
    const coord = new SyncCoordinator({
      deviceId: DEVICE_ID,
      store,
      scopeAdapter: adapter,
      inflight,
    });
    assert.equal(typeof coord.fetchFile, "function");
    assert.equal(typeof coord.fetchStat, "function");
    assert.equal(typeof coord.fetchReaddir, "function");
  });
});

describe("FileAgent 接 SyncCoordinator 完整链路（Task 5）", () => {
  test("FileAgent.read miss → SyncCoordinator.fetchFile via dispatcher → 返回内容", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const adapter = new ScopeAdapter(HOME_DIR);
    const inflight = new InflightMap();
    const coord = new SyncCoordinator({
      deviceId: DEVICE_ID,
      store,
      scopeAdapter: adapter,
      inflight,
      dispatcher: {
        dispatchSinglePathFetch: async (absPath) => {
          if (absPath !== `${HOME_DIR}/.claude/x`) return null;
          return {
            kind: "upsert",
            scope: "claude-home",
            path: "x",
            size: 5,
            mtime: 1,
            sha256: sha256("hello"),
            contentBase64: b64("hello"),
          };
        },
      },
    });

    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
      fetcher: coord,
    });

    const r = await agent.read(`${HOME_DIR}/.claude/x`, 1000);
    assert.equal(r.kind, "file");
    if (r.kind === "file") {
      assert.equal(r.content.toString("utf8"), "hello");
    }
  });

  test("watcher delta apply 后再 read：FileAgent 命中新内容（路径 B 完整链路）", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const adapter = new ScopeAdapter(HOME_DIR);
    const inflight = new InflightMap();
    const coord = new SyncCoordinator({
      deviceId: DEVICE_ID,
      store,
      scopeAdapter: adapter,
      inflight,
    });

    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
      fetcher: coord,
    });

    // 路径 B：watcher 推 delta，FileAgent.read 命中
    const content = "v1";
    await coord.applyWatcherDelta([
      {
        kind: "upsert",
        scope: "claude-home",
        path: "f",
        size: 2,
        mtime: 100,
        sha256: sha256(content),
        contentBase64: b64(content),
      },
    ]);

    const r1 = await agent.read(`${HOME_DIR}/.claude/f`, 1000);
    assert.equal(r1.kind, "file");
    if (r1.kind === "file") {
      assert.equal(r1.content.toString("utf8"), "v1");
    }

    // 又一次 watcher delta（模拟运行时增量）
    const content2 = "v2-updated";
    await coord.applyWatcherDelta([
      {
        kind: "upsert",
        scope: "claude-home",
        path: "f",
        size: content2.length,
        mtime: 200,
        sha256: sha256(content2),
        contentBase64: b64(content2),
      },
    ]);

    const r2 = await agent.read(`${HOME_DIR}/.claude/f`, 1000);
    assert.equal(r2.kind, "file");
    if (r2.kind === "file") {
      assert.equal(r2.content.toString("utf8"), "v2-updated");
    }
  });
});

describe("协议封装规范（plan §11 实施纪律）", () => {
  test("sync-coordinator.ts 不直接出现 cache_task_* type 字面量（应通过 client-protocol-v1）", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      "src/file-agent/sync-coordinator.ts",
      "utf8",
    );
    // 注：comment 内可以提及 cache_task_* 名字（解释意图），但代码中不应有 type 字面量
    // 简单 grep：确认没有 `type: "cache_task_assignment"` 或 `type: "cache_task_delta"` 等字面量
    assert.equal(
      /type:\s*["']cache_task_/g.test(src),
      false,
      "sync-coordinator 不应直接构造 cache_task_* 协议消息字面量；应通过 client-protocol-v1.ts builder",
    );
  });
});
