// ============================================================
// 端到端 skeleton: MCPIpcHost + spawn 真实 mcp-routed 子进程 + SDK Client
// End-to-end skeleton: MCPIpcHost + spawn real mcp-routed child + SDK Client
//
// 验证流程:
//   1. 主进程 listen unix socket
//   2. spawn `node --import tsx src/mcp-routed/index.ts`，env 注入 socket+token
//   3. 用 SDK Client+StdioClientTransport 通过 stdio 跟子进程握手
//   4. tools/list 看到 echo
//   5. tools/call __cerelay_echo -> dispatcher 收到 IPC tool_call -> 回结果
//      -> 子进程渲染 -> Client 拿到 isError:false 的 CallToolResult
// ============================================================

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MCPIpcHost, buildMcpIpcSocketPath } from "../src/mcp-ipc-host.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTED_ENTRY = path.resolve(HERE, "../src/mcp-routed/index.ts");

test("mcp-routed 子进程 echo 工具端到端：MCP tools/call → IPC tool_call → result", async (t) => {
  // macOS sun_path 限制 104 byte，tmpdir() 在 macOS 是 /var/folders/...
  // 太长，用 /tmp 配合 mkdtemp 保证 socket 路径在限制内。
  const dir = await mkdtemp(path.join("/tmp", "cerelay-mcp-skeleton-"));
  const sessionId = "pty-skeleton-1";
  const socketPath = buildMcpIpcSocketPath(dir, sessionId);

  let lastDispatched: { toolName: string; input: unknown } | null = null;
  const host = new MCPIpcHost({
    sessionId,
    socketPath,
    token: "secret-token",
    dispatcher: async (toolName, input) => {
      lastDispatched = { toolName, input };
      const message = (input as { message?: string } | null)?.message ?? "";
      return { output: message.toUpperCase() };
    },
    verboseLogging: false,
  });
  await host.start();

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", ROUTED_ENTRY],
    env: {
      ...process.env,
      CERELAY_MCP_IPC_SOCKET: socketPath,
      CERELAY_MCP_IPC_TOKEN: "secret-token",
      CERELAY_MCP_SESSION_ID: sessionId,
    } as Record<string, string>,
    stderr: "pipe",
  });

  const client = new Client({ name: "skeleton-test", version: "0.0.1" }, { capabilities: {} });

  t.after(async () => {
    try {
      await client.close();
    } catch {
      // ignore
    }
    await host.close();
  });

  await client.connect(transport);

  const list = await client.listTools();
  assert.equal(list.tools.length, 1);
  assert.equal(list.tools[0]?.name, "__cerelay_echo");

  const result = await client.callTool({
    name: "__cerelay_echo",
    arguments: { message: "hello" },
  });
  assert.equal(result.isError, false, "echo 应该 isError:false");
  assert.deepEqual(lastDispatched, { toolName: "__cerelay_echo", input: { message: "hello" } });
  assert.ok(Array.isArray(result.content));
  const block = (result.content as Array<{ type: string; text: string }>)[0];
  assert.equal(block?.type, "text");
  assert.equal(block?.text, "HELLO");
});
