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

/** 测试用：查 server 端 ClientCacheStore manifest 的统计摘要（仅 P0-B-2 C1/C2）。 */
export const cacheAdmin = {
  async summary(deviceId: string): Promise<CacheManifestSummary> {
    const u = new URL("/admin/cache", BASE);
    u.searchParams.set("deviceId", deviceId);
    const r = await fetch(u, { headers: { authorization: `Bearer ${TOKEN}` } });
    if (!r.ok) throw new Error(`server /admin/cache → ${r.status}: ${await r.text()}`);
    return await r.json() as CacheManifestSummary;
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
