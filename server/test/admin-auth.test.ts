import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import { CerelayServer } from "../src/server.js";

const ADMIN_TOKEN = "axon_admin_auth_test_token_0123456789abcdef";
const WS_TOKEN = "axon_ws_auth_test_token_0123456789abcdef";

test("admin APIs require a valid token and expose token management", async (t) => {
  const server = new CerelayServer({
    model: "claude-sonnet-4-20250514",
    port: 0,
    authEnabled: false,
    initialToken: ADMIN_TOKEN,
  });
  registerServerCleanup(t, server);
  await server.start();

  const baseUrl = `http://127.0.0.1:${server.getListenPort()}`;

  const unauthorized = await fetch(`${baseUrl}/admin/stats`);
  assert.equal(unauthorized.status, 401);

  const forbidden = await fetch(`${baseUrl}/admin/stats`, {
    headers: {
      Authorization: "Bearer axon_invalid_token",
    },
  });
  assert.equal(forbidden.status, 403);

  const stats = await fetch(`${baseUrl}/admin/stats`, {
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    },
  });
  assert.equal(stats.status, 200);
  assert.equal(typeof (await stats.json()).handsOnline, "number");

  const routing = await fetch(`${baseUrl}/admin/tool-routing`, {
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    },
  });
  assert.equal(routing.status, 200);
  const initialRouting = await routing.json() as {
    builtinToolNames: string[];
    handToolNames: string[];
    handToolPrefixes: string[];
  };
  assert.equal(initialRouting.builtinToolNames.includes("Read"), true);
  assert.deepEqual(initialRouting.handToolNames, ["WebFetch"]);
  assert.deepEqual(initialRouting.handToolPrefixes, ["mcp__"]);

  const updateRouting = await fetch(`${baseUrl}/admin/tool-routing`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      handToolNames: ["WebFetch", "WebSearch"],
      handToolPrefixes: ["mcp__", "connector__"],
    }),
  });
  assert.equal(updateRouting.status, 200);
  const updatedRouting = await updateRouting.json() as {
    handToolNames: string[];
    handToolPrefixes: string[];
  };
  assert.deepEqual(updatedRouting.handToolNames, ["WebFetch", "WebSearch"]);
  assert.deepEqual(updatedRouting.handToolPrefixes, ["mcp__", "connector__"]);

  const createToken = await fetch(`${baseUrl}/admin/tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      label: "test-token",
      ttl: 60,
    }),
  });
  assert.equal(createToken.status, 201);
  const created = await createToken.json() as { tokenId: string; token: string };
  assert.match(created.token, /^axon_/);

  const tokens = await fetch(`${baseUrl}/admin/tokens`, {
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    },
  });
  const listed = await tokens.json() as {
    tokens: Array<{ tokenId: string; label: string; revoked: boolean }>;
  };
  assert.equal(listed.tokens.some((entry) => entry.tokenId === created.tokenId && entry.label === "test-token"), true);

  const revoke = await fetch(`${baseUrl}/admin/tokens/${created.tokenId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    },
  });
  assert.equal(revoke.status, 200);
});

test("websocket auth rejects missing tokens and accepts valid query/header tokens", async (t) => {
  const server = new CerelayServer({
    model: "claude-sonnet-4-20250514",
    port: 0,
    authEnabled: true,
    initialToken: WS_TOKEN,
  });
  registerServerCleanup(t, server);
  await server.start();

  const port = server.getListenPort();

  const missingToken = await connectExpectingUnauthorized(`ws://127.0.0.1:${port}/ws`);
  assert.equal(missingToken, 401);

  const querySocket = await connectSocket(`ws://127.0.0.1:${port}/ws?token=${WS_TOKEN}`);
  registerSocketCleanup(t, querySocket);
  querySocket.send(JSON.stringify({
    type: "create_session",
    cwd: "/tmp",
  }));
  const queryCreated = await waitForMessageType(querySocket, "session_created");
  assert.equal(typeof queryCreated.sessionId, "string");
  await closeSocket(querySocket);

  const headerSocket = await connectSocket(`ws://127.0.0.1:${port}/ws`, {
    Authorization: `Bearer ${WS_TOKEN}`,
  });
  registerSocketCleanup(t, headerSocket);
  headerSocket.send(JSON.stringify({
    type: "create_session",
    cwd: "/tmp",
  }));
  const created = await waitForMessageType(headerSocket, "session_created");
  assert.equal(typeof created.sessionId, "string");
  await closeSocket(headerSocket);
});

function registerServerCleanup(t: TestContext, server: CerelayServer): void {
  t.after(async () => {
    await server.shutdown();
  });
}

function registerSocketCleanup(t: TestContext, socket: WebSocket): void {
  t.after(async () => {
    await closeSocket(socket);
  });
}

function connectSocket(url: string, headers?: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function connectExpectingUnauthorized(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);

    socket.once("unexpected-response", (_request, response) => {
      resolve(response.statusCode ?? 0);
    });
    socket.once("open", () => {
      reject(new Error("缺少 token 时不应建立 WebSocket 连接"));
    });
    socket.once("error", reject);
  });
}

function waitForMessageType(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`等待消息超时: ${type}`));
    }, 3000);

    const onMessage = (data: WebSocket.RawData) => {
      try {
        const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
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
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
    };

    socket.on("message", onMessage);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.terminate();
      resolve();
    }, 1000);

    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });

    if (socket.readyState === WebSocket.CONNECTING) {
      socket.once("open", () => socket.close());
      return;
    }

    socket.close();
  });
}
