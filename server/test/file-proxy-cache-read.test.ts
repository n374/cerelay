import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import { CacheTaskManager } from "../src/cache-task-manager.js";
import { ClientCacheStore } from "../src/client-cache-store.js";
import { ClientRegistry } from "../src/client-registry.js";
import { FileProxyManager } from "../src/file-proxy-manager.js";
import type {
  CacheTaskAssignment,
  CacheTaskChange,
  ClientHello,
  FileProxyRequest,
  ServerToHandMessage,
} from "../src/protocol.js";

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

async function seedCache(store: ClientCacheStore, changes: CacheTaskChange[]) {
  await store.applyDelta(DEVICE_ID, CLIENT_CWD, changes);
}

function createManager(options?: {
  store?: ClientCacheStore;
  deviceId?: string;
  cacheTaskManager?: ConstructorParameters<typeof FileProxyManager>[0]["cacheTaskManager"];
  sendToClient?: (msg: FileProxyRequest) => Promise<void>;
}) {
  const sent: FileProxyRequest[] = [];
  const manager = new FileProxyManager({
    runtimeRoot: "/tmp/unused-runtime-root",
    clientHomeDir: CLIENT_HOME,
    clientCwd: CLIENT_CWD,
    sessionId: "s-1",
    sendToClient: options?.sendToClient ?? (async (msg) => {
      sent.push(msg);
    }),
    cacheStore: options?.store,
    deviceId: options?.deviceId,
    cacheTaskManager: options?.cacheTaskManager,
  });
  return { manager, sent };
}

test("buildSnapshotFromManifest 生成目录 + 文件 + 嵌套子目录", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  await seedCache(store, [
    {
      kind: "upsert",
      scope: "claude-home",
      path: "settings.json",
      size: 2,
      mtime: 1000,
      sha256: sha256("s1"),
      contentBase64: b64("s1"),
    },
    {
      kind: "upsert",
      scope: "claude-home",
      path: "subdir/nested.json",
      size: 2,
      mtime: 2000,
      sha256: sha256("n1"),
      contentBase64: b64("n1"),
    },
    {
      kind: "upsert",
      scope: "claude-json",
      path: "",
      size: 2,
      mtime: 3000,
      sha256: sha256("j1"),
      contentBase64: b64("j1"),
    },
  ]);

  const { manager } = createManager({ store, deviceId: DEVICE_ID });
  const manifest = await store.loadManifest(DEVICE_ID, CLIENT_CWD);
  const entries = (manager as unknown as {
    buildSnapshotFromManifest: (m: typeof manifest) => Array<{
      path: string;
      stat: { isDir: boolean; size: number };
      entries?: string[];
      data?: string;
    }>;
  }).buildSnapshotFromManifest(manifest);

  const byPath = new Map(entries.map((entry) => [entry.path, entry]));

  const json = byPath.get(path.join(CLIENT_HOME, ".claude.json"));
  assert.ok(json);
  assert.equal(json!.stat.isDir, false);
  assert.equal(json!.data, b64("j1"));

  const homeRoot = byPath.get(path.join(CLIENT_HOME, ".claude"));
  assert.ok(homeRoot);
  assert.equal(homeRoot!.stat.isDir, true);
  assert.deepEqual(homeRoot!.entries?.sort(), ["settings.json", "subdir"]);

  const subdir = byPath.get(path.join(CLIENT_HOME, ".claude", "subdir"));
  assert.ok(subdir);
  assert.equal(subdir!.stat.isDir, true);
  assert.deepEqual(subdir!.entries, ["nested.json"]);

  const leaf = byPath.get(path.join(CLIENT_HOME, ".claude", "subdir", "nested.json"));
  assert.ok(leaf);
  assert.equal(leaf!.data, b64("n1"));
});

test("buildSnapshotFromManifest 对 skipped 文件只有 stat 无 data", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  await seedCache(store, [
    {
      kind: "upsert",
      scope: "claude-home",
      path: "history/big.log",
      size: 10 * 1024 * 1024,
      mtime: 5000,
      sha256: null,
      skipped: true,
    },
  ]);

  const { manager } = createManager({ store, deviceId: DEVICE_ID });
  const manifest = await store.loadManifest(DEVICE_ID, CLIENT_CWD);
  const entries = (manager as unknown as {
    buildSnapshotFromManifest: (m: typeof manifest) => Array<{
      path: string;
      stat: { size: number; isDir: boolean };
      data?: string;
    }>;
  }).buildSnapshotFromManifest(manifest);

  const leaf = entries.find((entry) => entry.path === path.join(CLIENT_HOME, ".claude", "history", "big.log"));
  assert.ok(leaf);
  assert.equal(leaf!.data, undefined);
  assert.equal(leaf!.stat.size, 10 * 1024 * 1024);
});

test("syncing 状态下 cache read 强制穿透 Client", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  await seedCache(store, [
    {
      kind: "upsert",
      scope: "claude-home",
      path: "settings.json",
      size: 5,
      mtime: 1,
      sha256: sha256("hello"),
      contentBase64: b64("hello"),
    },
  ]);

  const { manager } = createManager({
    store,
    deviceId: DEVICE_ID,
    cacheTaskManager: {
      shouldUseCacheSnapshot: () => false,
      shouldBypassCacheRead: () => false,
      registerMutationHintForPath: async () => {},
      describeTaskState: () => ({
        exists: true,
        phase: "syncing",
        activeClientId: null,
        assignmentId: null,
        revision: 0,
        candidateClientCount: 0,
        lastHeartbeatAt: null,
      }),
    },
  });
  (manager as unknown as { writeToDaemon: () => void }).writeToDaemon = () => {};

  const hit = await (manager as unknown as {
    tryServeReadFromCache: (req: unknown) => Promise<{ served: boolean }>;
  }).tryServeReadFromCache({
    op: "read",
    root: "home-claude",
    relPath: "settings.json",
    reqId: "r-syncing",
  });

  assert.equal(hit.served, false);
});

test("non-ready 时 collectAndWriteSnapshot 会回退向 Client 拉 home roots snapshot", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "cerelay-fp-snapshot-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));

  const requestedPaths: string[] = [];
  let proxy!: FileProxyManager;
  const { manager } = createManager({
    store,
    deviceId: DEVICE_ID,
    cacheTaskManager: {
      shouldUseCacheSnapshot: () => false,
      shouldBypassCacheRead: () => false,
      registerMutationHintForPath: async () => {},
      describeTaskState: () => ({
        exists: true,
        phase: "syncing",
        activeClientId: null,
        assignmentId: null,
        revision: 0,
        candidateClientCount: 0,
        lastHeartbeatAt: null,
      }),
    },
    sendToClient: async (msg) => {
      if (msg.op !== "snapshot") {
        return;
      }
      requestedPaths.push(msg.path);
      proxy.resolveResponse({
        type: "file_proxy_response",
        reqId: msg.reqId,
        sessionId: msg.sessionId,
        snapshot: [{
          path: msg.path,
          stat: {
            mode: 0o100644,
            size: 0,
            mtime: 1,
            atime: 1,
            uid: 1,
            gid: 1,
            isDir: false,
          },
        }],
      });
    },
  });
  proxy = manager;

  const snapshotFile = path.join(runtimeRoot, "snapshot.json");
  await (manager as unknown as {
    collectAndWriteSnapshot: (snapshotFile: string) => Promise<void>;
  }).collectAndWriteSnapshot(snapshotFile);

  assert.deepEqual(requestedPaths.sort(), [
    path.join(CLIENT_CWD, ".claude"),
    path.join(CLIENT_HOME, ".claude"),
    path.join(CLIENT_HOME, ".claude.json"),
  ].sort());

  const snapshot = JSON.parse(await readFile(snapshotFile, "utf8")) as {
    stats: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(snapshot.stats).sort(), requestedPaths.sort());
});

test("mutation hint 命中后读穿透，delta 应用后恢复 cache 命中", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  await seedCache(store, [
    {
      kind: "upsert",
      scope: "claude-home",
      path: "settings.json",
      size: "hello-cache".length,
      mtime: 1,
      sha256: sha256("hello-cache"),
      contentBase64: b64("hello-cache"),
    },
  ]);

  const harness = await createReadyTaskHarness(store);
  const { manager, sent } = createManager({
    store,
    deviceId: DEVICE_ID,
    cacheTaskManager: harness.manager,
  });
  const writes: Record<string, unknown>[] = [];
  (manager as unknown as { writeToDaemon: (data: Record<string, unknown>) => void }).writeToDaemon = (data) => {
    writes.push(data);
  };

  await harness.manager.registerMutationHintForPath(DEVICE_ID, CLIENT_CWD, [
    { scope: "claude-home", path: "settings.json" },
  ]);

  const bypassed = await (manager as unknown as {
    tryServeReadFromCache: (req: unknown) => Promise<{ served: boolean }>;
  }).tryServeReadFromCache({
    op: "read",
    root: "home-claude",
    relPath: "settings.json",
    reqId: "r-bypass",
  });
  assert.equal(bypassed.served, false);

  await harness.manager.applyDelta("client-1", {
    type: "cache_task_delta",
    assignmentId: harness.assignment.assignmentId,
    batchId: "batch-1",
    baseRevision: harness.assignment.manifest?.revision ?? 0,
    mode: "live",
    sentAt: harness.clock.now,
    changes: [
      {
        kind: "upsert",
        scope: "claude-home",
        path: "settings.json",
        size: "hello-after".length,
        mtime: 2,
        sha256: sha256("hello-after"),
        contentBase64: b64("hello-after"),
      },
    ],
  });

  const hit = await (manager as unknown as {
    tryServeReadFromCache: (req: unknown) => Promise<{ served: boolean }>;
  }).tryServeReadFromCache({
    op: "read",
    root: "home-claude",
    relPath: "settings.json",
    reqId: "r-after",
    offset: 0,
    size: 64,
  });

  assert.equal(hit.served, true);
  assert.equal(sent.length, 0);
  assert.equal(writes.length, 1);
  assert.equal(
    Buffer.from(writes[0].data as string, "base64").toString("utf8"),
    "hello-after",
  );
});

test("ready 状态下未注册 hint 的 read 走 cache", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  await seedCache(store, [
    {
      kind: "upsert",
      scope: "claude-home",
      path: "settings.json",
      size: "hello-cache".length,
      mtime: 1,
      sha256: sha256("hello-cache"),
      contentBase64: b64("hello-cache"),
    },
  ]);

  const harness = await createReadyTaskHarness(store);
  const { manager, sent } = createManager({
    store,
    deviceId: DEVICE_ID,
    cacheTaskManager: harness.manager,
  });
  const writes: Record<string, unknown>[] = [];
  (manager as unknown as { writeToDaemon: (data: Record<string, unknown>) => void }).writeToDaemon = (data) => {
    writes.push(data);
  };

  const hit = await (manager as unknown as {
    tryServeReadFromCache: (req: unknown) => Promise<{ served: boolean }>;
  }).tryServeReadFromCache({
    op: "read",
    root: "home-claude",
    relPath: "settings.json",
    reqId: "r-ready",
    offset: 0,
    size: 64,
  });

  assert.equal(hit.served, true);
  assert.equal(sent.length, 0);
  assert.equal(writes.length, 1);
  assert.equal(
    Buffer.from(writes[0].data as string, "base64").toString("utf8"),
    "hello-cache",
  );
});

test("handleFuseLine 在转发写请求前注册 mutation hint", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  const events: string[] = [];
  let proxy!: FileProxyManager;
  const { manager } = createManager({
    store,
    deviceId: DEVICE_ID,
    cacheTaskManager: {
      shouldUseCacheSnapshot: () => true,
      shouldBypassCacheRead: () => false,
      registerMutationHintForPath: async (_deviceId, _cwd, targets) => {
        events.push(`hint:${targets.map((target) => `${target.scope}:${target.path}`).join(",")}`);
      },
      describeTaskState: () => ({
        exists: true,
        phase: "ready",
        activeClientId: "client-1",
        assignmentId: "assignment-1",
        revision: 1,
        candidateClientCount: 1,
        lastHeartbeatAt: 0,
      }),
    },
    sendToClient: async (msg) => {
      events.push(`send:${msg.op}`);
      proxy.resolveResponse({
        type: "file_proxy_response",
        reqId: msg.reqId,
        sessionId: msg.sessionId,
        written: 1,
      });
    },
  });
  proxy = manager;

  await (manager as unknown as { handleFuseLine: (line: string) => Promise<void> }).handleFuseLine(
    JSON.stringify({
      reqId: "req-write",
      op: "write",
      root: "home-claude",
      relPath: "settings.json",
      data: b64("x"),
      offset: 0,
    }),
  );

  assert.deepEqual(events, [
    "hint:claude-home:settings.json",
    "send:write",
  ]);
});

test("tryServeReadFromCache 对 skipped 文件返回 false（让调用方穿透）", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  await seedCache(store, [
    {
      kind: "upsert",
      scope: "claude-home",
      path: "big.log",
      size: 5_000_000,
      mtime: 1,
      sha256: null,
      skipped: true,
    },
  ]);

  const { manager } = createManager({ store, deviceId: DEVICE_ID });
  (manager as unknown as { writeToDaemon: () => void }).writeToDaemon = () => {};

  const hit = await (manager as unknown as {
    tryServeReadFromCache: (req: unknown) => Promise<{ served: boolean }>;
  }).tryServeReadFromCache({
    op: "read",
    root: "home-claude",
    relPath: "big.log",
    reqId: "r-2",
  });
  assert.equal(hit.served, false);
});

test("tryServeReadFromCache 对 project-claude root 返回 false（不走 cache）", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  const { manager } = createManager({ store, deviceId: DEVICE_ID });
  (manager as unknown as { writeToDaemon: () => void }).writeToDaemon = () => {};

  const hit = await (manager as unknown as {
    tryServeReadFromCache: (req: unknown) => Promise<{ served: boolean }>;
  }).tryServeReadFromCache({
    op: "read",
    root: "project-claude",
    relPath: "settings.local.json",
    reqId: "r-3",
  });
  assert.equal(hit.served, false);
});

test("cache 未启用时 buildSnapshotFromManifest 返回空", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  const { manager } = createManager();
  const manifest = await store.loadManifest(DEVICE_ID, CLIENT_CWD);
  const entries = (manager as unknown as {
    buildSnapshotFromManifest: (m: typeof manifest) => unknown[];
  }).buildSnapshotFromManifest(manifest);
  assert.equal(entries.length, 0);
});

test("cache 未启用（无 deviceId）时 tryServeReadFromCache 返回 false", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  const { manager } = createManager({ store });
  const hit = await (manager as unknown as {
    tryServeReadFromCache: (req: unknown) => Promise<{ served: boolean }>;
  }).tryServeReadFromCache({
    op: "read",
    root: "home-claude",
    relPath: "anything",
    reqId: "r-4",
  });
  assert.equal(hit.served, false);
});

async function createReadyTaskHarness(store: ClientCacheStore) {
  const registry = new ClientRegistry();
  const clock = { now: 1_700_000_000_000 };
  let assignmentSeq = 0;
  let mutationSeq = 0;
  const manager = new CacheTaskManager({
    registry,
    store,
    sendToClient: async (clientId, message) => {
      await registry.sendTo(clientId, message);
    },
    now: () => clock.now,
    createAssignmentId: () => `assignment-${++assignmentSeq}`,
    createMutationId: () => `mutation-${++mutationSeq}`,
  });

  const socket = createMockSocket();
  registry.register("client-1", socket, "token", "127.0.0.1");
  await manager.registerHello("client-1", capableHello());
  const assignment = latestAssignment(socket.sent.map((entry) => JSON.parse(entry) as ServerToHandMessage));
  await manager.completeInitialSync("client-1", {
    type: "cache_task_sync_complete",
    assignmentId: assignment.assignmentId,
    baseRevision: assignment.manifest?.revision ?? 0,
    scannedAt: clock.now,
  });

  return { manager, clock, assignment };
}

function capableHello(): ClientHello {
  return {
    type: "client_hello",
    deviceId: DEVICE_ID,
    cwd: CLIENT_CWD,
    capabilities: {
      cacheTaskV1: {
        protocolVersion: 1,
        maxFileBytes: 1024 * 1024,
        maxBatchBytes: 4 * 1024 * 1024,
        debounceMs: 250,
        watcherBackend: "chokidar",
      },
    },
  };
}

function latestAssignment(messages: ServerToHandMessage[]): CacheTaskAssignment {
  const assignment = [...messages].reverse().find((message): message is CacheTaskAssignment => {
    return message.type === "cache_task_assignment";
  });
  assert.ok(assignment);
  return assignment;
}

function createMockSocket(readyState = WebSocket.OPEN): WebSocket & { sent: string[] } {
  return {
    readyState,
    sent: [] as string[],
    send(data: unknown, callback?: (error?: Error) => void) {
      this.sent.push(String(data));
      callback?.();
      return this;
    },
  } as WebSocket & { sent: string[] };
}
