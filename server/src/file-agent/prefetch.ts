// FileAgent.prefetch 实现：批量预热。
//
// 设计要点（plan §3.1 + §8 Task 6）：
//   - 输入：PrefetchItem[]（混合 file/dir-recursive/dir-shallow）+ ttlMs
//   - 输出：PrefetchResult { fetched, alreadyHot, missing, failed[], durationMs }
//   - 内部 bounded concurrency（默认 16）；单项失败不阻塞其他
//   - 与 FileAgent 命中路径共享 store + inflight，避免重复穿透
//
// 不返回内容：调用方只关心"是否预热到了"，不关心具体 buffer。

import path from "node:path";
import type { ClientCacheStore } from "./store.js";
import type { ScopeAdapter } from "./scope-adapter.js";
import type { TtlTable } from "./ttl-table.js";
import type { InflightMap } from "./inflight.js";
import { inflightKey } from "./inflight.js";
import type {
  FileAgentFetcher,
  PrefetchItem,
  PrefetchResult,
} from "./types.js";

export const DEFAULT_PREFETCH_CONCURRENCY = 16;
export const DEFAULT_PREFETCH_MAX_DEPTH = 8;

export interface PrefetchOptions {
  deviceId: string;
  store: ClientCacheStore;
  scopeAdapter: ScopeAdapter;
  ttl: TtlTable;
  inflight: InflightMap;
  fetcher: FileAgentFetcher | null;
  /** Bounded concurrency。默认 16。 */
  concurrency?: number;
  /** dir-recursive 最大递归深度。默认 8（plan §10.2 决策）。 */
  maxDepth?: number;
  now?: () => number;
}

/**
 * 把 PrefetchItem[] 平铺为 file 列表（dir 项通过 fetcher.fetchReaddir 展开）。
 * 失败的 dir 展开记入 failed[]，不抛错。
 */
async function flattenItems(
  items: PrefetchItem[],
  fetcher: FileAgentFetcher | null,
  maxDepth: number,
  failed: Array<{ absPath: string; reason: string }>,
): Promise<string[]> {
  const filePaths: string[] = [];
  const seen = new Set<string>();

  async function walk(absPath: string, kind: PrefetchItem["kind"], depth: number): Promise<void> {
    if (depth > maxDepth) {
      failed.push({ absPath, reason: `exceeded maxDepth=${maxDepth}` });
      return;
    }
    if (kind === "file") {
      if (!seen.has(absPath)) {
        seen.add(absPath);
        filePaths.push(absPath);
      }
      return;
    }
    // dir-recursive / dir-shallow：调 fetchReaddir 展开
    if (!fetcher) {
      failed.push({
        absPath,
        reason: "fetcher 未配置，无法展开目录",
      });
      return;
    }
    let dir;
    try {
      dir = await fetcher.fetchReaddir(absPath);
    } catch (e) {
      failed.push({
        absPath,
        reason: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    if (dir.kind === "missing") return;
    for (const name of dir.entries) {
      const child = path.join(absPath, name);
      // dir-shallow 的子项当作 file 处理（不下钻）；dir-recursive 把子项当 dir-recursive 继续展开
      const childKind: PrefetchItem["kind"] = kind === "dir-recursive" ? "dir-recursive" : "file";
      // 但 dir-recursive 子项可能是 file 或 dir，无法分辨——我们当作"试探性 dir-recursive"，
      // fetchReaddir 失败时退化为 file（记 failed 但保留 file 处理）。
      // 简化：dir-recursive 模式下都尝试 fetchReaddir；如果 fetchReaddir 返回 missing 就当 file
      if (kind === "dir-recursive") {
        // 先当 dir-recursive 试探性展开；若 fetchReaddir 返 missing 表示是文件
        const subFailed: Array<{ absPath: string; reason: string }> = [];
        let probed;
        try {
          probed = await fetcher.fetchReaddir(child);
        } catch {
          // 不知是文件还是错误——保守当文件处理
          if (!seen.has(child)) {
            seen.add(child);
            filePaths.push(child);
          }
          continue;
        }
        if (probed.kind === "dir") {
          await walk(child, "dir-recursive", depth + 1);
        } else {
          if (!seen.has(child)) {
            seen.add(child);
            filePaths.push(child);
          }
        }
      } else {
        // dir-shallow：所有子项当 file
        if (!seen.has(child)) {
          seen.add(child);
          filePaths.push(child);
        }
      }
    }
  }

  for (const item of items) {
    await walk(item.absPath, item.kind, 0);
  }
  return filePaths;
}

/**
 * 用 bounded concurrency 处理 file 列表，每条调 store hit 检查 / fetcher.fetchFile。
 */
async function runFiles(
  filePaths: string[],
  opts: PrefetchOptions & {
    failed: Array<{ absPath: string; reason: string }>;
  },
  ttlMs: number,
): Promise<{ fetched: number; alreadyHot: number; missing: number }> {
  const counters = { fetched: 0, alreadyHot: 0, missing: 0 };
  const concurrency = opts.concurrency ?? DEFAULT_PREFETCH_CONCURRENCY;

  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= filePaths.length) return;
      const absPath = filePaths[i];
      try {
        await processOne(absPath);
      } catch (e) {
        opts.failed.push({
          absPath,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  async function processOne(absPath: string): Promise<void> {
    const sr = opts.scopeAdapter.toScopeRel(absPath);
    if (sr) {
      // 检查 store 是否已有 entry
      const entry = await opts.store.lookupEntry(opts.deviceId, sr.scope, sr.relPath);
      if (entry) {
        opts.ttl.bump(absPath, ttlMs);
        counters.alreadyHot += 1;
        return;
      }
    }
    // 不在 cache：调 fetcher 穿透（与 FileAgent.read 共享 inflight）
    if (!opts.fetcher) {
      throw new Error("fetcher 未配置，无法预热未 cache 的 path");
    }
    const result = await opts.inflight.dedupe(
      inflightKey("read", absPath),
      () => opts.fetcher!.fetchFile(absPath),
    );
    opts.ttl.bump(absPath, ttlMs);
    if (result.kind === "missing") {
      counters.missing += 1;
    } else {
      counters.fetched += 1;
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, filePaths.length || 1) }, () => worker()),
  );
  return counters;
}

/**
 * Prefetch 主入口。FileAgent.prefetch 调用此函数。
 */
export async function runPrefetch(
  items: PrefetchItem[],
  ttlMs: number,
  opts: PrefetchOptions,
): Promise<PrefetchResult> {
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();
  const failed: Array<{ absPath: string; reason: string }> = [];

  if (items.length === 0) {
    return {
      fetched: 0,
      alreadyHot: 0,
      missing: 0,
      failed: [],
      durationMs: 0,
    };
  }

  const maxDepth = opts.maxDepth ?? DEFAULT_PREFETCH_MAX_DEPTH;
  const filePaths = await flattenItems(items, opts.fetcher, maxDepth, failed);

  const result = await runFiles(filePaths, { ...opts, failed }, ttlMs);

  return {
    fetched: result.fetched,
    alreadyHot: result.alreadyHot,
    missing: result.missing,
    failed,
    durationMs: now() - startedAt,
  };
}
