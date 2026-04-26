import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { CacheTaskStateMachine } from "../src/cache-task-state-machine.js";
import type { CerelayConfig } from "../src/config.js";
import type { CacheSyncEvent, LocalEntry, ScopePlan } from "../src/cache-sync.js";
import type { ScanCacheStore } from "../src/scan-cache.js";
import type {
  CacheTaskAssignment,
  CacheTaskChange,
  CacheTaskDeltaAck,
  CacheScope,
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

class FakeScanCache implements ScanCacheStore {
  flushCalls = 0;

  lookup(): string | null {
    return null;
  }

  upsert(): void {}

  pruneToPresent(): void {}

  async flush(): Promise<void> {
    this.flushCalls += 1;
  }
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

const TEST_CONFIG: CerelayConfig = {
  scan: {
    excludeDirs: ["projects"],
  },
};

function makeEmptyPlan(scope: CacheScope, totalLocal: number): ScopePlan {
  return {
    scope,
    uploads: [],
    metaChanges: [],
    truncated: false,
    totalLocal,
  };
}

async function walkNothing(): Promise<LocalEntry[]> {
  return [];
}

async function hashNothing(args: { scope: CacheScope; locals: LocalEntry[] }): Promise<ScopePlan> {
  return makeEmptyPlan(args.scope, args.locals.length);
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
  const scanCache = new FakeScanCache();
  const walkedScopes: string[] = [];
  const hashedScopes: string[] = [];
  let watcherExclude: ((relPath: string) => boolean) | undefined;
  let pushCalled = false;

  const sm = new CacheTaskStateMachine({
    cwd: "/repo",
    deviceId: "device-1",
    config: TEST_CONFIG,
    scanCache,
    disableCacheTask: false,
    setIntervalFn: noopInterval as unknown as typeof setInterval,
    clearIntervalFn: (() => undefined) as typeof clearInterval,
    watcherFactory: ({ exclude }) => {
      watcherExclude = exclude;
      return watcher;
    },
    onProgress: (event) => progress.push(event),
    walkScope: async ({ scope, exclude }) => {
      walkedScopes.push(scope);
      if (scope === "claude-home") {
        assert.equal(exclude?.("projects/foo"), true);
        assert.equal(exclude?.("projectsx/foo"), false);
        return [{
          relPath: "a.json",
          absPath: "/tmp/a.json",
          size: 1,
          mtime: 1,
        }];
      }
      return [];
    },
    hashScope: async ({ scope, locals, scanCache: injected, onHashProgress }) => {
      hashedScopes.push(scope);
      assert.equal(injected, scanCache);
      for (const _local of locals) {
        onHashProgress?.();
      }
      if (scope === "claude-home") {
        return {
          scope,
          uploads: [{
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
          }],
          metaChanges: [],
          truncated: false,
          totalLocal: locals.length,
        };
      }
      return makeEmptyPlan(scope, locals.length);
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
  assert.deepEqual(walkedScopes, ["claude-home", "claude-json"]);
  assert.deepEqual(hashedScopes, ["claude-home", "claude-json"]);
  assert.equal(watcherExclude?.("projects/demo"), true);
  assert.equal(watcherExclude?.("projectsx/demo"), false);
  assert.equal(scanCache.flushCalls, 1);
  assert.equal(watcher.flushNowCalls, 1);
  assert.equal(sm.getState(), "assigned-watching");
  assert.deepEqual(progress.map((event) => event.kind), [
    "scan_start",
    "walk_done",
    "hash_progress",
    "scan_done",
  ]);
  const syncComplete = sent.find((message) => message.type === "cache_task_sync_complete");
  assert.equal(syncComplete?.type, "cache_task_sync_complete");
  if (syncComplete?.type === "cache_task_sync_complete") {
    assert.equal(syncComplete.baseRevision, 4);
  }
});

test("CacheTaskStateMachine initial pipeline 失败时仍会 flush scan cache", async () => {
  const watcher = new FakeWatcher();
  const scanCache = new FakeScanCache();
  const sm = new CacheTaskStateMachine({
    cwd: "/repo",
    deviceId: "device-1",
    config: TEST_CONFIG,
    scanCache,
    disableCacheTask: false,
    setIntervalFn: noopInterval as unknown as typeof setInterval,
    clearIntervalFn: (() => undefined) as typeof clearInterval,
    watcherFactory: () => watcher,
    walkScope: async ({ scope }) => scope === "claude-home"
      ? [{
        relPath: "a.json",
        absPath: "/tmp/a.json",
        size: 1,
        mtime: 1,
      }]
      : [],
    hashScope: async ({ scope, locals, onHashProgress }) => {
      for (const _local of locals) {
        onHashProgress?.();
      }
      return makeEmptyPlan(scope, locals.length);
    },
    pushInitialDeltaBatches: async () => {
      throw new Error("pipeline failed");
    },
  });

  await sm.onConnected(async () => undefined);
  await sm.onMessage(makeActiveAssignment());

  assert.equal(scanCache.flushCalls, 1);
  assert.equal(sm.getState(), "connected-passive");
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
    walkScope: walkNothing,
    hashScope: hashNothing,
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
    walkScope: walkNothing,
    hashScope: hashNothing,
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
    walkScope: walkNothing,
    hashScope: hashNothing,
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

test("CacheTaskStateMachine initial sync 失败时降级到 passive 并保活进程（不抛、不留 unhandled rejection）", async () => {
  // 回归：早期 server 用 falsy 检查把 0 字节文件 contentBase64="" 误判为缺失，
  // ack.ok=false 经 fileFuture 抛出 → handleActiveAssignment 静默吞错 + 进程崩溃。
  // 修复后要求：
  //   1. 任何 sync 异常都不能从 onMessage 透传出去（否则 client.ts 那条 void 链变 unhandled rejection）
  //   2. 状态降级为 connected-passive（"无缓存继续"）
  //   3. 异常细节通过 logger 暴露（这里不直接断言 log，由 logger 实现保证）
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const watcher = new FakeWatcher();
    const sm = new CacheTaskStateMachine({
      cwd: "/repo",
      deviceId: "device-1",
      disableCacheTask: false,
      setIntervalFn: noopInterval as unknown as typeof setInterval,
      clearIntervalFn: (() => undefined) as typeof clearInterval,
      watcherFactory: () => watcher,
      walkScope: walkNothing,
      hashScope: hashNothing,
      pushInitialDeltaBatches: async () => {
        // 模拟 server 因校验失败返回 ack.ok=false，fileFuture 包成 CacheTaskDeltaAckError 抛出
        const { CacheTaskDeltaAckError } = await import("../src/cache-sync.js");
        throw new CacheTaskDeltaAckError({
          type: "cache_task_delta_ack",
          assignmentId: "assignment-1",
          batchId: "batch-1",
          ok: false,
          errorCode: "STORE_WRITE_FAILED",
          error: "cache_task_delta upsert 条目缺少 contentBase64",
          resyncRequired: false,
        });
      },
    });

    await sm.onConnected(async () => undefined);
    // 关键断言：onMessage 自己 await 完不抛
    await sm.onMessage(makeActiveAssignment());

    assert.equal(sm.getState(), "connected-passive");
    assert.equal(watcher.stopped, true);

    await delay(10);
    assert.equal(
      unhandled.length,
      0,
      `不应有 unhandled rejection，实际收到 ${unhandled.length} 个`,
    );
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
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
    walkScope: walkNothing,
    hashScope: hashNothing,
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
    walkScope: walkNothing,
    hashScope: hashNothing,
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
