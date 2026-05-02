const BASE = process.env.SERVER_ADMIN_URL || "http://server:8765";
// Note: TokenStore.createFixed enforces a "cerelay_" prefix; default value
// kept consistent with that convention for any standalone-orchestrator dev usage.
const TOKEN = process.env.SERVER_ADMIN_TOKEN || "cerelay_e2e-admin-token";

/**
 * 路径前缀判断：严格按目录分隔符，避免 /proj/a 误匹配 /proj/ab/foo。
 * 只在 path === ancestor 或 path 以 ancestor + "/" 开头时返回 true。
 */
function isUnderDir(path: string, ancestor: string): boolean {
  if (path === ancestor) return true;
  return path.startsWith(ancestor.endsWith("/") ? ancestor : ancestor + "/");
}

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
  // 新增：cross-cwd 隔离断言字段（F4 P2 PR1.1）
  clientCwd?: string;
  clientPath?: string;
  contentSha256?: string;
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
  // 新增：cross-cwd 隔离断言字段（F4 P2 PR1.1）
  clientCwd?: string;
  fusePath?: string;
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
  // 新增：cross-cwd 隔离断言字段（F4 P2 PR1.1）
  clientCwd?: string;
  fusePath?: string;
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
  // 新增：cross-cwd 隔离断言字段（F4 P2 PR1.1）
  clientCwd?: string;
  clientPath?: string;
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

/**
 * F4 P2: ConfigPreloader 启动期预热计划事件，携带 session 上下文与预热路径列表。
 * 用于断言"预热只覆盖当前 session cwd，不泄露跨 session 路径"。
 */
export interface ConfigPreloaderPlanDetail {
  clientCwd: string;
  homeDir: string;
  ancestorDirs: string[];
  prefetchAbsPaths: string[];
}

/**
 * F4 P2: SessionBootstrap 启动计划事件，携带 session 初始化关键路径。
 * 用于断言"每个 session 有独立的 runtimeRoot / mountPoint，彼此不共享"。
 */
export interface SessionBootstrapPlanDetail {
  // sessionId 由 AdminEvent 顶层携带，detail 不重复（避免与顶层冗余 + 类型契约冲突，
  // 与 ConfigPreloaderPlanDetail 同策略——T6 follow-up commit 69f99c4 经验）
  deviceId: string;
  clientCwd: string;
  runtimeRoot: string;
  fileProxyMountPoint: string;
  projectClaudeBindTarget: string;
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
    clientCwd?: string;
    since?: number;
  }): Promise<Array<AdminEvent & { detail: FileProxyReadServedDetail }>> {
    const events = await serverEvents.fetch({ sessionId: opts.sessionId, since: opts.since });
    return events
      .filter((e) => e.kind === "file-proxy.read.served")
      .filter((e) => {
        const d = e.detail as Partial<FileProxyReadServedDetail> | undefined;
        if (d?.root !== opts.root || d?.relPath !== opts.relPath) return false;
        if (opts.clientCwd !== undefined && d?.clientCwd !== opts.clientCwd) return false;
        return true;
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
    clientCwd?: string;
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
    clientCwd?: string;
    since?: number;
  }): Promise<Array<AdminEvent & { detail: FileProxyShadowServedDetail }>> {
    const events = await serverEvents.fetch({ sessionId: opts.sessionId, since: opts.since });
    return events
      .filter((e) => e.kind === "file-proxy.shadow.served")
      .filter((e) => {
        const d = e.detail as Partial<FileProxyShadowServedDetail> | undefined;
        if (d?.root !== opts.root || d?.relPath !== opts.relPath) return false;
        if (opts.clientCwd !== undefined && d?.clientCwd !== opts.clientCwd) return false;
        return true;
      }) as Array<AdminEvent & { detail: FileProxyShadowServedDetail }>;
  },

  /** INF-2 helper：等 file-proxy.shadow.served 出现；超时给 file-proxy.* 全量诊断。 */
  async waitForShadowServed(opts: {
    root: string;
    relPath: string;
    sessionId?: string;
    clientCwd?: string;
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
    clientCwd?: string;
    since?: number;
  }): Promise<Array<AdminEvent & { detail: FileProxyWriteServedDetail }>> {
    const events = await serverEvents.fetch({ sessionId: opts.sessionId, since: opts.since });
    return events
      .filter((e) => e.kind === "file-proxy.write.served")
      .filter((e) => {
        const d = e.detail as Partial<FileProxyWriteServedDetail> | undefined;
        if (d?.root !== opts.root || d?.relPath !== opts.relPath) return false;
        if (opts.clientCwd !== undefined && d?.clientCwd !== opts.clientCwd) return false;
        return true;
      }) as Array<AdminEvent & { detail: FileProxyWriteServedDetail }>;
  },

  /** INF-6 helper：等 file-proxy.write.served 出现。 */
  async waitForWriteServed(opts: {
    root: string;
    relPath: string;
    sessionId?: string;
    clientCwd?: string;
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
    clientCwd?: string;
    since?: number;
  }): Promise<Array<AdminEvent & { detail: FileProxyClientRequestedDetail }>> {
    const events = await serverEvents.fetch({ sessionId: opts.sessionId, since: opts.since });
    return events
      .filter((e) => e.kind === "file-proxy.client.requested")
      .filter((e) => {
        const d = e.detail as Partial<FileProxyClientRequestedDetail> | undefined;
        if (d?.root !== opts.root || d?.relPath !== opts.relPath) return false;
        if (opts.op !== undefined && d?.op !== opts.op) return false;
        if (opts.clientCwd !== undefined && d?.clientCwd !== opts.clientCwd) return false;
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

  /**
   * Negative-assert: 在 timeoutMs 内收集所有 sessionId === sessionId 且
   * isUnderDir(clientPath, foreignCwd) 的 file-proxy.read.served event,
   * 期望 count === 0。isUnderDir 严格按目录分隔符（path === foreignCwd 或
   * path 以 foreignCwd + "/" 开头），避免 /proj/a 误匹配 /proj/ab/foo。
   *
   * 重点: poll-and-collect 模式，不是 absence-of-log——
   * 必须真等够 timeoutMs 收集完才能断言，而不是"没看到就跳过"。
   */
  async assertNoReadServedForCwd(opts: {
    sessionId: string;
    foreignCwd: string;
    since: number;
    timeoutMs?: number;  // 默认 500ms，所有 probe 完成后再调用
  }): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 500;
    const deadline = Date.now() + timeoutMs;
    const collected: AdminEvent[] = [];
    while (Date.now() < deadline) {
      const all = await serverEvents.fetch({ since: opts.since });
      for (const e of all) {
        if (e.kind !== "file-proxy.read.served") continue;
        if (e.sessionId !== opts.sessionId) continue;
        const clientPath = (e.detail as Record<string, unknown> | undefined)?.["clientPath"];
        if (typeof clientPath !== "string") continue;
        if (!isUnderDir(clientPath, opts.foreignCwd)) continue;
        if (collected.find((c) => c.id === e.id)) continue;
        collected.push(e);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (collected.length > 0) {
      throw new Error(
        `assertNoReadServedForCwd FAIL: 在 sessionId=${opts.sessionId} 检测到 ` +
        `${collected.length} 条访问 foreignCwd=${opts.foreignCwd} 的 read.served:\n` +
        collected.map((e) => {
          const d = e.detail as Record<string, unknown> | undefined;
          return `  - ${d?.["clientPath"]} (root=${d?.["root"]})`;
        }).join("\n")
      );
    }
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

/**
 * INF-11: 在指定 sessionId 的 namespace 内 spawn 一条临时 sh 命令。
 *
 * cerelay Plan D 后,namespace 内只剩 CC 自身 SDK 行为;mcp__cerelay__bash 等
 * client-routed 工具跑在 client 本机,不入 namespace。要 honest 触发 namespace
 * 内的 FUSE read/write (B5/B6/D4/E2 case),必须用 server 端 spawnInRuntime
 * 在同一 namespace 起 e2e probe 进程。
 *
 * 用法:
 *   const session = await ptyEvents.waitForSpawnReady({ expectedCwd, since });
 *   const out = await serverExec.run(session.sessionId!, {
 *     command: "/bin/sh", args: ["-c", "cat /home/clientuser/.claude/.credentials.json || true"]
 *   });
 *   assert.match(out.stdout, /marker/);
 */
export interface NamespaceExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export const serverExec = {
  async run(sessionId: string, opts: {
    command: string;
    args?: string[];
    timeoutMs?: number;
    env?: Record<string, string>;
  }): Promise<NamespaceExecResult> {
    const r = await fetch(new URL(`/admin/sessions/${encodeURIComponent(sessionId)}/exec`, BASE), {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(opts),
    });
    if (!r.ok) {
      throw new Error(`server /admin/sessions/${sessionId}/exec → ${r.status}: ${await r.text()}`);
    }
    return await r.json() as NamespaceExecResult;
  },
};

/**
 * INF-5: server 容器内 ${CERELAY_DATA_DIR}/credentials/default/.credentials.json
 * 读写代理。给 D4-credentials-shadow + E2-credentials-rw 用：
 *   - D4: PUT 预置 server 侧 credentials → 验 namespace 内 read shadow 真触达
 *   - E2: namespace 内写后 GET 验 server 侧持久化、bytes 一致
 *   - cleanup: DELETE 防 case 间互相污染
 *
 * 仅 CERELAY_ADMIN_EVENTS=true 时挂载（与 /admin/test-toggles + /admin/cache 同 gate）;
 * 生产返回 404。
 */
export const serverDataDir = {
  async getCredentials(): Promise<{ exists: boolean; path: string; content?: string }> {
    const r = await fetch(new URL("/admin/dataDir/credentials", BASE), {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    if (!r.ok) throw new Error(`server /admin/dataDir/credentials GET → ${r.status}: ${await r.text()}`);
    return await r.json() as { exists: boolean; path: string; content?: string };
  },
  async putCredentials(content: string): Promise<{ ok: boolean; path: string; bytes: number }> {
    const r = await fetch(new URL("/admin/dataDir/credentials", BASE), {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!r.ok) throw new Error(`server /admin/dataDir/credentials PUT → ${r.status}: ${await r.text()}`);
    return await r.json() as { ok: boolean; path: string; bytes: number };
  },
  async deleteCredentials(): Promise<{ ok: boolean; path: string }> {
    const r = await fetch(new URL("/admin/dataDir/credentials", BASE), {
      method: "DELETE",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    if (!r.ok) throw new Error(`server /admin/dataDir/credentials DELETE → ${r.status}: ${await r.text()}`);
    return await r.json() as { ok: boolean; path: string };
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

/**
 * F4 P2: ConfigPreloader 启动期预热计划事件 helper。
 * 用于断言"预热只覆盖当前 session cwd，不泄露跨 session 路径"。
 */
export const configPreloaderEvents = {
  async findPlan(opts: {
    sessionId: string;
    since: number;
  }): Promise<(AdminEvent & { detail: ConfigPreloaderPlanDetail }) | null> {
    const events = await serverEvents.fetch({ sessionId: opts.sessionId, since: opts.since });
    // serverEvents.fetch 已按 sessionId + since 在 server 端过滤，
    // 这里只需匹配 kind；sessionId / since 重复条件保留作为防御性快照。
    const hit = events.find((e) => e.kind === "config-preloader.plan");
    return (hit ?? null) as (AdminEvent & { detail: ConfigPreloaderPlanDetail }) | null;
  },

  async waitForPlan(opts: {
    sessionId: string;
    since: number;
    timeoutMs?: number;
  }): Promise<AdminEvent & { detail: ConfigPreloaderPlanDetail }> {
    const deadline = Date.now() + (opts.timeoutMs ?? 5_000);
    while (Date.now() < deadline) {
      const hit = await this.findPlan(opts);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(
      `waitForPlan(config-preloader.plan, sessionId=${opts.sessionId}) timeout after ${opts.timeoutMs ?? 5_000}ms`
    );
  },
};

/**
 * F4 P2: SessionBootstrap 启动计划事件 helper。
 * 用于断言"每个 session 有独立的 runtimeRoot / mountPoint，彼此不共享"。
 */
export const sessionBootstrapEvents = {
  async findPlan(opts: {
    sessionId: string;
    since: number;
  }): Promise<(AdminEvent & { detail: SessionBootstrapPlanDetail }) | null> {
    const events = await serverEvents.fetch({ sessionId: opts.sessionId, since: opts.since });
    // serverEvents.fetch 已按 sessionId + since 在 server 端过滤，
    // 这里只需匹配 kind；sessionId / since 重复条件保留作为防御性快照。
    const hit = events.find((e) => e.kind === "session.bootstrap.plan");
    return (hit ?? null) as (AdminEvent & { detail: SessionBootstrapPlanDetail }) | null;
  },

  async waitForPlan(opts: {
    sessionId: string;
    since: number;
    timeoutMs?: number;
  }): Promise<AdminEvent & { detail: SessionBootstrapPlanDetail }> {
    const deadline = Date.now() + (opts.timeoutMs ?? 5_000);
    while (Date.now() < deadline) {
      const hit = await this.findPlan(opts);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(
      `waitForPlan(session.bootstrap.plan, sessionId=${opts.sessionId}) timeout after ${opts.timeoutMs ?? 5_000}ms`
    );
  },
};

/**
 * F4 Cross-CWD 综合隔离断言。失败时 dump 完整 fileProxy + config-preloader +
 * session.bootstrap probe 摘要，方便 reviewer 定位串台。
 *
 * 详细约束见 spec §5.3 与 §6 守护意图自查。
 */
export async function assertF4CrossCwdIsolation(opts: {
  sessionA: { sessionId: string };
  sessionB: { sessionId: string };
  cwdA: string;
  cwdB: string;
  since: number;
}): Promise<void> {
  const errors: string[] = [];

  // 拉全量事件（不按 sessionId 过滤，确保两个 session 的事件都在）
  const allEvents = await serverEvents.fetch({ since: opts.since });

  // (a)+(d): A 的 project-claude read.served 必须 clientCwd === cwdA
  const aProjectReads = allEvents.filter((e) =>
    e.kind === "file-proxy.read.served" &&
    e.sessionId === opts.sessionA.sessionId &&
    (e.detail as Partial<FileProxyReadServedDetail> | undefined)?.root === "project-claude"
  );
  for (const e of aProjectReads) {
    const clientCwd = (e.detail as Partial<FileProxyReadServedDetail> | undefined)?.clientCwd;
    if (clientCwd !== opts.cwdA) {
      errors.push(
        `(a/d) sessionA project-claude read.served clientCwd 错位: 期望 ${opts.cwdA}，实际 ${clientCwd}`
      );
    }
  }

  // (a)+(d): B 的 project-claude read.served 必须 clientCwd === cwdB
  const bProjectReads = allEvents.filter((e) =>
    e.kind === "file-proxy.read.served" &&
    e.sessionId === opts.sessionB.sessionId &&
    (e.detail as Partial<FileProxyReadServedDetail> | undefined)?.root === "project-claude"
  );
  for (const e of bProjectReads) {
    const clientCwd = (e.detail as Partial<FileProxyReadServedDetail> | undefined)?.clientCwd;
    if (clientCwd !== opts.cwdB) {
      errors.push(
        `(a/d) sessionB project-claude read.served clientCwd 错位: 期望 ${opts.cwdB}，实际 ${clientCwd}`
      );
    }
  }

  // (c): config-preloader.plan ancestorDirs / prefetchAbsPaths 不串台
  const planA = await configPreloaderEvents.findPlan({
    sessionId: opts.sessionA.sessionId,
    since: opts.since,
  });
  if (!planA) {
    errors.push(`(c) sessionA config-preloader.plan event 缺失`);
  } else {
    const ancestorsA = planA.detail.ancestorDirs;
    const prefetchA = planA.detail.prefetchAbsPaths;
    const ancestorLeak = ancestorsA.filter((p) => isUnderDir(p, opts.cwdB));
    if (ancestorLeak.length > 0) {
      errors.push(`(c) sessionA ancestorDirs 串到 cwdB 子树: ${ancestorLeak.join(", ")}`);
    }
    const prefetchLeak = prefetchA.filter((p) => isUnderDir(p, opts.cwdB));
    if (prefetchLeak.length > 0) {
      errors.push(`(c) sessionA prefetchAbsPaths 串到 cwdB 子树: ${prefetchLeak.join(", ")}`);
    }
  }

  // (c): 对称检查 B
  const planB = await configPreloaderEvents.findPlan({
    sessionId: opts.sessionB.sessionId,
    since: opts.since,
  });
  if (!planB) {
    errors.push(`(c) sessionB config-preloader.plan event 缺失`);
  } else {
    const ancestorsB = planB.detail.ancestorDirs;
    const prefetchB = planB.detail.prefetchAbsPaths;
    const ancestorLeak = ancestorsB.filter((p) => isUnderDir(p, opts.cwdA));
    if (ancestorLeak.length > 0) {
      errors.push(`(c) sessionB ancestorDirs 串到 cwdA 子树: ${ancestorLeak.join(", ")}`);
    }
    const prefetchLeak = prefetchB.filter((p) => isUnderDir(p, opts.cwdA));
    if (prefetchLeak.length > 0) {
      errors.push(`(c) sessionB prefetchAbsPaths 串到 cwdA 子树: ${prefetchLeak.join(", ")}`);
    }
  }

  // (d): session.bootstrap.plan projectClaudeBindTarget 严格按 cwd
  const bootA = await sessionBootstrapEvents.findPlan({
    sessionId: opts.sessionA.sessionId,
    since: opts.since,
  });
  if (!bootA) {
    errors.push(`(d) sessionA session.bootstrap.plan event 缺失`);
  } else if (bootA.detail.projectClaudeBindTarget !== `${opts.cwdA}/.claude`) {
    errors.push(
      `(d) sessionA projectClaudeBindTarget 错位: 期望 ${opts.cwdA}/.claude，实际 ${bootA.detail.projectClaudeBindTarget}`
    );
  }

  const bootB = await sessionBootstrapEvents.findPlan({
    sessionId: opts.sessionB.sessionId,
    since: opts.since,
  });
  if (!bootB) {
    errors.push(`(d) sessionB session.bootstrap.plan event 缺失`);
  } else if (bootB.detail.projectClaudeBindTarget !== `${opts.cwdB}/.claude`) {
    errors.push(
      `(d) sessionB projectClaudeBindTarget 错位: 期望 ${opts.cwdB}/.claude，实际 ${bootB.detail.projectClaudeBindTarget}`
    );
  }

  if (errors.length > 0) {
    throw new Error(`assertF4CrossCwdIsolation FAIL:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }
}
