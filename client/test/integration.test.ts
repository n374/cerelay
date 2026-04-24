import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";

const CLIENT_WORKDIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 这批 integration 测试使用 fake brain，不模拟 cache_handshake/cache_push_ack。
// 开启 env var 跳过启动缓存同步，避免 60s 等待超时。真正的 cache sync 路径由
// test/cache-sync.test.ts 独立覆盖。
process.env.CERELAY_DISABLE_INITIAL_CACHE_SYNC = "true";

test("PTY mode executes remote tool calls while terminal passthrough is active", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cerelay-client-pty-"));
  const brain = await startFakeBrain();
  registerBrainCleanup(t, brain);
  let sawToolResult = false;

  brain.ws.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "connected" }));

    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;

      if (msg.type === "create_pty_session") {
        socket.send(JSON.stringify({ type: "pty_session_created", sessionId: "pty-test" }));
        setTimeout(() => {
          socket.send(JSON.stringify({
            type: "tool_call",
            sessionId: "pty-test",
            requestId: "req-write",
            toolName: "Write",
            input: {
              file_path: "pty-created.txt",
              content: "from-pty",
            },
          }));
        }, 20);
        return;
      }

      if (msg.type === "tool_result") {
        sawToolResult = true;
        socket.send(JSON.stringify({
          type: "tool_call_complete",
          sessionId: "pty-test",
          requestId: "req-write",
          toolName: "Write",
        }));
        socket.send(JSON.stringify({
          type: "pty_output",
          sessionId: "pty-test",
          data: Buffer.from("pty done\r\n", "utf8").toString("base64"),
        }));
        socket.send(JSON.stringify({
          type: "pty_exit",
          sessionId: "pty-test",
          exitCode: 0,
        }));
      }
    });
  });

  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/index.ts", "--server", `127.0.0.1:${brain.port}`, "--cwd", cwd],
    {
      cwd: CLIENT_WORKDIR,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  registerChildCleanup(t, child);

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  await waitFor(() => stdout.includes("[PTY 已连接]"), 3000, "等待 PTY 连接提示");
  await waitFor(() => sawToolResult, 3000, "等待 PTY tool_result");
  await waitFor(() => stdout.includes("pty done"), 3000, "等待 PTY output");

  // 验证功能正确性
  assert.equal(await fs.readFile(path.join(cwd, "pty-created.txt"), "utf8"), "from-pty");
  assert.match(stdout, /pty done/);
  assert.equal(stderr.includes("PTY passthrough 失败"), false);
});

test("PTY mode displays output arriving immediately after pty_session_created", async (t) => {
  const brain = await startFakeBrain();
  registerBrainCleanup(t, brain);

  brain.ws.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "connected" }));

    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;

      if (msg.type === "create_pty_session") {
        // 模拟真实场景：pty_session_created 后紧跟 PTY 输出（如 claude CLI 闪屏）
        socket.send(JSON.stringify({ type: "pty_session_created", sessionId: "pty-imm" }));
        socket.send(JSON.stringify({
          type: "pty_output",
          sessionId: "pty-imm",
          data: Buffer.from("claude> welcome\r\n", "utf8").toString("base64"),
        }));
        socket.send(JSON.stringify({
          type: "pty_exit",
          sessionId: "pty-imm",
          exitCode: 0,
        }));
        return;
      }
    });
  });

  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/index.ts", "--server", `127.0.0.1:${brain.port}`],
    {
      cwd: CLIENT_WORKDIR,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  registerChildCleanup(t, child);

  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });

  const exitCode = await waitForExit(child, 3000);
  assert.equal(exitCode, 0);
  assert.match(stdout, /\[PTY 已连接\]/);
  assert.match(stdout, /claude> welcome/);
});

test("PTY mode preserves early pty_output arriving before pty_session_created", async (t) => {
  const brain = await startFakeBrain();
  registerBrainCleanup(t, brain);

  brain.ws.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "connected" }));

    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;

      if (msg.type === "create_pty_session") {
        // 极端边界：pty_output 先于 pty_session_created 到达 Hand
        // （虽然在同一 WebSocket 上不太可能自然发生，但代码必须防御此情况）
        socket.send(JSON.stringify({
          type: "pty_output",
          sessionId: "pty-early",
          data: Buffer.from("early-splash\r\n", "utf8").toString("base64"),
        }));
        socket.send(JSON.stringify({ type: "pty_session_created", sessionId: "pty-early" }));
        socket.send(JSON.stringify({
          type: "pty_output",
          sessionId: "pty-early",
          data: Buffer.from("post-splash\r\n", "utf8").toString("base64"),
        }));
        socket.send(JSON.stringify({
          type: "pty_exit",
          sessionId: "pty-early",
          exitCode: 0,
        }));
        return;
      }
    });
  });

  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/index.ts", "--server", `127.0.0.1:${brain.port}`],
    {
      cwd: CLIENT_WORKDIR,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  registerChildCleanup(t, child);

  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });

  const exitCode = await waitForExit(child, 3000);
  assert.equal(exitCode, 0);
  // 修复前，early-splash 会被 waitForPtySessionReady 的消费器吞掉
  assert.match(stdout, /early-splash/);
  assert.match(stdout, /post-splash/);
});

test("PTY mode rejects when server closes before pty_session_created", async (t) => {
  const brain = await startFakeBrain();
  registerBrainCleanup(t, brain);

  brain.ws.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "connected" }));

    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;

      if (msg.type === "create_pty_session") {
        // 服务器在发送 pty_session_created 之前关闭连接
        setTimeout(() => socket.close(), 20);
        return;
      }
    });
  });

  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/index.ts", "--server", `127.0.0.1:${brain.port}`],
    {
      cwd: CLIENT_WORKDIR,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  registerChildCleanup(t, child);

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const exitCode = await waitForExit(child, 3000);
  assert.notEqual(exitCode, 0);
  assert.match(stderr, /连接已关闭/);
});

// ============================================================
// FUSE 文件代理写操作测试（PTY TUI 渲染依赖此功能）
// ============================================================

test("PTY mode handles file_proxy_request write operations during passthrough", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cerelay-client-fuse-write-"));
  // FileProxyHandler 限制路径必须在 {cwd}/.claude/ 内
  const claudeDir = path.join(cwd, ".claude");
  await fs.mkdir(claudeDir, { recursive: true });
  const brain = await startFakeBrain();
  registerBrainCleanup(t, brain);

  let writeResponseReceived = false;
  let createResponseReceived = false;
  const targetFile = path.join(claudeDir, "sessions", "test-session.json");

  brain.ws.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "connected" }));

    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;

      if (msg.type === "create_pty_session") {
        socket.send(JSON.stringify({ type: "pty_session_created", sessionId: "pty-fuse" }));

        // 模拟 Claude Code 启动时的 FUSE 写操作：
        // 1. create（创建 session 文件 — 路径在 {cwd}/.claude/ 内）
        setTimeout(() => {
          socket.send(JSON.stringify({
            type: "file_proxy_request",
            reqId: "fuse-create-1",
            sessionId: "pty-fuse",
            op: "create",
            path: targetFile,
            mode: 0o644,
            data: Buffer.from('{"id":"test"}').toString("base64"),
          }));
        }, 30);

        // 2. write（覆盖写入）
        setTimeout(() => {
          socket.send(JSON.stringify({
            type: "file_proxy_request",
            reqId: "fuse-write-1",
            sessionId: "pty-fuse",
            op: "write",
            path: targetFile,
            data: Buffer.from('{"id":"updated"}').toString("base64"),
            offset: 0,
          }));
        }, 60);
        return;
      }

      if (msg.type === "file_proxy_response") {
        const resp = msg as Record<string, unknown>;
        if (resp.reqId === "fuse-create-1" && !resp.error) {
          createResponseReceived = true;
        }
        if (resp.reqId === "fuse-write-1" && !resp.error) {
          writeResponseReceived = true;
          // 写操作完成后发送 PTY 输出并退出
          socket.send(JSON.stringify({
            type: "pty_output",
            sessionId: "pty-fuse",
            data: Buffer.from("TUI rendered\r\n", "utf8").toString("base64"),
          }));
          socket.send(JSON.stringify({
            type: "pty_exit",
            sessionId: "pty-fuse",
            exitCode: 0,
          }));
        }
      }
    });
  });

  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/index.ts", "--server", `127.0.0.1:${brain.port}`, "--cwd", cwd],
    {
      cwd: CLIENT_WORKDIR,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  registerChildCleanup(t, child);

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const exitCode = await waitForExit(child, 5000);
  assert.equal(exitCode, 0, `PTY 异常退出: stderr=${stderr}`);

  // 验证写操作成功
  assert.equal(createResponseReceived, true, "file_proxy create 应成功响应");
  assert.equal(writeResponseReceived, true, "file_proxy write 应成功响应");

  // 验证文件确实被写入
  const content = await fs.readFile(targetFile, "utf8");
  assert.equal(content, '{"id":"updated"}', "写入的文件内容应正确");

  // 验证 PTY 输出正常（TUI 在写操作成功后才渲染）
  assert.match(stdout, /TUI rendered/, "写操作成功后 TUI 应正常渲染");
});

test("PTY mode handles file_proxy_request snapshot operation", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cerelay-client-snapshot-"));

  // FileProxyHandler 限制路径必须在 {cwd}/.claude/ 内
  const claudeDir = path.join(cwd, ".claude");
  await fs.mkdir(path.join(claudeDir, "subdir"), { recursive: true });
  await fs.writeFile(path.join(claudeDir, "file1.txt"), "hello");
  await fs.writeFile(path.join(claudeDir, "subdir", "file2.txt"), "world");

  const brain = await startFakeBrain();
  registerBrainCleanup(t, brain);

  let snapshotResponse: Record<string, unknown> | null = null;

  brain.ws.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "connected" }));

    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;

      if (msg.type === "create_pty_session") {
        // 发送 snapshot 请求（路径必须在 {cwd}/.claude/ 内）
        socket.send(JSON.stringify({
          type: "file_proxy_request",
          reqId: "snap-1",
          sessionId: "pty-snap",
          op: "snapshot",
          path: claudeDir,
        }));
        socket.send(JSON.stringify({ type: "pty_session_created", sessionId: "pty-snap" }));
        return;
      }

      if (msg.type === "file_proxy_response") {
        const resp = msg as Record<string, unknown>;
        if (resp.reqId === "snap-1") {
          snapshotResponse = resp;
          socket.send(JSON.stringify({
            type: "pty_exit",
            sessionId: "pty-snap",
            exitCode: 0,
          }));
        }
      }
    });
  });

  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/index.ts", "--server", `127.0.0.1:${brain.port}`, "--cwd", cwd],
    {
      cwd: CLIENT_WORKDIR,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  registerChildCleanup(t, child);

  await waitForExit(child, 5000);

  assert.notEqual(snapshotResponse, null, "应收到 snapshot 响应");
  assert.equal(snapshotResponse!.error, undefined, "snapshot 不应返回错误");

  const snapshot = snapshotResponse!.snapshot as Array<{ path: string; stat: Record<string, unknown>; entries?: string[]; data?: string }>;
  assert.ok(Array.isArray(snapshot), "snapshot 应为数组");
  assert.ok(snapshot.length >= 3, `snapshot 应包含至少 3 个条目（根 + 2 文件 + 子目录），实际 ${snapshot.length}`);

  // 验证根目录有 entries
  const rootEntry = snapshot.find((e) => e.path === claudeDir);
  assert.ok(rootEntry, "snapshot 应包含根目录");
  assert.ok(rootEntry!.entries?.includes("file1.txt"), "根目录 entries 应包含 file1.txt");
  assert.ok(rootEntry!.entries?.includes("subdir"), "根目录 entries 应包含 subdir");

  // 验证文件有 stat（snapshot 只含 stat + readdir，不含文件内容）
  const fileEntry = snapshot.find((e) => e.path === path.join(claudeDir, "file1.txt"));
  assert.ok(fileEntry, "snapshot 应包含 file1.txt");
  assert.ok(fileEntry!.stat, "file1.txt 应有 stat 信息");
  assert.equal(fileEntry!.stat.isDir, false, "file1.txt 不应为目录");
  assert.equal(fileEntry!.stat.size, 5, "file1.txt 大小应为 5 字节");
});

// ============================================================
// 其他测试
// ============================================================

test("precompiled dist produces identical PTY behavior to tsx source", async (t) => {
  await buildClientDist();

  const brain = await startFakeBrain();
  registerBrainCleanup(t, brain);

  brain.ws.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "connected" }));

    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;

      if (msg.type === "create_pty_session") {
        socket.send(JSON.stringify({ type: "pty_session_created", sessionId: "pty-dist" }));
        socket.send(JSON.stringify({
          type: "pty_output",
          sessionId: "pty-dist",
          data: Buffer.from("dist-output\r\n", "utf8").toString("base64"),
        }));
        socket.send(JSON.stringify({
          type: "pty_exit",
          sessionId: "pty-dist",
          exitCode: 0,
        }));
        return;
      }
    });
  });

  const child = spawn(
    process.execPath,
    ["dist/index.js", "--server", `127.0.0.1:${brain.port}`],
    {
      cwd: CLIENT_WORKDIR,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  registerChildCleanup(t, child);

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const exitCode = await waitForExit(child, 5000);
  assert.equal(exitCode, 0, `dist PTY 异常退出: stderr=${stderr}`);
  assert.match(stdout, /\[PTY 已连接\]/, "dist PTY 应显示连接提示");
  assert.match(stdout, /dist-output/, "dist PTY 应显示 PTY 输出");
});

async function buildClientDist(): Promise<void> {
  const child = spawn("npm", ["run", "build"], {
    cwd: CLIENT_WORKDIR,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const exitCode = await waitForExit(child, 30_000);
  assert.equal(exitCode, 0, `client build 失败: ${stderr}`);
}

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

function registerChildCleanup(t: TestContext, child: ReturnType<typeof spawn>): void {
  t.after(async () => {
    child.stdin.destroy();
    if (child.exitCode !== null || child.killed) {
      return;
    }

    child.kill("SIGTERM");
    try {
      await waitForExit(child, 1000);
    } catch {
      child.kill("SIGKILL");
      await waitForExit(child, 1000).catch(() => undefined);
    }
  });
}

function registerBrainCleanup(
  t: TestContext,
  brain: {
    http: ReturnType<typeof createServer>;
    ws: WebSocketServer;
  }
): void {
  t.after(async () => {
    await stopFakeBrain(brain);
  });
}
