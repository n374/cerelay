import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

interface RunRequest {
  prompt: string;
  cwd: string;
  deviceLabel?: string;     // 仅日志用
  extraArgs?: string[];
  timeoutMs?: number;
}

interface RunResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
  sessionId: string;        // 由 agent 生成（client 内部 sessionId 由 server 端分配，agent 仅给一个 trace id）
  durationMs: number;
}

const CLIENT_BIN = process.env.CLIENT_BIN || "/app/client/dist/index.js";
const SERVER_URL = process.env.SERVER_URL || "ws://server:8765/ws";

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function runClient(req: RunRequest): Promise<RunResponse> {
  const traceId = randomUUID();
  const startedAt = Date.now();
  const args = [
    CLIENT_BIN,
    "--server", SERVER_URL,
    "--cwd", req.cwd,
    "--prompt", req.prompt,
    ...(req.extraArgs ?? []),
  ];

  return await new Promise<RunResponse>((resolve, reject) => {
    const child = spawn("node", args, {
      env: {
        ...process.env,
        CERELAY_E2E_TRACE_ID: traceId,
        CERELAY_E2E_DEVICE_LABEL: req.deviceLabel || "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on("data", (c) => stdoutChunks.push(Buffer.from(c)));
    child.stderr?.on("data", (c) => stderrChunks.push(Buffer.from(c)));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`client timeout after ${req.timeoutMs ?? 60_000}ms`));
    }, req.timeoutMs ?? 60_000);

    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        sessionId: traceId,
        durationMs: Date.now() - startedAt,
      });
    });

    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const server = createServer(async (req, res) => {
  try {
    if (req.url === "/healthz" && req.method === "GET") {
      return sendJson(res, 200, { ok: true });
    }
    if (req.url === "/run" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) as RunRequest;
      if (!body.prompt || !body.cwd) {
        return sendJson(res, 400, { error: "prompt + cwd required" });
      }
      try {
        const result = await runClient(body);
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 500, { error: String(err) });
      }
    }
    sendJson(res, 404, { error: "not found", url: req.url });
  } catch (err) {
    sendJson(res, 500, { error: String(err) });
  }
});

const port = Number.parseInt(process.env.PORT || "9100", 10);
server.listen(port, () => {
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr !== null ? addr.port : port;
  // eslint-disable-next-line no-console
  console.log(`[client-agent] listening on :${actualPort} → ${SERVER_URL} (bin=${CLIENT_BIN})`);
});
