import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "./logger.js";
import type { ScanCacheStore } from "./scan-cache.js";
import type {
  CacheManifestData,
  CacheScope,
  CacheTaskChange,
  CacheTaskDelta,
  CacheTaskDeltaAck,
  CacheTaskUpsertChange,
  ScopeWalkInstruction,
} from "./protocol.js";

const log = createLogger("cache-sync");

/** 单文件上限：超过则标记 skipped，仅同步元数据 */
export const MAX_FILE_BYTES = 1 * 1024 * 1024;
/** 单个 scope 总字节上限：超过则按 mtime 倒序截断 */
export const MAX_SCOPE_BYTES = 100 * 1024 * 1024;
/**
 * 保留给启动期 pipeline 的流控常量。
 * CacheTask v1 的 revision fencing 使 delta 实际上必须串行提交，但 UI 仍消费
 * file_pushed/file_acked 事件契约，因此常量继续导出供 capability / 兼容逻辑复用。
 */
export const MAX_INFLIGHT_BYTES = 16 * 1024 * 1024;

export const ALL_SCOPES: CacheScope[] = ["claude-home", "claude-json"];

export type CacheSyncEvent =
  | { kind: "skipped"; reason: string }
  | { kind: "scan_start" }
  | { kind: "walk_done"; totalFiles: number }
  | { kind: "hash_progress"; completedFiles: number; totalFiles: number }
  | { kind: "scan_done"; totalFiles: number; totalBytes: number; elapsedMs: number }
  | { kind: "upload_start"; totalFiles: number; totalBytes: number }
  | {
      kind: "file_pushed";
      scope: CacheScope;
      displayPath: string;
      size: number;
      seq: number;
      index: number;
      total: number;
    }
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
  | { kind: "upload_done"; totalFiles: number; totalBytes: number; elapsedMs: number; aborted?: boolean };

export interface LocalEntry {
  relPath: string;
  absPath: string;
  size: number;
  mtime: number;
}

export interface ScopePlan {
  scope: CacheScope;
  uploads: Array<{ change: CacheTaskUpsertChange; displayPath: string }>;
  metaChanges: CacheTaskChange[];
  truncated: boolean;
  totalLocal: number;
  cacheHits: number;
  cacheMisses: number;
}

export interface ScopeSyncSummary {
  scope: CacheScope;
  pushed: number;
  deleted: number;
  skippedLarge: number;
  truncated: boolean;
  totalLocal: number;
}

interface BuildPlanArgs extends ScanOptions {
  scope: CacheScope;
  homedir: string;
  remote: CacheManifestData | undefined;
  instruction?: ScopeWalkInstruction;
}

export interface ScanOptions {
  exclude?: (relPath: string) => boolean;
  scanCache?: ScanCacheStore;
  onHashProgress?: () => void;
  shouldAbort?: () => boolean;
}

export interface WalkScopeArgs {
  scope: CacheScope;
  homedir: string;
  instruction?: ScopeWalkInstruction;
  exclude?: (relPath: string) => boolean;
  shouldAbort?: () => boolean;
}

export interface HashScopeArgs {
  scope: CacheScope;
  locals: LocalEntry[];
  remote?: CacheManifestData;
  instruction?: ScopeWalkInstruction;
  scanCache?: ScanCacheStore;
  onHashProgress?: () => void;
  shouldAbort?: () => boolean;
}

interface PendingAck {
  sizeBytes: number;
  resolve: (ack: CacheTaskDeltaAck) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface InitialDeltaPipelineOptions {
  assignmentId: string;
  baseRevision: number;
  plans: ScopePlan[];
  sendDelta: (delta: CacheTaskDelta) => Promise<void>;
  subscribeAcks: (handler: (ack: CacheTaskDeltaAck) => void) => () => void;
  abortSignal?: AbortSignal;
  shouldAbort?: () => boolean;
  timeoutMs?: number;
  maxInflightBytes?: number;
  onProgress?: (event: CacheSyncEvent) => void;
  now?: () => number;
  createBatchId?: () => string;
}

export interface InitialDeltaPipelineResult {
  baseRevision: number;
  summaries: ScopeSyncSummary[];
}

export class CacheTaskDeltaAckError extends Error {
  readonly ack: CacheTaskDeltaAck;

  constructor(ack: CacheTaskDeltaAck) {
    super(ack.error || ack.errorCode || "cache_task_delta_ack failed");
    this.name = "CacheTaskDeltaAckError";
    this.ack = ack;
  }
}

export class InitialSyncAbortedError extends Error {
  constructor() {
    super("initial cache sync aborted");
    this.name = "InitialSyncAbortedError";
  }
}

export async function pushInitialDeltaBatches(
  options: InitialDeltaPipelineOptions,
): Promise<InitialDeltaPipelineResult> {
  const emit = makeSafeEmit(options.onProgress);
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxInflightBytes = options.maxInflightBytes ?? MAX_INFLIGHT_BYTES;
  const now = options.now ?? (() => Date.now());
  const createBatchId = options.createBatchId ?? randomUUID;
  const summaries = new Map<CacheScope, ScopeSyncSummary>();

  for (const plan of options.plans) {
    const deleted = plan.metaChanges.filter((change) => change.kind === "delete").length;
    const skippedLarge = plan.metaChanges.filter(
      (change) => change.kind === "upsert" && change.skipped,
    ).length;
    summaries.set(plan.scope, {
      scope: plan.scope,
      pushed: 0,
      deleted,
      skippedLarge,
      truncated: plan.truncated,
      totalLocal: plan.totalLocal,
    });
  }

  const totalUploadFiles = options.plans.reduce((count, plan) => count + plan.uploads.length, 0);
  const totalUploadBytes = options.plans.reduce(
    (sum, plan) => sum + plan.uploads.reduce((scopeSum, item) => scopeSum + item.change.size, 0),
    0,
  );
  emit({ kind: "upload_start", totalFiles: totalUploadFiles, totalBytes: totalUploadBytes });
  const uploadStartedAt = now();

  const pendingAcks = new Map<string, PendingAck>();
  let inFlightBytes = 0;
  let capacityWaiters: Array<() => void> = [];
  let unsubscribe = () => {};
  let aborted = false;
  const fatalAbortError = new InitialSyncAbortedError();

  function isAborted(): boolean {
    return options.abortSignal?.aborted === true || options.shouldAbort?.() === true;
  }

  function notifyCapacity(): void {
    const waiters = capacityWaiters;
    capacityWaiters = [];
    for (const waiter of waiters) {
      waiter();
    }
  }

  function takePending(batchId: string): PendingAck | undefined {
    const pending = pendingAcks.get(batchId);
    if (!pending) {
      return undefined;
    }
    pendingAcks.delete(batchId);
    clearTimeout(pending.timer);
    inFlightBytes -= pending.sizeBytes;
    notifyCapacity();
    return pending;
  }

  function rejectAllPending(error: Error): void {
    for (const batchId of Array.from(pendingAcks.keys())) {
      const pending = takePending(batchId);
      pending?.reject(error);
    }
  }

  function throwIfAborted(): void {
    if (isAborted()) {
      aborted = true;
      rejectAllPending(fatalAbortError);
      throw fatalAbortError;
    }
  }

  async function waitForCapacity(bytesNeeded: number): Promise<void> {
    while (pendingAcks.size > 0 && inFlightBytes + bytesNeeded > maxInflightBytes) {
      throwIfAborted();
      await new Promise<void>((resolve) => {
        capacityWaiters.push(resolve);
      });
    }
    throwIfAborted();
  }

  const handleAbort = (): void => {
    aborted = true;
    rejectAllPending(fatalAbortError);
    unsubscribe();
  };

  unsubscribe = options.subscribeAcks((ack) => {
    const pending = pendingAcks.get(ack.batchId);
    if (!pending) {
      return;
    }
    takePending(ack.batchId);
    pending.resolve(ack);
  });
  options.abortSignal?.addEventListener("abort", handleAbort, { once: true });

  let uiSeq = 1;
  let globalIndex = 0;
  let revision = options.baseRevision;

  try {
    for (const plan of options.plans) {
      throwIfAborted();
      if (plan.metaChanges.length > 0) {
        const ack = await registerPendingAck({
          assignmentId: options.assignmentId,
          baseRevision: revision,
          changes: plan.metaChanges,
          sendDelta: options.sendDelta,
          pendingAcks,
          releasePending: takePending,
          onRegistered: (sizeBytes) => {
            inFlightBytes += sizeBytes;
          },
          timeoutMs,
          createBatchId,
          mode: "initial",
          now,
          sizeBytes: 0,
        });
        throwIfAborted();
        if (!ack.ok) {
          throw new CacheTaskDeltaAckError(ack);
        }
        revision = nextRevision(revision, ack);
      }

      const summary = summaries.get(plan.scope)!;
      let nextBaseRevision = revision;
      const fileFutures: Array<Promise<number>> = [];
      for (const upload of plan.uploads) {
        await waitForCapacity(upload.change.size);
        const seq = uiSeq++;
        const index = globalIndex;
        const baseRevision = nextBaseRevision;
        nextBaseRevision += 1;
        emit({
          kind: "file_pushed",
          scope: plan.scope,
          displayPath: upload.displayPath,
          size: upload.change.size,
          seq,
          index,
          total: totalUploadFiles,
        });

        fileFutures.push((async () => {
          try {
            const ack = await registerPendingAck({
              assignmentId: options.assignmentId,
              baseRevision,
              changes: [upload.change],
              sendDelta: options.sendDelta,
              pendingAcks,
              releasePending: takePending,
              onRegistered: (sizeBytes) => {
                inFlightBytes += sizeBytes;
              },
              timeoutMs,
              createBatchId,
              mode: "initial",
              now,
              sizeBytes: upload.change.size,
            });
            if (!ack.ok) {
              throw new CacheTaskDeltaAckError(ack);
            }
            summary.pushed += 1;
            emit({
              kind: "file_acked",
              scope: plan.scope,
              displayPath: upload.displayPath,
              size: upload.change.size,
              seq,
              index,
              total: totalUploadFiles,
              ok: true,
            });
            return nextRevision(baseRevision, ack);
          } catch (error) {
            emit({
              kind: "file_acked",
              scope: plan.scope,
              displayPath: upload.displayPath,
              size: upload.change.size,
              seq,
              index,
              total: totalUploadFiles,
              ok: false,
              error: asErrorMessage(error),
            });
            if (error instanceof InitialSyncAbortedError) {
              aborted = true;
            } else {
              rejectAllPending(error instanceof Error ? error : new Error(String(error)));
            }
            throw error;
          }
        })());
        globalIndex += 1;
      }

      // 用 allSettled 而非 all：fileFuture 失败时（任意 ack.ok=false）catch 块会 rejectAllPending，
      // 把同批其它 future 一并 reject。Promise.all 只 await 第一个 reject，剩下的 rejected promise
      // 没人消费 → Node 25 默认 --unhandled-rejections=throw → 进程 crash。
      // allSettled 保证每个 future 都被 await，第一个 rejected 取出 reason 抛上去走 finally cleanup。
      const settled = await Promise.allSettled(fileFutures);
      const firstRejected = settled.find(
        (entry): entry is PromiseRejectedResult => entry.status === "rejected",
      );
      if (firstRejected) {
        throw firstRejected.reason;
      }
      const settledRevisions = settled
        .map((entry) => (entry as PromiseFulfilledResult<number>).value);
      if (settledRevisions.length > 0) {
        revision = Math.max(revision, ...settledRevisions);
      }
    }
  } finally {
    unsubscribe();
    options.abortSignal?.removeEventListener("abort", handleAbort);
    for (const pending of pendingAcks.values()) {
      clearTimeout(pending.timer);
    }
    pendingAcks.clear();
    inFlightBytes = 0;
    notifyCapacity();
    emit({
      kind: "upload_done",
      totalFiles: totalUploadFiles,
      totalBytes: totalUploadBytes,
      elapsedMs: now() - uploadStartedAt,
      aborted,
    });
  }

  throwIfAborted();
  return {
    baseRevision: revision,
    summaries: Array.from(summaries.values()),
  };
}

async function registerPendingAck(args: {
  assignmentId: string;
  baseRevision: number;
  changes: CacheTaskChange[];
  sendDelta: (delta: CacheTaskDelta) => Promise<void>;
  pendingAcks: Map<string, PendingAck>;
  releasePending: (batchId: string) => PendingAck | undefined;
  onRegistered: (sizeBytes: number) => void;
  timeoutMs: number;
  createBatchId: () => string;
  mode: CacheTaskDelta["mode"];
  now: () => number;
  sizeBytes: number;
}): Promise<CacheTaskDeltaAck> {
  const batchId = args.createBatchId();
  const delta: CacheTaskDelta = {
    type: "cache_task_delta",
    assignmentId: args.assignmentId,
    batchId,
    baseRevision: args.baseRevision,
    mode: args.mode,
    changes: args.changes,
    sentAt: args.now(),
  };

  const ackPromise = new Promise<CacheTaskDeltaAck>((resolve, reject) => {
    const timer = setTimeout(() => {
      const pending = args.releasePending(batchId);
      if (!pending) {
        return;
      }
      reject(new Error(`cache_task_delta_ack 超时 batchId=${batchId}`));
    }, args.timeoutMs);
    args.pendingAcks.set(batchId, {
      sizeBytes: args.sizeBytes,
      resolve,
      reject,
      timer,
    });
    args.onRegistered(args.sizeBytes);
  });

  try {
    await args.sendDelta(delta);
  } catch (error) {
    const pending = args.releasePending(batchId);
    if (pending) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
    throw error;
  }
  return ackPromise;
}

export async function buildScopePlan(args: BuildPlanArgs): Promise<ScopePlan> {
  const locals = await walkScope(args);
  return hashScope({
    scope: args.scope,
    locals,
    remote: args.remote,
    instruction: args.instruction,
    scanCache: args.scanCache,
    onHashProgress: args.onHashProgress,
    shouldAbort: args.shouldAbort,
  });
}

export async function walkScope(args: WalkScopeArgs): Promise<LocalEntry[]> {
  const instruction = args.instruction ?? WHOLE_SCOPE_INSTRUCTION;
  if (instruction.exactFilesAbs) {
    return scanExactFilesAbs(instruction.exactFilesAbs, args.exclude, args.shouldAbort);
  }
  if (isWholeScopeInstruction(instruction)) {
    return scanLocalFiles(args.scope, args.homedir, args.exclude, args.shouldAbort);
  }
  return scanInstructionFiles(args.scope, args.homedir, instruction, args.exclude, args.shouldAbort);
}

export async function hashScope(args: HashScopeArgs): Promise<ScopePlan> {
  const remoteEntries = args.remote?.entries ?? {};
  const localPaths = new Set(args.locals.map((entry) => entry.relPath));
  const instruction = args.instruction ?? WHOLE_SCOPE_INSTRUCTION;
  args.scanCache?.pruneToPresent(args.scope, localPaths);

  const adds: CacheTaskUpsertChange[] = [];
  let cacheHits = 0;
  let cacheMisses = 0;
  for (const local of args.locals) {
    if (args.shouldAbort?.()) {
      break;
    }
    const remoteEntry = remoteEntries[local.relPath];
    if (remoteEntry && remoteEntry.size === local.size && remoteEntry.mtime === local.mtime) {
      args.onHashProgress?.();
      continue;
    }
    const { change, cacheHit } = await buildUpsertChange(args.scope, local, args.scanCache);
    adds.push(change);
    if (!change.skipped) {
      if (cacheHit) {
        cacheHits += 1;
      } else {
        cacheMisses += 1;
      }
    }
    args.onHashProgress?.();
  }

  const deletes: CacheTaskChange[] = [];
  for (const remotePath of Object.keys(remoteEntries)) {
    if (!localPaths.has(remotePath) && isPathCoveredByInstruction(remotePath, instruction)) {
      deletes.push({
        kind: "delete",
        scope: args.scope,
        path: remotePath,
      });
    }
  }

  const { kept, truncatedAdds } = applyScopeBudget(adds);
  const uploads: Array<{ change: CacheTaskUpsertChange; displayPath: string }> = [];
  const metaChanges = [...deletes];

  for (const change of kept) {
    if (change.skipped) {
      metaChanges.push(change);
      continue;
    }
    uploads.push({
      change,
      displayPath: formatDisplayPath(args.scope, change.path),
    });
  }

  return {
    scope: args.scope,
    uploads,
    metaChanges,
    truncated: truncatedAdds,
    totalLocal: args.locals.length,
    cacheHits,
    cacheMisses,
  };
}

const WHOLE_SCOPE_INSTRUCTION: ScopeWalkInstruction = {
  subtrees: [],
  files: [],
  knownMissing: [],
};

async function scanExactFilesAbs(
  files: string[],
  exclude?: (relPath: string) => boolean,
  shouldAbort?: () => boolean,
): Promise<LocalEntry[]> {
  const results: LocalEntry[] = [];
  for (const absPath of files) {
    if (shouldAbort?.()) break;
    if (exclude?.(absPath)) continue;
    try {
      const stats = await stat(absPath);
      if (!stats.isFile()) continue;
      results.push({
        relPath: absPath,
        absPath,
        size: stats.size,
        mtime: Math.floor(stats.mtimeMs),
      });
    } catch {
      // Missing exact files are represented by absence from locals; hashScope
      // emits delete only when the remote manifest previously had that key.
    }
  }
  return results;
}

export async function scanLocalFiles(
  scope: CacheScope,
  homedir: string,
  exclude?: (relPath: string) => boolean,
  shouldAbort?: () => boolean,
): Promise<LocalEntry[]> {
  if (scope === "claude-json") {
    const abs = path.join(homedir, ".claude.json");
    if (!existsSync(abs)) {
      return [];
    }
    try {
      const stats = await stat(abs);
      if (!stats.isFile()) {
        return [];
      }
      return [{
        relPath: "",
        absPath: abs,
        size: stats.size,
        mtime: Math.floor(stats.mtimeMs),
      }];
    } catch {
      return [];
    }
  }

  const rootAbs = path.join(homedir, ".claude");
  if (!existsSync(rootAbs)) {
    return [];
  }

  const results: LocalEntry[] = [];
  await walkDir(rootAbs, rootAbs, results, exclude, shouldAbort);
  return results;
}

async function walkDir(
  root: string,
  current: string,
  out: LocalEntry[],
  exclude?: (relPath: string) => boolean,
  shouldAbort?: () => boolean,
  knownMissing?: Set<string>,
  maxDepth = -1,
  currentDepth = 0,
): Promise<void> {
  if (shouldAbort?.()) {
    return;
  }

  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (shouldAbort?.()) {
      return;
    }
    const abs = path.join(current, entry.name);
    const relPath = path.relative(root, abs).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (exclude?.(relPath)) {
        continue;
      }
      if (maxDepth < 0 || currentDepth < maxDepth) {
        await walkDir(root, abs, out, exclude, shouldAbort, knownMissing, maxDepth, currentDepth + 1);
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (exclude?.(relPath)) {
      continue;
    }
    if (knownMissing?.has(relPath)) {
      continue;
    }
    try {
      const stats = await stat(abs);
      out.push({
        relPath,
        absPath: abs,
        size: stats.size,
        mtime: Math.floor(stats.mtimeMs),
      });
    } catch {
      // ignore
    }
  }
}

async function scanInstructionFiles(
  scope: CacheScope,
  homedir: string,
  instruction: ScopeWalkInstruction,
  exclude?: (relPath: string) => boolean,
  shouldAbort?: () => boolean,
): Promise<LocalEntry[]> {
  const knownMissing = new Set(instruction.knownMissing.map(normalizeInstructionPath));
  if (scope === "claude-json") {
    if (knownMissing.has("")) {
      return [];
    }
    return scanInstructionFile(path.join(homedir, ".claude.json"), "", exclude, shouldAbort);
  }

  const rootAbs = path.join(homedir, ".claude");
  const results = new Map<string, LocalEntry>();
  for (const subtree of instruction.subtrees) {
    if (shouldAbort?.()) {
      break;
    }
    const relPath = normalizeInstructionPath(subtree.relPath);
    if (exclude?.(relPath)) {
      continue;
    }
    const subtreeAbs = path.join(rootAbs, relPath);
    const subtreeResults: LocalEntry[] = [];
    await walkDir(rootAbs, subtreeAbs, subtreeResults, exclude, shouldAbort, knownMissing, subtree.maxDepth);
    for (const entry of subtreeResults) {
      results.set(entry.relPath, entry);
    }
  }
  for (const relPath of instruction.files.map(normalizeInstructionPath)) {
    if (shouldAbort?.()) {
      break;
    }
    if (knownMissing.has(relPath)) {
      continue;
    }
    for (const entry of await scanInstructionFile(path.join(rootAbs, relPath), relPath, exclude, shouldAbort)) {
      results.set(entry.relPath, entry);
    }
  }
  return Array.from(results.values());
}

async function scanInstructionFile(
  absPath: string,
  relPath: string,
  exclude?: (relPath: string) => boolean,
  shouldAbort?: () => boolean,
): Promise<LocalEntry[]> {
  if (shouldAbort?.() || exclude?.(relPath)) {
    return [];
  }
  try {
    const stats = await stat(absPath);
    if (!stats.isFile()) {
      return [];
    }
    return [{
      relPath,
      absPath,
      size: stats.size,
      mtime: Math.floor(stats.mtimeMs),
    }];
  } catch {
    return [];
  }
}

function isWholeScopeInstruction(instruction: ScopeWalkInstruction): boolean {
  return instruction.subtrees.length === 0 && instruction.files.length === 0 && instruction.knownMissing.length === 0;
}

function isPathCoveredByInstruction(relPath: string, instruction: ScopeWalkInstruction): boolean {
  if (isWholeScopeInstruction(instruction)) {
    return true;
  }
  if (instruction.exactFilesAbs?.includes(relPath)) {
    return true;
  }
  const normalized = normalizeInstructionPath(relPath);
  if (instruction.files.map(normalizeInstructionPath).includes(normalized)) {
    return true;
  }
  if (instruction.knownMissing.map(normalizeInstructionPath).includes(normalized)) {
    return true;
  }
  return instruction.subtrees.some((subtree) => isPathWithinSubtree(
    normalized,
    normalizeInstructionPath(subtree.relPath),
    subtree.maxDepth,
  ));
}

function isPathWithinSubtree(relPath: string, subtree: string, maxDepth: number): boolean {
  if (!(subtree === "" || relPath === subtree || relPath.startsWith(`${subtree}/`))) {
    return false;
  }
  if (maxDepth < 0) {
    return true;
  }
  const remaining = subtree === "" ? relPath : relPath.slice(subtree.length).replace(/^\/+/, "");
  const depth = remaining === "" ? 0 : remaining.split("/").length;
  return depth <= maxDepth + 1;
}

function normalizeInstructionPath(relPath: string): string {
  return relPath.split(path.sep).join("/").replace(/^\/+|\/+$/g, "");
}

async function buildUpsertChange(
  scope: CacheScope,
  local: LocalEntry,
  scanCache?: ScanCacheStore,
): Promise<{ change: CacheTaskUpsertChange; cacheHit: boolean }> {
  if (local.size > MAX_FILE_BYTES) {
    return {
      cacheHit: false,
      change: {
        kind: "upsert",
        scope,
        path: local.relPath,
        size: local.size,
        mtime: local.mtime,
        sha256: null,
        skipped: true,
      },
    };
  }

  const buffer = await readFile(local.absPath);
  const cachedSha = scanCache?.lookup(scope, local.relPath, local.size, local.mtime);
  const sha256 = cachedSha ?? createHash("sha256").update(buffer).digest("hex");
  if (!cachedSha) {
    scanCache?.upsert(scope, local.relPath, {
      size: local.size,
      mtime: local.mtime,
      sha256,
    });
  }
  return {
    cacheHit: Boolean(cachedSha),
    change: {
      kind: "upsert",
      scope,
      path: local.relPath,
      size: local.size,
      mtime: local.mtime,
      sha256,
      contentBase64: buffer.toString("base64"),
    },
  };
}

export function applyScopeBudget<T extends { size: number; mtime: number; skipped?: boolean }>(
  adds: T[],
): { kept: T[]; truncatedAdds: boolean } {
  const kept: T[] = [];
  let usedBytes = 0;
  let truncatedAdds = false;

  for (const entry of [...adds].sort((a, b) => b.mtime - a.mtime)) {
    if (entry.skipped) {
      kept.push(entry);
      continue;
    }
    if (usedBytes + entry.size > MAX_SCOPE_BYTES) {
      truncatedAdds = true;
      continue;
    }
    usedBytes += entry.size;
    kept.push(entry);
  }

  return { kept, truncatedAdds };
}

function formatDisplayPath(scope: CacheScope, relPath: string): string {
  if (scope === "cwd-ancestor-md") {
    return relPath;
  }
  if (scope === "claude-json") {
    return "~/.claude.json";
  }
  return relPath ? `~/.claude/${relPath}` : "~/.claude";
}

function nextRevision(previous: number, ack: CacheTaskDeltaAck): number {
  if (typeof ack.appliedRevision === "number") {
    return ack.appliedRevision;
  }
  return previous + 1;
}

function makeSafeEmit(
  cb: ((event: CacheSyncEvent) => void) | undefined,
): (event: CacheSyncEvent) => void {
  if (!cb) {
    return () => {};
  }
  return (event) => {
    try {
      cb(event);
    } catch (error) {
      log.warn("cache-sync onProgress 回调抛错，已忽略", {
        kind: event.kind,
        error: asErrorMessage(error),
      });
    }
  };
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
