import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import { AccessLedgerRuntime, AccessLedgerStore } from "../src/access-ledger.js";
import { CacheTaskManager } from "../src/cache-task-manager.js";
import { ClientCacheStore } from "../src/client-cache-store.js";
import { ClientRegistry } from "../src/client-registry.js";
import type { CacheTaskAssignment, ClientHello, ServerToHandMessage } from "../src/protocol.js";

test("registerHello active 时 assignment.syncPlan 非空", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cerelay-cache-task-manager-syncplan-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const registry = new ClientRegistry();
  const cacheStore = new ClientCacheStore({ dataDir });
  const accessLedgerStore = new AccessLedgerStore({ dataDir });
  const ledger = new AccessLedgerRuntime("dev1");
  ledger.upsertFilePresent("/Users/foo/.claude/settings.json", 1_700_000_000_000);
  await accessLedgerStore.persist(ledger);

  const manager = new CacheTaskManager({
    registry,
    store: cacheStore,
    accessLedgerStore,
    getHomedirForDevice: () => "/Users/foo",
    sendToClient: async (clientId, message) => {
      await registry.sendTo(clientId, message);
    },
    createAssignmentId: () => "assignment-1",
  });

  const socket = createMockSocket();
  registry.register("client-1", socket, "token", "127.0.0.1");

  await manager.registerHello("client-1", capableHello());

  const assignment = socket.sent
    .map((entry) => JSON.parse(entry) as ServerToHandMessage)
    .find((message): message is CacheTaskAssignment => {
      return message.type === "cache_task_assignment" && message.role === "active";
    });
  assert.ok(assignment, "应下发 active assignment");
  assert.deepEqual(assignment.syncPlan?.scopes["claude-home"]?.files, ["settings.json"]);
});

function capableHello(): ClientHello {
  return {
    type: "client_hello",
    deviceId: "dev1",
    cwd: "/Users/foo/work",
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

function createMockSocket(): WebSocket & { sent: string[] } {
  return {
    readyState: WebSocket.OPEN,
    sent: [] as string[],
    send(data: unknown, callback?: (error?: Error) => void) {
      this.sent.push(String(data));
      callback?.();
    },
  } as WebSocket & { sent: string[] };
}
