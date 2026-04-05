import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { WebServer } from "../src/server.js";

test("WebServer serves health, static files, and security headers", async () => {
  const server = new WebServer({ port: 0, brainAddress: "127.0.0.1:65534" });
  await server.start();

  try {
    const port = server.getListenPort();

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("x-content-type-options"), "nosniff");

    const home = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Axon/);
    assert.match(home.headers.get("content-security-policy") ?? "", /default-src 'self'/);

    const fallback = await fetch(`http://127.0.0.1:${port}/missing-route`);
    assert.equal(fallback.status, 200);
    assert.match(await fallback.text(), /<html/);

    const forbidden = await fetch(`http://127.0.0.1:${port}/..%2F..%2Fetc%2Fpasswd`);
    assert.equal(forbidden.status, 403);
  } finally {
    await server.shutdown();
  }
});

test("WebServer proxies websocket traffic to brain", async () => {
  const brainHttp = createServer();
  const brainWs = new WebSocketServer({ server: brainHttp });

  brainWs.on("connection", (socket) => {
    socket.on("message", (data) => {
      socket.send(data.toString().toUpperCase());
    });
  });

  brainHttp.listen(0);
  await once(brainHttp, "listening");
  const brainPort = (brainHttp.address() as import("node:net").AddressInfo).port;

  const server = new WebServer({ port: 0, brainAddress: `127.0.0.1:${brainPort}` });
  await server.start();

  try {
    const ws = await connectWebSocket(`ws://127.0.0.1:${server.getListenPort()}/ws`);
    ws.send("hello");
    const [message] = await waitForWebSocketMessage(ws);
    assert.equal(message.toString(), "HELLO");
    await closeWebSocket(ws);
  } finally {
    await server.shutdown();
    for (const client of brainWs.clients) {
      client.close();
    }
    await new Promise<void>((resolve) => brainWs.close(() => resolve()));
    await new Promise<void>((resolve, reject) => brainHttp.close((error) => error ? reject(error) : resolve()));
  }
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
