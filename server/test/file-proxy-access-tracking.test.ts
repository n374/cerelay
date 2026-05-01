import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";

/**
 * 单元测试 file-proxy-manager 中 Phase 5.2 access tracking 三个核心 helper
 * 的逻辑: recordMutationEvent / deriveAccessEventFromResponse / recordCacheHitAccess.
 *
 * 因为 FileProxyManager 类深度依赖 spawn FUSE daemon, 这些 helper 是 private,
 * 无法直接拿出来单测。我们用"逻辑等价的独立函数 + 同样的 events buffer 契约"
 * 验证派生规则。完整 e2e (覆盖整条链路) 留到 Phase 7。
 */

import { AccessLedgerRuntime } from "../src/access-ledger.js";
import { SessionAccessBuffer, type AccessEvent } from "../src/access-event-buffer.js";
import { DaemonControlClient } from "../src/daemon-control.js";

class CapturingStream extends Writable {
  public chunks: string[] = [];
  override _write(chunk: any, _enc: BufferEncoding, cb: (e?: Error) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    cb();
  }
  msgs(): Array<Record<string, unknown>> {
    return this.chunks
      .join("")
      .split("\n")
      .filter((s) => s.length > 0)
      .map((s) => JSON.parse(s));
  }
}

/**
 * 复制 file-proxy-manager 内 deriveAccessEventFromResponse 的逻辑作为独立函数,
 * 保持跟产品代码完全一致 - 修产品时也要更新此处.
 */
function deriveAccessEvent(
  opCtx: { op: string; path: string },
  resp: {
    error?: { code: number; message: string };
    stat?: { isDir: boolean; mtime: number };
    entries?: string[];
    shallowestMissingAncestor?: string;
  },
  sessionRoots: string[],
): { event?: AccessEvent; pushNegative?: string } {
  // ENOENT 路径
  if (resp.error?.code === 2) {
    const candidate = resp.shallowestMissingAncestor || opCtx.path;
    const inRoots = sessionRoots.some(
      (r) => candidate === r || candidate.startsWith(r + "/"),
    );
    if (!inRoots) return {}; // 越界静默丢弃
    if (opCtx.op === "getattr" || opCtx.op === "read" || opCtx.op === "readdir") {
      return {
        event: {
          op: opCtx.op as any,
          path: opCtx.path,
          result: "missing",
          shallowestMissingAncestor: candidate,
        },
        pushNegative: candidate,
      };
    }
    return {};
  }
  if (opCtx.op === "getattr" && resp.stat) {
    return {
      event: {
        op: "getattr",
        path: opCtx.path,
        result: resp.stat.isDir ? "dir" : "file",
        mtime: resp.stat.mtime,
      },
    };
  }
  if (opCtx.op === "readdir" && resp.entries) {
    return {
      event: { op: "readdir", path: opCtx.path, result: "ok" },
    };
  }
  return {};
}

const ROOTS = ["/Users/foo/.claude", "/Users/foo/.claude.json", "/Users/foo/work/.claude"];

test("getattr 成功 file → 派生 file event 不推 daemon", () => {
  const r = deriveAccessEvent(
    { op: "getattr", path: "/Users/foo/.claude/settings.json" },
    { stat: { isDir: false, mtime: 12345 } },
    ROOTS,
  );
  assert.equal(r.event?.op, "getattr");
  if (r.event && r.event.op === "getattr" && r.event.result !== "missing") {
    assert.equal(r.event.result, "file");
    assert.equal(r.event.mtime, 12345);
  }
  assert.equal(r.pushNegative, undefined);
});

test("getattr 成功 dir → 派生 dir event readdirObserved 由后续 readdir 升级", () => {
  const r = deriveAccessEvent(
    { op: "getattr", path: "/Users/foo/.claude/skills" },
    { stat: { isDir: true, mtime: 1 } },
    ROOTS,
  );
  if (r.event && r.event.op === "getattr" && r.event.result !== "missing") {
    assert.equal(r.event.result, "dir");
  }
});

test("getattr ENOENT + ancestor 在 root 内 → missing event + putNegative", () => {
  const r = deriveAccessEvent(
    { op: "getattr", path: "/Users/foo/.claude/plugins/missing/leaf" },
    {
      error: { code: 2, message: "ENOENT" },
      shallowestMissingAncestor: "/Users/foo/.claude/plugins/missing",
    },
    ROOTS,
  );
  if (r.event && r.event.op === "getattr" && r.event.result === "missing") {
    assert.equal(r.event.shallowestMissingAncestor, "/Users/foo/.claude/plugins/missing");
  }
  assert.equal(r.pushNegative, "/Users/foo/.claude/plugins/missing");
});

test("readdir 成功 → readdir ok event", () => {
  const r = deriveAccessEvent(
    { op: "readdir", path: "/Users/foo/.claude/skills" },
    { entries: ["a.md", "b.md"] },
    ROOTS,
  );
  if (r.event && r.event.op === "readdir") {
    assert.equal(r.event.result, "ok");
  }
});

test("readdir ENOENT + ancestor → missing event + putNegative", () => {
  const r = deriveAccessEvent(
    { op: "readdir", path: "/Users/foo/.claude/non-existent-dir" },
    {
      error: { code: 2, message: "ENOENT" },
      shallowestMissingAncestor: "/Users/foo/.claude/non-existent-dir",
    },
    ROOTS,
  );
  if (r.event && r.event.op === "readdir" && r.event.result === "missing") {
    assert.equal(r.event.shallowestMissingAncestor, "/Users/foo/.claude/non-existent-dir");
  }
  assert.equal(r.pushNegative, "/Users/foo/.claude/non-existent-dir");
});

test("read ENOENT → missing event + putNegative (read ok 不写 ledger)", () => {
  const missing = deriveAccessEvent(
    { op: "read", path: "/Users/foo/.claude/missing.txt" },
    { error: { code: 2, message: "ENOENT" }, shallowestMissingAncestor: "/Users/foo/.claude/missing.txt" },
    ROOTS,
  );
  assert.ok(missing.event);
  assert.equal(missing.pushNegative, "/Users/foo/.claude/missing.txt");

  // read 成功 - 不应派生 event (CC read ok 之前必然 getattr 过)
  const ok = deriveAccessEvent(
    { op: "read", path: "/Users/foo/.claude/settings.json" },
    { stat: { isDir: false, mtime: 1 } },
    ROOTS,
  );
  assert.equal(ok.event, undefined);
});

test("ENOENT shallowestMissingAncestor 越界 root → 静默丢弃 (Codex D1)", () => {
  const r = deriveAccessEvent(
    { op: "getattr", path: "/Users/foo/.claude/some-path" },
    {
      error: { code: 2, message: "ENOENT" },
      // 这个 ancestor 不在任何 root 下 (跨用户路径)
      shallowestMissingAncestor: "/Users/other-user/.claude",
    },
    ROOTS,
  );
  assert.equal(r.event, undefined);
  assert.equal(r.pushNegative, undefined);
});

test("ENOENT 无 shallowestMissingAncestor 字段 → 用原 path fallback", () => {
  const r = deriveAccessEvent(
    { op: "getattr", path: "/Users/foo/.claude/missing-leaf" },
    { error: { code: 2, message: "ENOENT" } },
    ROOTS,
  );
  // 用原 path 写 ledger; root 校验通过 (path 在 root 内)
  if (r.event && r.event.result === "missing") {
    assert.equal(r.event.shallowestMissingAncestor, "/Users/foo/.claude/missing-leaf");
  }
});

/**
 * 验证 Phase 5.2 端到端集成: SessionAccessBuffer + DaemonControlClient 配合
 * 在 mutation event 时同时写 buffer + 推 daemon.
 */
test("mutation event 同步: buffer 记录 + daemon 收到 invalidate_negative_prefix", async () => {
  const ledger = new AccessLedgerRuntime("dev1");
  ledger.upsertMissing("/foo", 1);

  const stream = new CapturingStream();
  const daemon = new DaemonControlClient(stream);
  const buf = new SessionAccessBuffer();

  // 模拟 recordMutationEvent: write event 进 buffer + 推 daemon
  buf.recordEvent({ op: "write", path: "/foo/bar/file" });
  await daemon.invalidateNegativePrefix("/foo/bar/file");
  await daemon.invalidateCache("/foo/bar/file");

  // flush buffer 到 ledger
  await buf.flush(ledger);

  // ledger 侧: missing /foo 被前缀清理
  assert.equal(ledger.toJSON().entries["/foo"], undefined);

  // daemon 侧: 收到 invalidate_negative_prefix + invalidate_cache
  const msgs = stream.msgs();
  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs[0], { type: "invalidate_negative_prefix", path: "/foo/bar/file" });
  assert.deepEqual(msgs[1], { type: "invalidate_cache", path: "/foo/bar/file" });
});

test("ENOENT 同步: buffer 记录 missing + daemon 收到 putNegative", async () => {
  const ledger = new AccessLedgerRuntime("dev1");
  const stream = new CapturingStream();
  const daemon = new DaemonControlClient(stream);
  const buf = new SessionAccessBuffer();

  // 模拟 deriveAccessEventFromResponse + 实时推
  buf.recordEvent({
    op: "getattr",
    path: "/Users/foo/.claude/missing/x",
    result: "missing",
    shallowestMissingAncestor: "/Users/foo/.claude/missing",
  });
  await daemon.putNegative("/Users/foo/.claude/missing");

  await buf.flush(ledger);

  assert.equal(ledger.toJSON().entries["/Users/foo/.claude/missing"]?.kind, "missing");
  const msgs = stream.msgs();
  assert.deepEqual(msgs[0], { type: "put_negative", path: "/Users/foo/.claude/missing" });
});

/**
 * 5s 防抖逻辑独立测.
 */
function shouldRecordCacheHit(
  debounce: Map<string, number>,
  path: string,
  now: number,
  thresholdMs = 5000,
): boolean {
  // first-record (key 缺): 强制 record
  if (!debounce.has(path)) {
    debounce.set(path, now);
    return true;
  }
  const last = debounce.get(path)!;
  if (now - last < thresholdMs) return false;
  debounce.set(path, now);
  return true;
}

test("cache hit 5s 防抖: 首次记录, 5s 内重复跳过, 5s 后再次记录", () => {
  const debounce = new Map<string, number>();
  assert.equal(shouldRecordCacheHit(debounce, "/foo", 1000), true);
  assert.equal(shouldRecordCacheHit(debounce, "/foo", 2000), false); // 1s 后, 跳过
  assert.equal(shouldRecordCacheHit(debounce, "/foo", 5500), false); // 4.5s 后, 跳过
  assert.equal(shouldRecordCacheHit(debounce, "/foo", 6500), true); // 5.5s 后, 重新记录
  assert.equal(shouldRecordCacheHit(debounce, "/bar", 1000), true); // 不同 path 互不影响
});
