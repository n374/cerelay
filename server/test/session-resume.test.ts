import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { CerelayServer } from "../src/server.js";

interface JsonMessage {
  type?: string;
  sessionId?: string;
  message?: string;
  [key: string]: unknown;
}

test("idle session can be restored after reconnect", async (t) => {
  const server = new CerelayServer({
    model: "claude-sonnet-4-20250514",
    port: 0,
    sessionCleanupIntervalMs: 20,
    sessionResumeGraceMs: 500,
  });
  registerServerCleanup(t, server);

  await server.start();

  const ws1 = await connect(server.getListenPort());
  registerSocketCleanup(t, ws1);

  ws1.send(JSON.stringify({
    type: "create_session",
    cwd: "/tmp",
  }));

  const created = await waitForType(ws1, "session_created");
  assert.equal(typeof created.sessionId, "string");
  const sessionId = created.sessionId;

  await closeSocket(ws1);

  const ws2 = await connect(server.getListenPort());
  registerSocketCleanup(t, ws2);

  ws2.send(JSON.stringify({
    type: "restore_session",
    sessionId,
  }));

  const restored = await waitForType(ws2, "session_restored");
  assert.equal(restored.sessionId, sessionId);

  ws2.send(JSON.stringify({
    type: "close_session",
    sessionId,
  }));
  await closeSocket(ws2);
});

test("detached idle session expires after resume window", async (t) => {
  const server = new CerelayServer({
    model: "claude-sonnet-4-20250514",
    port: 0,
    sessionCleanupIntervalMs: 10,
    sessionResumeGraceMs: 30,
  });
  registerServerCleanup(t, server);

  await server.start();

  const ws1 = await connect(server.getListenPort());
  registerSocketCleanup(t, ws1);

  ws1.send(JSON.stringify({
    type: "create_session",
    cwd: "/tmp",
  }));

  const created = await waitForType(ws1, "session_created");
  assert.equal(typeof created.sessionId, "string");
  const sessionId = created.sessionId;

  await closeSocket(ws1);
  await delay(80);

  const ws2 = await connect(server.getListenPort());
  registerSocketCleanup(t, ws2);

  ws2.send(JSON.stringify({
    type: "restore_session",
    sessionId,
  }));

  const error = await waitForType(ws2, "error");
  assert.match(String(error.message), /会话不存在|已过期|无法恢复/);

  await closeSocket(ws2);
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
    }, 3000);

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

    const onClose = () => {
      cleanup();
      reject(new Error(`WebSocket 在等待 ${type} 时关闭`));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("message", onMessage);
      ws.off("error", onError);
      ws.off("close", onClose);
    };

    ws.on("message", onMessage);
    ws.on("error", onError);
    ws.on("close", onClose);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function registerServerCleanup(t: TestContext, server: CerelayServer): void {
  t.after(async () => {
    await server.shutdown();
  });
}

function registerSocketCleanup(t: TestContext, ws: WebSocket): void {
  t.after(async () => {
    await closeSocket(ws);
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

    if (ws.readyState === WebSocket.CONNECTING) {
      ws.once("open", () => ws.close());
      return;
    }

    ws.close();
  });
}
