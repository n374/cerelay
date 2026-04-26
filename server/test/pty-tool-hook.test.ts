import test from "node:test";
import assert from "node:assert/strict";
import { ClaudePtySession } from "../src/pty-session.js";

test("ClaudePtySession relays PreToolUse through Client and rewrites Server-local paths", async (t) => {
  const sent: Array<{ type: string; requestId: string; toolName: string; input?: unknown }> = [];
  let session!: ClaudePtySession;

  session = new ClaudePtySession({
    id: "pty-hook-test",
    cwd: "/Users/n374/Documents/Code/cerelay",
    runtime: {
      cwd: "/tmp/cerelay-claude-pty-hook-test",
      env: {
        HOME: "/home/node",
      },
      rootDir: "/tmp/cerelay-claude-pty-hook-test-root",
      cleanup: async () => {},
    },
    clientHomeDir: "/Users/n374",
    transport: {
      sendOutput: async () => {},
      sendExit: async () => {},
      sendToolCall: async (_sessionId, requestId, toolName, _toolUseId, input) => {
        sent.push({
          type: "tool_call",
          requestId,
          toolName,
          input,
        });
        queueMicrotask(() => {
          session.resolveToolResult(requestId, {
            output: {
              stdout: "/Users/n374/Documents/Code/cerelay\n",
              stderr: "",
              exit_code: 0,
            },
          });
        });
      },
      sendToolCallComplete: async (_sessionId, requestId, toolName) => {
        sent.push({
          type: "tool_call_complete",
          requestId,
          toolName,
        });
      },
    },
  });

  t.after(async () => {
    await session.close();
  });

  const result = await session.handleInjectedPreToolUse({
    tool_name: "Bash",
    tool_use_id: "toolu_pty_1",
    tool_input: {
      command: "cd /tmp/cerelay-claude-pty-hook-test && cat /home/node/.claude.json && pwd",
    },
  });

  assert.equal(result.hookSpecificOutput?.permissionDecision, "deny");
  // 真实 tool 输出必须装进 permissionDecisionReason —— CC 在 deny 分支会把它
  // 作为 tool_result.content 反馈给 Claude；additionalContext 走 isMeta 元消息
  // 通道会被过滤，不能作为唯一回注通道。这里两条字段携带同一份内容。
  const expectedRendered = "stdout:\n/Users/n374/Documents/Code/cerelay\n\nexit_code: 0";
  assert.equal(result.hookSpecificOutput?.permissionDecisionReason, expectedRendered);
  assert.equal(result.hookSpecificOutput?.additionalContext, expectedRendered);
  assert.deepEqual(sent[0], {
    type: "tool_call",
    requestId: sent[0]?.requestId,
    toolName: "Bash",
    input: {
      command: "cd /Users/n374/Documents/Code/cerelay && cat /Users/n374/.claude.json && pwd",
    },
  });
  assert.deepEqual(sent[1], {
    type: "tool_call_complete",
    requestId: sent[0]?.requestId,
    toolName: "Bash",
  });
});
