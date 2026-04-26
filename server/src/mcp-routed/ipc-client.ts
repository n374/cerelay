// ============================================================
// cerelay-routed MCP server 子进程的 IPC 客户端
// IPC client running inside the cerelay-routed MCP child process.
//
// 通过 Unix socket 连回 cerelay-server 主进程，发送 tool_call 并等结果。
// Connects back to cerelay-server main process via Unix socket; sends
// tool_call and awaits tool_result by id.
// ============================================================

import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import type { RemoteToolResult } from "../relay.js";
import {
  decodeIpcLines,
  encodeIpcMessage,
  type IpcMessage,
  type IpcToolCallResponse,
} from "./ipc-protocol.js";

export interface IpcClientOptions {
  socketPath: string;
  token: string;
  /** 单次 tool_call 等待结果的超时（默认 120 秒，对齐 ToolRelay）。 */
  callTimeoutMs?: number;
  /** 连接超时（默认 5 秒）。 */
  connectTimeoutMs?: number;
}

/** 复用主进程侧 ToolRelay 的结果形态，避免平行类型抽象。 */
export type IpcToolResult = RemoteToolResult;

const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

interface PendingCall {
  resolve: (result: IpcToolResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class IpcClient {
  private readonly socketPath: string;
  private readonly token: string;
  private readonly callTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private socket: Socket | null = null;
  private buffer = "";
  private connected = false;
  private authenticated = false;
  private closed = false;
  private readonly pending = new Map<string, PendingCall>();
  private connectPromise: Promise<void> | null = null;

  constructor(options: IpcClientOptions) {
    this.socketPath = options.socketPath;
    this.token = options.token;
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error("IpcClient 已关闭");
    }
    if (this.connected) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.connectPromise = this.doConnect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async doConnect(): Promise<void> {
    const socket = connect(this.socketPath);
    this.socket = socket;

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error(`IpcClient 连接超时（socket=${this.socketPath}）`));
        }, this.connectTimeoutMs);
        socket.once("connect", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    } catch (err) {
      this.socket = null;
      throw err;
    }

    this.connected = true;
    socket.setNoDelay(true);

    // 发送 hello 帧并等 ack（超时和 socket close-race 都要兜住）。
    // 注意：握手期间不要注册 long-running data/close listener，
    // 否则会跟 sendHelloAndAwaitAck 内部 listener 抢 buffer/事件。
    let helloAck: { ok: boolean; error?: string };
    try {
      helloAck = await this.sendHelloAndAwaitAck();
    } catch (err) {
      if (!socket.destroyed) {
        socket.destroy();
      }
      this.socket = null;
      this.connected = false;
      throw err;
    }
    if (!helloAck.ok) {
      if (!socket.destroyed) {
        socket.destroy();
      }
      this.socket = null;
      this.connected = false;
      throw new Error(`IpcClient hello 失败：${helloAck.error ?? "unknown"}`);
    }
    this.authenticated = true;
    // 握手完成后才挂 long-running listeners。
    socket.on("data", (chunk: Buffer) => this.handleData(chunk));
    socket.on("close", () => this.handleClose());
    socket.on("error", () => undefined);
  }

  private async sendHelloAndAwaitAck(): Promise<{ ok: boolean; error?: string }> {
    if (!this.socket) {
      throw new Error("IpcClient socket 未初始化");
    }
    const socket = this.socket;
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        socket.off("data", onData);
        socket.off("error", onErr);
        socket.off("close", onClose);
        clearTimeout(timer);
      };
      const onData = (chunk: Buffer) => {
        this.buffer += chunk.toString("utf8");
        const { messages, rest } = decodeIpcLines(this.buffer);
        this.buffer = rest;
        for (const message of messages) {
          if (message.type === "hello_ack" && !settled) {
            settled = true;
            cleanup();
            resolve({ ok: message.ok, error: message.error });
            return;
          }
        }
      };
      const onErr = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      const onClose = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("IpcClient hello 期间连接被对端关闭"));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`IpcClient hello 超时（${this.connectTimeoutMs}ms）`));
      }, this.connectTimeoutMs);
      socket.on("data", onData);
      socket.once("error", onErr);
      socket.once("close", onClose);
      socket.write(encodeIpcMessage({ type: "hello", token: this.token }));
    });
  }

  async callTool(toolName: string, input: unknown): Promise<IpcToolResult> {
    if (this.closed) {
      throw new Error("IpcClient 已关闭");
    }
    if (!this.authenticated) {
      await this.connect();
    }
    const id = randomUUID();
    const promise = new Promise<IpcToolResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`IpcClient tool_call 超时（id=${id}, toolName=${toolName}）`));
      }, this.callTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    if (!this.socket || this.socket.destroyed) {
      this.pending.delete(id);
      throw new Error("IpcClient socket 已断开");
    }
    this.socket.write(
      encodeIpcMessage({
        type: "tool_call",
        id,
        toolName,
        input,
      }),
    );
    return promise;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
    this.socket = null;
    this.connected = false;
    this.authenticated = false;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`IpcClient 已关闭（id=${id}）`));
    }
    this.pending.clear();
  }

  private handleData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    const { messages, rest } = decodeIpcLines(this.buffer);
    this.buffer = rest;
    for (const message of messages) {
      this.dispatchMessage(message);
    }
  }

  private dispatchMessage(message: IpcMessage): void {
    if (message.type !== "tool_result") {
      return;
    }
    this.resolvePending(message);
  }

  private resolvePending(message: IpcToolCallResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    pending.resolve({
      output: message.output,
      summary: message.summary,
      error: message.error,
    });
  }

  private handleClose(): void {
    if (this.closed) {
      return;
    }
    this.connected = false;
    this.authenticated = false;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`IpcClient 连接关闭（id=${id}）`));
    }
    this.pending.clear();
  }
}
