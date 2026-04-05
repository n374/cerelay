import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { UI } from "../src/ui.js";

const HAND_WORKDIR = "/Users/n374/Documents/Code/axon/hand";

test("UI prints formatted output to stdout and stderr", (t) => {
  const stdout: string[] = [];
  const stderr: string[] = [];

  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });
  t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });

  const ui = new UI();
  ui.printText("hello");
  ui.printThought("thinking");
  ui.printToolCall("Read", { file: "a.txt" });
  ui.printToolResult("Read", true);
  ui.printToolResult("Write", false);
  ui.printSessionEnd("done", "failed");
  ui.printError("boom");

  assert.match(stdout.join(""), /hello/);
  assert.match(stdout.join(""), /\[工具调用] Read/);
  assert.match(stdout.join(""), /\[完成] Read/);
  assert.match(stdout.join(""), /\[失败] Write/);
  assert.match(stdout.join(""), /会话结束/);
  assert.match(stdout.join(""), /结果: done/);
  assert.match(stderr.join(""), /错误: boom/);
});

test("UI.readInput resolves a line from stdin", async (t) => {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--eval",
      "import { UI } from './src/ui.ts'; const ui = new UI(); const line = await ui.readInput('你>'); process.stdout.write('\\nVALUE:' + line + '\\n');",
    ],
    {
      cwd: HAND_WORKDIR,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  registerChildCleanup(t, child);

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  child.stdin.write("hello\n");
  child.stdin.end();

  const [exitCode] = await once(child, "exit");
  assert.equal(exitCode, 0);
  assert.match(stdout, /VALUE:hello/);
  assert.equal(stderr, "");
});

test("UI.readInput rejects with EOF when stdin closes", async (t) => {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--eval",
      "import { UI, EOFError } from './src/ui.ts'; const ui = new UI(); try { await ui.readInput('你>'); process.exitCode = 1; } catch (error) { process.stdout.write('\\nEOF:' + String(error instanceof EOFError) + '\\n'); }",
    ],
    {
      cwd: HAND_WORKDIR,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  registerChildCleanup(t, child);

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  child.stdin.end();

  const [exitCode] = await once(child, "exit");
  assert.equal(exitCode, 0);
  assert.match(stdout, /EOF:true/);
  assert.equal(stderr, "");
});

function registerChildCleanup(t: TestContext, child: ReturnType<typeof spawn>): void {
  t.after(async () => {
    child.stdin.destroy();
    if (child.exitCode !== null || child.killed) {
      return;
    }

    child.kill("SIGTERM");
    await waitForExit(child, 1000).catch(async () => {
      child.kill("SIGKILL");
      await waitForExit(child, 1000).catch(() => undefined);
    });
  });
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("等待子进程退出超时"));
    }, timeoutMs);

    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}
