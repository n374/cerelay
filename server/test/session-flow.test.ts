import os from "node:os";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BrainSession } from "../src/session.js";
import type { ServerToHandMessage } from "../src/protocol.js";
import type { SdkMcpServerConfig } from "../src/mcp-types.js";
import { writeFakeClaude } from "./fixtures/fake-claude.js";

test("BrainSession streams thought/text chunks and passes Claude executable options to query runner", async (t) => {
  const fake = await writeFakeClaude();
  const sdkCwd = await mkdtemp(path.join(os.tmpdir(), "axon-session-flow-sdk-cwd-"));
  const originalExecutable = process.env.CLAUDE_CODE_EXECUTABLE;
  process.env.CLAUDE_CODE_EXECUTABLE = fake.executablePath;

  t.after(async () => {
    if (originalExecutable === undefined) {
      delete process.env.CLAUDE_CODE_EXECUTABLE;
    } else {
      process.env.CLAUDE_CODE_EXECUTABLE = originalExecutable;
    }
    await fake.cleanup();
    await rm(sdkCwd, { recursive: true, force: true });
  });

  const sent: ServerToHandMessage[] = [];
  let queryInput: { prompt: string; options: { cwd: unknown; model: string; pathToClaudeCodeExecutable: string } } | null = null;

  const session = BrainSession.createSession({
    id: "sess-flow-1",
    cwd: "/workspace/demo",
    model: "claude-test",
    sdkCwd,
    transport: {
      send: async (message) => {
        sent.push(message);
      },
    },
    queryRunner: (input) => {
      queryInput = {
        prompt: input.prompt,
        options: {
          // 捕获 cwd 字段以便断言 SDK 收到的是系统临时目录,而不是 Hand 的宿主机 cwd
          cwd: (input.options as { cwd?: unknown }).cwd,
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
      cwd: sdkCwd,
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

test("BrainSession passes Hand-discovered MCP proxy servers into query()", async () => {
  let capturedMcpServers: Record<string, SdkMcpServerConfig> | undefined;
  const proxyServer = new McpServer({ name: "demo", version: "1.0.0" });

  const session = BrainSession.createSession({
    id: "sess-flow-mcp",
    cwd: "/workspace/demo",
    model: "claude-test",
    mcpServers: {
      demo: {
        type: "sdk",
        name: "demo",
        instance: proxyServer,
      },
    },
    transport: {
      send: async () => {},
    },
    queryRunner: (input) => {
      capturedMcpServers = input.options.mcpServers;
      return (async function* () {
        yield { type: "result", result: "ok" };
      })();
    },
  });

  await session.prompt("mcp");

  assert.ok(capturedMcpServers);
  assert.equal(capturedMcpServers?.demo?.type, "sdk");
  assert.equal(capturedMcpServers?.demo?.name, "demo");
});

test("BrainSession resumes the real Claude session across prompts", async () => {
  const resumes: Array<string | undefined> = [];

  const session = BrainSession.createSession({
    id: "sess-flow-resume",
    cwd: "/workspace/demo",
    model: "claude-test",
    transport: {
      send: async () => {},
    },
    queryRunner: (input) => {
      resumes.push(input.options.resume);
      return (async function* () {
        yield {
          type: "result",
          result: input.options.resume ? "第二轮完成" : "第一轮完成",
          session_id: "11111111-1111-4111-8111-111111111111",
        };
      })();
    },
  });

  await session.prompt("第一问");
  await session.prompt("第二问");

  assert.deepEqual(resumes, [undefined, "11111111-1111-4111-8111-111111111111"]);
});

test("runPrompt 不透传 Hand 宿主机 cwd:使用系统临时目录避免 spawn ENOENT / regression for host cwd leaking", async (t) => {
  const fake = await writeFakeClaude();
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

  // 故意构造一个明显不存在的宿主机风格路径:如果 BrainSession 把它直接透传给 SDK,
  // child_process.spawn 会因 cwd ENOENT 立刻失败 —— 这正是 fix 之前的 bug。
  const hostCwd = "/Users/nobody/does-not-exist-xxx-regression";
  let capturedCwd: unknown = "<unset>";

  const session = BrainSession.createSession({
    id: "sess-flow-cwd-regression",
    cwd: hostCwd,
    model: "claude-test",
    transport: {
      send: async () => {},
    },
    queryRunner: (input) => {
      capturedCwd = (input.options as { cwd?: unknown }).cwd;
      return (async function* () {
        yield { type: "result", result: "ok" };
      })();
    },
  });

  await session.prompt("regression");

  // 1. 宿主机路径必须没有泄漏到 SDK
  assert.notEqual(capturedCwd, hostCwd);
  // 2. SDK 收到的是系统临时目录(方案 3 的承诺)
  assert.equal(capturedCwd, os.tmpdir());
  // 3. BrainSession 仍把宿主机路径作为元信息保留(供 Hand / 日志使用)
  assert.equal(session.info().cwd, hostCwd);
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
              output: { stdout: "/workspace/demo\n", stderr: "", exit_code: 0 },
              summary: "pwd 完成",
            });
          });
        }
      },
    },
    queryRunner: () => (async function* () {
      const decision = await session.handleInjectedPreToolUse({
        tool_name: "Bash",
        tool_use_id: "toolu_123",
        tool_input: { command: "pwd" },
      });

      assert.equal(decision.hookSpecificOutput?.permissionDecisionReason, "Tool response ready");
      assert.equal(decision.hookSpecificOutput?.additionalContext, "stdout:\n/workspace/demo\n\nexit_code: 0");

      yield {
        type: "assistant",
        message: {
          content: [{ type: "text", text: `工具结果: ${decision.hookSpecificOutput?.additionalContext ?? ""}` }],
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
    text: "工具结果: stdout:\n/workspace/demo\n\nexit_code: 0",
  });
  assert.deepEqual(sent[3], {
    type: "session_end",
    sessionId: "sess-flow-2",
    result: "done",
    error: undefined,
  });
});

test("BrainSession rewrites Claude-local file paths and injected cwd before handing tools to Hand", async () => {
  const sent: ServerToHandMessage[] = [];
  let session!: BrainSession;
  const sdkCwd = "/tmp/axon-claude-sess-123";
  const handCwd = "/Users/n374/Documents/Code/axon";
  const handHomeDir = "/Users/n374";

  session = BrainSession.createSession({
    id: "sess-flow-path-rewrite",
    claudeHomeDir: "/home/node",
    cwd: handCwd,
    handHomeDir,
    model: "claude-test",
    sdkCwd,
    transport: {
      send: async (message) => {
        sent.push(message);
        if (message.type === "tool_call") {
          session.resolveToolResult(message.requestId, {
            output: { stdout: "ok\n", stderr: "", exit_code: 0 },
            summary: "ok",
          });
        }
      },
    },
    queryRunner: () => (async function* () {
      await session.handleInjectedPreToolUse({
        tool_name: "Read",
        tool_use_id: "toolu_read",
        tool_input: { file_path: "/home/node/.claude/settings.json" },
      });
      await session.handleInjectedPreToolUse({
        tool_name: "Bash",
        tool_use_id: "toolu_bash",
        tool_input: { command: `cd ${sdkCwd} && cat /home/node/.claude.json && pwd` },
      });
      yield { type: "result", result: "done" };
    })(),
  });

  await session.prompt("path rewrite");

  const toolCalls = sent.filter((message): message is Extract<ServerToHandMessage, { type: "tool_call" }> => message.type === "tool_call");
  assert.equal(toolCalls.length, 2);
  assert.deepEqual(toolCalls[0]?.input, { file_path: "/Users/n374/.claude/settings.json" });
  assert.deepEqual(toolCalls[1]?.input, {
    command: "cd /Users/n374/Documents/Code/axon && cat /Users/n374/.claude.json && pwd",
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
