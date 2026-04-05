import process from "node:process";
import * as readline from "node:readline";

// ANSI 颜色码
const colorReset = "\x1b[0m";
const colorBold = "\x1b[1m";
const colorGray = "\x1b[90m";
const colorYellow = "\x1b[33m";
const colorGreen = "\x1b[32m";
const colorRed = "\x1b[31m";
const colorCyan = "\x1b[36m";

// UI 终端交互工具集
export class UI {
  // 打印 LLM 文本输出（流式，无换行）
  printText(text: string): void {
    process.stdout.write(text);
  }

  // 打印思考过程（灰色）
  printThought(text: string): void {
    process.stdout.write(`${colorGray}${text}${colorReset}`);
  }

  // 打印工具调用信息（黄色）
  printToolCall(toolName: string, params?: unknown): void {
    process.stdout.write(
      `${colorBold}${colorYellow}[工具调用] ${toolName}${colorReset}\n`
    );
    if (params !== undefined) {
      process.stdout.write(`${colorYellow}  参数: ${JSON.stringify(params)}${colorReset}\n`);
    }
  }

  // 打印工具执行结果（绿色/红色）
  printToolResult(toolName: string, success: boolean): void {
    if (success) {
      process.stdout.write(`${colorGreen}[完成] ${toolName}${colorReset}\n`);
    } else {
      process.stdout.write(`${colorRed}[失败] ${toolName}${colorReset}\n`);
    }
  }

  // 打印错误（红色，输出到 stderr）
  printError(msg: string): void {
    process.stderr.write(
      `${colorBold}${colorRed}错误: ${msg}${colorReset}\n`
    );
  }

  // 打印会话结束信息
  printSessionEnd(result?: string, error?: string): void {
    process.stdout.write(
      `\n${colorBold}${colorCyan}--- 会话结束 ---${colorReset}\n`
    );
    if (result) {
      process.stdout.write(`${colorCyan}结果: ${result}${colorReset}\n`);
    }
    if (error) {
      process.stdout.write(`${colorRed}错误: ${error}${colorReset}\n`);
    }
  }

  // 从 stdin 读取一行用户输入
  readInput(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false,
      });

      // 仅读取一行后立即关闭，避免占用 stdin
      rl.once("line", (line) => {
        rl.close();
        resolve(line);
      });

      rl.once("close", () => {
        // stdin 关闭（EOF）时 reject，由调用方处理
        reject(new EOFError());
      });

      process.stdout.write(`${colorBold}${prompt}${colorReset} `);
    });
  }
}

// EOF 错误，与 io.EOF 对齐
export class EOFError extends Error {
  constructor() {
    super("EOF");
    this.name = "EOFError";
  }
}
