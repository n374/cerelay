// FileAgent 接口契约 + Task 2 命中路径覆盖。

import assert from "node:assert";
import { test, describe } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { FileAgent } from "../src/file-agent/index.js";
import { ClientCacheStore } from "../src/file-agent/store.js";
import { ScopeAdapter } from "../src/file-agent/scope-adapter.js";
import type {
  FileAgentReadResult,
  FileAgentStatResult,
  FileAgentReaddirResult,
  PrefetchItem,
  PrefetchResult,
} from "../src/file-agent/types.js";

const DEVICE_ID = "device-fileagent";
const HOME_DIR = "/home/u";

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

async function makeStore() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cerelay-fa-"));
  return {
    dataDir,
    store: new ClientCacheStore({ dataDir }),
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}

describe("FileAgent 接口契约（Task 1 骨架）", () => {
  test("FileAgent 类可以实例化（仅 deviceId + homeDir）", () => {
    const agent = new FileAgent({ deviceId: DEVICE_ID, homeDir: HOME_DIR });
    assert.ok(agent instanceof FileAgent);
  });

  test("read 方法存在且接收 (absPath, ttlMs) 两个参数", async () => {
    const agent = new FileAgent({ deviceId: DEVICE_ID, homeDir: HOME_DIR });
    assert.strictEqual(typeof agent.read, "function");
    assert.strictEqual(agent.read.length, 2);
    // 没传 store + 无 cache → miss path 抛 not implemented
    await assert.rejects(
      () => agent.read("/abs/path", 1000),
      /not implemented/i,
    );
  });

  test("stat 方法存在且接收 (absPath, ttlMs) 两个参数", async () => {
    const agent = new FileAgent({ deviceId: DEVICE_ID, homeDir: HOME_DIR });
    assert.strictEqual(typeof agent.stat, "function");
    assert.strictEqual(agent.stat.length, 2);
    await assert.rejects(
      () => agent.stat("/abs/path", 1000),
      /not implemented/i,
    );
  });

  test("readdir 方法存在且接收 (absDir, ttlMs) 两个参数", async () => {
    const agent = new FileAgent({ deviceId: DEVICE_ID, homeDir: HOME_DIR });
    assert.strictEqual(typeof agent.readdir, "function");
    assert.strictEqual(agent.readdir.length, 2);
    await assert.rejects(
      () => agent.readdir("/abs/dir", 1000),
      /not implemented/i,
    );
  });

  test("prefetch 方法存在且接收 (items, ttlMs) 两个参数", async () => {
    const agent = new FileAgent({ deviceId: DEVICE_ID, homeDir: HOME_DIR });
    assert.strictEqual(typeof agent.prefetch, "function");
    assert.strictEqual(agent.prefetch.length, 2);
    const items: PrefetchItem[] = [];
    // Task 6 起 prefetch 已实现；不传 store 时拒绝（语义清晰）
    await assert.rejects(
      () => agent.prefetch(items, 1000),
      /需要 store 配置/i,
    );
  });

  test("close 方法存在", async () => {
    const agent = new FileAgent({ deviceId: DEVICE_ID, homeDir: HOME_DIR });
    assert.strictEqual(typeof agent.close, "function");
    await agent.close();
  });

  test("类型导出：所有 result type 都可 import", () => {
    const sampleRead: FileAgentReadResult = { kind: "missing" };
    const sampleStat: FileAgentStatResult = { kind: "missing" };
    const sampleReaddir: FileAgentReaddirResult = { kind: "missing" };
    const sampleItem: PrefetchItem = { kind: "file", absPath: "/a" };
    const sampleResult: PrefetchResult = {
      fetched: 0,
      alreadyHot: 0,
      missing: 0,
      failed: [],
      durationMs: 0,
    };
    assert.strictEqual(sampleRead.kind, "missing");
    assert.strictEqual(sampleStat.kind, "missing");
    assert.strictEqual(sampleReaddir.kind, "missing");
    assert.strictEqual(sampleItem.kind, "file");
    assert.strictEqual(sampleResult.fetched, 0);
  });
});

describe("ScopeAdapter（Task 2）", () => {
  test("absPath 在 ~/.claude/ 下 → scope=claude-home, relPath", () => {
    const adapter = new ScopeAdapter("/home/u");
    assert.deepEqual(adapter.toScopeRel("/home/u/.claude/settings.json"), {
      scope: "claude-home",
      relPath: "settings.json",
    });
    assert.deepEqual(adapter.toScopeRel("/home/u/.claude/projects/abc.jsonl"), {
      scope: "claude-home",
      relPath: "projects/abc.jsonl",
    });
  });

  test("absPath = ~/.claude.json → scope=claude-json, relPath=''", () => {
    const adapter = new ScopeAdapter("/home/u");
    assert.deepEqual(adapter.toScopeRel("/home/u/.claude.json"), {
      scope: "claude-json",
      relPath: "",
    });
  });

  test("absPath 不在已知 scope 内 → null", () => {
    const adapter = new ScopeAdapter("/home/u");
    assert.equal(adapter.toScopeRel("/home/u/CLAUDE.md"), null);
    assert.equal(adapter.toScopeRel("/tmp/random"), null);
    assert.equal(adapter.toScopeRel("/home/u/.claude.txt"), null);
    assert.equal(adapter.toScopeRel("/home/u/.claudefoo"), null);
  });

  test("toAbsPath 反向转换", () => {
    const adapter = new ScopeAdapter("/home/u");
    assert.equal(
      adapter.toAbsPath("claude-home", "settings.json"),
      "/home/u/.claude/settings.json",
    );
    assert.equal(adapter.toAbsPath("claude-json", ""), "/home/u/.claude.json");
    assert.equal(adapter.toAbsPath("claude-home", ""), "/home/u/.claude");
  });
});

describe("FileAgent.read 命中路径（Task 2）", () => {
  test("先在 store 写 entry，再 FileAgent.read 命中返回正确 buffer", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const content = "hello-world";
    const sha = sha256(content);
    await store.applyDelta(DEVICE_ID, [
      {
        kind: "upsert",
        scope: "claude-home",
        path: "settings.json",
        size: content.length,
        mtime: 1700000000000,
        sha256: sha,
        contentBase64: b64(content),
      },
    ]);

    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
    });

    const result = await agent.read(`${HOME_DIR}/.claude/settings.json`, 1000);
    assert.equal(result.kind, "file");
    if (result.kind === "file") {
      assert.equal(result.content.toString("utf8"), content);
      assert.equal(result.size, content.length);
      assert.equal(result.sha256, sha);
    }
  });

  test("read 命中 skipped 文件 → 返回 skipped kind（无 content）", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    await store.applyDelta(DEVICE_ID, [
      {
        kind: "upsert",
        scope: "claude-home",
        path: "big.bin",
        size: 8 * 1024 * 1024,
        mtime: 1700000000000,
        sha256: null,
        skipped: true,
      },
    ]);

    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
    });

    const result = await agent.read(`${HOME_DIR}/.claude/big.bin`, 1000);
    assert.equal(result.kind, "skipped");
    if (result.kind === "skipped") {
      assert.equal(result.size, 8 * 1024 * 1024);
    }
  });

  test("stat 命中 → 返回 file kind 元数据", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const content = "x";
    await store.applyDelta(DEVICE_ID, [
      {
        kind: "upsert",
        scope: "claude-json",
        path: "",
        size: 1,
        mtime: 42,
        sha256: sha256(content),
        contentBase64: b64(content),
      },
    ]);

    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
    });

    const result = await agent.stat(`${HOME_DIR}/.claude.json`, 1000);
    assert.equal(result.kind, "file");
    if (result.kind === "file") {
      assert.equal(result.size, 1);
      assert.equal(result.mtime, 42);
    }
  });

  test("read miss（store 中没有 entry）→ 抛 not implemented（Task 5 接 sync）", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
    });

    await assert.rejects(
      () => agent.read(`${HOME_DIR}/.claude/nonexistent`, 1000),
      /not implemented/i,
    );
  });

  test("read 不在已知 scope 范围内 → 抛 not implemented（不静默跳过）", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
    });

    await assert.rejects(
      () => agent.read("/tmp/random", 1000),
      /not implemented/i,
    );
  });
});
