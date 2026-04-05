import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import type {
  Connected,
  CloseSession,
  CreateSession,
  Envelope,
  ListSessions,
  Prompt,
  ServerError,
  ServerToHandMessage,
  ToolResult,
} from "./protocol.js";
import { BrainSession } from "./session.js";

interface ServerOptions {
  model: string;
  port: number;
}

export class AxonServer {
  private readonly defaultModel: string;
  private readonly port: number;
  private readonly sessions = new Map<string, BrainSession>();
  private readonly httpServer = createServer(this.handleHttpRequest.bind(this));
  private readonly wsServer = new WebSocketServer({ noServer: true });
  private connection: WebSocket | null = null;
  private shuttingDown = false;

  constructor(options: ServerOptions) {
    this.defaultModel = options.model;
    this.port = options.port;

    this.httpServer.on("upgrade", this.handleUpgrade.bind(this));
    this.wsServer.on("connection", (socket) => {
      void this.handleConnection(socket);
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(this.port, () => {
        this.httpServer.off("error", reject);
        resolve();
      });
    });
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    this.shuttingDown = true;

    for (const session of this.sessions.values()) {
      session.close();
    }
    this.sessions.clear();

    if (this.connection && this.connection.readyState === WebSocket.OPEN) {
      this.connection.close();
    }

    await new Promise<void>((resolve) => {
      this.wsServer.close(() => resolve());
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", time: new Date().toISOString() }));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  }

  private handleUpgrade(
    request: IncomingMessage,
    socket: Socket,
    head: Buffer
  ): void {
    if (request.url !== "/ws") {
      socket.destroy();
      return;
    }

    this.wsServer.handleUpgrade(request, socket, head, (ws) => {
      this.wsServer.emit("connection", ws, request);
    });
  }

  private async handleConnection(socket: WebSocket): Promise<void> {
    if (this.connection && this.connection.readyState === WebSocket.OPEN) {
      try {
        await this.sendRaw(this.connection, {
          type: "error",
          message: "另一个 Hand 连接已建立，当前连接将被替换",
        });
      } catch (error) {
        console.error("[server] failed to notify previous connection:", error);
      }
      this.connection.close();
    }

    this.connection = socket;

    await this.send({
      type: "connected",
    });

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        return;
      }
      void this.handleMessage(data.toString());
    });

    socket.on("close", () => {
      if (this.connection === socket) {
        this.connection = null;
      }
    });

    socket.on("error", (error) => {
      console.error("[server] websocket error:", error);
    });
  }

  private async handleMessage(raw: string): Promise<void> {
    let envelope: Envelope;

    try {
      envelope = JSON.parse(raw) as Envelope;
    } catch (error) {
      await this.sendError(asError(error).message);
      return;
    }

    try {
      switch (envelope.type) {
        case "create_session":
          await this.handleCreateSession(JSON.parse(raw) as CreateSession);
          return;
        case "prompt":
          await this.handlePrompt(JSON.parse(raw) as Prompt);
          return;
        case "tool_result":
          await this.handleToolResult(JSON.parse(raw) as ToolResult);
          return;
        case "list_sessions":
          await this.handleListSessions(JSON.parse(raw) as ListSessions);
          return;
        case "close_session":
          await this.handleCloseSession(JSON.parse(raw) as CloseSession);
          return;
        default:
          throw new Error(`未知消息类型: ${envelope.type}`);
      }
    } catch (error) {
      await this.sendError(asError(error).message);
    }
  }

  private async handleCreateSession(message: CreateSession): Promise<void> {
    const session = BrainSession.createSession({
      id: `sess-${Date.now()}-${randomUUID()}`,
      cwd: message.cwd || ".",
      model: message.model || this.defaultModel,
      transport: {
        send: (payload) => this.send(payload),
      },
    });

    this.sessions.set(session.id, session);

    await this.send({
      type: "session_created",
      sessionId: session.id,
    });
  }

  private async handlePrompt(message: Prompt): Promise<void> {
    const session = this.getSession(message.sessionId);
    void session.prompt(message.text).catch((error) => {
      void this.sendError(asError(error).message, message.sessionId);
    });
  }

  private async handleToolResult(message: ToolResult): Promise<void> {
    const session = this.getSession(message.sessionId);
    session.resolveToolResult(message.requestId, {
      output: message.output,
      summary: message.summary,
      error: message.error,
    });
  }

  private async handleListSessions(_: ListSessions): Promise<void> {
    await this.send({
      type: "session_list",
      sessions: Array.from(this.sessions.values()).map((session) => session.info()),
    });
  }

  private async handleCloseSession(message: CloseSession): Promise<void> {
    const session = this.getSession(message.sessionId);
    session.close();
    this.sessions.delete(message.sessionId);
  }

  private getSession(sessionId: string): BrainSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`会话不存在: ${sessionId}`);
    }
    return session;
  }

  private async send(message: ServerToHandMessage | Connected): Promise<void> {
    if (!this.connection || this.connection.readyState !== WebSocket.OPEN) {
      throw new Error("hand not connected");
    }

    await this.sendRaw(this.connection, message);
  }

  private async sendError(message: string, sessionId?: string): Promise<void> {
    if (!this.connection || this.connection.readyState !== WebSocket.OPEN) {
      console.error("[server]", message);
      return;
    }

    const payload: ServerError = {
      type: "error",
      sessionId,
      message,
    };
    await this.sendRaw(this.connection, payload);
  }

  private async sendRaw(socket: WebSocket, message: unknown): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      socket.send(JSON.stringify(message), (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(typeof error === "string" ? error : JSON.stringify(error));
}
