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
import { createHash } from "node:crypto";
import path from "node:path";
import { createLogger, type Logger } from "./logger.js";
import {
  decodeIpcLines,
  encodeIpcMessage,
  type IpcMessage,
  type IpcToolCallRequest,
} from "./mcp-routed/ipc-protocol.js";
import type { RemoteToolResult } from "./relay.js";

const HANDSHAKE_TIMEOUT_MS = 5_000;

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
  private handshakeTimer: NodeJS.Timeout | null = null;

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
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          server.off("listening", onListen);
          reject(err);
        };
        const onListen = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListen);
        server.listen(this.socketPath);
      });
    } catch (err) {
      // listen 失败必须显式关闭 server，避免 fd 泄漏。
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      }).catch(() => undefined);
      await unlink(this.socketPath).catch(() => undefined);
      throw err;
    }
    this.server = server;
    this.log.debug("MCPIpcHost 已 listen");
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    const server = this.server;
    this.server = null;
    if (this.activeSocket && !this.activeSocket.destroyed) {
      this.activeSocket.destroy();
    }
    this.activeSocket = null;
    this.authenticated = false;
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

    // 防御僵尸连接：握手必须在 HANDSHAKE_TIMEOUT_MS 内完成，否则 destroy。
    this.handshakeTimer = setTimeout(() => {
      if (this.activeSocket === socket && !this.authenticated) {
        this.log.warn("MCPIpcHost 握手超时，断开连接");
        socket.destroy();
      }
    }, HANDSHAKE_TIMEOUT_MS);

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
        if (this.handshakeTimer) {
          clearTimeout(this.handshakeTimer);
          this.handshakeTimer = null;
        }
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
        this.log.warn("MCPIpcHost token 不匹配，拒绝连接");
        // 用 socket.end(...) 让 ack 帧在 close 前完整发出，避免对端读不到 ok:false。
        socket.end(encodeIpcMessage({ type: "hello_ack", ok: false, error: "invalid token" }));
        return;
      }
      this.authenticated = true;
      if (this.handshakeTimer) {
        clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
      }
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
 * Pick a socket path within the strictest Unix socket sun_path limit:
 *   - macOS: 104 bytes including NUL → string ≤ 103
 *   - Linux: 108 bytes including NUL → string ≤ 107
 * 我们硬卡到 macOS 上限（103）。
 *
 * 长 sessionId 用 sha256 截 16 hex（64 bit 抗碰撞足够），不再原样拼接。
 */
export const MAX_UNIX_SOCKET_PATH_LENGTH = 103;

export function buildMcpIpcSocketPath(rootDir: string, sessionId: string): string {
  const hash = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  const candidate = path.join(rootDir, `mcp-${hash}.sock`);
  if (Buffer.byteLength(candidate, "utf8") > MAX_UNIX_SOCKET_PATH_LENGTH) {
    throw new Error(
      `mcp socket path 超出长度上限 ${MAX_UNIX_SOCKET_PATH_LENGTH}：${candidate}（rootDir 太长，请改用更短的 socket 目录）`,
    );
  }
  return candidate;
}
