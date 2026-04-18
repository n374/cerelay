import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createServer } from "node:http";
import { BrainSession } from "../src/session.js";
import type { ServerToHandMessage } from "../src/protocol.js";
import { writeFakeClaude } from "./fixtures/fake-claude.js";
import { createClaudeHookInjectionWorkspace } from "../src/claude-hook-injection.js";

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
  const hookToken = "axon-sdk-spawn-hook-token";
  const bridge = createServer((req, res) => {
    if (req.method !== "POST" || req.headers["x-axon-hook-token"] !== hookToken) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden" }));
      return;
    }

    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body) as { tool_name: string; tool_input?: unknown; tool_use_id?: string };
        const result = await session.handleInjectedPreToolUse({
          tool_name: payload.tool_name,
          tool_input: payload.tool_input,
          tool_use_id: payload.tool_use_id,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ decision: "block", reason: String(error) }));
      }
    });
  });
  await new Promise<void>((resolvePromise) => bridge.listen(0, "127.0.0.1", resolvePromise));
  const address = bridge.address();
  assert.ok(address && typeof address !== "string");
  const workspace = await createClaudeHookInjectionWorkspace({
    bridgeUrl: `http://127.0.0.1:${address.port}/hook`,
    sessionId: "sess-sdk-spawn",
    token: hookToken,
  });

  session = BrainSession.createSession({
    id: "sess-sdk-spawn",
    cwd: WORKDIR,
    model: "claude-test",
    sdkCwd: workspace.cwd,
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

  t.after(async () => {
    bridge.close();
    await workspace.cleanup();
  });

  await session.prompt("你好");

  assert.equal(sent[0]?.type, "tool_call");
  assert.equal((sent[0] as Extract<ServerToHandMessage, { type: "tool_call" }>).toolName, "Bash");
  assert.equal(sent[1]?.type, "tool_call_complete");
  assert.deepEqual(sent[2], {
    type: "text_chunk",
    sessionId: "sess-sdk-spawn",
    text: `fake assistant: stdout:\n${WORKDIR}\n\nexit_code: 0`,
  });
  assert.deepEqual(sent[3], {
    type: "session_end",
    sessionId: "sess-sdk-spawn",
    result: "fake done",
    error: undefined,
  });

  const argsRecord = JSON.parse(await readFile(argsFile, "utf8")) as { argv: string[]; cwd: string };
  assert.ok(argsRecord.argv.includes("--output-format"));
  assert.ok(argsRecord.argv.includes("stream-json"));
  assert.ok(argsRecord.argv.includes("--input-format"));
  assert.ok(argsRecord.argv.includes("--model"));
  assert.ok(argsRecord.argv.includes("claude-test"));
  assert.ok(argsRecord.argv.includes("--permission-mode"));
  assert.ok(argsRecord.argv.includes("default"));
  assert.equal(await realpath(argsRecord.cwd), await realpath(workspace.cwd));
  await stat(workspace.settingsPath);
  await stat(workspace.scriptPath);

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
