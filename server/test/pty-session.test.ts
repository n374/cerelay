import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";
import { AxonServer } from "../src/server.js";
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
  const originalPtyCommand = process.env.AXON_PTY_COMMAND;
  process.env.AXON_PTY_COMMAND = "cat";
  t.after(() => {
    restoreEnvVar("AXON_PTY_COMMAND", originalPtyCommand);
  });

  const server = new AxonServer({
    model: "claude-sonnet-4-20250514",
    port: 0,
    sessionCleanupIntervalMs: 20,
    sessionResumeGraceMs: 500,
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

test("create_pty_session keeps injected hook files in the PTY runtime root", async (t) => {
  const originalPtyCommand = process.env.AXON_PTY_COMMAND;
  const originalMountNamespace = process.env.AXON_ENABLE_MOUNT_NAMESPACE;
  process.env.AXON_PTY_COMMAND = "cat";
  process.env.AXON_ENABLE_MOUNT_NAMESPACE = "false";
  t.after(() => {
    restoreEnvVar("AXON_PTY_COMMAND", originalPtyCommand);
    restoreEnvVar("AXON_ENABLE_MOUNT_NAMESPACE", originalMountNamespace);
  });

  const server = new AxonServer({
    model: "claude-sonnet-4-20250514",
    port: 0,
    sessionCleanupIntervalMs: 20,
    sessionResumeGraceMs: 500,
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
  await access(path.join(runtimeRoot, "hooks", "axon-pretooluse.mjs"));
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
  assert.match(settings.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command ?? "", /axon-pretooluse\.mjs/);

  ws.send(JSON.stringify({
    type: "close_session",
    sessionId,
  }));
});

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
      reject(new Error(`等待消息超时: ${type}`));
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
      reject(new Error(`等待 PTY 输出超时: ${text}`));
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
