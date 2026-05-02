import { spawn, type ChildProcess, execSync } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createLogger } from "./logger.js";
import { PYTHON_FUSE_HOST_SCRIPT } from "./fuse-host-script.js";
import {
  isClaudeHomeSettingsJson,
  redactClaudeSettingsLoginState,
} from "./claude-settings-redaction.js";
import type {
  CacheScope,
  FileProxyRequest,
  FileProxyResponse,
  FileProxySnapshotEntry,
  FileProxyStat,
} from "./protocol.js";
import type { ClientCacheStore, PersistedManifest } from "./client-cache-store.js";
import type { CacheTaskManager } from "./cache-task-manager.js";
import type { AccessLedgerRuntime } from "./access-ledger.js";
import { SessionAccessBuffer, type AccessEvent } from "./access-event-buffer.js";
import { DaemonControlClient } from "./daemon-control.js";
import { SEED_WHITELIST } from "./seed-whitelist.js";

const log = createLogger("file-proxy-manager");

// CACHE_MUTATING_OPS 定义在文件底部 (line ~1616), Phase 5.2 access tracking 复用

/** FUSE daemon 发出的 JSON 请求（从 stdout 读取） */
interface FuseRequest {
  reqId: string;
  op: string;
  root: string;
  relPath: string;
  data?: string;
  offset?: number;
  size?: number;
  mode?: number;
  newRoot?: string;
  newRelPath?: string;
  atime?: number;
  mtime?: number;
}

interface Deferred {
  resolve: (resp: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /**
   * true = 内部发起的请求（如 settings.json 全文穿透），响应不要自动写回 Python
   * daemon，而是把 raw FileProxyResponse 交给 resolve 调用方继续处理。
   * 默认 false（外部 FUSE → server 链路，原有行为：响应转写到 Python daemon）。
   */
  silent?: boolean;
  /** 入队时间戳（仅 client 穿透 deferred 设置），用于计算 round-trip 耗时 */
  startedAt?: number;
  /**
   * 派生 access event 用的 op + 绝对路径上下文。仅 client-routed FUSE 请求
   * (非 silent) 设置；resolveResponse 收到回应时根据 resp 派生 AccessEvent
   * 进 buffer + 实时推 daemon control msg.
   */
  opForAccess?: { op: string; path: string };
}

type CacheTaskReadGate = Pick<
  CacheTaskManager,
  "registerMutationHintForPath" | "shouldUseCacheSnapshot" | "shouldBypassCacheRead" | "describeTaskState"
>;

export interface FileProxyManagerOptions {
  runtimeRoot: string;
  clientHomeDir: string;
  clientCwd: string;
  /** 向 Client 发送文件代理请求 */
  sendToClient: (msg: FileProxyRequest) => Promise<void>;
  /** 所属 session ID */
  sessionId: string;
  /** Shadow files: FUSE 内虚拟路径 → 本地真实文件路径（如 hook injection settings） */
  shadowFiles?: Record<string, string>;
  /**
   * Client 文件缓存。提供后：
   * - 启动时 snapshot 优先从 cache 构造 home-claude / home-claude-json，
   *   避免向 Client 发全量 snapshot 请求
   * - 运行时 read 命中 cache 的 blob 时直接回，不穿透 Client
   * - FUSE 写入（write/create/unlink/truncate）在穿透 Client 后同步更新 cache，
   *   让 cache 与 Client 本地保持一致
   */
  cacheStore?: ClientCacheStore;
  /** Client 本机 deviceId，用于定位 cache session 目录 */
  deviceId?: string;
  /** Cache task ready gate / mutation hint 协调器 */
  cacheTaskManager?: CacheTaskReadGate;
  /**
   * AccessLedger 存储器（可选）。提供后启动期会把 ledger.missing 投影到 snapshot
   * 的 negatives 字段，daemon 启动时灌进 _negative_perm（spec §7.4）。未提供时退化
   * 为不注入持久 missing（仅 broken symlink 走原 negativeEntries 路径）。
   */
  accessLedgerStore?: AccessLedgerProjection;
}

/**
 * FileProxyManager 跟 AccessLedger 的依赖契约:
 * - loadMissingForDevice: snapshot 启动期投影 missing (Phase 4.2)
 * - load + persist: Phase 5.3 定时 flush 时 read-modify-write
 *
 * 用专门接口避免把 server/src/access-ledger.ts 全模块依赖塞进 file-proxy-manager
 * 的 unit test 路径。
 */
export interface AccessLedgerProjection {
  loadMissingForDevice(deviceId: string): Promise<string[]>;
  loadDirsForDevice(deviceId: string): Promise<string[]>;
  load(deviceId: string): Promise<AccessLedgerRuntime>;
  persist(runtime: AccessLedgerRuntime): Promise<void>;
}

/**
 * 管理单个 session 的 FUSE daemon 生命周期。
 * FUSE daemon ←stdin/stdout→ FileProxyManager ←WebSocket→ Client
 */
export class FileProxyManager {
  private readonly runtimeRoot: string;
  private readonly sessionId: string;
  private readonly clientHomeDir: string;
  private readonly clientCwd: string;
  private readonly sendToClient: (msg: FileProxyRequest) => Promise<void>;

  private fuseProcess: ChildProcess | null = null;
  private controlStream: NodeJS.WritableStream | null = null;
  private readonly pendingRequests = new Map<string, Deferred>();
  private readline: ReadlineInterface | null = null;
  private _mountPoint: string = "";
  private helperPath: string = "";
  private destroyed = false;

  // 启动期 FUSE 活动诊断：从 daemon ready 到首次 stdout 之间，CC 通常会通过 FUSE
  // 连续读 ~/.claude/、settings、credentials 等文件。如果这段长时间没有日志，
  // 用户无法判断是 FUSE 慢还是 CC 自身在做别的事（spawn MCP / 网络 / sleep 等）。
  // 用一个轻量计数器记录 op 次数和 client 穿透耗时，按 5s 周期输出汇总。
  private readonly opCounters = new Map<string, number>();
  /** 累积 client 穿透 round-trip 耗时（毫秒），仅统计实际穿透到 Client 的请求 */
  private clientRoundTripMs = 0;
  /** 命中 server 侧 cache 的 read 请求次数 */
  private cacheHitReads = 0;
  /** 第一次收到 FUSE daemon 请求的时间戳，用于反映 CC 实际开始访问 FUSE 的时刻 */
  private firstRequestAt: number | null = null;
  /** 最近一次输出 stats 的时间，用于决定是否再输出汇总 */
  private lastStatsLoggedAt = 0;
  private startupStatsTimer: ReturnType<typeof setInterval> | null = null;
  private readonly fuseDaemonReadyAt: { value: number | null } = { value: null };
  /** 同时在飞的 client 穿透请求数瞬时峰值，用于回答"实际并发能跑到多少" */
  private peakPendingRequests = 0;
  /**
   * 已经向 Client 穿透过的路径 → 累计次数 + miss reason。让用户直接看到具体哪些
   * 文件没命中 cache，便于优化（比如 maxDepth 不够、cache 范围未覆盖、文件已被
   * 用户改写但 cache 失效后没回填等）。第一次出现时单独 INFO log；周期 stats
   * 用 top-N 方式回放热点。
   */
  private readonly perforatedPaths = new Map<string, { count: number; reason: string }>();

  /** FUSE 虚拟根到 Hand 侧绝对路径的映射 */
  private readonly roots: Record<string, string>;
  /** Shadow files: FUSE 内路径 → 本地文件路径 */
  private readonly shadowFiles: Record<string, string>;
  /** Client 文件缓存（可选）；未提供时退化为纯穿透模式 */
  private readonly cacheStore: ClientCacheStore | undefined;
  /** Client 本机 deviceId；无 cacheStore 时忽略 */
  private readonly deviceId: string | undefined;
  /** Cache task ready gate / mutation hint 协调器 */
  private readonly cacheTaskManager: CacheTaskReadGate | undefined;
  /** AccessLedger projection (启动期把 ledger.missing 注入 snapshot, 见 §7.4) */
  private readonly accessLedgerStore: AccessLedgerProjection | undefined;
  /**
   * 当前 session 的访问事件 buffer (Phase 5.1). flush 由 file-proxy-manager 在
   * shutdown / 5s timer / sync_complete 时驱动 (Phase 5.3 集成).
   * Buffer 内 events 在 flush 时应用到 ledger; 但 daemon 实时增量推送在 RPC
   * 响应时立即发出 (不等 flush), 保证 namespace 内 CC 实时可见.
   */
  private readonly accessBuffer: SessionAccessBuffer = new SessionAccessBuffer();
  /**
   * Daemon control client 包装。spawn 后从 controlStream 实例化, 用于 fire-and-forget
   * 推送 putNegative / invalidateNegativePrefix / invalidateCache / shutdown.
   * 创建在 startWithRetry 之后, shutdown 之前为 null.
   */
  private daemonControl: DaemonControlClient | null = null;
  /** Server-side cache hit 5s 防抖去重 (Codex 新 F1 / spec §4.4) */
  private readonly cacheHitDebounce = new Map<string, number>();
  private static readonly CACHE_HIT_DEBOUNCE_MS = 5000;
  /** Phase 5.3: ledger flush 5s 定时器 */
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly LEDGER_FLUSH_INTERVAL_MS = 5000;
  /** flush 互斥: 防止多个调用并发 read-modify-write 同一 ledger */
  private flushInFlight: Promise<void> | null = null;
  /**
   * Phase 6: SeedWhitelist capture 模式. 由 CERELAY_CAPTURE_SEED=path/to/output.json
   * env 触发. 启用时:
   *   1. 跳过 snapshot 反向构造 (避免 daemon 命中 perm cache 后不发 RPC, 漏采)
   *   2. 累积所有 daemon 收到的 RPC 路径 + 结果, shutdown 时 dump 到指定 JSON 路径
   * 后续用 scripts/seed-whitelist-codegen.ts 把 JSON 转 ts const 覆写 seed-whitelist.ts.
   */
  private readonly captureSeedPath: string | undefined;
  private readonly captureBuffer: Array<{
    op: string;
    path: string;
    result: "ok" | "missing";
    isDir?: boolean;
    mtime?: number;
  }> = [];

  constructor(options: FileProxyManagerOptions) {
    this.runtimeRoot = options.runtimeRoot;
    this.sessionId = options.sessionId;
    this.clientHomeDir = options.clientHomeDir;
    this.clientCwd = options.clientCwd;
    this.sendToClient = options.sendToClient;
    this.shadowFiles = options.shadowFiles ?? {};
    this.cacheStore = options.cacheStore;
    this.deviceId = options.deviceId;
    this.cacheTaskManager = options.cacheTaskManager;
    this.accessLedgerStore = options.accessLedgerStore;
    // Phase 6: capture mode 由 env 触发 (dev-only)
    this.captureSeedPath = process.env.CERELAY_CAPTURE_SEED;

    this.roots = {
      "home-claude": path.join(this.clientHomeDir, ".claude"),
      "home-claude-json": path.join(this.clientHomeDir, ".claude.json"),
      "project-claude": path.join(this.clientCwd, ".claude"),
    };
  }

  /** 判断是否启用了 cache 读优先路径。二者同时存在才算启用。 */
  private cacheAvailable(): boolean {
    return Boolean(this.cacheStore && this.deviceId);
  }

  private shouldUseCacheSnapshot(): boolean {
    if (!this.cacheAvailable()) {
      return false;
    }
    return this.cacheTaskManager
      ? this.cacheTaskManager.shouldUseCacheSnapshot(this.deviceId!, this.clientCwd)
      : true;
  }

  /**
   * 对外暴露 cache 不可用原因。snapshot 收集 / 启动诊断 log 时用，让用户直接看到
   * "为什么 usedCacheSnapshot=false"——区分 deviceId 缺失、cacheStore 未注入、
   * cacheTaskManager 状态尚未 ready 等不同根因。
   */
  private explainCacheAvailability(): {
    available: boolean;
    reason: string;
    taskState?: ReturnType<CacheTaskReadGate["describeTaskState"]>;
  } {
    if (!this.cacheStore) {
      return { available: false, reason: "no_cache_store" };
    }
    if (!this.deviceId) {
      return { available: false, reason: "no_device_id" };
    }
    if (!this.cacheTaskManager) {
      return { available: true, reason: "ok_no_task_manager_gate" };
    }
    const state = this.cacheTaskManager.describeTaskState(this.deviceId, this.clientCwd);
    if (!state.exists) {
      return { available: false, reason: "task_state_missing", taskState: state };
    }
    if (state.phase !== "ready") {
      return { available: false, reason: `phase_${state.phase}`, taskState: state };
    }
    return { available: true, reason: "ok_phase_ready", taskState: state };
  }

  /**
   * 阻塞等待 cache_task 进入 `ready`（spec §7.2 Defect 1 修复）。
   *
   * - phase=ready: 立即返回
   * - phase=degraded/idle 或 task 不存在: 立即返回（fallback 走 client 全量）
   * - phase=syncing: 50ms 轮询直到 ready 或转为 degraded/idle
   * - 无 cacheTaskManager / 无 deviceId: 立即返回（无 cache 子系统, 沿用旧路径）
   *
   * **不设超时**：cache sync 体感耗时本质由 client walk + hash + push delta 决定；
   * 设短超时反而让一部分 entry 走 fallback，违背修复目的。仅靠 phase 状态判定是否
   * 可达 ready。
   */
  private async waitForCacheReadyOrDegraded(): Promise<void> {
    if (!this.cacheTaskManager || !this.deviceId) return;
    const startedAt = Date.now();
    while (true) {
      const state = this.cacheTaskManager.describeTaskState(this.deviceId, this.clientCwd);
      if (state.phase === "ready") break;
      if (!state.exists || state.phase === "degraded" || state.phase === "idle") {
        log.warn("cache task 不可达 ready, 退化全量 walk", {
          sessionId: this.sessionId,
          phase: state.phase,
          exists: state.exists,
          waitedMs: Date.now() - startedAt,
        });
        return;
      }
      // phase=syncing: 等
      await sleep(50);
    }
    log.info("snapshot 等 cache ready 完成", {
      sessionId: this.sessionId,
      waitedMs: Date.now() - startedAt,
    });
  }

  get mountPoint(): string {
    return this._mountPoint;
  }

  // ============================================================
  // Phase 5 Access Tracking - 公开访问 buffer 给上层 (server.ts) 触发 flush
  // ============================================================

  /** 暴露 buffer 给上层 — Phase 5.3 在 5s timer / sync_complete / shutdown 时调 flush */
  getAccessBuffer(): SessionAccessBuffer {
    return this.accessBuffer;
  }

  /**
   * Phase 5.3: 把 buffer 内 events flush 到持久 ledger.
   *
   * - buffer 空 → no-op
   * - 没有 accessLedgerStore / deviceId → no-op (cache 子系统未启用)
   * - 并发 flush 通过 flushInFlight 串行化, 避免多并发 read-modify-write 写丢
   * - 失败降级 warn, events 仍在 buffer 中等下次 flush (除非已经 drained 到本地变量)
   */
  async flushAccessBufferIfNeeded(): Promise<void> {
    if (!this.accessLedgerStore || !this.deviceId) return;
    if (this.accessBuffer.isEmpty()) return;

    // 串行化: 等上一个 flush 完成
    if (this.flushInFlight) {
      await this.flushInFlight.catch(() => {/* 上次失败不影响本次 */});
    }

    const promise = (async () => {
      const beforeSize = this.accessBuffer.size();
      try {
        const ledger = await this.accessLedgerStore!.load(this.deviceId!);
        await this.accessBuffer.flush(ledger);
        await this.accessLedgerStore!.persist(ledger);
        log.debug("ledger flushed", {
          sessionId: this.sessionId,
          deviceId: this.deviceId,
          flushedEvents: beforeSize,
        });
      } catch (err) {
        log.warn("ledger flush 失败 (降级, 不阻塞)", {
          sessionId: this.sessionId,
          deviceId: this.deviceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    this.flushInFlight = promise;
    try {
      await promise;
    } finally {
      if (this.flushInFlight === promise) {
        this.flushInFlight = null;
      }
    }
  }

  /** Phase 5.3: 启动 5s flush 定时器 (仅在 ledger 子系统已启用时启动) */
  private startFlushTimer(): void {
    if (this.flushTimer) return;
    if (!this.accessLedgerStore || !this.deviceId) return;
    this.flushTimer = setInterval(() => {
      void this.flushAccessBufferIfNeeded();
    }, FileProxyManager.LEDGER_FLUSH_INTERVAL_MS);
  }

  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /** 暴露 daemon control client (有可能为 null 如果 spawn 失败) */
  getDaemonControl(): DaemonControlClient | null {
    return this.daemonControl;
  }

  /**
   * 在 RPC 派发到 client 之前调用. 对 mutation op 立即记录 access event +
   * 推 daemon invalidate_negative_prefix / invalidate_cache (实时可见).
   */
  private recordMutationEvent(req: FuseRequest, hand_path: string): void {
    if (!CACHE_MUTATING_OPS.has(req.op)) return;

    let event: AccessEvent | null = null;
    switch (req.op) {
      case "write":
      case "create":
      case "truncate":
      case "setattr":
      case "chmod":
        event = { op: req.op as any, path: hand_path };
        break;
      case "mkdir":
        event = { op: "mkdir", path: hand_path };
        break;
      case "unlink":
        event = { op: "unlink", path: hand_path };
        break;
      case "rmdir":
        event = { op: "rmdir", path: hand_path };
        break;
      case "rename": {
        const newRoot = this.roots[req.newRoot ?? req.root];
        if (newRoot && req.newRelPath !== undefined) {
          const newPath = req.newRelPath ? path.join(newRoot, req.newRelPath) : newRoot;
          event = { op: "rename", oldPath: hand_path, newPath };
        }
        break;
      }
    }
    if (!event) return;
    this.accessBuffer.recordEvent(event);
    // 实时推 daemon (fire-and-forget); rename 用 newPath 做 invalidate
    if (this.daemonControl) {
      const targetPath = event.op === "rename" ? event.newPath : event.path;
      if (event.op === "unlink" || event.op === "rmdir") {
        // unlink/rmdir 不清祖先 missing - 这两个 op 是删除, 不创建新路径
        // 但目录或文件被删后, daemon 内对应的 stat/readdir 缓存要失效
        void this.daemonControl.invalidateCache(targetPath);
      } else {
        // 创建/写入: 清祖先 missing + 失效缓存 (双管齐下)
        void this.daemonControl.invalidateNegativePrefix(targetPath);
        void this.daemonControl.invalidateCache(targetPath);
      }
    }
  }

  /**
   * 在 RPC 响应回到 server 时调用 (resolveResponse). 根据 deferred.opForAccess +
   * resp 派生 AccessEvent 进 buffer; missing 类事件同时实时推 daemon putNegative.
   */
  private deriveAccessEventFromResponse(
    opCtx: { op: string; path: string },
    resp: FileProxyResponse,
  ): void {
    // ENOENT + shallowestMissingAncestor: 写 missing
    if (resp.error?.code === 2 /* ENOENT */) {
      const ancestor = this.normalizeMissingAncestor(resp.shallowestMissingAncestor, opCtx.path);
      if (!ancestor) return; // 越界 / 缺字段 — 静默丢弃
      if (opCtx.op === "getattr" || opCtx.op === "read" || opCtx.op === "readdir") {
        this.accessBuffer.recordEvent({
          op: opCtx.op as any,
          path: opCtx.path,
          result: "missing",
          shallowestMissingAncestor: ancestor,
        });
        // 实时推 daemon — 让 namespace 内 CC 立即可见
        if (this.daemonControl) {
          void this.daemonControl.putNegative(ancestor);
        }
      }
      return;
    }

    // getattr 成功: stat 字段决定 file/dir
    if (opCtx.op === "getattr" && resp.stat) {
      this.accessBuffer.recordEvent({
        op: "getattr",
        path: opCtx.path,
        result: resp.stat.isDir ? "dir" : "file",
        mtime: resp.stat.mtime,
      });
      return;
    }

    // readdir 成功: entries 字段
    if (opCtx.op === "readdir" && resp.entries) {
      this.accessBuffer.recordEvent({ op: "readdir", path: opCtx.path, result: "ok" });
      return;
    }

    // read ok 不写 ledger (spec §4.3): CC read 之前必然 getattr 过, 不重复
  }

  /**
   * 校验 client 上报的 shallowestMissingAncestor 必须位于本 session FUSE roots 内 (Codex D1).
   * 越界返回 null, 由 caller 决定是否静默丢弃或 fallback 用原 path.
   * 缺字段 (client 实现 bug) 也返回 null.
   */
  private normalizeMissingAncestor(
    ancestor: string | undefined,
    fallbackPath: string,
  ): string | null {
    const candidate = ancestor && ancestor.length > 0 ? ancestor : fallbackPath;
    const sessionRoots = Object.values(this.roots);
    const inRoots = sessionRoots.some(
      (root) => candidate === root || candidate.startsWith(root + "/"),
    );
    if (!inRoots) {
      log.warn("shallowestMissingAncestor 越界 root, 降级丢弃", {
        sessionId: this.sessionId,
        ancestor: candidate,
        sessionRoots,
      });
      return null;
    }
    return candidate;
  }

  /**
   * Server-side cache hit 时的 lastAccessedAt 刷新 (5s 防抖).
   * 高频 hit 不能每次都写 buffer + 推 daemon - 没有意义且浪费. 5s 内同 path 只记一次.
   */
  private recordCacheHitAccess(path: string): void {
    const now = Date.now();
    if (this.cacheHitDebounce.has(path)) {
      const last = this.cacheHitDebounce.get(path)!;
      if (now - last < FileProxyManager.CACHE_HIT_DEBOUNCE_MS) return;
    }
    this.cacheHitDebounce.set(path, now);
    this.accessBuffer.recordEvent({ op: "cache_hit", path });
  }

  private static readonly FUSE_MAX_RETRIES = 3;
  private static readonly FUSE_RETRY_DELAY_MS = 1000;

  /**
   * 启动 FUSE daemon 并等待就绪（含重试）。
   * 必须在 namespace bootstrap 之前调用。
   */
  async start(): Promise<void> {
    this._mountPoint = path.join(this.runtimeRoot, "fuse");

    await mkdir(this._mountPoint, { recursive: true });

    // 写入 Python helper 脚本
    this.helperPath = await this.ensureHelperScript();

    // 在 FUSE daemon 启动前，向 Hand 批量获取各 root 的完整快照。
    // 一次 round-trip 替代原来 14k+ 次逐文件 round-trip（6s → <1s）。
    const snapshotFile = path.join(this.runtimeRoot, "cache-snapshot.json");
    await this.collectAndWriteSnapshot(snapshotFile).catch((err) => {
      log.warn("FUSE 缓存快照收集失败（退化为冷缓存）", {
        sessionId: this.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= FileProxyManager.FUSE_MAX_RETRIES; attempt++) {
      try {
        await this.tryStartDaemon(snapshotFile);
        return; // 成功
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        log.warn("FUSE daemon 启动失败，准备重试", {
          sessionId: this.sessionId,
          attempt,
          maxRetries: FileProxyManager.FUSE_MAX_RETRIES,
          error: lastError.message,
        });
        // 清理残留 mount point 和进程
        await this.cleanupFailedDaemon();
        if (attempt < FileProxyManager.FUSE_MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, FileProxyManager.FUSE_RETRY_DELAY_MS));
        }
      }
    }
    throw new Error(`FUSE daemon 启动失败（${FileProxyManager.FUSE_MAX_RETRIES} 次重试后放弃）: ${lastError?.message}`);
  }

  /** 清理失败的 FUSE daemon 残留 */
  private async cleanupFailedDaemon(): Promise<void> {
    if (this.fuseProcess && this.fuseProcess.exitCode === null) {
      this.fuseProcess.kill("SIGKILL");
      await new Promise<void>((resolve) => {
        this.fuseProcess!.once("exit", () => resolve());
        setTimeout(resolve, 2000);
      });
    }
    this.fuseProcess = null;
    this.controlStream = null;
    this.readline?.close();
    this.readline = null;
    // 清理可能的 stale mount
    try {
      execSync(`fusermount -u "${this._mountPoint}" 2>/dev/null || umount "${this._mountPoint}" 2>/dev/null || true`);
    } catch { /* ignore */ }
  }

  /** 单次尝试启动 FUSE daemon */
  private async tryStartDaemon(snapshotFile: string): Promise<void> {
    const readyFile = path.join(this.runtimeRoot, "fuse-ready");
    // 清除上次重试可能残留的 ready file
    await rm(readyFile, { force: true }).catch(() => undefined);

    log.info("启动 FUSE daemon", {
      sessionId: this.sessionId,
      mountPoint: this._mountPoint,
      roots: this.roots,
    });

    const child = spawn(
      "python3",
      [this.helperPath],
      {
        env: {
          ...process.env,
          CERELAY_FUSE_MOUNT_POINT: this._mountPoint,
          CERELAY_FUSE_CONTROL_FD: "3",
          CERELAY_FUSE_ROOTS: JSON.stringify(this.roots),
          CERELAY_FUSE_READY_FILE: readyFile,
          CERELAY_FUSE_SHADOW_FILES: JSON.stringify(this.shadowFiles),
          CERELAY_FUSE_CACHE_SNAPSHOT: snapshotFile,
        },
        stdio: ["pipe", "pipe", "pipe", "pipe"],
      }
    );

    this.fuseProcess = child;
    this.controlStream = child.stdio[3] as NodeJS.WritableStream;
    // controlStream 是 Writable - 包装为 DaemonControlClient 用于 Phase 5 access tracking 实时推送
    this.daemonControl = new DaemonControlClient(this.controlStream as unknown as import("node:stream").Writable);
    // Phase 5.3: spawn 完成后启 flush timer (定时把 buffer 写到 ledger)
    this.startFlushTimer();

    // 收集 stderr 用于异常退出时诊断
    // [FUSE-DIAG] 前缀的行是诊断专用日志（snapshot 加载汇总、cache miss path、
    // 周期 hit/miss 计数等），提升到 INFO 级别让它直接出现在 server 日志里，方便
    // 对照 server 端 perforation log 看 Python 那侧到底是 cache 没命中还是没有 key。
    const stderrChunks: string[] = [];
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (!text) return;
      stderrChunks.push(text.trim());
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("[FUSE-DIAG]")) {
          log.info("FUSE daemon 诊断", {
            sessionId: this.sessionId,
            text: trimmed.slice("[FUSE-DIAG]".length).trim(),
          });
        } else {
          log.debug("FUSE daemon stderr", { sessionId: this.sessionId, text: trimmed });
        }
      }
    });

    // 监听提前退出（mount 失败会导致进程立即退出）
    const earlyExitPromise = new Promise<never>((_, reject) => {
      child.once("exit", (code, signal) => {
        if (!this.destroyed) {
          log.error("FUSE daemon 异常退出", {
            sessionId: this.sessionId,
            code,
            signal,
            stderr: stderrChunks.join("\n"),
          });
        }
        this.rejectAllPending(new Error(`FUSE daemon exited (code=${code}, stderr=${stderrChunks.join(" | ")})`));
        reject(new Error(`FUSE daemon 启动失败，exitCode=${code}`));
      });
    });

    // 从 stdout 读取 FUSE daemon 的请求
    this.readline = createInterface({ input: child.stdout! });
    this.readline.on("line", (line) => {
      this.handleFuseLine(line).catch((err) => {
        log.error("处理 FUSE 请求失败", {
          sessionId: this.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    // 等待 FUSE mount 就绪，或进程提前退出
    await Promise.race([
      this.waitForReady(readyFile, 15_000),
      earlyExitPromise,
    ]);

    this.fuseDaemonReadyAt.value = Date.now();
    log.info("FUSE daemon 已就绪", {
      sessionId: this.sessionId,
      mountPoint: this._mountPoint,
    });

    // 启动期 FUSE 活动监控：从 daemon ready 到 60 秒，每 5s 汇总一次 op 计数与
    // client 穿透耗时。命令：CC 启动慢时（首次 stdout 长时间不到达），日志会显示
    // 是否仍有大量 FUSE 流量。无活动则说明瓶颈在 CC 进程自身（spawn / 网络 / API 等），
    // 而非文件代理。一旦 60s 后或 shutdown 时停止。
    this.startupStatsTimer = setInterval(() => {
      const sinceReady = this.fuseDaemonReadyAt.value
        ? Date.now() - this.fuseDaemonReadyAt.value
        : 0;
      if (sinceReady > 60_000 || this.destroyed) {
        this.stopStartupStatsTimer();
        return;
      }
      this.logStartupStats("startup periodic");
    }, 5_000);
    this.startupStatsTimer.unref?.();
  }

  private stopStartupStatsTimer(): void {
    if (this.startupStatsTimer) {
      clearInterval(this.startupStatsTimer);
      this.startupStatsTimer = null;
    }
  }

  private logStartupStats(reason: string): void {
    const ops: Record<string, number> = {};
    let total = 0;
    for (const [op, n] of this.opCounters) {
      ops[op] = n;
      total += n;
    }
    const sinceReady = this.fuseDaemonReadyAt.value
      ? Date.now() - this.fuseDaemonReadyAt.value
      : null;
    const sinceFirstReq = this.firstRequestAt ? Date.now() - this.firstRequestAt : null;
    if (total === 0 && this.cacheHitReads === 0 && reason === "startup periodic") {
      // 无活动也输出一行，让用户知道 FUSE 不是瓶颈
      log.info("FUSE 启动期活动统计 (无新请求)", {
        sessionId: this.sessionId,
        reason,
        sinceReadyMs: sinceReady,
        pendingRequests: this.pendingRequests.size,
      });
      return;
    }
    log.info("FUSE 启动期活动统计", {
      sessionId: this.sessionId,
      reason,
      sinceReadyMs: sinceReady,
      sinceFirstRequestMs: sinceFirstReq,
      totalOps: total,
      cacheHitReads: this.cacheHitReads,
      clientRoundTripMs: this.clientRoundTripMs,
      pendingRequests: this.pendingRequests.size,
      peakPendingRequests: this.peakPendingRequests,
      opCounts: ops,
      topPerforatedPaths: this.topPerforatedPaths(15),
    });
    this.lastStatsLoggedAt = Date.now();
  }

  /**
   * 取穿透次数 top-N 的 (op, root, relPath, reason, count) 列表，方便用户
   * 一眼看出"哪些路径频繁不命中 cache"作为优化突破口。
   */
  private topPerforatedPaths(n: number): Array<{ op: string; path: string; reason: string; count: number }> {
    const entries: Array<{ op: string; path: string; reason: string; count: number }> = [];
    for (const [key, value] of this.perforatedPaths) {
      const sepIdx = key.indexOf("\0");
      const op = sepIdx >= 0 ? key.slice(0, sepIdx) : "?";
      const path = sepIdx >= 0 ? key.slice(sepIdx + 1) : key;
      entries.push({ op, path, reason: value.reason, count: value.count });
    }
    entries.sort((a, b) => b.count - a.count);
    return entries.slice(0, n);
  }

  /**
   * 向 Client 发送 snapshot 请求，收集各 root 的完整目录树快照，
   * 写入临时文件供 FUSE daemon 启动时加载。
   * 一次 round-trip 替代原来 14k+ 次逐文件 FUSE 操作。
   */
  private async collectAndWriteSnapshot(snapshotFile: string): Promise<void> {
    const startedAt = Date.now();

    // === Phase 6 SeedWhitelist capture 模式 ===
    // 写一个空 snapshot 跳过 daemon perm cache 预热 — 让所有 RPC 穿透 client,
    // 这样 captureBuffer 才能记录到完整访问路径列表 (否则命中 perm cache 不发 RPC).
    if (this.captureSeedPath) {
      log.info("CAPTURE_SEED 模式: 跳过 snapshot 反向构造", {
        sessionId: this.sessionId,
        capturePath: this.captureSeedPath,
      });
      const emptySnapshot = JSON.stringify({
        stats: {}, readdirs: {}, reads: {}, negatives: [],
      });
      await writeFile(snapshotFile, emptySnapshot, "utf8");
      return;
    }

    // === Defect 1 修复 (spec §7.2): 阻塞等 cache ready, 无超时 ===
    // 之前 phase=syncing 时直接走 fallback (client 全量) — 跟 cache 同步抢跑导致即便
    // cache 已持久化 27000+ entries 仍走全量。现在: phase=syncing 阻塞等 ready,
    // 仅 phase=degraded/idle/不存在 时才退化为 fallback (兜底, 不会无限阻塞 PTY 启动).
    await this.waitForCacheReadyOrDegraded();

    // 区分 root：home-claude 和 home-claude-json 优先从 Server 侧缓存构造，
    // 避免启动时向 Client 发全量 snapshot 请求（单次 round-trip 变 0 次）。
    // project-claude 仍然穿透 Client —— 项目级文件不进 cache。
    const cacheCoveredRoots = new Set<string>(["home-claude", "home-claude-json"]);
    const rootsToFetchFromClient: Array<[string, string]> = [];
    const cachedEntries: FileProxySnapshotEntry[] = [];
    let cachedEntryCount = 0;
    const shouldUseCacheSnapshot = this.shouldUseCacheSnapshot();

    if (shouldUseCacheSnapshot) {
      const manifest = await this.cacheStore!.loadManifest(this.deviceId!);
      const built = this.buildSnapshotFromManifest(manifest);
      cachedEntries.push(...built);
      cachedEntryCount = built.length;
      log.debug("启动时从 cache 构造 snapshot", {
        sessionId: this.sessionId,
        deviceId: this.deviceId,
        cachedEntryCount,
      });
    }

    for (const [rootName, clientPath] of Object.entries(this.roots)) {
      if (cacheCoveredRoots.has(rootName) && shouldUseCacheSnapshot) {
        continue;
      }
      rootsToFetchFromClient.push([rootName, clientPath]);
    }

    // 未被 cache 覆盖的 root 并行向 Client 取 snapshot
    const results = await Promise.allSettled(
      rootsToFetchFromClient.map(async ([rootName, clientPath]) => {
        const reqId = `snapshot-${rootName}-${Date.now()}`;
        const resp = await this.sendSnapshotRequest(reqId, rootName, clientPath);
        return { rootName, entries: resp?.snapshot, negativeEntries: resp?.negativeEntries };
      })
    );

    // 组装快照 JSON：{ stats, readdirs, reads, negatives }
    // negatives：snapshot 期间发现的 broken symlink 等"应当 ENOENT 的路径"，FUSE
    // daemon 启动时预填到本地负缓存，避免 CC 反复探测时全程 RTT。
    const snapshot: {
      stats: Record<string, Record<string, unknown>>;
      readdirs: Record<string, string[]>;
      reads: Record<string, string>;
      negatives: string[];
    } = { stats: {}, readdirs: {}, reads: {}, negatives: [] };

    let entryCount = 0;

    // 诊断：分别统计每个来源（cache / 各 root client）的条目数 + 抽样路径，
    // 让用户判断 "snapshot 里到底有没有 skills/bytedcli 这种 path"。
    const perSourceCounts: Record<string, number> = {};
    const perSourceSamples: Record<string, string[]> = {};
    const recordSampleFor = (source: string, path: string): void => {
      perSourceCounts[source] = (perSourceCounts[source] ?? 0) + 1;
      const samples = perSourceSamples[source] ?? (perSourceSamples[source] = []);
      // 头 3 个 + 尾 3 个，便于看到 root 与深层路径同时存在
      if (samples.length < 3) {
        samples.push(path);
      } else {
        // 尾部用 ring buffer 保留最后 3 个
        if (samples.length === 3) samples.push("...");
        if (samples.length >= 7) samples.splice(4, 1);
        samples.push(path);
      }
    };

    // 1. 先写入 cache 构造的条目
    for (const entry of cachedEntries) {
      entryCount++;
      const cachePath = entry.path;
      snapshot.stats[cachePath] = statToFuseFormat(entry.stat);
      if (entry.entries) snapshot.readdirs[cachePath] = entry.entries;
      if (entry.data) snapshot.reads[cachePath] = entry.data;
      recordSampleFor("cache", cachePath);
    }

    // 2. 再写入 Client 穿透拿到的条目（project-claude 等）
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const { rootName, entries, negativeEntries } = result.value;
      if (entries) {
        for (const entry of entries) {
          entryCount++;
          const cachePath = entry.path;
          snapshot.stats[cachePath] = statToFuseFormat(entry.stat);
          if (entry.entries) snapshot.readdirs[cachePath] = entry.entries;
          if (entry.data) snapshot.reads[cachePath] = entry.data;
          recordSampleFor(`client:${rootName}`, cachePath);
        }
      }
      if (negativeEntries) {
        for (const negPath of negativeEntries) {
          snapshot.negatives.push(negPath);
        }
      }
    }

    // 3. 注入 AccessLedger 持久化的 missing 路径（spec §7.4 Defect 2 修复）
    //    投影范围：仅本 session 的 FUSE roots 内的 missing path。同 device 跨 cwd
    //    共享 ledger，但 daemon 只关心自己的 roots（避免污染其他 cwd 视图）。
    let ledgerMissingInjected = 0;
    let seedMissingInjected = 0;
    const negativesSeen = new Set(snapshot.negatives);

    if (this.accessLedgerStore && this.deviceId) {
      try {
        const allMissing = await this.accessLedgerStore.loadMissingForDevice(this.deviceId);
        const sessionRoots = Object.values(this.roots);
        for (const missingPath of allMissing) {
          const inRoots = sessionRoots.some(
            (root) => missingPath === root || missingPath.startsWith(root + "/"),
          );
          if (inRoots && !negativesSeen.has(missingPath)) {
            snapshot.negatives.push(missingPath);
            negativesSeen.add(missingPath);
            ledgerMissingInjected++;
          }
        }
      } catch (err) {
        log.warn("ledger.missing 投影失败 (降级, 不阻塞 snapshot 写出)", {
          sessionId: this.sessionId,
          deviceId: this.deviceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 4. 注入 SeedWhitelist.knownMissing - 兜底冷启动场景 (新 device / ledger 空时
    //    ledger.missing 没条目, SeedWhitelist 已知"CC 启动期常探但默认不存在"的路径
    //    必须也进 daemon _negative_perm, 否则全部穿透 client). claude-home scope
    //    的 knownMissing relPath 转绝对路径; claude-json scope 一般无 knownMissing.
    {
      const homeRoot = this.roots["home-claude"];
      const homeKnownMissing = SEED_WHITELIST.scopes["claude-home"]?.knownMissing ?? [];
      if (homeRoot) {
        for (const relPath of homeKnownMissing) {
          const absPath = relPath ? path.join(homeRoot, relPath) : homeRoot;
          if (!negativesSeen.has(absPath)) {
            snapshot.negatives.push(absPath);
            negativesSeen.add(absPath);
            seedMissingInjected++;
          }
        }
      }
    }

    // 5. 注入 ledger 中的 dir entries 为合成 dir stat — 解决 cache-sync file-only
    //    限制: manifest 不含 dir entry, CC 在 stat 已知 ledger 学过的父 dir 时穿透.
    //    实测案例: projects (CC stat 过但 readdirObserved=false, 子 sid 目录又没
    //    file 子项, 所以 manifest 完全没 projects/* 任何 entry, buildSnapshotFromManifest
    //    无法从父链派生 projects dir stat). 直接从 ledger.dir 合成 stat 注入 snapshot.
    let ledgerDirsInjected = 0;
    if (this.accessLedgerStore && this.deviceId) {
      try {
        const allDirs = await this.accessLedgerStore.loadDirsForDevice(this.deviceId);
        const sessionRoots = Object.values(this.roots);
        const statsSeen = new Set(Object.keys(snapshot.stats));
        for (const dirPath of allDirs) {
          const inRoots = sessionRoots.some(
            (root) => dirPath === root || dirPath.startsWith(root + "/"),
          );
          if (!inRoots) continue;
          if (statsSeen.has(dirPath)) continue;
          // 合成 dir stat (跟 buildSnapshotFromManifest 派生父 dir 时用同一 makeDirStat)
          snapshot.stats[dirPath] = statToFuseFormat(makeDirStat());
          statsSeen.add(dirPath);
          ledgerDirsInjected++;
        }
      } catch (err) {
        log.warn("ledger.dirs 投影失败 (降级, 不阻塞 snapshot 写出)", {
          sessionId: this.sessionId,
          deviceId: this.deviceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.info("missing 注入 snapshot", {
      sessionId: this.sessionId,
      deviceId: this.deviceId,
      ledgerMissingInjected,
      seedMissingInjected,
      ledgerDirsInjected,
      totalNegatives: snapshot.negatives.length,
    });

    const snapshotJson = JSON.stringify(snapshot);
    await writeFile(snapshotFile, snapshotJson, "utf8");

    const availability = this.explainCacheAvailability();
    log.info("FUSE 缓存快照已收集", {
      sessionId: this.sessionId,
      entryCount,
      cachedEntryCount,
      usedCacheSnapshot: shouldUseCacheSnapshot,
      cacheAvailability: availability.reason,
      cacheTaskState: availability.taskState,
      clientFetchedRoots: rootsToFetchFromClient.map(([r]) => r),
      durationMs: Date.now() - startedAt,
      // 诊断：snapshot json 体积 + 每来源 entry 数 / 抽样 path，确认 snapshot 完整性
      snapshotJsonBytes: Buffer.byteLength(snapshotJson, "utf8"),
      perSourceCounts,
      perSourceSamples,
      statKeyCount: Object.keys(snapshot.stats).length,
      readdirKeyCount: Object.keys(snapshot.readdirs).length,
      readKeyCount: Object.keys(snapshot.reads).length,
      negativeCount: snapshot.negatives.length,
      negativeSample: snapshot.negatives.slice(0, 10),
    });
  }

  /**
   * 从 ClientCacheStore 持久化的 manifest 反向构造出 FUSE snapshot 条目。
   *
   * - home-claude scope：目录 `~/.claude/` 及其中所有文件
   * - home-claude-json scope：单文件 `~/.claude.json`
   *
   * 处理细节：
   * - 目录 stat 是合成的（FUSE 只看 st_mode/st_size 等，uid/gid 默认当前进程）
   * - 中间目录（如 `subdir/nested.json` 中的 `subdir`）必须显式创建 stat + entries
   * - skipped 的大文件只有 stat，没有 data → FUSE read 时会触发穿透 Client
   * - blob 缺失（manifest 里有记录但 blob 被手动删除）与 skipped 同等处理
   */
  private buildSnapshotFromManifest(manifest: PersistedManifest): FileProxySnapshotEntry[] {
    const entries: FileProxySnapshotEntry[] = [];
    const claudeRoot = path.join(this.clientHomeDir, ".claude");
    const claudeJsonPath = path.join(this.clientHomeDir, ".claude.json");

    // claude-json: 单文件
    const jsonEntries = manifest.scopes["claude-json"]?.entries ?? {};
    const jsonEntry = jsonEntries[""];
    if (jsonEntry) {
      entries.push(this.cacheEntryToSnapshot(claudeJsonPath, jsonEntry, "claude-json", ""));
    }

    // claude-home: 目录 + 文件（完全空时不生成占位根目录，避免 FUSE 看到一个
    // 和 Client 本机不一致的空 ~/.claude）
    const homeEntries = manifest.scopes["claude-home"]?.entries ?? {};
    if (Object.keys(homeEntries).length > 0) {
      const allDirs = new Set<string>();
      allDirs.add(""); // 根目录 ~/.claude
      for (const relPath of Object.keys(homeEntries)) {
        const parts = relPath.split("/");
        for (let i = 1; i < parts.length; i++) {
          allDirs.add(parts.slice(0, i).join("/"));
        }
      }

      // 生成目录 stat + readdir
      for (const dir of allDirs) {
        const abs = dir ? path.join(claudeRoot, dir) : claudeRoot;
        const children = this.collectDirectChildren(dir, allDirs, Object.keys(homeEntries));
        entries.push({
          path: abs,
          stat: makeDirStat(),
          entries: Array.from(children).sort(),
        });
      }

      // 生成文件 stat + data
      for (const [relPath, entry] of Object.entries(homeEntries)) {
        const abs = path.join(claudeRoot, relPath);
        entries.push(this.cacheEntryToSnapshot(abs, entry, "claude-home", relPath));
      }
    }

    return entries;
  }

  private cacheEntryToSnapshot(
    absPath: string,
    entry: import("./protocol.js").CacheEntry,
    scope: CacheScope,
    relPath: string,
  ): FileProxySnapshotEntry {
    let data: string | undefined;
    if (!entry.skipped && entry.sha256 && this.cacheAvailable()) {
      const buf = this.cacheStore!.readBlobSync(this.deviceId!, entry.sha256);
      if (buf) {
        // 出口 #1：~/.claude/settings.json 灌进 Python 启动 snapshot 缓存前 redact 登录态字段。
        // size-preserving padding 保证 stat.size（取自 entry.size）与实际 data 一致。
        const out = isClaudeHomeSettingsJson(scope, relPath)
          ? redactClaudeSettingsLoginState(buf)
          : buf;
        data = out.toString("base64");
      }
      // blob 缺失（被删 / 损坏）时不带 data，FUSE read 时会穿透 Client
    }
    return {
      path: absPath,
      stat: makeFileStat(entry.size, entry.mtime),
      data,
    };
  }

  /**
   * 尝试从 cache 返回一次 FUSE read。命中返回 { served: true }，未命中返回
   * { served: false, reason } 让调用方记录 miss 原因。reason 取值（用于诊断 log）：
   *   - no_cache_store / no_device_id：cache 子系统未启用
   *   - no_scope：root 不属于 cache 覆盖范围（如 project-claude）
   *   - phase_not_ready / phase_*：cache task 状态机还没 ready
   *   - bypass_pending：写后短期穿透窗口
   *   - entry_missing / entry_skipped：manifest 里没记录 / 大文件未同步
   *   - blob_missing：sha256 落盘的 blob 文件丢失
   */
  private async tryServeReadFromCache(req: FuseRequest): Promise<{ served: true } | { served: false; reason: string }> {
    if (!this.cacheStore) return { served: false, reason: "no_cache_store" };
    if (!this.deviceId) return { served: false, reason: "no_device_id" };
    const scope = rootToCacheScope(req.root);
    if (!scope) return { served: false, reason: "no_scope" };
    if (this.cacheTaskManager && !this.cacheTaskManager.shouldUseCacheSnapshot(this.deviceId, this.clientCwd)) {
      const state = this.cacheTaskManager.describeTaskState(this.deviceId, this.clientCwd);
      return { served: false, reason: state.phase ? `phase_${state.phase}` : "task_state_missing" };
    }

    const cacheRelPath = toCacheRelPath(scope, req.relPath);
    if (
      this.cacheTaskManager &&
      this.cacheTaskManager.shouldBypassCacheRead(
        this.deviceId,
        this.clientCwd,
        scope,
        cacheRelPath,
      )
    ) {
      return { served: false, reason: "bypass_pending" };
    }
    const entry = await this.cacheStore.lookupEntry(
      this.deviceId,
      scope,
      cacheRelPath,
    );
    if (!entry) return { served: false, reason: "entry_missing" };
    if (entry.skipped) return { served: false, reason: "entry_skipped" };
    if (!entry.sha256) return { served: false, reason: "entry_no_sha256" };

    let buf = this.cacheStore.readBlobSync(this.deviceId, entry.sha256);
    if (!buf) return { served: false, reason: "blob_missing" };

    // 出口 #2：~/.claude/settings.json 命中 cache 后、切片前 redact 登录态字段。
    // size-preserving padding 保证 buf.byteLength 与 entry.size / stat.size 一致，
    // offset/size 切片语义不变。
    if (isClaudeHomeSettingsJson(scope, cacheRelPath)) {
      buf = redactClaudeSettingsLoginState(buf);
    }

    const offset = req.offset ?? 0;
    const size = req.size ?? buf.byteLength;
    const slice = buf.subarray(offset, Math.min(offset + size, buf.byteLength));
    this.writeToDaemon({
      reqId: req.reqId,
      data: slice.toString("base64"),
    });
    return { served: true };
  }

  /** 列出 dir 下的直接子项（子目录名 + 直接子文件名） */
  private collectDirectChildren(
    dir: string,
    allDirs: Set<string>,
    filePaths: string[],
  ): Set<string> {
    const children = new Set<string>();
    const prefix = dir ? `${dir}/` : "";

    for (const other of allDirs) {
      if (other === dir) continue;
      if (!other.startsWith(prefix)) continue;
      const remainder = other.slice(prefix.length);
      if (remainder && !remainder.includes("/")) children.add(remainder);
    }
    for (const filePath of filePaths) {
      if (!filePath.startsWith(prefix)) continue;
      const remainder = filePath.slice(prefix.length);
      if (remainder && !remainder.includes("/")) children.add(remainder);
    }
    return children;
  }

  private sendSnapshotRequest(
    reqId: string,
    rootName: string,
    clientPath: string,
  ): Promise<{
    snapshot?: import("./protocol.js").FileProxySnapshotEntry[];
    negativeEntries?: string[];
  } | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        log.warn("snapshot 请求超时", { sessionId: this.sessionId, rootName });
        resolve(undefined);
      }, 30_000);

      this.pendingRequests.set(reqId, {
        resolve: (resp) => {
          const r = resp as {
            snapshot?: import("./protocol.js").FileProxySnapshotEntry[];
            negativeEntries?: string[];
          };
          resolve({ snapshot: r.snapshot, negativeEntries: r.negativeEntries });
        },
        reject: () => resolve(undefined),
        timer,
      });

      this.sendToClient({
        type: "file_proxy_request",
        reqId,
        sessionId: this.sessionId,
        op: "snapshot",
        path: clientPath,
      }).catch(() => {
        this.pendingRequests.delete(reqId);
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  }

  /**
   * 处理 Client 返回的 file_proxy_response，dispatch 到等待中的 FUSE 请求。
   */
  resolveResponse(resp: FileProxyResponse): void {
    const deferred = this.pendingRequests.get(resp.reqId);
    if (!deferred) {
      log.debug("收到未知 reqId 的 file_proxy_response", {
        reqId: resp.reqId,
        sessionId: this.sessionId,
      });
      return;
    }
    this.pendingRequests.delete(resp.reqId);
    clearTimeout(deferred.timer);
    if (deferred.startedAt !== undefined) {
      this.clientRoundTripMs += Date.now() - deferred.startedAt;
    }

    // silent 路径：内部发起的 Client 请求（如 settings.json 全文穿透），
    // 把 raw response 交给调用方处理，不自动写回 Python daemon。
    if (deferred.silent) {
      deferred.resolve(resp as unknown as Record<string, unknown>);
      return;
    }

    // Phase 5.2: 派生 access event (含 ENOENT 时实时推 daemon putNegative)
    if (deferred.opForAccess) {
      try {
        this.deriveAccessEventFromResponse(deferred.opForAccess, resp);
      } catch (err) {
        // 派生失败不能阻塞主响应链路 - warn 后继续
        log.warn("派生 access event 失败 (降级)", {
          sessionId: this.sessionId,
          reqId: resp.reqId,
          op: deferred.opForAccess.op,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Phase 6: capture 模式 — 累积 RPC 访问路径
      if (this.captureSeedPath) {
        if (resp.error?.code === 2) {
          this.captureBuffer.push({
            op: deferred.opForAccess.op,
            path: deferred.opForAccess.path,
            result: "missing",
          });
        } else if (resp.stat) {
          this.captureBuffer.push({
            op: deferred.opForAccess.op,
            path: deferred.opForAccess.path,
            result: "ok",
            isDir: resp.stat.isDir,
            mtime: resp.stat.mtime,
          });
        } else if (resp.entries) {
          this.captureBuffer.push({
            op: deferred.opForAccess.op,
            path: deferred.opForAccess.path,
            result: "ok",
          });
        }
      }
    }

    // 将 Hand 响应写回 FUSE daemon stdin
    const fuseResp: Record<string, unknown> = { reqId: resp.reqId };
    if (resp.error) {
      fuseResp.error = resp.error;
    }
    if (resp.stat) {
      fuseResp.stat = resp.stat;
    }
    if (resp.entries) {
      fuseResp.entries = resp.entries;
    }
    if (resp.data !== undefined) {
      fuseResp.data = resp.data;
    }
    if (resp.written !== undefined) {
      fuseResp.written = resp.written;
    }
    if (resp.snapshot) {
      fuseResp.snapshot = resp.snapshot;
    }
    if (resp.negativeEntries) {
      // P0-1：snapshot response 带回的 broken symlink 等"应当 ENOENT 的路径"。
      // sendSnapshotRequest 的 deferred resolve 处会从这里取出来；不复制就丢失，
      // 导致 server 拿到的 snapshot 永远没有 negatives 字段（已实测复现）。
      fuseResp.negativeEntries = resp.negativeEntries;
    }

    this.writeToDaemon(fuseResp);
    deferred.resolve(fuseResp);
  }

  /**
   * 关闭 FUSE daemon：发送 shutdown → fusermount -u → kill。
   */
  /**
   * 启动期累计活动统计快照。供外部组件（如 PTY session 启动诊断）打 log 时合并使用。
   */
  getStartupStats(): {
    fuseDaemonReadyAt: number | null;
    firstRequestAt: number | null;
    totalOps: number;
    cacheHitReads: number;
    clientRoundTripMs: number;
    pendingRequests: number;
    peakPendingRequests: number;
    opCounts: Record<string, number>;
  } {
    const ops: Record<string, number> = {};
    let total = 0;
    for (const [op, n] of this.opCounters) {
      ops[op] = n;
      total += n;
    }
    return {
      fuseDaemonReadyAt: this.fuseDaemonReadyAt.value,
      firstRequestAt: this.firstRequestAt,
      totalOps: total,
      cacheHitReads: this.cacheHitReads,
      clientRoundTripMs: this.clientRoundTripMs,
      pendingRequests: this.pendingRequests.size,
      peakPendingRequests: this.peakPendingRequests,
      opCounts: ops,
    };
  }

  async shutdown(): Promise<void> {
    this.destroyed = true;
    this.stopStartupStatsTimer();
    this.stopFlushTimer();

    // Phase 5.3: shutdown 必 flush (保证 session 学到的 events 落盘)
    try {
      await this.flushAccessBufferIfNeeded();
    } catch {
      // flushAccessBufferIfNeeded 内部已经处理了所有 error; 这里兜底
    }

    // Phase 6: capture 模式 dump JSON
    if (this.captureSeedPath && this.captureBuffer.length > 0) {
      try {
        await writeFile(
          this.captureSeedPath,
          JSON.stringify({ events: this.captureBuffer }, null, 2),
          "utf8",
        );
        log.info("CAPTURE_SEED 已写出", {
          path: this.captureSeedPath,
          eventCount: this.captureBuffer.length,
        });
      } catch (err) {
        log.warn("CAPTURE_SEED 写出失败 (降级)", {
          path: this.captureSeedPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 发送 shutdown 控制消息
    if (this.controlStream) {
      try {
        this.controlStream.write(JSON.stringify({ type: "shutdown" }) + "\n");
      } catch {
        // 管道可能已关闭
      }
    }

    // 等待进程退出
    if (this.fuseProcess && this.fuseProcess.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.fuseProcess?.kill("SIGKILL");
          resolve();
        }, 5_000);

        this.fuseProcess!.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    // 清理 mount point
    try {
      execSync(`fusermount -u "${this._mountPoint}" 2>/dev/null || umount "${this._mountPoint}" 2>/dev/null || true`);
    } catch {
      // 忽略
    }

    this.readline?.close();
    this.rejectAllPending(new Error("FileProxyManager shutdown"));

    // 清理 helper 脚本
    try {
      await rm(this.helperPath, { force: true });
    } catch {
      // 忽略
    }
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /**
   * 处理 FUSE daemon stdout 的一行 JSON。
   * 将 FUSE 的虚拟根路径解析为 Client 侧绝对路径，转发给 Client。
   */
  private async handleFuseLine(line: string): Promise<void> {
    let req: FuseRequest;
    try {
      req = JSON.parse(line) as FuseRequest;
    } catch {
      return;
    }

    // 启动诊断：第一次收到 daemon 请求即记录时间，后续 stats 用其计算 "首次请求到现在" 间隔
    if (this.firstRequestAt === null) {
      this.firstRequestAt = Date.now();
      const sinceReady = this.fuseDaemonReadyAt.value
        ? this.firstRequestAt - this.fuseDaemonReadyAt.value
        : null;
      log.info("FUSE 收到首次 daemon 请求", {
        sessionId: this.sessionId,
        op: req.op,
        root: req.root,
        relPath: req.relPath,
        sinceReadyMs: sinceReady,
      });
    }
    this.opCounters.set(req.op, (this.opCounters.get(req.op) ?? 0) + 1);

    const { root, relPath, reqId } = req;
    const clientRoot = this.roots[root];
    if (!clientRoot) {
      // 未知 root，返回 ENOENT
      this.writeToDaemon({
        reqId,
        error: { code: 2, message: "ENOENT: unknown root" },
      });
      return;
    }

    // Phase 5.2: mutation op 派生 access event + 实时推 daemon control msg
    if (CACHE_MUTATING_OPS.has(req.op)) {
      const handPath = relPath ? path.join(clientRoot, relPath) : clientRoot;
      this.recordMutationEvent(req, handPath);
    }

    // 运行时 cache 读优先：对 read op 在 home-claude / home-claude-json 命中
    // blob 时直接从 Server 侧返回，不穿透 Client。
    // Python FUSE daemon 也会在本地 snapshot 缓存中查（启动时预热过），所以
    // 正常情况下这条路径只在 Python cache 被失效时才会触发，作为兜底。
    let readMissReason: string | undefined;
    if (req.op === "read") {
      if (!this.cacheAvailable()) {
        readMissReason = !this.cacheStore ? "no_cache_store" : "no_device_id";
      } else {
        const result = await this.tryServeReadFromCache(req);
        if (result.served) {
          this.cacheHitReads++;
          // Phase 5.2: server-side cache hit 刷 lastAccessedAt 防 aging 误清 (5s 防抖)
          const handPath = relPath ? path.join(clientRoot, relPath) : clientRoot;
          this.recordCacheHitAccess(handPath);
          return;
        }
        readMissReason = result.reason;
      }
    }

    // 出口 #3：~/.claude/settings.json 的 read 命中 cache miss / bypass / 未启用 cache
    // 三种穿透场景。Client doRead 严格按 (offset,size) 切片返回，server 看不到全文
    // 就无法判断哪些字节属于登录态字段。专用分支：拉全文 → redact → 本地切片。
    {
      const scope = rootToCacheScope(root);
      const cacheRelPath = scope ? toCacheRelPath(scope, relPath) : "";
      if (
        req.op === "read" &&
        scope !== null &&
        isClaudeHomeSettingsJson(scope, cacheRelPath)
      ) {
        await this.handleSettingsJsonReadPassthrough(req, clientRoot);
        return;
      }
    }

    // 构建 Client 侧绝对路径
    const clientPath = relPath ? path.join(clientRoot, relPath) : clientRoot;

    // 构建发给 Client 的 file_proxy_request
    const clientReq: FileProxyRequest = {
      type: "file_proxy_request",
      reqId,
      sessionId: this.sessionId,
      op: req.op as FileProxyRequest["op"],
      path: clientPath,
      data: req.data,
      offset: req.offset,
      size: req.size,
      mode: req.mode,
      atime: req.atime,
      mtime: req.mtime,
      newPath: req.op === "rename" && req.newRelPath !== undefined
        ? path.join(this.roots[req.newRoot ?? root] ?? clientRoot, req.newRelPath)
        : undefined,
    };

    // 路径穿透追踪：read 用 cache miss reason；其他 op（getattr/readdir/write/...）
    // 标 reason 为 op 名本身。让用户直接看到具体哪些路径在跑 client round-trip。
    const perforationKey = `${req.op}\0${root}/${relPath}`;
    const reasonForPerforation = readMissReason ?? `op_${req.op}`;
    const existing = this.perforatedPaths.get(perforationKey);
    if (!existing) {
      this.perforatedPaths.set(perforationKey, { count: 1, reason: reasonForPerforation });
      log.info("FUSE 穿透 client 首次出现", {
        sessionId: this.sessionId,
        op: req.op,
        root,
        relPath,
        reason: reasonForPerforation,
      });
    } else {
      existing.count++;
    }

    const mutationTargets = this.collectMutationHintTargets(req);
    let deferred: Deferred | undefined;

    try {
      if (
        mutationTargets.length > 0 &&
        this.cacheTaskManager &&
        this.deviceId
      ) {
        await this.cacheTaskManager.registerMutationHintForPath(
          this.deviceId,
          this.clientCwd,
          mutationTargets,
        );
      }

      // 注册 pending，等待 Client 响应
      deferred = this.createDeferred(reqId);
      // Phase 5.2: 记 opForAccess 让 resolveResponse 派生 AccessEvent
      // (clientPath 已在上方计算; mutation op 不进 access event 派生 — 它们走
      // recordMutationEvent 即时路径; access event 派生只覆盖 read-side ops)
      const isReadSideOp = req.op === "getattr" || req.op === "readdir" || req.op === "read";
      if (isReadSideOp) {
        deferred.opForAccess = { op: req.op, path: clientPath };
      }
      this.pendingRequests.set(reqId, deferred);
      if (this.pendingRequests.size > this.peakPendingRequests) {
        this.peakPendingRequests = this.pendingRequests.size;
      }
      await this.sendToClient(clientReq);
    } catch (err) {
      if (deferred) {
        this.pendingRequests.delete(reqId);
        clearTimeout(deferred.timer);
      }
      this.writeToDaemon({
        reqId,
        error: { code: 5, message: `EIO: failed to send to Client: ${err}` },
      });
    }
  }

  private createDeferred(reqId: string): Deferred {
    let resolve!: (resp: Record<string, unknown>) => void;
    let reject!: (err: Error) => void;

    // 不需要 Promise 本身，只用于 dispatch
    new Promise<Record<string, unknown>>((res, rej) => {
      resolve = res;
      reject = rej;
    }).catch(() => undefined);

    const timer = setTimeout(() => {
      this.pendingRequests.delete(reqId);
      this.writeToDaemon({
        reqId,
        error: { code: 110, message: "ETIMEDOUT: Client response timeout" },
      });
      reject(new Error("timeout"));
    }, 30_000);

    return { resolve, reject, timer, startedAt: Date.now() };
  }

  private writeToDaemon(data: Record<string, unknown>): void {
    if (!this.fuseProcess?.stdin?.writable) {
      return;
    }
    try {
      this.fuseProcess.stdin.write(JSON.stringify(data) + "\n");
    } catch {
      // stdin 可能已关闭
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [reqId, deferred] of this.pendingRequests) {
      clearTimeout(deferred.timer);
      deferred.reject(err);
    }
    this.pendingRequests.clear();
  }

  private async ensureHelperScript(): Promise<string> {
    const scriptDir = path.join(this.runtimeRoot, "fuse-helper");
    await mkdir(scriptDir, { recursive: true });
    const scriptPath = path.join(scriptDir, "cerelay-fuse-host.py");
    await writeFile(scriptPath, PYTHON_FUSE_HOST_SCRIPT, "utf8");
    await chmod(scriptPath, 0o755);
    return scriptPath;
  }

  private async waitForReady(
    readyFile: string,
    timeoutMs: number
  ): Promise<void> {
    const startedAt = Date.now();
    while (!existsSync(readyFile)) {
      if (
        this.fuseProcess &&
        this.fuseProcess.exitCode !== null
      ) {
        throw new Error(
          `FUSE daemon 启动失败，exitCode=${this.fuseProcess.exitCode}`
        );
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`等待 FUSE daemon ready 超时: ${readyFile}`);
      }
      await sleep(50);
    }
  }

  /**
   * 出口 #3 settings.json 专用穿透分支。
   * Client doRead 严格按 (offset,size) 切片返回，无法在 server 侧 redact 部分内容；
   * 此分支强制拉全文 → size-preserving redact → 按 Python 原始 (offset,size) 切片。
   *
   * 成本：cache 中没有 manifest entry 时多一次 getattr round-trip。
   * 该路径仅在 cache miss / mutation hint bypass / cache 未启用 时触发，
   * Python FUSE 端有 read TTL 缓存吸收热点请求，频率很低。
   */
  private async handleSettingsJsonReadPassthrough(
    req: FuseRequest,
    clientRoot: string,
  ): Promise<void> {
    const clientPath = req.relPath ? path.join(clientRoot, req.relPath) : clientRoot;
    const offsetOrig = req.offset ?? 0;
    const sizeOrig = req.size ?? 0;

    try {
      // 1. 拉全文 size：优先看 cache manifest（无额外 round-trip）；不可用时 stat
      let fullSize = await this.tryGetSettingsJsonSizeFromCache();
      if (fullSize === null) {
        const statResp = await this.sendClientRequest({
          op: "getattr",
          path: clientPath,
        });
        if (statResp.error || !statResp.stat) {
          throw new Error(
            `getattr failed: ${statResp.error?.message ?? "no stat in response"}`,
          );
        }
        fullSize = statResp.stat.size;
      }

      if (fullSize === 0) {
        this.writeToDaemon({ reqId: req.reqId, data: "" });
        return;
      }

      // 2. 拉全文内容
      const readResp = await this.sendClientRequest({
        op: "read",
        path: clientPath,
        offset: 0,
        size: fullSize,
      });
      if (readResp.error) {
        throw new Error(`read failed: ${readResp.error.message}`);
      }
      const fullBuf = Buffer.from(readResp.data ?? "", "base64");

      // 3. redact（size-preserving，输出长度 ≤ fullSize）
      const redacted = redactClaudeSettingsLoginState(fullBuf);

      // 4. 按 Python 原始 (offsetOrig, sizeOrig) 切片回 Python
      const end = Math.min(offsetOrig + sizeOrig, redacted.byteLength);
      const slice = offsetOrig >= redacted.byteLength
        ? Buffer.alloc(0)
        : redacted.subarray(offsetOrig, end);

      this.writeToDaemon({ reqId: req.reqId, data: slice.toString("base64") });
    } catch (err) {
      log.warn("settings.json passthrough 失败", {
        sessionId: this.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.writeToDaemon({
        reqId: req.reqId,
        error: { code: 5, message: `EIO: settings.json passthrough failed: ${err}` },
      });
    }
  }

  /**
   * 从 cacheStore 的 manifest 拿 ~/.claude/settings.json 的真实 size，
   * 跳过 stat round-trip。manifest 不可用 / entry 缺失时返回 null。
   */
  private async tryGetSettingsJsonSizeFromCache(): Promise<number | null> {
    if (!this.cacheStore || !this.deviceId) return null;
    try {
      const entry = await this.cacheStore.lookupEntry(
        this.deviceId,
        "claude-home",
        "settings.json",
      );
      if (!entry) return null;
      return entry.size;
    } catch {
      return null;
    }
  }

  /**
   * 内部发起的 Client 请求：复用 pendingRequests registry 但走 silent 路径，
   * 响应不自动写回 Python daemon，而是返回给调用方继续处理。
   * 用于 settings.json 全文穿透等需要 server 主动消费 Client 响应的场景。
   */
  private sendClientRequest(
    partial: Omit<FileProxyRequest, "type" | "reqId" | "sessionId">,
  ): Promise<FileProxyResponse> {
    return new Promise<FileProxyResponse>((resolve, reject) => {
      const reqId = `internal-${randomUUID()}`;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        reject(new Error("ETIMEDOUT: Client response timeout"));
      }, 30_000);

      this.pendingRequests.set(reqId, {
        resolve: (resp) => {
          resolve(resp as unknown as FileProxyResponse);
        },
        reject: (err) => {
          reject(err);
        },
        timer,
        silent: true,
      });

      this.sendToClient({
        type: "file_proxy_request",
        reqId,
        sessionId: this.sessionId,
        ...partial,
      }).catch((err) => {
        this.pendingRequests.delete(reqId);
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private collectMutationHintTargets(
    req: FuseRequest,
  ): Array<{ scope: CacheScope; path: string }> {
    if (!CACHE_MUTATING_OPS.has(req.op)) {
      return [];
    }

    const dedup = new Set<string>();
    const targets: Array<{ scope: CacheScope; path: string }> = [];
    const addTarget = (root: string | undefined, relPath: string | undefined) => {
      if (typeof relPath !== "string") {
        return;
      }
      const scope = rootToCacheScope(root ?? "");
      if (!scope) {
        return;
      }
      const cachePath = toCacheRelPath(scope, relPath);
      const key = `${scope}\0${cachePath}`;
      if (dedup.has(key)) {
        return;
      }
      dedup.add(key);
      targets.push({ scope, path: cachePath });
    };

    addTarget(req.root, req.relPath);
    if (req.op === "rename") {
      addTarget(req.newRoot ?? req.root, req.newRelPath);
    }
    return targets;
  }

}

const CACHE_MUTATING_OPS = new Set<string>([
  "write",
  "create",
  "unlink",
  "mkdir",
  "rmdir",
  "rename",
  "truncate",
  "setattr",
  "chmod",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 把 FUSE 的 root 名转成 cache scope 名。
 * project-claude 不走 cache（项目级文件频繁变更，穿透 Client 就行），返回 null。
 */
function rootToCacheScope(root: string): CacheScope | null {
  if (root === "home-claude") return "claude-home";
  if (root === "home-claude-json") return "claude-json";
  return null;
}

/**
 * FUSE 请求的 relPath → cache store 使用的 relPath。
 * claude-json scope 下，FUSE 的 relPath 总是 ""；cache store 也用 ""。
 * claude-home scope 直接透传。
 */
function toCacheRelPath(scope: CacheScope, fuseRelPath: string): string {
  if (scope === "claude-json") return "";
  return fuseRelPath;
}

/** 合成一个目录 stat，供从 manifest 构造 snapshot 时使用。 */
function makeDirStat(): FileProxyStat {
  return {
    mode: 0o755,
    size: 0,
    mtime: Math.floor(Date.now() / 1000),
    atime: Math.floor(Date.now() / 1000),
    uid: process.getuid ? process.getuid()! : 0,
    gid: process.getgid ? process.getgid()! : 0,
    isDir: true,
  };
}

/** 从 manifest 的 size + mtime 合成文件 stat。 */
function makeFileStat(size: number, mtime: number): FileProxyStat {
  // cache manifest 的 mtime 是毫秒；FileProxyStat 使用秒
  const mtimeSec = Math.floor(mtime / 1000);
  return {
    mode: 0o644,
    size,
    mtime: mtimeSec,
    atime: mtimeSec,
    uid: process.getuid ? process.getuid()! : 0,
    gid: process.getgid ? process.getgid()! : 0,
    isDir: false,
  };
}

function statToFuseFormat(st: import("./protocol.js").FileProxyStat): Record<string, unknown> {
  const S_IFDIR = 0o40000;
  const S_IFREG = 0o100000;
  const mode = st.isDir
    ? S_IFDIR | (st.mode & 0o7777)
    : S_IFREG | (st.mode & 0o7777);
  return {
    st_mode: mode,
    st_nlink: st.isDir ? 2 : 1,
    st_size: st.size,
    st_atime: st.atime,
    st_mtime: st.mtime,
    st_ctime: st.mtime,
    st_uid: st.uid,
    st_gid: st.gid,
  };
}
