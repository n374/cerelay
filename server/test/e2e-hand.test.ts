/**
 * e2e-hand.test.ts
 *
 * Brain↔Hand 真端到端测试：
 *   - AxonServer 进程内启动（port:0 动态端口）
 *   - HandClient 进程内实例化，通过 WebSocket 连接 Server
 *   - fake-claude 发出 Bash tool_call（echo brain-hand-e2e）
 *   - HandClient 的 ToolExecutor 真实执行 Bash，将 tool_result 通过 WebSocket 回传
 *   - fake-claude 将 tool_result 原始输出作为 text_chunk 输出，并发 session_end
 *
 * 验证路径：Hand 收到 tool_call → Bash 真跑 → tool_result 回传 → text_chunk + session_end 到达
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AxonServer } from "../src/server.js";
import { HandClient } from "../../hand/src/client.js";
import { writeFakeClaude } from "./fixtures/fake-claude.js";

// ============================================================
// 辅助：恢复环境变量
// ============================================================

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

// ============================================================
// e2e 测试
// ============================================================

test(
  "Hand↔Brain e2e: HandClient 真实执行 Bash tool_call 并将结果回传 Brain",
  { concurrency: false, timeout: 15_000 },
  async (t) => {
    // ---- 1. 准备 fake-claude fixture ----
    const argsDir = await mkdtemp(path.join(tmpdir(), "axon-e2e-args-"));
    const argsFile = path.join(argsDir, "argv.json");
    const stdinFile = path.join(argsDir, "stdin.jsonl");

    const fake = await writeFakeClaude({ command: "echo brain-hand-e2e" });

    const originalExecutable = process.env.CLAUDE_CODE_EXECUTABLE;
    const originalArgsFile = process.env.AXON_FAKE_CLAUDE_ARGS_FILE;
    const originalStdinFile = process.env.AXON_FAKE_CLAUDE_STDIN_FILE;

    process.env.CLAUDE_CODE_EXECUTABLE = fake.executablePath;
    process.env.AXON_FAKE_CLAUDE_ARGS_FILE = argsFile;
    process.env.AXON_FAKE_CLAUDE_STDIN_FILE = stdinFile;

    t.after(() => {
      restoreEnvVar("CLAUDE_CODE_EXECUTABLE", originalExecutable);
      restoreEnvVar("AXON_FAKE_CLAUDE_ARGS_FILE", originalArgsFile);
      restoreEnvVar("AXON_FAKE_CLAUDE_STDIN_FILE", originalStdinFile);
    });
    t.after(async () => {
      await fake.cleanup();
      await rm(argsDir, { recursive: true, force: true });
    });

    // ---- 2. 启动 AxonServer ----
    const server = new AxonServer({
      model: "claude-test",
      port: 0,
      sessionCleanupIntervalMs: 5_000,
      sessionResumeGraceMs: 10_000,
    });

    t.after(async () => {
      await server.shutdown();
    });

    await server.start();
    const port = server.getListenPort();

    // ---- 3. 启动 HandClient ----
    const client = new HandClient(
      `ws://127.0.0.1:${port}/ws`,
      process.cwd(),
      { interactiveOutput: false }
    );

    t.after(() => {
      client.close();
    });

    await client.ensureSession({
      cwd: process.cwd(),
      allowCreateOnRestoreFailure: false,
    });

    // ---- 4. 收集回调事件 ----
    const textChunks: string[] = [];
    const toolCalls: Array<{ toolName: string; requestId: string; input: unknown }> = [];
    const toolCallCompletes: Array<{ toolName: string; requestId: string }> = [];
    let sessionEndResult: string | undefined;
    let sessionEndError: string | undefined;

    const callbacks = {
      onTextChunk: (text: string) => {
        textChunks.push(text);
      },
      onToolCall: (toolName: string, requestId: string, input: unknown) => {
        toolCalls.push({ toolName, requestId, input });
      },
      onToolCallComplete: (toolName: string, requestId: string) => {
        toolCallCompletes.push({ toolName, requestId });
      },
    };

    // ---- 5. 发送 prompt 并等待 session_end ----
    await client.sendPrompt("请帮我执行一条命令");

    // runWithCallbacks 阻塞直到 session_end 到达
    await client.runWithCallbacks(callbacks);

    // session_end 到达后，从 client 取结果
    const lastResult = client.getLastResult();
    sessionEndResult = lastResult.result;
    sessionEndError = lastResult.error;

    // ---- 6. 断言 ----

    // 6a. Hand 收到了 Bash tool_call
    assert.ok(toolCalls.length >= 1, `期望至少 1 个 tool_call，实际 ${toolCalls.length} 个`);
    const bashCall = toolCalls.find((c) => c.toolName === "Bash");
    assert.ok(bashCall !== undefined, "期望收到 Bash tool_call");
    const bashInput = bashCall!.input as { command?: string };
    assert.equal(bashInput.command, "echo brain-hand-e2e", "Bash 命令应为 echo brain-hand-e2e");

    // 6b. tool_call 完成后有 tool_call_complete
    assert.ok(toolCallCompletes.length >= 1, `期望至少 1 个 tool_call_complete，实际 ${toolCallCompletes.length} 个`);
    assert.ok(
      toolCallCompletes.some((c) => c.toolName === "Bash"),
      "期望收到 Bash tool_call_complete"
    );

    // 6c. fake-claude 将 Hand 侧 Bash 原始输出作为 text_chunk 输出
    //     BrainSession 通过 PreToolUse hook 将 stdout/stderr/exit_code 文本化后
    //     作为 additionalContext 返回给 fake-claude。
    assert.ok(textChunks.length >= 1, `期望至少 1 个 text_chunk，实际 ${textChunks.length} 个`);
    const allText = textChunks.join("");
    assert.ok(
      allText.includes("fake assistant:"),
      `期望 text_chunk 包含 "fake assistant:"，实际: "${allText}"`
    );
    assert.ok(
      allText.includes("stdout:\nbrain-hand-e2e\n"),
      `期望 text_chunk 包含 Bash stdout（证明 Brain 看到了 Hand 原始输出），实际: "${allText}"`
    );
    assert.ok(
      allText.includes("exit_code: 0"),
      `期望 text_chunk 包含 "exit_code: 0"（证明 Bash 真实执行），实际: "${allText}"`
    );

    // 6d. session_end 正常到达
    assert.equal(sessionEndResult, "fake done", `期望 session_end.result = "fake done"，实际: "${sessionEndResult}"`);
    assert.equal(sessionEndError, undefined, `期望 session_end.error 为 undefined，实际: "${sessionEndError}"`);

    const argsRecord = JSON.parse(await readFile(argsFile, "utf8")) as { argv: string[]; cwd: string };
    assert.ok(
      argsRecord.cwd.includes("axon-claude-"),
      `期望 fake Claude 在注入工作区启动，实际 cwd: "${argsRecord.cwd}"`
    );
  }
);
