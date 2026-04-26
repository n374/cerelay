// ============================================================
// MCPIpcHost：主进程侧的 per-session Unix socket 服务端
// Main-process per-session Unix socket server backing the routed MCP child.
//
// 设计 / Design:
// - 每个 ClaudePtySession 拥有独立 IPC host（独立 socket path、独立 token）。
// - 子进程（cerelay-routed MCP server）启动时用 token 做 hello 握手，握手后所有
//   tool_call 通过注入的 dispatcher 路由到 ClaudePtySession 的 client-routing 通道。
// - 一次只允许一个活跃连接（CC 也只 spawn 一个 MCP server 子进程）。
// ============================================================

import { createServer, type Server, type Socket } from "node:net";
import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { createLogger, type Logger } from "./logger.js";
import {
  decodeIpcLines,
  encodeIpcMessage,
  type IpcMessage,
  type IpcToolCallRequest,
} from "./mcp-routed/ipc-protocol.js";
import type { RemoteToolResult } from "./relay.js";

const log = createLogger("mcp-ipc-host");

export type ToolCallDispatcher = (
  toolName: string,
  input: unknown,
) => Promise<RemoteToolResult>;

export interface MCPIpcHostOptions {
  sessionId: string;
  socketPath: string;
  token: string;
  dispatcher: ToolCallDispatcher;
  /** 收到 tool_call 时是否记录详情（默认 true）；测试可关闭。 */
  verboseLogging?: boolean;
}

export class MCPIpcHost {
  readonly sessionId: string;
  readonly socketPath: string;

  private readonly token: string;
  private readonly dispatcher: ToolCallDispatcher;
  private readonly verbose: boolean;
  private readonly log: Logger;
  private server: Server | null = null;
  private activeSocket: Socket | null = null;
  private buffer = "";
  private authenticated = false;
  private closed = false;

  constructor(options: MCPIpcHostOptions) {
    this.sessionId = options.sessionId;
    this.socketPath = options.socketPath;
    this.token = options.token;
    this.dispatcher = options.dispatcher;
    this.verbose = options.verboseLogging ?? true;
    this.log = log.child({ sessionId: this.sessionId, socketPath: this.socketPath });
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    if (this.closed) {
      throw new Error("MCPIpcHost 已关闭，无法重启");
    }
    await mkdir(path.dirname(this.socketPath), { recursive: true });
    await unlink(this.socketPath).catch(() => undefined);

    const server = createServer((socket) => this.handleConnection(socket));
    server.on("error", (err) => {
      this.log.warn("MCPIpcHost server 异常", { error: err.message });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    this.log.debug("MCPIpcHost 已 listen");
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const server = this.server;
    this.server = null;
    if (this.activeSocket && !this.activeSocket.destroyed) {
      this.activeSocket.destroy();
    }
    this.activeSocket = null;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    await unlink(this.socketPath).catch(() => undefined);
    this.log.debug("MCPIpcHost 已关闭");
  }

  /** 是否当前有已认证的活跃连接（测试用）。 */
  hasActiveAuthenticatedConnection(): boolean {
    return Boolean(this.activeSocket && this.authenticated);
  }

  private handleConnection(socket: Socket): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    if (this.activeSocket) {
      // CC 一次只 spawn 一个 MCP server 子进程；多连接很可能是僵尸或攻击。
      this.log.warn("MCPIpcHost 拒绝并发连接");
      socket.destroy();
      return;
    }

    this.activeSocket = socket;
    this.authenticated = false;
    this.buffer = "";

    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      const { messages, rest } = decodeIpcLines(this.buffer);
      this.buffer = rest;
      for (const message of messages) {
        void this.dispatchMessage(socket, message);
      }
    });
    socket.on("close", () => {
      if (this.activeSocket === socket) {
        this.activeSocket = null;
        this.authenticated = false;
        this.buffer = "";
        this.log.debug("MCPIpcHost 连接关闭");
      }
    });
    socket.on("error", (err) => {
      this.log.debug("MCPIpcHost socket error", { error: err.message });
    });
  }

  private async dispatchMessage(socket: Socket, message: IpcMessage): Promise<void> {
    if (!this.authenticated) {
      if (message.type !== "hello") {
        this.log.warn("MCPIpcHost 收到未认证连接的非 hello 消息", { type: message.type });
        socket.destroy();
        return;
      }
      if (message.token !== this.token) {
        this.writeMessage(socket, {
          type: "hello_ack",
          ok: false,
          error: "invalid token",
        });
        this.log.warn("MCPIpcHost token 不匹配，拒绝连接");
        socket.destroy();
        return;
      }
      this.authenticated = true;
      this.writeMessage(socket, { type: "hello_ack", ok: true });
      this.log.debug("MCPIpcHost 子进程已认证");
      return;
    }

    if (message.type === "tool_call") {
      await this.handleToolCall(socket, message);
      return;
    }

    this.log.warn("MCPIpcHost 已认证连接收到意外消息", { type: message.type });
  }

  private async handleToolCall(socket: Socket, message: IpcToolCallRequest): Promise<void> {
    if (this.verbose) {
      this.log.debug("MCPIpcHost dispatch tool_call", {
        id: message.id,
        toolName: message.toolName,
      });
    }
    let result: RemoteToolResult;
    try {
      result = await this.dispatcher(message.toolName, message.input);
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);
      this.writeMessage(socket, {
        type: "tool_result",
        id: message.id,
        error: errorText,
      });
      return;
    }
    this.writeMessage(socket, {
      type: "tool_result",
      id: message.id,
      output: result.output,
      summary: result.summary,
      error: result.error,
    });
  }

  private writeMessage(socket: Socket, message: IpcMessage): void {
    if (socket.destroyed) {
      return;
    }
    socket.write(encodeIpcMessage(message));
  }
}

/**
 * 选择一个长度安全的 socket 路径。
 * Pick a socket path within Unix socket length limit (108 bytes on Linux).
 */
export function buildMcpIpcSocketPath(rootDir: string, sessionId: string): string {
  // sessionId 形如 "pty-<ms>-<uuid>"（54 char），rootDir 通常 < 30 char。
  // 整体路径稳定 < 108 char。
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "-");
  return path.join(rootDir, `mcp-${safeId}.sock`);
}
