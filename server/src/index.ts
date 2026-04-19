// ============================================================
// Cerelay Server 入口
// 支持的命令行参数：
//   --port <n>       监听端口（默认 8765）
//   --model <name>   默认 Claude 模型
//   --auth           启用 Token 认证
//   --log-json       以 JSON Lines 格式输出结构化日志
//   --log-level <l>  日志级别（debug/info/warn/error）
// ============================================================

import process from "node:process";
import { CerelayServer } from "./server.js";
import { configureLogger, createLogger } from "./logger.js";

const DEFAULT_PORT = 8765;
const DEFAULT_MODEL = "claude-sonnet-4-20250514";

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  // 配置全局日志
  configureLogger({
    minLevel: opts.logLevel,
    json: opts.logJson,
  });

  const log = createLogger("main");

  const cerelayKey = process.env.CERELAY_KEY?.trim() || undefined;

  const server = new CerelayServer({
    port: opts.port,
    model: opts.model,
    authEnabled: opts.auth,
    cerelayKey,
  });

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

  log.info("Cerelay Server 已启动", {
    port: opts.port,
    model: opts.model,
    auth: opts.auth,
  });
}

interface ParsedOptions {
  port: number;
  model: string;
  auth: boolean;
  logJson: boolean;
  logLevel: "debug" | "info" | "warn" | "error";
}

function parseArgs(argv: string[]): ParsedOptions {
  let port = DEFAULT_PORT;
  let model = DEFAULT_MODEL;
  let auth = false;
  let logJson = false;
  let logLevel: "debug" | "info" | "warn" | "error" = "info";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--port") {
      const value = argv[i + 1];
      if (!value) throw new Error("--port 缺少值");
      port = Number.parseInt(value, 10);
      i += 1;
      continue;
    }

    if (arg === "--model") {
      const value = argv[i + 1];
      if (!value) throw new Error("--model 缺少值");
      model = value;
      i += 1;
      continue;
    }

    if (arg === "--auth") {
      auth = true;
      continue;
    }

    if (arg === "--log-json") {
      logJson = true;
      continue;
    }

    if (arg === "--log-level") {
      const value = argv[i + 1];
      if (!value) throw new Error("--log-level 缺少值");
      if (!["debug", "info", "warn", "error"].includes(value)) {
        throw new Error(`无效日志级别: ${value}`);
      }
      logLevel = value as "debug" | "info" | "warn" | "error";
      i += 1;
      continue;
    }
  }

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`无效端口: ${port}`);
  }

  return { port, model, auth, logJson, logLevel };
}

main().catch((error) => {
  console.error("[cerelay-server] fatal:", error);
  process.exit(1);
});
