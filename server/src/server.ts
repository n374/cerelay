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
  RestoreSession,
  SessionMcpCatalog,
  ServerError,
  ServerToHandMessage,
  ToolResult,
} from "./protocol.js";
import { BrainSession } from "./session.js";
import { TokenStore, extractBearerToken, extractQueryToken } from "./auth.js";
import { HandRegistry } from "./hand-registry.js";
import { StatsCollector } from "./stats.js";
import { createLogger } from "./logger.js";
import { ToolRoutingStore } from "./tool-routing.js";
import { createClaudeSessionRuntime } from "./claude-session-runtime.js";
import { createMcpProxyServers } from "./mcp-proxy.js";
import { loadClaudeMcpServerConfigs } from "./claude-mcp-config.js";

const log = createLogger("server");
const SESSION_RESUME_GRACE_MS = 60_000;

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
  /** session 恢复窗口，默认 60 秒 */
  sessionResumeGraceMs?: number;
  /** detached session 清理轮询间隔，默认 15 秒 */
  sessionCleanupIntervalMs?: number;
}

// ============================================================
// AxonServer
// ============================================================

export class AxonServer {
  private readonly defaultModel: string;
  private readonly port: number;
  private readonly sessionResumeGraceMs: number;

  // 组件
  private readonly auth: TokenStore;
  private readonly hands = new HandRegistry();
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly stats = new StatsCollector();
  private readonly toolRouting = new ToolRoutingStore();
  private readonly tokenCleanupTimer: NodeJS.Timeout;
  private readonly sessionCleanupTimer: NodeJS.Timeout;

  // HTTP/WS 基础设施
  private readonly httpServer = createServer(this.handleHttpRequest.bind(this));
  private readonly wsServer = new WebSocketServer({ noServer: true });

  private shuttingDown = false;

  constructor(options: ServerOptions) {
    this.defaultModel = options.model;
    this.port = options.port;
    this.sessionResumeGraceMs = options.sessionResumeGraceMs ?? SESSION_RESUME_GRACE_MS;
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

    this.sessionCleanupTimer = setInterval(() => {
      this.cleanupDetachedSessions();
    }, options.sessionCleanupIntervalMs ?? 15_000);

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

  getListenPort(): number {
    const address = this.httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("服务器尚未监听端口");
    }
    return address.port;
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    this.shuttingDown = true;
    log.info("开始优雅关闭...");
    clearInterval(this.tokenCleanupTimer);
    clearInterval(this.sessionCleanupTimer);

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
    const requestLog = log.child({
      method: req.method ?? "UNKNOWN",
      path: pathname,
      remoteAddress: req.socket.remoteAddress ?? "unknown",
    });
    requestLog.debug("收到 HTTP 请求");

    // 健康检查（无需认证）
    if (pathname === "/health") {
      requestLog.debug("返回健康检查结果", {
        handsOnline: this.hands.count(),
      });
      this.sendJson(res, 200, {
        status: "ok",
        time: new Date().toISOString(),
        handsOnline: this.hands.count(),
      });
      return;
    }

    // 管理后台路由（需要认证）
    if (pathname === "/admin" || pathname.startsWith("/admin/")) {
      requestLog.debug("转交管理后台路由");
      this.handleAdminRequest(req, res, pathname);
      return;
    }

    requestLog.debug("HTTP 路由未命中");
    this.sendJson(res, 404, { error: "not_found" });
  }

  // ============================================================
  // 管理后台 HTTP API
  // ============================================================

  private handleAdminRequest(req: IncomingMessage, res: ServerResponse, url: string): void {
    const requestLog = log.child({
      method: req.method ?? "UNKNOWN",
      path: url,
      remoteAddress: req.socket.remoteAddress ?? "unknown",
    });
    requestLog.debug("收到管理后台请求");

    // 管理后台认证（始终要求 token，即使认证未全局启用）
    const authHeader = req.headers.authorization;
    const token = extractBearerToken(authHeader);

    if (!token) {
      requestLog.debug("管理后台请求缺少 Bearer Token");
      this.sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    const tokenId = this.auth.verify(token);
    if (!tokenId) {
      requestLog.warn("管理后台请求认证失败");
      this.sendJson(res, 403, { error: "forbidden" });
      return;
    }

    requestLog.debug("管理后台请求认证通过", { tokenId });

    // 路由
    if (url === "/admin/stats" && req.method === "GET") {
      requestLog.debug("返回统计信息");
      this.sendJson(res, 200, this.stats.snapshot(this.hands.count()));
      return;
    }

    if (url === "/admin/hands" && req.method === "GET") {
      requestLog.debug("返回 Hand 列表");
      this.sendJson(res, 200, { hands: this.hands.stats() });
      return;
    }

    if (url === "/admin/sessions" && req.method === "GET") {
      requestLog.debug("返回 Session 列表", { sessionCount: this.sessions.size });
      this.sendJson(res, 200, {
        sessions: Array.from(this.sessions.entries()).map(([id, { session, handId }]) => ({
          ...session.info(),
          handId,
        })),
      });
      return;
    }

    if (url === "/admin/tokens" && req.method === "GET") {
      requestLog.debug("返回 Token 列表", { tokenCount: this.auth.list().length });
      this.sendJson(res, 200, { tokens: this.auth.list() });
      return;
    }

    if (url === "/admin/tool-routing" && req.method === "GET") {
      requestLog.debug("返回工具路由配置");
      this.sendJson(res, 200, this.toolRouting.snapshot());
      return;
    }

    if (url === "/admin/tokens" && req.method === "POST") {
      requestLog.debug("进入创建 Token 流程");
      this.handleCreateToken(req, res);
      return;
    }

    if (url === "/admin/tool-routing" && req.method === "PUT") {
      requestLog.debug("进入更新工具路由流程");
      this.handleUpdateToolRouting(req, res);
      return;
    }

    if (url.startsWith("/admin/tokens/") && req.method === "DELETE") {
      const tokenId = url.replace("/admin/tokens/", "");
      const ok = this.auth.revoke(tokenId);
      requestLog.debug("处理 Token 吊销请求", { tokenId, ok });
      this.sendJson(res, ok ? 200 : 404, { ok, tokenId });
      return;
    }

    requestLog.debug("管理后台路由未命中");
    this.sendJson(res, 404, { error: "not_found" });
  }

  private handleCreateToken(req: IncomingMessage, res: ServerResponse): void {
    const requestLog = log.child({
      method: req.method ?? "UNKNOWN",
      path: this.getPathname(req.url),
      remoteAddress: req.socket.remoteAddress ?? "unknown",
    });
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
        requestLog.debug("已创建管理 Token", {
          tokenId: result.tokenId,
          label,
          ttl,
        });
        this.sendJson(res, 201, result);
      } catch (err) {
        requestLog.warn("创建 Token 请求体无效", {
          bodyLength: body.length,
          error: asError(err).message,
        });
        this.sendJson(res, 400, { error: "invalid_body" });
      }
    });
  }

  private handleUpdateToolRouting(req: IncomingMessage, res: ServerResponse): void {
    const requestLog = log.child({
      method: req.method ?? "UNKNOWN",
      path: this.getPathname(req.url),
      remoteAddress: req.socket.remoteAddress ?? "unknown",
    });
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        const params = body
          ? (JSON.parse(body) as { handToolNames?: string[]; handToolPrefixes?: string[] })
          : {};
        const updated = this.toolRouting.update(params);
        requestLog.debug("已更新工具路由配置", {
          handToolNames: updated.handToolNames,
          handToolPrefixes: updated.handToolPrefixes,
        });
        this.sendJson(res, 200, updated);
      } catch (error) {
        requestLog.warn("更新工具路由请求体无效", {
          bodyLength: body.length,
          error: asError(error).message,
        });
        this.sendJson(res, 400, { error: "invalid_body" });
      }
    });
  }

  // ============================================================
  // WebSocket 升级处理
  // ============================================================

  private handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    const upgradeLog = log.child({
      path: this.getPathname(request.url),
      remoteAddress: request.socket.remoteAddress ?? "unknown",
      hasAuthHeader: Boolean(request.headers.authorization),
      hasQueryToken: Boolean(extractQueryToken(request.url)),
      authEnabled: this.auth.isEnabled(),
    });
    upgradeLog.debug("收到 WebSocket 升级请求");

    if (request.url !== "/ws" && !request.url?.startsWith("/ws?")) {
      upgradeLog.debug("WebSocket 升级路径不受支持", { url: request.url });
      socket.destroy();
      return;
    }

    // 认证校验（支持 Authorization header 和 ?token= query string）
    if (this.auth.isEnabled()) {
      const headerToken = extractBearerToken(request.headers.authorization);
      const queryToken = extractQueryToken(request.url);
      const rawToken = headerToken ?? queryToken ?? "";
      const tokenSource = headerToken ? "header" : queryToken ? "query" : "missing";
      const tokenId = this.auth.verify(rawToken);

      if (!tokenId) {
        upgradeLog.warn("WebSocket 升级被拒绝：Token 无效", {
          tokenSource,
        });
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      upgradeLog.debug("WebSocket 升级认证通过", {
        tokenId,
        tokenSource,
      });
    }

    this.wsServer.handleUpgrade(request, socket, head, (ws) => {
      upgradeLog.debug("WebSocket 升级完成");
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
    const tokenSource = headerToken ? "header" : queryToken ? "query" : "none";

    const handId = `hand-${Date.now()}-${randomUUID().substring(0, 8)}`;
    const remoteAddress =
      req.socket.remoteAddress ?? req.headers["x-forwarded-for"]?.toString() ?? "unknown";
    const handLog = log.child({ handId, remoteAddress, tokenId });

    const handInfo = this.hands.register(handId, socket, tokenId, remoteAddress);
    this.stats.onHandConnected();
    log.info("Hand 已连接", { handId, remoteAddress, tokenId });
    handLog.debug("Hand 连接上下文已建立", {
      tokenSource,
      authEnabled: this.auth.isEnabled(),
    });

    // 发送 connected 通知
    try {
      handLog.debug("发送 connected 通知");
      await this.sendToHand(handId, { type: "connected" });
    } catch (err) {
      log.error("发送 connected 通知失败", { handId, error: String(err) });
    }

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        handLog.debug("忽略二进制消息");
        return;
      }
      this.stats.onMessageReceived();
      handLog.debug("收到 Hand 文本消息", {
        bytes: data.toString().length,
      });
      void this.handleMessage(handId, data.toString());
    });

    socket.on("close", () => {
      this.hands.unregister(handId);
      this.stats.onHandDisconnected();
      log.info("Hand 已断开", { handId });
      handLog.debug("开始处理 Hand 断开后的 session 状态", {
        sessionCount: handInfo.sessionIds.size,
      });

      // 活跃中的 session 无法安全恢复，直接关闭；空闲 session 进入短暂可恢复窗口。
      for (const sessionId of handInfo.sessionIds) {
        const entry = this.sessions.get(sessionId);
        if (entry) {
          if (entry.session.info().status === "active") {
            handLog.debug("Hand 断开时销毁活跃 session", { sessionId });
            this.destroySession(sessionId, entry, "Hand 断开时 session 仍在运行");
            continue;
          }

          entry.handId = null;
          entry.resumableUntil = Date.now() + this.sessionResumeGraceMs;
          log.info("Session 进入可恢复窗口", {
            sessionId,
            resumableUntil: new Date(entry.resumableUntil).toISOString(),
          });
          handLog.debug("Session 已标记为可恢复", {
            sessionId,
            resumableUntil: entry.resumableUntil,
          });
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
    const messageLog = log.child({
      handId,
      bytes: raw.length,
    });

    try {
      envelope = JSON.parse(raw) as Envelope;
    } catch (error) {
      messageLog.warn("Hand 消息 JSON 解析失败", { error: asError(error).message });
      await this.sendErrorToHand(handId, asError(error).message);
      return;
    }

    const parsedMessageLog = messageLog.child(messageDebugFields(envelope));
    parsedMessageLog.debug("Hand 消息解析完成");

    try {
      switch (envelope.type) {
        case "create_session":
          await this.handleCreateSession(handId, JSON.parse(raw) as CreateSession);
          return;
        case "prompt":
          await this.handlePrompt(handId, JSON.parse(raw) as Prompt);
          return;
        case "restore_session":
          await this.handleRestoreSession(handId, JSON.parse(raw) as RestoreSession);
          return;
        case "tool_result":
          await this.handleToolResult(handId, JSON.parse(raw) as ToolResult);
          return;
        case "session_mcp_catalog":
          await this.handleSessionMcpCatalog(handId, JSON.parse(raw) as SessionMcpCatalog);
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
      parsedMessageLog.error("处理 Hand 消息失败", { error: asError(error).message });
      this.stats.onError();
      await this.sendErrorToHand(handId, asError(error).message);
    }
  }

  private async handleCreateSession(handId: string, message: CreateSession): Promise<void> {
    log.debug("收到创建 Session 请求", {
      handId,
      cwd: message.cwd || ".",
      model: message.model || this.defaultModel,
    });
    const sessionId = `sess-${Date.now()}-${randomUUID()}`;
    const runtime = await createClaudeSessionRuntime({
      sessionId,
      cwd: message.cwd || ".",
      handHomeDir: message.homeDir,
    });
    const claudeMcpConfigs = await loadClaudeMcpServerConfigs({
      cwd: message.cwd || ".",
    });

    let session!: BrainSession;
    session = BrainSession.createSession({
      id: sessionId,
      cwd: message.cwd || ".",
      claudeEnv: runtime.env,
      claudeHomeDir: runtime.env.HOME,
      handHomeDir: message.homeDir,
      model: message.model || this.defaultModel,
      sdkCwd: runtime.cwd,
      spawnClaudeCodeProcess: runtime.spawnClaudeCodeProcess,
      onClose: runtime.cleanup,
      shouldRouteToolToHand: (toolName) => this.toolRouting.shouldRouteToHand(toolName),
      transport: {
        send: async (payload) => {
          const currentEntry = this.sessions.get(sessionId);
          if (!currentEntry?.handId) {
            throw new Error(`Session ${sessionId} 当前未绑定可用 Hand`);
          }
          log.debug("转发 Session 消息到 Hand", {
            sessionId,
            handId: currentEntry.handId,
            ...messageDebugFields(payload),
          });
          // tool_call 时记录工具调用统计
          if (payload.type === "tool_call") {
            const tc = payload as import("./protocol.js").ToolCall;
            this.stats.onToolCall(tc.toolName);
          }
          await this.sendToHand(currentEntry.handId, payload);
        },
      },
    });

    this.sessions.set(sessionId, {
      session,
      handId,
      resumableUntil: null,
    });
    this.hands.bindSession(handId, sessionId);
    this.stats.onSessionCreated();

    log.info("Session 已创建", { sessionId, handId, cwd: message.cwd, model: message.model });

    await this.sendToHand(handId, {
      type: "session_created",
      sessionId,
      mcpServerConfigs: claudeMcpConfigs,
    });
  }

  private async handleSessionMcpCatalog(handId: string, message: SessionMcpCatalog): Promise<void> {
    const entry = this.getSessionEntry(message.sessionId);
    if (entry.handId !== handId) {
      throw new Error(`Session ${message.sessionId} 不属于当前 Hand`);
    }

    entry.session.setMcpServers(
      createMcpProxyServers(
        message.mcpToolCatalog,
        (toolName, input) => entry.session.executeToolViaHand(toolName, input)
      )
    );

    log.debug("已应用 Hand 返回的 MCP tool catalog", {
      sessionId: message.sessionId,
      handId,
      serverCount: Object.keys(message.mcpToolCatalog).length,
      servers: Object.keys(message.mcpToolCatalog),
    });

    await this.sendToHand(handId, {
      type: "session_mcp_catalog_applied",
      sessionId: message.sessionId,
    });
  }

  private async handleRestoreSession(handId: string, message: RestoreSession): Promise<void> {
    const entry = this.getSessionEntry(message.sessionId);
    log.debug("收到恢复 Session 请求", {
      sessionId: message.sessionId,
      handId,
      currentHandId: entry.handId,
      resumableUntil: entry.resumableUntil,
      status: entry.session.info().status,
    });

    if (entry.handId) {
      throw new Error(`Session ${message.sessionId} 当前已绑定到其他 Hand`);
    }

    if (entry.resumableUntil !== null && entry.resumableUntil < Date.now()) {
      this.destroySession(message.sessionId, entry, "恢复窗口已过期");
      throw new Error(`Session ${message.sessionId} 已过期，无法恢复`);
    }

    entry.handId = handId;
    entry.resumableUntil = null;
    this.hands.bindSession(handId, message.sessionId);

    log.info("Session 已恢复", { sessionId: message.sessionId, handId });

    await this.sendToHand(handId, {
      type: "session_restored",
      sessionId: message.sessionId,
    });
  }

  private async handlePrompt(handId: string, message: Prompt): Promise<void> {
    const entry = this.getSessionEntry(message.sessionId);

    if (entry.handId !== handId) {
      throw new Error(`Session ${message.sessionId} 不属于当前 Hand`);
    }

    log.debug("收到 prompt", { sessionId: message.sessionId, handId });
    log.debug("开始派发 prompt 到 BrainSession", {
      sessionId: message.sessionId,
      handId,
      textLength: message.text.length,
      preview: previewText(message.text),
    });

    void entry.session.prompt(message.text).catch((error) => {
      log.error("prompt 执行失败", { sessionId: message.sessionId, error: String(error) });
      this.stats.onError();
      void this.sendErrorToHand(handId, asError(error).message, message.sessionId);
    });
  }

  private async handleToolResult(handId: string, message: ToolResult): Promise<void> {
    const entry = this.getSessionEntry(message.sessionId);
    log.debug("收到工具结果", {
      handId,
      sessionId: message.sessionId,
      requestId: message.requestId,
      hasError: Boolean(message.error),
      hasSummary: Boolean(message.summary),
      outputType: message.output === undefined ? "undefined" : typeof message.output,
      error: message.error,
      outputSummary: summarizeUnknown(message.output),
    });
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

    log.debug("返回 Hand 的 Session 列表", {
      handId,
      sessionCount: sessionList.length,
    });

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

    log.debug("收到关闭 Session 请求", {
      handId,
      sessionId: message.sessionId,
      status: entry.session.info().status,
    });
    entry.session.close();
    this.destroySession(message.sessionId, entry, "客户端主动关闭");

    log.info("Session 已关闭", { sessionId: message.sessionId, handId });
  }

  // ============================================================
  // 辅助方法
  // ============================================================

  private getSessionEntry(sessionId: string): SessionEntry {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new Error(`会话不存在: ${sessionId}`);
    }
    return entry;
  }

  private async sendToHand(handId: string, message: ServerToHandMessage | Connected): Promise<void> {
    log.debug("发送消息到 Hand", {
      handId,
      ...messageDebugFields(message),
    });
    await this.hands.sendTo(handId, message);
  }

  private async sendErrorToHand(handId: string, message: string, sessionId?: string): Promise<void> {
    const payload: ServerError = {
      type: "error",
      sessionId,
      message,
    };

    try {
      log.debug("发送错误消息到 Hand", {
        handId,
        sessionId,
        message,
      });
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

  private cleanupDetachedSessions(): void {
    const now = Date.now();
    let expiredCount = 0;

    for (const [sessionId, entry] of this.sessions.entries()) {
      if (entry.handId !== null || entry.resumableUntil === null || entry.resumableUntil > now) {
        continue;
      }

      expiredCount += 1;
      this.destroySession(sessionId, entry, "恢复窗口超时");
    }

    if (expiredCount > 0) {
      log.debug("已清理超时未恢复的 Session", { expiredCount });
    }
  }

  private destroySession(sessionId: string, entry: SessionEntry, reason: string): void {
    const boundHandId = entry.handId;
    entry.session.close();
    this.sessions.delete(sessionId);
    if (boundHandId) {
      this.hands.unbindSession(boundHandId, sessionId);
    }
    this.stats.onSessionEnded();
    log.info("Session 已销毁", { sessionId, handId: boundHandId, reason });
  }

}

interface SessionEntry {
  session: BrainSession;
  handId: string | null;
  resumableUntil: number | null;
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(typeof error === "string" ? error : JSON.stringify(error));
}

function messageDebugFields(message: {
  type: string;
  sessionId?: unknown;
  requestId?: unknown;
  toolName?: unknown;
}): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    type: message.type,
  };

  if (typeof message.sessionId === "string") {
    fields.sessionId = message.sessionId;
  }

  if (typeof message.requestId === "string") {
    fields.requestId = message.requestId;
  }

  if (typeof message.toolName === "string") {
    fields.toolName = message.toolName;
  }

  return fields;
}

function previewText(text: string, maxLength = 120): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
}

function summarizeUnknown(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }

  if (typeof value === "string") {
    return previewText(value, 160);
  }

  try {
    return previewText(JSON.stringify(value), 160);
  } catch {
    return String(value);
  }
}
