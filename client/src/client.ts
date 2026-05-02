import os from "node:os";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { Agent } from "node:http";
import WebSocket from "ws";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { ToolExecutor, summarizeToolResult, formatToolError } from "./executor.js";
import { FileProxyHandler } from "./file-proxy.js";
import { UI, CacheSyncProgressView } from "./ui.js";
import { createLogger, configureLogger, flushLogger } from "./logger.js";
import { getOrCreateDeviceId } from "./device-id.js";
import {
  DEFAULT_EXCLUDE_DIRS,
  loadConfig,
  type CerelayConfig,
} from "./config.js";
import {
  CacheTaskStateMachine,
  isCacheTaskDisabled,
  type CacheTaskStateMachineOptions,
} from "./cache-task-state-machine.js";
import type { CacheSyncEvent } from "./cache-sync.js";
import { openScanCache, type ScanCacheStore } from "./scan-cache.js";
import type {
  CacheTaskAssignment,
  CacheTaskDeltaAck,
  CacheTaskMutationHint,
  CreatePtySession,
  FileProxyRequest,
  PtyExit,
  PtyInput,
  PtyOutput,
  PtyResize,
  PtySessionCreated,
  ToolResult,
  ServerToHandMessage,
  ToolCall,
  ServerError,
} from "./protocol.js";

const log = createLogger("client");

export interface ClientOptions {
  interactiveOutput?: boolean;
  deviceId?: string;
  homedir?: string;
  loadConfig?: typeof loadConfig;
  openScanCache?: typeof openScanCache;
  isCacheTaskDisabled?: typeof isCacheTaskDisabled;
  cacheTaskStateMachineFactory?: (options: CacheTaskStateMachineOptions) => CacheTaskStateMachineLike;
}

interface CacheTaskStateMachineLike {
  onConnected(send: (message: import("./protocol.js").HandToServerMessage) => Promise<void>): Promise<void>;
  onDisconnected(): Promise<void>;
  onMessage(message: CacheTaskAssignment | CacheTaskDeltaAck | CacheTaskMutationHint | { type: "cache_task_heartbeat_ack" }): Promise<void>;
  isInitialSyncActive(): boolean;
}

export class CerelayClient {
  private readonly serverURL: string;
  private readonly cwd: string;
  private ws: WebSocket | null = null;
  private readonly ui: UI;
  private readonly interactiveOutput: boolean;
  private pendingMessages: string[] = [];
  private activeMessageConsumer: ((raw: string) => void) | null = null;
  private executor: ToolExecutor;
  private fileProxy: FileProxyHandler;
  private ptySessionId = "";
  private ptySessionCreatedAt = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private closeInProgress = false;
  private readonly homedir: string;
  /**
   * 本机设备 ID，用于 Server 侧文件缓存按 (deviceId, cwd) 隔离。
   * 在构造时读取/生成并持久化到 ~/.config/cerelay/device-id。
   */
  private readonly deviceId: string;
  private readonly loadConfigImpl: typeof loadConfig;
  private readonly openScanCacheImpl: typeof openScanCache;
  private readonly isCacheTaskDisabledImpl: typeof isCacheTaskDisabled;
  private readonly cacheTaskStateMachineFactory: (options: CacheTaskStateMachineOptions) => CacheTaskStateMachineLike;
  private cacheTaskStateMachine: CacheTaskStateMachineLike | null = null;
  private cacheSyncView: CacheSyncProgressView | null = null;

  constructor(serverURL: string, cwd: string, options: ClientOptions = {}) {
    this.serverURL = serverURL;
    this.cwd = cwd;
    this.ui = new UI();
    this.interactiveOutput = options.interactiveOutput ?? true;
    this.executor = new ToolExecutor(cwd);
    this.homedir = options.homedir ?? os.homedir();
    this.fileProxy = new FileProxyHandler(this.homedir, cwd);
    this.deviceId = options.deviceId ?? getOrCreateDeviceId();
    this.loadConfigImpl = options.loadConfig ?? loadConfig;
    this.openScanCacheImpl = options.openScanCache ?? openScanCache;
    this.isCacheTaskDisabledImpl = options.isCacheTaskDisabled ?? isCacheTaskDisabled;
    this.cacheTaskStateMachineFactory = options.cacheTaskStateMachineFactory
      ?? ((factoryOptions) => new CacheTaskStateMachine(factoryOptions));
    configureLogger({
      consoleSink: (line) => {
        if (!this.cacheSyncView) {
          return false;
        }
        this.cacheSyncView.printPersistent(line);
        return true;
      },
    });
  }

  connect(): Promise<void> {
    const connectStartedAt = Date.now();
    log.info("client connect entry", {
      serverURL: this.serverURL,
      cwd: this.cwd,
      deviceId: this.deviceId.slice(0, 8),
      homedir: this.homedir,
    });
    return new Promise((resolve, reject) => {
      if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
        this.ws.removeAllListeners();
        this.ws.close();
      }

      this.ws = null;
      this.pendingMessages = [];
      this.activeMessageConsumer = null;
      const agent = resolveProxyAgent(this.serverURL);
      const ws = new WebSocket(this.serverURL, agent ? { agent } : undefined);

      ws.on("open", () => {
        void (async () => {
          log.info("websocket open", {
            elapsedMs: Date.now() - connectStartedAt,
          });
          this.ws = ws;
          const disableCacheTask = this.isCacheTaskDisabledImpl();
          const config = disableCacheTask ? undefined : await this.safeLoadConfig();
          const scanCache = disableCacheTask
            ? undefined
            : await this.safeOpenScanCache({
              deviceId: this.deviceId,
              cwd: this.cwd,
            });

          this.cacheTaskStateMachine = this.cacheTaskStateMachineFactory({
            cwd: this.cwd,
            deviceId: this.deviceId,
            config,
            scanCache,
            homedir: this.homedir,
            disableCacheTask,
            onProgress: (event) => this.handleCacheSyncProgress(event),
          });
          ws.on("message", (data) => {
            const raw = data.toString();
            if (this.tryHandleFileProxyFromRaw(raw)) {
              return;
            }
            if (this.tryHandleCacheTaskFromRaw(raw)) {
              return;
            }
            if (this.activeMessageConsumer) {
              this.activeMessageConsumer(raw);
              return;
            }
            this.pendingMessages.push(raw);
          });
          ws.on("close", (code, reason) => {
            log.info("websocket close event", {
              code,
              reason: reason.toString(),
            });
            if (this.closeInProgress) {
              return;
            }
            void this.cacheTaskStateMachine?.onDisconnected();
            this.cacheTaskStateMachine = null;
            this.disposeCacheSyncView();
          });
          await this.cacheTaskStateMachine.onConnected((msg) => this.writeJSON(msg));
          resolve();
        })().catch(reject);
      });

      ws.on("error", (err) => {
        reject(new Error(`连接 ${this.serverURL} 失败: ${err.message}`));
      });
    });
  }

  async close(): Promise<void> {
    const closeStartedAt = Date.now();
    log.info("client close entry", {
      ptySessionId: this.ptySessionId,
      connected: Boolean(this.ws),
    });
    this.closeInProgress = true;
    this.fileProxy.dispose?.();
    const stateMachine = this.cacheTaskStateMachine;
    const disconnectStartedAt = Date.now();
    await stateMachine?.onDisconnected();
    log.info("cache task disconnected during close", {
      elapsedMs: Date.now() - disconnectStartedAt,
    });
    this.cacheTaskStateMachine = null;
    const ws = this.ws;
    if (ws) {
      await waitForWebSocketClose(ws);
      this.ws = null;
    }
    this.disposeCacheSyncView();
    const executorStartedAt = Date.now();
    try {
      await this.executor.close();
      log.info("executor closed during client close", {
        ok: true,
        elapsedMs: Date.now() - executorStartedAt,
      });
    } catch (error) {
      log.info("executor closed during client close", {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - executorStartedAt,
      });
    } finally {
      this.closeInProgress = false;
    }
    log.info("client close complete", {
      elapsedMs: Date.now() - closeStartedAt,
    });
    await flushLogger();
  }

  async sendCreatePtySession(cwd: string, model?: string, prompt?: string): Promise<string> {
    log.info("send create pty session", {
      cwd,
      model,
      oneShot: Boolean(prompt),
    });
    await this.resetExecutor(cwd);
    const projectClaudeSettingsLocalContent = await readProjectClaudeSettingsLocal(cwd);
    const msg: CreatePtySession = {
      type: "create_pty_session",
      cwd,
      homeDir: os.homedir(),
      model,
      projectClaudeSettingsLocalContent,
      cols: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
      term: process.env.TERM,
      colorTerm: process.env.COLORTERM,
      termProgram: process.env.TERM_PROGRAM,
      termProgramVersion: process.env.TERM_PROGRAM_VERSION,
      deviceId: this.deviceId,
      prompt,
    };
    await this.writeJSON(msg);
    const sessionId = await this.waitForPtySessionReady();
    this.ptySessionId = sessionId;
    this.ptySessionCreatedAt = Date.now();
    return sessionId;
  }

  getPtySessionId(): string {
    return this.ptySessionId;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** 启动期 cache 初始同步是否仍在 walk/hash/upload；false 则 \x03 应直通给远端 PTY */
  isCacheSyncActive(): boolean {
    return this.cacheTaskStateMachine?.isInitialSyncActive() ?? false;
  }

  private waitForPtySessionReady(): Promise<string> {
    const waitStartedAt = Date.now();
    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(new Error("WebSocket 未连接"));
        return;
      }

      const ws = this.ws;

      const cleanup = () => {
        releaseMessageConsumer();
        ws.off("error", onError);
        ws.off("close", onClose);
      };

      const onMessage = (raw: string) => {
        let msg: ServerToHandMessage;
        try {
          msg = JSON.parse(raw) as ServerToHandMessage;
        } catch {
          return;
        }

        switch (msg.type) {
          case "pty_session_created": {
            const created = msg as PtySessionCreated;
            log.info("pty session ready", {
              sessionId: created.sessionId,
              elapsedMs: Date.now() - waitStartedAt,
            });
            cleanup();
            resolve(created.sessionId);
            break;
          }
          case "connected":
            break;
          case "error": {
            cleanup();
            reject(new Error(`服务器错误: ${(msg as ServerError).message}`));
            break;
          }
          default:
            this.pendingMessages.push(raw);
            break;
        }
      };

      const onError = (err: Error) => {
        cleanup();
        reject(new Error(`等待 pty_session_created 失败: ${err.message}`));
      };

      const onClose = () => {
        cleanup();
        reject(new Error("等待 pty_session_created 时连接已关闭"));
      };

      const releaseMessageConsumer = this.attachMessageConsumer(onMessage);
      this.flushPendingMessages();
      ws.on("error", onError);
      ws.on("close", onClose);
    });
  }

  private tryHandleFileProxyFromRaw(raw: string): boolean {
    if (!raw.includes('"file_proxy_request"')) {
      return false;
    }
    try {
      const msg = JSON.parse(raw) as { type?: string };
      if (msg.type !== "file_proxy_request") {
        return false;
      }
      void this.handleFileProxyRequest(msg as FileProxyRequest);
      return true;
    } catch {
      return false;
    }
  }

  private tryHandleCacheTaskFromRaw(raw: string): boolean {
    if (!raw.includes('"cache_task_')) {
      return false;
    }
    try {
      const msg = JSON.parse(raw) as { type?: string };
      switch (msg.type) {
        case "cache_task_assignment":
        case "cache_task_delta_ack":
        case "cache_task_mutation_hint":
        case "cache_task_heartbeat_ack":
          if (this.cacheTaskStateMachine) {
            // onMessage 内部已对 cache sync 失败做了 error log + 降级，但仍需顶层 .catch 兜底：
            // 任何意外抛错都不能让这条 void 链变成 unhandled rejection（Node 25 默认会 crash 进程）。
            this.cacheTaskStateMachine.onMessage(
              msg as CacheTaskAssignment | CacheTaskDeltaAck | CacheTaskMutationHint | { type: "cache_task_heartbeat_ack" },
            ).catch((err) => {
              log.error("cache task onMessage 抛出未捕获异常，已忽略以保活进程", {
                msgType: msg.type,
                error: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined,
              });
            });
          }
          return true;
        default:
          return false;
      }
    } catch {
      return false;
    }
  }

  private async handleFileProxyRequest(req: FileProxyRequest): Promise<void> {
    const resp = await this.fileProxy.handle(req);
    await this.writeJSON(resp).catch((writeErr: unknown) => {
      log.error("发送 file_proxy_response 失败", {
        reqId: req.reqId,
        error: writeErr instanceof Error ? writeErr.message : String(writeErr),
      });
    });
  }

  private async executeToolCall(msg: ToolCall): Promise<void> {
    log.info("开始执行工具调用", {
      sessionId: msg.sessionId,
      requestId: msg.requestId,
      toolName: msg.toolName,
      inputSummary: summarizeUnknown(msg.input),
    });
    try {
      const result = await this.executor.dispatch(msg.toolName, msg.input);

      if (this.interactiveOutput) {
        this.ui.printToolResult(msg.toolName, true);
      }

      const resp: ToolResult = {
        type: "tool_result",
        sessionId: msg.sessionId,
        requestId: msg.requestId,
        output: result,
        summary: summarizeToolResult(msg.toolName, result),
      };

      log.info("工具调用执行成功", {
        sessionId: msg.sessionId,
        requestId: msg.requestId,
        toolName: msg.toolName,
        summary: resp.summary,
        outputSummary: summarizeUnknown(result),
      });

      await this.writeJSON(resp).catch((writeErr: unknown) => {
        this.ui.printError(
          `发送 tool_result 失败: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`
        );
      });
    } catch (err) {
      if (this.interactiveOutput) {
        this.ui.printToolResult(msg.toolName, false);
        this.ui.printError(`[${msg.toolName}] ${formatToolError(err)}`);
      }

      const resp: ToolResult = {
        type: "tool_result",
        sessionId: msg.sessionId,
        requestId: msg.requestId,
        error: formatToolError(err),
      };

      log.warn("工具调用执行失败", {
        sessionId: msg.sessionId,
        requestId: msg.requestId,
        toolName: msg.toolName,
        inputSummary: summarizeUnknown(msg.input),
        error: resp.error,
        rawError: formatErrorForLog(err),
      });

      await this.writeJSON(resp).catch((writeErr: unknown) => {
        this.ui.printError(
          `发送 tool_result(error) 失败: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`
        );
      });
    }
  }

  async runPtyPassthrough(sessionId: string): Promise<void> {
    log.info("run pty passthrough entry", {
      sessionId,
      cols: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
      isTTY: Boolean(process.stdin.isTTY),
    });
    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(new Error("WebSocket 未连接"));
        return;
      }

      configureLogger({ console: false });

      const ws = this.ws;
      const stdin = process.stdin;
      const stdout = process.stdout;
      const isTTY = Boolean(stdin.isTTY);
      const previousRawMode = isTTY ? stdin.isRaw : false;

      let stopSpinner: (() => void) | undefined;

      // 启动诊断：从进入 passthrough 到首次 pty_output 之间的时长，以及之后输出累积。
      // server 已在 PTY spawn 后周期 log "尚未首次 stdout"；client 这里则用于反映
      // server → ws → client 的端到端延迟，定位 "服务端有数据但本地没渲染"。
      const passthroughStartedAt = Date.now();
      let firstPtyOutputAt: number | null = null;
      let totalPtyOutputBytes = 0;
      let totalPtyOutputChunks = 0;
      let lastPtyStatsLoggedAt = 0;
      const noOutputDiagTimer = setInterval(() => {
        if (firstPtyOutputAt !== null) {
          clearInterval(noOutputDiagTimer);
          return;
        }
        log.warn("等待 pty_output 中（首帧未到达）", {
          sessionId,
          elapsedMs: Date.now() - passthroughStartedAt,
        });
      }, 5_000);
      noOutputDiagTimer.unref?.();

      const cleanup = () => {
        clearInterval(noOutputDiagTimer);
        stopSpinner?.();
        releaseMessageConsumer();
        ws.off("error", onError);
        ws.off("close", onClose);
        stdin.off("data", onInput);
        stdout.off("resize", onResize);
        if (isTTY) {
          stdin.setRawMode(previousRawMode);
        }
        stdin.pause();
        configureLogger({ console: true });
      };

      const finish = (error?: Error) => {
        cleanup();
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };

      const onMessage = (raw: string) => {
        let msg: ServerToHandMessage;
        try {
          msg = JSON.parse(raw) as ServerToHandMessage;
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
          return;
        }

        switch (msg.type) {
          case "file_proxy_request": {
            const proxyReq = msg as FileProxyRequest;
            if (proxyReq.sessionId !== sessionId) {
              break;
            }
            void this.handleFileProxyRequest(proxyReq);
            break;
          }
          case "tool_call": {
            const toolCall = msg as ToolCall;
            if (toolCall.sessionId !== sessionId) {
              break;
            }
            void this.executeToolCall(toolCall);
            break;
          }
          case "tool_call_complete":
            break;
          case "pty_output": {
            const output = msg as PtyOutput;
            if (output.sessionId !== sessionId) {
              break;
            }
            const buf = Buffer.from(output.data, "base64");
            totalPtyOutputBytes += buf.length;
            totalPtyOutputChunks++;
            if (firstPtyOutputAt === null) {
              firstPtyOutputAt = Date.now();
              clearInterval(noOutputDiagTimer);
              log.info("收到首次 pty_output", {
                sessionId,
                bytes: buf.length,
                elapsedSinceCreate: this.ptySessionCreatedAt > 0
                  ? firstPtyOutputAt - this.ptySessionCreatedAt
                  : undefined,
                elapsedMsSincePassthrough: firstPtyOutputAt - passthroughStartedAt,
              });
              lastPtyStatsLoggedAt = firstPtyOutputAt;
            } else if (Date.now() - lastPtyStatsLoggedAt >= 5_000) {
              // 启动期 CC TUI 经常分多次写出，用户感知 "看到完整界面" 滞后于首帧。
              // 这条日志反映 ws → 本地 stdout 的累计量，方便定位 "界面慢" 是否出在
              // server 节奏（参考 server 的 "PTY stdout 累计输出统计"）。
              log.info("pty_output 累计接收统计", {
                sessionId,
                totalBytes: totalPtyOutputBytes,
                totalChunks: totalPtyOutputChunks,
                elapsedMsSinceFirstOutput: Date.now() - (firstPtyOutputAt ?? Date.now()),
              });
              lastPtyStatsLoggedAt = Date.now();
            }
            stdout.write(buf);
            break;
          }
          case "pty_exit": {
            const exit = msg as PtyExit;
            if (exit.sessionId !== sessionId) {
              break;
            }
            finish();
            break;
          }
          case "error": {
            const serverError = msg as ServerError;
            if (serverError.sessionId && serverError.sessionId !== sessionId) {
              break;
            }
            finish(new Error(`服务器错误: ${serverError.message}`));
            break;
          }
        }
      };

      const onInput = (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        // raw 模式下终端不再产生 SIGINT，Ctrl+C 只剩下 \x03 字节；如果此时 cache 同步还在跑，
        // 字节会被原样转发给远端 PTY，本地 walk/hash/upload 永远收不到 abort 信号 → 用户卡死。
        // 在 sync 活跃窗口里把 \x03 转回 SIGINT，让顶层 handler 走 client.close + exit 路径。
        if (this.isCacheSyncActive() && buffer.includes(0x03)) {
          process.kill(process.pid, "SIGINT");
          return;
        }
        const payload: PtyInput = {
          type: "pty_input",
          sessionId,
          data: buffer.toString("base64"),
        };
        void this.writeJSON(payload).catch((error) => {
          finish(error instanceof Error ? error : new Error(String(error)));
        });
      };

      const onResize = () => {
        const payload: PtyResize = {
          type: "pty_resize",
          sessionId,
          cols: stdout.columns ?? 80,
          rows: stdout.rows ?? 24,
        };
        void this.writeJSON(payload).catch(() => undefined);
      };

      const onError = (err: Error) => {
        finish(err);
      };

      const onClose = () => {
        finish(new Error("WebSocket 连接已关闭"));
      };

      // PTY 启动 spinner ——"正在启动 Claude Code..."。统一走 cacheSyncView 的
      // pty-startup phase，跟 cache sync 的 scan/upload spinner 共享 100% 帧 /
      // trailing \n / printPersistent 等不变量；如果 cache sync 还在跑，本 phase
      // 会进 pending 队列等其结束后再激活，避免两个 spinner 争 stdout
      this.beginStartupSpinner();
      stopSpinner = () => this.endStartupSpinner();

      const wrappedOnMessage = (raw: string) => {
        // PTY 第一帧到达 → 启动完成，无论 phase 是否已激活都收尾
        if (raw.includes('"pty_output"')) {
          stopSpinner?.();
        }
        onMessage(raw);
      };

      const releaseMessageConsumer = this.attachMessageConsumer(wrappedOnMessage);
      this.flushPendingMessages();
      ws.on("error", onError);
      ws.on("close", onClose);
      if (isTTY) {
        stdin.setRawMode(true);
      }
      stdin.resume();
      stdin.on("data", onInput);
      stdout.on("resize", onResize);
      onResize();
    });
  }

  /**
   * One-shot 非交互模式：发送 prompt → 等 CC 完成 → 返回退出码。
   * 不开 raw mode，不绑 stdin，只把 pty_output 写到 stdout，pty_exit 时 resolve。
   * 供 e2e canary / CI 脚本化场景使用（对应 client CLI --prompt <text> 标志）。
   */
  async runOneShotMode(sessionId: string): Promise<number> {
    log.info("run one-shot mode entry", { sessionId });
    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(new Error("WebSocket 未连接"));
        return;
      }

      const ws = this.ws;

      const cleanup = () => {
        releaseMessageConsumer();
        ws.off("error", onError);
        ws.off("close", onClose);
      };

      const finish = (exitCode: number) => {
        cleanup();
        resolve(exitCode);
      };

      const onMessage = (raw: string) => {
        let msg: ServerToHandMessage;
        try {
          msg = JSON.parse(raw) as ServerToHandMessage;
        } catch (error) {
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }

        switch (msg.type) {
          case "tool_call": {
            const toolCall = msg as ToolCall;
            if (toolCall.sessionId !== sessionId) break;
            void this.executeToolCall(toolCall);
            break;
          }
          case "tool_call_complete":
            break;
          case "pty_output": {
            const output = msg as PtyOutput;
            if (output.sessionId !== sessionId) break;
            process.stdout.write(Buffer.from(output.data, "base64"));
            break;
          }
          case "pty_exit": {
            const exit = msg as PtyExit;
            if (exit.sessionId !== sessionId) break;
            log.info("one-shot pty_exit received", {
              sessionId,
              exitCode: exit.exitCode,
              signal: exit.signal,
            });
            finish(exit.exitCode ?? 0);
            break;
          }
          case "error": {
            const serverError = msg as ServerError;
            if (serverError.sessionId && serverError.sessionId !== sessionId) break;
            cleanup();
            reject(new Error(`服务器错误: ${serverError.message}`));
            break;
          }
        }
      };

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const onClose = () => {
        cleanup();
        // WS 关闭时如果 CC 已 exit，pty_exit 应先到达。若 WS 先关则认为异常退出。
        reject(new Error("WebSocket 连接已关闭（one-shot 模式等待 pty_exit 时）"));
      };

      const releaseMessageConsumer = this.attachMessageConsumer(onMessage);
      this.flushPendingMessages();
      ws.on("error", onError);
      ws.on("close", onClose);
    });
  }

  private handleCacheSyncProgress(event: CacheSyncEvent): void {
    if (!process.stdout.isTTY) {
      return;
    }
    this.ensureProgressView().handle(event);
    // upload_done / skipped 只是 cache sync 自身两个 phase 的终点；如果 PTY 启动
    // spinner 仍在跑或排队，view 不能 dispose——交由 endStartupSpinner 收尾
    if (event.kind === "skipped") {
      this.tryDisposeProgressView();
    }
  }

  /**
   * 写一行持久输出（如 `[PTY 已连接]`、日志路径）。如果当前有任何活跃 phase
   * （cache sync 或 pty-startup），走 view 的 print-above-spinner 路径，避免
   * 污染 spinner 的 cursor 行追踪；否则直接 stdout。
   */
  printAboveSyncProgress(content: string): void {
    if (this.cacheSyncView) {
      this.cacheSyncView.printPersistent(content);
      return;
    }
    process.stdout.write(content);
  }

  /**
   * 启动 "正在启动 Claude Code..." spinner。统一走 view 的 pty-startup phase——
   * 如果 cache sync 还在跑，phase 会进 pending 队列等当前 phase 结束后再激活；
   * 同一时刻最多只有一个 spinner 在写 stdout。非 TTY 直接跳过。
   */
  beginStartupSpinner(message?: string): void {
    if (!process.stdout.isTTY) return;
    this.ensureProgressView().beginPtyStartup(message);
  }

  /**
   * 结束 "正在启动 Claude Code..." spinner（PTY 第一帧到达 / pty_exit / 错误）。
   * 调用后如果所有 phase 都已结束，view 会被 dispose 掉释放 timer 等资源。
   */
  endStartupSpinner(): void {
    this.cacheSyncView?.endPtyStartup();
    this.tryDisposeProgressView();
  }

  private ensureProgressView(): CacheSyncProgressView {
    if (!this.cacheSyncView) {
      this.cacheSyncView = new CacheSyncProgressView();
    }
    return this.cacheSyncView;
  }

  /**
   * 如果当前没有任何活跃 phase，就 dispose view 释放 timer。
   * 不能粗暴地一律 dispose——cache sync 和 pty-startup phase 可能交叠。
   */
  private tryDisposeProgressView(): void {
    if (!this.cacheSyncView) return;
    if (this.cacheSyncView.isIdle()) {
      this.cacheSyncView.dispose();
      this.cacheSyncView = null;
    }
  }

  private disposeCacheSyncView(): void {
    this.cacheSyncView?.dispose();
    this.cacheSyncView = null;
  }

  private writeJSON(data: unknown): Promise<void> {
    const nextWrite = this.writeChain
      .catch(() => undefined)
      .then(() => this.doWriteJSON(data));

    this.writeChain = nextWrite.catch(() => undefined);
    return nextWrite;
  }

  private doWriteJSON(data: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket 未连接或已关闭"));
        return;
      }

      this.ws.send(JSON.stringify(data), (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  private async resetExecutor(cwd: string): Promise<void> {
    this.fileProxy.dispose?.();
    this.fileProxy = new FileProxyHandler(os.homedir(), cwd);
    await this.executor.close().catch(() => undefined);
    this.executor = new ToolExecutor(cwd);
  }

  private attachMessageConsumer(consumer: (raw: string) => void): () => void {
    this.activeMessageConsumer = consumer;
    return () => {
      if (this.activeMessageConsumer === consumer) {
        this.activeMessageConsumer = null;
      }
    };
  }

  private flushPendingMessages(): void {
    while (this.activeMessageConsumer && this.pendingMessages.length > 0) {
      const raw = this.pendingMessages.shift();
      if (raw === undefined) {
        break;
      }
      this.activeMessageConsumer(raw);
    }
  }

  private async safeLoadConfig(): Promise<CerelayConfig> {
    try {
      return await this.loadConfigImpl();
    } catch (error) {
      log.warn("loadConfig 抛出异常，回退默认 scan 配置", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        scan: {
          excludeDirs: [...DEFAULT_EXCLUDE_DIRS],
        },
      };
    }
  }

  private async safeOpenScanCache(args: {
    deviceId: string;
    cwd: string;
  }): Promise<ScanCacheStore | undefined> {
    try {
      return await this.openScanCacheImpl(args);
    } catch (error) {
      log.warn("openScanCache 抛出异常，降级为 no-op 行为", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
}

function summarizeUnknown(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }

  if (typeof value === "string") {
    return previewText(value, 120);
  }

  try {
    return previewText(JSON.stringify(value), 120);
  } catch {
    return String(value);
  }
}

function waitForWebSocketClose(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, 500);
    timeout.unref?.();
    const onClose = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("close", onClose);
    };
    ws.once("close", onClose);
    if (ws.readyState !== WebSocket.CLOSING) {
      ws.close();
    }
  });
}

async function readProjectClaudeSettingsLocal(cwd: string): Promise<string | undefined> {
  const settingsPath = path.join(cwd, ".claude", "settings.local.json");
  if (!existsSync(settingsPath)) {
    return undefined;
  }

  try {
    return await readFile(settingsPath, "utf8");
  } catch (error) {
    log.warn("读取项目级 Claude settings.local.json 失败，已忽略", {
      cwd,
      settingsPath,
      error: formatErrorForLog(error),
    });
    return undefined;
  }
}

function previewText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
}

function formatErrorForLog(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function resolveProxyAgent(serverURL: string): Agent | undefined {
  const url = new URL(serverURL);
  const isSecure = url.protocol === "wss:";

  if (matchesNoProxy(url.hostname, url.port)) {
    return undefined;
  }

  const env = process.env;
  const proxyURL = isSecure
    ? (env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy)
    : (env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy);

  if (!proxyURL) {
    return undefined;
  }

  return isSecure
    ? new HttpsProxyAgent(proxyURL)
    : new HttpProxyAgent(proxyURL);
}

function matchesNoProxy(hostname: string, port: string): boolean {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (!noProxy) return false;

  const entries = noProxy.split(",").map((s) => s.trim()).filter(Boolean);
  for (const entry of entries) {
    if (entry === "*") return true;

    const [hostPattern, portPattern] = entry.split(":");
    if (portPattern && portPattern !== port) continue;

    if (hostname === hostPattern) return true;
    if (hostPattern.startsWith(".") && hostname.endsWith(hostPattern)) return true;
    if (!hostPattern.startsWith(".") && hostname.endsWith(`.${hostPattern}`)) return true;
  }
  return false;
}
