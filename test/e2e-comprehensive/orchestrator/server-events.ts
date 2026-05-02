const BASE = process.env.SERVER_ADMIN_URL || "http://server:8765";
// Note: TokenStore.createFixed enforces a "cerelay_" prefix; default value
// kept consistent with that convention for any standalone-orchestrator dev usage.
const TOKEN = process.env.SERVER_ADMIN_TOKEN || "cerelay_e2e-admin-token";

export interface AdminEvent {
  id: number;
  ts: string;
  sessionId: string | null;
  kind: string;
  detail?: Record<string, unknown>;
}

export const serverEvents = {
  async fetch(opts: { sessionId?: string; since?: number } = {}): Promise<AdminEvent[]> {
    const u = new URL("/admin/events", BASE);
    if (opts.sessionId) u.searchParams.set("sessionId", opts.sessionId);
    if (opts.since !== undefined) u.searchParams.set("since", String(opts.since));
    const r = await fetch(u, { headers: { authorization: `Bearer ${TOKEN}` } });
    if (!r.ok) throw new Error(`server /admin/events → ${r.status}: ${await r.text()}`);
    const body = await r.json() as { enabled: boolean; events: AdminEvent[] };
    if (!body.enabled) throw new Error("CERELAY_ADMIN_EVENTS=false on server, e2e cannot run");
    return body.events;
  },

  async waitForKind(opts: { sessionId?: string; kind: string; timeoutMs?: number }): Promise<AdminEvent> {
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
    let since = 0;
    while (Date.now() < deadline) {
      const events = await this.fetch({ sessionId: opts.sessionId, since });
      const hit = events.find((e) => e.kind === opts.kind);
      if (hit) return hit;
      since = events.at(-1)?.id ?? since;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`waitForKind(${opts.kind}) timeout after ${opts.timeoutMs ?? 30_000}ms`);
  },
};

export interface CacheManifestSummary {
  deviceId: string;
  revision: number;
  scopes: Record<string, {
    entryCount: number;
    totalBytes: number;
    truncated: boolean;
    skippedCount: number;
  }>;
}

export interface CacheEntrySummary {
  deviceId: string;
  scope: string;
  relPath: string;
  size: number;
  sha256: string | null;
  skipped: boolean;
  mtime: number;
}

/** 测试用：查 server 端 ClientCacheStore manifest 的统计摘要（C1/C2/C3/F3）。 */
export const cacheAdmin = {
  async summary(deviceId: string): Promise<CacheManifestSummary> {
    const u = new URL("/admin/cache", BASE);
    u.searchParams.set("deviceId", deviceId);
    const r = await fetch(u, { headers: { authorization: `Bearer ${TOKEN}` } });
    if (!r.ok) throw new Error(`server /admin/cache → ${r.status}: ${await r.text()}`);
    return await r.json() as CacheManifestSummary;
  },
  /**
   * C3 / F3 / meta-collision: 按 (deviceId, scope, relPath) 查单项 entry 摘要。
   * - 命中返回 { size, sha256, ... }
   * - 未命中返回 null（HTTP 404）——区分"互查不到对方"与"取到对方 hash"两种 collision 失败模式
   */
  async lookupEntry(opts: {
    deviceId: string;
    scope: "claude-home" | "claude-json";
    relPath: string;
  }): Promise<CacheEntrySummary | null> {
    const u = new URL("/admin/cache", BASE);
    u.searchParams.set("deviceId", opts.deviceId);
    u.searchParams.set("scope", opts.scope);
    u.searchParams.set("relPath", opts.relPath);
    const r = await fetch(u, { headers: { authorization: `Bearer ${TOKEN}` } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`server /admin/cache lookup → ${r.status}: ${await r.text()}`);
    return await r.json() as CacheEntrySummary;
  },
};

/**
 * C1 file-proxy admin event 检索工具。
 * 用于 B1/B2/B3 主断言：服务端 FUSE 链路真把目标 (root, relPath) 的内容
 * 灌进 daemon snapshot 或运行时命中 cache。
 */
export interface FileProxyReadServedDetail {
  root: string;       // home-claude | home-claude-json | project-claude | cwd-ancestor-N
  relPath: string;
  servedFrom: "snapshot-cache" | "snapshot-client" | "cache" | "passthrough-settings";
  hasData?: boolean;
  size?: number;
  sliceBytes?: number;
}

/**
 * INF-2: shadow file 的 daemon 内部本地 read 事件。
 * shadow file (settings.local.json / credentials/.credentials.json) 由
 * daemon 直接读本地真实文件，不经过 server FUSE handling，read.served
 * 4 个出口都看不到——必须用本 event 才能 honest 断言"shadow 注入端到端可达"。
 */
export interface FileProxyShadowServedDetail {
  op: string;        // 当前只有 "read"；INF-6 用 file-proxy.write.served
  root: string;      // home-claude / project-claude / ...
  relPath: string;
  shadowPath: string;
  bytes: number;
  offset: number;
  size: number;
}

/**
 * INF-6: shadow file write 事件（与 INF-2 同 sideband 通道）。
 */
export interface FileProxyWriteServedDetail {
  op: string;        // "write"
  root: string;
  relPath: string;
  servedTo: string;  // 实际落到的 server 侧绝对路径（shadow 模式下为本地真实文件）
  bytes: number;
  offset: number;
  shadow: boolean;   // true = 经 daemon shadow 写本地；false 预留给未来 server 端 write 出口
}

/**
 * INF-1: 每次 server 真要回 client 拿一次 round-trip 时 emit。
 * 与 perforatedPaths 不同：admin event 每次穿透都 emit（perforatedPaths 只记首次）。
 * B5-negative-cache 用此 event 精确判断"两次 read 同 path 是否都穿透"。
 */
export interface FileProxyClientRequestedDetail {
  op: string;
  root: string;
  relPath: string;
  reason: string;
  perforationCount: number;
}

/**
 * INF-1: 穿透 client 后 client 报 ENOENT → 进入 negative cache 入口。
 * 之后同 path 在 daemon 本地 _negative_perm 命中，不再回 server，更不再回 client。
 */
export interface FileProxyClientMissDetail {
  op: string;
  root: string;
  relPath: string;
  errorCode: number;  // 应当是 2 (ENOENT)
}

export const fileProxyEvents = {
  /**
   * 拉 file-proxy.read.served events，按 root + relPath 过滤。
   * since 用于隔离当前 case 之前已有的事件（推荐每个 case 启动前先 fetch baseline）。
   */
  async findReadServed(opts: {
    root: string;
    relPath: string;
    sessionId?: string;
    since?: number;
  }): Promise<Array<AdminEvent & { detail: FileProxyReadServedDetail }>> {
    const events = await serverEvents.fetch({ sessionId: opts.sessionId, since: opts.since });
    return events
      .filter((e) => e.kind === "file-proxy.read.served")
      .filter((e) => {
        const d = e.detail as Partial<FileProxyReadServedDetail> | undefined;
        return d?.root === opts.root && d?.relPath === opts.relPath;
      }) as Array<AdminEvent & { detail: FileProxyReadServedDetail }>;
  },

  /**
   * 等待至少一条匹配 (root, relPath) 的 file-proxy.read.served event 出现。
   * 用于主断言：超时则 throw，提供完整诊断（已抓到的 events 摘要 + 实际拉到的 root/relPath）。
   */
  async waitForReadServed(opts: {
    root: string;
    relPath: string;
    sessionId?: string;
    since?: number;
    timeoutMs?: number;
  }): Promise<AdminEvent & { detail: FileProxyReadServedDetail }> {
    const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
    let lastSnapshot: AdminEvent[] = [];
    while (Date.now() < deadline) {
      const matched = await this.findReadServed(opts);
      if (matched.length > 0) return matched[0];
      lastSnapshot = await serverEvents.fetch({ sessionId: opts.sessionId, since: opts.since });
      await new Promise((r) => setTimeout(r, 200));
    }
    const proxyEvents = lastSnapshot
      .filter((e) => e.kind.startsWith("file-proxy."))
      .map((e) => ({
        kind: e.kind,
        root: (e.detail as { root?: string } | undefined)?.root,
        relPath: (e.detail as { relPath?: string } | undefined)?.relPath,
        servedFrom: (e.detail as { servedFrom?: string } | undefined)?.servedFrom,
      }));
    throw new Error(
      `waitForReadServed(root=${opts.root}, relPath=${opts.relPath}) timeout after ${opts.timeoutMs ?? 10_000}ms\n` +
        `已抓到的 file-proxy.* events:\n${JSON.stringify(proxyEvents, null, 2)}`,
    );
  },

  /** INF-2 helper：findShadowServed — daemon 内部 shadow read 事件按 (root, relPath) 过滤。 */
  async findShadowServed(opts: {
    root: string;
    relPath: string;
    sessionId?: string;
    since?: number;
  }): Promise<Array<AdminEvent & { detail: FileProxyShadowServedDetail }>> {
    const events = await serverEvents.fetch({ sessionId: opts.sessionId, since: opts.since });
    return events
      .filter((e) => e.kind === "file-proxy.shadow.served")
      .filter((e) => {
        const d = e.detail as Partial<FileProxyShadowServedDetail> | undefined;
        return d?.root === opts.root && d?.relPath === opts.relPath;
      }) as Array<AdminEvent & { detail: FileProxyShadowServedDetail }>;
  },

  /** INF-2 helper：等 file-proxy.shadow.served 出现；超时给 file-proxy.* 全量诊断。 */
  async waitForShadowServed(opts: {
    root: string;
    relPath: string;
    sessionId?: string;
    since?: number;
    timeoutMs?: number;
  }): Promise<AdminEvent & { detail: FileProxyShadowServedDetail }> {
    const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
    let lastSnapshot: AdminEvent[] = [];
    while (Date.now() < deadline) {
      const matched = await this.findShadowServed(opts);
      if (matched.length > 0) return matched[0];
      lastSnapshot = await serverEvents.fetch({ sessionId: opts.sessionId, since: opts.since });
      await new Promise((r) => setTimeout(r, 200));
    }
    const proxyEvents = lastSnapshot
      .filter((e) => e.kind.startsWith("file-proxy."))
      .map((e) => ({
        kind: e.kind,
        root: (e.detail as { root?: string } | undefined)?.root,
        relPath: (e.detail as { relPath?: string } | undefined)?.relPath,
      }));
    throw new Error(
      `waitForShadowServed(root=${opts.root}, relPath=${opts.relPath}) timeout after ${opts.timeoutMs ?? 10_000}ms\n` +
        `已抓到的 file-proxy.* events:\n${JSON.stringify(proxyEvents, null, 2)}`,
    );
  },

  /** INF-6 helper：findWriteServed — daemon 内部 shadow write 事件按 (root, relPath) 过滤。 */
  async findWriteServed(opts: {
    root: string;
    relPath: string;
    sessionId?: string;
    since?: number;
  }): Promise<Array<AdminEvent & { detail: FileProxyWriteServedDetail }>> {
    const events = await serverEvents.fetch({ sessionId: opts.sessionId, since: opts.since });
    return events
      .filter((e) => e.kind === "file-proxy.write.served")
      .filter((e) => {
        const d = e.detail as Partial<FileProxyWriteServedDetail> | undefined;
        return d?.root === opts.root && d?.relPath === opts.relPath;
      }) as Array<AdminEvent & { detail: FileProxyWriteServedDetail }>;
  },

  /** INF-6 helper：等 file-proxy.write.served 出现。 */
  async waitForWriteServed(opts: {
    root: string;
    relPath: string;
    sessionId?: string;
    since?: number;
    timeoutMs?: number;
  }): Promise<AdminEvent & { detail: FileProxyWriteServedDetail }> {
    const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
    let lastSnapshot: AdminEvent[] = [];
    while (Date.now() < deadline) {
      const matched = await this.findWriteServed(opts);
      if (matched.length > 0) return matched[0];
      lastSnapshot = await serverEvents.fetch({ sessionId: opts.sessionId, since: opts.since });
      await new Promise((r) => setTimeout(r, 200));
    }
    const proxyEvents = lastSnapshot
      .filter((e) => e.kind.startsWith("file-proxy."))
      .map((e) => ({
        kind: e.kind,
        root: (e.detail as { root?: string } | undefined)?.root,
        relPath: (e.detail as { relPath?: string } | undefined)?.relPath,
      }));
    throw new Error(
      `waitForWriteServed(root=${opts.root}, relPath=${opts.relPath}) timeout after ${opts.timeoutMs ?? 10_000}ms\n` +
        `已抓到的 file-proxy.* events:\n${JSON.stringify(proxyEvents, null, 2)}`,
    );
  },

  /**
   * INF-1 helper：findClientRequested — 每次穿透 client 都 emit 的事件。
   * 与 read.served 不同：本事件 = "server 决定要回 client 拿"；read.served = "server 提供了内容"。
   * B5-negative-cache 用法：first read 应有 1 条 client.requested + 1 条 client.miss；
   * second read 应有 0 条 client.requested（被 daemon negative cache 拦在 server 之外）。
   */
  async findClientRequested(opts: {
    root: string;
    relPath: string;
    op?: string;
    sessionId?: string;
    since?: number;
  }): Promise<Array<AdminEvent & { detail: FileProxyClientRequestedDetail }>> {
    const events = await serverEvents.fetch({ sessionId: opts.sessionId, since: opts.since });
    return events
      .filter((e) => e.kind === "file-proxy.client.requested")
      .filter((e) => {
        const d = e.detail as Partial<FileProxyClientRequestedDetail> | undefined;
        if (d?.root !== opts.root || d?.relPath !== opts.relPath) return false;
        if (opts.op !== undefined && d?.op !== opts.op) return false;
        return true;
      }) as Array<AdminEvent & { detail: FileProxyClientRequestedDetail }>;
  },

  /** INF-1 helper：findClientMiss — 穿透 client 拿到 ENOENT、进 negative cache 时 emit。 */
  async findClientMiss(opts: {
    root: string;
    relPath: string;
    op?: string;
    sessionId?: string;
    since?: number;
  }): Promise<Array<AdminEvent & { detail: FileProxyClientMissDetail }>> {
    const events = await serverEvents.fetch({ sessionId: opts.sessionId, since: opts.since });
    return events
      .filter((e) => e.kind === "file-proxy.client.miss")
      .filter((e) => {
        const d = e.detail as Partial<FileProxyClientMissDetail> | undefined;
        if (d?.root !== opts.root || d?.relPath !== opts.relPath) return false;
        if (opts.op !== undefined && d?.op !== opts.op) return false;
        return true;
      }) as Array<AdminEvent & { detail: FileProxyClientMissDetail }>;
  },
};

/**
 * D1/D2 主断言用：拉 pty.spawn.ready event 的 detail.cwd / detail.homeDir。
 * POSIX spawn 契约保证 detail.cwd === namespace 内 pwd；detail.homeDir === namespace 内 $HOME。
 */
export interface PtySpawnReadyDetail {
  cwd: string;
  homeDir: string;
  pid?: number;
}

export const ptyEvents = {
  async findSpawnReady(opts: {
    expectedCwd: string;
    sessionId?: string;
    since?: number;
  }): Promise<Array<AdminEvent & { detail: PtySpawnReadyDetail }>> {
    const events = await serverEvents.fetch({ sessionId: opts.sessionId, since: opts.since });
    return events
      .filter((e) => e.kind === "pty.spawn.ready")
      .filter((e) => (e.detail as Partial<PtySpawnReadyDetail> | undefined)?.cwd === opts.expectedCwd) as Array<AdminEvent & { detail: PtySpawnReadyDetail }>;
  },
  /**
   * 等待匹配 expectedCwd 的 pty.spawn.ready event。
   * 失败时把诊断信息（同 since 之后所有 pty.* event）打出来。
   */
  async waitForSpawnReady(opts: {
    expectedCwd: string;
    sessionId?: string;
    since?: number;
    timeoutMs?: number;
  }): Promise<AdminEvent & { detail: PtySpawnReadyDetail }> {
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
    let lastSnapshot: AdminEvent[] = [];
    while (Date.now() < deadline) {
      const matched = await this.findSpawnReady(opts);
      if (matched.length > 0) return matched[0];
      lastSnapshot = await serverEvents.fetch({ sessionId: opts.sessionId, since: opts.since });
      await new Promise((r) => setTimeout(r, 200));
    }
    const ptyOnly = lastSnapshot
      .filter((e) => e.kind.startsWith("pty."))
      .map((e) => ({ kind: e.kind, detail: e.detail }));
    throw new Error(
      `waitForSpawnReady(cwd=${opts.expectedCwd}) timeout after ${opts.timeoutMs ?? 30_000}ms\n` +
        `pty.* events: ${JSON.stringify(ptyOnly, null, 2)}`,
    );
  },
};

/**
 * INF-8: tool relay timeout 触发时 emit。G1-tool-timeout case 用此 event 验证
 * timeout 路径真触发(而不只是 reject log)。
 */
export interface ToolTimeoutFiredDetail {
  requestId: string;
  toolName: string;
  timeoutMs: number;
  injected: boolean;   // true = 由 testToggles.injectToolTimeout 注入的短超时
  pendingCount: number;
}

/**
 * INF-8: ws session 断开 / cleanup 时 emit。G2-client-disconnect case 用此
 * event 验证 "断 ws → server 真触发 destroyPtySession + cleanup"。
 */
export interface SessionDisconnectedDetail {
  clientId: string;
  reason: string;       // "client_close" | "server_shutdown" | "pty_exit" | ...
}

export const toolTimeoutEvents = {
  async findFired(opts: {
    sessionId?: string;
    toolName?: string;
    since?: number;
  }): Promise<Array<AdminEvent & { detail: ToolTimeoutFiredDetail }>> {
    const events = await serverEvents.fetch({ sessionId: opts.sessionId, since: opts.since });
    return events
      .filter((e) => e.kind === "tool.timeout.fired")
      .filter((e) => {
        if (opts.toolName === undefined) return true;
        return (e.detail as Partial<ToolTimeoutFiredDetail> | undefined)?.toolName === opts.toolName;
      }) as Array<AdminEvent & { detail: ToolTimeoutFiredDetail }>;
  },
  async waitForFired(opts: {
    sessionId?: string;
    toolName?: string;
    since?: number;
    timeoutMs?: number;
  }): Promise<AdminEvent & { detail: ToolTimeoutFiredDetail }> {
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      const matched = await this.findFired(opts);
      if (matched.length > 0) return matched[0];
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(
      `waitForFired(toolName=${opts.toolName ?? "<any>"}) timeout after ${opts.timeoutMs ?? 30_000}ms`,
    );
  },
};

export const sessionEvents = {
  async findDisconnected(opts: {
    sessionId?: string;
    since?: number;
  }): Promise<Array<AdminEvent & { detail: SessionDisconnectedDetail }>> {
    const events = await serverEvents.fetch({ sessionId: opts.sessionId, since: opts.since });
    return events.filter((e) => e.kind === "session.disconnected") as Array<
      AdminEvent & { detail: SessionDisconnectedDetail }
    >;
  },
  async waitForDisconnected(opts: {
    sessionId?: string;
    since?: number;
    timeoutMs?: number;
  }): Promise<AdminEvent & { detail: SessionDisconnectedDetail }> {
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      const matched = await this.findDisconnected(opts);
      if (matched.length > 0) return matched[0];
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(
      `waitForDisconnected(sessionId=${opts.sessionId ?? "<any>"}) timeout after ${opts.timeoutMs ?? 30_000}ms`,
    );
  },
};

/** P0-B-4 meta-test 用：toggle server-side process-global flags（disableRedact / injectIfsBug）。 */
export const testToggles = {
  async set(toggles: {
    disableRedact?: boolean;
    injectIfsBug?: boolean;
    /** INF-8 fault injection: 强制 tool relay 在 ms 后超时。null = 关闭。 */
    injectToolTimeout?: { ms: number; toolName?: string } | null;
  }): Promise<void> {
    const r = await fetch(new URL("/admin/test-toggles", BASE), {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(toggles),
    });
    if (!r.ok) throw new Error(`server /admin/test-toggles → ${r.status}: ${await r.text()}`);
  },
  async reset(): Promise<void> {
    const r = await fetch(new URL("/admin/test-toggles", BASE), {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ reset: true }),
    });
    if (!r.ok) throw new Error(`server /admin/test-toggles reset → ${r.status}: ${await r.text()}`);
  },
};
