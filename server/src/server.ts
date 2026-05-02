// ============================================================
// Cerelay Server：主服务器
// Phase 6 升级：
//   - Multi-Client 支持（ClientRegistry）
//   - Token 认证（TokenStore）
//   - 结构化日志（Logger）
//   - 统计收集（StatsCollector）
//   - 管理后台 HTTP API（/admin/*）
//   - 优雅关闭
// ============================================================

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import type {
  CacheTaskDelta,
  CacheTaskFault,
  CacheTaskHeartbeat,
  CacheTaskSyncComplete,
  ClientHello,
  Connected,
  CloseSession,
  CreatePtySession,
  Envelope,
  PtyInput,
  PtyResize,
  ServerError,
  ServerToHandMessage,
  ToolResult,
} from "./protocol.js";
import { ClientCacheStore } from "./file-agent/store.js";
import { FileAgent, ScopeAdapter, InflightMap } from "./file-agent/index.js";
import { SyncCoordinator } from "./file-agent/sync-coordinator.js";
import { CacheTaskClientDispatcher } from "./file-agent/cache-task-dispatcher.js";
import { ConfigPreloader } from "./config-preloader.js";
import { AccessLedgerStore } from "./access-ledger.js";
import { TokenStore, extractBearerToken, extractQueryToken } from "./auth.js";
import { ClientRegistry } from "./client-registry.js";
import { CacheTaskManager } from "./cache-task-manager.js";
import { StatsCollector } from "./stats.js";
import { createLogger } from "./logger.js";
import { ToolRoutingStore } from "./tool-routing.js";
import { createAdminEventBuffer, type AdminEventBuffer } from "./admin-events.js";
import { createClaudeSessionRuntime, getClaudeSessionRuntimeRoot } from "./claude-session-runtime.js";
import { ClaudePtySession } from "./pty-session.js";
import { prepareClaudeHookInjection } from "./claude-hook-injection.js";
import { FileProxyManager } from "./file-proxy-manager.js";
import type { FileProxyResponse } from "./protocol.js";
import type { HookInput } from "./claude-tool-bridge.js";

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
  /** 简单共享密钥（通过 CERELAY_KEY 环境变量传入），Client 连接时必须匹配 */
  cerelayKey?: string;
}

// ============================================================
// CerelayServer
// ============================================================

export class CerelayServer {
  private readonly defaultModel: string;
  private readonly port: number;
  private readonly cerelayKey: string | undefined;

  // 组件
  private readonly auth: TokenStore;
  private readonly clients = new ClientRegistry();
  private readonly ptySessions = new Map<string, PtySessionEntry>();
  /** sessionId → FileProxyManager，独立于 PTY session entry 注册，确保 session 创建期间也能 dispatch */
  private readonly fileProxies = new Map<string, FileProxyManager>();
  private readonly stats = new StatsCollector();
  private readonly toolRouting = new ToolRoutingStore();
  private readonly tokenCleanupTimer: NodeJS.Timeout;
  /**
   * Client 文件缓存存储（Data 目录持久化）。
   * 在构造时固定 dataDir，后续 handshake/push 都复用这一个实例。
   */
  private readonly cacheStore = new ClientCacheStore({
    dataDir: process.env.CERELAY_DATA_DIR?.trim() || "/var/lib/cerelay",
  });
  private readonly accessLedgerStore = new AccessLedgerStore({
    dataDir: process.env.CERELAY_DATA_DIR?.trim() || "/var/lib/cerelay",
  });
  private readonly cacheTaskManager: CacheTaskManager;
  private readonly cacheTaskSweepTimer: NodeJS.Timeout;
  readonly adminEvents: AdminEventBuffer = createAdminEventBuffer();

  /**
   * Per-device FileAgent 单例池（plan §2 P6）。
   * Session 创建时 lazy 实例化；server 关闭时关闭所有 GC 定时器。
   */
  private readonly fileAgents = new Map<string, import("./file-agent/index.js").FileAgent>();

  // HTTP/WS 基础设施
  private readonly httpServer = createServer(this.handleHttpRequest.bind(this));
  private readonly wsServer = new WebSocketServer({ noServer: true });

  private shuttingDown = false;

  constructor(options: ServerOptions) {
    this.defaultModel = options.model;
    this.port = options.port;
    this.cerelayKey = options.cerelayKey || undefined;
    this.auth = new TokenStore(options.authEnabled ?? false);
    this.cacheTaskManager = new CacheTaskManager({
      registry: this.clients,
      store: this.cacheStore,
      accessLedgerStore: this.accessLedgerStore,
      getHomedirForDevice: () => homedir(),
      sendToClient: async (clientId, message) => {
        await this.sendToClient(clientId, message);
      },
      // Plan §3.6 路径 B wiring：watcher delta 落 manifest 后通知对应 FileAgent
      // 处理 inflight telemetry + TTL 续期。FileAgent 不重复 apply manifest。
      onDeltaApplied: async (deviceId, changes) => {
        const agent = this.fileAgents.get(deviceId);
        if (agent) {
          await agent.notifyWatcherDeltaApplied(changes);
        }
      },
    });

    if (this.cerelayKey) {
      log.info("CERELAY_KEY 已配置，Client 连接需提供匹配的 key");
    }

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
    this.cacheTaskSweepTimer = setInterval(() => {
      void this.cacheTaskManager.sweepHeartbeats().catch((error) => {
        log.error("执行 cache task heartbeat sweep 失败", {
          error: asError(error).message,
        });
      });
    }, 5_000);

    this.httpServer.on("upgrade", this.handleUpgrade.bind(this));
    this.wsServer.on("connection", (socket, req) => {
      void this.handleConnection(socket, req);
    });
  }

  async start(): Promise<void> {
    // Phase 5.3 + 12: 启动期对所有已知 deviceId 跑一次 ledger aging
    // (missing 30 天未访问 → 清; file/dir 永久保留)
    await this.runLedgerAging().catch((err) => {
      log.warn("启动期 ledger aging 失败 (非致命)", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(this.port, () => {
        this.httpServer.off("error", reject);
        resolve();
      });
    });
  }

  private async runLedgerAging(): Promise<void> {
    const ageDays = parseInt(process.env.CERELAY_LEDGER_AGING_DAYS ?? "30", 10);
    if (!Number.isFinite(ageDays) || ageDays <= 0) return;
    const ageMs = ageDays * 24 * 3600 * 1000;
    const now = Date.now();

    // 列出 access-ledger 目录下所有 deviceId, 逐一 load + age + persist
    const fs = await import("node:fs/promises");
    const rootDir = this.accessLedgerStore.rootDir();
    let devices: string[];
    try {
      devices = await fs.readdir(rootDir);
    } catch {
      // ENOENT - 目录还没创建过, 没 ledger 可 age
      return;
    }

    let totalCleaned = 0;
    for (const deviceId of devices) {
      // sanitize: 跳过 dot files / 异常名
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(deviceId)) continue;
      try {
        const ledger = await this.accessLedgerStore.load(deviceId);
        const before = ledger.missingSortedSnapshot().length;
        ledger.runAging(now, ageMs);
        const after = ledger.missingSortedSnapshot().length;
        if (before !== after) {
          ledger.bumpRevision();
          await this.accessLedgerStore.persist(ledger);
          totalCleaned += before - after;
          log.info("启动期 aging 完成", {
            deviceId,
            removed: before - after,
            remaining: after,
          });
        }
      } catch (err) {
        log.warn("启动期 aging 单个 device 失败", {
          deviceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (totalCleaned > 0) {
      log.info("启动期 ledger aging 总计完成", { totalCleaned, ageDays });
    }
  }

  getListenPort(): number {
    const address = this.httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("服务器尚未监听端口");
    }
    return address.port;
  }

  /** 判断是否应启动 FUSE 文件代理（仅 Linux + mount namespace 模式） */
  private shouldStartFileProxy(): boolean {
    return (
      process.platform === "linux" &&
      process.env.CERELAY_ENABLE_MOUNT_NAMESPACE === "true"
    );
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    this.shuttingDown = true;
    log.info("开始优雅关闭...");
    clearInterval(this.tokenCleanupTimer);
    clearInterval(this.cacheTaskSweepTimer);
    // 关闭所有 per-device FileAgent（停止周期 GC）
    for (const agent of this.fileAgents.values()) {
      await agent.close().catch(() => undefined);
    }
    this.fileAgents.clear();
    for (const [sessionId, entry] of Array.from(this.ptySessions.entries())) {
      this.destroyPtySession(sessionId, entry, "服务器关闭");
    }

    // 关闭所有 Client 连接
    for (const client of this.clients.all()) {
      if (client.socket.readyState === WebSocket.OPEN) {
        client.socket.close();
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
        clientsOnline: this.clients.count(),
      });
      this.sendJson(res, 200, {
        status: "ok",
        time: new Date().toISOString(),
        clientsOnline: this.clients.count(),
      });
      return;
    }

    if (pathname === "/internal/hooks/pretooluse") {
      requestLog.debug("转交内部 PreToolUse hook bridge");
      void this.handleInjectedPreToolUseRequest(req, res);
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
      this.sendJson(res, 200, this.stats.snapshot(this.clients.count()));
      return;
    }

    if (url === "/admin/clients" && req.method === "GET") {
      requestLog.debug("返回 Client 列表");
      this.sendJson(res, 200, { clients: this.clients.stats() });
      return;
    }

    if (url === "/admin/sessions" && req.method === "GET") {
      requestLog.debug("返回 PTY Session 列表", { sessionCount: this.ptySessions.size });
      this.sendJson(res, 200, {
        sessions: Array.from(this.ptySessions.entries()).map(([id, { session, clientId }]) => ({
          sessionId: id,
          cwd: session.cwd,
          mode: "pty",
          clientId,
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

    if (url.startsWith("/admin/events") && req.method === "GET") {
      const u = new URL(url, "http://x");
      const sessionId = u.searchParams.get("sessionId") ?? undefined;
      const sinceStr = u.searchParams.get("since");
      const since = sinceStr ? Number.parseInt(sinceStr, 10) : undefined;
      const events = this.adminEvents.fetch({ sessionId, since });
      requestLog.debug("返回 admin events", { sessionId, since, count: events.length });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ enabled: this.adminEvents.isEnabled(), events }));
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

    // CERELAY_KEY 简单共享密钥校验
    if (this.cerelayKey) {
      const clientKey = this.getQueryParam(request.url, "key");
      if (clientKey !== this.cerelayKey) {
        upgradeLog.warn("WebSocket 升级被拒绝：CERELAY_KEY 不匹配", {
          hasClientKey: Boolean(clientKey),
        });
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      upgradeLog.debug("CERELAY_KEY 校验通过");
    }

    // Token 认证校验（支持 Authorization header 和 ?token= query string）
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

  /**
   * 获取或创建 per-device FileAgent 单例（plan §2 P6 + Task 10）。
   * 同 deviceId 多 session 共享同一 FileAgent；shutdown() 时统一关闭。
   *
   * homeDir 一致性：FileAgent.ScopeAdapter 在构造时固化 homeDir；如果同 deviceId
   * 后续 session 上报不同 homeDir，应警告且重建（避免 scope 映射错位）。
   */
  private getOrCreateFileAgent(deviceId: string, homeDir: string): FileAgent {
    const existing = this.fileAgents.get(deviceId);
    if (existing) {
      // 校验 homeDir 一致：FileAgent 没暴露 scopeAdapter 内的 homeDir，但通过
      // ScopeAdapter 的 toAbsPath('claude-json', '') 反推。如果不一致 → 关闭旧实例并重建。
      const existingHome = existing.getHomeDirForTest();
      if (existingHome !== homeDir) {
        log.warn(
          "同 deviceId 后续 session 上报了不同 homeDir，重建 FileAgent",
          { deviceId, existingHome, newHome: homeDir } as Record<string, unknown>,
        );
        existing.close().catch(() => undefined);
        this.fileAgents.delete(deviceId);
      } else {
        return existing;
      }
    }
    // Wiring（plan §9.1 #1）：构造 SyncCoordinator + CacheTaskClientDispatcher 注入
    // FileAgent，让 read miss 时通过 dispatcher 查 manifest（active client 之前推过的内容
    // 能命中，否则 missing；不抛错）。
    const scopeAdapter = new ScopeAdapter(homeDir);
    const inflight = new InflightMap();
    const dispatcher = new CacheTaskClientDispatcher({
      deviceId,
      store: this.cacheStore,
      scopeAdapter,
    });
    const syncCoordinator = new SyncCoordinator({
      deviceId,
      store: this.cacheStore,
      scopeAdapter,
      inflight,
      dispatcher,
    });
    const agent = new FileAgent({
      deviceId,
      homeDir,
      store: this.cacheStore,
      fetcher: syncCoordinator,
      // 默认周期 GC 60s（DEFAULT_GC_INTERVAL_MS）
    });
    this.fileAgents.set(deviceId, agent);
    log.debug("创建 FileAgent 单例", { deviceId, homeDir } as Record<string, unknown>);
    return agent;
  }

  // ============================================================
  // Client 连接处理
  // ============================================================

  private async handleConnection(socket: WebSocket, req: IncomingMessage): Promise<void> {
    // 获取 token（用于关联 client 记录）
    const headerToken = extractBearerToken(req.headers.authorization);
    const queryToken = extractQueryToken(req.url);
    const rawToken = headerToken ?? queryToken ?? "";
    const tokenId = this.auth.isEnabled() ? (this.auth.verify(rawToken) ?? "unknown") : "noauth";
    const tokenSource = headerToken ? "header" : queryToken ? "query" : "none";

    const clientId = `client-${Date.now()}-${randomUUID().substring(0, 8)}`;
    const remoteAddress =
      req.socket.remoteAddress ?? req.headers["x-forwarded-for"]?.toString() ?? "unknown";
    const clientLog = log.child({ clientId, remoteAddress, tokenId });

    const clientInfo = this.clients.register(clientId, socket, tokenId, remoteAddress);
    this.stats.onHandConnected();
    log.info("Client 已连接", { clientId, remoteAddress, tokenId });
    clientLog.debug("Client 连接上下文已建立", {
      tokenSource,
      authEnabled: this.auth.isEnabled(),
    });

    // 发送 connected 通知
    try {
      clientLog.debug("发送 connected 通知");
      await this.sendToClient(clientId, { type: "connected" });
    } catch (err) {
      log.error("发送 connected 通知失败", { clientId, error: String(err) });
    }

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        clientLog.debug("忽略二进制消息");
        return;
      }
      this.stats.onMessageReceived();
      clientLog.debug("收到 Client 文本消息", {
        bytes: data.toString().length,
      });
      void this.handleMessage(clientId, data.toString());
    });

    socket.on("close", () => {
      void (async () => {
        try {
          await this.cacheTaskManager.handleDisconnect(clientId);
        } catch (error) {
          log.error("处理 Client cache task 断开失败", {
            clientId,
            error: asError(error).message,
          });
        } finally {
          this.clients.unregister(clientId);
          this.stats.onHandDisconnected();
          log.info("Client 已断开", { clientId });
          clientLog.debug("开始处理 Client 断开后的 session 状态", {
            sessionCount: clientInfo.sessionIds.size,
          });

          // 活跃中的 session 无法安全恢复，直接关闭；空闲 session 进入短暂可恢复窗口。
          for (const sessionId of clientInfo.sessionIds) {
            const ptyEntry = this.ptySessions.get(sessionId);
            if (ptyEntry) {
              clientLog.debug("Client 断开时销毁 PTY session", { sessionId });
              this.destroyPtySession(sessionId, ptyEntry, "Client 断开");
            }
          }
        }
      })();
    });

    socket.on("error", (error) => {
      log.error("Client WebSocket 错误", { clientId, error: error.message });
      this.stats.onError();
    });
  }

  // ============================================================
  // 消息路由
  // ============================================================

  private async handleMessage(clientId: string, raw: string): Promise<void> {
    let envelope: Envelope;
    const messageLog = log.child({
      clientId,
      bytes: raw.length,
    });

    try {
      envelope = JSON.parse(raw) as Envelope;
    } catch (error) {
      messageLog.warn("Client 消息 JSON 解析失败", { error: asError(error).message });
      await this.sendErrorToClient(clientId, asError(error).message);
      return;
    }

    const parsedMessageLog = messageLog.child(messageDebugFields(envelope));
    parsedMessageLog.debug("Client 消息解析完成");

    try {
      switch (envelope.type) {
        case "create_pty_session":
          await this.handleCreatePtySession(clientId, JSON.parse(raw) as CreatePtySession);
          return;
        case "tool_result":
          await this.handleToolResult(clientId, JSON.parse(raw) as ToolResult);
          return;
        case "file_proxy_response":
          this.handleFileProxyResponse(clientId, JSON.parse(raw) as FileProxyResponse);
          return;
        case "pty_input":
          await this.handlePtyInput(clientId, JSON.parse(raw) as PtyInput);
          return;
        case "pty_resize":
          await this.handlePtyResize(clientId, JSON.parse(raw) as PtyResize);
          return;
        case "close_session":
          await this.handleCloseSession(clientId, JSON.parse(raw) as CloseSession);
          return;
        case "client_hello":
          await this.handleClientHello(clientId, JSON.parse(raw) as ClientHello);
          return;
        case "cache_task_delta":
          await this.handleCacheTaskDelta(clientId, JSON.parse(raw) as CacheTaskDelta);
          return;
        case "cache_task_sync_complete":
          await this.handleCacheTaskSyncComplete(
            clientId,
            JSON.parse(raw) as CacheTaskSyncComplete,
          );
          return;
        case "cache_task_heartbeat":
          await this.handleCacheTaskHeartbeat(clientId, JSON.parse(raw) as CacheTaskHeartbeat);
          return;
        case "cache_task_fault":
          await this.handleCacheTaskFault(clientId, JSON.parse(raw) as CacheTaskFault);
          return;
        default:
          throw new Error(`未知消息类型: ${envelope.type}`);
      }
    } catch (error) {
      parsedMessageLog.error("处理 Client 消息失败", { error: asError(error).message });
      this.stats.onError();
      await this.sendErrorToClient(clientId, asError(error).message);
    }
  }

  // ============================================================
  // File Proxy 响应分发
  // ============================================================

  private handleFileProxyResponse(_clientId: string, resp: FileProxyResponse): void {
    const proxy = this.fileProxies.get(resp.sessionId);
    if (proxy) {
      proxy.resolveResponse(resp);
      return;
    }

    log.debug("收到 file_proxy_response 但未找到对应 FileProxyManager", {
      sessionId: resp.sessionId,
      reqId: resp.reqId,
    });
  }

  private async handleCreatePtySession(clientId: string, message: CreatePtySession): Promise<void> {
    const phaseStart = Date.now();
    const phaseTimings: Record<string, number> = {};
    const markPhase = (name: string, since: number): number => {
      const now = Date.now();
      phaseTimings[name] = now - since;
      return now;
    };

    log.info("收到创建 PTY Session 请求", {
      clientId,
      cwd: message.cwd || ".",
      model: message.model || this.defaultModel,
      cols: message.cols,
      rows: message.rows,
      hasDeviceId: Boolean(message.deviceId),
    });

    const sessionId = `pty-${Date.now()}-${randomUUID()}`;
    const hookToken = randomUUID();
    const runtimeRoot = getClaudeSessionRuntimeRoot(sessionId);
    await rm(runtimeRoot, { recursive: true, force: true });
    let phaseAt = markPhase("cleanRuntimeRoot", phaseStart);
    const hookInjection = await prepareClaudeHookInjection({
      bridgeUrl: `http://127.0.0.1:${this.getListenPort()}/internal/hooks/pretooluse?sessionId=${encodeURIComponent(sessionId)}`,
      existingProjectSettingsLocalContent: message.projectClaudeSettingsLocalContent,
      runtimeRoot,
      sessionId,
      token: hookToken,
    });
    phaseAt = markPhase("prepareHookInjection", phaseAt);

    // 启动 FUSE 文件代理（mount namespace 模式下）
    let fileProxy: FileProxyManager | undefined;
    if (this.shouldStartFileProxy()) {
      // hook injection 的 settings.local.json 作为 shadow file 注入 FUSE
      const shadowFiles: Record<string, string> = {};
      if (hookInjection.settingsPath) {
        shadowFiles["project-claude/settings.local.json"] = hookInjection.settingsPath;
      }
      // 容器内凭证文件作为 shadow file 注入 FUSE，确保 namespace 内可见。
      // 凭证存放于 Data 目录（默认 /var/lib/cerelay/credentials/default/.credentials.json），
      // 由 docker-compose named volume 持久化。
      // 首次启动文件不存在是允许的：CC `login` 时 FUSE create 会在 shadow 路径创建新文件。
      // 所以这里必须总是注入映射，不能用 existsSync 跳过——否则写入会穿透到 Client，违背隔离约束。
      const dataDir = process.env.CERELAY_DATA_DIR?.trim() || "/var/lib/cerelay";
      const credentialsDir = path.join(dataDir, "credentials", "default");
      mkdirSync(credentialsDir, { recursive: true });
      shadowFiles["home-claude/.credentials.json"] = path.join(credentialsDir, ".credentials.json");
      // Per-device FileAgent 单例（plan §2 P6 + Task 10）；同一 deviceId 多 session 共享
      const fileAgent = message.deviceId ? this.getOrCreateFileAgent(
        message.deviceId,
        message.homeDir || process.env.HOME || "/home/node",
      ) : undefined;

      fileProxy = new FileProxyManager({
        runtimeRoot,
        clientHomeDir: message.homeDir || process.env.HOME || "/home/node",
        clientCwd: message.cwd || ".",
        sessionId,
        shadowFiles,
        sendToClient: async (msg) => {
          await this.sendToClient(clientId, msg);
        },
        // 仅当 Client 上报了 deviceId 时才启用 cache 读优先；
        // 未上报则 FileProxyManager 退化为纯穿透模式，功能不变。
        cacheStore: message.deviceId ? this.cacheStore : undefined,
        deviceId: message.deviceId,
        cacheTaskManager: message.deviceId ? this.cacheTaskManager : undefined,
        // Phase 4.2 / 5: 注入 AccessLedger - 启动期 missing 投影 + 运行期 access tracking flush
        accessLedgerStore: message.deviceId ? this.accessLedgerStore : undefined,
        fileAgent,
      });
      // 必须在 start() 之前注册到 fileProxies，否则 start() 内部的 FUSE 缓存预热
      // 发出的 file_proxy_request → Client 响应 file_proxy_response 时，
      // handleFileProxyResponse 找不到 FileProxyManager，响应被丢弃导致 FUSE 请求超时。
      this.fileProxies.set(sessionId, fileProxy);
      await fileProxy.start();

      // Task 10：session 启动期 ConfigPreloader 预热配置文件（同步阻塞）。
      // 当前 FileAgent 还没接 dispatcher（cache-task-manager 单 path fetch 入口属于
      // plan §9 渐进事项），prefetch 在 cache miss 时会 fail；这里 catch 不阻塞 session
      // 启动——日志记录后继续，运行期 FUSE 仍能从 file-proxy-manager 命中已有 cache。
      if (fileAgent && message.deviceId) {
        try {
          const preloader = new ConfigPreloader({
            homeDir: message.homeDir || process.env.HOME || "/home/node",
            cwd: message.cwd || ".",
            fileAgent,
            ttlMs: 7 * 24 * 60 * 60 * 1000, // 7 天（plan §10.2 决策）
            totalTimeoutMs: 10_000, // 10s（preheat 是预热而非阻塞 session 的硬约束）
          });
          const preheatResult = await preloader.preheat();
          log.info("ConfigPreloader 预热完成", {
            sessionId,
            deviceId: message.deviceId,
            ...preheatResult,
          } as Record<string, unknown>);
        } catch (err) {
          log.warn("ConfigPreloader 预热失败（不阻塞 session 启动）", {
            sessionId,
            deviceId: message.deviceId,
            err: err instanceof Error ? err.message : String(err),
          } as Record<string, unknown>);
        }
      }
    }
    phaseAt = markPhase("fileProxyStart", phaseAt);

    let runtime;
    try {
      runtime = await createClaudeSessionRuntime({
        sessionId,
        cwd: message.cwd || ".",
        clientHomeDir: message.homeDir,
        // FUSE 模式下 settings.local.json 由 FUSE shadow file 提供，不需要 bind mount
        projectSettingsLocalShadowPath: fileProxy ? undefined : hookInjection.settingsPath,
        fuseRootDir: fileProxy?.mountPoint,
      });
      phaseAt = markPhase("createRuntime", phaseAt);
      await verifyPtyHookVisibleInRuntime(runtime, message.cwd || ".");
      phaseAt = markPhase("verifyHookVisible", phaseAt);
    } catch (err) {
      // runtime 创建失败时必须先关闭 FUSE，否则 rm(runtimeRoot) 会 EBUSY
      if (fileProxy) {
        this.fileProxies.delete(sessionId);
        await fileProxy.shutdown().catch(() => undefined);
      }
      await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }

    log.info("PTY Session runtime 与 hook 已准备完成", {
      sessionId,
      clientId,
      runtimeRoot: runtime.rootDir,
      runtimeCwd: runtime.cwd,
      runtimeHome: runtime.env.HOME,
      hookScriptPath: hookInjection.scriptPath,
      hookSettingsPath: hookInjection.settingsPath,
      hasProjectSettingsLocal: Boolean(message.projectClaudeSettingsLocalContent),
    });

    const session = new ClaudePtySession({
      id: sessionId,
      cwd: message.cwd || ".",
      model: message.model || this.defaultModel,
      runtime,
      transport: {
        sendOutput: async (targetSessionId, data) => {
          const currentEntry = this.ptySessions.get(targetSessionId);
          if (!currentEntry?.clientId) {
            throw new Error(`PTY session ${targetSessionId} 当前未绑定可用 Client`);
          }
          await this.sendToClient(currentEntry.clientId, {
            type: "pty_output",
            sessionId: targetSessionId,
            data: data.toString("base64"),
          });
        },
        sendExit: async (targetSessionId, exitCode, signal) => {
          const currentEntry = this.ptySessions.get(targetSessionId);
          if (!currentEntry?.clientId) {
            return;
          }
          await this.sendToClient(currentEntry.clientId, {
            type: "pty_exit",
            sessionId: targetSessionId,
            exitCode,
            signal,
          });
          this.destroyPtySession(targetSessionId, currentEntry, "PTY 进程退出");
        },
        sendToolCall: async (targetSessionId, requestId, toolName, toolUseId, input) => {
          const currentEntry = this.ptySessions.get(targetSessionId);
          if (!currentEntry?.clientId) {
            throw new Error(`PTY session ${targetSessionId} 当前未绑定可用 Client`);
          }
          this.stats.onToolCall(toolName);
          await this.sendToClient(currentEntry.clientId, {
            type: "tool_call",
            sessionId: targetSessionId,
            requestId,
            toolName,
            toolUseId,
            input,
          });
        },
        sendToolCallComplete: async (targetSessionId, requestId, toolName) => {
          const currentEntry = this.ptySessions.get(targetSessionId);
          if (!currentEntry?.clientId) {
            throw new Error(`PTY session ${targetSessionId} 当前未绑定可用 Client`);
          }
          await this.sendToClient(currentEntry.clientId, {
            type: "tool_call_complete",
            sessionId: targetSessionId,
            requestId,
            toolName,
          });
        },
      },
      term: message.term,
      colorTerm: message.colorTerm,
      termProgram: message.termProgram,
      termProgramVersion: message.termProgramVersion,
      clientHomeDir: message.homeDir,
      shouldRouteToolToClient: (toolName) => this.toolRouting.shouldRouteToHand(toolName),
      getFileProxyStartupStats: fileProxy ? () => fileProxy!.getStartupStats() : undefined,
      adminEvents: this.adminEvents,
    });

    this.ptySessions.set(sessionId, {
      session,
      clientId,
      hookToken,
      fileProxy,
    });
    this.clients.bindSession(clientId, sessionId);
    this.stats.onSessionCreated();
    await session.start(message.cols ?? 80, message.rows ?? 24);
    phaseAt = markPhase("ptySessionStart", phaseAt);
    await this.sendToClient(clientId, {
      type: "pty_session_created",
      sessionId,
    });

    log.info("PTY Session 已创建", {
      sessionId,
      clientId,
      cwd: message.cwd,
      model: message.model,
      totalMs: Date.now() - phaseStart,
      phaseTimings,
    });
  }

  private async handleToolResult(clientId: string, message: ToolResult): Promise<void> {
    log.debug("收到工具结果", {
      clientId,
      sessionId: message.sessionId,
      requestId: message.requestId,
      hasError: Boolean(message.error),
      hasSummary: Boolean(message.summary),
      outputType: message.output === undefined ? "undefined" : typeof message.output,
      error: message.error,
      outputSummary: summarizeUnknown(message.output),
    });

    const result = {
      output: message.output,
      summary: message.summary,
      error: message.error,
    };

    const ptyEntry = this.getPtySessionEntry(message.sessionId);
    if (ptyEntry.clientId !== clientId) {
      throw new Error(`PTY Session ${message.sessionId} 不属于当前 Client`);
    }
    ptyEntry.session.resolveToolResult(message.requestId, result);
  }

  private async handlePtyInput(clientId: string, message: PtyInput): Promise<void> {
    const entry = this.getPtySessionEntry(message.sessionId);
    if (entry.clientId !== clientId) {
      throw new Error(`PTY Session ${message.sessionId} 不属于当前 Client`);
    }
    entry.session.write(Buffer.from(message.data, "base64"));
  }

  private async handlePtyResize(clientId: string, message: PtyResize): Promise<void> {
    const entry = this.getPtySessionEntry(message.sessionId);
    if (entry.clientId !== clientId) {
      throw new Error(`PTY Session ${message.sessionId} 不属于当前 Client`);
    }
    entry.session.resize(message.cols, message.rows);
  }

  private async handleCloseSession(clientId: string, message: CloseSession): Promise<void> {
    const ptyEntry = this.ptySessions.get(message.sessionId);
    if (!ptyEntry) {
      throw new Error(`PTY 会话不存在: ${message.sessionId}`);
    }
    if (ptyEntry.clientId !== clientId) {
      throw new Error(`PTY Session ${message.sessionId} 不属于当前 Client`);
    }
    this.destroyPtySession(message.sessionId, ptyEntry, "客户端主动关闭");
    log.info("PTY Session 已关闭", { sessionId: message.sessionId, clientId });
  }

  private async handleClientHello(clientId: string, message: ClientHello): Promise<void> {
    await this.cacheTaskManager.registerHello(clientId, message);
  }

  private async handleCacheTaskDelta(clientId: string, message: CacheTaskDelta): Promise<void> {
    await this.cacheTaskManager.applyDelta(clientId, message);
  }

  private async handleCacheTaskSyncComplete(
    clientId: string,
    message: CacheTaskSyncComplete,
  ): Promise<void> {
    await this.cacheTaskManager.completeInitialSync(clientId, message);
  }

  private async handleCacheTaskHeartbeat(
    clientId: string,
    message: CacheTaskHeartbeat,
  ): Promise<void> {
    await this.cacheTaskManager.handleHeartbeat(clientId, message);
  }

  private async handleCacheTaskFault(clientId: string, message: CacheTaskFault): Promise<void> {
    await this.cacheTaskManager.handleFault(clientId, message);
  }

  private getPtySessionEntry(sessionId: string): PtySessionEntry {
    const entry = this.ptySessions.get(sessionId);
    if (!entry) {
      throw new Error(`PTY 会话不存在: ${sessionId}`);
    }
    return entry;
  }

  private async sendToClient(clientId: string, message: ServerToHandMessage | Connected): Promise<void> {
    log.debug("发送消息到 Client", {
      clientId,
      ...messageDebugFields(message),
    });
    await this.clients.sendTo(clientId, message);
  }

  private async sendErrorToClient(clientId: string, message: string, sessionId?: string): Promise<void> {
    const payload: ServerError = {
      type: "error",
      sessionId,
      message,
    };

    try {
      log.debug("发送错误消息到 Client", {
        clientId,
        sessionId,
        message,
      });
      await this.clients.sendTo(clientId, payload);
    } catch (err) {
      log.error("发送错误消息失败", { clientId, error: String(err), originalMessage: message });
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

  private destroyPtySession(sessionId: string, entry: PtySessionEntry, reason: string): void {
    const boundClientId = entry.clientId;
    void entry.session.close().catch(() => undefined);
    if (entry.fileProxy) {
      this.fileProxies.delete(sessionId);
      void entry.fileProxy.shutdown().catch(() => undefined);
    }
    this.ptySessions.delete(sessionId);
    if (boundClientId) {
      this.clients.unbindSession(boundClientId, sessionId);
    }
    this.stats.onSessionEnded();
    log.info("PTY Session 已销毁", { sessionId, clientId: boundClientId, reason });
  }

  private async handleInjectedPreToolUseRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      this.sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    const sessionId = this.getQueryParam(req.url, "sessionId");
    if (!sessionId) {
      this.sendJson(res, 400, { error: "missing_session_id" });
      return;
    }

    const token = req.headers["x-cerelay-hook-token"];
    const ptyEntry = this.ptySessions.get(sessionId);
    if (!ptyEntry?.hookToken) {
      this.sendJson(res, 404, { error: "session_not_found" });
      return;
    }

    if (token !== ptyEntry.hookToken) {
      this.sendJson(res, 403, { error: "forbidden" });
      return;
    }

    let body: string;
    try {
      body = await this.readRequestBody(req);
    } catch (error) {
      log.warn("读取内部 hook bridge 请求体失败", {
        sessionId,
        error: asError(error).message,
      });
      this.sendJson(res, 400, { error: "invalid_body" });
      return;
    }

    try {
      const payload = JSON.parse(body) as HookInput;
      if (typeof payload.tool_name !== "string") {
        throw new Error("missing tool_name");
      }

      log.info("收到内部 PreToolUse hook bridge 请求", {
        sessionId,
        toolName: payload.tool_name,
        toolUseId: payload.tool_use_id,
        inputSummary: summarizeUnknown(payload.tool_input),
        from: "pty-session",
      });

      const result = await ptyEntry.session.handleInjectedPreToolUse(payload);
      this.sendJson(res, 200, result.hookSpecificOutput ?? result);
    } catch (error) {
      log.warn("处理内部 PreToolUse hook bridge 失败", {
        sessionId,
        error: asError(error).message,
      });
      this.sendJson(res, 500, {
        decision: "block",
        reason: `Tool hook bridge failed: ${asError(error).message}`,
      });
    }
  }

  private getQueryParam(requestUrl: string | undefined, name: string): string | null {
    if (!requestUrl) {
      return null;
    }

    try {
      return new URL(requestUrl, "http://localhost").searchParams.get(name);
    } catch {
      return null;
    }
  }

  private readRequestBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  }

}

async function verifyPtyHookVisibleInRuntime(
  runtime: import("./claude-session-runtime.js").ClaudeSessionRuntime,
  cwd: string
): Promise<void> {
  if (process.platform !== "linux" || process.env.CERELAY_ENABLE_MOUNT_NAMESPACE !== "true") {
    return;
  }

  const spawnInRuntime = runtime.spawnInRuntime;
  if (!spawnInRuntime) {
    throw new Error("session runtime does not support preflight verification");
  }

  const abortController = new AbortController();
  const child = spawnInRuntime({
    command: "/bin/sh",
    args: [
      "-lc",
      [
        'if [ -f ".claude/settings.local.json" ]; then',
        '  echo "__CERELAY_HOOK_OK__";',
        "else",
        '  echo "__CERELAY_HOOK_MISSING__";',
        '  pwd;',
        '  ls -la;',
        '  if [ -d ".claude" ]; then ls -la .claude; else echo "__CERELAY_NO_DOT_CLAUDE_DIR__"; fi;',
        "fi",
      ].join(" "),
    ],
    cwd,
    env: runtime.env,
    signal: abortController.signal,
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutChunks.push(Buffer.from(chunk));
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(Buffer.from(chunk));
  });

  const [exitCode] = await once(child, "exit");
  abortController.abort();

  const stdoutText = Buffer.concat(stdoutChunks).toString("utf8").trim();
  const stderrText = Buffer.concat(stderrChunks).toString("utf8").trim();
  if (exitCode === 0 && stdoutText.includes("__CERELAY_HOOK_OK__")) {
    log.info("PTY session hook 配置已出现在 Claude 项目目录", {
      runtimeCwd: cwd,
      runtimeRoot: runtime.rootDir,
    });
    return;
  }

  throw new Error(
    [
      "Claude 项目级 hook 配置未出现在 session runtime 中",
      `cwd=${cwd}`,
      `runtimeRoot=${runtime.rootDir}`,
      stdoutText ? `stdout=${stdoutText}` : "",
      stderrText ? `stderr=${stderrText}` : "",
    ]
      .filter(Boolean)
      .join(" | ")
  );
}

interface PtySessionEntry {
  session: ClaudePtySession;
  clientId: string | null;
  hookToken: string;
  fileProxy?: FileProxyManager;
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
