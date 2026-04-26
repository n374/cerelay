// IpcClient 失败路径单测：对端关闭、ack 失败、token 错误的资源回收。
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { mkdtemp, unlink } from "node:fs/promises";
import path from "node:path";
import { IpcClient } from "../src/mcp-routed/ipc-client.js";
import {
  decodeIpcLines,
  encodeIpcMessage,
} from "../src/mcp-routed/ipc-protocol.js";

async function withMockHost(
  onConnection: (socket: Socket) => void,
  fn: (socketPath: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join("/tmp", "cerelay-mcp-mock-"));
  const socketPath = path.join(dir, "mock.sock");
  const tracked = new Set<Socket>();
  const server = createServer((socket) => {
    tracked.add(socket);
    socket.on("close", () => tracked.delete(socket));
    onConnection(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    await fn(socketPath);
  } finally {
    // 主动 destroy 所有 mock 端 socket，否则 server.close 会等空闲连接关。
    for (const sock of tracked) {
      if (!sock.destroyed) sock.destroy();
    }
    tracked.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(socketPath).catch(() => undefined);
  }
}

test("IpcClient hello 期间对端 close 立即 reject，不悬挂", async () => {
  await withMockHost(
    (socket) => {
      // 收到 hello 后不发 ack 直接 close。
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const { messages } = decodeIpcLines(buf);
        if (messages.some((m) => m.type === "hello")) {
          socket.destroy();
        }
      });
    },
    async (socketPath) => {
      const client = new IpcClient({ socketPath, token: "any", connectTimeoutMs: 1_000 });
      await assert.rejects(client.connect(), /对端关闭/);
      await client.close();
    },
  );
});

test("IpcClient hello ack 超时（server 不响应）时 reject，不悬挂", async () => {
  await withMockHost(
    () => {
      // 接受连接但永远不发 ack，也不关
    },
    async (socketPath) => {
      const client = new IpcClient({ socketPath, token: "any", connectTimeoutMs: 250 });
      await assert.rejects(client.connect(), /hello 超时/);
      await client.close();
    },
  );
});

test("IpcClient hello_ack ok:false 抛错且 socket 被 destroy", async () => {
  await withMockHost(
    (socket) => {
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const { messages } = decodeIpcLines(buf);
        if (messages.some((m) => m.type === "hello")) {
          socket.write(encodeIpcMessage({ type: "hello_ack", ok: false, error: "bad token" }));
        }
      });
    },
    async (socketPath) => {
      const client = new IpcClient({ socketPath, token: "wrong", connectTimeoutMs: 1_000 });
      await assert.rejects(client.connect(), /bad token/);
      await client.close();
    },
  );
});

test("IpcClient 在 callTool 飞行期间 socket 被对端关闭，pending promise 立即 reject", async () => {
  let activeSocket: Socket | null = null;
  await withMockHost(
    (socket) => {
      activeSocket = socket;
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const { messages, rest } = decodeIpcLines(buf);
        buf = rest;
        for (const m of messages) {
          if (m.type === "hello") {
            socket.write(encodeIpcMessage({ type: "hello_ack", ok: true }));
          } else if (m.type === "tool_call") {
            // 不响应 tool_result，等下方主动 destroy socket 模拟 host 关闭。
            setTimeout(() => activeSocket?.destroy(), 50);
          }
        }
      });
    },
    async (socketPath) => {
      const client = new IpcClient({ socketPath, token: "any", connectTimeoutMs: 1_000 });
      await client.connect();
      await assert.rejects(
        client.callTool("Bash", { command: "ls" }),
        /连接关闭/,
      );
      await client.close();
    },
  );
});
