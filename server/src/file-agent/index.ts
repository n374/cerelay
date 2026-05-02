// FileAgent 入口（per-device 单例）。
// Task 1 阶段：仅接口骨架，所有方法抛 not-implemented。
// 后续 task 逐步接入 store / ledger / inflight / sync-coordinator / prefetch / gc。

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
}

export class FileAgent {
  readonly deviceId: string;

  constructor(options: FileAgentOptions) {
    this.deviceId = options.deviceId;
  }

  // 注：read/stat/readdir/prefetch 在 Task 1 阶段抛 "not implemented"，
  // 用于让 TDD 流程中的接口契约测试先失败（RED），下一个 task 接入 store 后变绿。

  async read(_absPath: string, _ttlMs: number): Promise<FileAgentReadResult> {
    throw new Error("FileAgent.read not implemented (Task 1 skeleton)");
  }

  async stat(_absPath: string, _ttlMs: number): Promise<FileAgentStatResult> {
    throw new Error("FileAgent.stat not implemented (Task 1 skeleton)");
  }

  async readdir(
    _absDir: string,
    _ttlMs: number,
  ): Promise<FileAgentReaddirResult> {
    throw new Error("FileAgent.readdir not implemented (Task 1 skeleton)");
  }

  async prefetch(
    _items: PrefetchItem[],
    _ttlMs: number,
  ): Promise<PrefetchResult> {
    throw new Error("FileAgent.prefetch not implemented (Task 1 skeleton)");
  }

  async close(): Promise<void> {
    // close 在骨架阶段是 noop——保证 setUp/tearDown 流程不会因 not-implemented 抛错。
    // Task 7 GC 接入后会在这里关掉定时器。
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
