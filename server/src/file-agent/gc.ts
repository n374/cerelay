// FileAgent GC：周期性清理过期 entries 与 orphan blob（plan §3.2 + §8 Task 7）。
//
// 算法：
//   1. ttl.collectExpired() 取出过期 path 列表（不从 ttl 表 drop）
//   2. 跳过当前有 in-flight op 的 path（避免别人复用过期穿透结果；ttl 条目保留，下次 GC 再处理）
//   3. 剩下的 path 通过 scope-adapter 转 scope+rel，store.removeEntry 删 manifest entry
//   4. ttl.drop(path) 移除 ttl 条目
//   5. store.gcOrphanBlobs 清 orphan blob（mark-and-sweep）

import type { ClientCacheStore } from "./store.js";
import type { ScopeAdapter } from "./scope-adapter.js";
import type { TtlTable } from "./ttl-table.js";
import type { InflightMap } from "./inflight.js";
import { inflightKey } from "./inflight.js";
import { createLogger } from "../logger.js";

const log = createLogger("file-agent.gc");

export const DEFAULT_GC_INTERVAL_MS = 60_000;

export interface GcRunnerOptions {
  deviceId: string;
  store: ClientCacheStore;
  scopeAdapter: ScopeAdapter;
  ttl: TtlTable;
  inflight: InflightMap;
  intervalMs?: number;
}

export interface GcRunResult {
  evicted: number;
  skippedInflight: number;
  deletedBlobs: number;
  durationMs: number;
}

export class GcRunner {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly intervalMs: number;

  constructor(private readonly opts: GcRunnerOptions) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_GC_INTERVAL_MS;
  }

  /** 启动周期性 GC。重复调用 idempotent。 */
  start(): void {
    if (this.intervalHandle) return;
    this.intervalHandle = setInterval(() => {
      void this.runOnce().catch((e) => {
        log.warn("GC runOnce 出错", { err: e });
      });
    }, this.intervalMs);
    // 不阻塞 process exit
    if (typeof this.intervalHandle.unref === "function") {
      this.intervalHandle.unref();
    }
  }

  /** 停止周期 GC。 */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * 单次 GC。可独立调用（测试 / 手动触发）。
   * 重入保护：上次未完成时本次直接返回 0（避免并发跑 manifest 锁互相干扰）。
   */
  async runOnce(): Promise<GcRunResult> {
    if (this.running) {
      return { evicted: 0, skippedInflight: 0, deletedBlobs: 0, durationMs: 0 };
    }
    this.running = true;
    const startedAt = Date.now();
    try {
      const expired = this.opts.ttl.collectExpired();
      let evicted = 0;
      let skippedInflight = 0;

      for (const absPath of expired) {
        if (this.hasAnyInflight(absPath)) {
          skippedInflight += 1;
          continue;
        }
        const sr = this.opts.scopeAdapter.toScopeRel(absPath);
        if (sr) {
          await this.opts.store.removeEntry(this.opts.deviceId, sr.scope, sr.relPath);
        }
        this.opts.ttl.drop(absPath);
        evicted += 1;
      }

      // 清 orphan blob
      const blobResult = await this.opts.store.gcOrphanBlobs(this.opts.deviceId);

      const durationMs = Date.now() - startedAt;
      if (evicted > 0 || skippedInflight > 0 || blobResult.deleted > 0) {
        log.debug("GC 执行完成", {
          deviceId: this.opts.deviceId,
          evicted,
          skippedInflight,
          deletedBlobs: blobResult.deleted,
          durationMs,
        } as Record<string, unknown>);
      }
      return {
        evicted,
        skippedInflight,
        deletedBlobs: blobResult.deleted,
        durationMs,
      };
    } finally {
      this.running = false;
    }
  }

  private hasAnyInflight(absPath: string): boolean {
    return (
      this.opts.inflight.has(inflightKey("read", absPath)) ||
      this.opts.inflight.has(inflightKey("stat", absPath)) ||
      this.opts.inflight.has(inflightKey("readdir", absPath))
    );
  }
}
