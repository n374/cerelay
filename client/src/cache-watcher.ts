import { createHash } from "node:crypto";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { createLogger } from "./logger.js";
import { ALL_SCOPES, MAX_FILE_BYTES, type LocalEntry, scanLocalFiles } from "./cache-sync.js";
import type { CacheScope, CacheTaskChange, CacheTaskFaultCode } from "./protocol.js";

const log = createLogger("cache-watcher");

export const DEBOUNCE_MS = 250;
export const DEFAULT_SUPPRESS_TTL_MS = 10_000;

type FsEventName = "add" | "addDir" | "change" | "unlink" | "unlinkDir";

export interface CacheWatcherFault {
  code: CacheTaskFaultCode;
  fatal: boolean;
  message: string;
}

export interface CacheWatcherCallbacks {
  onChanges: (changes: CacheTaskChange[]) => void | Promise<void>;
  onFault?: (fault: CacheWatcherFault) => void;
}

export interface WatchBackendOptions {
  ignoreInitial: boolean;
  atomic: boolean;
  awaitWriteFinish: false;
  persistent: boolean;
}

export interface WatchHandle {
  on(event: "all", listener: (eventName: FsEventName, filePath: string) => void): this;
  on(event: "error", listener: (error: unknown) => void): this;
  close(): Promise<void> | void;
}

export interface WatchBackend {
  watch(paths: string[], options: WatchBackendOptions): Promise<WatchHandle> | WatchHandle;
}

export interface CacheWatcherOptions extends CacheWatcherCallbacks {
  homedir: string;
  debounceMs?: number;
  maxFileBytes?: number;
  backend?: WatchBackend;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export class CacheWatcher {
  private readonly homedir: string;
  private readonly debounceMs: number;
  private readonly maxFileBytes: number;
  private readonly callbacks: CacheWatcherCallbacks;
  private readonly backend: WatchBackend;
  private readonly now: () => number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly dirtyPathSet = new Set<string>();
  private readonly suppressions = new Map<string, number>();
  private readonly localIndex = new Map<string, LocalEntry>();
  private handle: WatchHandle | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private started = false;
  private flushChain: Promise<void> = Promise.resolve();

  constructor(options: CacheWatcherOptions) {
    this.homedir = options.homedir;
    this.debounceMs = options.debounceMs ?? DEBOUNCE_MS;
    this.maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
    this.callbacks = {
      onChanges: options.onChanges,
      onFault: options.onFault,
    };
    this.backend = options.backend ?? new ChokidarBackend();
    this.now = options.now ?? (() => Date.now());
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    await this.rebuildLocalIndex();

    this.handle = await this.backend.watch(
      [this.claudeHomeRoot(), this.claudeJsonPath()],
      {
        ignoreInitial: true,
        atomic: true,
        awaitWriteFinish: false,
        persistent: true,
      },
    );
    this.handle.on("all", (eventName, filePath) => {
      void this.onFsEvent(eventName, filePath);
    });
    this.handle.on("error", (error) => {
      this.handleWatcherError(error);
    });
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.flushTimer) {
      this.clearTimeoutFn(this.flushTimer);
      this.flushTimer = null;
    }
    this.dirtyPathSet.clear();
    this.clearSuppressor();
    this.localIndex.clear();
    const handle = this.handle;
    this.handle = null;
    if (handle) {
      await handle.close();
    }
    await this.flushChain.catch(() => undefined);
  }

  suppressPaths(paths: string[], ttlMs: number): void {
    const expiresAt = this.now() + ttlMs;
    for (const fsPath of paths) {
      this.suppressions.set(path.resolve(fsPath), expiresAt);
    }
  }

  clearSuppressor(): void {
    this.suppressions.clear();
  }

  async flushNow(): Promise<void> {
    if (this.flushTimer) {
      this.clearTimeoutFn(this.flushTimer);
      this.flushTimer = null;
    }
    await this.enqueueFlush();
  }

  async onFsEvent(_eventName: FsEventName, filePath: string): Promise<void> {
    if (!this.started) {
      return;
    }
    const absPath = path.resolve(filePath);
    if (this.isSuppressed(absPath)) {
      return;
    }
    this.dirtyPathSet.add(absPath);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = this.setTimeoutFn(() => {
      this.flushTimer = null;
      void this.enqueueFlush();
    }, this.debounceMs);
  }

  private async enqueueFlush(): Promise<void> {
    if (!this.started || this.dirtyPathSet.size === 0) {
      return;
    }

    const dirtyPaths = Array.from(this.dirtyPathSet).sort((a, b) => a.length - b.length);
    this.dirtyPathSet.clear();

    this.flushChain = this.flushChain.then(async () => {
      const deduped = new Map<string, CacheTaskChange>();

      for (const absPath of dirtyPaths) {
        if (this.isSuppressed(absPath)) {
          continue;
        }
        for (const change of await this.buildChangesForPath(absPath)) {
          deduped.set(this.changeKey(change), change);
        }
      }

      if (deduped.size === 0) {
        return;
      }

      try {
        await this.callbacks.onChanges(Array.from(deduped.values()));
      } catch (error) {
        this.emitFault("INTERNAL_ERROR", false, asErrorMessage(error));
      }
    });

    await this.flushChain;
  }

  private async rebuildLocalIndex(): Promise<void> {
    this.localIndex.clear();
    for (const scope of ALL_SCOPES) {
      const entries = await scanLocalFiles(scope, this.homedir);
      for (const entry of entries) {
        this.localIndex.set(this.indexKey(scope, entry.relPath), entry);
      }
    }
  }

  private async buildChangesForPath(absPath: string): Promise<CacheTaskChange[]> {
    const target = this.toScopePath(absPath);
    if (!target) {
      return [];
    }

    try {
      const stats = await stat(absPath);
      if (stats.isDirectory()) {
        return [];
      }
      if (!stats.isFile()) {
        return [];
      }

      const relPath = target.scope === "claude-json" ? "" : target.path;
      const entry: LocalEntry = {
        relPath,
        absPath,
        size: stats.size,
        mtime: Math.floor(stats.mtimeMs),
      };
      this.localIndex.set(this.indexKey(target.scope, relPath), entry);

      if (stats.size > this.maxFileBytes) {
        return [{
          kind: "upsert",
          scope: target.scope,
          path: relPath,
          size: stats.size,
          mtime: Math.floor(stats.mtimeMs),
          sha256: null,
          skipped: true,
        }];
      }

      const content = await readFile(absPath);
      return [{
        kind: "upsert",
        scope: target.scope,
        path: relPath,
        size: stats.size,
        mtime: Math.floor(stats.mtimeMs),
        sha256: createHash("sha256").update(content).digest("hex"),
        contentBase64: content.toString("base64"),
      }];
    } catch (error) {
      const code = errorCode(error);
      if (code === "EACCES") {
        return [];
      }
      if (code === "ENOENT") {
        return this.expandDeletes(target.scope, target.path);
      }
      this.emitFault("INTERNAL_ERROR", false, `${absPath}: ${asErrorMessage(error)}`);
      return [];
    }
  }

  private expandDeletes(scope: CacheScope, relPath: string): CacheTaskChange[] {
    const deletes: CacheTaskChange[] = [];
    const prefix = relPath ? `${relPath}/` : "";
    for (const key of Array.from(this.localIndex.keys())) {
      const [entryScope, entryPath] = splitIndexKey(key);
      if (entryScope !== scope) {
        continue;
      }
      if (scope === "claude-json") {
        this.localIndex.delete(key);
        deletes.push({ kind: "delete", scope, path: "" });
        break;
      }
      if (relPath === "" || entryPath === relPath || (prefix && entryPath.startsWith(prefix))) {
        this.localIndex.delete(key);
        deletes.push({ kind: "delete", scope, path: entryPath });
      }
    }
    return deletes;
  }

  private handleWatcherError(error: unknown): void {
    const code = errorCode(error);
    if (code === "EMFILE" || code === "ENOSPC") {
      this.emitFault("WATCHER_OVERFLOW", true, asErrorMessage(error));
      return;
    }
    if (code === "EACCES" || code === "ENOENT") {
      return;
    }
    this.emitFault("INTERNAL_ERROR", true, asErrorMessage(error));
  }

  private emitFault(code: CacheTaskFaultCode, fatal: boolean, message: string): void {
    log.warn("cache watcher fault", { code, fatal, message });
    this.callbacks.onFault?.({ code, fatal, message });
  }

  private isSuppressed(absPath: string): boolean {
    const now = this.now();
    for (const [suppressedPath, expiresAt] of Array.from(this.suppressions.entries())) {
      if (expiresAt <= now) {
        this.suppressions.delete(suppressedPath);
        continue;
      }
      if (absPath === suppressedPath || absPath.startsWith(`${suppressedPath}${path.sep}`)) {
        return true;
      }
    }
    return false;
  }

  private toScopePath(absPath: string): { scope: CacheScope; path: string } | null {
    const normalized = path.resolve(absPath);
    const jsonPath = this.claudeJsonPath();
    if (normalized === jsonPath) {
      return { scope: "claude-json", path: "" };
    }

    const homeRoot = this.claudeHomeRoot();
    if (normalized === homeRoot) {
      return { scope: "claude-home", path: "" };
    }
    if (normalized.startsWith(`${homeRoot}${path.sep}`)) {
      return {
        scope: "claude-home",
        path: path.relative(homeRoot, normalized).split(path.sep).join("/"),
      };
    }
    return null;
  }

  private changeKey(change: CacheTaskChange): string {
    return `${change.scope}:${change.path}`;
  }

  private indexKey(scope: CacheScope, relPath: string): string {
    return `${scope}:${relPath}`;
  }

  private claudeHomeRoot(): string {
    return path.join(this.homedir, ".claude");
  }

  private claudeJsonPath(): string {
    return path.join(this.homedir, ".claude.json");
  }
}

class ChokidarBackend implements WatchBackend {
  async watch(paths: string[], options: WatchBackendOptions): Promise<WatchHandle> {
    const chokidar = await import("chokidar");
    return chokidar.watch(paths, options) as unknown as WatchHandle;
  }
}

function splitIndexKey(key: string): [CacheScope, string] {
  const separator = key.indexOf(":");
  return [key.slice(0, separator) as CacheScope, key.slice(separator + 1)];
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
