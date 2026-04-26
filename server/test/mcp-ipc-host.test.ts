import test from "node:test";
import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MCPIpcHost, buildMcpIpcSocketPath, type ToolCallDispatcher } from "../src/mcp-ipc-host.js";
import {
  decodeIpcLines,
  encodeIpcMessage,
  type IpcMessage,
} from "../src/mcp-routed/ipc-protocol.js";

interface TestClient {
  socket: Socket;
  read: (predicate: (msg: IpcMessage) => boolean, timeoutMs?: number) => Promise<IpcMessage>;
  send: (message: IpcMessage) => void;
  close: () => void;
}

async function dialTestClient(socketPath: string): Promise<TestClient> {
  const socket = connect(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  let buffer = "";
  const queue: IpcMessage[] = [];
  const waiters: Array<{ predicate: (msg: IpcMessage) => boolean; resolve: (msg: IpcMessage) => void }> = [];

  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const { messages, rest } = decodeIpcLines(buffer);
    buffer = rest;
    for (const message of messages) {
      const idx = waiters.findIndex((w) => w.predicate(message));
      if (idx >= 0) {
        const [matched] = waiters.splice(idx, 1);
        matched.resolve(message);
      } else {
        queue.push(message);
      }
    }
  });

  return {
    socket,
    send: (message) => {
      socket.write(encodeIpcMessage(message));
    },
    read: (predicate, timeoutMs = 2_000) =>
      new Promise<IpcMessage>((resolve, reject) => {
        const idx = queue.findIndex(predicate);
        if (idx >= 0) {
          const [matched] = queue.splice(idx, 1);
          resolve(matched);
          return;
        }
        const timer = setTimeout(() => {
          const wIdx = waiters.findIndex((w) => w.predicate === predicate);
          if (wIdx >= 0) waiters.splice(wIdx, 1);
          reject(new Error("read timeout"));
        }, timeoutMs);
        waiters.push({
          predicate,
          resolve: (msg) => {
            clearTimeout(timer);
            resolve(msg);
          },
        });
      }),
    close: () => {
      socket.destroy();
    },
  };
}

async function setupHost(dispatcher: ToolCallDispatcher): Promise<{
  host: MCPIpcHost;
  socketPath: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "cerelay-mcp-host-"));
  const sessionId = "pty-test-1";
  const socketPath = buildMcpIpcSocketPath(dir, sessionId);
  const host = new MCPIpcHost({
    sessionId,
    socketPath,
    token: "secret",
    dispatcher,
    verboseLogging: false,
  });
  await host.start();
  return {
    host,
    socketPath,
    cleanup: async () => {
      await host.close();
    },
  };
}

test("MCPIpcHost hello 握手成功后才接受 tool_call", async () => {
  const { host, socketPath, cleanup } = await setupHost(async (toolName, input) => ({
    output: { toolName, input },
  }));
  try {
    const client = await dialTestClient(socketPath);
    client.send({ type: "hello", token: "secret" });
    const ack = await client.read((m) => m.type === "hello_ack");
    assert.equal(ack.type === "hello_ack" && ack.ok, true);

    client.send({ type: "tool_call", id: "1", toolName: "Bash", input: { command: "ls" } });
    const result = await client.read((m) => m.type === "tool_result" && m.id === "1");
    assert.equal(result.type, "tool_result");
    if (result.type !== "tool_result") throw new Error("unreachable");
    assert.deepEqual(result.output, { toolName: "Bash", input: { command: "ls" } });
    assert.equal(result.error, undefined);

    client.close();
  } finally {
    await cleanup();
    assert.equal(host.hasActiveAuthenticatedConnection(), false);
  }
});

test("MCPIpcHost token 错误会拒绝连接", async () => {
  const { socketPath, cleanup } = await setupHost(async () => ({}));
  try {
    const client = await dialTestClient(socketPath);
    client.send({ type: "hello", token: "wrong" });
    const ack = await client.read((m) => m.type === "hello_ack");
    if (ack.type !== "hello_ack") throw new Error("unreachable");
    assert.equal(ack.ok, false);
    // socket 应被服务端 destroy
    await new Promise<void>((resolve) => {
      if (client.socket.destroyed) {
        resolve();
        return;
      }
      client.socket.once("close", () => resolve());
    });
  } finally {
    await cleanup();
  }
});

test("MCPIpcHost dispatcher 抛错时回 error 响应", async () => {
  const { socketPath, cleanup } = await setupHost(async () => {
    throw new Error("bash failed");
  });
  try {
    const client = await dialTestClient(socketPath);
    client.send({ type: "hello", token: "secret" });
    await client.read((m) => m.type === "hello_ack");
    client.send({ type: "tool_call", id: "x", toolName: "Bash", input: {} });
    const result = await client.read((m) => m.type === "tool_result" && m.id === "x");
    if (result.type !== "tool_result") throw new Error("unreachable");
    assert.equal(result.error, "bash failed");
    client.close();
  } finally {
    await cleanup();
  }
});

test("MCPIpcHost 拒绝未握手即发 tool_call 的连接", async () => {
  const { socketPath, cleanup } = await setupHost(async () => ({ output: "x" }));
  try {
    const client = await dialTestClient(socketPath);
    client.send({ type: "tool_call", id: "1", toolName: "Bash", input: {} });
    // 服务端应直接 destroy socket
    await new Promise<void>((resolve) => {
      if (client.socket.destroyed) {
        resolve();
        return;
      }
      client.socket.once("close", () => resolve());
    });
  } finally {
    await cleanup();
  }
});

test("MCPIpcHost 拒绝并发连接（同时只允许一个活跃 child）", async () => {
  const { socketPath, cleanup } = await setupHost(async () => ({ output: "ok" }));
  try {
    const a = await dialTestClient(socketPath);
    a.send({ type: "hello", token: "secret" });
    await a.read((m) => m.type === "hello_ack");

    const b = await dialTestClient(socketPath);
    // 第二个连接应被立刻 destroy
    await new Promise<void>((resolve) => {
      if (b.socket.destroyed) {
        resolve();
        return;
      }
      b.socket.once("close", () => resolve());
    });
    a.close();
  } finally {
    await cleanup();
  }
});

test("buildMcpIpcSocketPath 总长度低于 Unix socket 限制 108", () => {
  const sid = "pty-1234567890123-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const sock = buildMcpIpcSocketPath("/tmp", sid);
  assert.ok(sock.length < 108, `socket path too long: ${sock.length} for ${sock}`);
});
