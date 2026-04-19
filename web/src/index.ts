// ============================================================
// Cerelay Web Server 入口
// 职责：
//   - 提供 Web UI 静态文件服务
//   - 代理浏览器 WebSocket 连接到 Cerelay Server
// ============================================================

import process from "node:process";
import { WebServer } from "./server.js";

const DEFAULT_PORT = 8766;
const DEFAULT_SERVER = "localhost:8765";

async function main(): Promise<void> {
  const { port, server: serverAddr } = parseArgs(process.argv.slice(2));

  const server = new WebServer({ port, serverAddress: serverAddr });

  const shutdown = async (): Promise<void> => {
    await server.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  await server.start();
  console.log(`[cerelay-web] 已启动`);
  console.log(`  Web UI: http://localhost:${port}`);
  console.log(`  Server: ws://${serverAddr}/ws`);
}

function parseArgs(argv: string[]): { port: number; server: string } {
  let port = DEFAULT_PORT;
  let server = DEFAULT_SERVER;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--port") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--port 缺少值");
      }
      port = Number.parseInt(value, 10);
      i += 1;
      continue;
    }

    if (arg === "--server") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--server 缺少值");
      }
      server = value;
      i += 1;
      continue;
    }
  }

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`无效端口: ${port}`);
  }

  return { port, server };
}

main().catch((error) => {
  console.error("[cerelay-web] fatal:", error);
  process.exit(1);
});
