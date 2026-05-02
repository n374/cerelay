// FileAgent 入口（per-device 单例）。
//
// 当前实施进度（plan 2026-05-02-file-agent-and-config-preloader.md）：
//   - Task 1: 接口骨架 ✓
//   - Task 2: store + scope-adapter，read/stat/readdir 命中路径走 store；miss 仍抛 not-implemented
//   - Task 3+ 后续: ledger / inflight / sync-coordinator / prefetch / gc

import type { ClientCacheStore } from "./store.js";
import { ScopeAdapter } from "./scope-adapter.js";
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
  /** 持久化 store；可选，仅 Task 2+ 命中路径需要（Task 1 骨架不强求）。 */
  store?: ClientCacheStore;
}

export class FileAgent {
  readonly deviceId: string;
  private readonly scopeAdapter: ScopeAdapter;
  private readonly store: ClientCacheStore | null;

  constructor(options: FileAgentOptions) {
    this.deviceId = options.deviceId;
    this.scopeAdapter = new ScopeAdapter(options.homeDir);
    this.store = options.store ?? null;
  }

  async read(absPath: string, _ttlMs: number): Promise<FileAgentReadResult> {
    // Task 2 命中路径：把 absPath 转 scope+rel，查 store；命中且非 skipped → 读 blob 返回 buffer。
    const sr = this.scopeAdapter.toScopeRel(absPath);
    if (this.store && sr) {
      const entry = await this.store.lookupEntry(this.deviceId, sr.scope, sr.relPath);
      if (entry) {
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
    // miss 或 store 不可用：Task 5 接 sync-coordinator 后再阻塞穿透。
    throw new Error(
      `FileAgent.read miss path not implemented yet (Task 5)`,
    );
  }

  async stat(absPath: string, _ttlMs: number): Promise<FileAgentStatResult> {
    const sr = this.scopeAdapter.toScopeRel(absPath);
    if (this.store && sr) {
      const entry = await this.store.lookupEntry(this.deviceId, sr.scope, sr.relPath);
      if (entry) {
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
    _absDir: string,
    _ttlMs: number,
  ): Promise<FileAgentReaddirResult> {
    // readdir 命中需要从 manifest 全量遍历推断目录结构——本期暂作 Task 5 实现。
    // Task 2 阶段不做（store 当前 schema 不直接索引 dir）。
    throw new Error("FileAgent.readdir not implemented yet (Task 5)");
  }

  async prefetch(
    _items: PrefetchItem[],
    _ttlMs: number,
  ): Promise<PrefetchResult> {
    throw new Error("FileAgent.prefetch not implemented yet (Task 6)");
  }

  async close(): Promise<void> {
    // Task 7 GC 接入后会在这里关掉定时器。当前 noop。
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
