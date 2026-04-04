/**
 * POC 1: 基本通信验证
 * 验证 SDK 能否启动 Claude Code 子进程并获取流式响应
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

async function main() {
  console.log("=== Axon POC: 基本通信验证 ===\n");

  const startTime = Date.now();

  const q = query({
    prompt: "回复 'Axon POC 成功' 这五个字，不要说其他任何内容",
    options: {
      cwd: process.cwd(),
      model: "claude-haiku-4-5-20251001",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: 1,
    },
  });

  let messageCount = 0;

  for await (const message of q) {
    messageCount++;
    console.log(`[${Date.now() - startTime}ms] 消息 #${messageCount}: type=${message.type}`);

    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") {
          console.log(`  文本: ${block.text}`);
        }
      }
    } else if (message.type === "result") {
      if (message.subtype === "success") {
        console.log(`  结果: ${message.result}`);
      } else {
        console.error(`  错误: ${message.error}`);
      }
    }
  }

  const elapsed = Date.now() - startTime;
  console.log(`\n=== 完成: ${elapsed}ms, ${messageCount} 条消息 ===`);
}

main().catch(console.error);
