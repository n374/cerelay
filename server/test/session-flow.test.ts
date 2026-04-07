import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { BrainSession } from "../src/session.js";
import type { ServerToHandMessage } from "../src/protocol.js";
import { writeFakeClaude } from "./fixtures/fake-claude.js";

test("BrainSession streams thought/text chunks and passes Claude executable options to query runner", async (t) => {
  const fake = await writeFakeClaude({ command: "pwd" });
  const originalExecutable = process.env.CLAUDE_CODE_EXECUTABLE;
  process.env.CLAUDE_CODE_EXECUTABLE = fake.executablePath;

  t.after(async () => {
    if (originalExecutable === undefined) {
      delete process.env.CLAUDE_CODE_EXECUTABLE;
    } else {
      process.env.CLAUDE_CODE_EXECUTABLE = originalExecutable;
    }
    await fake.cleanup();
  });

  const sent: ServerToHandMessage[] = [];
  let queryInput: { prompt: string; options: { cwd: string; model: string; pathToClaudeCodeExecutable: string } } | null = null;

  const session = BrainSession.createSession({
    id: "sess-flow-1",
    cwd: "/workspace/demo",
    model: "claude-test",
    transport: {
      send: async (message) => {
        sent.push(message);
      },
    },
    queryRunner: (input) => {
      queryInput = {
        prompt: input.prompt,
        options: {
          cwd: input.options.cwd,
          model: input.options.model,
          pathToClaudeCodeExecutable: input.options.pathToClaudeCodeExecutable,
        },
      };
      return (async function* () {
        yield {
          type: "assistant",
          message: {
            content: [
              { type: "thinking", thinking: "分析中" },
              { type: "text", text: "你好" },
            ],
          },
        };
        yield { type: "result", result: "完成" };
      })();
    },
  });

  await session.prompt("测试 prompt");

  assert.deepEqual(queryInput, {
    prompt: "测试 prompt",
    options: {
      cwd: "/workspace/demo",
      model: "claude-test",
      pathToClaudeCodeExecutable: fake.executablePath,
    },
  });
  assert.deepEqual(sent, [
    { type: "thought_chunk", sessionId: "sess-flow-1", text: "分析中" },
    { type: "text_chunk", sessionId: "sess-flow-1", text: "你好" },
    { type: "session_end", sessionId: "sess-flow-1", result: "完成", error: undefined },
  ]);
});

test("BrainSession relays tool calls through Hand and completes once tool_result arrives", async () => {
  const sent: ServerToHandMessage[] = [];
  let session!: BrainSession;

  session = BrainSession.createSession({
    id: "sess-flow-2",
    cwd: "/workspace/demo",
    model: "claude-test",
    transport: {
      send: async (message) => {
        sent.push(message);
        if (message.type === "tool_call") {
          queueMicrotask(() => {
            session.resolveToolResult(message.requestId, {
              output: { stdout: "/workspace/demo\n", exit_code: 0 },
              summary: "pwd 完成",
            });
          });
        }
      },
    },
    queryRunner: (input) => (async function* () {
      const hook = input.options.hooks.PreToolUse[0]?.hooks[0];
      assert.ok(hook);

      const decision = await hook({
        tool_name: "Bash",
        tool_use_id: "toolu_123",
        tool_input: { command: "pwd" },
      });

      assert.equal(decision.permissionDecisionReason, "Tool executed remotely via Axon Hand");
      assert.equal(decision.additionalContext, "pwd 完成");

      yield {
        type: "assistant",
        message: {
          content: [{ type: "text", text: `工具结果: ${decision.additionalContext}` }],
        },
      };
      yield { type: "result", result: "done" };
    })(),
  });

  await session.prompt("执行 pwd");

  assert.equal(sent[0]?.type, "tool_call");
  assert.equal(sent[1]?.type, "tool_call_complete");
  assert.deepEqual(sent[2], {
    type: "text_chunk",
    sessionId: "sess-flow-2",
    text: "工具结果: pwd 完成",
  });
  assert.deepEqual(sent[3], {
    type: "session_end",
    sessionId: "sess-flow-2",
    result: "done",
    error: undefined,
  });
});

test("BrainSession converts Claude runner failures into session_end errors", async () => {
  const sent: ServerToHandMessage[] = [];

  const session = BrainSession.createSession({
    id: "sess-flow-3",
    cwd: "/workspace/demo",
    model: "claude-test",
    transport: {
      send: async (message) => {
        sent.push(message);
      },
    },
    queryRunner: () => (async function* () {
      yield {
        type: "result",
        subtype: "error",
        error: "mock claude failed",
      };
    })(),
  });

  await session.prompt("失败 prompt");

  assert.deepEqual(sent, [
    {
      type: "session_end",
      sessionId: "sess-flow-3",
      result: undefined,
      error: "mock claude failed",
    },
  ]);
});
