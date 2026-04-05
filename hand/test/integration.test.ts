import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket, { WebSocketServer } from "ws";

const HAND_WORKDIR = "/Users/n374/Documents/Code/axon/hand";

test("CLI mode can create session, execute remote Write tool, and exit cleanly", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "axon-hand-cli-"));
  const brain = await startFakeBrain();
  let sawToolResult = false;

  brain.ws.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "connected" }));

    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;

      if (msg.type === "create_session") {
        socket.send(JSON.stringify({ type: "session_created", sessionId: "sess-cli" }));
        return;
      }

      if (msg.type === "prompt") {
        socket.send(JSON.stringify({
          type: "tool_call",
          sessionId: "sess-cli",
          requestId: "req-write",
          toolName: "Write",
          input: {
            file_path: "created.txt",
            content: "from-cli",
          },
        }));
        return;
      }

      if (msg.type === "tool_result") {
        sawToolResult = true;
        socket.send(JSON.stringify({
          type: "tool_call_complete",
          sessionId: "sess-cli",
          requestId: "req-write",
          toolName: "Write",
        }));
        socket.send(JSON.stringify({
          type: "text_chunk",
          sessionId: "sess-cli",
          text: "done",
        }));
        socket.send(JSON.stringify({
          type: "session_end",
          sessionId: "sess-cli",
          result: "ok",
        }));
      }
    });
  });

  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/index.ts", "--server", `127.0.0.1:${brain.port}`, "--cwd", cwd],
    {
      cwd: HAND_WORKDIR,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitFor(
      () => stdout.includes("你>") || child.exitCode !== null,
      3000,
      "等待 CLI 输入提示"
    );
    assert.equal(
      stdout.includes("你>"),
      true,
      `CLI 未进入输入态，exit=${child.exitCode}, stdout=${JSON.stringify(stdout)}, stderr=${JSON.stringify(stderr)}`
    );
    child.stdin.write("hello\n");
    await waitFor(() => sawToolResult, 3000, "等待 CLI tool_result");
    child.stdin.write("/quit\n");
    child.stdin.end();

    const exitCode = await waitForExit(child, 3000);

    assert.equal(exitCode, 0);
    assert.equal(await fs.readFile(path.join(cwd, "created.txt"), "utf8"), "from-cli");
    assert.match(stdout, /会话结束/);
    assert.match(stdout, /done/);
    assert.equal(stderr.includes("错误:"), false);
  } finally {
    if (child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
      await waitForExit(child, 3000).catch(() => undefined);
    }
    await stopFakeBrain(brain);
  }
});

test("ACP mode returns clean JSON-RPC responses and notifications", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "axon-hand-acp-"));
  const brain = await startFakeBrain();

  brain.ws.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "connected" }));

    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;

      if (msg.type === "create_session") {
        socket.send(JSON.stringify({ type: "session_created", sessionId: "sess-acp" }));
        return;
      }

      if (msg.type === "prompt") {
        socket.send(JSON.stringify({
          type: "text_chunk",
          sessionId: "sess-acp",
          text: "streamed",
        }));
        socket.send(JSON.stringify({
          type: "session_end",
          sessionId: "sess-acp",
          result: "finished",
        }));
      }
    });
  });

  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/index.ts", "--server", `127.0.0.1:${brain.port}`, "--cwd", cwd, "acp"],
    {
      cwd: HAND_WORKDIR,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );

  const stdoutLines: string[] = [];
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdoutLines.push(
      ...chunk
        .toString()
        .split("\n")
        .map((line: string) => line.trim())
        .filter(Boolean)
    );
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "test", version: "1.0.0" },
      },
    }) + "\n");
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd },
    }) + "\n");
    await waitFor(() => stdoutLines.some((line) => line.includes('"id":2')), 3000, "等待 ACP session/new 响应");
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId: "sess-acp", prompt: "hi" },
    }) + "\n");

    await waitFor(() => stdoutLines.some((line) => line.includes('"id":3')), 3000, "等待 ACP prompt 响应");

    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "session/close",
      params: { sessionId: "sess-acp" },
    }) + "\n");
    child.stdin.end();

    await waitForExit(child, 3000);

    const parsed = stdoutLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(parsed.some((entry) => entry.id === 1 && "result" in entry), true);
    assert.equal(parsed.some((entry) => entry.id === 2 && "result" in entry), true);
    assert.equal(parsed.some((entry) => entry.method === "$/textChunk"), true);
    assert.equal(
      parsed.some((entry) => entry.id === 3 && JSON.stringify(entry).includes("finished")),
      true
    );
    assert.equal(stderr.includes("stdout"), false);
  } finally {
    if (child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
      await waitForExit(child, 3000).catch(() => undefined);
    }
    await stopFakeBrain(brain);
  }
});

async function startFakeBrain(): Promise<{
  http: ReturnType<typeof createServer>;
  ws: WebSocketServer;
  port: number;
}> {
  const http = createServer();
  const ws = new WebSocketServer({ server: http });
  http.listen(0);
  await once(http, "listening");
  const port = (http.address() as import("node:net").AddressInfo).port;
  return { http, ws, port };
}

async function stopFakeBrain(brain: {
  http: ReturnType<typeof createServer>;
  ws: WebSocketServer;
}): Promise<void> {
  for (const client of brain.ws.clients) {
    client.close();
  }
  await new Promise<void>((resolve) => brain.ws.close(() => resolve()));
  await new Promise<void>((resolve, reject) => brain.http.close((error) => error ? reject(error) : resolve()));
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`${label} 超时`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("等待子进程退出超时"));
    }, timeoutMs);

    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}
