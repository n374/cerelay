// ============================================================
// Axon Server：主服务器
// Phase 6 升级：
//   - Multi-Hand 支持（HandRegistry）
//   - Token 认证（TokenStore）
//   - 结构化日志（Logger）
//   - 统计收集（StatsCollector）
//   - 管理后台 HTTP API（/admin/*）
//   - 优雅关闭
// ============================================================

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
import { TokenStore, extractBearerToken, extractQueryToken } from "./auth.js";
import { HandRegistry } from "./hand-registry.js";
import { StatsCollector } from "./stats.js";
import { createLogger } from "./logger.js";

const log = createLogger("server");

// ============================================================
// ServerOptions
// ============================================================

export interface ServerOptions {
  model: string;
  port: number;
  /** 是否启用 Token 认证（默认 false）*/
  authEnabled?: boolean;
  /** 初始 Token（启动时自动创建，打印到日志）*/
  initialToken?: string;
}

// ============================================================
// AxonServer
// ============================================================

export class AxonServer {
  private readonly defaultModel: string;
  private readonly port: number;

  // 组件
  private readonly auth: TokenStore;
  private readonly hands = new HandRegistry();
  private readonly sessions = new Map<string, { session: BrainSession; handId: string }>();
  private readonly stats = new StatsCollector();
  private readonly tokenCleanupTimer: NodeJS.Timeout;

  // HTTP/WS 基础设施
  private readonly httpServer = createServer(this.handleHttpRequest.bind(this));
  private readonly wsServer = new WebSocketServer({ noServer: true });

  private shuttingDown = false;

  constructor(options: ServerOptions) {
    this.defaultModel = options.model;
    this.port = options.port;
    this.auth = new TokenStore(options.authEnabled ?? false);

    const initialToken = options.initialToken?.trim();
    const seededToken = initialToken
      ? this.auth.createFixed("initial", initialToken)
      : this.auth.create("initial");
    log.info("已生成初始管理 Token，请妥善保存", {
      token: seededToken.token,
      websocketAuthEnabled: this.auth.isEnabled(),
    });

    this.tokenCleanupTimer = setInterval(() => {
      const removed = this.auth.cleanup();
      if (removed > 0) {
        log.debug("已清理过期或吊销的 token", { removed });
      }
    }, 60_000);

    this.httpServer.on("upgrade", this.handleUpgrade.bind(this));
    this.wsServer.on("connection", (socket, req) => {
      void this.handleConnection(socket, req);
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
    log.info("开始优雅关闭...");
    clearInterval(this.tokenCleanupTimer);

    // 关闭所有 session
    for (const { session } of this.sessions.values()) {
      session.close();
    }
    this.sessions.clear();

    // 关闭所有 Hand 连接
    for (const hand of this.hands.all()) {
      if (hand.socket.readyState === WebSocket.OPEN) {
        hand.socket.close();
      }
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

    log.info("服务器已关闭");
  }

  // ============================================================
  // HTTP 请求处理（健康检查 + 管理后台）
  // ============================================================

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    const pathname = this.getPathname(req.url);

    // 健康检查（无需认证）
    if (pathname === "/health") {
      this.sendJson(res, 200, {
        status: "ok",
        time: new Date().toISOString(),
        handsOnline: this.hands.count(),
      });
      return;
    }

    // 管理后台路由（需要认证）
    if (pathname === "/admin" || pathname.startsWith("/admin/")) {
      this.handleAdminRequest(req, res, pathname);
      return;
    }

    this.sendJson(res, 404, { error: "not_found" });
  }

  // ============================================================
  // 管理后台 HTTP API
  // ============================================================

  private handleAdminRequest(req: IncomingMessage, res: ServerResponse, url: string): void {
    // 管理后台认证（始终要求 token，即使认证未全局启用）
    const authHeader = req.headers.authorization;
    const token = extractBearerToken(authHeader);

    if (!token) {
      this.sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    if (!this.auth.verify(token)) {
      this.sendJson(res, 403, { error: "forbidden" });
      return;
    }

    // 路由
    if (url === "/admin/stats" && req.method === "GET") {
      this.sendJson(res, 200, this.stats.snapshot(this.hands.count()));
      return;
    }

    if (url === "/admin/hands" && req.method === "GET") {
      this.sendJson(res, 200, { hands: this.hands.stats() });
      return;
    }

    if (url === "/admin/sessions" && req.method === "GET") {
      this.sendJson(res, 200, {
        sessions: Array.from(this.sessions.entries()).map(([id, { session, handId }]) => ({
          ...session.info(),
          handId,
        })),
      });
      return;
    }

    if (url === "/admin/tokens" && req.method === "GET") {
      this.sendJson(res, 200, { tokens: this.auth.list() });
      return;
    }

    if (url === "/admin/tokens" && req.method === "POST") {
      this.handleCreateToken(req, res);
      return;
    }

    if (url.startsWith("/admin/tokens/") && req.method === "DELETE") {
      const tokenId = url.replace("/admin/tokens/", "");
      const ok = this.auth.revoke(tokenId);
      this.sendJson(res, ok ? 200 : 404, { ok, tokenId });
      return;
    }

    this.sendJson(res, 404, { error: "not_found" });
  }

  private handleCreateToken(req: IncomingMessage, res: ServerResponse): void {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        const params = body ? (JSON.parse(body) as { label?: string; ttl?: number }) : {};
        const label = params.label ?? "手动创建";
        const ttl = params.ttl;
        const result = this.auth.create(label, ttl);
        this.sendJson(res, 201, result);
      } catch (err) {
        this.sendJson(res, 400, { error: "invalid_body" });
      }
    });
  }

  // ============================================================
  // WebSocket 升级处理
  // ============================================================

  private handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    if (request.url !== "/ws" && !request.url?.startsWith("/ws?")) {
      socket.destroy();
      return;
    }

    // 认证校验（支持 Authorization header 和 ?token= query string）
    if (this.auth.isEnabled()) {
      const headerToken = extractBearerToken(request.headers.authorization);
      const queryToken = extractQueryToken(request.url);
      const rawToken = headerToken ?? queryToken ?? "";
      const tokenId = this.auth.verify(rawToken);

      if (!tokenId) {
        log.warn("WebSocket 升级被拒绝：Token 无效");
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    this.wsServer.handleUpgrade(request, socket, head, (ws) => {
      this.wsServer.emit("connection", ws, request);
    });
  }

  // ============================================================
  // Hand 连接处理
  // ============================================================

  private async handleConnection(socket: WebSocket, req: IncomingMessage): Promise<void> {
    // 获取 token（用于关联 hand 记录）
    const headerToken = extractBearerToken(req.headers.authorization);
    const queryToken = extractQueryToken(req.url);
    const rawToken = headerToken ?? queryToken ?? "";
    const tokenId = this.auth.isEnabled() ? (this.auth.verify(rawToken) ?? "unknown") : "noauth";

    const handId = `hand-${Date.now()}-${randomUUID().substring(0, 8)}`;
    const remoteAddress =
      req.socket.remoteAddress ?? req.headers["x-forwarded-for"]?.toString() ?? "unknown";

    const handInfo = this.hands.register(handId, socket, tokenId, remoteAddress);
    this.stats.onHandConnected();
    log.info("Hand 已连接", { handId, remoteAddress, tokenId });

    // 发送 connected 通知
    try {
      await this.sendToHand(handId, { type: "connected" });
    } catch (err) {
      log.error("发送 connected 通知失败", { handId, error: String(err) });
    }

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        return;
      }
      this.stats.onMessageReceived();
      void this.handleMessage(handId, data.toString());
    });

    socket.on("close", () => {
      this.hands.unregister(handId);
      this.stats.onHandDisconnected();
      log.info("Hand 已断开", { handId });

      // 清理该 hand 的所有 session（发送 session_end 通知已无意义，因为 WS 已关闭）
      for (const sessionId of handInfo.sessionIds) {
        const entry = this.sessions.get(sessionId);
        if (entry) {
          entry.session.close();
          this.sessions.delete(sessionId);
          this.stats.onSessionEnded();
        }
      }
    });

    socket.on("error", (error) => {
      log.error("Hand WebSocket 错误", { handId, error: error.message });
      this.stats.onError();
    });
  }

  // ============================================================
  // 消息路由
  // ============================================================

  private async handleMessage(handId: string, raw: string): Promise<void> {
    let envelope: Envelope;

    try {
      envelope = JSON.parse(raw) as Envelope;
    } catch (error) {
      await this.sendErrorToHand(handId, asError(error).message);
      return;
    }

    try {
      switch (envelope.type) {
        case "create_session":
          await this.handleCreateSession(handId, JSON.parse(raw) as CreateSession);
          return;
        case "prompt":
          await this.handlePrompt(handId, JSON.parse(raw) as Prompt);
          return;
        case "tool_result":
          await this.handleToolResult(handId, JSON.parse(raw) as ToolResult);
          return;
        case "list_sessions":
          await this.handleListSessions(handId, JSON.parse(raw) as ListSessions);
          return;
        case "close_session":
          await this.handleCloseSession(handId, JSON.parse(raw) as CloseSession);
          return;
        default:
          throw new Error(`未知消息类型: ${envelope.type}`);
      }
    } catch (error) {
      this.stats.onError();
      await this.sendErrorToHand(handId, asError(error).message);
    }
  }

  private async handleCreateSession(handId: string, message: CreateSession): Promise<void> {
    const sessionId = `sess-${Date.now()}-${randomUUID()}`;

    const session = BrainSession.createSession({
      id: sessionId,
      cwd: message.cwd || ".",
      model: message.model || this.defaultModel,
      transport: {
        send: async (payload) => {
          // tool_call 时记录工具调用统计
          if (payload.type === "tool_call") {
            const tc = payload as import("./protocol.js").ToolCall;
            this.stats.onToolCall(tc.toolName);
          }
          await this.sendToHand(handId, payload);
        },
      },
    });

    this.sessions.set(sessionId, { session, handId });
    this.hands.bindSession(handId, sessionId);
    this.stats.onSessionCreated();

    log.info("Session 已创建", { sessionId, handId, cwd: message.cwd, model: message.model });

    await this.sendToHand(handId, {
      type: "session_created",
      sessionId,
    });
  }

  private async handlePrompt(handId: string, message: Prompt): Promise<void> {
    const entry = this.getSessionEntry(message.sessionId);

    if (entry.handId !== handId) {
      throw new Error(`Session ${message.sessionId} 不属于当前 Hand`);
    }

    log.debug("收到 prompt", { sessionId: message.sessionId, handId });

    void entry.session.prompt(message.text).catch((error) => {
      log.error("prompt 执行失败", { sessionId: message.sessionId, error: String(error) });
      this.stats.onError();
      void this.sendErrorToHand(handId, asError(error).message, message.sessionId);
    });
  }

  private async handleToolResult(handId: string, message: ToolResult): Promise<void> {
    const entry = this.getSessionEntry(message.sessionId);
    entry.session.resolveToolResult(message.requestId, {
      output: message.output,
      summary: message.summary,
      error: message.error,
    });
  }

  private async handleListSessions(handId: string, _: ListSessions): Promise<void> {
    // 只列出属于该 hand 的 session
    const handInfo = this.hands.get(handId);
    const sessionIds = handInfo ? handInfo.sessionIds : new Set<string>();

    const sessionList = Array.from(sessionIds)
      .map((id) => this.sessions.get(id))
      .filter(Boolean)
      .map((entry) => entry!.session.info());

    await this.sendToHand(handId, {
      type: "session_list",
      sessions: sessionList,
    });
  }

  private async handleCloseSession(handId: string, message: CloseSession): Promise<void> {
    const entry = this.getSessionEntry(message.sessionId);

    if (entry.handId !== handId) {
      throw new Error(`Session ${message.sessionId} 不属于当前 Hand`);
    }

    entry.session.close();
    this.sessions.delete(message.sessionId);
    this.hands.unbindSession(handId, message.sessionId);
    this.stats.onSessionEnded();

    log.info("Session 已关闭", { sessionId: message.sessionId, handId });
  }

  // ============================================================
  // 辅助方法
  // ============================================================

  private getSessionEntry(sessionId: string): { session: BrainSession; handId: string } {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new Error(`会话不存在: ${sessionId}`);
    }
    return entry;
  }

  private async sendToHand(handId: string, message: ServerToHandMessage | Connected): Promise<void> {
    await this.hands.sendTo(handId, message);
  }

  private async sendErrorToHand(handId: string, message: string, sessionId?: string): Promise<void> {
    const payload: ServerError = {
      type: "error",
      sessionId,
      message,
    };

    try {
      await this.hands.sendTo(handId, payload);
    } catch (err) {
      log.error("发送错误消息失败", { handId, error: String(err), originalMessage: message });
    }
  }

  private sendJson(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, {
      "content-type": "application/json",
      "x-content-type-options": "nosniff",
    });
    res.end(JSON.stringify(data));
  }

  private getPathname(requestUrl: string | undefined): string {
    if (!requestUrl) {
      return "/";
    }

    try {
      return new URL(requestUrl, "http://localhost").pathname;
    } catch {
      return "/";
    }
  }
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(typeof error === "string" ? error : JSON.stringify(error));
}
