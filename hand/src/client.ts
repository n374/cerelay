import os from "node:os";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import WebSocket from "ws";
import { ToolExecutor, summarizeToolResult, formatToolError } from "./executor.js";
import { UI } from "./ui.js";
import { createLogger, configureLogger } from "./logger.js";
import type {
  CreateSession,
  CreatePtySession,
  CreateSessionResponse,
  McpServerConfig,
  McpServerCatalogEntry,
  Prompt,
  PtyExit,
  PtyInput,
  PtyOutput,
  PtyResize,
  PtySessionCreated,
  RestoreSession,
  RestoreSessionResponse,
  SessionMcpCatalog,
  SessionMcpCatalogApplied,
  ToolResult,
  ServerToHandMessage,
  ToolCall,
  SessionEnd,
  ServerError,
  TextChunk,
  ThoughtChunk,
} from "./protocol.js";

const log = createLogger("hand-client");

// ============================================================
// 回调接口：供 ACP Server 等非 UI 场景使用
// ============================================================

export interface HandClientCallbacks {
  onTextChunk?: (text: string) => void;
  onThoughtChunk?: (text: string) => void;
  onToolCall?: (toolName: string, requestId: string, input: unknown) => void;
  onToolCallComplete?: (toolName: string, requestId: string) => void;
  onToolResult?: (toolName: string, requestId: string, output: unknown, error?: string) => void;
}

export interface HandClientOptions {
  interactiveOutput?: boolean;
}

export interface EnsureSessionOptions {
  cwd: string;
  model?: string;
  allowCreateOnRestoreFailure?: boolean;
}

// ============================================================
// HandClient：连接 Axon Server 并处理消息
// ============================================================

export class HandClient {
  private readonly serverURL: string;
  private readonly initialCwd: string;
  private ws: WebSocket | null = null;
  private readonly ui: UI;
  private readonly interactiveOutput: boolean;
  private pendingMessages: string[] = [];
  private activeMessageConsumer: ((raw: string) => void) | null = null;
  // executor 在 session 创建后含有正确的 cwd，先用占位 cwd 初始化
  private executor: ToolExecutor;
  private currentCwd: string;

  // 当前活跃的 session ID
  private sessionId = "";
  private ptySessionId = "";

  // 最后一次 session_end 结果（供 ACP Server 查询）
  private lastResult: { result?: string; error?: string } = {};
  private activeCallbacks: HandClientCallbacks | undefined;

  // 写锁：用 Promise 链模拟互斥，确保并发写安全
  private writeChain: Promise<void> = Promise.resolve();

  constructor(serverURL: string, cwd: string, options: HandClientOptions = {}) {
    this.serverURL = serverURL;
    this.initialCwd = cwd;
    this.currentCwd = cwd;
    this.ui = new UI();
    this.interactiveOutput = options.interactiveOutput ?? true;
    this.executor = new ToolExecutor(cwd);
  }

  // 连接到 Server
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
        this.ws.removeAllListeners();
        this.ws.close();
      }

      this.ws = null;
      this.pendingMessages = [];
      this.activeMessageConsumer = null;
      const ws = new WebSocket(this.serverURL);

      ws.on("open", () => {
        this.ws = ws;
        ws.on("message", (data) => {
          const raw = data.toString();
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

  // 关闭连接
  close(): void {
    log.debug("关闭 HandClient", {
      sessionId: this.sessionId,
      connected: Boolean(this.ws),
    });
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    void this.executor.close().catch(() => undefined);
  }

  // 发送 create_session 并等待 session_created 响应
  async sendCreateSession(cwd: string, model?: string): Promise<void> {
    this.currentCwd = cwd;
    await this.resetExecutor(cwd);

    const msg: CreateSession = {
      type: "create_session",
      cwd,
      homeDir: os.homedir(),
      model,
    };
    await this.writeJSON(msg);

    const response = await this.waitForSessionReady("session_created") as CreateSessionResponse;
    await this.applySessionMcpConfig(response.sessionId, response.mcpServerConfigs);
  }

  async sendRestoreSession(sessionId: string): Promise<void> {
    const msg: RestoreSession = {
      type: "restore_session",
      sessionId,
    };
    await this.writeJSON(msg);
    await this.waitForSessionReady("session_restored");
  }

  async sendCreatePtySession(cwd: string, model?: string): Promise<string> {
    this.currentCwd = cwd;
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
    };
    await this.writeJSON(msg);
    const sessionId = await this.waitForPtySessionReady();
    this.ptySessionId = sessionId;
    return sessionId;
  }

  // 获取当前 session ID（供 ACP Server 查询）
  getSessionId(): string {
    return this.sessionId;
  }

  getPtySessionId(): string {
    return this.ptySessionId;
  }

  // 获取最后一次 session_end 的结果（供 ACP Server 查询）
  getLastResult(): { result?: string; error?: string } {
    return this.lastResult;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async ensureSession(options: EnsureSessionOptions): Promise<"restored" | "created" | "reused"> {
    if (this.isConnected()) {
      return "reused";
    }

    await this.connect();

    if (this.sessionId) {
      try {
        await this.sendRestoreSession(this.sessionId);
        return "restored";
      } catch (error) {
        if (!options.allowCreateOnRestoreFailure) {
          throw error;
        }
        this.sessionId = "";
      }
    }

    await this.sendCreateSession(options.cwd || this.initialCwd, options.model);
    return "created";
  }

  // 发送用户 prompt
  async sendPrompt(text: string): Promise<void> {
    const msg: Prompt = {
      type: "prompt",
      sessionId: this.sessionId,
      text,
    };
    await this.writeJSON(msg);
  }

  // 主消息循环（阻塞直到 session_end 或错误）
  run(): Promise<void> {
    return this.runInternal(undefined);
  }

  // 带回调的消息循环（供 ACP Server 使用，不依赖 UI）
  runWithCallbacks(callbacks: HandClientCallbacks): Promise<void> {
    return this.runInternal(callbacks);
  }

  // 内部统一消息循环实现
  private runInternal(callbacks?: HandClientCallbacks): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(new Error("WebSocket 未连接"));
        return;
      }

      this.activeCallbacks = callbacks;
      const ws = this.ws;

      const onMessage = (raw: string) => {
        const done = this.handleMessage(raw, callbacks);
        if (done) {
          this.activeCallbacks = undefined;
          releaseMessageConsumer();
          ws.off("error", onError);
          ws.off("close", onClose);
          resolve();
        }
      };

      const onError = (err: Error) => {
        this.activeCallbacks = undefined;
        releaseMessageConsumer();
        ws.off("close", onClose);
        reject(err);
      };

      const onClose = () => {
        this.activeCallbacks = undefined;
        releaseMessageConsumer();
        ws.off("error", onError);
        reject(new Error("WebSocket 连接已关闭"));
      };

      const releaseMessageConsumer = this.attachMessageConsumer(onMessage);
      this.flushPendingMessages();
      ws.on("error", onError);
      ws.on("close", onClose);
    });
  }

  // ============================================================
  // 私有方法
  // ============================================================

  // 等待 session_created，跳过 connected 消息
  private waitForSessionReady(expectedType: "session_created" | "session_restored"): Promise<CreateSessionResponse | RestoreSessionResponse> {
    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(new Error("WebSocket 未连接"));
        return;
      }

      const ws = this.ws;

      const onMessage = (raw: string) => {
        let msg: ServerToHandMessage;
        try {
          msg = JSON.parse(raw) as ServerToHandMessage;
        } catch {
          return; // 跳过无法解析的消息
        }

        switch (msg.type) {
          case "session_created":
          case "session_restored": {
            if (msg.type !== expectedType) {
              break;
            }

            const response = msg as CreateSessionResponse | RestoreSessionResponse;
            this.sessionId = response.sessionId;
            releaseMessageConsumer();
            ws.off("error", onError);
            if (this.interactiveOutput) {
              const prefix = expectedType === "session_restored" ? "[已恢复]" : "[已连接]";
              process.stdout.write(`\x1b[36m${prefix} Session: ${this.sessionId}\x1b[0m\n`);
            }
            resolve(response);
            break;
          }
          case "connected":
            // 忽略 connected 通知，继续等待
            break;
          case "error": {
            releaseMessageConsumer();
            ws.off("error", onError);
            reject(new Error(`服务器错误: ${(msg as ServerError).message}`));
            break;
          }
        }
      };

      const onError = (err: Error) => {
        releaseMessageConsumer();
        reject(new Error(`等待 session_created 失败: ${err.message}`));
      };

      const releaseMessageConsumer = this.attachMessageConsumer(onMessage);
      this.flushPendingMessages();
      ws.on("error", onError);
    });
  }

  private waitForPtySessionReady(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(new Error("WebSocket 未连接"));
        return;
      }

      const ws = this.ws;

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
            releaseMessageConsumer();
            ws.off("error", onError);
            resolve(created.sessionId);
            break;
          }
          case "error": {
            releaseMessageConsumer();
            ws.off("error", onError);
            reject(new Error(`服务器错误: ${(msg as ServerError).message}`));
            break;
          }
        }
      };

      const onError = (err: Error) => {
        releaseMessageConsumer();
        reject(new Error(`等待 pty_session_created 失败: ${err.message}`));
      };

      const releaseMessageConsumer = this.attachMessageConsumer(onMessage);
      this.flushPendingMessages();
      ws.on("error", onError);
    });
  }

  // 处理单条消息，返回 true 表示会话结束（session_end）
  // callbacks 为可选，有则通知回调方（ACP 场景），无则使用 UI 输出（CLI 场景）
  private handleMessage(raw: string, callbacks?: HandClientCallbacks): boolean {
    let msg: ServerToHandMessage;
    try {
      msg = JSON.parse(raw) as ServerToHandMessage;
    } catch (err) {
      this.ui.printError(`解析消息失败: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }

    if (!msg || !msg.type) {
      this.ui.printError("收到无效消息：缺少 type 字段");
      return false;
    }

    switch (msg.type) {
      case "text_chunk": {
        const chunk = msg as TextChunk;
        if (callbacks?.onTextChunk) {
          callbacks.onTextChunk(chunk.text);
        } else if (this.interactiveOutput) {
          this.ui.printText(chunk.text);
        }
        break;
      }

      case "thought_chunk": {
        const chunk = msg as ThoughtChunk;
        if (callbacks?.onThoughtChunk) {
          callbacks.onThoughtChunk(chunk.text);
        } else if (this.interactiveOutput) {
          this.ui.printThought(chunk.text);
        }
        break;
      }

      case "tool_call": {
        const toolCall = msg as ToolCall;
        if (callbacks?.onToolCall) {
          callbacks.onToolCall(toolCall.toolName, toolCall.requestId, toolCall.input);
        } else if (this.interactiveOutput) {
          this.ui.printToolCall(toolCall.toolName);
        }
        // 异步执行工具，不阻塞消息循环
        void this.executeToolCall(toolCall);
        break;
      }

      case "tool_call_complete": {
        const complete = msg as import("./protocol.js").ToolCallComplete;
        if (callbacks?.onToolCallComplete) {
          callbacks.onToolCallComplete(complete.toolName, complete.requestId);
        }
        break;
      }

      case "session_end": {
        const end = msg as SessionEnd;
        // 记录最后结果供 ACP Server 查询
        this.lastResult = { result: end.result, error: end.error };
        if (!callbacks && this.interactiveOutput) {
          this.ui.printSessionEnd(end.result, end.error);
        }
        return true; // 标记会话结束
      }

      case "error": {
        const errMsg = msg as ServerError;
        this.ui.printError(errMsg.message);
        break;
      }
    }

    return false;
  }

  // 在后台执行工具调用并将结果发回 Server
  private async executeToolCall(msg: ToolCall): Promise<void> {
    log.info("开始执行工具调用", {
      sessionId: msg.sessionId,
      requestId: msg.requestId,
      toolName: msg.toolName,
      inputSummary: summarizeUnknown(msg.input),
    });
    try {
      const result = await this.executor.dispatch(
        msg.toolName,
        msg.input
      );

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

      this.activeCallbacks?.onToolResult?.(msg.toolName, msg.requestId, result);

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

      this.activeCallbacks?.onToolResult?.(msg.toolName, msg.requestId, undefined, resp.error);

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

      // 在 PTY passthrough 期间禁用日志 console 输出，避免日志混入 PTY 数据流
      configureLogger({ console: false });

      const ws = this.ws;
      const stdin = process.stdin;
      const stdout = process.stdout;
      const isTTY = Boolean(stdin.isTTY);
      const previousRawMode = isTTY ? stdin.isRaw : false;

      const cleanup = () => {
        releaseMessageConsumer();
        ws.off("error", onError);
        ws.off("close", onClose);
        stdin.off("data", onInput);
        stdout.off("resize", onResize);
        if (isTTY) {
          stdin.setRawMode(previousRawMode);
        }
        stdin.pause();
        // PTY passthrough 完成后恢复日志 console 输出
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
          case "tool_call": {
            const toolCall = msg as ToolCall;
            if (toolCall.sessionId !== sessionId) {
              break;
            }
            void this.executeToolCall(toolCall);
            break;
          }
          case "tool_call_complete": {
            const complete = msg as import("./protocol.js").ToolCallComplete;
            if (complete.sessionId !== sessionId) {
              break;
            }
            break;
          }
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

      const releaseMessageConsumer = this.attachMessageConsumer(onMessage);
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

  // 线程安全的 JSON 写入（通过 Promise 链串行化）
  private writeJSON(data: unknown): Promise<void> {
    // 前一次写失败后仍允许后续写继续排队，避免整条链永久 rejected。
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
    await this.resetExecutorWithConfig(cwd, undefined);
  }

  private async resetExecutorWithConfig(
    cwd: string,
    mcpServerConfigs: Record<string, McpServerConfig> | undefined
  ): Promise<void> {
    await this.executor.close().catch(() => undefined);
    this.executor = new ToolExecutor(cwd, mcpServerConfigs);
    log.debug("重建 ToolExecutor", {
      cwd,
      mcpServerCount: Object.keys(mcpServerConfigs ?? {}).length,
      mcpServers: Object.keys(mcpServerConfigs ?? {}),
    });
  }

  private async applySessionMcpConfig(
    sessionId: string,
    mcpServerConfigs: Record<string, McpServerConfig> | undefined
  ): Promise<void> {
    await this.resetExecutorWithConfig(this.currentCwd, mcpServerConfigs);

    let mcpToolCatalog: Record<string, McpServerCatalogEntry>;
    try {
      mcpToolCatalog = await this.executor.describeMcpServers();
      log.debug("收集 Brain 下发 MCP tool catalog 完成", {
        cwd: this.currentCwd,
        sessionId,
        serverCount: Object.keys(mcpToolCatalog).length,
        servers: Object.keys(mcpToolCatalog),
      });
    } catch (error) {
      log.error("收集 Brain 下发 MCP tool catalog 失败", {
        cwd: this.currentCwd,
        sessionId,
        error: formatErrorForLog(error),
      });
      throw error;
    }

    const update: SessionMcpCatalog = {
      type: "session_mcp_catalog",
      sessionId,
      mcpToolCatalog,
    };
    await this.writeJSON(update);
    await this.waitForMcpCatalogApplied(sessionId);
  }

  private waitForMcpCatalogApplied(sessionId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(new Error("WebSocket 未连接"));
        return;
      }

      const ws = this.ws;

      const onMessage = (raw: string) => {
        let msg: ServerToHandMessage;
        try {
          msg = JSON.parse(raw) as ServerToHandMessage;
        } catch {
          return;
        }

        switch (msg.type) {
          case "session_mcp_catalog_applied": {
            const applied = msg as SessionMcpCatalogApplied;
            if (applied.sessionId !== sessionId) {
              break;
            }
            releaseMessageConsumer();
            ws.off("error", onError);
            resolve();
            break;
          }
          case "error": {
            releaseMessageConsumer();
            ws.off("error", onError);
            reject(new Error(`服务器错误: ${(msg as ServerError).message}`));
            break;
          }
        }
      };

      const onError = (err: Error) => {
        releaseMessageConsumer();
        reject(new Error(`等待 MCP catalog 应用失败: ${err.message}`));
      };

      const releaseMessageConsumer = this.attachMessageConsumer(onMessage);
      this.flushPendingMessages();
      ws.on("error", onError);
    });
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
