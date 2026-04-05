import WebSocket from "ws";
import { ToolExecutor, summarizeToolResult, formatToolError } from "./executor.js";
import { UI } from "./ui.js";
import type {
  CreateSession,
  CreateSessionResponse,
  Prompt,
  ToolResult,
  ServerToHandMessage,
  Envelope,
  ToolCall,
  SessionEnd,
  ServerError,
  TextChunk,
  ThoughtChunk,
} from "./protocol.js";

// ============================================================
// HandClient：连接 Axon Server 并处理消息
// ============================================================

export class HandClient {
  private readonly serverURL: string;
  private ws: WebSocket | null = null;
  private readonly ui: UI;
  // executor 在 session 创建后含有正确的 cwd，先用占位 cwd 初始化
  private executor: ToolExecutor;

  // 当前活跃的 session ID
  private sessionId = "";

  // 写锁：用 Promise 链模拟互斥，确保并发写安全
  private writeChain: Promise<void> = Promise.resolve();

  constructor(serverURL: string, cwd: string) {
    this.serverURL = serverURL;
    this.ui = new UI();
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
    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(new Error("WebSocket 未连接"));
        return;
      }

      const ws = this.ws;

      const onMessage = (data: WebSocket.RawData) => {
        const raw = data.toString();
        const done = this.handleMessage(raw);
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
        let env: Envelope;
        try {
          env = JSON.parse(raw) as Envelope;
        } catch {
          return; // 跳过无法解析的消息
        }

        switch (env.type) {
          case "session_created": {
            const resp = JSON.parse(raw) as CreateSessionResponse;
            this.sessionId = resp.sessionId;
            ws.off("message", onMessage);
            ws.off("error", onError);
            console.log(`\x1b[36m[已连接] Session: ${this.sessionId}\x1b[0m`);
            resolve();
            break;
          }
          case "connected":
            // 忽略 connected 通知，继续等待
            break;
          case "error": {
            const errMsg = JSON.parse(raw) as ServerError;
            ws.off("message", onMessage);
            ws.off("error", onError);
            reject(new Error(`服务器错误: ${errMsg.message}`));
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
  private handleMessage(raw: string): boolean {
    let env: Envelope;
    try {
      env = JSON.parse(raw) as Envelope;
    } catch (err) {
      this.ui.printError(`解析消息失败: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }

    const msg = JSON.parse(raw) as ServerToHandMessage;

    switch (env.type) {
      case "text_chunk": {
        const chunk = msg as TextChunk;
        this.ui.printText(chunk.text);
        break;
      }

      case "thought_chunk": {
        const chunk = msg as ThoughtChunk;
        this.ui.printThought(chunk.text);
        break;
      }

      case "tool_call": {
        const toolCall = msg as ToolCall;
        this.ui.printToolCall(toolCall.toolName);
        // 异步执行工具，不阻塞消息循环
        void this.executeToolCall(toolCall);
        break;
      }

      case "session_end": {
        const end = msg as SessionEnd;
        this.ui.printSessionEnd(end.result, end.error);
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

      this.ui.printToolResult(msg.toolName, true);

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
      this.ui.printToolResult(msg.toolName, false);

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
    // 将写操作追加到队列末尾，确保顺序执行
    this.writeChain = this.writeChain.then(() =>
      this.doWriteJSON(data)
    );
    return this.writeChain;
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
