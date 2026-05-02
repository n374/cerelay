// FileAgent 入口（per-device 单例）。
//
// 当前实施进度（plan 2026-05-02-file-agent-and-config-preloader.md）：
//   - Task 1: 接口骨架 ✓
//   - Task 2: store + scope-adapter，read/stat 命中路径走 store ✓
//   - Task 3: TTL 表（命中时 bump expiresAt）✓
//   - Task 4: in-flight 去重 + fetcher（miss 阻塞穿透）✓
//   - Task 5+ 后续: sync-coordinator 实际接 client 协议 / prefetch / gc

import type { ClientCacheStore } from "./store.js";
import { ScopeAdapter } from "./scope-adapter.js";
import { TtlTable } from "./ttl-table.js";
import { InflightMap, inflightKey } from "./inflight.js";
import { GcRunner, DEFAULT_GC_INTERVAL_MS, type GcRunResult } from "./gc.js";
import type {
  FileAgentReadResult,
  FileAgentStatResult,
  FileAgentReaddirResult,
  FileAgentFetcher,
  PrefetchItem,
  PrefetchResult,
} from "./types.js";

export interface FileAgentOptions {
  /** Device 唯一标识（plan §2 P6）。 */
  deviceId: string;
  /** Client 侧 home 目录（用于 absPath ↔ scope+rel 适配）。 */
  homeDir: string;
  /** 持久化 store。 */
  store?: ClientCacheStore;
  /** 时间源，便于测试注入。 */
  now?: () => number;
  /** miss 时穿透 client 的 fetcher。Task 5 时由 sync-coordinator 提供。 */
  fetcher?: FileAgentFetcher;
  /**
   * GC 周期间隔。默认 DEFAULT_GC_INTERVAL_MS（60s）。设为 0 → 不启动周期 GC，
   * 调用方需自己调 runGcOnce() 手动触发。测试场景常用 0。
   */
  gcIntervalMs?: number;
}

function assertValidTtl(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError(
      `FileAgent ttlMs 必须是有限正数（不允许 0 / 负数 / Infinity / NaN）；收到 ${ttlMs}`,
    );
  }
}

function assertAbsPath(p: string): void {
  if (typeof p !== "string" || !p.startsWith("/")) {
    throw new TypeError(`FileAgent 要求绝对路径；收到 ${p}`);
  }
}

export class FileAgent {
  readonly deviceId: string;
  private readonly scopeAdapter: ScopeAdapter;
  private readonly store: ClientCacheStore | null;
  private readonly ttl: TtlTable;
  private readonly now: () => number;
  private readonly fetcher: FileAgentFetcher | null;
  private readonly inflight = new InflightMap();
  private readonly gc: GcRunner | null;

  constructor(options: FileAgentOptions) {
    this.deviceId = options.deviceId;
    this.scopeAdapter = new ScopeAdapter(options.homeDir);
    this.store = options.store ?? null;
    this.now = options.now ?? (() => Date.now());
    this.ttl = new TtlTable({ now: this.now });
    this.fetcher = options.fetcher ?? null;

    // 仅在 store 配置时启动 GC——没有 store 没有 manifest 可清。
    const intervalMs = options.gcIntervalMs ?? DEFAULT_GC_INTERVAL_MS;
    if (this.store && intervalMs > 0) {
      this.gc = new GcRunner({
        deviceId: this.deviceId,
        store: this.store,
        scopeAdapter: this.scopeAdapter,
        ttl: this.ttl,
        inflight: this.inflight,
        intervalMs,
      });
      this.gc.start();
    } else if (this.store) {
      // intervalMs=0 时仍构造 GC，便于调用方手动 runGcOnce
      this.gc = new GcRunner({
        deviceId: this.deviceId,
        store: this.store,
        scopeAdapter: this.scopeAdapter,
        ttl: this.ttl,
        inflight: this.inflight,
        intervalMs: 1, // 占位，不会用到（不调 start）
      });
    } else {
      this.gc = null;
    }
  }

  async read(absPath: string, ttlMs: number): Promise<FileAgentReadResult> {
    assertValidTtl(ttlMs);
    assertAbsPath(absPath);

    const sr = this.scopeAdapter.toScopeRel(absPath);
    if (this.store && sr) {
      const entry = await this.store.lookupEntry(this.deviceId, sr.scope, sr.relPath);
      if (entry) {
        this.ttl.bump(absPath, ttlMs);
        if (entry.skipped) {
          return { kind: "skipped", size: entry.size, mtime: entry.mtime };
        }
        if (entry.sha256) {
          const buf = this.store.readBlobSync(this.deviceId, entry.sha256);
          if (buf) {
            return {
              kind: "file",
              content: buf,
              size: entry.size,
              mtime: entry.mtime,
              sha256: entry.sha256,
            };
          }
        }
      }
    }
    // miss：用 inflight 去重 + fetcher 穿透
    if (!this.fetcher) {
      throw new Error(
        `FileAgent.read miss path not implemented yet (no fetcher; Task 5 接 sync-coordinator)`,
      );
    }
    const result = await this.inflight.dedupe(inflightKey("read", absPath), () =>
      this.fetcher!.fetchFile(absPath),
    );
    // 命中（即便是 missing kind）也 bump TTL，避免短时间反复 miss 重复穿透
    this.ttl.bump(absPath, ttlMs);
    return result;
  }

  async stat(absPath: string, ttlMs: number): Promise<FileAgentStatResult> {
    assertValidTtl(ttlMs);
    assertAbsPath(absPath);

    const sr = this.scopeAdapter.toScopeRel(absPath);
    if (this.store && sr) {
      const entry = await this.store.lookupEntry(this.deviceId, sr.scope, sr.relPath);
      if (entry) {
        this.ttl.bump(absPath, ttlMs);
        return {
          kind: "file",
          size: entry.size,
          mtime: entry.mtime,
          sha256: entry.sha256,
        };
      }
    }
    if (!this.fetcher) {
      throw new Error(
        `FileAgent.stat miss path not implemented yet (no fetcher; Task 5 接 sync-coordinator)`,
      );
    }
    const result = await this.inflight.dedupe(inflightKey("stat", absPath), () =>
      this.fetcher!.fetchStat(absPath),
    );
    this.ttl.bump(absPath, ttlMs);
    return result;
  }

  async readdir(
    absDir: string,
    ttlMs: number,
  ): Promise<FileAgentReaddirResult> {
    assertValidTtl(ttlMs);
    assertAbsPath(absDir);

    if (!this.fetcher) {
      throw new Error(
        `FileAgent.readdir miss path not implemented yet (no fetcher; Task 5)`,
      );
    }
    const result = await this.inflight.dedupe(inflightKey("readdir", absDir), () =>
      this.fetcher!.fetchReaddir(absDir),
    );
    this.ttl.bump(absDir, ttlMs);
    return result;
  }

  async prefetch(
    items: PrefetchItem[],
    ttlMs: number,
  ): Promise<PrefetchResult> {
    assertValidTtl(ttlMs);
    if (!this.store) {
      // 没 store 退化为只调 fetcher 不落 cache（语义不对，所以拒绝）
      throw new Error(
        "FileAgent.prefetch 需要 store 配置（用于 hit 检查 + fetcher 落 cache）",
      );
    }
    const { runPrefetch } = await import("./prefetch.js");
    return runPrefetch(items, ttlMs, {
      deviceId: this.deviceId,
      store: this.store,
      scopeAdapter: this.scopeAdapter,
      ttl: this.ttl,
      inflight: this.inflight,
      fetcher: this.fetcher,
      now: this.now,
    });
  }

  async close(): Promise<void> {
    if (this.gc) {
      this.gc.stop();
    }
  }

  /**
   * Plan §3.6 路径 B wiring：watcher delta 已被外部（cache-task-manager）apply 到
   * store 后通知 FileAgent。本方法**不重复 apply**，只做：
   *   1. 清掉受影响 path 的 in-flight 项 telemetry（fetcher 让它按 snapshot 正常 resolve）
   *   2. 让 TTL 表对受影响 path 续期（watcher 推送 = 用户/系统在用，应保留）
   *
   * 注：在 server.ts 中通过 cacheTaskManager.onDeltaApplied 回调注册到对应 deviceId
   * 的 FileAgent。
   */
  async notifyWatcherDeltaApplied(
    changes: import("../protocol.js").CacheTaskChange[],
    ttlMs: number = DEFAULT_GC_INTERVAL_MS * 60, // 默认 60min（与 runtime ttl 同档）
  ): Promise<void> {
    for (const change of changes) {
      const absPath = this.scopeAdapter.toAbsPath(change.scope, change.path);
      // TTL 续期：watcher 推送 = 用户在用
      try {
        this.ttl.bump(absPath, ttlMs);
      } catch {
        // ttlMs 非法不该发生（默认值合法）；防御性 catch 不打断流程
      }
      // Inflight telemetry：仅 log，不强制清除（详见 SyncCoordinator.invalidateInflightForPath 的契约说明）
      const keys = [
        inflightKey("read", absPath),
        inflightKey("stat", absPath),
        inflightKey("readdir", absPath),
      ];
      for (const key of keys) {
        if (this.inflight.has(key)) {
          // 留给运维诊断
          // 这里不 log（避免运行时高频路径噪声）；E2E / SyncCoordinator 那边有 telemetry
        }
      }
    }
  }

  /** 手动触发一次 GC（测试 / 启动期主动清理时用）。 */
  async runGcOnce(): Promise<GcRunResult> {
    if (!this.gc) {
      return { evicted: 0, skippedInflight: 0, deletedBlobs: 0, durationMs: 0 };
    }
    return this.gc.runOnce();
  }

  /** 测试 only：暴露 TTL 表中某 path 的 expiresAt。 */
  getTtlForTest(absPath: string): number | null {
    return this.ttl.getExpiresAt(absPath);
  }

  /** 暴露 ScopeAdapter 内固化的 homeDir。供 server 层判断同 deviceId 是否需要重建实例。 */
  getHomeDirForTest(): string {
    return this.scopeAdapter.homeDir;
  }

  /**
   * Plan §9.1 #2 wiring：外部命中（如 FileProxyManager 通过共享 store 命中）通知
   * FileAgent 续期 TTL。这让 FileAgent 的 GC 不会清掉正在被 FUSE 读的 path（即便
   * 这些 path 没经 FileAgent.read 入口）。
   *
   * absPath 不在已知 scope 内 / ttlMs 非法时静默忽略（FUSE 路径调用频繁，不应抛错）。
   */
  bumpTtlForExternalHit(absPath: string, ttlMs: number): void {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
    if (typeof absPath !== "string" || !absPath.startsWith("/")) return;
    if (this.scopeAdapter.toScopeRel(absPath) === null) return;
    this.ttl.bump(absPath, ttlMs);
  }

  /** 测试 only：暴露 inflight 项数。 */
  getInflightSizeForTest(): number {
    return this.inflight.size();
  }
}

export type {
  FileAgentReadResult,
  FileAgentStatResult,
  FileAgentReaddirResult,
  FileAgentFetcher,
  PrefetchItem,
  PrefetchResult,
} from "./types.js";
export { FileAgentUnavailableError } from "./types.js";
export { ScopeAdapter } from "./scope-adapter.js";
export { TtlTable } from "./ttl-table.js";
export { InflightMap, inflightKey } from "./inflight.js";
export { GcRunner, DEFAULT_GC_INTERVAL_MS } from "./gc.js";
export type { GcRunResult } from "./gc.js";
