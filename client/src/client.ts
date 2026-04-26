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
import { createLogger, configureLogger } from "./logger.js";
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
  private writeChain: Promise<void> = Promise.resolve();
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
  }

  connect(): Promise<void> {
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
          ws.on("close", () => {
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

  close(): void {
    log.debug("关闭 CerelayClient", {
      ptySessionId: this.ptySessionId,
      connected: Boolean(this.ws),
    });
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    void this.cacheTaskStateMachine?.onDisconnected();
    this.cacheTaskStateMachine = null;
    this.disposeCacheSyncView();
    void this.executor.close().catch(() => undefined);
  }

  async sendCreatePtySession(cwd: string, model?: string): Promise<string> {
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
    };
    await this.writeJSON(msg);
    const sessionId = await this.waitForPtySessionReady();
    this.ptySessionId = sessionId;
    return sessionId;
  }

  getPtySessionId(): string {
    return this.ptySessionId;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private waitForPtySessionReady(): Promise<string> {
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

      const cleanup = () => {
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
            stdout.write(Buffer.from(output.data, "base64"));
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

      const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
      let spinnerIndex = 0;
      let spinnerActive = true;
      const spinnerTimer = setInterval(() => {
        if (!spinnerActive) return;
        const frame = spinnerFrames[spinnerIndex % spinnerFrames.length];
        stdout.write(`\r\x1b[36m${frame} 正在启动 Claude Code...\x1b[0m\x1b[K`);
        spinnerIndex++;
      }, 100);

      stopSpinner = () => {
        if (!spinnerActive) return;
        spinnerActive = false;
        clearInterval(spinnerTimer);
        stdout.write("\r\x1b[K");
      };

      const wrappedOnMessage = (raw: string) => {
        if (spinnerActive && raw.includes('"pty_output"')) {
          stopSpinner();
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

  private handleCacheSyncProgress(event: CacheSyncEvent): void {
    if (!process.stdout.isTTY) {
      return;
    }
    if (!this.cacheSyncView) {
      this.cacheSyncView = new CacheSyncProgressView();
    }
    this.cacheSyncView.handle(event);
    if (event.kind === "upload_done" || event.kind === "skipped") {
      this.disposeCacheSyncView();
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
