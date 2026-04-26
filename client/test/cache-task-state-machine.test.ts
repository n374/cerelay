import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { CacheTaskStateMachine } from "../src/cache-task-state-machine.js";
import type { CacheSyncEvent, ScopePlan } from "../src/cache-sync.js";
import type {
  CacheTaskAssignment,
  CacheTaskChange,
  CacheTaskDeltaAck,
  HandToServerMessage,
} from "../src/protocol.js";

class FakeWatcher {
  started = false;
  stopped = false;
  flushNowCalls = 0;
  suppressed: Array<{ paths: Array<{ absPath: string; mutationId: string }>; ttlMs: number }> = [];

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async flushNow(): Promise<void> {
    this.flushNowCalls += 1;
  }

  suppressPaths(paths: Array<{ absPath: string; mutationId: string }>, ttlMs: number): void {
    this.suppressed.push({ paths, ttlMs });
  }

  clearSuppressor(): void {}
}

function makeActiveAssignment(): CacheTaskAssignment {
  return {
    type: "cache_task_assignment",
    deviceId: "device-1",
    cwd: "/repo",
    assignmentId: "assignment-1",
    role: "active",
    reason: "elected",
    heartbeatIntervalMs: 5_000,
    heartbeatTimeoutMs: 15_000,
    manifest: {
      revision: 3,
      scopes: {
        "claude-home": { entries: {} },
        "claude-json": { entries: {} },
      },
    },
  };
}

function noopInterval(): NodeJS.Timeout {
  return { unref() {} } as unknown as NodeJS.Timeout;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("waitFor timeout");
    }
    await delay(0);
  }
}

test("CacheTaskStateMachine onConnected 发送 client_hello 并进入 passive", async () => {
  const sent: HandToServerMessage[] = [];
  const sm = new CacheTaskStateMachine({
    cwd: "/repo",
    deviceId: "device-1",
    disableCacheTask: false,
    setIntervalFn: noopInterval as unknown as typeof setInterval,
    clearIntervalFn: (() => undefined) as typeof clearInterval,
  });

  await sm.onConnected(async (message) => {
    sent.push(message);
  });

  assert.equal(sm.getState(), "connected-passive");
  assert.equal(sent[0]?.type, "client_hello");
});

test("CacheTaskStateMachine 收到 active assignment 后启动 watcher、推 initial、发 sync_complete", async () => {
  const sent: HandToServerMessage[] = [];
  const progress: CacheSyncEvent[] = [];
  const watcher = new FakeWatcher();
  const buildCalls: string[] = [];
  let pushCalled = false;

  const sm = new CacheTaskStateMachine({
    cwd: "/repo",
    deviceId: "device-1",
    disableCacheTask: false,
    setIntervalFn: noopInterval as unknown as typeof setInterval,
    clearIntervalFn: (() => undefined) as typeof clearInterval,
    watcherFactory: () => watcher,
    onProgress: (event) => progress.push(event),
    buildScopePlan: async ({ scope }) => {
      buildCalls.push(scope);
      const plan: ScopePlan = {
        scope,
        uploads: scope === "claude-home"
          ? [{
              displayPath: "~/.claude/a.json",
              change: {
                kind: "upsert",
                scope,
                path: "a.json",
                size: 1,
                mtime: 1,
                sha256: "a",
                contentBase64: "YQ==",
              },
            }]
          : [],
        metaChanges: [],
        truncated: false,
        totalLocal: scope === "claude-home" ? 1 : 0,
      };
      return plan;
    },
    pushInitialDeltaBatches: async ({ assignmentId, baseRevision }) => {
      pushCalled = true;
      assert.equal(watcher.started, true);
      assert.equal(assignmentId, "assignment-1");
      assert.equal(baseRevision, 3);
      return {
        baseRevision: 4,
        summaries: [],
      };
    },
  });

  await sm.onConnected(async (message) => {
    sent.push(message);
  });
  await sm.onMessage(makeActiveAssignment());

  assert.equal(pushCalled, true);
  assert.deepEqual(buildCalls, ["claude-home", "claude-json"]);
  assert.equal(watcher.flushNowCalls, 1);
  assert.equal(sm.getState(), "assigned-watching");
  assert.ok(progress.some((event) => event.kind === "scan_start"));
  assert.ok(progress.some((event) => event.kind === "scan_done"));
  const syncComplete = sent.find((message) => message.type === "cache_task_sync_complete");
  assert.equal(syncComplete?.type, "cache_task_sync_complete");
  if (syncComplete?.type === "cache_task_sync_complete") {
    assert.equal(syncComplete.baseRevision, 4);
  }
});

test("CacheTaskStateMachine 收到 inactive assignment 后停止 watcher 并回到 passive", async () => {
  const watcher = new FakeWatcher();
  const sm = new CacheTaskStateMachine({
    cwd: "/repo",
    deviceId: "device-1",
    disableCacheTask: false,
    setIntervalFn: noopInterval as unknown as typeof setInterval,
    clearIntervalFn: (() => undefined) as typeof clearInterval,
    watcherFactory: () => watcher,
    buildScopePlan: async ({ scope }) => ({
      scope,
      uploads: [],
      metaChanges: [],
      truncated: false,
      totalLocal: 0,
    }),
    pushInitialDeltaBatches: async () => ({ baseRevision: 3, summaries: [] }),
  });

  await sm.onConnected(async () => undefined);
  await sm.onMessage(makeActiveAssignment());
  await sm.onMessage({
    ...makeActiveAssignment(),
    role: "inactive",
    assignmentId: "inactive",
    reason: "standby",
    manifest: undefined,
  });

  assert.equal(sm.getState(), "connected-passive");
  assert.equal(watcher.stopped, true);
});

test("CacheTaskStateMachine 收到 inactive assignment 时会中断进行中的 initial sync", async () => {
  const watcher = new FakeWatcher();
  let abortSignal: AbortSignal | undefined;
  let abortChecks = 0;

  const sm = new CacheTaskStateMachine({
    cwd: "/repo",
    deviceId: "device-1",
    disableCacheTask: false,
    setIntervalFn: noopInterval as unknown as typeof setInterval,
    clearIntervalFn: (() => undefined) as typeof clearInterval,
    watcherFactory: () => watcher,
    buildScopePlan: async ({ scope }) => ({
      scope,
      uploads: [],
      metaChanges: [],
      truncated: false,
      totalLocal: 0,
    }),
    pushInitialDeltaBatches: async ({ abortSignal: signal, shouldAbort }) => {
      abortSignal = signal;
      assert.equal(shouldAbort?.(), false);
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", resolve, { once: true });
      });
      abortChecks += 1;
      assert.equal(shouldAbort?.(), true);
      throw new Error("aborted");
    },
  });

  await sm.onConnected(async () => undefined);
  const activePromise = sm.onMessage(makeActiveAssignment());
  await waitFor(() => abortSignal !== undefined);

  await sm.onMessage({
    ...makeActiveAssignment(),
    role: "inactive",
    assignmentId: "inactive",
    reason: "standby",
    manifest: undefined,
  });
  await activePromise;

  assert.equal(abortSignal?.aborted, true);
  assert.equal(abortChecks, 1);
  assert.equal(sm.getState(), "connected-passive");
});

test("CacheTaskStateMachine task token mismatch ack 会退回 passive", async () => {
  const watcher = new FakeWatcher();
  const sent: HandToServerMessage[] = [];
  const sm = new CacheTaskStateMachine({
    cwd: "/repo",
    deviceId: "device-1",
    disableCacheTask: false,
    setIntervalFn: noopInterval as unknown as typeof setInterval,
    clearIntervalFn: (() => undefined) as typeof clearInterval,
    watcherFactory: () => watcher,
    buildScopePlan: async ({ scope }) => ({
      scope,
      uploads: [],
      metaChanges: [],
      truncated: false,
      totalLocal: 0,
    }),
    pushInitialDeltaBatches: async () => ({ baseRevision: 3, summaries: [] }),
  });

  await sm.onConnected(async (message) => {
    sent.push(message);
  });
  await sm.onMessage(makeActiveAssignment());
  assert.equal(sm.getState(), "assigned-watching");

  const ack: CacheTaskDeltaAck = {
    type: "cache_task_delta_ack",
    assignmentId: "assignment-1",
    batchId: "batch-1",
    ok: false,
    errorCode: "STALE_ASSIGNMENT",
    error: "stale",
    resyncRequired: true,
  };
  await sm.onMessage(ack);

  assert.equal(sm.getState(), "connected-passive");
  assert.equal(watcher.stopped, true);
});

test("CacheTaskStateMachine mutation hint 会把 absPath 和 mutationId 传给 watcher", async () => {
  const watcher = new FakeWatcher();
  const sm = new CacheTaskStateMachine({
    cwd: "/repo",
    deviceId: "device-1",
    homedir: "/Users/tester",
    disableCacheTask: false,
    suppressTtlMs: 1_234,
    setIntervalFn: noopInterval as unknown as typeof setInterval,
    clearIntervalFn: (() => undefined) as typeof clearInterval,
    watcherFactory: () => watcher,
    buildScopePlan: async ({ scope }) => ({
      scope,
      uploads: [],
      metaChanges: [],
      truncated: false,
      totalLocal: 0,
    }),
    pushInitialDeltaBatches: async () => ({ baseRevision: 3, summaries: [] }),
  });

  await sm.onConnected(async () => undefined);
  await sm.onMessage(makeActiveAssignment());
  await sm.onMessage({
    type: "cache_task_mutation_hint",
    assignmentId: "assignment-1",
    mutationId: "mutation-1",
    targets: [{ scope: "claude-home", path: "settings.json" }],
    issuedAt: 1,
  });

  assert.deepEqual(watcher.suppressed, [{
    paths: [{
      absPath: "/Users/tester/.claude/settings.json",
      mutationId: "mutation-1",
    }],
    ttlMs: 1_234,
  }]);
});

test("CacheTaskStateMachine 使用 assignment 指定的 heartbeatIntervalMs", async () => {
  const watcher = new FakeWatcher();
  const intervalMs: number[] = [];
  let cleared = 0;
  const timer = noopInterval();
  const assignment = {
    ...makeActiveAssignment(),
    heartbeatIntervalMs: 1_234,
  };

  const sm = new CacheTaskStateMachine({
    cwd: "/repo",
    deviceId: "device-1",
    disableCacheTask: false,
    setIntervalFn: ((_: () => void, ms?: number) => {
      intervalMs.push(ms ?? 0);
      return timer;
    }) as unknown as typeof setInterval,
    clearIntervalFn: (() => {
      cleared += 1;
    }) as typeof clearInterval,
    watcherFactory: () => watcher,
    buildScopePlan: async ({ scope }) => ({
      scope,
      uploads: [],
      metaChanges: [],
      truncated: false,
      totalLocal: 0,
    }),
    pushInitialDeltaBatches: async () => ({ baseRevision: 3, summaries: [] }),
  });

  await sm.onConnected(async () => undefined);
  await sm.onMessage(assignment);
  await sm.onMessage({
    ...assignment,
    role: "inactive",
    assignmentId: "inactive",
    reason: "standby",
    manifest: undefined,
  });

  assert.deepEqual(intervalMs, [1_234]);
  assert.ok(cleared >= 1);
});

test("CacheTaskStateMachine 读取 CERELAY_DISABLE_CACHE_TASK 时跳过 hello", async (t) => {
  const original = process.env.CERELAY_DISABLE_CACHE_TASK;
  process.env.CERELAY_DISABLE_CACHE_TASK = "true";
  t.after(() => {
    if (original === undefined) {
      delete process.env.CERELAY_DISABLE_CACHE_TASK;
      return;
    }
    process.env.CERELAY_DISABLE_CACHE_TASK = original;
  });

  const sent: HandToServerMessage[] = [];
  const sm = new CacheTaskStateMachine({
    cwd: "/repo",
    deviceId: "device-1",
    setIntervalFn: noopInterval as unknown as typeof setInterval,
    clearIntervalFn: (() => undefined) as typeof clearInterval,
  });

  await sm.onConnected(async (message) => {
    sent.push(message);
  });

  assert.equal(sm.getState(), "connected-passive");
  assert.equal(sent.length, 0);
});
