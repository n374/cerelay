// ============================================================
// Client 文件缓存的持久化存储
//
// 目录布局（以默认 CERELAY_DATA_DIR=/var/lib/cerelay 为例）：
//
//   /var/lib/cerelay/client-cache/<deviceId>/<cwdHash>/
//     manifest.json                   按 scope 组织的元数据（path → {size, mtime, sha256, skipped}）
//     blobs/<sha256>                  实际内容，内容寻址，天然去重
//
// - cwdHash = sha256(cwd 绝对路径).slice(0,16)，避免同一 deviceId 下 cwd 切换时缓存互相污染
// - 跳过的大文件（skipped=true）只记 manifest，不写 blob；运行时需要穿透到 Client 读取
// ============================================================

import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CacheEntry,
  CacheManifestData,
  CachePush,
  CachePushEntry,
  CacheScope,
} from "./protocol.js";

export const CACHE_SCOPES: CacheScope[] = ["claude-home", "claude-json"];

/** Server 侧完整 manifest：按 scope 分组；未初始化的 scope 视为空条目集。 */
export interface PersistedManifest {
  version: 1;
  scopes: Record<CacheScope, CacheManifestData & { truncated?: boolean }>;
}

export interface ClientCacheStoreOptions {
  /** 默认 /var/lib/cerelay */
  dataDir: string;
}

export interface ApplyPushResult {
  written: number;
  deleted: number;
  skippedContents: number;
  manifest: CacheManifestData & { truncated?: boolean };
}

export class ClientCacheStore {
  private readonly dataDir: string;

  constructor(options: ClientCacheStoreOptions) {
    this.dataDir = options.dataDir;
  }

  /**
   * 返回 Client cache 的根目录，如 /var/lib/cerelay/client-cache/。
   * 外部（例如 commit 3 的 FUSE 读路径）只应通过本 store 访问，不要手动拼路径。
   */
  rootDir(): string {
    return path.join(this.dataDir, "client-cache");
  }

  /**
   * 读取指定 (deviceId, cwd) 的完整 manifest。
   * 不存在或损坏时返回一个全空的 manifest，不抛异常——新设备首次连接走这条路径。
   */
  async loadManifest(deviceId: string, cwd: string): Promise<PersistedManifest> {
    const manifestPath = this.manifestPath(deviceId, cwd);
    try {
      const raw = await readFile(manifestPath, "utf8");
      const parsed = JSON.parse(raw) as PersistedManifest;
      if (parsed?.version === 1 && parsed.scopes) {
        // 补齐缺失 scope，避免调用方处理 undefined
        for (const scope of CACHE_SCOPES) {
          if (!parsed.scopes[scope]) {
            parsed.scopes[scope] = { entries: {} };
          }
        }
        return parsed;
      }
    } catch {
      // ENOENT / JSON 解析失败 → 回空
    }
    return emptyManifest();
  }

  /**
   * 应用一次推送：写 blobs、更新 manifest。原子性保证：
   * - manifest 写入使用 tmp + rename，避免半写状态
   * - blob 不需要原子性（sha256 内容寻址，同名即同内容）
   */
  async applyPush(push: CachePush): Promise<ApplyPushResult> {
    const sessionDir = this.sessionDir(push.deviceId, push.cwd);
    await mkdir(path.join(sessionDir, "blobs"), { recursive: true });

    const manifest = await this.loadManifest(push.deviceId, push.cwd);
    const scopeData = manifest.scopes[push.scope];

    // 删除
    let deleted = 0;
    for (const rel of push.deletes) {
      if (scopeData.entries[rel]) {
        delete scopeData.entries[rel];
        deleted += 1;
      }
    }

    // 新增/更新
    let written = 0;
    let skippedContents = 0;
    for (const entry of push.adds) {
      if (entry.skipped) {
        // 仅更新 manifest，不写 blob
        scopeData.entries[entry.path] = {
          size: entry.size,
          mtime: entry.mtime,
          sha256: entry.sha256 || null,
          skipped: true,
        };
        skippedContents += 1;
        continue;
      }

      if (!entry.content) {
        throw new Error(
          `cache_push adds 条目缺少 content 字段: scope=${push.scope} path=${entry.path}`,
        );
      }
      const buf = Buffer.from(entry.content, "base64");
      const actualSha = sha256Hex(buf);
      if (actualSha !== entry.sha256) {
        throw new Error(
          `cache_push 条目 sha256 校验失败: scope=${push.scope} path=${entry.path} ` +
          `declared=${entry.sha256} actual=${actualSha}`,
        );
      }
      await writeBlobIfMissing(sessionDir, actualSha, buf);
      scopeData.entries[entry.path] = {
        size: entry.size,
        mtime: entry.mtime,
        sha256: actualSha,
      };
      written += 1;
    }

    // 标记 truncated 用于后续诊断；仍允许继续运行
    if (push.truncated) {
      scopeData.truncated = true;
    } else {
      delete scopeData.truncated;
    }

    await writeManifestAtomic(this.manifestPath(push.deviceId, push.cwd), manifest);
    return {
      written,
      deleted,
      skippedContents,
      manifest: scopeData,
    };
  }

  /**
   * 根据 (deviceId, cwd, sha256) 定位 blob 文件路径。commit 3 的 FUSE read
   * 优先查 blob；调用方负责判断文件是否存在（skipped 的没有 blob）。
   */
  blobPath(deviceId: string, cwd: string, sha256: string): string {
    return path.join(this.sessionDir(deviceId, cwd), "blobs", sha256);
  }

  blobExists(deviceId: string, cwd: string, sha256: string): boolean {
    return existsSync(this.blobPath(deviceId, cwd, sha256));
  }

  /**
   * 同步读取 blob 内容。commit 3 的 FUSE 读路径使用：
   * - 文件不存在（skipped / 新文件）→ 返回 null，调用方 fallback 到穿透 Client
   * - 文件存在 → 返回 Buffer
   */
  readBlobSync(deviceId: string, cwd: string, sha256: string): Buffer | null {
    const p = this.blobPath(deviceId, cwd, sha256);
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
  async writeBlobBuffer(deviceId: string, cwd: string, buf: Buffer): Promise<CacheEntry> {
    const sessionDir = this.sessionDir(deviceId, cwd);
    await mkdir(path.join(sessionDir, "blobs"), { recursive: true });
    const sha = sha256Hex(buf);
    await writeBlobIfMissing(sessionDir, sha, buf);
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
    cwd: string,
    scope: CacheScope,
    relPath: string,
    entry: CacheEntry,
  ): Promise<void> {
    const manifest = await this.loadManifest(deviceId, cwd);
    manifest.scopes[scope].entries[relPath] = entry;
    await writeManifestAtomic(this.manifestPath(deviceId, cwd), manifest);
  }

  /**
   * 从 manifest 移除一个 entry。供 FUSE unlink 同步调用。
   */
  async removeEntry(
    deviceId: string,
    cwd: string,
    scope: CacheScope,
    relPath: string,
  ): Promise<void> {
    const manifest = await this.loadManifest(deviceId, cwd);
    if (scope in manifest.scopes && relPath in manifest.scopes[scope].entries) {
      delete manifest.scopes[scope].entries[relPath];
      await writeManifestAtomic(this.manifestPath(deviceId, cwd), manifest);
    }
  }

  /**
   * 查询某个 (scope, relPath) 在 cache 中的元数据。未命中返回 null。
   * FUSE 读优先策略：先 lookupEntry，命中且未 skipped → readBlobSync，否则回源 Client。
   */
  async lookupEntry(
    deviceId: string,
    cwd: string,
    scope: CacheScope,
    relPath: string,
  ): Promise<CacheEntry | null> {
    const manifest = await this.loadManifest(deviceId, cwd);
    return manifest.scopes[scope]?.entries[relPath] ?? null;
  }

  // ---------- 内部 ----------

  private sessionDir(deviceId: string, cwd: string): string {
    return path.join(this.rootDir(), sanitizeDeviceId(deviceId), cwdHash(cwd));
  }

  private manifestPath(deviceId: string, cwd: string): string {
    return path.join(this.sessionDir(deviceId, cwd), "manifest.json");
  }
}

export function emptyManifest(): PersistedManifest {
  return {
    version: 1,
    scopes: {
      "claude-home": { entries: {} },
      "claude-json": { entries: {} },
    },
  };
}

export function cwdHash(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
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
  sessionDir: string,
  sha256: string,
  buf: Buffer,
): Promise<void> {
  const blobPath = path.join(sessionDir, "blobs", sha256);
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

/** 把 PushEntry 转为 manifest 层面的 CacheEntry，便于调用方统一处理 */
export function pushEntryToCacheEntry(entry: CachePushEntry): CacheEntry {
  if (entry.skipped) {
    return {
      size: entry.size,
      mtime: entry.mtime,
      sha256: entry.sha256 || null,
      skipped: true,
    };
  }
  return {
    size: entry.size,
    mtime: entry.mtime,
    sha256: entry.sha256,
  };
}
