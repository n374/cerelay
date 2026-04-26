#!/usr/bin/env node
import { mkdir, open } from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import process from "node:process";
import { Command } from "commander";
import { CerelayClient } from "./client.js";
import { configureLogger, getLogFilePath, resolveDefaultLogFilePath, type LogLevel } from "./logger.js";

const program = new Command();

program
  .name("cerelay")
  .description("Cerelay Client — 用户交互端")
  .option("--server <url>", "Cerelay Server 地址（host:port / http(s):// / ws(s)://）", "localhost:8765")
  .option("--key <key>", "连接 Server 的共享密钥（默认读取 CERELAY_KEY 环境变量）")
  .option("--cwd <dir>", "工作目录（默认当前目录）")
  .option("--log-level <level>", "日志级别（debug/info/warn/error）", "info")
  .option("--log-file <path>", "Client 日志文件路径", resolveDefaultLogFilePath())
  .action(async () => {
    const opts = program.opts<CommonOptions>();
    configureHandLogging(opts);
    await runPtyMode(opts.server, resolveKey(opts.key), opts.cwd);
  });

program
  .command("logs")
  .description("查看 Client 实时日志")
  .option("--lines <count>", "启动时先显示最后 N 行", "200")
  .option("--no-follow", "只输出当前日志，不持续跟随")
  .action(async (commandOptions: { lines?: string; follow?: boolean }) => {
    const opts = program.opts<CommonOptions>();
    configureHandLogging(opts);
    const lines = Math.max(Number.parseInt(commandOptions.lines ?? "200", 10) || 200, 1);
    await runLogsMode(lines, commandOptions.follow ?? true);
  });

await program.parseAsync(process.argv);

interface CommonOptions {
  server: string;
  key?: string;
  cwd?: string;
  logLevel?: string;
  logFile?: string;
}

// ============================================================
// 辅助：构造 WebSocket URL
// ============================================================

function resolveKey(cliKey?: string): string | undefined {
  return cliKey?.trim() || process.env.CERELAY_KEY?.trim() || undefined;
}

/**
 * 将 --server 参数规范化为 WebSocket URL。
 * 支持：host:port / http:// / https:// / ws:// / wss://
 *   localhost:8765          → ws://localhost:8765/ws
 *   http://example.com      → ws://example.com/ws
 *   https://example.com     → wss://example.com/ws
 *   https://example.com/pfx → wss://example.com/pfx/ws
 */
function resolveWebSocketURL(server: string): string {
  let raw = server
    .replace(/^https:\/\//, "wss://")
    .replace(/^http:\/\//, "ws://");
  if (!/^wss?:\/\//.test(raw)) {
    raw = `ws://${raw}`;
  }
  const u = new URL(raw);
  if (!u.pathname.endsWith("/ws")) {
    u.pathname = u.pathname.replace(/\/$/, "") + "/ws";
  }
  return u.toString().replace(/\/$/, "");
}

function buildServerURL(server: string, key?: string): string {
  const base = resolveWebSocketURL(server);
  if (!key) return base;
  return `${base}?key=${encodeURIComponent(key)}`;
}

// ============================================================
// 默认 PTY 模式
// ============================================================

async function runPtyMode(server: string, key: string | undefined, cwdOverride?: string): Promise<void> {
  const cwd = cwdOverride ?? process.cwd();
  const serverURL = buildServerURL(server, key);
  const client = new CerelayClient(serverURL, cwd, { interactiveOutput: false });

  // Cooked 模式下（cache sync 还没把 stdin 让给 raw 模式之前）Ctrl+C 直接产生 SIGINT。
  // raw 模式下 client.runPtyPassthrough 会把 \x03 字节回送 SIGINT 给本进程。
  // 两条路径都汇到这里走优雅关闭：abort cache sync → 关闭 WS → 退出。
  let interrupting = false;
  const handleInterrupt = (signal: NodeJS.Signals) => {
    if (interrupting) {
      // 用户连按两次 Ctrl+C：放弃优雅退出，立刻硬退
      process.stderr.write("\n\x1b[31m[强制退出]\x1b[0m\n");
      process.exit(130);
    }
    interrupting = true;
    process.stderr.write(`\n\x1b[33m[已中断 ${signal}, 正在退出...]\x1b[0m\n`);
    try {
      client.close();
    } catch {
      // ignore
    }
    process.exitCode = 130;
    // 给 WS close + 缓存 onDisconnected 一点时间走完，但不等太久；用户已经在催了
    setTimeout(() => process.exit(130), 500).unref();
  };
  process.on("SIGINT", handleInterrupt);
  process.on("SIGTERM", handleInterrupt);

  try {
    await client.connect();
    const sessionId = await client.sendCreatePtySession(cwd);
    process.stdout.write(`\x1b[36m[PTY 已连接] Session: ${sessionId}\x1b[0m\r\n`);
    const logFilePath = getLogFilePath();
    if (logFilePath) {
      process.stdout.write(`\x1b[90m日志文件: ${logFilePath} （查看: npm start -- logs）\x1b[0m\r\n`);
    }
    await client.runPtyPassthrough(sessionId);
  } catch (err) {
    process.stderr.write(`\x1b[31mPTY passthrough 失败: ${err instanceof Error ? err.message : String(err)}\x1b[0m\n`);
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", handleInterrupt);
    process.off("SIGTERM", handleInterrupt);
    client.close();
  }
}

function configureHandLogging(options: CommonOptions): void {
  configureLogger({
    minLevel: normalizeLogLevel(options.logLevel),
    filePath: options.logFile ?? resolveDefaultLogFilePath(),
  });
}

function normalizeLogLevel(value: string | undefined): LogLevel {
  switch (value) {
    case "debug":
    case "info":
    case "warn":
    case "error":
      return value;
    default:
      return "info";
  }
}

async function runLogsMode(lines: number, follow: boolean): Promise<void> {
  const logFilePath = getLogFilePath() ?? resolveDefaultLogFilePath();
  await mkdir(path.dirname(logFilePath), { recursive: true });
  const fileHandle = await open(logFilePath, "a+");
  try {
    const initialContent = await fileHandle.readFile("utf8");
    const chunks = initialContent
      .split("\n")
      .filter(Boolean)
      .slice(-lines);
    if (chunks.length > 0) {
      process.stdout.write(chunks.join("\n") + "\n");
    }

    if (!follow) {
      return;
    }

    process.stdout.write(`\x1b[90m实时跟随日志: ${logFilePath}\x1b[0m\n`);
    let offset = Buffer.byteLength(initialContent);
    await new Promise<void>((resolve, reject) => {
      const watcher = watch(logFilePath, async (eventType) => {
        if (eventType !== "change") {
          return;
        }
        try {
          const stat = await fileHandle.stat();
          if (stat.size < offset) {
            offset = 0;
          }
          if (stat.size === offset) {
            return;
          }
          const length = stat.size - offset;
          const buffer = Buffer.alloc(length);
          const result = await fileHandle.read(buffer, 0, length, offset);
          offset += result.bytesRead;
          if (result.bytesRead > 0) {
            process.stdout.write(buffer.subarray(0, result.bytesRead).toString("utf8"));
          }
        } catch (error) {
          watcher.close();
          reject(error);
        }
      });

      const handleSignal = () => {
        watcher.close();
        resolve();
      };
      process.once("SIGINT", handleSignal);
      process.once("SIGTERM", handleSignal);
    });
  } finally {
    await fileHandle.close();
  }
}
