// ============================================================
// Client 文件缓存同步（pipeline / 全双工）
//
// 启动流程：
//   1. 向 Server 发 cache_handshake（deviceId + cwd + scopes）
//   2. 收到 cache_manifest：Server 当前持有的文件元数据
//   3. 一次性扫描所有 scope 的本地文件，与 Server manifest 做 diff，构造 plan
//   4. 串行发送各 scope 的"元数据批"（deletes + skipped），等 ack（不进入 pipeline）
//   5. 进入 pipeline：连续发送 cache_push 不阻塞等待 ack；通过单调递增的 seq
//      在 in-flight 队列中匹配回到的 ack
//   6. 流控：当 in-flight 字节累计 > MAX_INFLIGHT_BYTES 时暂停发送，等任意 ack
//      释放配额后继续
//   7. 大小限制：
//      - 单文件 > MAX_FILE_BYTES：标记 skipped，仅同步元数据
//      - 一个 scope 累计内容 > MAX_SCOPE_BYTES：按 mtime 倒序取，超过阈值的丢弃
//
// 事件序列（onProgress）：
//   skipped (异常 / 跳过同步) | scan_start → scan_done → upload_start →
//     [(file_pushed → file_acked) 多次，可能交叠] → upload_done
//
// 协议假设：
//   - cache_push.seq 单调递增（本流程内自增）；server 必须在 cache_push_ack.seq 中原样回显
//   - server 端 (deviceId, cwd) 串行化 manifest 写入；同一 manifest 上多个 push
//     不会丢更新（依赖 server-side mutex）
//
// 单文件传输进度的取舍：
//   pipeline 模式下多个文件的字节会同时滞留在 OS 发送缓冲中，ws.bufferedAmount
//   只能反映"in-flight 集合"的总残留，无法分离到单个文件。所以本模块**不再**
//   暴露单文件 baseline，UI 只展示总进度（已 ack 字节 / 总字节）+ in-flight 头部。
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
/**
 * Pipeline 流控水位：in-flight 字节超过此值时暂停发送。
 * 16MB 的取值平衡了：
 *  - 流水线深度足够吃掉常见 RTT（公网 200ms × 80MB/s ≈ 16MB）
 *  - 不至于让 OS 发送缓冲压力过大
 */
export const MAX_INFLIGHT_BYTES = 16 * 1024 * 1024;

export const ALL_SCOPES: CacheScope[] = ["claude-home", "claude-json"];

// ---------- 进度事件 ----------

export type CacheSyncEvent =
  /** 整个同步流程被跳过（ws 未就绪 / 协议失败），UI 不展示任何东西 */
  | { kind: "skipped"; reason: string }
  /** 进入扫描阶段；UI 展示 spinner + 计时 */
  | { kind: "scan_start" }
  /** 扫描完成；UI 定格扫描行 */
  | { kind: "scan_done"; totalFiles: number; totalBytes: number; elapsedMs: number }
  /**
   * 上传阶段开始；totalFiles / totalBytes 仅统计真正有 content 要上传的文件。
   * 元数据批（deletes / skipped）不计入。
   */
  | { kind: "upload_start"; totalFiles: number; totalBytes: number }
  /**
   * 单文件 push 已交给 sendMessage（进入 in-flight 队列）。
   * 这是事件而非状态——同一时刻可能有多个文件处于 pushed 但未 acked 的状态。
   */
  | {
      kind: "file_pushed";
      scope: CacheScope;
      displayPath: string;
      size: number;
      seq: number;
      index: number;
      total: number;
    }
  /** 单文件 ack 收到；UI 把该文件移出 in-flight 队列、累计已 ack 字节 */
  | {
      kind: "file_acked";
      scope: CacheScope;
      displayPath: string;
      size: number;
      seq: number;
      index: number;
      total: number;
      ok: boolean;
      error?: string;
    }
  /** 上传阶段结束（无论是否有失败）；UI 定格总结行 */
  | { kind: "upload_done"; totalFiles: number; totalBytes: number; elapsedMs: number };

// ---------- Deps & Options ----------

export interface CacheSyncDeps {
  /** 发送消息到 Server（通常为 client.writeJSON） */
  sendMessage: (msg: CacheHandshake | CachePush) => Promise<void>;
  /**
   * 等单条 cache_manifest（一次性）。手 shake 阶段使用。
   * 与 subscribeAcks 不同的是：本方法专门处理 handshake 单消息，捕获后立即返回。
   */
  waitForServerMessage: <T>(predicate: (raw: string) => T | null, timeoutMs: number) => Promise<T>;
  /**
   * 订阅 cache_push_ack 流，返回 unsubscribe。pipeline 模式下同一 scope 可能
   * 有多个 ack 并发到达，必须用长期订阅+按 seq 路由。
   *
   * 实现要求：handler 接收"已成功解析为 CachePushAck 的消息"，非 ack 消息不应回调。
   */
  subscribeAcks: (handler: (ack: CachePushAck) => void) => () => void;
  /** Client 本机 HOME 目录，用于定位 ~/.claude 与 ~/.claude.json */
  homedir?: string;
  /** 进度回调；不传则不发事件，行为退化为静默同步 */
  onProgress?: (event: CacheSyncEvent) => void;
}

export interface CacheSyncOptions {
  deviceId: string;
  cwd: string;
  /** 单次等待 Server 响应的超时（manifest / 单个 ack），默认 60s */
  timeoutMs?: number;
  /** 流控水位，仅测试覆写；默认 MAX_INFLIGHT_BYTES */
  maxInflightBytes?: number;
}

export interface ScopeSyncSummary {
  scope: CacheScope;
  pushed: number;
  deleted: number;
  skippedLarge: number;
  truncated: boolean;
  totalLocal: number;
  /** 本次遇到的致命错误（Server ack 返回 ok=false / 超时），有值则表示该 scope 有失败 */
  error?: string;
}

interface LocalEntry {
  relPath: string;
  absPath: string;
  size: number;
  mtime: number;
}

interface ScopePlan {
  scope: CacheScope;
  uploads: Array<{ entry: CachePushEntry; displayPath: string }>;
  metaSkipped: CachePushEntry[];
  metaDeletes: string[];
  truncated: boolean;
  totalLocal: number;
}

/**
 * 执行完整的启动时缓存同步。失败不抛——降级为"无 Server 缓存"，FUSE 仍可穿透。
 */
export async function performInitialCacheSync(
  deps: CacheSyncDeps,
  options: CacheSyncOptions,
): Promise<ScopeSyncSummary[]> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxInflight = options.maxInflightBytes ?? MAX_INFLIGHT_BYTES;
  const homedir = deps.homedir ?? os.homedir();
  const emit = makeSafeEmit(deps.onProgress);

  // 1. handshake
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
    emit({ kind: "skipped", reason: `cache_manifest 等待失败: ${asErrorMessage(err)}` });
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

  // 2. 扫描所有 scope + 计算 plan
  emit({ kind: "scan_start" });
  const scanStartedAt = Date.now();
  const plans: ScopePlan[] = [];
  let totalLocalFiles = 0;
  let totalLocalBytes = 0;
  for (const scope of ALL_SCOPES) {
    try {
      const plan = await buildScopePlan({
        scope,
        homedir,
        remote: manifest.manifests[scope],
      });
      plans.push(plan);
      totalLocalFiles += plan.totalLocal;
      for (const u of plan.uploads) totalLocalBytes += u.entry.size;
      for (const s of plan.metaSkipped) totalLocalBytes += s.size;
    } catch (err) {
      log.warn("scope plan 构造失败", { scope, error: asErrorMessage(err) });
      plans.push({
        scope,
        uploads: [],
        metaSkipped: [],
        metaDeletes: [],
        truncated: false,
        totalLocal: 0,
      });
    }
  }
  emit({
    kind: "scan_done",
    totalFiles: totalLocalFiles,
    totalBytes: totalLocalBytes,
    elapsedMs: Date.now() - scanStartedAt,
  });

  // 3. 汇总待上传总量
  const totalUploadFiles = plans.reduce((acc, p) => acc + p.uploads.length, 0);
  const totalUploadBytes = plans.reduce(
    (acc, p) => acc + p.uploads.reduce((s, u) => s + u.entry.size, 0),
    0,
  );
  emit({ kind: "upload_start", totalFiles: totalUploadFiles, totalBytes: totalUploadBytes });

  // 4. pipeline 执行
  const uploadStartedAt = Date.now();
  const scopeSummaries = await pipelineUpload({
    plans,
    deps,
    deviceId: options.deviceId,
    cwd: options.cwd,
    timeoutMs,
    maxInflight,
    emit,
    totalUploadFiles,
  });

  emit({
    kind: "upload_done",
    totalFiles: totalUploadFiles,
    totalBytes: totalUploadBytes,
    elapsedMs: Date.now() - uploadStartedAt,
  });
  return scopeSummaries;
}

// ---------- Pipeline 执行 ----------

interface PipelineArgs {
  plans: ScopePlan[];
  deps: CacheSyncDeps;
  deviceId: string;
  cwd: string;
  timeoutMs: number;
  maxInflight: number;
  emit: (event: CacheSyncEvent) => void;
  totalUploadFiles: number;
}

interface InflightEntry {
  scope: CacheScope;
  displayPath: string;
  size: number;
  index: number;
  resolve: (ack: CachePushAck) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

async function pipelineUpload(args: PipelineArgs): Promise<ScopeSyncSummary[]> {
  const { plans, deps, deviceId, cwd, timeoutMs, maxInflight, emit, totalUploadFiles } = args;
  const summaries = new Map<CacheScope, ScopeSyncSummary>();
  for (const plan of plans) {
    summaries.set(plan.scope, {
      scope: plan.scope,
      pushed: 0,
      deleted: 0,
      skippedLarge: 0,
      truncated: plan.truncated,
      totalLocal: plan.totalLocal,
    });
  }

  let nextSeq = 1;
  const inFlight = new Map<number, InflightEntry>();
  let inFlightBytes = 0;

  /** 等待"in-flight 字节释放"信号的链表式 condition variable。 */
  let capacityWaiters: Array<() => void> = [];
  function notifyCapacity() {
    const waiters = capacityWaiters;
    capacityWaiters = [];
    for (const w of waiters) w();
  }
  async function waitForCapacity(bytesNeeded: number): Promise<void> {
    while (inFlight.size > 0 && inFlightBytes + bytesNeeded > maxInflight) {
      await new Promise<void>((resolve) => {
        capacityWaiters.push(resolve);
      });
    }
  }

  const unsubscribe = deps.subscribeAcks((ack) => {
    const entry = inFlight.get(ack.seq);
    if (!entry) {
      log.warn("收到未匹配的 cache_push_ack（可能 server bug 或 seq 重复）", {
        seq: ack.seq,
        scope: ack.scope,
      });
      return;
    }
    inFlight.delete(ack.seq);
    inFlightBytes -= entry.size;
    clearTimeout(entry.timer);
    entry.resolve(ack);
    notifyCapacity();
  });

  try {
    let globalIndex = 0;

    for (const plan of plans) {
      const summary = summaries.get(plan.scope)!;

      // ---- 元数据批（deletes + skipped）：等 ack，不进 pipeline 进度 ----
      if (plan.metaDeletes.length > 0 || plan.metaSkipped.length > 0) {
        const seq = nextSeq++;
        const metaPush: CachePush = {
          type: "cache_push",
          deviceId,
          cwd,
          scope: plan.scope,
          adds: plan.metaSkipped,
          deletes: plan.metaDeletes,
          seq,
          truncated: plan.truncated && plan.uploads.length === 0,
        };
        try {
          const ack = await registerAndSendInflight({
            push: metaPush,
            inFlight,
            sizeBytes: 0,
            timeoutMs,
            scope: plan.scope,
            displayPath: `[${plan.scope} meta]`,
            index: -1,
            sendMessage: deps.sendMessage,
            notifyCapacity,
          });
          if (!ack.ok) {
            summary.error = ack.error || "server ack failed (meta batch)";
            continue;
          }
          summary.deleted = plan.metaDeletes.length;
          summary.skippedLarge = plan.metaSkipped.length;
        } catch (err) {
          summary.error = asErrorMessage(err);
          continue;
        }
      }

      // ---- 逐文件 pipeline ----
      const fileFutures: Array<Promise<void>> = [];
      for (let i = 0; i < plan.uploads.length; i += 1) {
        const { entry, displayPath } = plan.uploads[i];
        const isLast = i === plan.uploads.length - 1;

        // 流控：等到有足够配额再发
        await waitForCapacity(entry.size);

        const seq = nextSeq++;
        const push: CachePush = {
          type: "cache_push",
          deviceId,
          cwd,
          scope: plan.scope,
          adds: [entry],
          deletes: [],
          seq,
          truncated: isLast ? plan.truncated : undefined,
        };

        const ackPromise = new Promise<CachePushAck>((resolve, reject) => {
          const timer = setTimeout(() => {
            if (inFlight.has(seq)) {
              const e = inFlight.get(seq)!;
              inFlight.delete(seq);
              inFlightBytes -= e.size;
              notifyCapacity();
              reject(new Error(`cache_push_ack 超时 seq=${seq}`));
            }
          }, timeoutMs);
          inFlight.set(seq, {
            scope: plan.scope,
            displayPath,
            size: entry.size,
            index: globalIndex,
            resolve,
            reject,
            timer,
          });
        });
        inFlightBytes += entry.size;

        const myIndex = globalIndex;
        emit({
          kind: "file_pushed",
          scope: plan.scope,
          displayPath,
          size: entry.size,
          seq,
          index: myIndex,
          total: totalUploadFiles,
        });

        // fire-and-forget 发送：send 失败也要把 in-flight 条目清理掉
        const sendPromise = deps.sendMessage(push).catch((err) => {
          if (inFlight.has(seq)) {
            const e = inFlight.get(seq)!;
            inFlight.delete(seq);
            inFlightBytes -= e.size;
            clearTimeout(e.timer);
            e.reject(err instanceof Error ? err : new Error(String(err)));
            notifyCapacity();
          }
        });

        // 异步等 ack 触发 file_acked + 更新 summary；不阻塞主循环
        fileFutures.push(
          (async () => {
            try {
              await sendPromise;
              const ack = await ackPromise;
              emit({
                kind: "file_acked",
                scope: plan.scope,
                displayPath,
                size: entry.size,
                seq,
                index: myIndex,
                total: totalUploadFiles,
                ok: ack.ok,
                error: ack.ok ? undefined : (ack.error || "server ack failed"),
              });
              if (ack.ok) {
                summary.pushed += 1;
              } else if (!summary.error) {
                summary.error = ack.error || "server ack failed";
              }
            } catch (err) {
              emit({
                kind: "file_acked",
                scope: plan.scope,
                displayPath,
                size: entry.size,
                seq,
                index: myIndex,
                total: totalUploadFiles,
                ok: false,
                error: asErrorMessage(err),
              });
              if (!summary.error) {
                summary.error = asErrorMessage(err);
              }
            }
          })(),
        );

        globalIndex += 1;
      }

      // 同 scope 的 push 全部发完之后再走下一个 scope，不等 ack。
      // ack 由长期 subscriber 异步处理；fileFutures 在最后统一 await。
      // 注意：跨 scope 的 push 会与上一 scope 的 ack 并发交叠，这正是 pipeline 收益所在。
      await Promise.all(fileFutures); // 该 scope 全部 ack 完成
    }
  } finally {
    unsubscribe();
    // 所有还没 settle 的 in-flight 条目（理论上 await Promise.all 后应该为空）：
    // 兜底清理 timer 防止泄漏
    for (const entry of inFlight.values()) {
      clearTimeout(entry.timer);
    }
  }

  return Array.from(summaries.values());
}

/**
 * 元数据批专用 helper：注册到 in-flight Map（size=0，不占流控）→ send → 等 ack。
 *
 * 与 pipeline 路径共享 in-flight Map 是为了让 ack subscriber 用单一路径派发；
 * size=0 保证不会反向影响主路径的流控水位。
 */
async function registerAndSendInflight(args: {
  push: CachePush;
  inFlight: Map<number, InflightEntry>;
  sizeBytes: number;
  timeoutMs: number;
  scope: CacheScope;
  displayPath: string;
  index: number;
  sendMessage: (msg: CachePush) => Promise<void>;
  notifyCapacity: () => void;
}): Promise<CachePushAck> {
  const { push, inFlight, sizeBytes, timeoutMs, scope, displayPath, index, sendMessage, notifyCapacity } = args;
  const seq = push.seq;
  const ackPromise = new Promise<CachePushAck>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (inFlight.has(seq)) {
        inFlight.delete(seq);
        notifyCapacity();
        reject(new Error(`cache_push_ack 超时 seq=${seq}`));
      }
    }, timeoutMs);
    inFlight.set(seq, {
      scope,
      displayPath,
      size: sizeBytes,
      index,
      resolve,
      reject,
      timer,
    });
  });
  try {
    await sendMessage(push);
  } catch (err) {
    if (inFlight.has(seq)) {
      const entry = inFlight.get(seq)!;
      inFlight.delete(seq);
      clearTimeout(entry.timer);
      notifyCapacity();
    }
    throw err;
  }
  return ackPromise;
}

// ---------- Plan 构造 ----------

interface BuildPlanArgs {
  scope: CacheScope;
  homedir: string;
  remote: CacheManifestData | undefined;
}

async function buildScopePlan(args: BuildPlanArgs): Promise<ScopePlan> {
  const { scope, homedir, remote } = args;
  const remoteEntries = remote?.entries ?? {};
  const locals = await scanLocalFiles(scope, homedir);

  const adds: CachePushEntry[] = [];
  for (const local of locals) {
    const remoteEntry = remoteEntries[local.relPath];
    if (!remoteEntry) {
      adds.push(await buildPushEntry(local));
      continue;
    }
    if (remoteEntry.size === local.size && remoteEntry.mtime === local.mtime) {
      continue;
    }
    adds.push(await buildPushEntry(local));
  }

  const deletes: string[] = [];
  const localPaths = new Set(locals.map((l) => l.relPath));
  for (const remotePath of Object.keys(remoteEntries)) {
    if (!localPaths.has(remotePath)) {
      deletes.push(remotePath);
    }
  }

  const { kept, truncatedAdds } = applyScopeBudget(adds);

  const uploads: Array<{ entry: CachePushEntry; displayPath: string }> = [];
  const metaSkipped: CachePushEntry[] = [];
  for (const entry of kept) {
    if (entry.skipped) {
      metaSkipped.push(entry);
    } else {
      uploads.push({ entry, displayPath: formatDisplayPath(scope, entry.path) });
    }
  }

  return {
    scope,
    uploads,
    metaSkipped,
    metaDeletes: deletes,
    truncated: truncatedAdds,
    totalLocal: locals.length,
  };
}

// ---------- 本地扫描 / 推送条目构造 ----------

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
      // ignore
    }
  }
}

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

// ---------- 工具函数 ----------

function formatDisplayPath(scope: CacheScope, relPath: string): string {
  if (scope === "claude-json") return "~/.claude.json";
  if (!relPath) return "~/.claude";
  return `~/.claude/${relPath}`;
}

function makeSafeEmit(
  cb: ((event: CacheSyncEvent) => void) | undefined,
): (event: CacheSyncEvent) => void {
  if (!cb) return () => {};
  return (event) => {
    try {
      cb(event);
    } catch (err) {
      log.warn("cache-sync onProgress 回调抛错，已忽略", {
        error: asErrorMessage(err),
        kind: event.kind,
      });
    }
  };
}

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

export async function __testOnlyBuildPushEntry(local: { relPath: string; absPath: string; size: number; mtime: number }): Promise<CachePushEntry> {
  return buildPushEntry(local);
}

export type { CacheEntry };
