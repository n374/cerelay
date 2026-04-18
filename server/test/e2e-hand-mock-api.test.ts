import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { AxonServer } from "../src/server.js";
import { resolveClaudeCodeExecutable } from "../src/session.js";
import { HandClient } from "../../hand/src/client.js";
import { startMockClaudeApiServer } from "./fixtures/mock-claude-api.js";

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

test(
  "Hand↔Brain e2e via mock Claude API server: Bash is triggered by mock API and executed through Hand",
  { concurrency: false, timeout: 30_000 },
  async (t) => {
    let claudeExecutable: string;
    try {
      claudeExecutable = resolveClaudeCodeExecutable();
    } catch {
      t.skip("real claude executable is not available in this environment");
      return;
    }

    const mockApi = await startMockClaudeApiServer("pwd");
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
      await rm(handCwd, { recursive: true, force: true });
      await rm(tempHome, { recursive: true, force: true });
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

    await client.sendPrompt("请执行 pwd 并告诉我结果");
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

    const lastResult = client.getLastResult();
    const observedToolResult = mockApi.observedToolResult();
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

    assert.equal(mockApi.promptRequestCount(), 2, "mock API should receive exactly 2 /v1/messages requests");
    assert.ok(toolCalls.some((call) => call.toolName === "Bash"), "Hand should receive a Bash tool_call");
    assert.ok(
      toolCallCompletes.some((call) => call.toolName === "Bash"),
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

    const allText = textChunks.join("");
    assert.ok(
      allText.includes("mock api final: Tool response ready"),
      `expected final assistant text to include the mocked hook result, actual: ${allText}`
    );
    assert.equal(lastResult.error, undefined);
    assert.equal(lastResult.result, "mock api final: Tool response ready");
  }
);
