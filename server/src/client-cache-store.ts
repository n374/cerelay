// ============================================================
// Client 文件缓存的持久化存储
//
// 目录布局（以默认 CERELAY_DATA_DIR=/var/lib/cerelay 为例）：
//
//   /var/lib/cerelay/client-cache/<deviceId>/
//     manifest.json                   按 scope 组织的元数据（path → {size, mtime, sha256, skipped}）
//     blobs/<sha256>                  实际内容，内容寻址，天然去重
//
// - 跳过的大文件（skipped=true）只记 manifest，不写 blob；运行时需要穿透到 Client 读取
// ============================================================

import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CacheEntry,
  CacheManifestData,
  CacheTaskChange,
  CacheScope,
} from "./protocol.js";

export const CACHE_SCOPES: CacheScope[] = ["claude-home", "claude-json"];

/** Server 侧完整 manifest：按 scope 分组；未初始化的 scope 视为空条目集。 */
export interface PersistedManifest {
  version: 3;
  revision: number;
  scopes: Record<CacheScope, CacheManifestData>;
}

export interface ClientCacheStoreOptions {
  /** 默认 /var/lib/cerelay */
  dataDir: string;
}

export interface ApplyDeltaResult {
  revision: number;
  written: number;
  deleted: number;
  skippedContents: number;
}

export class ClientCacheStore {
  private readonly dataDir: string;
  /**
   * 按 deviceId 维护的串行锁。
   *
   * 背景：WebSocket message handler 是并发的（server.ts 里 void this.handleMessage(...)），
   * 同一 deviceId 的多个 delta / 单条目更新可能并发落盘，manifest 的
   * read-modify-write 之间没有同步原语，会互相覆盖丢更新。因此这里加 per-manifest
   * 串行锁（注意是 per-deviceId，不是 per-scope，因为 manifest.json 是单文件存所有 scope）。
   *
   * 实现是简单的 promise 链：每个新请求 await 上一个的结尾，自己再追加上去。
   * 同 key 的请求严格 FIFO；不同 deviceId 之间天然并发。
   */
  private readonly mutexChains = new Map<string, Promise<void>>();

  constructor(options: ClientCacheStoreOptions) {
    this.dataDir = options.dataDir;
  }

  /**
   * 在 deviceId 锁下串行执行 fn。
   * 实现：经典 promise 链——每次拿当前 tail 的 promise，await 它后自己再追加一节。
   * Map 仅记录"最新尾节点 promise"，所以每个 key 永远只占一项；条目数受
   * deviceId 的活跃数约束，不会无界增长。
   */
  private async withManifestLock<T>(
    deviceId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = sanitizeDeviceId(deviceId);
    const previous = this.mutexChains.get(key) ?? Promise.resolve();
    let releaseSelf!: () => void;
    const self = new Promise<void>((resolve) => {
      releaseSelf = resolve;
    });
    // 新尾节点 = 上一节完成后等本节点
    const newTail = previous.then(() => self);
    this.mutexChains.set(key, newTail);
    try {
      // 上一节失败不影响后续：业务异常已经各自上报
      await previous.catch(() => undefined);
      return await fn();
    } finally {
      releaseSelf();
      // 如果我们就是当前尾巴（没有后继接上来），清理 Map 防长留 settled promise
      if (this.mutexChains.get(key) === newTail) {
        this.mutexChains.delete(key);
      }
    }
  }

  /**
   * 返回 Client cache 的根目录，如 /var/lib/cerelay/client-cache/。
   * 外部（例如 commit 3 的 FUSE 读路径）只应通过本 store 访问，不要手动拼路径。
   */
  rootDir(): string {
    return path.join(this.dataDir, "client-cache");
  }

  /**
   * 读取指定 deviceId 的完整 manifest。
   * 不存在或损坏时返回一个全空的 manifest，不抛异常——新设备首次连接走这条路径。
   * v1/v2 旧 schema 无历史包袱，直接视为空 v3 manifest。
   */
  async loadManifest(deviceId: string): Promise<PersistedManifest> {
    const manifestPath = this.manifestPath(deviceId);
    try {
      const raw = await readFile(manifestPath, "utf8");
      const parsed = JSON.parse(raw) as PersistedManifest;
      if (parsed?.version === 3 && parsed.scopes) {
        return normalizeManifestV3(parsed);
      }
    } catch {
      // ENOENT / JSON 解析失败 → 回空
    }
    return emptyManifest();
  }

  async applyDelta(
    deviceId: string,
    changes: CacheTaskChange[],
  ): Promise<ApplyDeltaResult> {
    return this.withManifestLock(deviceId, async () => {
      const deviceDir = this.deviceDir(deviceId);
      await mkdir(path.join(deviceDir, "blobs"), { recursive: true });

      const manifest = await this.loadManifest(deviceId);
      const result = await this.applyChangesToManifest(manifest, deviceDir, changes);
      manifest.revision += 1;
      await writeManifestAtomic(this.manifestPath(deviceId), manifest);
      return {
        revision: manifest.revision,
        written: result.written,
        deleted: result.deleted,
        skippedContents: result.skippedContents,
      };
    });
  }

  /**
   * 根据 (deviceId, sha256) 定位 blob 文件路径。FUSE read
   * 优先查 blob；调用方负责判断文件是否存在（skipped 的没有 blob）。
   */
  blobPath(deviceId: string, sha256: string): string {
    return path.join(this.deviceDir(deviceId), "blobs", sha256);
  }

  blobExists(deviceId: string, sha256: string): boolean {
    return existsSync(this.blobPath(deviceId, sha256));
  }

  /**
   * 同步读取 blob 内容。commit 3 的 FUSE 读路径使用：
   * - 文件不存在（skipped / 新文件）→ 返回 null，调用方 fallback 到穿透 Client
   * - 文件存在 → 返回 Buffer
   */
  readBlobSync(deviceId: string, sha256: string): Buffer | null {
    const p = this.blobPath(deviceId, sha256);
    if (!existsSync(p)) return null;
    try {
      return readFileSync(p);
    } catch {
      return null;
    }
  }

  /**
   * 把一个内存 buffer 作为"已写入 cache 的变更"落盘。供 FUSE 写入同步调用。
   * 返回写入后的 CacheEntry，调用方负责把它合并进 manifest（通常通过 upsertEntry）。
   */
  async writeBlobBuffer(deviceId: string, buf: Buffer): Promise<CacheEntry> {
    const deviceDir = this.deviceDir(deviceId);
    await mkdir(path.join(deviceDir, "blobs"), { recursive: true });
    const sha = sha256Hex(buf);
    await writeBlobIfMissing(deviceDir, sha, buf);
    return {
      size: buf.byteLength,
      mtime: Date.now(),
      sha256: sha,
    };
  }

  /**
   * 更新单个 entry 的 manifest 记录（不写 blob）。适合与 writeBlobBuffer 搭配，
   * 或用于 Claude Code 通过 FUSE write 后刷新 manifest。
   */
  async upsertEntry(
    deviceId: string,
    scope: CacheScope,
    relPath: string,
    entry: CacheEntry,
  ): Promise<void> {
    return this.withManifestLock(deviceId, async () => {
      const manifest = await this.loadManifest(deviceId);
      manifest.scopes[scope].entries[relPath] = entry;
      manifest.revision += 1;
      await writeManifestAtomic(this.manifestPath(deviceId), manifest);
    });
  }

  /**
   * 从 manifest 移除一个 entry。供 FUSE unlink 同步调用。
   */
  async removeEntry(
    deviceId: string,
    scope: CacheScope,
    relPath: string,
  ): Promise<void> {
    return this.withManifestLock(deviceId, async () => {
      const manifest = await this.loadManifest(deviceId);
      if (scope in manifest.scopes && relPath in manifest.scopes[scope].entries) {
        delete manifest.scopes[scope].entries[relPath];
        manifest.revision += 1;
        await writeManifestAtomic(this.manifestPath(deviceId), manifest);
      }
    });
  }

  /**
   * 查询某个 (scope, relPath) 在 cache 中的元数据。未命中返回 null。
   * FUSE 读优先策略：先 lookupEntry，命中且未 skipped → readBlobSync，否则回源 Client。
   */
  async lookupEntry(
    deviceId: string,
    scope: CacheScope,
    relPath: string,
  ): Promise<CacheEntry | null> {
    const manifest = await this.loadManifest(deviceId);
    return manifest.scopes[scope]?.entries[relPath] ?? null;
  }

  async gcOrphanBlobs(deviceId: string): Promise<{ deleted: number }> {
    return this.withManifestLock(deviceId, async () => {
      const manifest = await this.loadManifest(deviceId);
      const live = new Set<string>();
      for (const scope of Object.values(manifest.scopes)) {
        for (const entry of Object.values(scope.entries)) {
          if (entry.sha256) live.add(entry.sha256);
        }
      }

      const blobsDir = path.join(this.deviceDir(deviceId), "blobs");
      let deleted = 0;
      try {
        const names = await readdir(blobsDir);
        for (const name of names) {
          if (live.has(name)) continue;
          await rm(path.join(blobsDir, name), { force: true });
          deleted += 1;
        }
      } catch {
        // ENOENT: no blobs yet.
      }
      return { deleted };
    });
  }

  // ---------- 内部 ----------

  private deviceDir(deviceId: string): string {
    return path.join(this.rootDir(), sanitizeDeviceId(deviceId));
  }

  private manifestPath(deviceId: string): string {
    return path.join(this.deviceDir(deviceId), "manifest.json");
  }

  private async applyChangesToManifest(
    manifest: PersistedManifest,
    deviceDir: string,
    changes: CacheTaskChange[],
  ): Promise<Omit<ApplyDeltaResult, "revision">> {
    let written = 0;
    let deleted = 0;
    let skippedContents = 0;

    for (const change of changes) {
      const scopeData = manifest.scopes[change.scope];
      if (change.kind === "delete") {
        if (scopeData.entries[change.path]) {
          delete scopeData.entries[change.path];
          deleted += 1;
        }
        continue;
      }

      if (change.skipped) {
        scopeData.entries[change.path] = {
          size: change.size,
          mtime: change.mtime,
          sha256: change.sha256 ?? null,
          skipped: true,
        };
        skippedContents += 1;
        continue;
      }

      // 注意：必须用 typeof 判定字段存在，不能用 !change.contentBase64。
      // 0 字节文件（如 ~/.claude/tasks/<uuid>/.lock）的 contentBase64 是空字符串 ""，
      // 是合法值；早期写法用 falsy 检查会把它误当成"缺失"并整个 cache sync 崩盘。
      if (typeof change.contentBase64 !== "string") {
        throw new Error(
          `cache_task_delta upsert 条目缺少 contentBase64: scope=${change.scope} path=${change.path}`,
        );
      }
      if (typeof change.sha256 !== "string" || change.sha256.length === 0) {
        throw new Error(
          `cache_task_delta upsert 条目缺少 sha256: scope=${change.scope} path=${change.path}`,
        );
      }

      const buf = Buffer.from(change.contentBase64, "base64");
      const actualSha = sha256Hex(buf);
      if (actualSha !== change.sha256) {
        throw new Error(
          `cache_task_delta 条目 sha256 校验失败: scope=${change.scope} path=${change.path} ` +
          `declared=${change.sha256} actual=${actualSha}`,
        );
      }
      await writeBlobIfMissing(deviceDir, actualSha, buf);
      scopeData.entries[change.path] = {
        size: change.size,
        mtime: change.mtime,
        sha256: actualSha,
      };
      written += 1;
    }

    return { written, deleted, skippedContents };
  }
}

export function emptyManifest(): PersistedManifest {
  return {
    version: 3,
    revision: 0,
    scopes: {
      "claude-home": { entries: {} },
      "claude-json": { entries: {} },
    },
  };
}

/**
 * deviceId 允许的格式是 UUIDv4 / 字母数字；这里做一个保守的 sanitize，防止被用于
 * path traversal（"../"）或跨目录污染。出现非法字符直接抛错——deviceId 是 Client
 * 侧生成持久化的，不应发生。
 */
export function sanitizeDeviceId(deviceId: string): string {
  if (!deviceId || deviceId.length > 128) {
    throw new Error(`invalid deviceId: ${deviceId}`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(deviceId)) {
    throw new Error(`deviceId 含非法字符: ${deviceId}`);
  }
  return deviceId;
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function writeBlobIfMissing(
  deviceDir: string,
  sha256: string,
  buf: Buffer,
): Promise<void> {
  const blobPath = path.join(deviceDir, "blobs", sha256);
  if (existsSync(blobPath)) return;
  const tmpPath = `${blobPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, buf);
  try {
    await rename(tmpPath, blobPath);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

async function writeManifestAtomic(
  manifestPath: string,
  manifest: PersistedManifest,
): Promise<void> {
  await mkdir(path.dirname(manifestPath), { recursive: true });
  const tmpPath = `${manifestPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await rename(tmpPath, manifestPath);
}

// 该 helper 被 commit 3 使用：按流读 blob 的 0-size 检测；commit 2 内部暂未调用
// 但一并导出，避免 commit 3 再动 ClientCacheStore 接口。
export function createBlobReadStream(blobPath: string): NodeJS.ReadableStream {
  return createReadStream(blobPath);
}

function normalizeManifestV3(manifest: PersistedManifest): PersistedManifest {
  for (const scope of CACHE_SCOPES) {
    if (!manifest.scopes[scope]) {
      manifest.scopes[scope] = { entries: {} };
    }
  }
  if (typeof manifest.revision !== "number" || Number.isNaN(manifest.revision)) {
    manifest.revision = 0;
  }
  return manifest;
}
