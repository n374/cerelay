// ============================================================
// 端到端 skeleton: spawn 真实 mcp-routed 子进程 + SDK Client
// End-to-end skeleton: spawn real mcp-routed child + SDK Client
//
// 验证流程:
//   1. 主进程 listen unix socket（MCPIpcHost），dispatcher 模拟主进程的
//      executeToolViaClient（直接返回伪造的 stdout）。
//   2. spawn `node --import tsx src/mcp-routed/index.ts`，env 注入 socket+token
//   3. 用 SDK Client+StdioClientTransport 通过 stdio 跟子进程握手
//   4. tools/list 看到 7 个 shadow tools（bash/read/write/edit/multi_edit/glob/grep）
//   5. tools/call mcp__cerelay__bash → IPC tool_call("Bash", ...) → dispatcher
//      回结果 → 子进程渲染 → Client 拿到 isError:false 的 CallToolResult
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

test("mcp-routed 端到端：CC tools/list 看到 7 个 shadow tools 且 callTool bash 走通完整渲染", async (t) => {
  const dir = await mkdtemp(path.join("/tmp", "cerelay-mcp-skeleton-"));
  const sessionId = "pty-skeleton-1";
  const socketPath = buildMcpIpcSocketPath(dir, sessionId);

  const dispatched: Array<{ toolName: string; input: unknown }> = [];
  const host = new MCPIpcHost({
    sessionId,
    socketPath,
    token: "secret-token",
    dispatcher: async (toolName, input) => {
      dispatched.push({ toolName, input });
      if (toolName === "Bash") {
        return {
          output: {
            stdout: "README.md\npackage.json\n",
            stderr: "",
            exit_code: 0,
          },
        };
      }
      return { error: `unexpected toolName ${toolName}` };
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
  const names = list.tools.map((t) => t.name).sort();
  assert.deepEqual(
    names,
    ["bash", "edit", "glob", "grep", "multi_edit", "read", "write"],
    "tools/list 应该暴露 7 个 shadow tools",
  );

  const result = await client.callTool({
    name: "bash",
    arguments: { command: "ls" },
  });

  assert.equal(result.isError, false, "shadow bash 工具必须以 isError:false 返回（Plan D 核心不变量）");
  assert.deepEqual(dispatched, [{ toolName: "Bash", input: { command: "ls" } }]);

  assert.ok(Array.isArray(result.content));
  const block = (result.content as Array<{ type: string; text: string }>)[0];
  assert.equal(block?.type, "text");
  assert.match(block?.text ?? "", /stdout:\nREADME\.md\npackage\.json/);
  assert.match(block?.text ?? "", /exit_code: 0/);
});
