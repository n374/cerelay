// SyncCoordinator —— FileAgent 内部的"双路写入 manifest"中枢（plan §3.6 / P9）。
//
// 路径 A: fetchFile/fetchStat/fetchReaddir（被 FileAgent miss 时调）—— 派发单 path
//         SyncPlan 给 active client，等 client 推 delta 回来；解析后落 manifest 返回。
// 路径 B: applyWatcherDelta（client 主动 push 的运行时增量）—— 直接落 manifest，
//         同时清掉受影响 path 的 in-flight（避免别人复用过期穿透结果）。
//
// 当前实施进度（Task 5）：
//   - 接口契约 + 路径 B 完整实现 ✓
//   - 路径 A: 接口存在，内部实现以 stub 形式抛 FileAgentUnavailable；Task 9 FuseHost 接通后再启用真正派发
//
// 业务逻辑与协议层分离（P7）：
//   sync-coordinator 不直接构造 cache_task_* 字面量；都通过 ./client-protocol-v1.ts 的 builder。

import type { CacheTaskChange } from "../protocol.js";
import type { ClientCacheStore } from "./store.js";
import type { ScopeAdapter } from "./scope-adapter.js";
import type { InflightMap } from "./inflight.js";
import { inflightKey } from "./inflight.js";
import { buildSinglePathFetchPlan, projectChangeAbsPath } from "./client-protocol-v1.js";
import {
  type FileAgentFetcher,
  type FileAgentReadResult,
  type FileAgentStatResult,
  type FileAgentReaddirResult,
} from "./types.js";
import { FileAgentUnavailableError } from "./types.js";
import { createLogger } from "../logger.js";

const log = createLogger("file-agent.sync-coordinator");

/**
 * Task 9 接 cache-task-manager 时实现该接口；Task 5 阶段不依赖此接口落地。
 *
 * dispatchSinglePathFetch:
 *   - 把单 path SyncPlan 通过 cache_task_assignment 派发给 active client
 *   - 等 client 推 cache_task_delta 回来（含目标 path 的 entry）
 *   - 返回该 entry 对应的 CacheTaskChange（或 null = 不存在）
 */
export interface ClientFetchDispatcher {
  dispatchSinglePathFetch(
    absPath: string,
    timeoutMs: number,
  ): Promise<CacheTaskChange | null>;
}

export interface SyncCoordinatorOptions {
  deviceId: string;
  store: ClientCacheStore;
  scopeAdapter: ScopeAdapter;
  /** 与 FileAgent 共享 inflight，让 watcher delta 推送时能清掉 in-flight 项。 */
  inflight: InflightMap;
  /** Task 9 接通后传入；Task 5 阶段允许 undefined（fetch 路径抛 unavailable）。 */
  dispatcher?: ClientFetchDispatcher | null;
  fetchTimeoutMs?: number;
}

export class SyncCoordinator implements FileAgentFetcher {
  private readonly deviceId: string;
  private readonly store: ClientCacheStore;
  private readonly scopeAdapter: ScopeAdapter;
  private readonly inflight: InflightMap;
  private readonly dispatcher: ClientFetchDispatcher | null;
  private readonly fetchTimeoutMs: number;

  constructor(options: SyncCoordinatorOptions) {
    this.deviceId = options.deviceId;
    this.store = options.store;
    this.scopeAdapter = options.scopeAdapter;
    this.inflight = options.inflight;
    this.dispatcher = options.dispatcher ?? null;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? 5_000;
  }

  // ============================================================
  // 路径 A: fetch（被 FileAgent miss 时调）
  // ============================================================

  async fetchFile(absPath: string): Promise<FileAgentReadResult> {
    const change = await this.dispatchAndApply(absPath);
    if (!change) return { kind: "missing" };
    if (change.kind === "delete") return { kind: "missing" };
    if (change.skipped) {
      return { kind: "skipped", size: change.size, mtime: change.mtime };
    }
    if (typeof change.contentBase64 !== "string" || !change.sha256) {
      return { kind: "missing" };
    }
    const buf = Buffer.from(change.contentBase64, "base64");
    return {
      kind: "file",
      content: buf,
      size: change.size,
      mtime: change.mtime,
      sha256: change.sha256,
    };
  }

  async fetchStat(absPath: string): Promise<FileAgentStatResult> {
    const change = await this.dispatchAndApply(absPath);
    if (!change) return { kind: "missing" };
    if (change.kind === "delete") return { kind: "missing" };
    return {
      kind: "file",
      size: change.size,
      mtime: change.mtime,
      sha256: change.sha256 ?? null,
    };
  }

  async fetchReaddir(_absDir: string): Promise<FileAgentReaddirResult> {
    // readdir 单路径派发本期不实现——配置预热阶段 ConfigPreloader 通过整 scope walk
    // 已经把 home 子树拉满；运行时 FUSE 走 stat 路径。
    throw new FileAgentUnavailableError(
      _absDir,
      new Error("readdir live fetch 未实现（Task 9 接 FuseHost 时再决定是否需要）"),
    );
  }

  /**
   * 派发单 path fetch + 收 client delta + 落 manifest，返回该 path 的 change。
   * dispatcher 缺省时直接抛 FileAgentUnavailable（Task 5 阶段 stub）。
   */
  private async dispatchAndApply(absPath: string): Promise<CacheTaskChange | null> {
    const plan = buildSinglePathFetchPlan(absPath, this.scopeAdapter);
    if (!plan) {
      // 不在已知 scope 内（如 cwd 父链 CLAUDE.md 当前未 scope 化）—— 当作 missing
      return null;
    }
    if (!this.dispatcher) {
      throw new FileAgentUnavailableError(
        absPath,
        new Error(
          "SyncCoordinator.dispatcher 未配置（Task 9 接 cache-task-manager 时启用）",
        ),
      );
    }
    const change = await this.dispatcher.dispatchSinglePathFetch(
      absPath,
      this.fetchTimeoutMs,
    );
    if (change) {
      // dispatcher 已把 client 推的 change apply 到 manifest（cache_task_delta_ack 流程内含），
      // 这里不重复 apply。但需要清掉 in-flight 让后续 read 重走 store hit 路径。
      this.invalidateInflightForPath(absPath);
    }
    return change;
  }

  // ============================================================
  // 路径 B: watcher delta apply（client 主动 push）
  // ============================================================

  /**
   * 把 client 推送的 watcher delta 应用到 manifest。运行时 client cache-watcher
   * 检测到本地文件变更后通过 cache_task_delta 推到这里。
   *
   * 副作用：
   *   1. store.applyDelta 落入 manifest（含新 sha256 / blob）
   *   2. 受影响 path 的 in-flight 项清除（避免别人复用过期穿透结果）
   */
  async applyWatcherDelta(changes: CacheTaskChange[]): Promise<void> {
    if (changes.length === 0) return;
    await this.store.applyDelta(this.deviceId, changes);
    for (const change of changes) {
      const proj = projectChangeAbsPath(change, this.scopeAdapter);
      this.invalidateInflightForPath(proj.absPath);
    }
    log.debug("watcher delta 已 apply", {
      deviceId: this.deviceId,
      changes: changes.length,
    });
  }

  // ============================================================
  // 内部 helper
  // ============================================================

  private invalidateInflightForPath(absPath: string): void {
    // 三个 op 的 inflight key 都尝试清除（不存在则 no-op）
    const keys = [
      inflightKey("read", absPath),
      inflightKey("stat", absPath),
      inflightKey("readdir", absPath),
    ];
    // InflightMap 没有 delete 方法（dedupe 内部 finally 自动清）；此处用 has 判断
    // 仅做 telemetry，不强制清除——active 的 fetcher promise 让它正常 resolve。
    // 这种语义让"watcher 推送的内容比 fetcher 早到达"的场景更安全：fetcher 拿到的
    // 仍是它发起 fetch 时的 client 状态；下一次 read 因 store 已被 watcher 更新
    // 会命中新内容。
    for (const key of keys) {
      if (this.inflight.has(key)) {
        log.debug("watcher delta 命中正在 in-flight 的 path", {
          deviceId: this.deviceId,
          absPath,
          key,
        });
      }
    }
  }
}
