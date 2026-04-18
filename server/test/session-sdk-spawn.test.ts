import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BrainSession } from "../src/session.js";
import type { ServerToHandMessage } from "../src/protocol.js";
import { writeFakeClaude } from "./fixtures/fake-claude.js";

test("BrainSession can drive the real SDK transport with a fake Claude executable", { concurrency: false }, async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "axon-sdk-spawn-"));
  const argsFile = path.join(tempDir, "argv.jsonl");
  const stdinFile = path.join(tempDir, "stdin.jsonl");
  const claudeCwd = await mkdtemp(path.join(tmpdir(), "axon-sdk-cwd-"));

  const fake = await writeFakeClaude({ assistantText: "fake assistant from sdk" });
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
    await rm(tempDir, { recursive: true, force: true });
    await rm(claudeCwd, { recursive: true, force: true });
  });

  const sent: ServerToHandMessage[] = [];
  const session = BrainSession.createSession({
    id: "sess-sdk-spawn",
    cwd: "/workspace/demo",
    model: "claude-test",
    sdkCwd: claudeCwd,
    transport: {
      send: async (message) => {
        sent.push(message);
      },
    },
  });

  await session.prompt("你好");

  assert.deepEqual(sent, [
    {
      type: "text_chunk",
      sessionId: "sess-sdk-spawn",
      text: "fake assistant from sdk",
    },
    {
      type: "session_end",
      sessionId: "sess-sdk-spawn",
      result: "fake done",
      error: undefined,
    },
  ]);

  const argsRecords = (await readFile(argsFile, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { argv: string[]; cwd: string });
  assert.equal(argsRecords.length, 1);
  const [argsRecord] = argsRecords;
  assert.ok(argsRecord.argv.includes("--output-format"));
  assert.ok(argsRecord.argv.includes("stream-json"));
  assert.ok(argsRecord.argv.includes("--input-format"));
  assert.ok(argsRecord.argv.includes("--model"));
  assert.ok(argsRecord.argv.includes("claude-test"));
  assert.ok(argsRecord.argv.includes("--permission-mode"));
  assert.ok(argsRecord.argv.includes("default"));
  assert.equal(await realpath(argsRecord.cwd), await realpath(claudeCwd));

  const stdinLines = (await readFile(stdinFile, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(stdinLines.some((entry) => entry.type === "control_request"), true);
  assert.equal(stdinLines.some((entry) => entry.type === "user"), true);
});

test("BrainSession resumes the same Claude Code session on the second SDK query", { concurrency: false }, async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "axon-sdk-resume-"));
  const argsFile = path.join(tempDir, "argv.jsonl");
  const stdinFile = path.join(tempDir, "stdin.jsonl");
  const claudeCwd = await mkdtemp(path.join(tmpdir(), "axon-sdk-resume-cwd-"));

  const fake = await writeFakeClaude();
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
    await rm(tempDir, { recursive: true, force: true });
    await rm(claudeCwd, { recursive: true, force: true });
  });

  const session = BrainSession.createSession({
    id: "sess-sdk-resume",
    cwd: "/workspace/demo",
    model: "claude-test",
    sdkCwd: claudeCwd,
    transport: {
      send: async () => {},
    },
  });

  await session.prompt("第一问");
  await session.prompt("第二问");

  const argsRecords = (await readFile(argsFile, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { argv: string[]; cwd: string });

  assert.equal(argsRecords.length, 2);
  assert.equal(argsRecords[0]?.argv.includes("--resume"), false);
  assert.equal(argsRecords[1]?.argv.includes("--resume"), true);
  assert.equal(
    argsRecords[1]?.argv[argsRecords[1].argv.indexOf("--resume") + 1],
    "11111111-1111-4111-8111-111111111111"
  );
});

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
