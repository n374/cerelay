// TTL table + FileAgent 命中时的 bump 行为（Task 3）。

import assert from "node:assert";
import { test, describe } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { FileAgent } from "../src/file-agent/index.js";
import { ClientCacheStore } from "../src/file-agent/store.js";
import { TtlTable } from "../src/file-agent/ttl-table.js";

const DEVICE_ID = "device-ttl";
const HOME_DIR = "/home/u";

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

async function makeStore() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cerelay-ttl-"));
  return {
    dataDir,
    store: new ClientCacheStore({ dataDir }),
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}

describe("TtlTable 单元行为", () => {
  test("bump 设置 expiresAt = now + ttlMs", () => {
    let now = 1000;
    const ttl = new TtlTable({ now: () => now });
    ttl.bump("/a", 500);
    assert.equal(ttl.getExpiresAt("/a"), 1500);
  });

  test("bump 用 max 不覆盖：长 ttl 不被短 ttl 缩短", () => {
    let now = 1000;
    const ttl = new TtlTable({ now: () => now });
    ttl.bump("/a", 10_000); // expiresAt = 11000
    ttl.bump("/a", 100); // 候选 = 1100，应被忽略
    assert.equal(ttl.getExpiresAt("/a"), 11_000);
  });

  test("bump 用 max：短 ttl 后再来长 ttl 应延后", () => {
    let now = 1000;
    const ttl = new TtlTable({ now: () => now });
    ttl.bump("/a", 100); // expiresAt = 1100
    ttl.bump("/a", 10_000); // 候选 = 11000，应替换
    assert.equal(ttl.getExpiresAt("/a"), 11_000);
  });

  test("bump 同 path 推进 now 后再 bump，max 仍正确", () => {
    let now = 1000;
    const ttl = new TtlTable({ now: () => now });
    ttl.bump("/a", 1000); // expiresAt = 2000
    now = 1500;
    ttl.bump("/a", 1000); // 候选 = 2500，应替换
    assert.equal(ttl.getExpiresAt("/a"), 2500);
  });

  test("bump 拒绝 ttlMs ≤ 0 / Infinity / NaN", () => {
    const ttl = new TtlTable();
    assert.throws(() => ttl.bump("/a", 0), /必须是有限正数/);
    assert.throws(() => ttl.bump("/a", -100), /必须是有限正数/);
    assert.throws(() => ttl.bump("/a", Infinity), /必须是有限正数/);
    assert.throws(() => ttl.bump("/a", NaN), /必须是有限正数/);
  });

  test("isExpired 在未跟踪 / 已过期 / 未过期 三种情况", () => {
    let now = 1000;
    const ttl = new TtlTable({ now: () => now });
    assert.equal(ttl.isExpired("/never-tracked"), true);
    ttl.bump("/a", 100); // expiresAt = 1100
    assert.equal(ttl.isExpired("/a"), false);
    now = 2000;
    assert.equal(ttl.isExpired("/a"), true);
  });

  test("drop 移除单条记录", () => {
    const ttl = new TtlTable();
    ttl.bump("/a", 1000);
    ttl.drop("/a");
    assert.equal(ttl.getExpiresAt("/a"), null);
  });

  test("snapshot 只包含未过期项", () => {
    let now = 1000;
    const ttl = new TtlTable({ now: () => now });
    ttl.bump("/a", 100); // expires at 1100
    ttl.bump("/b", 500); // expires at 1500
    now = 1300; // /a 过期
    const snap = ttl.snapshot();
    assert.equal(snap.active["/a"], undefined);
    assert.equal(snap.active["/b"], 1500);
  });

  test("collectAndDropExpired 返回过期项并从表中移除", () => {
    let now = 1000;
    const ttl = new TtlTable({ now: () => now });
    ttl.bump("/a", 100);
    ttl.bump("/b", 500);
    ttl.bump("/c", 10_000);
    now = 1200; // /a 过期；/b /c 未过期
    const expired = ttl.collectAndDropExpired();
    assert.deepEqual(expired.sort(), ["/a"]);
    assert.equal(ttl.getExpiresAt("/a"), null);
    assert.equal(ttl.getExpiresAt("/b"), 1500);
    assert.equal(ttl.getExpiresAt("/c"), 11_000);
  });
});

describe("FileAgent.read/stat 命中时 bump TTL（Task 3）", () => {
  test("FileAgent.read 命中后 TTL 表中该 path 的 expiresAt 被设置", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const content = "x";
    await store.applyDelta(DEVICE_ID, [
      {
        kind: "upsert",
        scope: "claude-home",
        path: "settings.json",
        size: 1,
        mtime: 42,
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
    await agent.read(absPath, 5000);
    const exp = agent.getTtlForTest(absPath);
    assert.equal(exp, now + 5000);
  });

  test("FileAgent.stat 命中后 TTL 也被 bump", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const content = "x";
    await store.applyDelta(DEVICE_ID, [
      {
        kind: "upsert",
        scope: "claude-json",
        path: "",
        size: 1,
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
      now: () => now,
    });

    const absPath = `${HOME_DIR}/.claude.json`;
    await agent.stat(absPath, 800);
    assert.equal(agent.getTtlForTest(absPath), 1800);
  });

  test("多次 read 不同 ttl，expiresAt 取 max", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const content = "x";
    await store.applyDelta(DEVICE_ID, [
      {
        kind: "upsert",
        scope: "claude-home",
        path: "f",
        size: 1,
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
      now: () => now,
    });

    const absPath = `${HOME_DIR}/.claude/f`;
    await agent.read(absPath, 10_000); // expires 11000
    await agent.read(absPath, 100); // 候选 1100，应不变
    assert.equal(agent.getTtlForTest(absPath), 11_000);
  });

  test("read 时 ttlMs 非法（≤0 / Infinity）→ RangeError，且不修改 TTL 表", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
    });

    await assert.rejects(() => agent.read("/home/u/.claude/x", 0), RangeError);
    await assert.rejects(() => agent.read("/home/u/.claude/x", -1), RangeError);
    await assert.rejects(
      () => agent.read("/home/u/.claude/x", Infinity),
      RangeError,
    );
  });
});
