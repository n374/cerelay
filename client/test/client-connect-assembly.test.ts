import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { CerelayClient } from "../src/client.js";
import { DEFAULT_EXCLUDE_DIRS, type CerelayConfig } from "../src/config.js";
import type { CacheTaskStateMachineOptions } from "../src/cache-task-state-machine.js";
import type { ScanCacheStore } from "../src/scan-cache.js";

class FakeCacheTaskStateMachine {
  onConnectedCalls = 0;
  onDisconnectedCalls = 0;
  initialSyncActive = false;

  async onConnected(): Promise<void> {
    this.onConnectedCalls += 1;
  }

  async onDisconnected(): Promise<void> {
    this.onDisconnectedCalls += 1;
  }

  async onMessage(): Promise<void> {}

  isInitialSyncActive(): boolean {
    return this.initialSyncActive;
  }
}

function makeScanCacheStore(): ScanCacheStore {
  return {
    lookup() {
      return null;
    },
    upsert() {},
    pruneToPresent() {},
    async flush() {},
  };
}

async function makeTestHome(t: { after(callback: () => void | Promise<void>): void }): Promise<string> {
  const homedir = await mkdtemp(path.join(os.tmpdir(), "cerelay-home-"));
  t.after(async () => {
    await rm(homedir, { recursive: true, force: true });
  });
  return homedir;
}

async function startFakeBrain(): Promise<{
  http: ReturnType<typeof createServer>;
  ws: WebSocketServer;
  url: string;
}> {
  const http = createServer();
  const ws = new WebSocketServer({ server: http });
  http.listen(0);
  await once(http, "listening");
  const port = (http.address() as import("node:net").AddressInfo).port;
  return { http, ws, url: `ws://127.0.0.1:${port}` };
}

async function stopFakeBrain(brain: {
  http: ReturnType<typeof createServer>;
  ws: WebSocketServer;
}): Promise<void> {
  for (const client of brain.ws.clients) {
    client.close();
  }
  await new Promise<void>((resolve) => brain.ws.close(() => resolve()));
  await new Promise<void>((resolve, reject) => brain.http.close((error) => error ? reject(error) : resolve()));
}

test("CerelayClient disableCacheTask=true 时不装配 loadConfig/openScanCache", async (t) => {
  const brain = await startFakeBrain();
  t.after(async () => {
    await stopFakeBrain(brain);
  });
  brain.ws.on("connection", (socket: WebSocket) => {
    socket.send(JSON.stringify({ type: "connected" }));
  });

  let loadConfigCalls = 0;
  let openScanCacheCalls = 0;
  let factoryOptions: CacheTaskStateMachineOptions | undefined;
  const stateMachine = new FakeCacheTaskStateMachine();
  const homedir = await makeTestHome(t);
  const client = new CerelayClient(brain.url, "/repo", {
    interactiveOutput: false,
    deviceId: "device-1",
    homedir,
    isCacheTaskDisabled: () => true,
    loadConfig: async () => {
      loadConfigCalls += 1;
      return { scan: { excludeDirs: ["projects"] } };
    },
    openScanCache: async () => {
      openScanCacheCalls += 1;
      return makeScanCacheStore();
    },
    cacheTaskStateMachineFactory: (options) => {
      factoryOptions = options;
      return stateMachine;
    },
  });
  t.after(() => {
    client.close();
  });

  await client.connect();

  assert.equal(loadConfigCalls, 0);
  assert.equal(openScanCacheCalls, 0);
  assert.equal(factoryOptions?.disableCacheTask, true);
  assert.equal(stateMachine.onConnectedCalls, 1);
});

test("CerelayClient loadConfig 抛错时 connect 仍完成，并回退默认配置", async (t) => {
  const brain = await startFakeBrain();
  t.after(async () => {
    await stopFakeBrain(brain);
  });
  brain.ws.on("connection", (socket: WebSocket) => {
    socket.send(JSON.stringify({ type: "connected" }));
  });

  const scanCache = makeScanCacheStore();
  let factoryOptions: CacheTaskStateMachineOptions | undefined;
  const homedir = await makeTestHome(t);
  const client = new CerelayClient(brain.url, "/repo", {
    interactiveOutput: false,
    deviceId: "device-1",
    homedir,
    loadConfig: async () => {
      throw new Error("broken config");
    },
    openScanCache: async () => scanCache,
    cacheTaskStateMachineFactory: (options) => {
      factoryOptions = options;
      return new FakeCacheTaskStateMachine();
    },
  });
  t.after(() => {
    client.close();
  });

  await assert.doesNotReject(client.connect());

  assert.deepEqual(factoryOptions?.config, {
    scan: {
      excludeDirs: [...DEFAULT_EXCLUDE_DIRS],
    },
  });
  assert.equal(factoryOptions?.scanCache, scanCache);
});

test("CerelayClient openScanCache 抛错时 connect 仍完成", async (t) => {
  const brain = await startFakeBrain();
  t.after(async () => {
    await stopFakeBrain(brain);
  });
  brain.ws.on("connection", (socket: WebSocket) => {
    socket.send(JSON.stringify({ type: "connected" }));
  });

  const config: CerelayConfig = {
    scan: {
      excludeDirs: ["projects"],
    },
  };
  let factoryOptions: CacheTaskStateMachineOptions | undefined;
  const homedir = await makeTestHome(t);
  const client = new CerelayClient(brain.url, "/repo", {
    interactiveOutput: false,
    deviceId: "device-1",
    homedir,
    loadConfig: async () => config,
    openScanCache: async () => {
      throw new Error("broken scan cache");
    },
    cacheTaskStateMachineFactory: (options) => {
      factoryOptions = options;
      return new FakeCacheTaskStateMachine();
    },
  });
  t.after(() => {
    client.close();
  });

  await assert.doesNotReject(client.connect());

  assert.equal(factoryOptions?.config, config);
  assert.equal(factoryOptions?.scanCache, undefined);
});

test("CerelayClient connect 装配成功时把 config 和 scanCache 传给 state machine", async (t) => {
  const brain = await startFakeBrain();
  t.after(async () => {
    await stopFakeBrain(brain);
  });
  brain.ws.on("connection", (socket: WebSocket) => {
    socket.send(JSON.stringify({ type: "connected" }));
  });

  const config: CerelayConfig = {
    scan: {
      excludeDirs: ["projects"],
    },
  };
  const scanCache = makeScanCacheStore();
  let factoryOptions: CacheTaskStateMachineOptions | undefined;
  const stateMachine = new FakeCacheTaskStateMachine();
  const homedir = await makeTestHome(t);
  const client = new CerelayClient(brain.url, "/repo", {
    interactiveOutput: false,
    deviceId: "device-1",
    homedir,
    loadConfig: async () => config,
    openScanCache: async () => scanCache,
    cacheTaskStateMachineFactory: (options) => {
      factoryOptions = options;
      return stateMachine;
    },
  });
  t.after(() => {
    client.close();
  });

  await client.connect();

  assert.equal(factoryOptions?.config, config);
  assert.equal(factoryOptions?.scanCache, scanCache);
  assert.equal(stateMachine.onConnectedCalls, 1);
});

test("CerelayClient.isCacheSyncActive 委托给 state machine 的 isInitialSyncActive", async (t) => {
  const brain = await startFakeBrain();
  t.after(async () => {
    await stopFakeBrain(brain);
  });
  brain.ws.on("connection", (socket: WebSocket) => {
    socket.send(JSON.stringify({ type: "connected" }));
  });

  const stateMachine = new FakeCacheTaskStateMachine();
  const homedir = await makeTestHome(t);
  const client = new CerelayClient(brain.url, "/repo", {
    interactiveOutput: false,
    deviceId: "device-1",
    homedir,
    loadConfig: async () => ({ scan: { excludeDirs: [] } }),
    openScanCache: async () => makeScanCacheStore(),
    cacheTaskStateMachineFactory: () => stateMachine,
  });
  t.after(() => {
    client.close();
  });

  // 未连接：state machine 还没装配，应当返回 false
  assert.equal(client.isCacheSyncActive(), false);

  await client.connect();

  // state machine 默认 initialSyncActive=false
  assert.equal(client.isCacheSyncActive(), false);

  // 切到 active：客户端应反映 true（这是 raw 模式下拦截 \x03 的判定依据）
  stateMachine.initialSyncActive = true;
  assert.equal(client.isCacheSyncActive(), true);

  stateMachine.initialSyncActive = false;
  assert.equal(client.isCacheSyncActive(), false);
});
