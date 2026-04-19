import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { WebServer } from "../src/server.js";

test("WebServer serves health, static files, and security headers", async (t) => {
  const server = new WebServer({ port: 0, serverAddress: "127.0.0.1:65534" });
  registerWebServerCleanup(t, server);
  await server.start();

  const port = server.getListenPort();

  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("x-content-type-options"), "nosniff");

  const home = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Cerelay/);
  assert.match(home.headers.get("content-security-policy") ?? "", /default-src 'self'/);

  const fallback = await fetch(`http://127.0.0.1:${port}/missing-route`);
  assert.equal(fallback.status, 200);
  assert.match(await fallback.text(), /<html/);

  const forbidden = await fetch(`http://127.0.0.1:${port}/..%2F..%2Fetc%2Fpasswd`);
  assert.equal(forbidden.status, 403);
});

test("WebServer proxies websocket traffic to server", async (t) => {
  const serverHttp = createServer();
  const serverWs = new WebSocketServer({ server: serverHttp });
  registerServerCleanup(t, serverHttp, serverWs);

  serverWs.on("connection", (socket) => {
    socket.on("message", (data) => {
      socket.send(data.toString().toUpperCase());
    });
  });

  serverHttp.listen(0);
  await once(serverHttp, "listening");
  const serverPort = (serverHttp.address() as import("node:net").AddressInfo).port;

  const server = new WebServer({ port: 0, serverAddress: `127.0.0.1:${serverPort}` });
  registerWebServerCleanup(t, server);
  await server.start();

  const ws = await connectWebSocket(`ws://127.0.0.1:${server.getListenPort()}/ws`);
  registerSocketCleanup(t, ws);
  ws.send("hello");
  const [message] = await waitForWebSocketMessage(ws);
  assert.equal(message.toString(), "HELLO");
  await closeWebSocket(ws);
});

function connectWebSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function closeWebSocket(ws: WebSocket): Promise<void> {
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

function waitForWebSocketMessage(ws: WebSocket): Promise<[WebSocket.RawData, boolean]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("等待 WebSocket 消息超时"));
    }, 2000);

    const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      cleanup();
      resolve([data, isBinary]);
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("error", onError);
    };

    ws.on("message", onMessage);
    ws.on("error", onError);
  });
}

function registerWebServerCleanup(t: TestContext, server: WebServer): void {
  t.after(async () => {
    await server.shutdown();
  });
}

function registerServerCleanup(
  t: TestContext,
  serverHttp: ReturnType<typeof createServer>,
  serverWs: WebSocketServer
): void {
  t.after(async () => {
    for (const client of serverWs.clients) {
      client.close();
    }
    await new Promise<void>((resolve) => serverWs.close(() => resolve()));
    await new Promise<void>((resolve, reject) => serverHttp.close((error) => error ? reject(error) : resolve()));
  });
}

function registerSocketCleanup(t: TestContext, ws: WebSocket): void {
  t.after(async () => {
    await closeWebSocket(ws);
  });
}
