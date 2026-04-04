/**
 * POC 2: 工具拦截验证（使用 hooks.PreToolUse）
 *
 * canUseTool 在 bypassPermissions 模式下不触发。
 * 改用 hooks.PreToolUse，不受权限模式影响。
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

async function main() {
  console.log("=== Axon POC: 工具拦截验证 (hooks.PreToolUse) ===\n");

  const interceptedTools: Array<{ tool: string; input: unknown; timestamp: number }> = [];
  const startTime = Date.now();

  const q = query({
    prompt: "请执行 `echo hello-axon` 命令，然后告诉我当前目录下有哪些文件",
    options: {
      cwd: process.cwd(),
      model: "claude-haiku-4-5-20251001",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: 3,
      hooks: {
        PreToolUse: [
          {
            matcher: ".*",
            hooks: [
              async (input) => {
                const elapsed = Date.now() - startTime;
                console.log(`\n[${elapsed}ms] 🔧 PreToolUse Hook 拦截:`);
                console.log(`  工具: ${input.tool_name}`);
                console.log(`  输入: ${JSON.stringify(input.tool_input).slice(0, 200)}`);

                interceptedTools.push({
                  tool: input.tool_name,
                  input: input.tool_input,
                  timestamp: elapsed,
                });

                // 放行：让 Claude Code 正常执行
                return {
                  hookEventName: "PreToolUse" as const,
                };
              },
            ],
          },
        ],
      },
    },
  });

  for await (const message of q) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") {
          process.stdout.write(block.text);
        }
      }
    } else if (message.type === "result") {
      console.log("\n");
      if (message.subtype === "success") {
        console.log(`结果: ${message.result}`);
      } else {
        console.error(`错误: ${message.error}`);
      }
    }
  }

  console.log(`\n=== 拦截统计 ===`);
  console.log(`共拦截 ${interceptedTools.length} 次工具调用:`);
  for (const t of interceptedTools) {
    console.log(`  [${t.timestamp}ms] ${t.tool}: ${JSON.stringify(t.input).slice(0, 100)}`);
  }
}

main().catch(console.error);
