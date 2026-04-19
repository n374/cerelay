import { spawn, type ChildProcess, execSync } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import path from "node:path";
import { tmpdir } from "node:os";
import { createLogger } from "./logger.js";
import { PYTHON_FUSE_HOST_SCRIPT } from "./fuse-host-script.js";
import type { FileProxyRequest, FileProxyResponse } from "./protocol.js";

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
}

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

  constructor(options: FileProxyManagerOptions) {
    this.runtimeRoot = options.runtimeRoot;
    this.sessionId = options.sessionId;
    this.clientHomeDir = options.clientHomeDir;
    this.clientCwd = options.clientCwd;
    this.sendToClient = options.sendToClient;
    this.shadowFiles = options.shadowFiles ?? {};

    this.roots = {
      "home-claude": path.join(this.clientHomeDir, ".claude"),
      "home-claude-json": path.join(this.clientHomeDir, ".claude.json"),
      "project-claude": path.join(this.clientCwd, ".claude"),
    };
  }

  get mountPoint(): string {
    return this._mountPoint;
  }

  /**
   * 启动 FUSE daemon 并等待就绪。
   * 必须在 namespace bootstrap 之前调用。
   */
  async start(): Promise<void> {
    this._mountPoint = path.join(this.runtimeRoot, "fuse");
    const readyFile = path.join(this.runtimeRoot, "fuse-ready");

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

    child.on("exit", (code, signal) => {
      if (!this.destroyed) {
        log.error("FUSE daemon 异常退出", {
          sessionId: this.sessionId,
          code,
          signal,
          stderr: stderrChunks.join("\n"),
        });
      }
      this.rejectAllPending(new Error(`FUSE daemon exited (code=${code}, stderr=${stderrChunks.join(" | ")})`));
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

    // 等待 FUSE mount 就绪（ready file 由 FUSE init() 回调写入，保证 mount 已生效）
    await this.waitForReady(readyFile, 15_000);

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

    // 并行对每个 root 发 snapshot 请求
    const results = await Promise.allSettled(
      Object.entries(this.roots).map(async ([rootName, clientPath]) => {
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
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const { rootName, entries } = result.value;
      if (!entries) continue;

      const handRoot = this.roots[rootName];
      for (const entry of entries) {
        entryCount++;
        // 将 Hand 绝对路径转换为 FUSE daemon 缓存用的 Hand 路径
        const cachePath = entry.path;
        snapshot.stats[cachePath] = statToFuseFormat(entry.stat);
        if (entry.entries) {
          snapshot.readdirs[cachePath] = entry.entries;
        }
        if (entry.data) {
          snapshot.reads[cachePath] = entry.data;
        }
      }
    }

    await writeFile(snapshotFile, JSON.stringify(snapshot), "utf8");

    log.info("FUSE 缓存快照已收集", {
      sessionId: this.sessionId,
      entryCount,
      durationMs: Date.now() - startedAt,
    });
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

    // 注册 pending，等待 Client 响应
    const deferred = this.createDeferred(reqId);
    this.pendingRequests.set(reqId, deferred);

    try {
      await this.sendToClient(clientReq);
    } catch (err) {
      this.pendingRequests.delete(reqId);
      clearTimeout(deferred.timer);
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

}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
