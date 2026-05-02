// FileAgent 对外接口与结果类型定义。
// 参考 docs/superpowers/plans/2026-05-02-file-agent-and-config-preloader.md §3.1。
//
// 设计原则（plan §2）：
//   P2 接口窄面：只暴露 read / stat / readdir / prefetch + ttlMs
//   P4 TTL 决策权下放：调用方传 ttlMs，必须有限正数
//   P5 阻塞穿透：miss 时阻塞调用方直到内部穿透 client 完成
//   P9 双向数据流入：manifest 同时接受 read miss 拉取 + watcher delta 推送

export type FileAgentReadResult =
  | {
      kind: "file";
      content: Buffer;
      size: number;
      mtime: number;
      sha256: string;
    }
  | { kind: "missing" }
  | { kind: "skipped"; size: number; mtime: number };

export type FileAgentStatResult =
  | { kind: "file"; size: number; mtime: number; sha256: string | null }
  | { kind: "dir"; mtime: number }
  | { kind: "missing" };

export type FileAgentReaddirResult =
  | { kind: "dir"; entries: string[] }
  | { kind: "missing" };

export type PrefetchItem =
  | { kind: "file"; absPath: string }
  | { kind: "dir-recursive"; absPath: string }
  | { kind: "dir-shallow"; absPath: string };

export interface PrefetchResult {
  fetched: number;
  alreadyHot: number;
  missing: number;
  failed: Array<{ absPath: string; reason: string }>;
  durationMs: number;
}

/** Task 4 引入：穿透 client 失败时抛出。 */
export class FileAgentUnavailableError extends Error {
  override readonly name = "FileAgentUnavailableError";
  constructor(absPath: string, cause?: unknown) {
    super(
      `FileAgent: client unavailable for ${absPath}${
        cause instanceof Error ? `: ${cause.message}` : ""
      }`,
    );
  }
}
