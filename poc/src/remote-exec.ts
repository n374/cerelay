/**
 * POC 3: 远程执行模拟
 *
 * 验证 PreToolUse Hook 能否完全接管工具执行：
 * - Hook 拦截工具调用
 * - 转发给 "Hand" 模拟执行
 * - 通过 deny + additionalContext 将 Hand 的结果注入给 LLM
 *
 * 这是 Cerelay 远程执行的核心机制验证。
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

// 模拟 Hand 端的工具执行器
class MockHandExecutor {
  private execLog: Array<{
    tool: string;
    input: unknown;
    result: string;
    latencyMs: number;
  }> = [];

  async execute(
    toolName: string,
    input: Record<string, unknown>
  ): Promise<string> {
    const start = Date.now();
    let result: string;

    switch (toolName) {
      case "Bash": {
        const cmd = String(input.command || "");
        console.log(`  [Hand] 执行命令: ${cmd}`);
        if (cmd.includes("echo")) {
          const match = cmd.match(/echo\s+["']?([^"'\n]+)["']?/);
          result = match ? match[1].trim() : "";
        } else if (cmd.includes("ls")) {
          result =
            "total 5\ndrwxr-xr-x  proxy/\n-rw-r--r--  README.md\ndrwxr-xr-x  poc/\n-rw-r--r--  .gitignore\ndrwxr-xr-x  .claude/";
        } else if (cmd.includes("pwd")) {
          result = "/Users/remote-user/projects/cerelay";
        } else {
          result = `[Hand Mock] 已执行: ${cmd}\nexit code: 0`;
        }
        break;
      }
      case "Read": {
        const path = String(input.file_path || "");
        console.log(`  [Hand] 读取文件: ${path}`);
        if (path.includes("README")) {
          result = "# Cerelay\n\nClaude Code 的分体式架构";
        } else {
          result = `[Hand Mock] 文件内容: ${path}`;
        }
        break;
      }
      case "Glob": {
        console.log(`  [Hand] 搜索文件: ${JSON.stringify(input)}`);
        result = "proxy/dispatch.sh\nproxy/lib.sh\nproxy/init-proxy.sh";
        break;
      }
      case "Grep": {
        console.log(`  [Hand] 搜索内容: ${JSON.stringify(input)}`);
        result = "proxy/lib.sh:24:proxy_get_field()";
        break;
      }
      default: {
        console.log(
          `  [Hand] 工具 ${toolName}: ${JSON.stringify(input).slice(0, 100)}`
        );
        result = `[Hand Mock] ${toolName} 执行完成`;
      }
    }

    const latency = Date.now() - start;
    this.execLog.push({ tool: toolName, input, result, latencyMs: latency });
    return result;
  }

  getStats() {
    return {
      totalCalls: this.execLog.length,
      log: this.execLog,
    };
  }
}

async function main() {
  console.log("=== Cerelay POC: 远程执行模拟 (deny + additionalContext) ===\n");

  const hand = new MockHandExecutor();
  const startTime = Date.now();

  const q = query({
    prompt:
      "执行 `echo hello-from-brain` 命令，然后列出当前目录的文件。用两句话总结你看到了什么。",
    options: {
      cwd: process.cwd(),
      model: "claude-haiku-4-5-20251001",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: 5,
      hooks: {
        PreToolUse: [
          {
            matcher: ".*",
            hooks: [
              async (input) => {
                const elapsed = Date.now() - startTime;
                console.log(
                  `\n[${elapsed}ms] 🔧 Brain 拦截: ${input.tool_name}`
                );

                // 转发给 Hand 执行
                const result = await hand.execute(
                  input.tool_name,
                  input.tool_input as Record<string, unknown>
                );
                console.log(
                  `  [Hand→Brain] 结果 (${result.length} chars): ${result.slice(0, 100)}`
                );

                // 通过 deny + additionalContext 将 Hand 的结果注入给 LLM
                return {
                  hookEventName: "PreToolUse" as const,
                  permissionDecision: "deny" as const,
                  permissionDecisionReason:
                    "Tool executed remotely via Cerelay Hand",
                  additionalContext: result,
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
        console.log(`✅ 最终结果: ${message.result}`);
      } else {
        console.error(`❌ 错误: ${message.error}`);
      }
    }
  }

  const stats = hand.getStats();
  const totalTime = Date.now() - startTime;
  console.log(`\n=== Hand 执行统计 ===`);
  console.log(`总调用: ${stats.totalCalls} 次`);
  console.log(`总耗时: ${totalTime}ms`);
  for (const entry of stats.log) {
    console.log(
      `  ${entry.tool} (${entry.latencyMs}ms): ${JSON.stringify(entry.input).slice(0, 80)}`
    );
  }
}

main().catch(console.error);
