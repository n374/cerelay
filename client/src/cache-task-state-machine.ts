import os from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import {
  ALL_SCOPES,
  CacheTaskDeltaAckError,
  MAX_FILE_BYTES,
  MAX_INFLIGHT_BYTES,
  hashScope,
  pushInitialDeltaBatches,
  type CacheSyncEvent,
  type InitialDeltaPipelineResult,
  type LocalEntry,
  type ScopePlan,
  walkScope,
} from "./cache-sync.js";
import {
  CacheWatcher,
  DEFAULT_SUPPRESS_TTL_MS,
  type CacheWatcherFault,
} from "./cache-watcher.js";
import { createExcludeMatcher, type CerelayConfig } from "./config.js";
import { createLogger } from "./logger.js";
import type { ScanCacheStore } from "./scan-cache.js";
import type {
  CacheTaskAssignment,
  CacheTaskChange,
  CacheTaskDelta,
  CacheTaskDeltaAck,
  CacheTaskFault,
  CacheTaskHeartbeat,
  CacheTaskMutationHint,
  CacheTaskSyncComplete,
  ClientHello,
  HandToServerMessage,
} from "./protocol.js";

const log = createLogger("cache-task-sm");

export type CacheTaskState =
  | "disconnected"
  | "connected-passive"
  | "assigned-syncing"
  | "assigned-watching";

export interface CacheTaskStateMachineOptions {
  cwd: string;
  deviceId: string;
  config?: CerelayConfig;
  scanCache?: ScanCacheStore;
  homedir?: string;
  debounceMs?: number;
  disableCacheTask?: boolean;
  suppressTtlMs?: number;
  ackTimeoutMs?: number;
  onProgress?: (event: CacheSyncEvent) => void;
  watcherFactory?: (callbacks: {
    onChanges: (changes: CacheTaskChange[]) => void | Promise<void>;
    onFault: (fault: CacheWatcherFault) => void | Promise<void>;
    exclude: (relPath: string) => boolean;
  }) => CacheWatcherLike;
  walkScope?: typeof walkScope;
  hashScope?: typeof hashScope;
  pushInitialDeltaBatches?: (options: Parameters<typeof pushInitialDeltaBatches>[0]) => Promise<InitialDeltaPipelineResult>;
  now?: () => number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  createBatchId?: () => string;
}

export interface CacheWatcherLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  flushNow(): Promise<void>;
  suppressPaths(paths: Array<{ absPath: string; mutationId: string }>, ttlMs: number): void;
  clearSuppressor(): void;
}

type CacheTaskMessage =
  | CacheTaskAssignment
  | CacheTaskDeltaAck
  | CacheTaskMutationHint
  | { type: "cache_task_heartbeat_ack" };

type SendFn = (message: HandToServerMessage) => Promise<void>;

export class CacheTaskStateMachine {
  private readonly cwd: string;
  private readonly deviceId: string;
  private readonly config: CerelayConfig;
  private readonly scanCache?: ScanCacheStore;
  private readonly exclude: (relPath: string) => boolean;
  private readonly homedir: string;
  private readonly debounceMs: number;
  private readonly disableCacheTask: boolean;
  private readonly suppressTtlMs: number;
  private readonly ackTimeoutMs: number;
  private readonly onProgress?: (event: CacheSyncEvent) => void;
  private readonly watcherFactory: NonNullable<CacheTaskStateMachineOptions["watcherFactory"]>;
  private readonly walkScopeImpl: typeof walkScope;
  private readonly hashScopeImpl: typeof hashScope;
  private readonly pushInitialDeltaBatchesImpl: NonNullable<CacheTaskStateMachineOptions["pushInitialDeltaBatches"]>;
  private readonly now: () => number;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly createBatchId: () => string;
  private readonly ackSubscribers = new Set<(ack: CacheTaskDeltaAck) => void>();
  private readonly bufferedChanges = new Map<string, CacheTaskChange>();
  private readonly pendingLiveChanges = new Map<string, CacheTaskChange>();
  private state: CacheTaskState = "disconnected";
  private send: SendFn | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatIntervalMs = 5_000;
  private watcher: CacheWatcherLike | null = null;
  private assignment: CacheTaskAssignment | null = null;
  private revision = 0;
  private generation = 0;
  private liveDrain: Promise<void> | null = null;
  private watcherHealth: CacheTaskHeartbeat["watcherHealth"] = "ok";
  private lastFlushAt: number | undefined;
  private initialSyncAbortController: AbortController | null = null;

  constructor(options: CacheTaskStateMachineOptions) {
    this.cwd = options.cwd;
    this.deviceId = options.deviceId;
    this.config = options.config ?? { scan: { excludeDirs: [] } };
    this.scanCache = options.scanCache;
    this.exclude = createExcludeMatcher(this.config.scan.excludeDirs);
    this.homedir = options.homedir ?? os.homedir();
    this.debounceMs = options.debounceMs ?? 250;
    this.disableCacheTask = options.disableCacheTask ?? isCacheTaskDisabled();
    this.suppressTtlMs = options.suppressTtlMs ?? DEFAULT_SUPPRESS_TTL_MS;
    this.ackTimeoutMs = options.ackTimeoutMs ?? 60_000;
    this.onProgress = options.onProgress;
    this.walkScopeImpl = options.walkScope ?? walkScope;
    this.hashScopeImpl = options.hashScope ?? hashScope;
    this.pushInitialDeltaBatchesImpl = options.pushInitialDeltaBatches ?? pushInitialDeltaBatches;
    this.now = options.now ?? (() => Date.now());
    this.setIntervalFn = options.setIntervalFn ?? setInterval;
    this.clearIntervalFn = options.clearIntervalFn ?? clearInterval;
    this.setTimeoutFn = setTimeout;
    this.clearTimeoutFn = clearTimeout;
    this.createBatchId = options.createBatchId ?? randomUUID;
    this.watcherFactory = options.watcherFactory ?? ((callbacks) => new CacheWatcher({
      homedir: this.homedir,
      exclude: callbacks.exclude,
      debounceMs: this.debounceMs,
      onChanges: callbacks.onChanges,
      onFault: callbacks.onFault,
    }));
  }

  getState(): CacheTaskState {
    return this.state;
  }

  async onConnected(send: SendFn): Promise<void> {
    this.send = send;
    this.state = "connected-passive";

    if (this.disableCacheTask) {
      log.debug("cache task disabled by env, keep passive");
      return;
    }

    const hello: ClientHello = {
      type: "client_hello",
      deviceId: this.deviceId,
      cwd: this.cwd,
      capabilities: {
        cacheTaskV1: {
          protocolVersion: 1,
          maxFileBytes: MAX_FILE_BYTES,
          maxBatchBytes: MAX_INFLIGHT_BYTES,
          debounceMs: this.debounceMs,
          watcherBackend: "chokidar",
        },
      },
    };
    await this.sendMessage(hello);
  }

  async onDisconnected(): Promise<void> {
    this.generation += 1;
    this.abortInitialSync();
    this.stopHeartbeatTimer();
    await this.stopWatcher();
    this.assignment = null;
    this.heartbeatIntervalMs = 5_000;
    this.revision = 0;
    this.watcherHealth = "ok";
    this.lastFlushAt = undefined;
    this.bufferedChanges.clear();
    this.pendingLiveChanges.clear();
    this.ackSubscribers.clear();
    this.liveDrain = null;
    this.send = null;
    this.state = "disconnected";
  }

  async onMessage(message: CacheTaskMessage): Promise<void> {
    switch (message.type) {
      case "cache_task_assignment":
        if (message.role === "inactive") {
          await this.transitionToPassive();
          return;
        }
        await this.handleActiveAssignment(message);
        return;
      case "cache_task_delta_ack":
        this.dispatchAck(message);
        if (!message.ok && this.isTaskTokenMismatch(message)) {
          await this.transitionToPassive();
        }
        return;
      case "cache_task_mutation_hint":
        this.handleMutationHint(message);
        return;
      case "cache_task_heartbeat_ack":
        return;
    }
  }

  private async handleActiveAssignment(message: CacheTaskAssignment): Promise<void> {
    if (!message.manifest) {
      await this.sendFault({
        code: "INTERNAL_ERROR",
        fatal: true,
        message: "active assignment 缺少 manifest",
      });
      await this.transitionToPassive();
      return;
    }

    this.generation += 1;
    const generation = this.generation;
    this.abortInitialSync();
    await this.stopWatcher();
    this.assignment = message;
    this.heartbeatIntervalMs = message.heartbeatIntervalMs;
    this.revision = message.manifest.revision;
    this.bufferedChanges.clear();
    this.pendingLiveChanges.clear();
    this.watcherHealth = "ok";
    this.lastFlushAt = undefined;
    this.state = "assigned-syncing";
    this.startHeartbeatTimer();

    const watcher = this.watcherFactory({
      onChanges: (changes) => this.handleWatcherChanges(changes),
      onFault: (fault) => this.handleWatcherFault(fault),
      exclude: this.exclude,
    });
    this.watcher = watcher;

    try {
      await watcher.start();
      await this.runInitialSync(message, generation);
    } catch (error) {
      // Cache sync 失败一律降级为"无缓存继续"——CLAUDE.md 明确写过缓存同步失败不阻塞 PTY session，
      // FUSE 读请求会回穿到 Client。但绝不能静默吞：异常以 error 级别打全堆栈，必要细节（ack.errorCode、
      // ack.error）一并暴露，方便日志层排查。注意不要 throw，否则 client.ts 那条 void onMessage 链会
      // 变成 unhandled rejection 把进程拉崩。
      log.error("cache task initial sync 失败，降级为无缓存继续", {
        assignmentId: message.assignmentId,
        deviceId: this.deviceId,
        cwd: this.cwd,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: asErrorMessage(error),
        ackErrorCode: error instanceof CacheTaskDeltaAckError ? error.ack.errorCode : undefined,
        ackErrorMessage: error instanceof CacheTaskDeltaAckError ? error.ack.error : undefined,
        ackResyncRequired: error instanceof CacheTaskDeltaAckError ? error.ack.resyncRequired : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      });
      if (!this.isGenerationCurrent(generation, message.assignmentId)) {
        return;
      }
      if (error instanceof CacheTaskDeltaAckError) {
        await this.transitionToPassive();
        return;
      }
      await this.sendFault({
        code: "LOCAL_SCAN_FAILED",
        fatal: true,
        message: asErrorMessage(error),
      });
      await this.transitionToPassive();
    }
  }

  private async runInitialSync(message: CacheTaskAssignment, generation: number): Promise<void> {
    const abortController = this.replaceInitialSyncAbortController();
    const scanStartedAt = this.now();
    this.onProgress?.({ kind: "scan_start" });

    const walkedScopes: Array<{ scope: (typeof ALL_SCOPES)[number]; locals: LocalEntry[] }> = [];
    let totalFiles = 0;
    for (const scope of ALL_SCOPES) {
      const locals = await this.walkScopeImpl({
        scope,
        homedir: this.homedir,
        exclude: this.exclude,
        shouldAbort: () => !this.isGenerationCurrent(generation, message.assignmentId),
      });
      walkedScopes.push({ scope, locals });
      totalFiles += locals.length;
      if (!this.isGenerationCurrent(generation, message.assignmentId)) {
        return;
      }
    }

    this.onProgress?.({ kind: "walk_done", totalFiles });

    const plans: ScopePlan[] = [];
    let totalBytes = 0;
    let completedFiles = 0;
    for (const walked of walkedScopes) {
      const plan = await this.hashScopeImpl({
        scope: walked.scope,
        locals: walked.locals,
        remote: message.manifest?.scopes[walked.scope],
        scanCache: this.scanCache,
        shouldAbort: () => !this.isGenerationCurrent(generation, message.assignmentId),
        onHashProgress: () => {
          completedFiles += 1;
          this.onProgress?.({
            kind: "hash_progress",
            completedFiles,
            totalFiles,
          });
        },
      });
      plans.push(plan);
      totalBytes += plan.uploads.reduce((sum, item) => sum + item.change.size, 0);
      totalBytes += plan.metaChanges.reduce(
        (sum, change) => sum + (change.kind === "upsert" ? change.size : 0),
        0,
      );
      if (!this.isGenerationCurrent(generation, message.assignmentId)) {
        return;
      }
    }

    this.onProgress?.({
      kind: "scan_done",
      totalFiles,
      totalBytes,
      elapsedMs: this.now() - scanStartedAt,
    });

    await this.flushScanCache();

    if (!this.isGenerationCurrent(generation, message.assignmentId)) {
      return;
    }

    const initialResult = await this.pushInitialDeltaBatchesImpl({
      assignmentId: message.assignmentId,
      baseRevision: message.manifest!.revision,
      plans,
      sendDelta: (delta) => this.sendMessage(delta),
      subscribeAcks: (handler) => this.subscribeAcks(handler),
      abortSignal: abortController.signal,
      shouldAbort: () => !this.isGenerationCurrent(generation, message.assignmentId),
      timeoutMs: this.ackTimeoutMs,
      onProgress: this.onProgress,
      now: this.now,
      createBatchId: this.createBatchId,
    });
    this.revision = initialResult.baseRevision;
    if (this.initialSyncAbortController === abortController) {
      this.initialSyncAbortController = null;
    }

    if (!this.isGenerationCurrent(generation, message.assignmentId)) {
      return;
    }

    await this.watcher?.flushNow();
    if (!this.isGenerationCurrent(generation, message.assignmentId)) {
      return;
    }

    if (this.bufferedChanges.size > 0) {
      const buffered = Array.from(this.bufferedChanges.values());
      this.bufferedChanges.clear();
      await this.pushLiveBatch(buffered);
    }

    if (!this.isGenerationCurrent(generation, message.assignmentId)) {
      return;
    }

    const syncComplete: CacheTaskSyncComplete = {
      type: "cache_task_sync_complete",
      assignmentId: message.assignmentId,
      baseRevision: this.revision,
      scannedAt: scanStartedAt,
    };
    await this.sendMessage(syncComplete);
    this.state = "assigned-watching";
    this.scheduleLiveDrain();
  }

  private async handleWatcherChanges(changes: CacheTaskChange[]): Promise<void> {
    if (changes.length === 0 || !this.assignment) {
      return;
    }
    const target = this.state === "assigned-syncing" ? this.bufferedChanges : this.pendingLiveChanges;
    for (const change of changes) {
      target.set(changeKey(change), change);
    }
    if (this.state === "assigned-watching") {
      this.scheduleLiveDrain();
    }
  }

  private async handleWatcherFault(fault: CacheWatcherFault): Promise<void> {
    this.watcherHealth = fault.fatal ? "degraded" : "degraded";
    await this.sendFault(fault);
    if (fault.fatal) {
      await this.transitionToPassive();
    }
  }

  private handleMutationHint(message: CacheTaskMutationHint): void {
    if (!this.watcher || !this.assignment || message.assignmentId !== this.assignment.assignmentId) {
      return;
    }
    this.watcher.suppressPaths(
      message.targets.map((target) => ({
        absPath: resolveTargetPath(this.homedir, target.scope, target.path),
        mutationId: message.mutationId,
      })),
      this.suppressTtlMs,
    );
  }

  private scheduleLiveDrain(): void {
    if (this.liveDrain) {
      return;
    }
    this.liveDrain = (async () => {
      while (this.state === "assigned-watching" && this.assignment && this.pendingLiveChanges.size > 0) {
        const batch = Array.from(this.pendingLiveChanges.values());
        this.pendingLiveChanges.clear();
        try {
          await this.pushLiveBatch(batch);
        } catch (error) {
          log.warn("push live batch failed", { error: asErrorMessage(error) });
          if (error instanceof CacheTaskDeltaAckError) {
            await this.transitionToPassive();
          }
          break;
        }
      }
    })().finally(() => {
      this.liveDrain = null;
      if (this.state === "assigned-watching" && this.pendingLiveChanges.size > 0) {
        this.scheduleLiveDrain();
      }
    });
  }

  private async pushLiveBatch(changes: CacheTaskChange[]): Promise<void> {
    const assignment = this.assignment;
    if (!assignment || changes.length === 0) {
      return;
    }
    const ack = await this.sendDeltaAndWaitAck({
      assignmentId: assignment.assignmentId,
      baseRevision: this.revision,
      changes,
      mode: "live",
    });
    this.revision = typeof ack.appliedRevision === "number" ? ack.appliedRevision : this.revision + 1;
    this.lastFlushAt = this.now();
  }

  private async sendDeltaAndWaitAck(args: {
    assignmentId: string;
    baseRevision: number;
    changes: CacheTaskChange[];
    mode: CacheTaskDelta["mode"];
  }): Promise<CacheTaskDeltaAck> {
    const batchId = this.createBatchId();
    const delta: CacheTaskDelta = {
      type: "cache_task_delta",
      assignmentId: args.assignmentId,
      batchId,
      baseRevision: args.baseRevision,
      mode: args.mode,
      changes: args.changes,
      sentAt: this.now(),
    };

    let unsubscribe = () => {};
    let timer: NodeJS.Timeout | null = null;
    const ackPromise = new Promise<CacheTaskDeltaAck>((resolve, reject) => {
      timer = this.setTimeoutFn(() => {
        unsubscribe();
        reject(new Error(`cache_task_delta_ack 超时 batchId=${batchId}`));
      }, this.ackTimeoutMs);

      unsubscribe = this.subscribeAcks((ack) => {
        if (ack.batchId !== batchId) {
          return;
        }
        if (timer) {
          this.clearTimeoutFn(timer);
        }
        unsubscribe();
        resolve(ack);
      });
    });

    try {
      await this.sendMessage(delta);
    } catch (error) {
      if (timer) {
        this.clearTimeoutFn(timer);
      }
      unsubscribe();
      throw error;
    }
    const ack = await ackPromise;
    if (!ack.ok) {
      throw new CacheTaskDeltaAckError(ack);
    }
    return ack;
  }

  private async transitionToPassive(): Promise<void> {
    this.generation += 1;
    this.abortInitialSync();
    this.stopHeartbeatTimer();
    this.state = "connected-passive";
    this.assignment = null;
    this.heartbeatIntervalMs = 5_000;
    this.revision = 0;
    this.bufferedChanges.clear();
    this.pendingLiveChanges.clear();
    this.watcherHealth = "ok";
    this.lastFlushAt = undefined;
    await this.stopWatcher();
  }

  private async stopWatcher(): Promise<void> {
    const watcher = this.watcher;
    this.watcher = null;
    if (!watcher) {
      return;
    }
    watcher.clearSuppressor();
    await watcher.stop();
  }

  private startHeartbeatTimer(): void {
    this.stopHeartbeatTimer();
    this.heartbeatTimer = this.setIntervalFn(() => {
      void this.sendHeartbeat();
    }, this.heartbeatIntervalMs);
    if (typeof this.heartbeatTimer.unref === "function") {
      this.heartbeatTimer.unref();
    }
  }

  private stopHeartbeatTimer(): void {
    if (!this.heartbeatTimer) {
      return;
    }
    this.clearIntervalFn(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private async sendHeartbeat(): Promise<void> {
    if (!this.assignment || this.state === "connected-passive" || this.state === "disconnected") {
      return;
    }
    const heartbeat: CacheTaskHeartbeat = {
      type: "cache_task_heartbeat",
      assignmentId: this.assignment.assignmentId,
      phase: this.state === "assigned-syncing" ? "assigned-syncing" : "assigned-watching",
      watcherHealth: this.watcherHealth,
      lastFlushAt: this.lastFlushAt,
      sentAt: this.now(),
    };
    await this.sendMessage(heartbeat);
  }

  private async sendFault(fault: {
    code: CacheTaskFault["code"];
    fatal: boolean;
    message: string;
  }): Promise<void> {
    if (!this.assignment) {
      return;
    }
    const payload: CacheTaskFault = {
      type: "cache_task_fault",
      assignmentId: this.assignment.assignmentId,
      code: fault.code,
      fatal: fault.fatal,
      message: fault.message,
      sentAt: this.now(),
    };
    await this.sendMessage(payload);
  }

  private dispatchAck(ack: CacheTaskDeltaAck): void {
    for (const subscriber of Array.from(this.ackSubscribers)) {
      try {
        subscriber(ack);
      } catch (error) {
        log.warn("ack subscriber failed", { error: asErrorMessage(error) });
      }
    }
  }

  private subscribeAcks(handler: (ack: CacheTaskDeltaAck) => void): () => void {
    this.ackSubscribers.add(handler);
    return () => {
      this.ackSubscribers.delete(handler);
    };
  }

  private replaceInitialSyncAbortController(): AbortController {
    this.abortInitialSync();
    const controller = new AbortController();
    this.initialSyncAbortController = controller;
    return controller;
  }

  private abortInitialSync(): void {
    this.initialSyncAbortController?.abort();
    this.initialSyncAbortController = null;
  }

  private async flushScanCache(): Promise<void> {
    if (!this.scanCache) {
      return;
    }
    try {
      await this.scanCache.flush();
    } catch (error) {
      log.warn("scan cache flush 失败，已忽略", {
        error: asErrorMessage(error),
      });
    }
  }

  private async sendMessage(message: HandToServerMessage): Promise<void> {
    if (!this.send) {
      throw new Error("cache task send channel unavailable");
    }
    await this.send(message);
  }

  private isGenerationCurrent(generation: number, assignmentId: string): boolean {
    return generation === this.generation && this.assignment?.assignmentId === assignmentId;
  }

  private isTaskTokenMismatch(ack: CacheTaskDeltaAck): boolean {
    return ack.errorCode === "STALE_ASSIGNMENT" || ack.errorCode === "NOT_ACTIVE";
  }
}

export function isCacheTaskDisabled(): boolean {
  return process.env.CERELAY_DISABLE_INITIAL_CACHE_SYNC === "true"
    || process.env.CERELAY_DISABLE_CACHE_TASK === "true";
}

function resolveTargetPath(homedir: string, scope: CacheTaskChange["scope"], relPath: string): string {
  if (scope === "claude-json") {
    return path.join(homedir, ".claude.json");
  }
  return relPath ? path.join(homedir, ".claude", relPath) : path.join(homedir, ".claude");
}

function changeKey(change: CacheTaskChange): string {
  return `${change.scope}:${change.path}`;
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
