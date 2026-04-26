import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import {
  InitialSyncAbortedError,
  MAX_FILE_BYTES,
  applyScopeBudget,
  buildScopePlan,
  pushInitialDeltaBatches,
  scanLocalFiles,
} from "../src/cache-sync.js";
import type { CacheSyncEvent } from "../src/cache-sync.js";
import type { CacheTaskDelta, CacheTaskDeltaAck, CacheTaskUpsertChange } from "../src/protocol.js";

async function makeTempHome() {
  const home = await mkdtemp(path.join(tmpdir(), "cerelay-home-"));
  return { home, cleanup: () => rm(home, { recursive: true, force: true }) };
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

function maxInflightFromEvents(events: CacheSyncEvent[]): number {
  let current = 0;
  let max = 0;
  for (const event of events) {
    if (event.kind === "file_pushed") {
      current += 1;
      max = Math.max(max, current);
      continue;
    }
    if (event.kind === "file_acked") {
      current -= 1;
    }
  }
  return max;
}

test("scanLocalFiles claude-json 返回空数组当文件不存在", async (t) => {
  const { home, cleanup } = await makeTempHome();
  t.after(cleanup);
  const entries = await scanLocalFiles("claude-json", home);
  assert.deepEqual(entries, []);
});

test("scanLocalFiles claude-home 递归遍历 ~/.claude/", async (t) => {
  const { home, cleanup } = await makeTempHome();
  t.after(cleanup);
  await mkdir(path.join(home, ".claude", "nested"), { recursive: true });
  await writeFile(path.join(home, ".claude", "settings.json"), "{}", "utf8");
  await writeFile(path.join(home, ".claude", "nested", "prefs.json"), '{"a":1}', "utf8");

  const entries = await scanLocalFiles("claude-home", home);
  assert.deepEqual(
    entries.map((entry) => entry.relPath).sort(),
    ["nested/prefs.json", "settings.json"],
  );
});

test("applyScopeBudget 单文件 skipped 不占预算，按 mtime 截断其余项", () => {
  const adds: CacheTaskUpsertChange[] = [
    {
      kind: "upsert",
      scope: "claude-home",
      path: "big.bin",
      size: MAX_FILE_BYTES + 1,
      mtime: 100,
      sha256: null,
      skipped: true,
    },
    {
      kind: "upsert",
      scope: "claude-home",
      path: "newer.json",
      size: 70 * 1024 * 1024,
      mtime: 90,
      sha256: "a",
      contentBase64: "YQ==",
    },
    {
      kind: "upsert",
      scope: "claude-home",
      path: "older.json",
      size: 40 * 1024 * 1024,
      mtime: 80,
      sha256: "b",
      contentBase64: "Yg==",
    },
  ];

  const { kept, truncatedAdds } = applyScopeBudget(adds);
  assert.equal(truncatedAdds, true);
  assert.deepEqual(
    kept.map((entry) => entry.path).sort(),
    ["big.bin", "newer.json"],
  );
});

test("buildScopePlan 生成 uploads、skipped metadata 与 remote deletes", async (t) => {
  const { home, cleanup } = await makeTempHome();
  t.after(cleanup);
  await mkdir(path.join(home, ".claude"), { recursive: true });
  const unchanged = path.join(home, ".claude", "unchanged.json");
  await writeFile(unchanged, "{}", "utf8");
  const stats = await import("node:fs/promises").then((fs) => fs.stat(unchanged));
  await utimes(unchanged, stats.atime, stats.mtime);
  await writeFile(path.join(home, ".claude", "large.bin"), Buffer.alloc(MAX_FILE_BYTES + 10));
  await writeFile(path.join(home, ".claude", "fresh.json"), '{"ok":true}', "utf8");

  const unchangedStats = await import("node:fs/promises").then((fs) => fs.stat(unchanged));
  const plan = await buildScopePlan({
    scope: "claude-home",
    homedir: home,
    remote: {
      entries: {
        "unchanged.json": {
          size: unchangedStats.size,
          mtime: Math.floor(unchangedStats.mtimeMs),
          sha256: "ignored",
        },
        "stale.json": {
          size: 1,
          mtime: 1,
          sha256: "old",
        },
      },
    },
  });

  assert.deepEqual(plan.uploads.map((item) => item.change.path), ["fresh.json"]);
  assert.ok(plan.metaChanges.some((change) => change.kind === "delete" && change.path === "stale.json"));
  assert.ok(
    plan.metaChanges.some(
      (change) => change.kind === "upsert" && change.path === "large.bin" && change.skipped === true,
    ),
  );
});

test("pushInitialDeltaBatches 保留 file_pushed/file_acked 事件契约并预分配 baseRevision", async () => {
  const sent: CacheTaskDelta[] = [];
  const subscribers = new Set<(ack: CacheTaskDeltaAck) => void>();
  const events: CacheSyncEvent[] = [];
  let revision = 7;

  const result = await pushInitialDeltaBatches({
    assignmentId: "assign-1",
    baseRevision: revision,
    plans: [
      {
        scope: "claude-home",
        uploads: [
          {
            displayPath: "~/.claude/a.json",
            change: {
              kind: "upsert",
              scope: "claude-home",
              path: "a.json",
              size: 3,
              mtime: 1,
              sha256: "a",
              contentBase64: "YQ==",
            },
          },
          {
            displayPath: "~/.claude/b.json",
            change: {
              kind: "upsert",
              scope: "claude-home",
              path: "b.json",
              size: 3,
              mtime: 2,
              sha256: "b",
              contentBase64: "Yg==",
            },
          },
        ],
        metaChanges: [{ kind: "delete", scope: "claude-home", path: "gone.json" }],
        truncated: false,
        totalLocal: 2,
      },
    ],
    sendDelta: async (delta) => {
      sent.push(delta);
      revision += 1;
      queueMicrotask(() => {
        for (const subscriber of Array.from(subscribers)) {
          subscriber({
            type: "cache_task_delta_ack",
            assignmentId: delta.assignmentId,
            batchId: delta.batchId,
            ok: true,
            appliedRevision: revision,
          });
        }
      });
    },
    subscribeAcks: (handler) => {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },
    onProgress: (event) => events.push(event),
    createBatchId: (() => {
      let id = 0;
      return () => `batch-${++id}`;
    })(),
    now: (() => {
      let value = 10;
      return () => ++value;
    })(),
  });

  assert.equal(sent.length, 3);
  assert.deepEqual(sent.map((delta) => delta.baseRevision), [7, 8, 9]);
  assert.equal(sent[0].changes[0]?.kind, "delete");
  assert.equal(events[0]?.kind, "upload_start");
  assert.equal(events.at(-1)?.kind, "upload_done");
  const pushed = events.filter((event): event is Extract<CacheSyncEvent, { kind: "file_pushed" }> => event.kind === "file_pushed");
  const acked = events.filter((event): event is Extract<CacheSyncEvent, { kind: "file_acked" }> => event.kind === "file_acked");
  assert.deepEqual(pushed.map((event) => event.seq), [1, 2]);
  assert.deepEqual(acked.map((event) => event.seq).sort((a, b) => a - b), [1, 2]);
  assert.equal(result.baseRevision, 10);
});

test("pushInitialDeltaBatches 在 initial 阶段保留多文件并发 in-flight", async () => {
  const sent: CacheTaskDelta[] = [];
  const subscribers = new Set<(ack: CacheTaskDeltaAck) => void>();
  const events: CacheSyncEvent[] = [];
  const batches = new Map<string, CacheTaskDelta>();

  const promise = pushInitialDeltaBatches({
    assignmentId: "assign-1",
    baseRevision: 20,
    plans: [{
      scope: "claude-home",
      uploads: [
        makeUpload("a.json", 3, 1, "a"),
        makeUpload("b.json", 3, 2, "b"),
        makeUpload("c.json", 3, 3, "c"),
      ],
      metaChanges: [],
      truncated: false,
      totalLocal: 3,
    }],
    sendDelta: async (delta) => {
      sent.push(delta);
      batches.set(delta.batchId, delta);
    },
    subscribeAcks: (handler) => {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },
    onProgress: (event) => events.push(event),
    createBatchId: (() => {
      let id = 0;
      return () => `batch-${++id}`;
    })(),
    now: (() => {
      let value = 100;
      return () => ++value;
    })(),
  });

  await waitFor(() => sent.length === 3);
  assert.deepEqual(sent.map((delta) => delta.baseRevision), [20, 21, 22]);
  assert.equal(events.filter((event) => event.kind === "file_pushed").length, 3);
  assert.equal(events.filter((event) => event.kind === "file_acked").length, 0);
  assert.ok(maxInflightFromEvents(events) > 1);

  ackBatch(subscribers, batches.get("batch-1")!, 21);
  await waitFor(() => events.filter((event) => event.kind === "file_acked").length === 1);
  ackBatch(subscribers, batches.get("batch-2")!, 22);
  ackBatch(subscribers, batches.get("batch-3")!, 23);

  const result = await promise;
  assert.equal(result.baseRevision, 23);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["upload_start", "file_pushed", "file_pushed", "file_pushed", "file_acked", "file_acked", "file_acked", "upload_done"],
  );
});

test("pushInitialDeltaBatches 在达到 capacity 水位前阻塞后续 push", async () => {
  const sent: CacheTaskDelta[] = [];
  const subscribers = new Set<(ack: CacheTaskDeltaAck) => void>();
  const batches = new Map<string, CacheTaskDelta>();

  const promise = pushInitialDeltaBatches({
    assignmentId: "assign-1",
    baseRevision: 30,
    maxInflightBytes: 10,
    plans: [{
      scope: "claude-home",
      uploads: [
        makeUpload("a.bin", 7, 1, "a"),
        makeUpload("b.bin", 7, 2, "b"),
        makeUpload("c.bin", 7, 3, "c"),
      ],
      metaChanges: [],
      truncated: false,
      totalLocal: 3,
    }],
    sendDelta: async (delta) => {
      sent.push(delta);
      batches.set(delta.batchId, delta);
    },
    subscribeAcks: (handler) => {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },
    createBatchId: (() => {
      let id = 0;
      return () => `batch-${++id}`;
    })(),
  });

  await waitFor(() => sent.length === 1);
  await delay(10);
  assert.equal(sent.length, 1);

  ackBatch(subscribers, batches.get("batch-1")!, 31);
  await waitFor(() => sent.length === 2);
  await delay(10);
  assert.equal(sent.length, 2);

  ackBatch(subscribers, batches.get("batch-2")!, 32);
  await waitFor(() => sent.length === 3);
  ackBatch(subscribers, batches.get("batch-3")!, 33);

  const result = await promise;
  assert.equal(result.baseRevision, 33);
});

test("pushInitialDeltaBatches abort 时清理 ack listener 并抛 InitialSyncAbortedError", async () => {
  const controller = new AbortController();
  const sent: CacheTaskDelta[] = [];
  const subscribers = new Set<(ack: CacheTaskDeltaAck) => void>();
  const events: CacheSyncEvent[] = [];

  const promise = pushInitialDeltaBatches({
    assignmentId: "assign-1",
    baseRevision: 40,
    plans: [{
      scope: "claude-home",
      uploads: [
        makeUpload("a.json", 3, 1, "a"),
        makeUpload("b.json", 3, 2, "b"),
      ],
      metaChanges: [],
      truncated: false,
      totalLocal: 2,
    }],
    sendDelta: async (delta) => {
      sent.push(delta);
    },
    subscribeAcks: (handler) => {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },
    abortSignal: controller.signal,
    onProgress: (event) => events.push(event),
    createBatchId: (() => {
      let id = 0;
      return () => `batch-${++id}`;
    })(),
  });

  await waitFor(() => sent.length === 2);
  assert.equal(subscribers.size, 1);

  controller.abort();

  await assert.rejects(promise, InitialSyncAbortedError);
  assert.equal(subscribers.size, 0);
  const uploadDone = events.find((event): event is Extract<CacheSyncEvent, { kind: "upload_done" }> => event.kind === "upload_done");
  assert.equal(uploadDone?.aborted, true);
});

function makeUpload(pathName: string, size: number, mtime: number, sha: string) {
  return {
    displayPath: `~/.claude/${pathName}`,
    change: {
      kind: "upsert" as const,
      scope: "claude-home" as const,
      path: pathName,
      size,
      mtime,
      sha256: sha,
      contentBase64: "YQ==",
    },
  };
}

function ackBatch(
  subscribers: Set<(ack: CacheTaskDeltaAck) => void>,
  delta: CacheTaskDelta,
  appliedRevision: number,
): void {
  for (const subscriber of Array.from(subscribers)) {
    subscriber({
      type: "cache_task_delta_ack",
      assignmentId: delta.assignmentId,
      batchId: delta.batchId,
      ok: true,
      appliedRevision,
    });
  }
}
