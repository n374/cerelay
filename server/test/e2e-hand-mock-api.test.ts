import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { AxonServer } from "../src/server.js";
import { resolveClaudeCodeExecutable } from "../src/session.js";
import { HandClient } from "../../hand/src/client.js";
import {
  startMockClaudeApiServer,
  type MockClaudeApiHandle,
  type MockClaudeApiScenario,
} from "./fixtures/mock-claude-api.js";

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function rmWithRetries(target: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

interface E2eRunResult {
  client: HandClient;
  handCwd: string;
  mockApi: MockClaudeApiHandle;
  textChunks: string[];
  toolCalls: Array<{ toolName: string; requestId: string; input: unknown }>;
  toolCallCompletes: Array<{ toolName: string; requestId: string }>;
  toolResults: Array<{ toolName: string; requestId: string; output: unknown; error?: string }>;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`等待超时: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function runMockClaudeE2e(
  t: TestContext,
  scenario: string | MockClaudeApiScenario,
  prompt: string
): Promise<E2eRunResult> {
  let claudeExecutable: string;
  try {
    claudeExecutable = resolveClaudeCodeExecutable();
  } catch {
    t.skip("real claude executable is not available in this environment");
    throw new Error("unreachable after skip");
  }

  const mockApi = await startMockClaudeApiServer(scenario);
  t.after(async () => {
    await mockApi.close();
  });

  const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const originalExecutable = process.env.CLAUDE_CODE_EXECUTABLE;

  process.env.ANTHROPIC_BASE_URL = mockApi.baseUrl;
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.CLAUDE_CODE_EXECUTABLE = claudeExecutable;

  t.after(() => {
    restoreEnvVar("ANTHROPIC_BASE_URL", originalBaseUrl);
    restoreEnvVar("ANTHROPIC_API_KEY", originalApiKey);
    restoreEnvVar("ANTHROPIC_AUTH_TOKEN", originalAuthToken);
    restoreEnvVar("CLAUDE_CODE_EXECUTABLE", originalExecutable);
  });

  const handCwd = await mkdtemp(path.join(tmpdir(), "axon-hand-cwd-"));
  const tempHome = await mkdtemp(path.join(tmpdir(), "axon-hand-home-"));
  const originalHome = process.env.HOME;
  process.env.HOME = tempHome;

  t.after(() => {
    restoreEnvVar("HOME", originalHome);
  });
  t.after(async () => {
    await rmWithRetries(handCwd);
    await rmWithRetries(tempHome);
  });

  const server = new AxonServer({
    model: "claude-sonnet-4-20250514",
    port: 0,
    sessionCleanupIntervalMs: 5_000,
    sessionResumeGraceMs: 10_000,
  });
  t.after(async () => {
    await server.shutdown();
  });

  await server.start();

  const client = new HandClient(`ws://127.0.0.1:${server.getListenPort()}/ws`, handCwd, {
    interactiveOutput: false,
  });
  t.after(() => {
    client.close();
  });

  await client.ensureSession({
    cwd: handCwd,
    allowCreateOnRestoreFailure: false,
  });

  const textChunks: string[] = [];
  const toolCalls: Array<{ toolName: string; requestId: string; input: unknown }> = [];
  const toolCallCompletes: Array<{ toolName: string; requestId: string }> = [];
  const toolResults: Array<{ toolName: string; requestId: string; output: unknown; error?: string }> = [];

  await client.sendPrompt(prompt);
  await client.runWithCallbacks({
    onTextChunk: (text) => {
      textChunks.push(text);
    },
    onToolCall: (toolName, requestId, input) => {
      toolCalls.push({ toolName, requestId, input });
    },
    onToolCallComplete: (toolName, requestId) => {
      toolCallCompletes.push({ toolName, requestId });
    },
    onToolResult: (toolName, requestId, output, error) => {
      toolResults.push({ toolName, requestId, output, error });
    },
  });

  return {
    client,
    handCwd,
    mockApi,
    textChunks,
    toolCalls,
    toolCallCompletes,
    toolResults,
  };
}

test(
  "Hand↔Brain e2e via mock Claude API server: Bash is triggered by mock API and executed through Hand",
  { concurrency: false, timeout: 30_000 },
  async (t) => {
    const run = await runMockClaudeE2e(t, "pwd", "请执行 pwd 并告诉我结果");

    const lastResult = run.client.getLastResult();
    const observedToolResult = run.mockApi.observedToolResult();
    const bashResult = run.toolResults.find((result) => result.toolName === "Bash");
    const bashStdout =
      bashResult &&
      bashResult.output &&
      typeof bashResult.output === "object" &&
      typeof (bashResult.output as { stdout?: unknown }).stdout === "string"
        ? (bashResult.output as { stdout: string }).stdout.trim()
        : null;
    const normalizedHandCwd = await realpath(run.handCwd);
    const normalizedBashStdout = bashStdout ? await realpath(bashStdout) : null;

    assert.equal(run.mockApi.promptRequestCount(), 2, "mock API should receive exactly 2 /v1/messages requests");
    assert.ok(run.toolCalls.some((call) => call.toolName === "Bash"), "Hand should receive a Bash tool_call");
    assert.ok(
      run.toolCallCompletes.some((call) => call.toolName === "Bash"),
      "Hand should receive a Bash tool_call_complete"
    );
    assert.ok(bashResult, "Hand should produce a raw Bash tool_result");
    assert.equal(bashResult?.error, undefined, "Bash tool_result should not contain an execution error");
    assert.equal(
      normalizedBashStdout,
      normalizedHandCwd,
      "pwd stdout should equal the Hand cwd, proving the command executed on Hand instead of Brain"
    );
    assert.ok(
      !bashStdout?.includes("axon-claude-"),
      `pwd stdout should not point at the Brain Claude injection workspace, actual: ${bashStdout}`
    );
    assert.equal(
      observedToolResult,
      "Tool response ready",
      "follow-up request should carry the hook decision proving the Bash call was routed through Hand"
    );

    const allText = run.textChunks.join("");
    assert.ok(
      allText.includes("mock api final: Tool response ready"),
      `expected final assistant text to include the mocked hook result, actual: ${allText}`
    );
    assert.equal(lastResult.error, undefined);
    assert.equal(lastResult.result, "mock api final: Tool response ready");
  }
);

test(
  "Hand↔Brain e2e via mock Claude API server: Task-created child agent still routes Bash through Hand hook",
  { concurrency: false, timeout: 30_000 },
  async (t) => {
    let claudeExecutable: string;
    try {
      claudeExecutable = resolveClaudeCodeExecutable();
    } catch {
      t.skip("real claude executable is not available in this environment");
      return;
    }

    const mockApi = await startMockClaudeApiServer({
      type: "task_subagent_bash",
      command: "pwd",
    });
    t.after(async () => {
      await mockApi.close();
    });

    const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
    const originalExecutable = process.env.CLAUDE_CODE_EXECUTABLE;
    process.env.ANTHROPIC_BASE_URL = mockApi.baseUrl;
    process.env.ANTHROPIC_API_KEY = "test-key";
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.CLAUDE_CODE_EXECUTABLE = claudeExecutable;
    t.after(() => {
      restoreEnvVar("ANTHROPIC_BASE_URL", originalBaseUrl);
      restoreEnvVar("ANTHROPIC_API_KEY", originalApiKey);
      restoreEnvVar("ANTHROPIC_AUTH_TOKEN", originalAuthToken);
      restoreEnvVar("CLAUDE_CODE_EXECUTABLE", originalExecutable);
    });

    const handCwd = await mkdtemp(path.join(tmpdir(), "axon-hand-cwd-"));
    const tempHome = await mkdtemp(path.join(tmpdir(), "axon-hand-home-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    t.after(() => {
      restoreEnvVar("HOME", originalHome);
    });
    t.after(async () => {
      await rmWithRetries(handCwd);
      await rmWithRetries(tempHome);
    });

    const server = new AxonServer({
      model: "claude-sonnet-4-20250514",
      port: 0,
      sessionCleanupIntervalMs: 5_000,
      sessionResumeGraceMs: 10_000,
    });
    t.after(async () => {
      await server.shutdown();
    });
    await server.start();

    const client = new HandClient(`ws://127.0.0.1:${server.getListenPort()}/ws`, handCwd, {
      interactiveOutput: false,
    });
    t.after(() => {
      client.close();
    });
    await client.ensureSession({
      cwd: handCwd,
      allowCreateOnRestoreFailure: false,
    });

    const toolCalls: Array<{ toolName: string; requestId: string; input: unknown }> = [];
    const toolCallCompletes: Array<{ toolName: string; requestId: string }> = [];
    const toolResults: Array<{ toolName: string; requestId: string; output: unknown; error?: string }> = [];
    const textChunks: string[] = [];

    await client.sendPrompt("请创建一个子 Agent 查看当前目录，并告诉我它看到的路径");
    const runPromise = client.runWithCallbacks({
      onTextChunk: (text) => {
        textChunks.push(text);
      },
      onToolCall: (toolName, requestId, input) => {
        toolCalls.push({ toolName, requestId, input });
      },
      onToolCallComplete: (toolName, requestId) => {
        toolCallCompletes.push({ toolName, requestId });
      },
      onToolResult: (toolName, requestId, output, error) => {
        toolResults.push({ toolName, requestId, output, error });
      },
    });

    await waitFor(
      () => toolResults.some((result) => result.toolName === "Bash"),
      10_000,
      "子 Agent Bash tool_result"
    );

    await runPromise;

    const observedTaskToolInput = mockApi.observedTaskToolInput();
    const observedRequests = mockApi.observedRequests();
    const bashResult = toolResults.find((result) => result.toolName === "Bash");
    const bashStdout =
      bashResult &&
      bashResult.output &&
      typeof bashResult.output === "object" &&
      typeof (bashResult.output as { stdout?: unknown }).stdout === "string"
        ? (bashResult.output as { stdout: string }).stdout.trim()
        : null;
    const normalizedHandCwd = await realpath(handCwd);
    const normalizedBashStdout = bashStdout ? await realpath(bashStdout) : null;

    assert.ok(observedTaskToolInput, "mock API should issue a Task tool_use to create a child agent");
    assert.ok(
      observedRequests.length >= 2,
      `mock API should record at least parent and child request turns, actual=${observedRequests.length}`
    );
    assert.ok(toolCalls.some((call) => call.toolName === "Bash"), "child agent should still trigger a Bash tool_call on Hand");
    assert.ok(
      toolCallCompletes.some((call) => call.toolName === "Bash"),
      "child agent Bash call should still emit tool_call_complete"
    );
    assert.ok(bashResult, "child agent should still produce a raw Bash tool_result through Hand");
    assert.equal(bashResult?.error, undefined, "child agent Bash tool_result should not contain an execution error");
    assert.equal(
      normalizedBashStdout,
      normalizedHandCwd,
      "child agent pwd stdout should equal the Hand cwd, proving the sub-agent command executed on Hand"
    );
    assert.equal(client.getLastResult().error, undefined);
    assert.ok(
      textChunks.join("").includes("child agent final: Tool response ready"),
      `expected final text to include the child-agent hook result, actual: ${textChunks.join("")}`
    );
  }
);
