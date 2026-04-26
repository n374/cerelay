import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import {
  CacheTaskDeltaAckError,
  InitialSyncAbortedError,
  MAX_FILE_BYTES,
  applyScopeBudget,
  buildScopePlan,
  hashScope,
  pushInitialDeltaBatches,
  scanLocalFiles,
  walkScope,
} from "../src/cache-sync.js";
import type { ScanCacheStore } from "../src/scan-cache.js";
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
  const stats = await stat(unchanged);
  await utimes(unchanged, stats.atime, stats.mtime);
  await writeFile(path.join(home, ".claude", "large.bin"), Buffer.alloc(MAX_FILE_BYTES + 10));
  await writeFile(path.join(home, ".claude", "fresh.json"), '{"ok":true}', "utf8");

  const unchangedStats = await stat(unchanged);
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

test("buildScopePlan 接受 exclude matcher，被排除的路径不会进入 plan", async (t) => {
  const { home, cleanup } = await makeTempHome();
  t.after(cleanup);
  await mkdir(path.join(home, ".claude", "projects"), { recursive: true });
  await writeFile(path.join(home, ".claude", "keep.json"), "keep", "utf8");
  await writeFile(path.join(home, ".claude", "projects", "skip.json"), "skip", "utf8");

  const plan = await buildScopePlan({
    scope: "claude-home",
    homedir: home,
    remote: undefined,
    exclude: (relPath) => relPath === "projects" || relPath.startsWith("projects/"),
  });

  assert.deepEqual(plan.uploads.map((item) => item.change.path), ["keep.json"]);
  assert.equal(plan.totalLocal, 1);
});

test("buildScopePlan 接受 scanCache：命中时复用 sha256，并把 miss 写回缓存", async (t) => {
  const { home, cleanup } = await makeTempHome();
  t.after(cleanup);
  await mkdir(path.join(home, ".claude"), { recursive: true });
  const hitPath = path.join(home, ".claude", "hit.json");
  const missPath = path.join(home, ".claude", "miss.json");
  await writeFile(hitPath, "hit-content", "utf8");
  await writeFile(missPath, "miss-content", "utf8");
  const hitStats = await stat(hitPath);
  const missStats = await stat(missPath);
  const upserts: Array<{ scope: string; relPath: string; sha256: string }> = [];
  let prunedPaths: Set<string> | null = null;

  const scanCache: ScanCacheStore = {
    lookup(scope, relPath, size, mtime) {
      if (
        scope === "claude-home"
        && relPath === "hit.json"
        && size === hitStats.size
        && mtime === Math.floor(hitStats.mtimeMs)
      ) {
        return "cached-hit-sha";
      }
      return null;
    },
    upsert(scope, relPath, entry) {
      upserts.push({ scope, relPath, sha256: entry.sha256 });
    },
    pruneToPresent(_scope, presentPaths) {
      prunedPaths = new Set(presentPaths);
    },
    async flush() {},
  };

  const plan = await buildScopePlan({
    scope: "claude-home",
    homedir: home,
    remote: undefined,
    scanCache,
  });

  const uploads = new Map(plan.uploads.map((item) => [item.change.path, item.change]));
  assert.equal(uploads.get("hit.json")?.sha256, "cached-hit-sha");
  assert.equal(
    uploads.get("miss.json")?.sha256,
    createHash("sha256").update("miss-content").digest("hex"),
  );
  assert.deepEqual(upserts, [{
    scope: "claude-home",
    relPath: "miss.json",
    sha256: createHash("sha256").update("miss-content").digest("hex"),
  }]);
  assert.deepEqual(
    Array.from(prunedPaths ?? []).sort(),
    ["hit.json", "miss.json"],
  );
  assert.equal(plan.totalLocal, 2);
  assert.equal(scanCache.lookup("claude-home", "miss.json", missStats.size, Math.floor(missStats.mtimeMs)), null);
});

test("walkScope/hashScope 中 walk_done 必须先于所有 hash_progress", async (t) => {
  const { home, cleanup } = await makeTempHome();
  t.after(cleanup);
  await mkdir(path.join(home, ".claude"), { recursive: true });
  const unchangedPath = path.join(home, ".claude", "unchanged.json");
  await writeFile(unchangedPath, "{}", "utf8");
  await writeFile(path.join(home, ".claude", "fresh.json"), '{"ok":true}', "utf8");
  const unchangedStats = await stat(unchangedPath);
  const locals = await walkScope({
    scope: "claude-home",
    homedir: home,
  });
  const events: Array<
    | { kind: "walk_done"; totalFiles: number }
    | { kind: "hash_progress"; completedFiles: number; totalFiles: number }
  > = [];
  let completedFiles = 0;

  events.push({ kind: "walk_done", totalFiles: locals.length });
  const plan = await hashScope({
    scope: "claude-home",
    locals,
    remote: {
      entries: {
        "unchanged.json": {
          size: unchangedStats.size,
          mtime: Math.floor(unchangedStats.mtimeMs),
          sha256: "remote-hit",
        },
      },
    },
    onHashProgress: () => {
      completedFiles += 1;
      events.push({
        kind: "hash_progress",
        completedFiles,
        totalFiles: locals.length,
      });
    },
  });

  assert.equal(plan.totalLocal, 2);
  assert.deepEqual(events.map((event) => event.kind), ["walk_done", "hash_progress", "hash_progress"]);
  assert.deepEqual(
    events.filter((event): event is Extract<(typeof events)[number], { kind: "hash_progress" }> => event.kind === "hash_progress")
      .map((event) => event.completedFiles),
    [1, 2],
  );
  assert.ok(events.slice(1).every((event) => event.kind === "hash_progress"));
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

test("buildScopePlan 为 0 字节文件生成 contentBase64=''（不会标记 skipped）", async (t) => {
  // 回归：~/.claude/tasks/<uuid>/.lock 这类 0 字节锁文件，buildUpsertChange 走的是
  // readFile + base64 路径（不是 skipped），buffer.toString("base64") 返回 ""。
  // 该值是合法字段，server 必须接受；不应被 client 这层过滤掉。
  const { home, cleanup } = await makeTempHome();
  t.after(cleanup);

  const lockDir = path.join(home, ".claude", "tasks", "abc");
  await mkdir(lockDir, { recursive: true });
  await writeFile(path.join(lockDir, ".lock"), "");

  const plan = await buildScopePlan({
    scope: "claude-home",
    homedir: home,
    remote: undefined,
    exclude: () => false,
  });
  assert.equal(plan.uploads.length, 1);
  const upload = plan.uploads[0]!;
  assert.equal(upload.change.path, "tasks/abc/.lock");
  assert.equal(upload.change.size, 0);
  assert.equal(upload.change.skipped, undefined);
  assert.equal(upload.change.contentBase64, "");
  // 空 buffer 的 sha256 是固定的
  assert.equal(
    upload.change.sha256,
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

test("pushInitialDeltaBatches: 多 future 同时被 reject 不留下 unhandled rejection", async () => {
  // 回归：当 server 回 ack.ok=false 时，fileFuture catch 块会 rejectAllPending 把同批
  // 其它 in-flight ackPromise 一并 reject。早先用 Promise.all(fileFutures) 只 await 第一个 reject，
  // 其它 rejected promise 没人消费 → Node 25 默认 --unhandled-rejections=throw → 进程 crash。
  // 必须用 allSettled 保证每个 future 都被消费。
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const subscribers = new Set<(ack: CacheTaskDeltaAck) => void>();
    const promise = pushInitialDeltaBatches({
      assignmentId: "assign-fail",
      baseRevision: 0,
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
        // Server 立刻拒收（模拟 server 端 STORE_WRITE_FAILED：每个文件都失败）
        queueMicrotask(() => {
          for (const subscriber of Array.from(subscribers)) {
            subscriber({
              type: "cache_task_delta_ack",
              assignmentId: delta.assignmentId,
              batchId: delta.batchId,
              ok: false,
              errorCode: "STORE_WRITE_FAILED",
              error: "stub failure",
              resyncRequired: false,
            });
          }
        });
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

    await assert.rejects(promise, CacheTaskDeltaAckError);
    // 给 microtask 队列充分时间；如果有其它 future 没被 await，rejection 会在这之后冒出来
    await delay(10);
    assert.equal(
      unhandled.length,
      0,
      `不应有 unhandled rejection，实际收到 ${unhandled.length} 个: ${unhandled.map((r) => (r instanceof Error ? r.message : String(r))).join(", ")}`,
    );
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
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
