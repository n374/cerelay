import { mkdir, open } from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import process from "node:process";
import { Command } from "commander";
import { HandClient } from "./client.js";
import { UI, EOFError } from "./ui.js";
import { runAcpServer } from "./acp/index.js";
import { configureLogger, getLogFilePath, resolveDefaultLogFilePath, type LogLevel } from "./logger.js";

const program = new Command();

program
  .name("axon-hand")
  .description("Axon Hand CLI — 用户交互端")
  .option("--server <host:port>", "Axon Server 地址", "localhost:8765")
  .option("--cwd <dir>", "工作目录（默认当前目录）")
  .option("--log-level <level>", "日志级别（debug/info/warn/error）", "info")
  .option("--log-file <path>", "Hand 日志文件路径", resolveDefaultLogFilePath())
  .action(async () => {
    const opts = program.opts<CommonOptions>();
    configureHandLogging(opts);
    await runCliMode(opts.server, opts.cwd);
  });

program
  .command("pty")
  .description("以 PTY passthrough 模式连接远端 Claude Code 终端")
  .action(async () => {
    const opts = program.opts<CommonOptions>();
    configureHandLogging(opts);
    await runPtyMode(opts.server, opts.cwd);
  });

program
  .command("logs")
  .description("查看 Hand 实时日志")
  .option("--lines <count>", "启动时先显示最后 N 行", "200")
  .option("--no-follow", "只输出当前日志，不持续跟随")
  .action(async (commandOptions: { lines?: string; follow?: boolean }) => {
    const opts = program.opts<CommonOptions>();
    configureHandLogging(opts);
    const lines = Math.max(Number.parseInt(commandOptions.lines ?? "200", 10) || 200, 1);
    await runLogsMode(lines, commandOptions.follow ?? true);
  });

// ---- 子命令：acp（stdio ACP Server，供编辑器集成）----
program
  .command("acp")
  .description("以 ACP stdio 模式启动，供编辑器（Zed/VS Code）通过 ACP 协议连接")
  .action(async () => {
    const opts = program.opts<CommonOptions>();
    configureHandLogging(opts);
    await runAcpServer({
      server: opts.server,
      cwd: opts.cwd ?? process.cwd(),
    });
  });

await program.parseAsync(process.argv);

interface CommonOptions {
  server: string;
  cwd?: string;
  logLevel?: string;
  logFile?: string;
}

// ============================================================
// 默认 CLI 交互模式
// ============================================================

async function runCliMode(server: string, cwdOverride?: string): Promise<void> {
  const cwd = cwdOverride ?? process.cwd();
  const serverURL = `ws://${server}/ws`;

  // --- 建立连接 ---
  const client = new HandClient(serverURL, cwd);
  const ui = new UI();

  const ensureSession = async (allowCreateOnRestoreFailure: boolean): Promise<boolean> => {
    try {
      await client.ensureSession({
        cwd,
        allowCreateOnRestoreFailure,
      });
      return true;
    } catch (err) {
      ui.printError(`连接或恢复 Session 失败: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };

  if (!(await ensureSession(false))) {
    process.exit(1);
  }

  // --- 捕获 Ctrl+C ---
  process.on("SIGINT", () => {
    console.log("\n\x1b[90m已退出\x1b[0m");
    client.close();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    client.close();
    process.exit(0);
  });

  console.log("\x1b[1m\x1b[36mAxon Hand CLI\x1b[0m — 输入 /quit 退出");
  const logFilePath = getLogFilePath();
  if (logFilePath) {
    console.log(`\x1b[90m日志文件: ${logFilePath} （查看: npm start -- logs）\x1b[0m`);
  }
  console.log();

  const executePrompt = async (text: string): Promise<boolean> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!(await ensureSession(true))) {
        return false;
      }

      try {
        await client.sendPrompt(text);
        console.log();
        await client.run();
        console.log();
        return true;
      } catch (err) {
        ui.printError(`消息发送或执行失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return false;
  };

  // --- 交互循环 ---
  while (true) {
    let input: string;
    try {
      input = await ui.readInput("你>");
    } catch (err) {
      if (err instanceof EOFError) {
        console.log();
        break;
      }
      ui.printError(`读取输入失败: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }

    input = input.trim();
    if (!input) {
      continue;
    }

    if (input === "/quit" || input === "/exit") {
      console.log("\x1b[90m再见！\x1b[0m");
      break;
    }

    if (!(await executePrompt(input))) {
      break;
    }
  }

  client.close();
}

async function runPtyMode(server: string, cwdOverride?: string): Promise<void> {
  const cwd = cwdOverride ?? process.cwd();
  const serverURL = `ws://${server}/ws`;
  const client = new HandClient(serverURL, cwd, { interactiveOutput: false });

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
