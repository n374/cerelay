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

/** P0-B-4 meta-test 用：toggle server-side process-global flags（disableRedact / injectIfsBug）。 */
export const testToggles = {
  async set(toggles: { disableRedact?: boolean; injectIfsBug?: boolean }): Promise<void> {
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
