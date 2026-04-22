import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// ============================================================
// FakeClaudePty Fixture
//
// 生成一个在 PTY 下可运行的 fake-claude 脚本，用来替代真实的 Claude CLI
// 跑完整 PTY 链路（pty-session.ts → fake-claude → hook script → bridge HTTP
// → ClaudePtySession.handleInjectedPreToolUse → WebSocket tool_call → Client）。
//
// 脚本行为：
//   1. 启动时打印 "FAKE_CLAUDE_READY"，让测试确认 PTY 已经绑定。
//   2. 轮询 CERELAY_FAKE_PTY_RUNTIMEROOT_FILE 指向的文件，直到拿到 runtimeRoot。
//      这个 file 是测试在收到 pty_session_created 后写入的——因为 sessionId
//      是 server 端随机生成的，fake-claude 启动前没办法得知 runtimeRoot。
//   3. 轮询 CERELAY_FAKE_PTY_SCRIPT_FILE，按步骤执行：
//        - { "op": "call_tool", toolName, toolInput, toolUseId } →
//          spawn <runtimeRoot>/hooks/cerelay-pretooluse.mjs，stdin 喂
//          {tool_name, tool_input, tool_use_id} JSON，读 stdout hook 响应，
//          打印 "FAKE_CLAUDE_TOOL_RESULT <hook_response_json>"
//        - { "op": "print", text } → 直接 print 到 PTY stdout
//        - { "op": "exit", code } → exit with code
//   4. 脚本文件新增一行时 fake-claude 才会读并执行，测试可逐步驱动。
// ============================================================

export interface FakeClaudePtyHandle {
  executablePath: string;
  runtimeRootHintFile: string;
  scriptFile: string;
  cleanup(): Promise<void>;
}

export async function writeFakeClaudePty(): Promise<FakeClaudePtyHandle> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "cerelay-fake-claude-pty-"));
  const executablePath = path.join(tempDir, "fake-claude");
  const nodeScriptPath = `${executablePath}.mjs`;
  const runtimeRootHintFile = path.join(tempDir, "runtime-root-hint.txt");
  const scriptFile = path.join(tempDir, "script.jsonl");

  await writeFile(runtimeRootHintFile, "", "utf8");
  await writeFile(scriptFile, "", "utf8");

  const wrapper = `#!/bin/sh
exec node "${nodeScriptPath}" "$@"
`;

  const script = String.raw`#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const runtimeRootHintFile = process.env.CERELAY_FAKE_PTY_RUNTIMEROOT_FILE;
const scriptFile = process.env.CERELAY_FAKE_PTY_SCRIPT_FILE;
const pollIntervalMs = Number(process.env.CERELAY_FAKE_PTY_POLL_MS || "30");
const maxWaitMs = Number(process.env.CERELAY_FAKE_PTY_MAX_WAIT_MS || "10000");

if (!runtimeRootHintFile || !scriptFile) {
  process.stdout.write("FAKE_CLAUDE_ERROR missing_env\r\n");
  process.exit(1);
}

process.stdout.write("FAKE_CLAUDE_READY\r\n");

// 等待 hint 文件被测试写入 runtimeRoot
const deadline = Date.now() + maxWaitMs;
let runtimeRoot = "";
while (Date.now() < deadline) {
  try {
    const raw = (await readFile(runtimeRootHintFile, "utf8")).trim();
    if (raw.length > 0) {
      runtimeRoot = raw;
      break;
    }
  } catch {
    // hint 文件还没写入
  }
  await sleep(pollIntervalMs);
}

if (!runtimeRoot) {
  process.stdout.write("FAKE_CLAUDE_ERROR runtime_root_hint_timeout\r\n");
  process.exit(1);
}
process.stdout.write("FAKE_CLAUDE_RUNTIME_READY " + runtimeRoot + "\r\n");

const hookScriptPath = path.join(runtimeRoot, "hooks", "cerelay-pretooluse.mjs");

// 按行消费脚本文件；每行一个 JSON 指令。
let cursor = 0;
let done = false;
while (!done) {
  let content = "";
  try {
    content = await readFile(scriptFile, "utf8");
  } catch {
    content = "";
  }
  const lines = content.split("\n");
  // 丢掉末尾不完整行（可能还在写）——只消费已经写完的完整行。
  const completeLines = content.endsWith("\n") ? lines.slice(0, -1) : lines.slice(0, Math.max(0, lines.length - 1));
  while (cursor < completeLines.length) {
    const line = completeLines[cursor].trim();
    cursor++;
    if (!line) continue;
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch (err) {
      process.stdout.write("FAKE_CLAUDE_ERROR bad_script_line " + err.message + "\r\n");
      continue;
    }
    if (cmd.op === "print") {
      process.stdout.write(String(cmd.text ?? "") + "\r\n");
      continue;
    }
    if (cmd.op === "exit") {
      process.stdout.write("FAKE_CLAUDE_EXIT " + String(cmd.code ?? 0) + "\r\n");
      process.exit(Number(cmd.code ?? 0));
    }
    if (cmd.op === "call_tool") {
      if (!existsSync(hookScriptPath)) {
        process.stdout.write("FAKE_CLAUDE_ERROR hook_script_missing " + hookScriptPath + "\r\n");
        continue;
      }
      try {
        const response = await callHookScript(hookScriptPath, {
          tool_name: cmd.toolName,
          tool_use_id: cmd.toolUseId ?? "toolu_fake_" + Math.random().toString(36).slice(2, 8),
          tool_input: cmd.toolInput ?? {},
        });
        // 输出一行方便断言——序列化成不含换行的 JSON
        process.stdout.write("FAKE_CLAUDE_TOOL_RESULT " + JSON.stringify(response) + "\r\n");
      } catch (err) {
        process.stdout.write("FAKE_CLAUDE_ERROR tool_call " + err.message + "\r\n");
      }
      continue;
    }
    process.stdout.write("FAKE_CLAUDE_ERROR unknown_op " + JSON.stringify(cmd) + "\r\n");
  }
  await sleep(pollIntervalMs);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function callHookScript(scriptPath, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error("hook exit " + code + " stderr=" + stderr.trim()));
        return;
      }
      try {
        const parsed = stdout ? JSON.parse(stdout) : {};
        resolve(parsed);
      } catch (err) {
        reject(new Error("hook response parse error: " + err.message + " raw=" + stdout));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}
`;

  await writeFile(executablePath, wrapper, "utf8");
  await chmod(executablePath, 0o755);
  await writeFile(nodeScriptPath, script, "utf8");
  await chmod(nodeScriptPath, 0o755);

  return {
    executablePath,
    runtimeRootHintFile,
    scriptFile,
    cleanup: () => rm(tempDir, { recursive: true, force: true }),
  };
}
