// Phase 3 集成测试：
// 1. ClaudePtySession.dispatchToolToClient 把 builtin toolName 透传到 client
//    转发链（与 PreToolUse hook 路径共用 executeToolViaClient）
// 2. handleInjectedPreToolUse 收到 mcp__cerelay__* 时直接 allow（不走 client
//    routed 路径，避免跟 stdio MCP 双重执行）
import test from "node:test";
import assert from "node:assert/strict";
import { ClaudePtySession, type PtySessionTransport } from "../src/pty-session.js";
import type { ClaudeSessionRuntime } from "../src/claude-session-runtime.js";

function createMockRuntime(): ClaudeSessionRuntime {
  return {
    cwd: "/sdk/cwd",
    env: { HOME: "/home/node", PATH: "/usr/bin" },
    rootDir: "/sdk/root",
    cleanup: async () => undefined,
  };
}

interface Capture {
  toolCalls: Array<{ requestId: string; toolName: string; toolUseId: string | undefined; input: unknown }>;
  completes: Array<{ requestId: string; toolName: string }>;
}

function createCapture(): Capture {
  return { toolCalls: [], completes: [] };
}

function createTransport(
  capture: Capture,
  onToolCall: (requestId: string, toolName: string, input: unknown) => void,
): PtySessionTransport {
  return {
    sendOutput: async () => undefined,
    sendExit: async () => undefined,
    sendToolCall: async (sessionId, requestId, toolName, toolUseId, input) => {
      capture.toolCalls.push({ requestId, toolName, toolUseId, input });
      onToolCall(requestId, toolName, input);
    },
    sendToolCallComplete: async (sessionId, requestId, toolName) => {
      capture.completes.push({ requestId, toolName });
    },
  };
}

test("Phase 3: dispatchToolToClient 把 builtin Bash 透传到 client，路径重写 cwd→clientCwd", async () => {
  const capture = createCapture();
  const session = new ClaudePtySession({
    id: "pty-shadow-mcp-1",
    cwd: "/Users/dev/project",
    runtime: createMockRuntime(),
    clientHomeDir: "/Users/dev",
    transport: createTransport(capture, (requestId) => {
      session.resolveToolResult(requestId, {
        output: { stdout: "ok\n", stderr: "", exit_code: 0 },
      });
    }),
  });

  const result = await session.dispatchToolToClient("Bash", {
    command: "cd /sdk/cwd && ls",
  });

  assert.equal(capture.toolCalls.length, 1);
  // sdkCwd 必须被重写成 clientCwd
  assert.deepEqual(capture.toolCalls[0]?.input, {
    command: "cd /Users/dev/project && ls",
  });
  // dispatch 不带 toolUseId（MCP tools/call 不用 anthropic tool_use_id 概念）
  assert.equal(capture.toolCalls[0]?.toolUseId, undefined);
  assert.equal(result.output && (result.output as { exit_code: number }).exit_code, 0);

  await session.close();
});

test("Phase 3: handleInjectedPreToolUse 收到 mcp__cerelay__bash 直接 allow，不进 client 转发", async () => {
  const capture = createCapture();
  const session = new ClaudePtySession({
    id: "pty-shadow-mcp-2",
    cwd: "/Users/dev/project",
    runtime: createMockRuntime(),
    transport: createTransport(capture, () => {
      throw new Error("不应该被调用：mcp__cerelay__* 不应进 client 转发");
    }),
  });

  const hookResult = await session.handleInjectedPreToolUse({
    tool_name: "mcp__cerelay__bash",
    tool_use_id: "toolu_x",
    tool_input: { command: "ls" },
  });

  assert.equal(hookResult.hookSpecificOutput?.permissionDecision, "allow");
  assert.equal(capture.toolCalls.length, 0);
  await session.close();
});

test("Phase 3: 用户自配 mcp__user__* 仍然走 client 转发（不被 shadow 排除规则误伤）", async () => {
  const capture = createCapture();
  const session = new ClaudePtySession({
    id: "pty-shadow-mcp-3",
    cwd: "/Users/dev/project",
    runtime: createMockRuntime(),
    transport: createTransport(capture, (requestId) => {
      session.resolveToolResult(requestId, { output: { ok: true } });
    }),
  });

  const hookResult = await session.handleInjectedPreToolUse({
    tool_name: "mcp__user__ping",
    tool_use_id: "toolu_y",
    tool_input: { msg: "hi" },
  });

  assert.equal(hookResult.hookSpecificOutput?.permissionDecision, "deny");
  assert.equal(capture.toolCalls.length, 1);
  assert.equal(capture.toolCalls[0]?.toolName, "mcp__user__ping");
  await session.close();
});
