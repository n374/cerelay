import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { BrainSession } from "../src/session.js";
import type { ServerToHandMessage } from "../src/protocol.js";
import { writeFakeClaude } from "./fixtures/fake-claude.js";

const WORKDIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("BrainSession can drive the real SDK transport with a fake Claude executable", { concurrency: false }, async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "axon-sdk-spawn-"));
  const argsFile = path.join(tempDir, "argv.json");
  const stdinFile = path.join(tempDir, "stdin.jsonl");

  const fake = await writeFakeClaude({ command: "pwd" });
  const executablePath = fake.executablePath;

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
    await fake.cleanup();
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

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
