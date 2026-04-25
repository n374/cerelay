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
import { performInitialCacheSync } from "./cache-sync.js";
import type {
  CacheHandshake,
  CacheManifest,
  CachePush,
  CachePushAck,
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
}

export class CerelayClient {
  private readonly serverURL: string;
  private ws: WebSocket | null = null;
  private readonly ui: UI;
  private readonly interactiveOutput: boolean;
  private pendingMessages: string[] = [];
  private activeMessageConsumer: ((raw: string) => void) | null = null;
  private executor: ToolExecutor;
  private fileProxy: FileProxyHandler;
  private ptySessionId = "";
  private writeChain: Promise<void> = Promise.resolve();
  /**
   * 本机设备 ID，用于 Server 侧文件缓存按 (deviceId, cwd) 隔离。
   * 在构造时读取/生成并持久化到 ~/.config/cerelay/device-id。
   */
  private readonly deviceId: string;
  /** 启动时缓存同步只做一次，避免 reconnect 场景下重复上传 */
  private cacheSyncDone = false;

  constructor(serverURL: string, cwd: string, options: ClientOptions = {}) {
    this.serverURL = serverURL;
    this.ui = new UI();
    this.interactiveOutput = options.interactiveOutput ?? true;
    this.executor = new ToolExecutor(cwd);
    this.fileProxy = new FileProxyHandler(os.homedir(), cwd);
    this.deviceId = getOrCreateDeviceId();
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
        this.ws = ws;
        ws.on("message", (data) => {
          const raw = data.toString();
          if (this.tryHandleFileProxyFromRaw(raw)) {
            return;
          }
          if (this.activeMessageConsumer) {
            this.activeMessageConsumer(raw);
            return;
          }
          this.pendingMessages.push(raw);
        });
        resolve();
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
    void this.executor.close().catch(() => undefined);
  }

  async sendCreatePtySession(cwd: string, model?: string): Promise<string> {
    // 启动前先做一次文件缓存同步：只在本次 client 生命周期内执行一次，
    // 失败不阻塞 session 创建（降级为"无 Server 缓存"，FUSE 仍可穿透到 Client）。
    await this.ensureInitialCacheSync(cwd);
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

  /**
   * 启动时的 cache 同步入口。
   *
   * - 失败不抛：缓存同步失败只是导致启动慢一点，不应让用户无法使用
   * - 整个流程期间独占 activeMessageConsumer，因为此时 PTY session 尚未创建，
   *   FUSE 请求通过独立 fast path (`tryHandleFileProxyFromRaw`) 处理，不会被借走
   */
  private async ensureInitialCacheSync(cwd: string): Promise<void> {
    if (this.cacheSyncDone) return;
    if (process.env.CERELAY_DISABLE_INITIAL_CACHE_SYNC === "true") {
      // 测试场景：mock server 不响应 cache_handshake，直接跳过避免超时
      log.debug("CERELAY_DISABLE_INITIAL_CACHE_SYNC=true，跳过启动缓存同步");
      this.cacheSyncDone = true;
      return;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log.warn("WebSocket 未就绪，跳过缓存同步");
      return;
    }

    // 仅在 TTY 场景下挂进度视图。非 TTY（管道/CI）走纯 log，不输出 ANSI。
    const ttyView = process.stdout.isTTY ? new CacheSyncProgressView() : null;

    // pipeline 模式下需要长期监听 cache_push_ack（多个 ack 并发到达）+ 一次性收
    // cache_manifest。这里挂一个长期 consumer 自己分流，不复用 waitForSpecificMessage
    // 的"单次 consumer"模式。其他类型消息（pty_session_created 等）回流到
    // pendingMessages，留给后续主流程处理。
    let manifestResolve: ((m: CacheManifest) => void) | null = null;
    const ackSubscribers = new Set<(ack: CachePushAck) => void>();

    const onCacheMessage = (raw: string) => {
      let parsed: { type?: string };
      try {
        parsed = JSON.parse(raw) as { type?: string };
      } catch {
        this.pendingMessages.push(raw);
        return;
      }
      if (parsed.type === "cache_manifest" && manifestResolve) {
        const r = manifestResolve;
        manifestResolve = null;
        r(parsed as CacheManifest);
        return;
      }
      if (parsed.type === "cache_push_ack") {
        // 复制订阅列表后再迭代，避免回调里 unsubscribe 引发副作用
        for (const sub of Array.from(ackSubscribers)) {
          try {
            sub(parsed as CachePushAck);
          } catch (subErr) {
            log.warn("ack subscriber 抛错，已忽略", {
              error: subErr instanceof Error ? subErr.message : String(subErr),
            });
          }
        }
        return;
      }
      this.pendingMessages.push(raw);
    };

    const releaseConsumer = this.attachMessageConsumer(onCacheMessage);
    this.flushPendingMessages();

    try {
      const summaries = await performInitialCacheSync(
        {
          sendMessage: (msg: CacheHandshake | CachePush) => this.writeJSON(msg),
          waitForServerMessage: <T>(predicate: (raw: string) => T | null, timeoutMs: number) => {
            // 仅 cache_manifest 一次性场景：钩进上面的长期 consumer
            return new Promise<T>((resolve, reject) => {
              const timer = setTimeout(() => {
                manifestResolve = null;
                reject(new Error(`等待 cache_manifest 超时（${timeoutMs}ms）`));
              }, timeoutMs);
              manifestResolve = (msg) => {
                clearTimeout(timer);
                const matched = predicate(JSON.stringify(msg));
                if (matched === null) {
                  reject(new Error("manifest predicate 拒绝消息"));
                  return;
                }
                resolve(matched);
              };
            });
          },
          subscribeAcks: (handler) => {
            ackSubscribers.add(handler);
            return () => {
              ackSubscribers.delete(handler);
            };
          },
          homedir: os.homedir(),
          onProgress: ttyView ? (event) => ttyView.handle(event) : undefined,
        },
        {
          deviceId: this.deviceId,
          cwd,
        },
      );
      for (const s of summaries) {
        log.info("启动缓存同步完成", {
          scope: s.scope,
          pushed: s.pushed,
          deleted: s.deleted,
          skippedLarge: s.skippedLarge,
          truncated: s.truncated,
          totalLocal: s.totalLocal,
          error: s.error,
        });
      }
      this.cacheSyncDone = true;
    } catch (err) {
      log.warn("启动缓存同步异常，降级继续", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      ttyView?.dispose();
      releaseConsumer();
    }
  }

  /**
   * 临时订阅一条符合 predicate 的消息。超时会 reject。
   *
   * - 命中 predicate 的消息被消费；其他消息回流到 pendingMessages
   * - consumer 独占期间，FUSE 请求仍由 fast path 拦截，不受影响
   */
  private waitForSpecificMessage<T>(
    predicate: (raw: string) => T | null,
    timeoutMs: number,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.ws) {
        reject(new Error("WebSocket 未连接"));
        return;
      }

      let release: (() => void) | null = null;
      const timer = setTimeout(() => {
        release?.();
        reject(new Error(`等待 Server 消息超时（${timeoutMs}ms）`));
      }, timeoutMs);

      const onMessage = (raw: string) => {
        const matched = predicate(raw);
        if (matched !== null) {
          clearTimeout(timer);
          release?.();
          resolve(matched);
          return;
        }
        // 非目标消息回流到 pending 队列，等后续 consumer 处理
        this.pendingMessages.push(raw);
      };

      release = this.attachMessageConsumer(onMessage);
      this.flushPendingMessages();
    });
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
