import process from "node:process";
import { Command } from "commander";
import { HandClient } from "./client.js";
import { UI, EOFError } from "./ui.js";
import { runAcpServer } from "./acp/index.js";

const program = new Command();

program
  .name("axon-hand")
  .description("Axon Hand CLI — 用户交互端")
  .option("--server <host:port>", "Axon Server 地址", "localhost:8765")
  .option("--cwd <dir>", "工作目录（默认当前目录）")
  .action(async () => {
    const opts = program.opts<{ server: string; cwd?: string }>();
    await runCliMode(opts.server, opts.cwd);
  });

// ---- 子命令：acp（stdio ACP Server，供编辑器集成）----
program
  .command("acp")
  .description("以 ACP stdio 模式启动，供编辑器（Zed/VS Code）通过 ACP 协议连接")
  .action(async () => {
    const opts = program.opts<{ server: string; cwd?: string }>();
    await runAcpServer({
      server: opts.server,
      cwd: opts.cwd ?? process.cwd(),
    });
  });

await program.parseAsync(process.argv);

// ============================================================
// 默认 CLI 交互模式
// ============================================================

async function runCliMode(server: string, cwdOverride?: string): Promise<void> {
  const cwd = cwdOverride ?? process.cwd();
  const serverURL = `ws://${server}/ws`;

  // --- 建立连接 ---
  const client = new HandClient(serverURL, cwd);

  try {
    await client.connect();
  } catch (err) {
    console.error(`连接失败: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // --- 创建 Session ---
  try {
    await client.sendCreateSession(cwd);
  } catch (err) {
    console.error(`创建 Session 失败: ${err instanceof Error ? err.message : String(err)}`);
    client.close();
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

  const ui = new UI();
  console.log("\x1b[1m\x1b[36mAxon Hand CLI\x1b[0m — 输入 /quit 退出\n");

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

    // 发送 prompt
    try {
      await client.sendPrompt(input);
    } catch (err) {
      ui.printError(`发送 prompt 失败: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }

    // 运行消息循环直到 session_end（prompt 完成，session 仍存活可复用）
    console.log();
    try {
      await client.run();
    } catch (err) {
      ui.printError(`消息循环错误: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
    console.log();
  }

  client.close();
}
