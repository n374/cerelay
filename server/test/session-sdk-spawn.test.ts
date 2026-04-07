import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { BrainSession } from "../src/session.js";
import type { ServerToHandMessage } from "../src/protocol.js";

const WORKDIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("BrainSession can drive the real SDK transport with a fake Claude executable", { concurrency: false }, async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "axon-fake-claude-"));
  const argsFile = path.join(tempDir, "argv.json");
  const stdinFile = path.join(tempDir, "stdin.jsonl");
  const executablePath = path.join(tempDir, "fake-claude");

  await writeFakeClaudeExecutable(executablePath);

  const originalExecutable = process.env.CLAUDE_CODE_EXECUTABLE;
  const originalArgsFile = process.env.AXON_FAKE_CLAUDE_ARGS_FILE;
  const originalStdinFile = process.env.AXON_FAKE_CLAUDE_STDIN_FILE;

  process.env.CLAUDE_CODE_EXECUTABLE = executablePath;
  process.env.AXON_FAKE_CLAUDE_ARGS_FILE = argsFile;
  process.env.AXON_FAKE_CLAUDE_STDIN_FILE = stdinFile;

  t.after(() => {
    restoreEnvVar("CLAUDE_CODE_EXECUTABLE", originalExecutable);
    restoreEnvVar("AXON_FAKE_CLAUDE_ARGS_FILE", originalArgsFile);
    restoreEnvVar("AXON_FAKE_CLAUDE_STDIN_FILE", originalStdinFile);
  });
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const sent: ServerToHandMessage[] = [];
  let session!: BrainSession;

  session = BrainSession.createSession({
    id: "sess-sdk-spawn",
    cwd: WORKDIR,
    model: "claude-test",
    transport: {
      send: async (message) => {
        sent.push(message);
        if (message.type === "tool_call") {
          session.resolveToolResult(message.requestId, {
            output: { stdout: `${WORKDIR}\n`, stderr: "", exit_code: 0 },
            summary: "pwd 完成",
          });
        }
      },
    },
  });

  await session.prompt("你好");

  assert.equal(sent[0]?.type, "tool_call");
  assert.equal((sent[0] as Extract<ServerToHandMessage, { type: "tool_call" }>).toolName, "Bash");
  assert.equal(sent[1]?.type, "tool_call_complete");
  assert.deepEqual(sent[2], {
    type: "text_chunk",
    sessionId: "sess-sdk-spawn",
    text: "fake assistant: pwd 完成",
  });
  assert.deepEqual(sent[3], {
    type: "session_end",
    sessionId: "sess-sdk-spawn",
    result: "fake done",
    error: undefined,
  });

  const argv = JSON.parse(await readFile(argsFile, "utf8")) as string[];
  assert.ok(argv.includes("--output-format"));
  assert.ok(argv.includes("stream-json"));
  assert.ok(argv.includes("--input-format"));
  assert.ok(argv.includes("--model"));
  assert.ok(argv.includes("claude-test"));
  assert.ok(argv.includes("--permission-mode"));
  assert.ok(argv.includes("default"));

  const stdinLines = (await readFile(stdinFile, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(stdinLines.some((entry) => entry.type === "control_request"), true);
  assert.equal(stdinLines.some((entry) => entry.type === "user"), true);
});

async function writeFakeClaudeExecutable(filePath: string): Promise<void> {
  const nodeScriptPath = `${filePath}.mjs`;
  const wrapper = `#!/bin/sh
exec node "${nodeScriptPath}" "$@"
`;

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
          tool_input: { command: "pwd" },
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

  await writeFile(filePath, wrapper, "utf8");
  await chmod(filePath, 0o755);
  await writeFile(nodeScriptPath, script, "utf8");
  await chmod(nodeScriptPath, 0o755);
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
