import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AxonServer } from "../src/server.js";
import { HandClient } from "../../hand/src/client.js";
import { writeFakeClaude } from "./fixtures/fake-claude.js";

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

test(
  "Hand↔Brain e2e with fake Claude executable keeps the session prompt path working",
  { concurrency: false, timeout: 15_000 },
  async (t) => {
    const argsDir = await mkdtemp(path.join(tmpdir(), "axon-e2e-args-"));
    const tempHome = await mkdtemp(path.join(tmpdir(), "axon-e2e-home-"));
    const argsFile = path.join(argsDir, "argv.jsonl");
    const stdinFile = path.join(argsDir, "stdin.jsonl");

    const fake = await writeFakeClaude({ assistantText: "fake assistant e2e" });

    const originalExecutable = process.env.CLAUDE_CODE_EXECUTABLE;
    const originalArgsFile = process.env.AXON_FAKE_CLAUDE_ARGS_FILE;
    const originalStdinFile = process.env.AXON_FAKE_CLAUDE_STDIN_FILE;
    const originalHome = process.env.HOME;

    process.env.CLAUDE_CODE_EXECUTABLE = fake.executablePath;
    process.env.AXON_FAKE_CLAUDE_ARGS_FILE = argsFile;
    process.env.AXON_FAKE_CLAUDE_STDIN_FILE = stdinFile;
    process.env.HOME = tempHome;

    t.after(() => {
      restoreEnvVar("CLAUDE_CODE_EXECUTABLE", originalExecutable);
      restoreEnvVar("AXON_FAKE_CLAUDE_ARGS_FILE", originalArgsFile);
      restoreEnvVar("AXON_FAKE_CLAUDE_STDIN_FILE", originalStdinFile);
      restoreEnvVar("HOME", originalHome);
    });
    t.after(async () => {
      await fake.cleanup();
      await rm(argsDir, { recursive: true, force: true });
      await rm(tempHome, { recursive: true, force: true });
    });

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

    const client = new HandClient(
      `ws://127.0.0.1:${server.getListenPort()}/ws`,
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

    const textChunks: string[] = [];
    await client.sendPrompt("请回复一句话");
    await client.runWithCallbacks({
      onTextChunk: (text) => {
        textChunks.push(text);
      },
    });

    const lastResult = client.getLastResult();
    assert.equal(textChunks.join(""), "fake assistant e2e");
    assert.equal(lastResult.result, "fake done");
    assert.equal(lastResult.error, undefined);

    const argsRecords = (await readFile(argsFile, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { argv: string[]; cwd: string });
    assert.equal(argsRecords.length, 1);
    assert.ok(argsRecords[0]?.argv.includes("--model"));

    const stdinLines = (await readFile(stdinFile, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(stdinLines.some((entry) => entry.type === "user"), true);
  }
);
