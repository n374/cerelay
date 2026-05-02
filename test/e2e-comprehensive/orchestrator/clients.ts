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
};
