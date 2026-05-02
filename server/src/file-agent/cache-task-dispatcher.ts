// CacheTaskClientDispatcher：把 cache-task-manager 包装成 FileAgent 的 ClientFetchDispatcher。
//
// 当前实现（plan §9.1 wiring 渐进事项）：
//   - 通过 store.lookupEntry 查 manifest（active client 之前已通过 cache_task_delta 推送过的内容）
//   - 命中 → 把 entry 转为 CacheTaskChange 返回（含 contentBase64 等）；让 SyncCoordinator
//     的 fetchFile/fetchStat 流程能拿到结果
//   - miss → 返回 null（FileAgent.read 在 SyncCoordinator 里得到 missing 结果，不抛错）
//
// 这是 SyncCoordinator dispatcher 接口的"被动 lookup"实现——active client 已经主动推过
// 的内容能被 FileAgent.read 命中；**主动 fetch 单 path** 仍是 plan §9.1 列出的 follow-up
// （要新增 cache_task_assignment 微型 SyncPlan 派发或新协议消息），不在本期。

import type { CacheTaskChange } from "../protocol.js";
import type { ClientCacheStore } from "./store.js";
import type { ScopeAdapter } from "./scope-adapter.js";
import type { ClientFetchDispatcher } from "./sync-coordinator.js";
import { createLogger } from "../logger.js";

const log = createLogger("file-agent.cache-task-dispatcher");

export interface CacheTaskClientDispatcherOptions {
  deviceId: string;
  store: ClientCacheStore;
  scopeAdapter: ScopeAdapter;
}

export class CacheTaskClientDispatcher implements ClientFetchDispatcher {
  private readonly deviceId: string;
  private readonly store: ClientCacheStore;
  private readonly scopeAdapter: ScopeAdapter;

  constructor(opts: CacheTaskClientDispatcherOptions) {
    this.deviceId = opts.deviceId;
    this.store = opts.store;
    this.scopeAdapter = opts.scopeAdapter;
  }

  /**
   * 当前实现策略：
   *   - 查 manifest：如果 active client 已通过 watcher delta / 启动期同步推过该 path，
   *     就能命中
   *   - miss → 返 null（不主动派发单 path SyncPlan；那是 follow-up）
   */
  async dispatchSinglePathFetch(
    absPath: string,
    _timeoutMs: number,
  ): Promise<CacheTaskChange | null> {
    const sr = this.scopeAdapter.toScopeRel(absPath);
    if (!sr) return null;

    const entry = await this.store.lookupEntry(this.deviceId, sr.scope, sr.relPath);
    if (!entry) {
      log.debug("dispatcher: store miss（active client 未推过该 path）", {
        deviceId: this.deviceId,
        absPath,
      } as Record<string, unknown>);
      return null;
    }
    if (entry.skipped) {
      return {
        kind: "upsert",
        scope: sr.scope,
        path: sr.relPath,
        size: entry.size,
        mtime: entry.mtime,
        sha256: entry.sha256,
        skipped: true,
      };
    }
    if (!entry.sha256) return null;

    const buf = this.store.readBlobSync(this.deviceId, entry.sha256);
    if (!buf) return null;
    return {
      kind: "upsert",
      scope: sr.scope,
      path: sr.relPath,
      size: entry.size,
      mtime: entry.mtime,
      sha256: entry.sha256,
      contentBase64: buf.toString("base64"),
    };
  }
}
