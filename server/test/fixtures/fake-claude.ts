import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// ============================================================
// FakeClaude Fixture
//
// 生成一个可执行的 fake-claude stub，行为与真实 claude 完全兼容：
//   1. 保存 argv 到 AXON_FAKE_CLAUDE_ARGS_FILE
//   2. 收到 control_request/initialize → 响应 control_response/success，并记录 callbackId
//   3. 收到第一个 user 消息 → 发 hook_callback（触发 PreToolUse），命令为 options.command
//   4. 收到 control_response（hook 响应）→ 发 assistant 文本 + result/success，退出
//
// stdin 内容同时追加到 AXON_FAKE_CLAUDE_STDIN_FILE，供测试断言。
// ============================================================

export interface FakeClaudeOptions {
  /** 触发的 Bash 命令，默认 "pwd" */
  command?: string;
}

export interface FakeClaudeHandle {
  executablePath: string;
  cleanup(): Promise<void>;
}

export async function writeFakeClaude(options?: FakeClaudeOptions): Promise<FakeClaudeHandle> {
  const command = options?.command ?? "pwd";

  const tempDir = await mkdtemp(path.join(tmpdir(), "axon-fake-claude-"));
  const executablePath = path.join(tempDir, "fake-claude");
  const nodeScriptPath = `${executablePath}.mjs`;

  const wrapper = `#!/bin/sh
exec node "${nodeScriptPath}" "$@"
`;

  // 使用 JSON.stringify 将命令安全地嵌入脚本，避免任何转义问题
  const commandLiteral = JSON.stringify(command);

  const script = String.raw`#!/usr/bin/env node
import { appendFile, writeFile } from "node:fs/promises";
import process from "node:process";
import readline from "node:readline";

const argsFile = process.env.AXON_FAKE_CLAUDE_ARGS_FILE;
const stdinFile = process.env.AXON_FAKE_CLAUDE_STDIN_FILE;
if (!argsFile || !stdinFile) {
  console.error("missing fake claude env");
  process.exit(1);
}

await writeFile(argsFile, JSON.stringify(process.argv.slice(2)), "utf8");

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

let callbackId = "";
let hookRequestId = "";
let userSeen = false;

function emit(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

for await (const line of rl) {
  if (!line.trim()) continue;
  await appendFile(stdinFile, line + "\n", "utf8");
  const message = JSON.parse(line);

  if (message.type === "control_request" && message.request?.subtype === "initialize") {
    callbackId = message.request.hooks?.PreToolUse?.[0]?.hookCallbackIds?.[0] ?? "";
    emit({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: {
          commands: [],
          models: [],
          agents: [],
          account: null,
        },
      },
    });
    continue;
  }

  if (message.type === "user" && !userSeen) {
    userSeen = true;
    hookRequestId = "hook-request-1";
    emit({
      type: "control_request",
      request_id: hookRequestId,
      request: {
        subtype: "hook_callback",
        callback_id: callbackId,
        tool_use_id: "toolu_fake_1",
        input: {
          tool_name: "Bash",
          tool_use_id: "toolu_fake_1",
          tool_input: { command: ` + commandLiteral + ` },
        },
      },
    });
    continue;
  }

  if (message.type === "control_response" && message.response?.request_id === hookRequestId) {
    const additionalContext = message.response?.response?.additionalContext ?? "";
    emit({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "fake assistant: " + additionalContext }],
      },
    });
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "fake done",
    });
    break;
  }
}
`;

  await writeFile(executablePath, wrapper, "utf8");
  await chmod(executablePath, 0o755);
  await writeFile(nodeScriptPath, script, "utf8");
  await chmod(nodeScriptPath, 0o755);

  return {
    executablePath,
    cleanup: () => rm(tempDir, { recursive: true, force: true }),
  };
}
