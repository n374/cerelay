// ============================================================
// ACP Server（stdio）
// 通过标准输入/输出与编辑器通信，实现 JSON-RPC 2.0 协议
// 编辑器发请求 → ACP Server 处理 → 通过 ACP 通知推流
// ============================================================

import * as readline from "node:readline";
import { HandClient } from "../client.js";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  InitializeParams,
  InitializeResult,
  SessionNewParams,
  SessionNewResult,
  SessionPromptParams,
  SessionPromptResult,
  SessionUpdateParams,
  SessionUpdateResult,
  SessionCloseParams,
  SessionCloseResult,
} from "./protocol.js";
import { ACP_ERROR_CODES } from "./protocol.js";

// ACP Server 版本
const ACP_VERSION = "0.1.0";
const PROTOCOL_VERSION = "2024-11-05";

export interface AcpServerOptions {
  /** Axon Brain WebSocket 地址，例如 ws://localhost:8765/ws */
  serverURL: string;
  /** 默认工作目录 */
  cwd: string;
}

// ============================================================
// AcpServer：ACP stdio 服务器主类
// ============================================================

export class AcpServer {
  private readonly serverURL: string;
  private readonly defaultCwd: string;

  // 每个 ACP session 对应一个独立的 HandClient 连接
  // key: ACP sessionId（由编辑器提供或自动生成）
  private readonly sessions = new Map<string, AcpSession>();

  // readline 接口，从 stdin 逐行读取 JSON-RPC 消息
  private rl: readline.Interface | null = null;

  // 标记是否已初始化（received initialize）
  private initialized = false;

  constructor(options: AcpServerOptions) {
    this.serverURL = options.serverURL;
    this.defaultCwd = options.cwd;
  }

  // 启动 ACP Server，开始监听 stdin
  start(): void {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: undefined,
      terminal: false,
    });

    this.rl.on("line", (line) => {
      void this.handleLine(line);
    });

    this.rl.on("close", () => {
      void this.shutdown();
    });

    // ACP 启动时不打印到 stdout，避免污染 JSON-RPC 流
    this.log("ACP Server 已启动，等待请求...");
  }

  // 关闭所有 session
  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.client.close();
    }
    this.sessions.clear();

    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  // ============================================================
  // 私有：逐行处理输入
  // ============================================================

  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      this.sendError(null, ACP_ERROR_CODES.PARSE_ERROR, "JSON 解析失败");
      return;
    }

    // 基础校验
    if (request.jsonrpc !== "2.0" || !request.method) {
      this.sendError(
        request.id ?? null,
        ACP_ERROR_CODES.INVALID_REQUEST,
        "无效的 JSON-RPC 请求"
      );
      return;
    }

    // initialize 必须先调用
    if (request.method !== "initialize" && !this.initialized) {
      this.sendError(
        request.id ?? null,
        ACP_ERROR_CODES.INVALID_REQUEST,
        "请先调用 initialize"
      );
      return;
    }

    try {
      await this.dispatch(request);
    } catch (err) {
      this.sendError(
        request.id ?? null,
        ACP_ERROR_CODES.INTERNAL_ERROR,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  // ============================================================
  // 方法分发
  // ============================================================

  private async dispatch(request: JsonRpcRequest): Promise<void> {
    switch (request.method) {
      case "initialize":
        this.handleInitialize(request);
        return;
      case "session/new":
        await this.handleSessionNew(request);
        return;
      case "session/prompt":
        await this.handleSessionPrompt(request);
        return;
      case "session/update":
        await this.handleSessionUpdate(request);
        return;
      case "session/close":
        await this.handleSessionClose(request);
        return;
      default:
        this.sendError(
          request.id ?? null,
          ACP_ERROR_CODES.METHOD_NOT_FOUND,
          `未知方法: ${request.method}`
        );
    }
  }

  // ---- initialize ----

  private handleInitialize(request: JsonRpcRequest): void {
    const _params = request.params as InitializeParams | undefined;

    this.initialized = true;

    const result: InitializeResult = {
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: {
        name: "axon-hand",
        version: ACP_VERSION,
      },
      capabilities: {
        streaming: true,
        multiSession: true,
        tools: ["Read", "Write", "Edit", "MultiEdit", "Bash", "Grep", "Glob"],
      },
    };

    this.sendResult(request.id, result);
    this.log("初始化完成");
  }

  // ---- session/new ----

  private async handleSessionNew(request: JsonRpcRequest): Promise<void> {
    const params = request.params as SessionNewParams | undefined;
    const cwd = params?.cwd ?? this.defaultCwd;

    // 创建新的 HandClient 并连接到 Brain
    const client = new HandClient(this.serverURL, cwd, {
      interactiveOutput: false,
    });

    try {
      await client.connect();
    } catch (err) {
      throw new Error(
        `连接 Brain 失败: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // 让 HandClient 创建 Brain session，获取 sessionId
    await client.sendCreateSession(cwd, params?.model);
    const sessionId = client.getSessionId();

    if (!sessionId) {
      client.close();
      throw new Error("Brain 未返回 sessionId");
    }

    // 存储 session
    const session: AcpSession = {
      id: sessionId,
      cwd,
      model: params?.model,
      client,
      busy: false,
      closing: false,
      promptState: null,
    };
    this.sessions.set(sessionId, session);

    const result: SessionNewResult = { sessionId };
    this.sendResult(request.id, result);
    this.log(`Session 已创建: ${sessionId}`);
  }

  // ---- session/prompt ----

  private async handleSessionPrompt(request: JsonRpcRequest): Promise<void> {
    const params = request.params as SessionPromptParams | undefined;

    if (!params?.sessionId || !params?.prompt) {
      this.sendError(
        request.id ?? null,
        ACP_ERROR_CODES.INVALID_PARAMS,
        "缺少必要参数: sessionId 或 prompt"
      );
      return;
    }

    const session = this.sessions.get(params.sessionId);
    if (!session) {
      this.sendError(
        request.id ?? null,
        ACP_ERROR_CODES.SESSION_NOT_FOUND,
        `Session 不存在: ${params.sessionId}`
      );
      return;
    }

    if (session.busy) {
      this.sendError(
        request.id ?? null,
        ACP_ERROR_CODES.SESSION_BUSY,
        `Session 正忙: ${params.sessionId}`
      );
      return;
    }

    try {
      await this.ensureSessionConnected(session);
    } catch (error) {
      this.sessions.delete(params.sessionId);
      this.sendError(
        request.id ?? null,
        ACP_ERROR_CODES.SESSION_NOT_FOUND,
        error instanceof Error ? error.message : String(error)
      );
      return;
    }

    session.busy = true;
    const promptState: AcpPromptState = {
      requestId: request.id ?? null,
      cancelled: false,
    };
    session.promptState = promptState;

    try {
      await this.executePrompt(session, params.sessionId, params.prompt);

      // session_end 后返回最终结果
      const finalResult = session.client.getLastResult();
      const result: SessionPromptResult = {
        sessionId: params.sessionId,
        result: finalResult.result,
        error: finalResult.error,
      };
      if (!promptState.cancelled) {
        this.sendResult(request.id, result);
      }
    } catch (err) {
      if (!promptState.cancelled) {
        const result: SessionPromptResult = {
          sessionId: params.sessionId,
          error: err instanceof Error ? err.message : String(err),
        };
        this.sendResult(request.id, result);
      }
    } finally {
      session.busy = false;
      if (session.promptState === promptState) {
        session.promptState = null;
      }
      if (session.closing) {
        this.sessions.delete(params.sessionId);
      }
    }
  }

  // ---- session/update ----

  private async handleSessionUpdate(request: JsonRpcRequest): Promise<void> {
    const params = request.params as SessionUpdateParams | undefined;

    if (!params?.sessionId) {
      this.sendError(
        request.id ?? null,
        ACP_ERROR_CODES.INVALID_PARAMS,
        "缺少必要参数: sessionId"
      );
      return;
    }

    const session = this.sessions.get(params.sessionId);
    if (!session) {
      this.sendError(
        request.id ?? null,
        ACP_ERROR_CODES.SESSION_NOT_FOUND,
        `Session 不存在: ${params.sessionId}`
      );
      return;
    }

    if (params.action === "cancel") {
      // 取消当前任务：标记 prompt 已取消并关闭连接，避免原 prompt 再补发响应
      session.closing = true;
      if (session.promptState) {
        session.promptState.cancelled = true;
      }

      if (!session.busy) {
        try {
          await this.ensureSessionConnected(session);
        } catch {
          this.sessions.delete(params.sessionId);
        }
      }

      session.client.close();
      if (!session.busy) {
        this.sessions.delete(params.sessionId);
      }

      const result: SessionUpdateResult = {
        sessionId: params.sessionId,
        status: "cancelled",
      };
      this.sendResult(request.id, result);
      this.log(`Session 已取消: ${params.sessionId}`);
      return;
    }

    const result: SessionUpdateResult = {
      sessionId: params.sessionId,
      status: "ok",
    };
    this.sendResult(request.id, result);
  }

  // ---- session/close ----

  private async handleSessionClose(request: JsonRpcRequest): Promise<void> {
    const params = request.params as SessionCloseParams | undefined;

    if (!params?.sessionId) {
      this.sendError(
        request.id ?? null,
        ACP_ERROR_CODES.INVALID_PARAMS,
        "缺少必要参数: sessionId"
      );
      return;
    }

    const session = this.sessions.get(params.sessionId);
    if (!session) {
      this.sendError(
        request.id ?? null,
        ACP_ERROR_CODES.SESSION_NOT_FOUND,
        `Session 不存在: ${params.sessionId}`
      );
      return;
    }

    session.closing = true;
    if (session.promptState) {
      session.promptState.cancelled = true;
    }

    if (!session.busy) {
      try {
        await this.ensureSessionConnected(session);
      } catch {
        this.sessions.delete(params.sessionId);
      }
    }

    session.client.close();
    if (!session.busy) {
      this.sessions.delete(params.sessionId);
    }

    const result: SessionCloseResult = { sessionId: params.sessionId };
    this.sendResult(request.id, result);
    this.log(`Session 已关闭: ${params.sessionId}`);
  }

  // ============================================================
  // 输出辅助方法（写入 stdout）
  // ============================================================

  private sendResult(id: number | string | null | undefined, result: unknown): void {
    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: id ?? null,
      result,
    };
    this.writeLine(JSON.stringify(response));
  }

  private sendError(id: number | string | null, code: number, message: string, data?: unknown): void {
    const error: JsonRpcError = { code, message };
    if (data !== undefined) {
      error.data = data;
    }

    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id,
      error,
    };
    this.writeLine(JSON.stringify(response));
  }

  private sendNotification(method: string, params: unknown): void {
    const notification = {
      jsonrpc: "2.0",
      method,
      params,
    };
    this.writeLine(JSON.stringify(notification));
  }

  // 写入一行到 stdout（JSON-RPC 使用换行符分隔消息）
  private writeLine(line: string): void {
    process.stdout.write(line + "\n");
  }

  // 调试日志写入 stderr（不污染 stdout 的 JSON-RPC 流）
  private log(message: string): void {
    process.stderr.write(`[axon-acp] ${message}\n`);
  }

  private async ensureSessionConnected(session: AcpSession): Promise<void> {
    if (session.client.isConnected()) {
      return;
    }

    const result = await session.client.ensureSession({
      cwd: session.cwd,
      model: session.model,
      allowCreateOnRestoreFailure: false,
    });

    if (result !== "restored" && session.client.getSessionId() !== session.id) {
      throw new Error(`Session 恢复失败: ${session.id}`);
    }
  }

  private async executePrompt(
    session: AcpSession,
    sessionId: string,
    prompt: string
  ): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.ensureSessionConnected(session);

      try {
        await session.client.sendPrompt(prompt);
        await session.client.runWithCallbacks({
          onTextChunk: (text) => {
            this.sendNotification("$/textChunk", {
              sessionId,
              text,
            });
          },
          onThoughtChunk: (text) => {
            this.sendNotification("$/thoughtChunk", {
              sessionId,
              text,
            });
          },
          onToolCall: (toolName, requestId, input) => {
            this.sendNotification("$/toolCall", {
              sessionId,
              toolName,
              requestId,
              input,
            });
          },
          onToolCallComplete: (toolName, requestId) => {
            this.sendNotification("$/toolCallComplete", {
              sessionId,
              toolName,
              requestId,
            });
          },
        });
        return;
      } catch (error) {
        if (attempt === 1) {
          throw error;
        }
      }
    }
  }
}

// ACP session 内部状态
interface AcpSession {
  id: string;
  cwd: string;
  model?: string;
  client: HandClient;
  busy: boolean;
  closing: boolean;
  promptState: AcpPromptState | null;
}

interface AcpPromptState {
  requestId: number | string | null;
  cancelled: boolean;
}
