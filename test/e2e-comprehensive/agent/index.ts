import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";

interface RunRequest {
  prompt: string;
  cwd: string;
  deviceLabel?: string;     // 仅日志用
  extraArgs?: string[];
  timeoutMs?: number;
  // 在 spawn client 前往 $HOME/<rel> 写入 fixture，run 结束后默认 best-effort 清理。
  // 用于 B1（~/.claude/<file>）/ B2（~/.claude.json）/ E1（settings.json 含 secret）。
  homeFixture?: Record<string, string>;
  // 默认 false：run 结束后删除 homeFixture 中列出的文件（不动目录）。设为 true 则保留。
  homeFixtureKeepAfter?: boolean;
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

const HOME_DIR = process.env.HOME || "/home/clientuser";

async function applyHomeFixture(files: Record<string, string>): Promise<string[]> {
  const written: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    // 拒绝绝对路径或上跳：fixture 必须落在 $HOME 内
    if (rel.startsWith("/") || rel.split("/").some((seg) => seg === "..")) {
      throw new Error(`homeFixture rel must be inside $HOME: ${rel}`);
    }
    const abs = path.join(HOME_DIR, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    written.push(abs);
  }
  return written;
}

async function cleanupHomeFixture(absPaths: string[]): Promise<void> {
  // 特例：~/.claude.json 不删除——CC 启动期会 parse 它，缺文件直接退出 1。
  // 容器 entrypoint 只在启动时写 "{}"，运行时再 rm 会让下个 case 的 CC 启动失败。
  // 因此 cleanup 时把 .claude.json 重置为空对象保持下一 case 可启动。
  const claudeJsonAbs = path.join(HOME_DIR, ".claude.json");
  for (const p of absPaths) {
    try {
      if (p === claudeJsonAbs) {
        await writeFile(p, "{}", "utf8");
      } else {
        await rm(p, { force: true });
      }
    } catch { /* best-effort */ }
  }
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

  const homeFixtureWritten = req.homeFixture
    ? await applyHomeFixture(req.homeFixture)
    : [];

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

    child.once("exit", async (code) => {
      clearTimeout(timer);
      if (!req.homeFixtureKeepAfter) {
        await cleanupHomeFixture(homeFixtureWritten);
      }
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        sessionId: traceId,
        durationMs: Date.now() - startedAt,
      });
    });

    child.once("error", async (err) => {
      clearTimeout(timer);
      if (!req.homeFixtureKeepAfter) {
        await cleanupHomeFixture(homeFixtureWritten);
      }
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
