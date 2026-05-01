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

const log = createLogger("file-proxy-manager");

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
}

type CacheTaskReadGate = Pick<
  CacheTaskManager,
  "registerMutationHintForPath" | "shouldUseCacheSnapshot" | "shouldBypassCacheRead"
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

  get mountPoint(): string {
    return this._mountPoint;
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

    // 收集 stderr 用于异常退出时诊断
    const stderrChunks: string[] = [];
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        stderrChunks.push(text);
        log.debug("FUSE daemon stderr", { sessionId: this.sessionId, text });
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

    log.info("FUSE daemon 已就绪", {
      sessionId: this.sessionId,
      mountPoint: this._mountPoint,
    });
  }

  /**
   * 向 Client 发送 snapshot 请求，收集各 root 的完整目录树快照，
   * 写入临时文件供 FUSE daemon 启动时加载。
   * 一次 round-trip 替代原来 14k+ 次逐文件 FUSE 操作。
   */
  private async collectAndWriteSnapshot(snapshotFile: string): Promise<void> {
    const startedAt = Date.now();

    // 区分 root：home-claude 和 home-claude-json 优先从 Server 侧缓存构造，
    // 避免启动时向 Client 发全量 snapshot 请求（单次 round-trip 变 0 次）。
    // project-claude 仍然穿透 Client —— 项目级文件不进 cache。
    const cacheCoveredRoots = new Set<string>(["home-claude", "home-claude-json"]);
    const rootsToFetchFromClient: Array<[string, string]> = [];
    const cachedEntries: FileProxySnapshotEntry[] = [];
    let cachedEntryCount = 0;
    const shouldUseCacheSnapshot = this.shouldUseCacheSnapshot();

    if (shouldUseCacheSnapshot) {
      const manifest = await this.cacheStore!.loadManifest(this.deviceId!, this.clientCwd);
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
        return { rootName, entries: resp };
      })
    );

    // 组装快照 JSON：{ stats: {fusePath: statObj}, readdirs: {fusePath: entries}, reads: {fusePath: base64} }
    const snapshot: {
      stats: Record<string, Record<string, unknown>>;
      readdirs: Record<string, string[]>;
      reads: Record<string, string>;
    } = { stats: {}, readdirs: {}, reads: {} };

    let entryCount = 0;

    // 1. 先写入 cache 构造的条目
    for (const entry of cachedEntries) {
      entryCount++;
      const cachePath = entry.path;
      snapshot.stats[cachePath] = statToFuseFormat(entry.stat);
      if (entry.entries) snapshot.readdirs[cachePath] = entry.entries;
      if (entry.data) snapshot.reads[cachePath] = entry.data;
    }

    // 2. 再写入 Client 穿透拿到的条目（project-claude 等）
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const { entries } = result.value;
      if (!entries) continue;
      for (const entry of entries) {
        entryCount++;
        const cachePath = entry.path;
        snapshot.stats[cachePath] = statToFuseFormat(entry.stat);
        if (entry.entries) snapshot.readdirs[cachePath] = entry.entries;
        if (entry.data) snapshot.reads[cachePath] = entry.data;
      }
    }

    await writeFile(snapshotFile, JSON.stringify(snapshot), "utf8");

    log.info("FUSE 缓存快照已收集", {
      sessionId: this.sessionId,
      entryCount,
      cachedEntryCount,
      usedCacheSnapshot: shouldUseCacheSnapshot,
      clientFetchedRoots: rootsToFetchFromClient.map(([r]) => r),
      durationMs: Date.now() - startedAt,
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
      const buf = this.cacheStore!.readBlobSync(this.deviceId!, this.clientCwd, entry.sha256);
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
   * 尝试从 cache 返回一次 FUSE read。命中返回 true（已写回 FUSE daemon），
   * 未命中返回 false（调用方继续穿透 Client）。
   */
  private async tryServeReadFromCache(req: FuseRequest): Promise<boolean> {
    if (!this.cacheStore || !this.deviceId) return false;
    const scope = rootToCacheScope(req.root);
    if (!scope) return false;
    if (this.cacheTaskManager && !this.cacheTaskManager.shouldUseCacheSnapshot(this.deviceId, this.clientCwd)) {
      return false;
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
      return false;
    }
    const entry = await this.cacheStore.lookupEntry(
      this.deviceId,
      this.clientCwd,
      scope,
      cacheRelPath,
    );
    if (!entry || entry.skipped || !entry.sha256) return false;

    let buf = this.cacheStore.readBlobSync(this.deviceId, this.clientCwd, entry.sha256);
    if (!buf) return false;

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
    return true;
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
  ): Promise<import("./protocol.js").FileProxySnapshotEntry[] | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        log.warn("snapshot 请求超时", { sessionId: this.sessionId, rootName });
        resolve(undefined);
      }, 30_000);

      this.pendingRequests.set(reqId, {
        resolve: (resp) => {
          resolve((resp as { snapshot?: import("./protocol.js").FileProxySnapshotEntry[] }).snapshot);
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

    // silent 路径：内部发起的 Client 请求（如 settings.json 全文穿透），
    // 把 raw response 交给调用方处理，不自动写回 Python daemon。
    if (deferred.silent) {
      deferred.resolve(resp as unknown as Record<string, unknown>);
      return;
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

    this.writeToDaemon(fuseResp);
    deferred.resolve(fuseResp);
  }

  /**
   * 关闭 FUSE daemon：发送 shutdown → fusermount -u → kill。
   */
  async shutdown(): Promise<void> {
    this.destroyed = true;

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

    // 运行时 cache 读优先：对 read op 在 home-claude / home-claude-json 命中
    // blob 时直接从 Server 侧返回，不穿透 Client。
    // Python FUSE daemon 也会在本地 snapshot 缓存中查（启动时预热过），所以
    // 正常情况下这条路径只在 Python cache 被失效时才会触发，作为兜底。
    if (req.op === "read" && this.cacheAvailable() && await this.tryServeReadFromCache(req)) {
      return;
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
      this.pendingRequests.set(reqId, deferred);
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

    return { resolve, reject, timer };
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
        this.clientCwd,
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
