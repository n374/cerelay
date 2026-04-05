import process from "node:process";
import WebSocket from "ws";
import { ToolExecutor, summarizeToolResult, formatToolError } from "./executor.js";
import { UI } from "./ui.js";
import type {
  CreateSession,
  CreateSessionResponse,
  Prompt,
  ToolResult,
  ServerToHandMessage,
  ToolCall,
  SessionEnd,
  ServerError,
  TextChunk,
  ThoughtChunk,
} from "./protocol.js";

// ============================================================
// 回调接口：供 ACP Server 等非 UI 场景使用
// ============================================================

export interface HandClientCallbacks {
  onTextChunk?: (text: string) => void;
  onThoughtChunk?: (text: string) => void;
  onToolCall?: (toolName: string, requestId: string, input: unknown) => void;
  onToolCallComplete?: (toolName: string, requestId: string) => void;
}

export interface HandClientOptions {
  interactiveOutput?: boolean;
}

// ============================================================
// HandClient：连接 Axon Server 并处理消息
// ============================================================

export class HandClient {
  private readonly serverURL: string;
  private ws: WebSocket | null = null;
  private readonly ui: UI;
  private readonly interactiveOutput: boolean;
  // executor 在 session 创建后含有正确的 cwd，先用占位 cwd 初始化
  private executor: ToolExecutor;

  // 当前活跃的 session ID
  private sessionId = "";

  // 最后一次 session_end 结果（供 ACP Server 查询）
  private lastResult: { result?: string; error?: string } = {};

  // 写锁：用 Promise 链模拟互斥，确保并发写安全
  private writeChain: Promise<void> = Promise.resolve();

  constructor(serverURL: string, cwd: string, options: HandClientOptions = {}) {
    this.serverURL = serverURL;
    this.ui = new UI();
    this.interactiveOutput = options.interactiveOutput ?? true;
    this.executor = new ToolExecutor(cwd);
  }

  // 连接到 Server
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.serverURL);

      ws.on("open", () => {
        this.ws = ws;
        resolve();
      });

      ws.on("error", (err) => {
        reject(new Error(`连接 ${this.serverURL} 失败: ${err.message}`));
      });
    });
  }

  // 关闭连接
  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // 发送 create_session 并等待 session_created 响应
  async sendCreateSession(cwd: string): Promise<void> {
    const msg: CreateSession = {
      type: "create_session",
      cwd,
    };
    await this.writeJSON(msg);

    // 等待 session_created（可能先收到 connected 通知）
    await this.waitForSessionCreated();
  }

  // 获取当前 session ID（供 ACP Server 查询）
  getSessionId(): string {
    return this.sessionId;
  }

  // 获取最后一次 session_end 的结果（供 ACP Server 查询）
  getLastResult(): { result?: string; error?: string } {
    return this.lastResult;
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

      const ws = this.ws;

      const onMessage = (data: WebSocket.RawData) => {
        const raw = data.toString();
        const done = this.handleMessage(raw, callbacks);
        if (done) {
          ws.off("message", onMessage);
          ws.off("error", onError);
          ws.off("close", onClose);
          resolve();
        }
      };

      const onError = (err: Error) => {
        ws.off("message", onMessage);
        ws.off("close", onClose);
        reject(err);
      };

      const onClose = () => {
        ws.off("message", onMessage);
        ws.off("error", onError);
        reject(new Error("WebSocket 连接已关闭"));
      };

      ws.on("message", onMessage);
      ws.on("error", onError);
      ws.on("close", onClose);
    });
  }

  // ============================================================
  // 私有方法
  // ============================================================

  // 等待 session_created，跳过 connected 消息
  private waitForSessionCreated(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(new Error("WebSocket 未连接"));
        return;
      }

      const ws = this.ws;

      const onMessage = (data: WebSocket.RawData) => {
        const raw = data.toString();
        let msg: ServerToHandMessage;
        try {
          msg = JSON.parse(raw) as ServerToHandMessage;
        } catch {
          return; // 跳过无法解析的消息
        }

        switch (msg.type) {
          case "session_created": {
            this.sessionId = (msg as CreateSessionResponse).sessionId;
            ws.off("message", onMessage);
            ws.off("error", onError);
            if (this.interactiveOutput) {
              process.stdout.write(`\x1b[36m[已连接] Session: ${this.sessionId}\x1b[0m\n`);
            }
            resolve();
            break;
          }
          case "connected":
            // 忽略 connected 通知，继续等待
            break;
          case "error": {
            ws.off("message", onMessage);
            ws.off("error", onError);
            reject(new Error(`服务器错误: ${(msg as ServerError).message}`));
            break;
          }
        }
      };

      const onError = (err: Error) => {
        ws.off("message", onMessage);
        reject(new Error(`等待 session_created 失败: ${err.message}`));
      };

      ws.on("message", onMessage);
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

      await this.writeJSON(resp).catch((writeErr: unknown) => {
        this.ui.printError(
          `发送 tool_result 失败: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`
        );
      });
    } catch (err) {
      if (this.interactiveOutput) {
        this.ui.printToolResult(msg.toolName, false);
      }

      const resp: ToolResult = {
        type: "tool_result",
        sessionId: msg.sessionId,
        requestId: msg.requestId,
        error: formatToolError(err),
      };

      await this.writeJSON(resp).catch((writeErr: unknown) => {
        this.ui.printError(
          `发送 tool_result(error) 失败: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`
        );
      });
    }
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
}
