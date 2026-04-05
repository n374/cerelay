// ============================================================
// Axon Web Server 入口
// 职责：
//   - 提供 Web UI 静态文件服务
//   - 代理浏览器 WebSocket 连接到 Axon Brain Server
// ============================================================

import process from "node:process";
import { WebServer } from "./server.js";

const DEFAULT_PORT = 8766;
const DEFAULT_BRAIN = "localhost:8765";

async function main(): Promise<void> {
  const { port, brain } = parseArgs(process.argv.slice(2));

  const server = new WebServer({ port, brainAddress: brain });

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
  console.log(`[axon-web] 已启动`);
  console.log(`  Web UI: http://localhost:${port}`);
  console.log(`  Brain:  ws://${brain}/ws`);
}

function parseArgs(argv: string[]): { port: number; brain: string } {
  let port = DEFAULT_PORT;
  let brain = DEFAULT_BRAIN;

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

    if (arg === "--brain") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--brain 缺少值");
      }
      brain = value;
      i += 1;
      continue;
    }
  }

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`无效端口: ${port}`);
  }

  return { port, brain };
}

main().catch((error) => {
  console.error("[axon-web] fatal:", error);
  process.exit(1);
});
