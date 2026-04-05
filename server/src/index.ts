import process from "node:process";
import { AxonServer } from "./server.js";

const DEFAULT_PORT = 8765;
const DEFAULT_MODEL = "claude-sonnet-4-20250514";

async function main(): Promise<void> {
  const { port, model } = parseArgs(process.argv.slice(2));
  const server = new AxonServer({ port, model });

  const shutdown = async () => {
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
  console.log(`[axon-server] listening on :${port} (model=${model})`);
}

function parseArgs(argv: string[]): { model: string; port: number } {
  let port = DEFAULT_PORT;
  let model = DEFAULT_MODEL;

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

    if (arg === "--model") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--model 缺少值");
      }
      model = value;
      i += 1;
      continue;
    }
  }

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`无效端口: ${port}`);
  }

  return { port, model };
}

main().catch((error) => {
  console.error("[axon-server] fatal:", error);
  process.exit(1);
});
