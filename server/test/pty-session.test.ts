import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";
import { CerelayServer } from "../src/server.js";
import { getClaudeSessionRuntimeRoot } from "../src/claude-session-runtime.js";

interface JsonMessage {
  type?: string;
  sessionId?: string;
  data?: string;
  [key: string]: unknown;
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

test("pty session can stream terminal bytes through WebSocket", async (t) => {
  const originalPtyCommand = process.env.CERELAY_PTY_COMMAND;
  process.env.CERELAY_PTY_COMMAND = "cat";
  t.after(() => {
    restoreEnvVar("CERELAY_PTY_COMMAND", originalPtyCommand);
  });

  const server = new CerelayServer({
    model: "claude-sonnet-4-20250514",
    port: 0,
  });
  t.after(async () => {
    await server.shutdown();
  });
  await server.start();

  const ws = await connect(server.getListenPort());
  t.after(async () => {
    await closeSocket(ws);
  });

  ws.send(JSON.stringify({
    type: "create_pty_session",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    projectClaudeSettingsLocalContent: JSON.stringify({
      agents: {
        Explore: {
          model: "haiku",
        },
      },
    }),
  }));

  const created = await waitForType(ws, "pty_session_created");
  assert.equal(typeof created.sessionId, "string");
  const sessionId = String(created.sessionId);

  ws.send(JSON.stringify({
    type: "pty_input",
    sessionId,
    data: Buffer.from("hello from pty\r", "utf8").toString("base64"),
  }));

  ws.send(JSON.stringify({
    type: "pty_resize",
    sessionId,
    cols: 100,
    rows: 30,
  }));

  const output = await waitForOutputContains(ws, sessionId, "hello from pty");
  assert.match(output, /hello from pty/);

  ws.send(JSON.stringify({
    type: "close_session",
    sessionId,
  }));
});

test("pty session forwards process stdout as pty_output without user input", async (t) => {
  const originalPtyCommand = process.env.CERELAY_PTY_COMMAND;
  process.env.CERELAY_PTY_COMMAND = "echo PTY_AUTOTEST_OUTPUT";
  t.after(() => {
    restoreEnvVar("CERELAY_PTY_COMMAND", originalPtyCommand);
  });

  const server = new CerelayServer({
    model: "claude-sonnet-4-20250514",
    port: 0,
  });
  t.after(async () => {
    await server.shutdown();
  });
  await server.start();

  const ws = await connect(server.getListenPort());
  t.after(async () => {
    await closeSocket(ws);
  });

  ws.send(JSON.stringify({
    type: "create_pty_session",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
  }));

  const created = await waitForType(ws, "pty_session_created");
  assert.equal(typeof created.sessionId, "string");
  const sessionId = String(created.sessionId);

  const output = await waitForOutputContains(ws, sessionId, "PTY_AUTOTEST_OUTPUT");
  assert.match(output, /PTY_AUTOTEST_OUTPUT/);

  const exit = await waitForType(ws, "pty_exit");
  assert.equal(exit.sessionId, sessionId);
});

test("create_pty_session keeps injected hook files in the PTY runtime root", async (t) => {
  const originalPtyCommand = process.env.CERELAY_PTY_COMMAND;
  const originalMountNamespace = process.env.CERELAY_ENABLE_MOUNT_NAMESPACE;
  process.env.CERELAY_PTY_COMMAND = "cat";
  process.env.CERELAY_ENABLE_MOUNT_NAMESPACE = "false";
  t.after(() => {
    restoreEnvVar("CERELAY_PTY_COMMAND", originalPtyCommand);
    restoreEnvVar("CERELAY_ENABLE_MOUNT_NAMESPACE", originalMountNamespace);
  });

  const server = new CerelayServer({
    model: "claude-sonnet-4-20250514",
    port: 0,
  });
  t.after(async () => {
    await server.shutdown();
  });
  await server.start();

  const ws = await connect(server.getListenPort());
  t.after(async () => {
    await closeSocket(ws);
  });

  ws.send(JSON.stringify({
    type: "create_pty_session",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    projectClaudeSettingsLocalContent: JSON.stringify({
      agents: {
        Explore: {
          model: "haiku",
        },
      },
    }),
  }));

  const created = await waitForType(ws, "pty_session_created");
  assert.equal(typeof created.sessionId, "string");
  const sessionId = String(created.sessionId);
  const runtimeRoot = getClaudeSessionRuntimeRoot(sessionId);

  await access(path.join(runtimeRoot, "settings.local.json"));
  await access(path.join(runtimeRoot, "hooks", "cerelay-pretooluse.mjs"));
  const settings = JSON.parse(
    await readFile(path.join(runtimeRoot, "settings.local.json"), "utf8")
  ) as {
    agents?: Record<string, unknown>;
    hooks?: { PreToolUse?: Array<{ matcher?: string; hooks?: Array<{ type?: string; command?: string }> }> };
  };
  assert.deepEqual(settings.agents, {
    Explore: {
      model: "haiku",
    },
  });
  assert.equal(Array.isArray(settings.hooks?.PreToolUse), true);
  assert.equal(settings.hooks?.PreToolUse?.[0]?.matcher, ".*");
  assert.equal(settings.hooks?.PreToolUse?.[0]?.hooks?.[0]?.type, "command");
  assert.match(settings.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command ?? "", /cerelay-pretooluse\.mjs/);

  ws.send(JSON.stringify({
    type: "close_session",
    sessionId,
  }));
});

test("pty session delivers pty_exit after short-lived process terminates", async (t) => {
  const originalPtyCommand = process.env.CERELAY_PTY_COMMAND;
  process.env.CERELAY_PTY_COMMAND = "true";
  t.after(() => {
    restoreEnvVar("CERELAY_PTY_COMMAND", originalPtyCommand);
  });

  const server = new CerelayServer({
    model: "claude-sonnet-4-20250514",
    port: 0,
  });
  t.after(async () => {
    await server.shutdown();
  });
  await server.start();

  const ws = await connect(server.getListenPort());
  t.after(async () => {
    await closeSocket(ws);
  });

  ws.send(JSON.stringify({
    type: "create_pty_session",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
  }));

  const created = await waitForType(ws, "pty_session_created");
  assert.equal(typeof created.sessionId, "string");
  const sessionId = String(created.sessionId);

  const exit = await waitForType(ws, "pty_exit");
  assert.equal(exit.sessionId, sessionId);
});

test("close_session terminates a running pty session", async (t) => {
  const originalPtyCommand = process.env.CERELAY_PTY_COMMAND;
  process.env.CERELAY_PTY_COMMAND = "sleep 60";
  t.after(() => {
    restoreEnvVar("CERELAY_PTY_COMMAND", originalPtyCommand);
  });

  const server = new CerelayServer({
    model: "claude-sonnet-4-20250514",
    port: 0,
  });
  t.after(async () => {
    await server.shutdown();
  });
  await server.start();

  const ws = await connect(server.getListenPort());
  t.after(async () => {
    await closeSocket(ws);
  });

  ws.send(JSON.stringify({
    type: "create_pty_session",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
  }));

  const created = await waitForType(ws, "pty_session_created");
  const sessionId = String(created.sessionId);

  ws.send(JSON.stringify({
    type: "close_session",
    sessionId,
  }));

  // close 后对已销毁 session 发消息应收到 error
  ws.send(JSON.stringify({
    type: "pty_input",
    sessionId,
    data: Buffer.from("test", "utf8").toString("base64"),
  }));

  const err = await waitForType(ws, "error");
  assert.match(String(err.message), /不存在/);
});

// ============================================================
// 工具函数
// ============================================================

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function waitForType(ws: WebSocket, type: string): Promise<JsonMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`waitForType("${type}") timed out`));
    }, 5000);

    const onMessage = (data: WebSocket.RawData) => {
      try {
        const parsed = JSON.parse(data.toString()) as JsonMessage;
        if (parsed.type === type) {
          cleanup();
          resolve(parsed);
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("message", onMessage);
      ws.off("error", onError);
    };

    ws.on("message", onMessage);
    ws.on("error", onError);
  });
}

function waitForOutputContains(ws: WebSocket, sessionId: string, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`waitForOutputContains("${text}") timed out`));
    }, 5000);
    let combined = "";

    const onMessage = (data: WebSocket.RawData) => {
      try {
        const parsed = JSON.parse(data.toString()) as JsonMessage;
        if (parsed.type !== "pty_output" || parsed.sessionId !== sessionId || typeof parsed.data !== "string") {
          return;
        }
        combined += Buffer.from(parsed.data, "base64").toString("utf8");
        if (combined.includes(text)) {
          cleanup();
          resolve(combined);
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("message", onMessage);
      ws.off("error", onError);
    };

    ws.on("message", onMessage);
    ws.on("error", onError);
  });
}

function closeSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.terminate();
      resolve();
    }, 1000);

    ws.once("close", () => {
      clearTimeout(timer);
      resolve();
    });

    ws.close();
  });
}
