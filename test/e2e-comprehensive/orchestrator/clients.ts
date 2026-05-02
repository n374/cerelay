export interface RunRequest {
  prompt: string;
  cwd: string;
  deviceLabel?: string;
  extraArgs?: string[];
  timeoutMs?: number;
  // 在 spawn client 前往 $HOME/<rel> 写入 fixture（agent 端落地）；
  // run 结束后默认 best-effort 删除（不动目录）。详见 agent/index.ts。
  homeFixture?: Record<string, string>;
  homeFixtureKeepAfter?: boolean;
  // 批量生成 fixture（用于 C1/C2 1k+ 文件 initial sync 压测）。
  homeFixtureBulk?: {
    pathPrefix: string;
    count: number;
    bytesPerFile: number;
  };
}

export interface RunResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
  sessionId: string;
  durationMs: number;
  /** 容器持久化的 device-id；orchestrator 用它访问 server 的 /admin/cache。 */
  deviceId: string;
}

const HOSTS: Record<string, string> = {
  "client-a": process.env.CLIENT_A_URL || "http://client-a:9100",
  "client-b": process.env.CLIENT_B_URL || "http://client-b:9100",
};

export const clients = {
  hosts: () => Object.keys(HOSTS),

  async run(label: string, req: RunRequest): Promise<RunResponse> {
    const base = HOSTS[label];
    if (!base) throw new Error(`unknown client label: ${label}`);
    const r = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceLabel: label, ...req }),
    });
    if (!r.ok) throw new Error(`client ${label} /run → ${r.status}: ${await r.text()}`);
    return await r.json() as RunResponse;
  },

  async healthz(label: string): Promise<boolean> {
    const base = HOSTS[label];
    try {
      const r = await fetch(`${base}/healthz`);
      return r.ok;
    } catch {
      return false;
    }
  },

  async deviceId(label: string): Promise<string> {
    const base = HOSTS[label];
    if (!base) throw new Error(`unknown client label: ${label}`);
    const r = await fetch(`${base}/device`);
    if (!r.ok) throw new Error(`client ${label} /device → ${r.status}`);
    const body = await r.json() as { deviceId: string };
    return body.deviceId;
  },

  /** meta-deviceid-collision 测试用：覆盖 / 恢复持久化 device-id 文件。 */
  async setForcedDeviceId(label: string, opts: { forceDeviceId: string } | { reset: true }): Promise<void> {
    const base = HOSTS[label];
    if (!base) throw new Error(`unknown client label: ${label}`);
    const r = await fetch(`${base}/admin/toggles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts),
    });
    if (!r.ok) throw new Error(`client ${label} /admin/toggles → ${r.status}: ${await r.text()}`);
  },

  // ========================================================
  // INF-3: async run wrappers
  // ========================================================
  // sync `clients.run` 保持原 schema 不变（P0/P1-A 18 case 完全不感知 async）。
  // async wrapper 给 C3/F2/F4/G2 case 用：起 child 后立刻返回 runId,后续按
  // status / kill / wait 操作。
  // ========================================================

  /** INF-3: 起 client child 但不等 exit;返回 runId。 */
  async runAsync(label: string, req: RunRequest): Promise<{ runId: string }> {
    const base = HOSTS[label];
    if (!base) throw new Error(`unknown client label: ${label}`);
    const r = await fetch(`${base}/run-async`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceLabel: label, ...req }),
    });
    if (!r.ok) throw new Error(`client ${label} /run-async → ${r.status}: ${await r.text()}`);
    return await r.json() as { runId: string };
  },

  /** INF-3: 查 async run 当前状态。404 = unknown runId。 */
  async runStatus(label: string, runId: string): Promise<RunStatusResponse> {
    const base = HOSTS[label];
    if (!base) throw new Error(`unknown client label: ${label}`);
    const r = await fetch(`${base}/admin/run/${encodeURIComponent(runId)}/status`);
    if (!r.ok) throw new Error(`client ${label} /admin/run/${runId}/status → ${r.status}: ${await r.text()}`);
    return await r.json() as RunStatusResponse;
  },

  /** INF-3: SIGKILL async run。alreadyDone=true 表示 child 已 exit,kill 是 no-op。 */
  async killRun(label: string, runId: string): Promise<{ ok: boolean; alreadyDone?: boolean; state: string }> {
    const base = HOSTS[label];
    if (!base) throw new Error(`unknown client label: ${label}`);
    const r = await fetch(`${base}/admin/run/${encodeURIComponent(runId)}/kill`, { method: "POST" });
    if (!r.ok) throw new Error(`client ${label} /admin/run/${runId}/kill → ${r.status}: ${await r.text()}`);
    return await r.json() as { ok: boolean; alreadyDone?: boolean; state: string };
  },

  /** INF-3: 长 poll 等 async run exit/kill;504 = wait timeout 抛 Error。 */
  async waitRun(label: string, runId: string, timeoutMs = 60_000): Promise<RunStatusResponse> {
    const base = HOSTS[label];
    if (!base) throw new Error(`unknown client label: ${label}`);
    const r = await fetch(`${base}/admin/run/${encodeURIComponent(runId)}/wait`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timeoutMs }),
    });
    if (r.status === 504) throw new Error(`client ${label} /admin/run/${runId}/wait timeout (${timeoutMs}ms)`);
    if (!r.ok) throw new Error(`client ${label} /admin/run/${runId}/wait → ${r.status}: ${await r.text()}`);
    return await r.json() as RunStatusResponse;
  },

  /**
   * INF-4: 在 child 仍在 run 时往 $HOME 写 fixture（C3-runtime-delta 用：
   * 触发 cache-watcher 推 delta → server 端 cache 更新内容）。
   * **不**触发任何 cleanup,调用方负责后续清理或覆盖。
   */
  async mutateHomeFixture(label: string, files: Record<string, string>): Promise<{ ok: boolean; written: string[] }> {
    const base = HOSTS[label];
    if (!base) throw new Error(`unknown client label: ${label}`);
    const r = await fetch(`${base}/admin/mutate-home-fixture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files }),
    });
    if (!r.ok) throw new Error(`client ${label} /admin/mutate-home-fixture → ${r.status}: ${await r.text()}`);
    return await r.json() as { ok: boolean; written: string[] };
  },
};

export interface RunStatusResponse {
  runId: string;
  state: "running" | "exited" | "killed";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  deviceId: string;
  durationMs: number | null;
  startedAt: number;
}
