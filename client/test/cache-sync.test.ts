/**
 * cache-sync 单元测试：本地扫描、大小预算截断、pipeline 发送、seq ack 匹配、
 * 流控水位、进度事件序列。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  ALL_SCOPES,
  MAX_FILE_BYTES,
  MAX_INFLIGHT_BYTES,
  MAX_SCOPE_BYTES,
  applyScopeBudget,
  performInitialCacheSync,
  scanLocalFiles,
} from "../src/cache-sync.js";
import type { CacheSyncDeps, CacheSyncEvent } from "../src/cache-sync.js";
import type {
  CacheHandshake,
  CacheManifest,
  CachePush,
  CachePushAck,
  CachePushEntry,
} from "../src/protocol.js";

async function makeTempHome() {
  const home = await mkdtemp(path.join(tmpdir(), "cerelay-home-"));
  return { home, cleanup: () => rm(home, { recursive: true, force: true }) };
}

/**
 * 构造一个可控的 mock deps：
 * - sendMessage：记录所有出站消息
 * - subscribeAcks：保存订阅者，测试用 ackController 主动派发
 * - waitForServerMessage：第一次返回 manifest
 *
 * ackController 提供：
 *   - autoAck = true：每收到一个 push 立即按 seq 回一个 ok=true 的 ack
 *   - autoAck = false：测试手动 ackByLastPush() / ackBySeq() 控制时机
 */
function makeControllableDeps(opts: {
  manifest: CacheManifest;
  homedir: string;
  onProgress?: (event: CacheSyncEvent) => void;
  autoAck?: boolean;
  failByPath?: (path: string) => string | undefined;
}) {
  const sent: Array<CacheHandshake | CachePush> = [];
  const ackSubs = new Set<(ack: CachePushAck) => void>();
  let manifestSent = false;
  const autoAck = opts.autoAck !== false;

  const dispatchAck = (push: CachePush) => {
    const failReason = push.adds[0] && opts.failByPath?.(push.adds[0].path);
    const ack: CachePushAck = {
      type: "cache_push_ack",
      deviceId: opts.manifest.deviceId,
      cwd: opts.manifest.cwd,
      scope: push.scope,
      seq: push.seq,
      ok: !failReason,
      error: failReason,
    };
    for (const sub of Array.from(ackSubs)) sub(ack);
  };

  const deps: CacheSyncDeps = {
    sendMessage: async (msg) => {
      sent.push(msg);
      if (autoAck && msg.type === "cache_push") {
        // 异步派发 ack（next microtask），模拟真实异步路径
        Promise.resolve().then(() => dispatchAck(msg));
      }
    },
    waitForServerMessage: async (predicate) => {
      if (manifestSent) {
        throw new Error("waitForServerMessage 在 pipeline 模式下应只调用一次（manifest）");
      }
      manifestSent = true;
      const parsed = predicate(JSON.stringify(opts.manifest));
      if (parsed === null) throw new Error("predicate 拒绝 manifest");
      return parsed;
    },
    subscribeAcks: (handler) => {
      ackSubs.add(handler);
      return () => {
        ackSubs.delete(handler);
      };
    },
    homedir: opts.homedir,
    onProgress: opts.onProgress,
  };

  return {
    sent,
    deps,
    /** 手动派发与最近一次 push 对应的 ack（autoAck=false 模式） */
    ackLast: (override?: Partial<CachePushAck>) => {
      const lastPush = sent.filter((m): m is CachePush => m.type === "cache_push").at(-1);
      if (!lastPush) throw new Error("没有可 ack 的 push");
      const ack: CachePushAck = {
        type: "cache_push_ack",
        deviceId: opts.manifest.deviceId,
        cwd: opts.manifest.cwd,
        scope: lastPush.scope,
        seq: lastPush.seq,
        ok: true,
        ...override,
      };
      for (const sub of Array.from(ackSubs)) sub(ack);
    },
    /** 按 seq 派发 ack，可乱序 */
    ackBySeq: (seq: number, override?: Partial<CachePushAck>) => {
      const push = sent.find((m): m is CachePush => m.type === "cache_push" && m.seq === seq);
      if (!push) throw new Error(`没有 seq=${seq} 的 push`);
      const ack: CachePushAck = {
        type: "cache_push_ack",
        deviceId: opts.manifest.deviceId,
        cwd: opts.manifest.cwd,
        scope: push.scope,
        seq,
        ok: true,
        ...override,
      };
      for (const sub of Array.from(ackSubs)) sub(ack);
    },
  };
}

// ================== scanLocalFiles ==================

test("scanLocalFiles claude-json 返回空数组当文件不存在", async (t) => {
  const { home, cleanup } = await makeTempHome();
  t.after(cleanup);
  const res = await scanLocalFiles("claude-json", home);
  assert.deepEqual(res, []);
});

test("scanLocalFiles claude-json 找到 ~/.claude.json 返回单条目", async (t) => {
  const { home, cleanup } = await makeTempHome();
  t.after(cleanup);
  await writeFile(path.join(home, ".claude.json"), '{"x":1}', "utf8");
  const res = await scanLocalFiles("claude-json", home);
  assert.equal(res.length, 1);
  assert.equal(res[0].relPath, "");
});

test("scanLocalFiles claude-home 递归遍历 ~/.claude/", async (t) => {
  const { home, cleanup } = await makeTempHome();
  t.after(cleanup);
  const base = path.join(home, ".claude");
  await mkdir(path.join(base, "subdir"), { recursive: true });
  await writeFile(path.join(base, "settings.json"), "{}", "utf8");
  await writeFile(path.join(base, "subdir", "nested.json"), "{}", "utf8");

  const res = await scanLocalFiles("claude-home", home);
  const rels = res.map((r) => r.relPath).sort();
  assert.deepEqual(rels, ["settings.json", "subdir/nested.json"]);
});

// ================== applyScopeBudget ==================

test("applyScopeBudget 单文件 >1MB 保留但标记 skipped，不计入预算", () => {
  const adds: CachePushEntry[] = [
    { path: "big", size: 10 * 1024 * 1024, mtime: 100, sha256: "", skipped: true },
    { path: "a", size: 10, mtime: 50, sha256: "x", content: "Zm9v" },
    { path: "b", size: 10, mtime: 60, sha256: "y", content: "Zm9v" },
  ];
  const { kept, truncatedAdds } = applyScopeBudget(adds);
  assert.equal(truncatedAdds, false);
  assert.equal(kept.length, 3);
});

test("applyScopeBudget 按 mtime 倒序截断至 100MB", () => {
  const entry = (path: string, size: number, mtime: number): CachePushEntry => ({
    path,
    size,
    mtime,
    sha256: "h-" + path,
    content: "x",
  });
  const adds: CachePushEntry[] = [
    entry("oldest", 60 * 1024 * 1024, 1),
    entry("middle", 50 * 1024 * 1024, 2),
    entry("newest", 30 * 1024 * 1024, 3),
  ];
  const { kept, truncatedAdds } = applyScopeBudget(adds);
  assert.equal(truncatedAdds, true);
  const paths = kept.map((e) => e.path).sort();
  assert.deepEqual(paths, ["middle", "newest"]);
});

// ================== pipeline 主流程 ==================

test("performInitialCacheSync 首次同步：每个文件一个 push，且 push.seq 单调递增", async (t) => {
  const { home, cleanup } = await makeTempHome();
  t.after(cleanup);
  const base = path.join(home, ".claude");
  await mkdir(path.join(base, "sub"), { recursive: true });
  await writeFile(path.join(base, "settings.json"), "{}", "utf8");
  await writeFile(path.join(base, "sub", "nested.json"), '{"a":1}', "utf8");
  await writeFile(path.join(home, ".claude.json"), '{"x":1}', "utf8");

  const { sent, deps } = makeControllableDeps({
    homedir: home,
    manifest: {
      type: "cache_manifest",
      deviceId: "d",
      cwd: "/c",
      manifests: {
        "claude-home": { entries: {} },
        "claude-json": { entries: {} },
      },
    },
  });

  const summaries = await performInitialCacheSync(deps, { deviceId: "d", cwd: "/c" });

  assert.equal(sent[0].type, "cache_handshake");
  assert.deepEqual((sent[0] as CacheHandshake).scopes, ALL_SCOPES);

  const pushes = sent.filter((m): m is CachePush => m.type === "cache_push");
  // 三个文件 → 三个 push（一个都不合并）
  assert.equal(pushes.length, 3);
  for (const p of pushes) {
    assert.equal(p.adds.length, 1);
    assert.equal(p.deletes.length, 0);
    assert.ok(typeof p.seq === "number");
  }
  // seq 单调递增（不要求从 1 开始，只要严格递增）
  const seqs = pushes.map((p) => p.seq);
  for (let i = 1; i < seqs.length; i++) {
    assert.ok(seqs[i] > seqs[i - 1], `seq 必须递增 (${seqs[i - 1]} → ${seqs[i]})`);
  }

  const totalPushed = summaries.reduce((acc, s) => acc + s.pushed, 0);
  assert.equal(totalPushed, 3);
  for (const s of summaries) {
    assert.equal(s.error, undefined);
  }
});

test("performInitialCacheSync 完全 unchanged 时不发送任何 cache_push", async (t) => {
  const { home, cleanup } = await makeTempHome();
  t.after(cleanup);
  const base = path.join(home, ".claude");
  await mkdir(base, { recursive: true });
  const settingsPath = path.join(base, "settings.json");
  await writeFile(settingsPath, "{}", "utf8");
  const fixedMtime = 1_700_000_000_000;
  await utimes(settingsPath, new Date(fixedMtime), new Date(fixedMtime));

  const { sent, deps } = makeControllableDeps({
    homedir: home,
    manifest: {
      type: "cache_manifest",
      deviceId: "d",
      cwd: "/c",
      manifests: {
        "claude-home": {
          entries: {
            "settings.json": {
              size: 2,
              mtime: Math.floor(fixedMtime),
              sha256: "dummy",
            },
          },
        },
        "claude-json": { entries: {} },
      },
    },
  });

  await performInitialCacheSync(deps, { deviceId: "d", cwd: "/c" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "cache_handshake");
});

test("performInitialCacheSync 仅有 deletes 时发一次元数据批", async (t) => {
  const { home, cleanup } = await makeTempHome();
  t.after(cleanup);
  await mkdir(path.join(home, ".claude"), { recursive: true });

  const { sent, deps } = makeControllableDeps({
    homedir: home,
    manifest: {
      type: "cache_manifest",
      deviceId: "d",
      cwd: "/c",
      manifests: {
        "claude-home": {
          entries: {
            "stale.json": { size: 10, mtime: 100, sha256: "old" },
          },
        },
        "claude-json": { entries: {} },
      },
    },
  });

  const summaries = await performInitialCacheSync(deps, { deviceId: "d", cwd: "/c" });

  const pushes = sent.filter((m): m is CachePush => m.type === "cache_push");
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].scope, "claude-home");
  assert.deepEqual(pushes[0].deletes, ["stale.json"]);
  assert.equal(pushes[0].adds.length, 0);
  assert.ok(typeof pushes[0].seq === "number");

  const homeSummary = summaries.find((s) => s.scope === "claude-home");
  assert.ok(homeSummary);
  assert.equal(homeSummary.deleted, 1);
});

// ================== onProgress 事件序列 ==================

test("onProgress 事件序列：scan_start → scan_done → upload_start → file_pushed/file_acked* → upload_done", async (t) => {
  const { home, cleanup } = await makeTempHome();
  t.after(cleanup);
  const base = path.join(home, ".claude");
  await mkdir(base, { recursive: true });
  await writeFile(path.join(base, "settings.json"), "{}", "utf8");
  await writeFile(path.join(home, ".claude.json"), '{"x":1}', "utf8");

  const events: CacheSyncEvent[] = [];
  const { deps } = makeControllableDeps({
    homedir: home,
    onProgress: (e) => events.push(e),
    manifest: {
      type: "cache_manifest",
      deviceId: "d",
      cwd: "/c",
      manifests: {
        "claude-home": { entries: {} },
        "claude-json": { entries: {} },
      },
    },
  });

  await performInitialCacheSync(deps, { deviceId: "d", cwd: "/c" });

  const kinds = events.map((e) => e.kind);
  assert.equal(kinds[0], "scan_start");
  assert.equal(kinds[1], "scan_done");
  assert.equal(kinds[2], "upload_start");
  assert.equal(kinds[kinds.length - 1], "upload_done");

  const pushed = events.filter((e) => e.kind === "file_pushed");
  const acked = events.filter((e) => e.kind === "file_acked");
  assert.equal(pushed.length, 2);
  assert.equal(acked.length, 2);

  // 每个 file_pushed 都有对应 seq 的 file_acked
  for (const p of pushed) {
    if (p.kind !== "file_pushed") continue;
    const matched = acked.find((a) => a.kind === "file_acked" && a.seq === p.seq);
    assert.ok(matched, `file_pushed seq=${p.seq} 没有对应的 file_acked`);
  }

  const uploadStart = events.find((e) => e.kind === "upload_start") as Extract<
    CacheSyncEvent,
    { kind: "upload_start" }
  >;
  assert.equal(uploadStart.totalFiles, 2);
});

test("onProgress 在 manifest 等待失败时发 skipped 事件", async (t) => {
  const { home, cleanup } = await makeTempHome();
  t.after(cleanup);

  const events: CacheSyncEvent[] = [];
  const summaries = await performInitialCacheSync(
    {
      sendMessage: async () => {},
      waitForServerMessage: async () => {
        throw new Error("timeout");
      },
      subscribeAcks: () => () => {},
      homedir: home,
      onProgress: (e) => events.push(e),
    },
    { deviceId: "d", cwd: "/c" },
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "skipped");
  for (const s of summaries) {
    assert.ok(s.error);
  }
});

// ================== Pipeline 行为 ==================

test("pipeline：autoAck=false 时不阻塞，可同时有多个 push in-flight", async (t) => {
  const { home, cleanup } = await makeTempHome();
  t.after(cleanup);
  const base = path.join(home, ".claude");
  await mkdir(base, { recursive: true });
  // 三个小文件
  await writeFile(path.join(base, "a.json"), "1", "utf8");
  await writeFile(path.join(base, "b.json"), "2", "utf8");
  await writeFile(path.join(base, "c.json"), "3", "utf8");

  const { sent, deps, ackBySeq } = makeControllableDeps({
    homedir: home,
    autoAck: false,
    manifest: {
      type: "cache_manifest",
      deviceId: "d",
      cwd: "/c",
      manifests: {
        "claude-home": { entries: {} },
        "claude-json": { entries: {} },
      },
    },
  });

  const syncPromise = performInitialCacheSync(deps, { deviceId: "d", cwd: "/c" });

  // 让 IO/microtask 跑一轮，pipeline 应该已经把所有三个 push 都发出去
  await new Promise((r) => setTimeout(r, 30));

  const pushesBeforeAck = sent.filter((m): m is CachePush => m.type === "cache_push");
  // 三个文件 push 全部已发，证明没有等 ack 阻塞
  assert.equal(pushesBeforeAck.length, 3, "pipeline 应在收到 ack 前就把所有 push 发出去");

  // 按 seq 乱序回 ack（中间 → 最后 → 第一个）
  const seqs = pushesBeforeAck.map((p) => p.seq);
  ackBySeq(seqs[1]);
  ackBySeq(seqs[2]);
  ackBySeq(seqs[0]);

  const summaries = await syncPromise;
  const totalPushed = summaries.reduce((acc, s) => acc + s.pushed, 0);
  assert.equal(totalPushed, 3, "三个文件都应被记为已 push");
});

test("pipeline：流控水位生效——in-flight 字节超过水位时暂停发送，ack 释放后继续", async (t) => {
  const { home, cleanup } = await makeTempHome();
  t.after(cleanup);
  const base = path.join(home, ".claude");
  await mkdir(base, { recursive: true });
  // 3 个 ~10KB 文件
  const big = "x".repeat(10 * 1024);
  await writeFile(path.join(base, "a.json"), big, "utf8");
  await writeFile(path.join(base, "b.json"), big, "utf8");
  await writeFile(path.join(base, "c.json"), big, "utf8");

  const { sent, deps, ackBySeq } = makeControllableDeps({
    homedir: home,
    autoAck: false,
    manifest: {
      type: "cache_manifest",
      deviceId: "d",
      cwd: "/c",
      manifests: {
        "claude-home": { entries: {} },
        "claude-json": { entries: {} },
      },
    },
  });

  // 水位线 = 12KB，单文件 10KB → 一次只能 in-flight 一个
  const syncPromise = performInitialCacheSync(deps, {
    deviceId: "d",
    cwd: "/c",
    maxInflightBytes: 12 * 1024,
  });

  await new Promise((r) => setTimeout(r, 30));
  // 仅第一个 push 已发（水位限制）
  let pushes = sent.filter((m): m is CachePush => m.type === "cache_push");
  assert.equal(pushes.length, 1, "水位卡住后续：当前应只有 1 个 in-flight");

  // 释放第一个，第二个应能立刻进 in-flight
  ackBySeq(pushes[0].seq);
  await new Promise((r) => setTimeout(r, 10));
  pushes = sent.filter((m): m is CachePush => m.type === "cache_push");
  assert.equal(pushes.length, 2, "ack 释放后应能发下一个");

  ackBySeq(pushes[1].seq);
  await new Promise((r) => setTimeout(r, 10));
  pushes = sent.filter((m): m is CachePush => m.type === "cache_push");
  assert.equal(pushes.length, 3);

  ackBySeq(pushes[2].seq);
  const summaries = await syncPromise;
  assert.equal(summaries.reduce((acc, s) => acc + s.pushed, 0), 3);
});

test("pipeline：单个文件 ack 失败不影响其他 push 完成", async (t) => {
  const { home, cleanup } = await makeTempHome();
  t.after(cleanup);
  const base = path.join(home, ".claude");
  await mkdir(base, { recursive: true });
  await writeFile(path.join(base, "good.json"), "1", "utf8");
  await writeFile(path.join(base, "bad.json"), "2", "utf8");

  const { deps } = makeControllableDeps({
    homedir: home,
    manifest: {
      type: "cache_manifest",
      deviceId: "d",
      cwd: "/c",
      manifests: {
        "claude-home": { entries: {} },
        "claude-json": { entries: {} },
      },
    },
    failByPath: (p) => (p === "bad.json" ? "simulated server error" : undefined),
  });

  const summaries = await performInitialCacheSync(deps, { deviceId: "d", cwd: "/c" });
  const homeSummary = summaries.find((s) => s.scope === "claude-home");
  assert.ok(homeSummary);
  // 一个成功（good.json）+ 一个失败（bad.json）
  assert.equal(homeSummary.pushed, 1);
  assert.ok(homeSummary.error);
  assert.match(homeSummary.error, /simulated server error/);
});

// ================== 常量 ==================

test("常量值符合需求：单文件 1MB，单 scope 100MB，水位 16MB", () => {
  assert.equal(MAX_FILE_BYTES, 1 * 1024 * 1024);
  assert.equal(MAX_SCOPE_BYTES, 100 * 1024 * 1024);
  assert.equal(MAX_INFLIGHT_BYTES, 16 * 1024 * 1024);
});
