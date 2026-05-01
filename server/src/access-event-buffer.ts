import { createLogger } from "./logger.js";
import type { AccessLedgerRuntime } from "./access-ledger.js";
import type { DaemonControlClient } from "./daemon-control.js";

const log = createLogger("access-event-buffer");

/**
 * 由 server 在收到 client RPC response (或拦截 mutation op) 时派生的访问事件。
 * 9 种 mutation op + 3 种 read-side op (getattr/readdir/read) × 多种 result.
 *
 * 见 spec §4.3 / §8.2.
 */
export type AccessEvent =
  // ===== getattr =====
  | { op: "getattr"; path: string; result: "file" | "dir"; mtime: number }
  | { op: "getattr"; path: string; result: "missing"; shallowestMissingAncestor: string }

  // ===== readdir =====
  | { op: "readdir"; path: string; result: "ok" }
  | { op: "readdir"; path: string; result: "missing"; shallowestMissingAncestor: string }

  // ===== read =====
  // read ok 不写 ledger - CC read 之前必然 getattr 过 (file_present 已写).
  // 这里仅 missing case 进 ledger.
  | { op: "read"; path: string; result: "missing"; shallowestMissingAncestor: string }

  // ===== mutation (CACHE_MUTATING_OPS, file-proxy-manager.ts:1309 全 9 种) =====
  | { op: "write" | "create" | "truncate" | "setattr" | "chmod"; path: string }
  | { op: "mkdir"; path: string }
  | { op: "rmdir" | "unlink"; path: string }
  | { op: "rename"; oldPath: string; newPath: string }

  // ===== server-side cache hit (lastAccessedAt 刷新, 5s 防抖见 §4.4) =====
  | { op: "cache_hit"; path: string };

/**
 * 缓冲一个 session 内的访问事件，flush 时一次性应用到 ledger + 推 daemon。
 *
 * - flush 是唯一 ledger 写入路径; in-memory 期间 daemon 已经实时收到 control msg.
 * - flush 失败 (ledger persist 异常) 不抛, 缓存 events 继续累积下次重试.
 */
export class SessionAccessBuffer {
  private events: AccessEvent[] = [];

  recordEvent(event: AccessEvent): void {
    this.events.push(event);
  }

  size(): number {
    return this.events.length;
  }

  isEmpty(): boolean {
    return this.events.length === 0;
  }

  /**
   * 清空 buffer 后把 events 应用到 ledger。
   *
   * `daemon` 用于 mutation 的实时增量推送 (invalidate_negative_prefix); 注意
   * `putNegative` 的实时推送在 file-proxy-manager 端 RPC 响应时已经发出 (因为 daemon
   * 立即可见的诉求), 这里只在 flush 时把 missing 同步写到 ledger 一次, 不重复推 daemon.
   *
   * mutation 的 `invalidateNegativePrefix` 同样由 file-proxy-manager 在响应时推, 这里
   * flush 仅维护 ledger 状态 (前缀清理 + touchIfPresent)。
   */
  async flush(ledger: AccessLedgerRuntime): Promise<void> {
    if (this.events.length === 0) return;
    const events = this.events;
    this.events = [];

    let getattrFile = 0, getattrDir = 0, getattrMissing = 0;
    let readdirOk = 0, readdirMissing = 0;
    let readMissing = 0;
    let mutations = 0, cacheHits = 0;

    for (const ev of events) {
      const now = Date.now();
      switch (ev.op) {
        case "getattr":
          if (ev.result === "missing") {
            ledger.upsertMissing(ev.shallowestMissingAncestor, now);
            getattrMissing++;
          } else if (ev.result === "file") {
            ledger.upsertFilePresent(ev.path, now);
            getattrFile++;
          } else {
            ledger.upsertDirPresent(ev.path, now, false);
            getattrDir++;
          }
          break;

        case "readdir":
          if (ev.result === "ok") {
            ledger.upsertDirPresent(ev.path, now, true);
            readdirOk++;
          } else {
            ledger.upsertMissing(ev.shallowestMissingAncestor, now);
            readdirMissing++;
          }
          break;

        case "read":
          // 仅 missing 写 ledger; ok 路径不进事件流 (read ok 之前必然 getattr 过)
          ledger.upsertMissing(ev.shallowestMissingAncestor, now);
          readMissing++;
          break;

        case "write":
        case "create":
        case "truncate":
        case "setattr":
        case "chmod":
          ledger.invalidateMissingPrefixes(ev.path);
          ledger.touchIfPresent(ev.path, now);
          mutations++;
          break;

        case "mkdir":
          ledger.invalidateMissingPrefixes(ev.path);
          ledger.upsertDirPresent(ev.path, now, false);
          mutations++;
          break;

        case "unlink":
          ledger.removeFilePresent(ev.path);
          mutations++;
          break;

        case "rmdir":
          ledger.removeDirSubtree(ev.path);
          mutations++;
          break;

        case "rename":
          ledger.renameSubtree(ev.oldPath, ev.newPath);
          ledger.invalidateMissingPrefixes(ev.newPath);
          mutations++;
          break;

        case "cache_hit":
          // 仅刷 lastAccessedAt 防 aging 误清 (Codex 新 F1)
          ledger.touchIfPresent(ev.path, now);
          cacheHits++;
          break;
      }
    }

    ledger.bumpRevision();

    log.debug("flushed access events to ledger", {
      total: events.length,
      getattrFile,
      getattrDir,
      getattrMissing,
      readdirOk,
      readdirMissing,
      readMissing,
      mutations,
      cacheHits,
    });
  }
}
