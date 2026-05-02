export interface RunRequest {
  prompt: string;
  cwd: string;
  deviceLabel?: string;
  extraArgs?: string[];
  timeoutMs?: number;
}

export interface RunResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
  sessionId: string;
  durationMs: number;
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
};
