// ============================================================
// cerelay-routed MCP server 子进程入口
// Entry point for the cerelay-routed MCP child process.
//
// 由 CC 通过 --mcp-config 中的 command/args 拉起。
// Spawned by Claude Code via --mcp-config { command, args, env }.
//
// 启动流程 / Startup:
//   1. 从环境变量读 socket path + token
//   2. 通过 IpcClient 连主进程并 hello
//   3. 创建 MCP Server（registerTool / setRequestHandler）
//   4. 通过 StdioServerTransport 接 CC stdin/stdout
// ============================================================

import process from "node:process";
import { createLogger } from "../logger.js";
import { buildAllShadowToolHandlers } from "./handlers.js";
import { IpcClient } from "./ipc-client.js";
import {
  connectStdio,
  createRoutedMcpServer,
  type RoutedToolDefinition,
} from "./server.js";

const log = createLogger("mcp-routed");

const ENV_SOCKET = "CERELAY_MCP_IPC_SOCKET";
const ENV_TOKEN = "CERELAY_MCP_IPC_TOKEN";
const ENV_SESSION = "CERELAY_MCP_SESSION_ID";

// 子进程运行配置，留给 Phase 2 注入真实 tool 列表。
export interface RunRoutedMcpServerOptions {
  /** override toolset for tests; production 用默认 echo + handlers */
  buildTools?: (ipc: IpcClient) => RoutedToolDefinition[];
  /** override env reader（测试用） */
  env?: NodeJS.ProcessEnv;
}

export async function runRoutedMcpServer(options: RunRoutedMcpServerOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const socketPath = env[ENV_SOCKET]?.trim();
  const token = env[ENV_TOKEN]?.trim();
  const sessionId = env[ENV_SESSION]?.trim();

  if (!socketPath) {
    throw new Error(`mcp-routed: 环境变量 ${ENV_SOCKET} 未设置`);
  }
  if (!token) {
    throw new Error(`mcp-routed: 环境变量 ${ENV_TOKEN} 未设置`);
  }

  log.debug("mcp-routed 子进程启动", { sessionId, socketPath });

  const ipc = new IpcClient({ socketPath, token });
  await ipc.connect();

  const buildTools = options.buildTools ?? ((client) => buildAllShadowToolHandlers(client));
  const tools = buildTools(ipc);
  const server = createRoutedMcpServer({
    serverName: "cerelay",
    serverVersion: "0.1.0",
    tools,
  });

  await connectStdio(server);
  log.info("mcp-routed 已就绪", {
    sessionId,
    toolCount: tools.length,
    tools: tools.map((tool) => tool.name),
  });

  // 主进程关 socket 时退出子进程。
  const shutdown = async () => {
    try {
      await server.close();
    } catch {
      // ignore
    }
    await ipc.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// 直接 node 调用时启动。
const isDirectInvocation = (() => {
  if (typeof process.argv[1] !== "string") {
    return false;
  }
  const entry = process.argv[1];
  // 同时兼容 ts (dev/test 走 tsx) 与编译产物 (dist/.js) 两种入口。
  return entry.endsWith("/mcp-routed/index.js") || entry.endsWith("/mcp-routed/index.ts");
})();

if (isDirectInvocation) {
  runRoutedMcpServer().catch((err) => {
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    process.stderr.write(`[mcp-routed] fatal: ${message}\n`);
    process.exit(1);
  });
}
