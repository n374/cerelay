// ============================================================
// Client 文件缓存同步
//
// 启动流程：
//   1. 向 Server 发 cache_handshake（deviceId + cwd + scopes）
//   2. 收到 cache_manifest：Server 当前持有的文件元数据
//   3. 本地扫描 ~/.claude/ 与 ~/.claude.json
//   4. 与 Server manifest 做 diff，只推送变更（adds/deletes）
//   5. 大小限制：
//      - 单文件 > MAX_FILE_BYTES：标记 skipped，仅同步元数据
//      - 一个 scope 累计内容 > MAX_SCOPE_BYTES：按 mtime 倒序取，超过阈值的后续文件不同步
//   6. 向 Server 发 cache_push，等待 cache_push_ack
// ============================================================

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "./logger.js";
import type {
  CacheEntry,
  CacheHandshake,
  CacheManifest,
  CacheManifestData,
  CachePush,
  CachePushAck,
  CachePushEntry,
  CacheScope,
} from "./protocol.js";

const log = createLogger("cache-sync");

/** 单文件上限：超过则标记 skipped，仅同步元数据 */
export const MAX_FILE_BYTES = 1 * 1024 * 1024;
/** 单个 scope 总字节上限：超过则按 mtime 倒序截断 */
export const MAX_SCOPE_BYTES = 100 * 1024 * 1024;

export const ALL_SCOPES: CacheScope[] = ["claude-home", "claude-json"];

export interface CacheSyncDeps {
  /** 发送消息到 Server（通常为 client.writeJSON） */
  sendMessage: (msg: CacheHandshake | CachePush) => Promise<void>;
  /** 订阅下一条 cache_manifest / cache_push_ack，返回取消订阅函数 */
  waitForServerMessage: <T>(predicate: (raw: string) => T | null, timeoutMs: number) => Promise<T>;
  /** Client 本机 HOME 目录，用于定位 ~/.claude 与 ~/.claude.json */
  homedir?: string;
}

export interface CacheSyncOptions {
  deviceId: string;
  cwd: string;
  /** 单次等待 Server 响应的超时，默认 60s */
  timeoutMs?: number;
}

export interface ScopeSyncSummary {
  scope: CacheScope;
  pushed: number;
  deleted: number;
  skippedLarge: number;
  truncated: boolean;
  totalLocal: number;
  /** 本次遇到的致命错误（Server ack 返回 ok=false），有值则表示该 scope 失败 */
  error?: string;
}

/** 本地扫描出的文件条目 */
interface LocalEntry {
  /** 相对路径（POSIX 分隔符，claude-json scope 固定为 ""） */
  relPath: string;
  absPath: string;
  size: number;
  mtime: number;
}

/**
 * 执行完整的启动时缓存同步。
 *
 * - 出错不抛异常：启动同步失败不应阻止 PTY session 启动，降级为
 *   "无 Server 缓存"，后续读取仍然可以通过 FUSE 穿透到 Client。
 * - 各 scope 独立执行，一个 scope 失败不影响另一个。
 */
export async function performInitialCacheSync(
  deps: CacheSyncDeps,
  options: CacheSyncOptions,
): Promise<ScopeSyncSummary[]> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const homedir = deps.homedir ?? os.homedir();

  // 1. 握手
  await deps.sendMessage({
    type: "cache_handshake",
    deviceId: options.deviceId,
    cwd: options.cwd,
    scopes: ALL_SCOPES,
  });

  let manifest: CacheManifest;
  try {
    manifest = await deps.waitForServerMessage<CacheManifest>(
      (raw) => parseExpectedMessage<CacheManifest>(raw, "cache_manifest"),
      timeoutMs,
    );
  } catch (err) {
    log.warn("cache_manifest 等待失败，跳过启动同步", { error: asErrorMessage(err) });
    return ALL_SCOPES.map((scope) => ({
      scope,
      pushed: 0,
      deleted: 0,
      skippedLarge: 0,
      truncated: false,
      totalLocal: 0,
      error: asErrorMessage(err),
    }));
  }

  // 2. 每个 scope 独立推送
  const summaries: ScopeSyncSummary[] = [];
  for (const scope of ALL_SCOPES) {
    try {
      const summary = await syncScope({
        scope,
        deps,
        deviceId: options.deviceId,
        cwd: options.cwd,
        homedir,
        remote: manifest.manifests[scope],
        timeoutMs,
      });
      summaries.push(summary);
    } catch (err) {
      log.warn("单 scope 同步失败", { scope, error: asErrorMessage(err) });
      summaries.push({
        scope,
        pushed: 0,
        deleted: 0,
        skippedLarge: 0,
        truncated: false,
        totalLocal: 0,
        error: asErrorMessage(err),
      });
    }
  }
  return summaries;
}

interface SyncScopeArgs {
  scope: CacheScope;
  deps: CacheSyncDeps;
  deviceId: string;
  cwd: string;
  homedir: string;
  remote: CacheManifestData | undefined;
  timeoutMs: number;
}

async function syncScope(args: SyncScopeArgs): Promise<ScopeSyncSummary> {
  const { scope, deps, deviceId, cwd, homedir, remote, timeoutMs } = args;
  const remoteEntries = remote?.entries ?? {};

  const locals = await scanLocalFiles(scope, homedir);

  // 计算 diff：按 relPath
  const adds: CachePushEntry[] = [];
  const deletes: string[] = [];
  const unchanged: LocalEntry[] = [];

  for (const local of locals) {
    const remoteEntry = remoteEntries[local.relPath];
    if (!remoteEntry) {
      adds.push(await buildPushEntry(local));
      continue;
    }
    // 快速对比：size + mtime 一致 → 视为相同
    if (remoteEntry.size === local.size && remoteEntry.mtime === local.mtime) {
      unchanged.push(local);
      continue;
    }
    // size/mtime 不同 → 计算 sha256；相同则只更新 mtime，不需传 content
    const built = await buildPushEntry(local);
    if (remoteEntry.sha256 && remoteEntry.sha256 === built.sha256 && !built.skipped) {
      // 内容一致，但 mtime 不同 → 仅元数据更新
      adds.push({
        path: built.path,
        size: built.size,
        mtime: built.mtime,
        sha256: built.sha256,
        // 不带 content：Server 端 blob 已经存在，apply 时会因内容寻址去重
        // 但现有 store 要求 skipped 或 content 二选一，所以这里仍然传 content
        content: built.content,
      });
    } else {
      adds.push(built);
    }
  }

  // Server 有但本地没有 → 删除
  const localPaths = new Set(locals.map((l) => l.relPath));
  for (const remotePath of Object.keys(remoteEntries)) {
    if (!localPaths.has(remotePath)) {
      deletes.push(remotePath);
    }
  }

  // 应用 100MB scope 总量上限：按 mtime 倒序累加
  const { kept, truncatedAdds } = applyScopeBudget(adds);
  // truncatedAdds 不进 push，Server manifest 维持现状；后续 commit 3 读取时可 fallback
  let skippedLarge = 0;
  for (const add of kept) {
    if (add.skipped) skippedLarge += 1;
  }

  if (kept.length === 0 && deletes.length === 0 && !truncatedAdds) {
    log.debug("scope 无变更，跳过推送", {
      scope,
      totalLocal: locals.length,
      unchanged: unchanged.length,
    });
    return {
      scope,
      pushed: 0,
      deleted: 0,
      skippedLarge: 0,
      truncated: false,
      totalLocal: locals.length,
    };
  }

  // 发 push
  const push: CachePush = {
    type: "cache_push",
    deviceId,
    cwd,
    scope,
    adds: kept,
    deletes,
    truncated: truncatedAdds,
  };
  await deps.sendMessage(push);

  // 等 ack
  const ack = await deps.waitForServerMessage<CachePushAck>(
    (raw) => parseExpectedMessage<CachePushAck>(raw, "cache_push_ack", (msg) => msg.scope === scope),
    timeoutMs,
  );

  return {
    scope,
    pushed: kept.length,
    deleted: deletes.length,
    skippedLarge,
    truncated: truncatedAdds,
    totalLocal: locals.length,
    error: ack.ok ? undefined : ack.error || "server ack failed",
  };
}

/**
 * 扫描本地文件并返回规范化条目：
 * - claude-home：递归遍历 ~/.claude/
 * - claude-json：单文件 ~/.claude.json
 *
 * 对于目录不存在 / 无权限，返回空数组（首次启动是正常情况）。
 */
export async function scanLocalFiles(scope: CacheScope, homedir: string): Promise<LocalEntry[]> {
  if (scope === "claude-json") {
    const abs = path.join(homedir, ".claude.json");
    if (!existsSync(abs)) return [];
    try {
      const s = await stat(abs);
      if (!s.isFile()) return [];
      return [{
        relPath: "",
        absPath: abs,
        size: s.size,
        mtime: Math.floor(s.mtimeMs),
      }];
    } catch {
      return [];
    }
  }

  const rootAbs = path.join(homedir, ".claude");
  if (!existsSync(rootAbs)) return [];
  const results: LocalEntry[] = [];
  await walkDir(rootAbs, rootAbs, results);
  return results;
}

async function walkDir(root: string, current: string, out: LocalEntry[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walkDir(root, abs, out);
      continue;
    }
    if (!entry.isFile()) {
      // symlink / socket / fifo 等全部跳过；Claude 配置目录里不应出现
      continue;
    }
    try {
      const s = await stat(abs);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      out.push({
        relPath: rel,
        absPath: abs,
        size: s.size,
        mtime: Math.floor(s.mtimeMs),
      });
    } catch {
      // 权限问题直接忽略
    }
  }
}

/**
 * 根据文件大小决定是传完整内容还是仅同步元数据（skipped）。
 * 单文件 > MAX_FILE_BYTES 时标记 skipped。
 */
async function buildPushEntry(local: LocalEntry): Promise<CachePushEntry> {
  if (local.size > MAX_FILE_BYTES) {
    return {
      path: local.relPath,
      size: local.size,
      mtime: local.mtime,
      sha256: "",
      skipped: true,
    };
  }
  const buf = await readFile(local.absPath);
  const sha = createHash("sha256").update(buf).digest("hex");
  return {
    path: local.relPath,
    size: local.size,
    mtime: local.mtime,
    sha256: sha,
    content: buf.toString("base64"),
  };
}

/**
 * 按 mtime 倒序累加 content 大小，超过 MAX_SCOPE_BYTES 时截断。
 * skipped 的文件不计入预算（它们不带 content）但仍然计入"已同步"集合。
 */
export function applyScopeBudget(adds: CachePushEntry[]): { kept: CachePushEntry[]; truncatedAdds: boolean } {
  const sorted = [...adds].sort((a, b) => b.mtime - a.mtime);
  const kept: CachePushEntry[] = [];
  let usedBytes = 0;
  let truncated = false;
  for (const entry of sorted) {
    if (entry.skipped) {
      kept.push(entry);
      continue;
    }
    if (usedBytes + entry.size > MAX_SCOPE_BYTES) {
      truncated = true;
      continue;
    }
    usedBytes += entry.size;
    kept.push(entry);
  }
  return { kept, truncatedAdds: truncated };
}

// ---------- 消息解析 ----------

function parseExpectedMessage<T extends { type: string }>(
  raw: string,
  expectedType: T["type"],
  extraFilter?: (msg: T) => boolean,
): T | null {
  let parsed: { type?: string };
  try {
    parsed = JSON.parse(raw) as { type?: string };
  } catch {
    return null;
  }
  if (parsed.type !== expectedType) return null;
  const casted = parsed as T;
  if (extraFilter && !extraFilter(casted)) return null;
  return casted;
}

function asErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// 让外部测试用的辅助：构造 diff 时的简化版 buildPushEntry
export async function __testOnlyBuildPushEntry(local: { relPath: string; absPath: string; size: number; mtime: number }): Promise<CachePushEntry> {
  return buildPushEntry(local);
}

// 导出不直接用的类型，方便测试
export type { CacheEntry };
