import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { AccessLedgerRuntime, type AccessLedgerStore } from "./access-ledger.js";
import { ClientCacheStore } from "./file-agent/store.js";
import type { ClientRegistry } from "./client-registry.js";
import { createLogger } from "./logger.js";
import { computeSyncPlan } from "./sync-plan.js";

const log = createLogger("cache-task-manager");
import type {
  CacheScope,
  CacheTaskAckErrorCode,
  CacheTaskAssignment,
  CacheTaskAssignmentReason,
  CacheTaskChange,
  CacheTaskDelta,
  CacheTaskDeltaAck,
  CacheTaskFault,
  CacheTaskHeartbeat,
  CacheTaskMutationHint,
  CacheTaskMutationHintTarget,
  CacheTaskSyncComplete,
  ClientHello,
  ServerToHandMessage,
} from "./protocol.js";

type TaskPhase = "idle" | "syncing" | "ready" | "degraded";

interface CacheTaskRecord {
  cacheKey: string;
  deviceId: string;
  cwd: string;
  phase: TaskPhase;
  activeClientId: string | null;
  assignmentId: string | null;
  revision: number;
  candidateClientIds: Set<string>;
  pendingReadBypass: Map<string, { mutationId: string; expiresAt: number }>;
  recentMutationIds: Set<string>;
  recentMutationOrder: string[];
  lastHeartbeatAt: number | null;
  lastFailoverAt: number | null;
}

interface CacheTaskManagerOptions {
  registry: ClientRegistry;
  store: ClientCacheStore;
  sendToClient: (clientId: string, message: ServerToHandMessage) => Promise<void>;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  failoverCooldownMs?: number;
  readBypassTtlMs?: number;
  now?: () => number;
  createAssignmentId?: () => string;
  createMutationId?: () => string;
  accessLedgerStore?: AccessLedgerStore;
  getHomedirForDevice?: (deviceId: string) => string;
  /**
   * Plan §3.6 路径 B wiring：watcher delta 应用到 store 后调此回调。
   * server.ts 注册回调让对应 deviceId 的 FileAgent 处理 inflight 清理 + telemetry。
   * 失败不影响 cache_task_delta_ack（changes 已落盘成功）。
   */
  onDeltaApplied?: (deviceId: string, changes: CacheTaskChange[]) => void | Promise<void>;
}

interface OutboundMessage {
  clientId: string;
  message: ServerToHandMessage;
}

export class CacheTaskManager {
  private static readonly RECENT_MUTATION_ID_CAP = 64;
  private readonly registry: ClientRegistry;
  private readonly store: ClientCacheStore;
  private readonly sendToClientImpl: (clientId: string, message: ServerToHandMessage) => Promise<void>;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly failoverCooldownMs: number;
  private readonly readBypassTtlMs: number;
  private readonly now: () => number;
  private readonly createAssignmentId: () => string;
  private readonly createMutationId: () => string;
  private readonly accessLedgerStore: AccessLedgerStore | null;
  private readonly getHomedirForDevice: (deviceId: string) => string;
  private readonly onDeltaApplied:
    | ((deviceId: string, changes: CacheTaskChange[]) => void | Promise<void>)
    | null;
  private readonly tasks = new Map<string, CacheTaskRecord>();
  private readonly mutexChains = new Map<string, Promise<void>>();

  constructor(options: CacheTaskManagerOptions) {
    this.registry = options.registry;
    this.store = options.store;
    this.sendToClientImpl = options.sendToClient;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 15_000;
    this.failoverCooldownMs = options.failoverCooldownMs ?? 10_000;
    this.readBypassTtlMs = options.readBypassTtlMs ?? 10_000;
    this.now = options.now ?? (() => Date.now());
    this.createAssignmentId = options.createAssignmentId ?? (() => randomUUID());
    this.createMutationId = options.createMutationId ?? (() => randomUUID());
    this.accessLedgerStore = options.accessLedgerStore ?? null;
    this.getHomedirForDevice = options.getHomedirForDevice ?? (() => homedir());
    this.onDeltaApplied = options.onDeltaApplied ?? null;
  }

  async registerHello(clientId: string, hello: ClientHello): Promise<void> {
    this.registry.attachHello(clientId, hello);

    if (!hello.deviceId) {
      return;
    }
    const { deviceId } = hello;

    if (!hello.capabilities.cacheTaskV1) {
      await this.sendMessages([
        {
          clientId,
          message: this.buildInactiveAssignment(deviceId, hello.cwd, "capability_missing"),
        },
      ]);
      return;
    }

    const cacheKey = this.cacheKeyOf(deviceId, hello.cwd);
    const actions = await this.withTaskLock(deviceId, hello.cwd, async () => {
      const task = this.getOrCreateTask(deviceId, hello.cwd);
      task.candidateClientIds.add(clientId);

      if (!task.activeClientId) {
        return this.electActiveClient(task, "elected");
      }

      if (task.activeClientId === clientId) {
        return this.reassignActiveClient(task, clientId, "resync");
      }

      return [
        {
          clientId,
          message: this.buildInactiveAssignment(
            task.deviceId,
            task.cwd,
            "standby",
            task.assignmentId ?? undefined,
          ),
        },
      ];
    });

    await this.sendMessages(actions);
    this.cleanupIdleTask(cacheKey);
  }

  async handleDisconnect(clientId: string): Promise<void> {
    const cacheKeys = this.registry.cacheKeysOf(clientId);
    for (const cacheKey of cacheKeys) {
      const task = this.tasks.get(cacheKey);
      if (!task) {
        continue;
      }

      const actions = await this.withTaskLock(task.deviceId, task.cwd, async () => {
        task.candidateClientIds.delete(clientId);
        if (task.activeClientId !== clientId) {
          if (!task.activeClientId && task.candidateClientIds.size === 0) {
            task.phase = "idle";
          }
          return [];
        }
        return this.failoverTask(task, "failover", clientId, false);
      });

      await this.sendMessages(actions);
      this.cleanupIdleTask(cacheKey);
    }
  }

  async handleHeartbeat(clientId: string, heartbeat: CacheTaskHeartbeat): Promise<void> {
    this.registry.setLastHeartbeat(clientId, new Date(this.now()));

    const task = this.taskForClient(clientId);
    if (!task) {
      return;
    }

    await this.withTaskLock(task.deviceId, task.cwd, async () => {
      if (task.activeClientId !== clientId) {
        return;
      }
      if (task.assignmentId !== heartbeat.assignmentId) {
        return;
      }
      task.lastHeartbeatAt = this.now();
    });
  }

  async handleFault(clientId: string, fault: CacheTaskFault): Promise<void> {
    const task = this.taskForClient(clientId);
    if (!task) {
      return;
    }

    const actions = await this.withTaskLock(task.deviceId, task.cwd, async () => {
      if (task.activeClientId !== clientId || task.assignmentId !== fault.assignmentId) {
        return [];
      }
      if (!fault.fatal) {
        task.lastHeartbeatAt = this.now();
        return [];
      }
      return this.failoverTask(task, "failover", clientId, true);
    });

    await this.sendMessages(actions);
    this.cleanupIdleTask(task.cacheKey);
  }

  async applyDelta(clientId: string, delta: CacheTaskDelta): Promise<void> {
    const task = this.taskForClient(clientId);
    if (!task) {
      await this.sendAck(clientId, this.rejectAck(delta, "NOT_ACTIVE", "Client 未被分配为 active"));
      return;
    }

    // 收集 lock 内 apply 成功的 changes，待 lock 释放后调 onDeltaApplied（Codex review
    // 反馈：避免回调阻塞 lock 释放，拖慢 cache_task_delta_ack）
    let appliedChangesForCallback: CacheTaskChange[] | null = null;

    const ack = await this.withTaskLock(task.deviceId, task.cwd, async () => {
      if (task.activeClientId !== clientId) {
        return this.rejectAck(delta, "NOT_ACTIVE", "当前连接不是 active executor");
      }
      if (task.assignmentId !== delta.assignmentId) {
        return this.rejectAck(delta, "STALE_ASSIGNMENT", "assignmentId 已过期");
      }
      if (task.revision !== delta.baseRevision) {
        return this.rejectAck(delta, "STALE_REVISION", "baseRevision 已过期");
      }

      try {
        const changesToApply = this.filterDuplicateMutationChanges(task, delta.changes);
        if (changesToApply.length === 0) {
          return {
            type: "cache_task_delta_ack",
            assignmentId: delta.assignmentId,
            batchId: delta.batchId,
            ok: true,
            appliedRevision: task.revision,
          } satisfies CacheTaskDeltaAck;
        }

        const result = await this.store.applyDelta(task.deviceId, changesToApply);
        task.revision = result.revision;
        this.rememberMutationIds(task, changesToApply);
        this.clearReadBypass(task, changesToApply);

        // 标记本批 changes，等 lock 释放后再调 onDeltaApplied
        appliedChangesForCallback = changesToApply;

        return {
          type: "cache_task_delta_ack",
          assignmentId: delta.assignmentId,
          batchId: delta.batchId,
          ok: true,
          appliedRevision: result.revision,
        } satisfies CacheTaskDeltaAck;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        return this.rejectAck(
          delta,
          this.mapStoreErrorToAckCode(err),
          err.message,
          this.mapStoreErrorToAckCode(err) === "STORE_WRITE_FAILED" ? false : undefined,
        );
      }
    });

    // Plan §3.6 路径 B wiring：lock 外调 onDeltaApplied 让 FileAgent 处理 TTL/telemetry。
    // 失败不影响 ack（changes 已落盘成功；ack 也已构造完毕）。
    if (this.onDeltaApplied && appliedChangesForCallback) {
      try {
        await this.onDeltaApplied(task.deviceId, appliedChangesForCallback);
      } catch (err) {
        log.warn("onDeltaApplied 回调出错（不影响 delta_ack）", {
          deviceId: task.deviceId,
          err: err instanceof Error ? err.message : String(err),
        } as Record<string, unknown>);
      }
    }

    await this.sendAck(clientId, ack);
  }

  async completeInitialSync(clientId: string, message: CacheTaskSyncComplete): Promise<void> {
    const task = this.taskForClient(clientId);
    if (!task) {
      return;
    }

    const actions = await this.withTaskLock(task.deviceId, task.cwd, async () => {
      if (task.activeClientId !== clientId || task.assignmentId !== message.assignmentId) {
        return [];
      }
      if (task.revision < message.baseRevision) {
        return this.reassignActiveClient(task, clientId, "resync");
      }
      if (message.scopeTruncated) {
        await this.store.updateScopeTruncated(task.deviceId, message.scopeTruncated);
      }
      task.phase = "ready";
      log.info("cache task 进入 ready 状态", {
        deviceId: task.deviceId,
        cwd: task.cwd,
        assignmentId: task.assignmentId,
        revision: task.revision,
        activeClientId: task.activeClientId,
      });
      return [];
    });

    await this.sendMessages(actions);
  }

  async registerMutationHintForPath(
    deviceId: string,
    cwd: string,
    targets: CacheTaskMutationHintTarget[],
  ): Promise<void> {
    const task = this.tasks.get(this.cacheKeyOf(deviceId, cwd));
    if (!task) {
      return;
    }

    const actions = await this.withTaskLock(deviceId, cwd, async () => {
      if (!task.activeClientId || !task.assignmentId) {
        return [];
      }

      const mutationId = this.createMutationId();
      const now = this.now();
      for (const target of targets) {
        task.pendingReadBypass.set(this.readBypassKey(target.scope, target.path), {
          mutationId,
          expiresAt: now + this.readBypassTtlMs,
        });
      }

      return [
        {
          clientId: task.activeClientId,
          message: {
            type: "cache_task_mutation_hint",
            assignmentId: task.assignmentId,
            mutationId,
            targets,
            issuedAt: now,
          } satisfies CacheTaskMutationHint,
        },
      ];
    });

    await this.sendMessages(actions);
  }

  shouldUseCacheSnapshot(deviceId: string, cwd: string): boolean {
    const task = this.tasks.get(this.cacheKeyOf(deviceId, cwd));
    return task?.phase === "ready";
  }

  /**
   * 诊断接口：返回当前 (deviceId, cwd) 对应的 task 状态摘要，供 FileProxyManager
   * 在 cache snapshot 不可用时打印原因——区分 "task 不存在"、"phase=syncing 还在跑"、
   * "phase=degraded 失联" 等场景，避免用户只看到 usedCacheSnapshot=false 而不知所以。
   */
  describeTaskState(deviceId: string, cwd: string): {
    exists: boolean;
    phase: TaskPhase | null;
    activeClientId: string | null;
    assignmentId: string | null;
    revision: number | null;
    candidateClientCount: number;
    lastHeartbeatAt: number | null;
  } {
    const task = this.tasks.get(this.cacheKeyOf(deviceId, cwd));
    if (!task) {
      return {
        exists: false,
        phase: null,
        activeClientId: null,
        assignmentId: null,
        revision: null,
        candidateClientCount: 0,
        lastHeartbeatAt: null,
      };
    }
    return {
      exists: true,
      phase: task.phase,
      activeClientId: task.activeClientId,
      assignmentId: task.assignmentId,
      revision: task.revision,
      candidateClientCount: task.candidateClientIds.size,
      lastHeartbeatAt: task.lastHeartbeatAt,
    };
  }

  shouldBypassCacheRead(deviceId: string, cwd: string, scope: CacheScope, relPath: string): boolean {
    const task = this.tasks.get(this.cacheKeyOf(deviceId, cwd));
    if (!task) {
      return false;
    }
    if (task.phase !== "ready") {
      return true;
    }

    const key = this.readBypassKey(scope, relPath);
    const pending = task.pendingReadBypass.get(key);
    if (!pending) {
      return false;
    }
    if (pending.expiresAt <= this.now()) {
      task.pendingReadBypass.delete(key);
      return false;
    }
    return true;
  }

  /**
   * 这里有意把 store.applyDelta / store.loadManifest 放在 task lock 临界区内执行。
   * 形式上看，这是 task-lock -> manifest-lock 的嵌套，而不是 cross-review 里主张的“锁不嵌套”。
   * 当前实现仍然是死锁安全的，因为 store 被当作叶子组件使用。
   * store 内部不会反向调用 manager，也不存在拿到 manifest 锁后再回来申请 task lock 的路径。
   * 换句话说，锁顺序天然只有一个方向：先 task，再 store 自己的 manifest 锁。
   * 这样做是更保守的串行化策略，优先保证同一 (deviceId, cwd) 任务的状态一致性。
   * 代价也明确：task 的临界区会覆盖一次 manifest 读写对应的磁盘 I/O 时间。
   * 这会降低并发度，但能避免 assignment/revision 与落盘结果出现可见乱序。
   * 只要 store 继续保持叶子角色，这个取舍就是可控的。
   * 后续如果其他模块开始以反向顺序使用 store（先 manifest 锁，再 task 锁），
   * 或者 store 新增了任何回调 manager 的路径，就必须重新评估这里的锁顺序。
   */
  async withTaskLock<T>(deviceId: string, cwd: string, fn: () => Promise<T>): Promise<T> {
    const key = this.cacheKeyOf(deviceId, cwd);
    const previous = this.mutexChains.get(key) ?? Promise.resolve();
    let releaseSelf!: () => void;
    const self = new Promise<void>((resolve) => {
      releaseSelf = resolve;
    });
    const newTail = previous.then(() => self);
    this.mutexChains.set(key, newTail);

    try {
      await previous.catch(() => undefined);
      return await fn();
    } finally {
      releaseSelf();
      if (this.mutexChains.get(key) === newTail) {
        this.mutexChains.delete(key);
      }
    }
  }

  async sweepHeartbeats(): Promise<void> {
    for (const task of Array.from(this.tasks.values())) {
      if (!task.activeClientId || task.lastHeartbeatAt === null) {
        continue;
      }
      const now = this.now();
      if (now - task.lastHeartbeatAt <= this.heartbeatTimeoutMs) {
        continue;
      }
      if (task.lastFailoverAt && now - task.lastFailoverAt < this.failoverCooldownMs) {
        continue;
      }

      const actions = await this.withTaskLock(task.deviceId, task.cwd, async () => {
        if (!task.activeClientId || task.lastHeartbeatAt === null) {
          return [];
        }
        const currentNow = this.now();
        if (currentNow - task.lastHeartbeatAt <= this.heartbeatTimeoutMs) {
          return [];
        }
        if (task.lastFailoverAt && currentNow - task.lastFailoverAt < this.failoverCooldownMs) {
          return [];
        }
        return this.failoverTask(task, "failover", task.activeClientId, true);
      });

      await this.sendMessages(actions);
      this.cleanupIdleTask(task.cacheKey);
    }
  }

  private taskForClient(clientId: string): CacheTaskRecord | undefined {
    const cacheKey = this.registry.cacheKeyOf(clientId);
    return cacheKey ? this.tasks.get(cacheKey) : undefined;
  }

  private getOrCreateTask(deviceId: string, cwd: string): CacheTaskRecord {
    const cacheKey = this.cacheKeyOf(deviceId, cwd);
    let task = this.tasks.get(cacheKey);
    if (!task) {
      task = {
        cacheKey,
        deviceId,
        cwd,
        phase: "idle",
        activeClientId: null,
        assignmentId: null,
        revision: 0,
        candidateClientIds: new Set(),
        pendingReadBypass: new Map(),
        recentMutationIds: new Set(),
        recentMutationOrder: [],
        lastHeartbeatAt: null,
        lastFailoverAt: null,
      };
      this.tasks.set(cacheKey, task);
    }
    return task;
  }

  private async electActiveClient(
    task: CacheTaskRecord,
    reason: Extract<CacheTaskAssignmentReason, "elected" | "failover">,
  ): Promise<OutboundMessage[]> {
    const winner = this.electCandidate(task.candidateClientIds);
    if (!winner) {
      task.activeClientId = null;
      task.assignmentId = null;
      task.phase = "idle";
      task.lastHeartbeatAt = null;
      return [];
    }

    const manifest = await this.store.loadManifest(task.deviceId);
    task.activeClientId = winner;
    task.assignmentId = this.createAssignmentId();
    task.phase = "syncing";
    task.revision = manifest.revision;
    task.lastHeartbeatAt = this.now();
    if (reason === "failover") {
      task.lastFailoverAt = this.now();
    }

    const actions: OutboundMessage[] = [
      {
        clientId: winner,
        message: await this.buildActiveAssignment(task, manifest, reason),
      },
    ];

    for (const candidateId of task.candidateClientIds) {
      if (candidateId === winner) {
        continue;
      }
      actions.push({
        clientId: candidateId,
        message: this.buildInactiveAssignment(task.deviceId, task.cwd, "standby", task.assignmentId),
      });
    }

    return actions;
  }

  private async reassignActiveClient(
    task: CacheTaskRecord,
    clientId: string,
    reason: Extract<CacheTaskAssignmentReason, "resync">,
  ): Promise<OutboundMessage[]> {
    const manifest = await this.store.loadManifest(task.deviceId);
    task.activeClientId = clientId;
    task.assignmentId = this.createAssignmentId();
    task.phase = "syncing";
    task.revision = manifest.revision;
    task.lastHeartbeatAt = this.now();
    return [
      {
        clientId,
        message: await this.buildActiveAssignment(task, manifest, reason),
      },
    ];
  }

  private async failoverTask(
    task: CacheTaskRecord,
    reason: Extract<CacheTaskAssignmentReason, "failover">,
    previousActiveClientId: string,
    removePreviousFromCandidates: boolean,
  ): Promise<OutboundMessage[]> {
    if (removePreviousFromCandidates) {
      task.candidateClientIds.delete(previousActiveClientId);
    }
    task.activeClientId = null;
    task.assignmentId = null;
    task.lastHeartbeatAt = null;
    task.phase = task.candidateClientIds.size > 0 ? "degraded" : "idle";

    if (task.candidateClientIds.size === 0) {
      return [];
    }

    return this.electActiveClient(task, reason);
  }

  private electCandidate(candidateClientIds: Set<string>): string | null {
    return Array.from(candidateClientIds)
      .map((clientId) => this.registry.get(clientId))
      .filter((client): client is NonNullable<ReturnType<ClientRegistry["get"]>> => {
        return Boolean(client?.cacheCapabilities?.cacheTaskV1);
      })
      .sort((a, b) => {
        const connectedAtDiff = a.connectedAt.getTime() - b.connectedAt.getTime();
        if (connectedAtDiff !== 0) {
          return connectedAtDiff;
        }
        return a.id.localeCompare(b.id);
      })[0]?.id ?? null;
  }

  private async buildActiveAssignment(
    task: CacheTaskRecord,
    manifest: Awaited<ReturnType<ClientCacheStore["loadManifest"]>>,
    reason: Extract<CacheTaskAssignmentReason, "elected" | "failover" | "resync">,
  ): Promise<CacheTaskAssignment> {
    if (!task.assignmentId) {
      throw new Error("active assignment 缺少 assignmentId");
    }
    const ledger = this.accessLedgerStore
      ? await this.accessLedgerStore.load(task.deviceId)
      : new AccessLedgerRuntime(task.deviceId);
    const syncPlan = computeSyncPlan({
      ledger,
      homedir: this.getHomedirForDevice(task.deviceId),
    });

    return {
      type: "cache_task_assignment",
      deviceId: task.deviceId,
      cwd: task.cwd,
      assignmentId: task.assignmentId,
      role: "active",
      reason,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      heartbeatTimeoutMs: this.heartbeatTimeoutMs,
      manifest: {
        revision: manifest.revision,
        scopes: {
          "claude-home": { ...manifest.scopes["claude-home"], entries: { ...manifest.scopes["claude-home"].entries } },
          "claude-json": { ...manifest.scopes["claude-json"], entries: { ...manifest.scopes["claude-json"].entries } },
        },
      },
      syncPlan,
    };
  }

  private buildInactiveAssignment(
    deviceId: string,
    cwd: string,
    reason: Extract<CacheTaskAssignmentReason, "standby" | "capability_missing">,
    assignmentId = "inactive",
  ): CacheTaskAssignment {
    return {
      type: "cache_task_assignment",
      deviceId,
      cwd,
      assignmentId,
      role: "inactive",
      reason,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      heartbeatTimeoutMs: this.heartbeatTimeoutMs,
    };
  }

  private rejectAck(
    delta: CacheTaskDelta,
    errorCode: CacheTaskAckErrorCode,
    error: string,
    resyncRequired = true,
  ): CacheTaskDeltaAck {
    return {
      type: "cache_task_delta_ack",
      assignmentId: delta.assignmentId,
      batchId: delta.batchId,
      ok: false,
      errorCode,
      error,
      resyncRequired,
    };
  }

  private mapStoreErrorToAckCode(error: Error): CacheTaskAckErrorCode {
    return error.message.includes("sha256")
      ? "SHA256_MISMATCH"
      : "STORE_WRITE_FAILED";
  }

  private clearReadBypass(task: CacheTaskRecord, changes: CacheTaskChange[]): void {
    for (const change of changes) {
      const key = this.readBypassKey(change.scope, change.path);
      const pending = task.pendingReadBypass.get(key);
      if (!pending) {
        continue;
      }
      if (!change.mutationId || change.mutationId === pending.mutationId) {
        task.pendingReadBypass.delete(key);
      }
    }
  }

  private filterDuplicateMutationChanges(
    task: CacheTaskRecord,
    changes: CacheTaskChange[],
  ): CacheTaskChange[] {
    const filtered: CacheTaskChange[] = [];
    for (const change of changes) {
      if (change.mutationId && task.recentMutationIds.has(change.mutationId)) {
        continue;
      }
      filtered.push(change);
    }
    return filtered;
  }

  private rememberMutationIds(task: CacheTaskRecord, changes: CacheTaskChange[]): void {
    for (const change of changes) {
      if (!change.mutationId || task.recentMutationIds.has(change.mutationId)) {
        continue;
      }
      task.recentMutationIds.add(change.mutationId);
      task.recentMutationOrder.push(change.mutationId);
      if (task.recentMutationOrder.length > CacheTaskManager.RECENT_MUTATION_ID_CAP) {
        const evicted = task.recentMutationOrder.shift();
        if (evicted) {
          task.recentMutationIds.delete(evicted);
        }
      }
    }
  }

  private async sendMessages(actions: OutboundMessage[]): Promise<void> {
    for (const action of actions) {
      await this.sendToClientImpl(action.clientId, action.message);
    }
  }

  private async sendAck(clientId: string, ack: CacheTaskDeltaAck): Promise<void> {
    await this.sendToClientImpl(clientId, ack);
  }

  private cleanupIdleTask(cacheKey: string): void {
    const task = this.tasks.get(cacheKey);
    if (!task) {
      return;
    }
    if (task.activeClientId || task.candidateClientIds.size > 0) {
      return;
    }
    this.tasks.delete(cacheKey);
  }

  private cacheKeyOf(deviceId: string, cwd: string): string {
    return `${deviceId}\0${cwd}`;
  }

  private readBypassKey(scope: CacheScope, relPath: string): string {
    return `${scope}\0${relPath}`;
  }
}
