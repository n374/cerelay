/**
 * FileProxyManager 与 ClientCacheStore 的集成：commit 3
 *
 * 覆盖：
 * 1. snapshot 从 cache 构造 home-claude / home-claude-json 时：
 *    - 目录条目 + 文件条目完整生成
 *    - skipped / blob 缺失的文件只有 stat 没有 data
 *    - 中间目录被 entries 列表覆盖
 * 2. 运行时 read 命中 cache 时不发 file_proxy_request
 * 3. 未启用 cache（deviceId 缺失）时退化为纯穿透
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { ClientCacheStore } from "../src/client-cache-store.js";
import { FileProxyManager } from "../src/file-proxy-manager.js";
import type { CachePush, FileProxyRequest } from "../src/protocol.js";

const DEVICE_ID = "device-test";
const CLIENT_HOME = "/Users/foo";
const CLIENT_CWD = "/Users/foo/project";

async function makeStore() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cerelay-fp-"));
  return {
    dataDir,
    store: new ClientCacheStore({ dataDir }),
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

async function seedCache(store: ClientCacheStore, pushes: CachePush[]) {
  for (const push of pushes) {
    await store.applyPush(push);
  }
}

function createManager(store: ClientCacheStore | undefined, deviceId: string | undefined) {
  const sent: FileProxyRequest[] = [];
  const manager = new FileProxyManager({
    runtimeRoot: "/tmp/unused-runtime-root",
    clientHomeDir: CLIENT_HOME,
    clientCwd: CLIENT_CWD,
    sessionId: "s-1",
    sendToClient: async (msg) => {
      sent.push(msg);
    },
    cacheStore: store,
    deviceId,
  });
  return { manager, sent };
}

test("buildSnapshotFromManifest 生成目录 + 文件 + 嵌套子目录", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  // seed cache：~/.claude/settings.json 和 ~/.claude/subdir/nested.json
  await seedCache(store, [{
    type: "cache_push",
    deviceId: DEVICE_ID,
    cwd: CLIENT_CWD,
    scope: "claude-home",
    adds: [
      { path: "settings.json", size: 2, mtime: 1000, sha256: sha256("s1"), content: b64("s1") },
      { path: "subdir/nested.json", size: 2, mtime: 2000, sha256: sha256("n1"), content: b64("n1") },
    ],
    deletes: [],
  }, {
    type: "cache_push",
    deviceId: DEVICE_ID,
    cwd: CLIENT_CWD,
    scope: "claude-json",
    adds: [{ path: "", size: 2, mtime: 3000, sha256: sha256("j1"), content: b64("j1") }],
    deletes: [],
  }]);

  const { manager } = createManager(store, DEVICE_ID);

  // 访问 private 方法用反射
  const manifest = await store.loadManifest(DEVICE_ID, CLIENT_CWD);
  const entries = (manager as unknown as {
    buildSnapshotFromManifest: (m: typeof manifest) => Array<{
      path: string;
      stat: { isDir: boolean; size: number };
      entries?: string[];
      data?: string;
    }>;
  }).buildSnapshotFromManifest(manifest);

  const byPath = new Map(entries.map((e) => [e.path, e]));

  // ~/.claude.json 单文件
  const json = byPath.get(path.join(CLIENT_HOME, ".claude.json"));
  assert.ok(json, "应包含 ~/.claude.json");
  assert.equal(json!.stat.isDir, false);
  assert.equal(json!.data, b64("j1"));

  // ~/.claude 根目录，entries 应含 settings.json 和 subdir
  const homeRoot = byPath.get(path.join(CLIENT_HOME, ".claude"));
  assert.ok(homeRoot, "应包含 ~/.claude");
  assert.equal(homeRoot!.stat.isDir, true);
  assert.deepEqual(homeRoot!.entries?.sort(), ["settings.json", "subdir"]);

  // ~/.claude/subdir 中间目录，entries 应含 nested.json
  const subdir = byPath.get(path.join(CLIENT_HOME, ".claude", "subdir"));
  assert.ok(subdir, "应包含 subdir");
  assert.equal(subdir!.stat.isDir, true);
  assert.deepEqual(subdir!.entries, ["nested.json"]);

  // 叶子文件应携带 data
  const leaf = byPath.get(path.join(CLIENT_HOME, ".claude", "subdir", "nested.json"));
  assert.ok(leaf);
  assert.equal(leaf!.data, b64("n1"));
});

test("buildSnapshotFromManifest 对 skipped 文件只有 stat 无 data", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  await seedCache(store, [{
    type: "cache_push",
    deviceId: DEVICE_ID,
    cwd: CLIENT_CWD,
    scope: "claude-home",
    adds: [{
      path: "history/big.log",
      size: 10 * 1024 * 1024,
      mtime: 5000,
      sha256: "",
      skipped: true,
    }],
    deletes: [],
  }]);

  const { manager } = createManager(store, DEVICE_ID);
  const manifest = await store.loadManifest(DEVICE_ID, CLIENT_CWD);
  const entries = (manager as unknown as {
    buildSnapshotFromManifest: (m: typeof manifest) => Array<{
      path: string;
      stat: { size: number; isDir: boolean };
      data?: string;
    }>;
  }).buildSnapshotFromManifest(manifest);

  const leaf = entries.find((e) => e.path === path.join(CLIENT_HOME, ".claude", "history", "big.log"));
  assert.ok(leaf, "skipped 文件应有 stat");
  assert.equal(leaf!.data, undefined, "skipped 文件不应有 data");
  assert.equal(leaf!.stat.size, 10 * 1024 * 1024);
});

test("tryServeReadFromCache 命中时直接写回、不发 file_proxy_request", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  const content = "hello-cache";
  await seedCache(store, [{
    type: "cache_push",
    deviceId: DEVICE_ID,
    cwd: CLIENT_CWD,
    scope: "claude-home",
    adds: [{
      path: "settings.json",
      size: content.length,
      mtime: 10000,
      sha256: sha256(content),
      content: b64(content),
    }],
    deletes: [],
  }]);

  const { manager, sent } = createManager(store, DEVICE_ID);
  const writeCalls: Record<string, unknown>[] = [];
  // 劫持 writeToDaemon（它在 fuseProcess.stdin 上写；无 daemon 时是 noop）
  (manager as unknown as { writeToDaemon: (d: Record<string, unknown>) => void }).writeToDaemon = (data) => {
    writeCalls.push(data);
  };

  const hit = await (manager as unknown as {
    tryServeReadFromCache: (req: { op: string; root: string; relPath: string; reqId: string; offset?: number; size?: number }) => Promise<boolean>;
  }).tryServeReadFromCache({
    op: "read",
    root: "home-claude",
    relPath: "settings.json",
    reqId: "r-1",
    offset: 0,
    size: 64,
  });

  assert.equal(hit, true, "read 应命中 cache");
  assert.equal(sent.length, 0, "命中时不应发 file_proxy_request");
  assert.equal(writeCalls.length, 1);
  assert.equal(writeCalls[0].reqId, "r-1");
  const decoded = Buffer.from(writeCalls[0].data as string, "base64").toString("utf8");
  assert.equal(decoded, content);
});

test("tryServeReadFromCache 对 skipped 文件返回 false（让调用方穿透）", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  await seedCache(store, [{
    type: "cache_push",
    deviceId: DEVICE_ID,
    cwd: CLIENT_CWD,
    scope: "claude-home",
    adds: [{
      path: "big.log",
      size: 5_000_000,
      mtime: 1,
      sha256: "",
      skipped: true,
    }],
    deletes: [],
  }]);

  const { manager } = createManager(store, DEVICE_ID);
  (manager as unknown as { writeToDaemon: () => void }).writeToDaemon = () => {};

  const hit = await (manager as unknown as {
    tryServeReadFromCache: (req: unknown) => Promise<boolean>;
  }).tryServeReadFromCache({
    op: "read",
    root: "home-claude",
    relPath: "big.log",
    reqId: "r-2",
  });
  assert.equal(hit, false, "skipped 文件应 miss，走穿透");
});

test("tryServeReadFromCache 对 project-claude root 返回 false（不走 cache）", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  const { manager } = createManager(store, DEVICE_ID);
  (manager as unknown as { writeToDaemon: () => void }).writeToDaemon = () => {};

  const hit = await (manager as unknown as {
    tryServeReadFromCache: (req: unknown) => Promise<boolean>;
  }).tryServeReadFromCache({
    op: "read",
    root: "project-claude",
    relPath: "settings.local.json",
    reqId: "r-3",
  });
  assert.equal(hit, false, "project-claude 不在 cache 覆盖范围");
});

test("cache 未启用时 buildSnapshotFromManifest 返回空", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  const { manager } = createManager(undefined, undefined);
  const manifest = await store.loadManifest(DEVICE_ID, CLIENT_CWD);
  const entries = (manager as unknown as {
    buildSnapshotFromManifest: (m: typeof manifest) => unknown[];
  }).buildSnapshotFromManifest(manifest);
  // 空 manifest + 无 cache → 无 entries
  assert.equal(entries.length, 0);
});

test("cache 未启用（无 deviceId）时 tryServeReadFromCache 返回 false", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  const { manager } = createManager(store, undefined);
  const hit = await (manager as unknown as {
    tryServeReadFromCache: (req: unknown) => Promise<boolean>;
  }).tryServeReadFromCache({
    op: "read",
    root: "home-claude",
    relPath: "anything",
    reqId: "r-4",
  });
  assert.equal(hit, false);
});
