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

  constructor(options: FileAgentOptions) {
    this.deviceId = options.deviceId;
    this.scopeAdapter = new ScopeAdapter(options.homeDir);
    this.store = options.store ?? null;
    this.now = options.now ?? (() => Date.now());
    this.ttl = new TtlTable({ now: this.now });
    this.fetcher = options.fetcher ?? null;
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
    // Task 7 GC 接入后会在这里关掉定时器。当前 noop。
  }

  /** 测试 only：暴露 TTL 表中某 path 的 expiresAt。 */
  getTtlForTest(absPath: string): number | null {
    return this.ttl.getExpiresAt(absPath);
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
