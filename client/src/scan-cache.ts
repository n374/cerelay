import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createLogger } from "./logger.js";
import type { CacheScope } from "./protocol.js";

const log = createLogger("scan-cache");
const CACHE_VERSION = 1;

export interface ScanCacheEntry {
  size: number;
  mtime: number;
  sha256: string;
}

export interface ScanCacheStore {
  lookup(
    scope: CacheScope,
    relPath: string,
    size: number,
    mtime: number,
  ): string | null;
  upsert(scope: CacheScope, relPath: string, entry: ScanCacheEntry): void;
  pruneToPresent(scope: CacheScope, presentPaths: Set<string>): void;
  flush(): Promise<void>;
}

export async function openScanCache(args: {
  deviceId: string;
  cwd: string;
  configDir?: string;
}): Promise<ScanCacheStore> {
  const configDir = args.configDir ?? defaultConfigDir();
  const filePath = path.join(
    configDir,
    "scan-cache",
    `${args.deviceId}-${hashCwd(args.cwd)}.json`,
  );

  let decoded: PersistedScanCache;
  try {
    decoded = await readPersistedCache(filePath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      log.warn("打开 scan cache 失败，降级为 no-op store", {
        filePath,
        error: asErrorMessage(error),
      });
      return new NoopScanCacheStore();
    }
    decoded = emptyPersistedCache();
  }

  return new JsonScanCacheStore(filePath, decoded);
}

class JsonScanCacheStore implements ScanCacheStore {
  private readonly filePath: string;
  private readonly scopes: Map<CacheScope, Map<string, ScanCacheEntry>>;

  constructor(filePath: string, persisted: PersistedScanCache) {
    this.filePath = filePath;
    this.scopes = new Map();
    for (const [scope, entries] of Object.entries(persisted.scopes) as Array<[CacheScope, Record<string, ScanCacheEntry>]>) {
      this.scopes.set(scope, new Map(Object.entries(entries)));
    }
  }

  lookup(
    scope: CacheScope,
    relPath: string,
    size: number,
    mtime: number,
  ): string | null {
    const cached = this.scopes.get(scope)?.get(relPath);
    if (!cached) {
      return null;
    }
    return cached.size === size && cached.mtime === mtime ? cached.sha256 : null;
  }

  upsert(scope: CacheScope, relPath: string, entry: ScanCacheEntry): void {
    this.scopeMap(scope).set(relPath, { ...entry });
  }

  pruneToPresent(scope: CacheScope, presentPaths: Set<string>): void {
    const entries = this.scopes.get(scope);
    if (!entries) {
      return;
    }
    for (const relPath of Array.from(entries.keys())) {
      if (!presentPaths.has(relPath)) {
        entries.delete(relPath);
      }
    }
  }

  async flush(): Promise<void> {
    const payload = JSON.stringify(this.toPersisted(), null, 2) + "\n";
    const cacheDir = path.dirname(this.filePath);
    const tempPath = path.join(
      cacheDir,
      `${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );

    try {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(tempPath, payload, "utf8");
      await rename(tempPath, this.filePath);
    } catch (error) {
      log.warn("写入 scan cache 失败，已忽略", {
        filePath: this.filePath,
        error: asErrorMessage(error),
      });
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  private scopeMap(scope: CacheScope): Map<string, ScanCacheEntry> {
    let entries = this.scopes.get(scope);
    if (!entries) {
      entries = new Map();
      this.scopes.set(scope, entries);
    }
    return entries;
  }

  private toPersisted(): PersistedScanCache {
    const scopes: PersistedScanCache["scopes"] = {};
    for (const [scope, entries] of this.scopes.entries()) {
      scopes[scope] = {};
      for (const [relPath, entry] of entries.entries()) {
        scopes[scope][relPath] = { ...entry };
      }
    }
    return {
      version: CACHE_VERSION,
      scopes,
    };
  }
}

class NoopScanCacheStore implements ScanCacheStore {
  lookup(): string | null {
    return null;
  }

  upsert(): void {}

  pruneToPresent(): void {}

  async flush(): Promise<void> {}
}

interface PersistedScanCache {
  version: number;
  scopes: Partial<Record<CacheScope, Record<string, ScanCacheEntry>>>;
}

async function readPersistedCache(filePath: string): Promise<PersistedScanCache> {
  const raw = await readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    log.warn("scan cache JSON 损坏，按空缓存处理", {
      filePath,
      error: asErrorMessage(error),
    });
    return emptyPersistedCache();
  }

  const decoded = decodePersistedCache(parsed);
  if (!decoded.ok) {
    log.warn("scan cache 格式不兼容，按空缓存处理", {
      filePath,
      error: decoded.reason,
    });
    return emptyPersistedCache();
  }
  return decoded.value;
}

function decodePersistedCache(value: unknown):
  | { ok: true; value: PersistedScanCache }
  | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return { ok: false, reason: "root 必须是 object" };
  }
  if (value.version !== CACHE_VERSION) {
    return { ok: false, reason: `version=${String(value.version)}` };
  }
  if (!isRecord(value.scopes)) {
    return { ok: false, reason: "scopes 必须是 object" };
  }

  const scopes: PersistedScanCache["scopes"] = {};
  for (const scope of ["claude-home", "claude-json"] as const satisfies CacheScope[]) {
    const scopeValue = value.scopes[scope];
    if (scopeValue === undefined) {
      continue;
    }
    if (!isRecord(scopeValue)) {
      return { ok: false, reason: `${scope} entries 必须是 object` };
    }

    const decodedEntries: Record<string, ScanCacheEntry> = {};
    for (const [relPath, entry] of Object.entries(scopeValue)) {
      if (!isScanCacheEntry(entry)) {
        return { ok: false, reason: `${scope}.${relPath} 条目字段非法` };
      }
      decodedEntries[relPath] = entry;
    }
    scopes[scope] = decodedEntries;
  }

  return {
    ok: true,
    value: {
      version: CACHE_VERSION,
      scopes,
    },
  };
}

function emptyPersistedCache(): PersistedScanCache {
  return {
    version: CACHE_VERSION,
    scopes: {},
  };
}

function hashCwd(cwd: string): string {
  return createHash("sha1").update(cwd).digest("hex").slice(0, 16);
}

function defaultConfigDir(): string {
  return path.join(os.homedir(), ".config", "cerelay");
}

function isScanCacheEntry(value: unknown): value is ScanCacheEntry {
  return isRecord(value)
    && typeof value.size === "number"
    && Number.isFinite(value.size)
    && typeof value.mtime === "number"
    && Number.isFinite(value.mtime)
    && typeof value.sha256 === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMissingFileError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
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
