import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import WebSocket from "ws";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { CacheTaskManager } from "../src/cache-task-manager.js";
import { ClientCacheStore } from "../src/client-cache-store.js";
import { ClientRegistry } from "../src/client-registry.js";
import type {
  CacheTaskAssignment,
  CacheTaskDeltaAck,
  ClientHello,
  ServerToHandMessage,
} from "../src/protocol.js";

const DEVICE_ID = "device-abc";
const CWD = "/Users/foo/project";

test("elect active under per-key lock when two capable clients connect concurrently", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);

  const client1 = harness.addClient("client-1");
  const client2 = harness.addClient("client-2");

  await Promise.all([
    harness.manager.registerHello("client-1", capableHello()),
    harness.manager.registerHello("client-2", capableHello()),
  ]);

  const assignments = [
    ...client1.messages.filter(isAssignment),
    ...client2.messages.filter(isAssignment),
  ];
  const activeAssignments = assignments.filter((message) => message.role === "active");
  const inactiveAssignments = assignments.filter((message) => message.role === "inactive");

  assert.equal(activeAssignments.length, 1);
  assert.equal(inactiveAssignments.length, 1);
  assert.equal(new Set(activeAssignments.map((message) => message.assignmentId)).size, 1);
});

test("same device clients from different cwd share one task and one active client", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);

  const client1 = harness.addClient("client-1");
  const client2 = harness.addClient("client-2");

  await harness.manager.registerHello("client-1", capableHello("/Users/foo/project-a"));
  await harness.manager.registerHello("client-2", capableHello("/Users/foo/project-b"));

  const assignments = [
    ...client1.messages.filter(isAssignment),
    ...client2.messages.filter(isAssignment),
  ];
  assert.equal(assignments.filter((message) => message.role === "active").length, 1);
  assert.equal(assignments.filter((message) => message.role === "inactive").length, 1);

  const task = getTaskRecord(harness.manager);
  assert.equal(task?.candidateClientIds.size, 2);
});

test("inactive client ancestor delta writes cwd-ancestor-md scope without changing active revision", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);

  harness.addClient("client-1");
  harness.addClient("client-2");
  await harness.manager.registerHello("client-1", capableHello("/Users/foo/project-a"));
  await harness.manager.registerHello("client-2", capableHello("/Users/foo/project-b"));

  const task = getTaskRecord(harness.manager);
  const activeRevision = task?.revision;
  const content = "ancestor";
  await harness.manager.applyAncestorDelta({
    type: "cache_task_ancestor_delta",
    deviceId: DEVICE_ID,
    cwd: "/Users/foo/project-b",
    changes: [{
      kind: "upsert",
      scope: "cwd-ancestor-md",
      path: "/Users/foo/project-b/CLAUDE.md",
      size: content.length,
      mtime: 1,
      sha256: sha256(content),
      contentBase64: b64(content),
    }],
  });

  const manifest = await harness.store.loadManifest(DEVICE_ID);
  assert.ok(manifest.scopes["cwd-ancestor-md"].entries["/Users/foo/project-b/CLAUDE.md"]);
  assert.equal(task?.revision, activeRevision);
});

test("ancestor deltas from two cwd are keyed by absolute path", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);

  await harness.manager.applyAncestorDelta({
    type: "cache_task_ancestor_delta",
    deviceId: DEVICE_ID,
    cwd: "/repo/a",
    changes: [{
      kind: "delete",
      scope: "cwd-ancestor-md",
      path: "/repo/a/CLAUDE.md",
    }],
  });
  await harness.manager.applyAncestorDelta({
    type: "cache_task_ancestor_delta",
    deviceId: DEVICE_ID,
    cwd: "/repo/b",
    changes: [{
      kind: "upsert",
      scope: "cwd-ancestor-md",
      path: "/repo/b/CLAUDE.md",
      size: 1,
      mtime: 1,
      sha256: sha256("b"),
      contentBase64: b64("b"),
    }],
  });

  const manifest = await harness.store.loadManifest(DEVICE_ID);
  assert.equal(manifest.scopes["cwd-ancestor-md"].entries["/repo/a/CLAUDE.md"], undefined);
  assert.ok(manifest.scopes["cwd-ancestor-md"].entries["/repo/b/CLAUDE.md"]);
});


test("failover on heartbeat timeout", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);

  const client1 = harness.addClient("client-1");
  const client2 = harness.addClient("client-2");
  await harness.manager.registerHello("client-1", capableHello());
  await harness.manager.registerHello("client-2", capableHello());

  const firstAssignment1 = latestAssignment(client1.messages);
  const firstAssignment2 = latestAssignment(client2.messages);
  const activeClientId = firstAssignment1.role === "active" ? "client-1" : "client-2";
  const standbyClient = activeClientId === "client-1" ? client2 : client1;
  const standbyInitial = latestAssignment(standbyClient.messages);

  harness.clock.now += 20_000;
  await harness.manager.sweepHeartbeats();

  const standbyAfterFailover = latestAssignment(standbyClient.messages);
  assert.equal(standbyInitial.role, "inactive");
  assert.equal(standbyAfterFailover.role, "active");
  assert.equal(standbyAfterFailover.reason, "failover");
  assert.notEqual(standbyAfterFailover.assignmentId, firstAssignment1.assignmentId);
  void firstAssignment2;
});

test("active disconnect promotes standby to active", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);

  const client1 = harness.addClient("client-1");
  const client2 = harness.addClient("client-2");
  await harness.manager.registerHello("client-1", capableHello());
  await harness.manager.registerHello("client-2", capableHello());

  const assignment1 = latestAssignment(client1.messages);
  const assignment2 = latestAssignment(client2.messages);
  const initialActive =
    assignment1.role === "active"
      ? { clientId: "client-1", assignment: assignment1 }
      : { clientId: "client-2", assignment: assignment2 };
  const standbyClient = initialActive.clientId === "client-1" ? client2 : client1;
  const standbyInitial = latestAssignment(standbyClient.messages);

  await harness.manager.handleDisconnect(initialActive.clientId);

  const promoted = latestAssignment(standbyClient.messages);
  assert.equal(standbyInitial.role, "inactive");
  assert.equal(promoted.role, "active");
  assert.equal(promoted.reason, "failover");
  assert.notEqual(promoted.assignmentId, standbyInitial.assignmentId);
});

test("legacy client without cacheTaskV1 capability is never elected", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);

  const client1 = harness.addClient("client-1");
  const client2 = harness.addClient("client-2");

  await harness.manager.registerHello("client-1", {
    ...capableHello(),
    capabilities: {},
  });
  await harness.manager.registerHello("client-2", capableHello());

  const client1Assignment = latestAssignment(client1.messages);
  const client2Assignment = latestAssignment(client2.messages);
  const task = getTaskRecord(harness.manager);

  assert.equal(client1Assignment.role, "inactive");
  assert.equal(client1Assignment.reason, "capability_missing");
  assert.equal(client2Assignment.role, "active");
  assert.equal(task?.candidateClientIds.has("client-1"), false);
});

test("reject stale delta by assignmentId", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);

  const client = harness.addClient("client-1");
  await harness.manager.registerHello("client-1", capableHello());
  const firstAssignment = latestAssignment(client.messages);

  await harness.manager.registerHello("client-1", capableHello());
  const secondAssignment = latestAssignment(client.messages);
  assert.notEqual(firstAssignment.assignmentId, secondAssignment.assignmentId);

  await harness.manager.applyDelta("client-1", {
    type: "cache_task_delta",
    assignmentId: firstAssignment.assignmentId,
    batchId: "batch-1",
    baseRevision: firstAssignment.manifest?.revision ?? 0,
    mode: "live",
    sentAt: harness.clock.now,
    changes: [],
  });

  const ack = latestAck(client.messages);
  assert.equal(ack.ok, false);
  assert.equal(ack.errorCode, "STALE_ASSIGNMENT");
  assert.equal(ack.resyncRequired, true);
});

test("reject stale delta by revision", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);

  const client = harness.addClient("client-1");
  await harness.manager.registerHello("client-1", capableHello());
  const assignment = latestAssignment(client.messages);

  await harness.manager.applyDelta("client-1", {
    type: "cache_task_delta",
    assignmentId: assignment.assignmentId,
    batchId: "batch-1",
    baseRevision: assignment.manifest?.revision ?? 0,
    mode: "live",
    sentAt: harness.clock.now,
    changes: [
      {
        kind: "upsert",
        scope: "claude-home",
        path: "alpha.txt",
        size: 5,
        mtime: 1,
        sha256: sha256("alpha"),
        contentBase64: b64("alpha"),
      },
    ],
  });

  await harness.manager.applyDelta("client-1", {
    type: "cache_task_delta",
    assignmentId: assignment.assignmentId,
    batchId: "batch-2",
    baseRevision: assignment.manifest?.revision ?? 0,
    mode: "live",
    sentAt: harness.clock.now,
    changes: [],
  });

  const ack = latestAck(client.messages);
  assert.equal(ack.ok, false);
  assert.equal(ack.errorCode, "STALE_REVISION");
  assert.equal(ack.resyncRequired, true);
});

test("sync_complete moves task to ready", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);

  const client = harness.addClient("client-1");
  await harness.manager.registerHello("client-1", capableHello());
  const assignment = latestAssignment(client.messages);
  const initialRevision = assignment.manifest?.revision ?? 0;

  await harness.manager.applyDelta("client-1", {
    type: "cache_task_delta",
    assignmentId: assignment.assignmentId,
    batchId: "batch-1",
    baseRevision: initialRevision,
    mode: "initial",
    sentAt: harness.clock.now,
    changes: [
      {
        kind: "upsert",
        scope: "claude-home",
        path: "bootstrap.txt",
        size: 9,
        mtime: 1,
        sha256: sha256("bootstrap"),
        contentBase64: b64("bootstrap"),
      },
    ],
  });

  assert.equal(harness.manager.shouldUseCacheSnapshot(DEVICE_ID, CWD), false);
  await harness.manager.completeInitialSync("client-1", {
    type: "cache_task_sync_complete",
    assignmentId: assignment.assignmentId,
    baseRevision: initialRevision,
    scannedAt: harness.clock.now,
  });
  assert.equal(harness.manager.shouldUseCacheSnapshot(DEVICE_ID, CWD), true);
});

test("mutation hint TTL 过期后 shouldBypassCacheRead 返回 false", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);

  const client = harness.addClient("client-1");
  await harness.manager.registerHello("client-1", capableHello());
  const assignment = latestAssignment(client.messages);
  await harness.manager.completeInitialSync("client-1", {
    type: "cache_task_sync_complete",
    assignmentId: assignment.assignmentId,
    baseRevision: assignment.manifest?.revision ?? 0,
    scannedAt: harness.clock.now,
  });

  await harness.manager.registerMutationHintForPath(DEVICE_ID, CWD, [
    { scope: "claude-home", path: "settings.json" },
  ]);

  assert.equal(
    harness.manager.shouldBypassCacheRead(DEVICE_ID, CWD, "claude-home", "settings.json"),
    true,
  );

  harness.clock.now += 10_001;

  assert.equal(
    harness.manager.shouldBypassCacheRead(DEVICE_ID, CWD, "claude-home", "settings.json"),
    false,
  );
});

test("重复 mutationId 的 delta 会直接 ack，不重复推进 revision", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);

  const client = harness.addClient("client-1");
  await harness.manager.registerHello("client-1", capableHello());
  const assignment = latestAssignment(client.messages);

  await harness.manager.applyDelta("client-1", {
    type: "cache_task_delta",
    assignmentId: assignment.assignmentId,
    batchId: "batch-1",
    baseRevision: assignment.manifest?.revision ?? 0,
    mode: "live",
    sentAt: harness.clock.now,
    changes: [{
      kind: "upsert",
      scope: "claude-home",
      path: "settings.json",
      size: 5,
      mtime: 1,
      sha256: sha256("alpha"),
      contentBase64: b64("alpha"),
      mutationId: "mutation-1",
    }],
  });

  const firstAck = latestAck(client.messages);
  assert.equal(firstAck.ok, true);
  assert.equal(firstAck.appliedRevision, 1);

  await harness.manager.applyDelta("client-1", {
    type: "cache_task_delta",
    assignmentId: assignment.assignmentId,
    batchId: "batch-2",
    baseRevision: firstAck.appliedRevision ?? 0,
    mode: "live",
    sentAt: harness.clock.now,
    changes: [{
      kind: "upsert",
      scope: "claude-home",
      path: "settings.json",
      size: 5,
      mtime: 1,
      sha256: sha256("alpha"),
      contentBase64: b64("alpha"),
      mutationId: "mutation-1",
    }],
  });

  const secondAck = latestAck(client.messages);
  assert.equal(secondAck.ok, true);
  assert.equal(secondAck.appliedRevision, 1);

  const manifest = await harness.store.loadManifest(DEVICE_ID);
  assert.equal(manifest.revision, 1);
});

async function createHarness() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cerelay-cache-task-manager-"));
  const registry = new ClientRegistry();
  const store = new ClientCacheStore({ dataDir });
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

  return {
    manager,
    registry,
    store,
    clock,
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
    addClient(clientId: string) {
      const socket = createMockSocket();
      registry.register(clientId, socket, "token", "127.0.0.1");
      return {
        socket,
        get messages(): ServerToHandMessage[] {
          return socket.sent.map((entry) => JSON.parse(entry) as ServerToHandMessage);
        },
      };
    },
  };
}

function capableHello(cwd = CWD): ClientHello {
  return {
    type: "client_hello",
    deviceId: DEVICE_ID,
    cwd,
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
  const assignment = [...messages].reverse().find(isAssignment);
  assert.ok(assignment, "expected cache_task_assignment message");
  return assignment;
}

function latestAck(messages: ServerToHandMessage[]): CacheTaskDeltaAck {
  const ack = [...messages].reverse().find(isDeltaAck);
  assert.ok(ack, "expected cache_task_delta_ack message");
  return ack;
}

function getTaskRecord(manager: CacheTaskManager) {
  return (
    manager as unknown as {
      tasks: Map<string, { candidateClientIds: Set<string>; revision: number }>;
    }
  ).tasks.get(DEVICE_ID);
}

function isAssignment(message: ServerToHandMessage): message is CacheTaskAssignment {
  return message.type === "cache_task_assignment";
}

function isDeltaAck(message: ServerToHandMessage): message is CacheTaskDeltaAck {
  return message.type === "cache_task_delta_ack";
}

function createMockSocket(readyState = WebSocket.OPEN): WebSocket & { sent: string[] } {
  return {
    readyState,
    sent: [] as string[],
    send(data: unknown, callback?: (error?: Error) => void) {
      this.sent.push(String(data));
      callback?.();
    },
  } as WebSocket & { sent: string[] };
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}
