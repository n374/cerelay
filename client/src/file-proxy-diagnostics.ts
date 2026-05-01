import path from "node:path";
import { createLogger } from "./logger.js";

const log = createLogger("file-proxy");

export interface FileProxyDedupRecord {
  op: string;
  path: string;
  status: "ok" | "error";
  errno?: number;
  bytes: number;
  elapsedMs: number;
}

interface DedupEntry {
  op: string;
  path: string;
  status: "ok" | "error";
  errno?: number;
  bytes: number;
  elapsedMsTotal: number;
  elapsedMsMax: number;
  count: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface FileProxyDedupMapOptions {
  roots?: string[];
  windowMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export class FileProxyDedupMap {
  private readonly roots: string[];
  private readonly windowMs: number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly entries = new Map<string, DedupEntry>();

  constructor(options: FileProxyDedupMapOptions = {}) {
    this.roots = (options.roots ?? []).map((root) => path.resolve(root));
    this.windowMs = options.windowMs ?? 500;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  }

  record(record: FileProxyDedupRecord): void {
    const displayPath = this.relativize(record.path);
    const statusOrErrno = record.status === "ok" ? "ok" : String(record.errno ?? "error");
    const key = `${record.op}\0${displayPath}\0${statusOrErrno}`;
    const existing = this.entries.get(key);
    if (existing) {
      existing.bytes += record.bytes;
      existing.elapsedMsTotal += record.elapsedMs;
      existing.elapsedMsMax = Math.max(existing.elapsedMsMax, record.elapsedMs);
      existing.count += 1;
      return;
    }

    this.writeLeading(record, displayPath);
    const entry: DedupEntry = {
      op: record.op,
      path: displayPath,
      status: record.status,
      errno: record.errno,
      bytes: record.bytes,
      elapsedMsTotal: record.elapsedMs,
      elapsedMsMax: record.elapsedMs,
      count: 1,
      timer: this.setTimeoutFn(() => this.flushKey(key), this.windowMs),
    };
    entry.timer.unref?.();
    this.entries.set(key, entry);
  }

  flush(): void {
    for (const key of Array.from(this.entries.keys())) {
      this.flushKey(key);
    }
  }

  dispose(): void {
    this.flush();
    for (const entry of this.entries.values()) {
      this.clearTimeoutFn(entry.timer);
    }
    this.entries.clear();
  }

  private flushKey(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }
    this.entries.delete(key);
    this.clearTimeoutFn(entry.timer);
    if (entry.count === 1) {
      return;
    }
    log.info(`file_proxy: ${entry.op} ${entry.path} repeated +${entry.count - 1} times totalBytes=${entry.bytes} maxElapsedMs=${entry.elapsedMsMax}`);
  }

  private writeLeading(record: FileProxyDedupRecord, displayPath: string): void {
    const suffix = record.status === "ok" ? "ok" : `errno=${record.errno ?? "error"}`;
    log.info(`file_proxy: ${record.op} ${displayPath} bytes=${record.bytes} elapsedMs=${record.elapsedMs} ${suffix}`);
  }

  private relativize(filePath: string): string {
    const resolved = path.resolve(filePath);
    for (const root of this.roots) {
      if (resolved === root) {
        return ".";
      }
      const relative = path.relative(root, resolved);
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        return relative.split(path.sep).join("/");
      }
    }
    return filePath;
  }
}
