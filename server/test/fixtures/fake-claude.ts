import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// ============================================================
// FakeClaude Fixture
//
// 生成一个可执行的 fake-claude stub，行为与真实 claude 完全兼容：
//   1. 追加保存 argv + cwd 到 AXON_FAKE_CLAUDE_ARGS_FILE(JSONL)
//   2. 收到 control_request/initialize → 响应 control_response/success
//   3. 收到第一个 user 消息 → 直接输出 assistant 文本 + result/success，退出
//
// stdin 内容同时追加到 AXON_FAKE_CLAUDE_STDIN_FILE，供测试断言。
// ============================================================

export interface FakeClaudeOptions {
  assistantText?: string;
}

export interface FakeClaudeHandle {
  executablePath: string;
  cleanup(): Promise<void>;
}

export async function writeFakeClaude(options?: FakeClaudeOptions): Promise<FakeClaudeHandle> {
  const assistantText = options?.assistantText ?? "fake assistant";

  const tempDir = await mkdtemp(path.join(tmpdir(), "axon-fake-claude-"));
  const executablePath = path.join(tempDir, "fake-claude");
  const nodeScriptPath = `${executablePath}.mjs`;

  const wrapper = `#!/bin/sh
exec node "${nodeScriptPath}" "$@"
`;

  const assistantTextLiteral = JSON.stringify(assistantText);

  const script = String.raw`#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import process from "node:process";
import readline from "node:readline";

const argsFile = process.env.AXON_FAKE_CLAUDE_ARGS_FILE;
const stdinFile = process.env.AXON_FAKE_CLAUDE_STDIN_FILE;
if (!argsFile || !stdinFile) {
  console.error("missing fake claude env");
  process.exit(1);
}

const resumeIndex = process.argv.indexOf("--resume");
const resumeSessionId = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : undefined;
const sessionId = resumeSessionId || "11111111-1111-4111-8111-111111111111";

await appendFile(argsFile, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
}) + "\n", "utf8");

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

let userSeen = false;

function emit(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

for await (const line of rl) {
  if (!line.trim()) continue;
  await appendFile(stdinFile, line + "\n", "utf8");
  const message = JSON.parse(line);

  if (message.type === "control_request" && message.request?.subtype === "initialize") {
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
    emit({
      type: "assistant",
      message: {
        content: [{ type: "text", text: ` + assistantTextLiteral + ` }],
      },
    });
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "fake done",
      session_id: sessionId,
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
