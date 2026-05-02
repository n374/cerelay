// FileAgent 入口（per-device 单例）。
//
// 当前实施进度（plan 2026-05-02-file-agent-and-config-preloader.md）：
//   - Task 1: 接口骨架 ✓
//   - Task 2: store + scope-adapter，read/stat/readdir 命中路径走 store ✓
//   - Task 3: TTL 表（read/stat 命中时 bump expiresAt）✓
//   - Task 4+ 后续: inflight / sync-coordinator / prefetch / gc

import type { ClientCacheStore } from "./store.js";
import { ScopeAdapter } from "./scope-adapter.js";
import { TtlTable } from "./ttl-table.js";
import type {
  FileAgentReadResult,
  FileAgentStatResult,
  FileAgentReaddirResult,
  PrefetchItem,
  PrefetchResult,
} from "./types.js";

export interface FileAgentOptions {
  /** Device 唯一标识；FileAgent 与 deviceId 一一绑定（plan §2 P6）。 */
  deviceId: string;
  /** Client 侧 home 目录（用于 absPath ↔ scope+rel 适配）。 */
  homeDir: string;
  /** 持久化 store。 */
  store?: ClientCacheStore;
  /** 时间源，便于测试注入。 */
  now?: () => number;
}

/**
 * 校验 ttlMs 必须是有限正数（plan §3.5 拒绝条件 P4）。
 * 不论 op 命中还是 miss，入口都要校验——避免上层拿到 invalid ttl 后还能调到内部。
 */
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

  constructor(options: FileAgentOptions) {
    this.deviceId = options.deviceId;
    this.scopeAdapter = new ScopeAdapter(options.homeDir);
    this.store = options.store ?? null;
    this.now = options.now ?? (() => Date.now());
    this.ttl = new TtlTable({ now: this.now });
  }

  async read(absPath: string, ttlMs: number): Promise<FileAgentReadResult> {
    assertValidTtl(ttlMs);
    assertAbsPath(absPath);

    const sr = this.scopeAdapter.toScopeRel(absPath);
    if (this.store && sr) {
      const entry = await this.store.lookupEntry(this.deviceId, sr.scope, sr.relPath);
      if (entry) {
        // 命中：bump TTL 后返回。
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
    // miss / store 不可用：Task 5 接 sync-coordinator 后再阻塞穿透。
    throw new Error(
      `FileAgent.read miss path not implemented yet (Task 5)`,
    );
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
    throw new Error(
      `FileAgent.stat miss path not implemented yet (Task 5)`,
    );
  }

  async readdir(
    absDir: string,
    ttlMs: number,
  ): Promise<FileAgentReaddirResult> {
    assertValidTtl(ttlMs);
    assertAbsPath(absDir);
    // readdir 命中需要从 manifest 全量遍历推断目录结构——Task 5+ 实现。
    throw new Error("FileAgent.readdir not implemented yet (Task 5)");
  }

  async prefetch(
    _items: PrefetchItem[],
    ttlMs: number,
  ): Promise<PrefetchResult> {
    assertValidTtl(ttlMs);
    throw new Error("FileAgent.prefetch not implemented yet (Task 6)");
  }

  async close(): Promise<void> {
    // Task 7 GC 接入后会在这里关掉定时器。当前 noop。
  }

  /** 测试 only：暴露 TTL 表中某 path 的 expiresAt，便于 bump 行为断言。 */
  getTtlForTest(absPath: string): number | null {
    return this.ttl.getExpiresAt(absPath);
  }
}

export type {
  FileAgentReadResult,
  FileAgentStatResult,
  FileAgentReaddirResult,
  PrefetchItem,
  PrefetchResult,
} from "./types.js";
export { FileAgentUnavailableError } from "./types.js";
export { ScopeAdapter } from "./scope-adapter.js";
export { TtlTable } from "./ttl-table.js";
