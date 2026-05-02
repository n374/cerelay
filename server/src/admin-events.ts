// ============================================================
// 测试用结构化事件 ring buffer。
// 仅当 process.env.CERELAY_ADMIN_EVENTS === "true" 时启用 record；
// 关闭时 record/fetch 都是 no-op，零开销。
// 通过 server.ts 注册到 /admin/events?sessionId=&since=
// ============================================================

export interface AdminEvent {
  /** 单调递增 id，从 1 开始；orchestrator 用 since=<id> 增量拉取 */
  id: number;
  ts: string;       // ISO
  sessionId: string | null;
  kind: string;     // 例如 "namespace.bootstrap.ready" / "tool.relay.completed"
  detail?: Record<string, unknown>;
}

const MAX_BUFFER = 10_000;

export class AdminEventBuffer {
  private buf: AdminEvent[] = [];
  private nextId = 1;

  constructor(private readonly enabled: boolean) {}

  record(kind: string, sessionId: string | null, detail?: Record<string, unknown>): void {
    if (!this.enabled) return;
    const ev: AdminEvent = {
      id: this.nextId++,
      ts: new Date().toISOString(),
      sessionId,
      kind,
      detail,
    };
    this.buf.push(ev);
    if (this.buf.length > MAX_BUFFER) {
      this.buf.splice(0, this.buf.length - MAX_BUFFER);
    }
  }

  fetch(opts: { sessionId?: string; since?: number }): AdminEvent[] {
    if (!this.enabled) return [];
    return this.buf.filter((e) => {
      if (opts.sessionId && e.sessionId !== opts.sessionId) return false;
      if (opts.since !== undefined && e.id <= opts.since) return false;
      return true;
    });
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

export function createAdminEventBuffer(): AdminEventBuffer {
  return new AdminEventBuffer(process.env.CERELAY_ADMIN_EVENTS === "true");
}
