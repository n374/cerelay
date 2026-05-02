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
  // CERELAY_ADMIN_TOKEN：允许外部（e.g. e2e 测试容器）指定一个固定初始管理 token，
  // 而不是每次启动随机生成。healthcheck 或自动化脚本可以直接使用该固定 token。
  const adminToken = process.env.CERELAY_ADMIN_TOKEN?.trim() || undefined;

  const server = new CerelayServer({
    port: opts.port,
    model: opts.model,
    authEnabled: opts.auth,
    cerelayKey,
    initialToken: adminToken,
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

  // Build/feature marker：升级 server 后看 server log 第一行就能确认部署是否生效。
  // 改 BUILD_FEATURE_MARKER 字符串可以在新功能发布时让用户立刻区分新旧版本。
  // 当前 marker 包含 P0-1（snapshot.negativeEntries / broken symlink）+ P0-2
  // （Python FUSE 负缓存）+ doSnapshot maxDepth=8 这一波。
  log.info("Cerelay Server 已启动", {
    port: opts.port,
    model: opts.model,
    auth: opts.auth,
    buildFeatureMarker: "snapshot-negatives+fuse-neg-cache+depth8",
    nodeVersion: process.version,
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
