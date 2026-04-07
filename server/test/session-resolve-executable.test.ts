import process from "node:process";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { resolveClaudeCodeExecutable } from "../src/session.js";

test("resolveClaudeCodeExecutable: 环境变量优先,直接返回(不检查存在性)", () => {
  const original = process.env.CLAUDE_CODE_EXECUTABLE;
  try {
    process.env.CLAUDE_CODE_EXECUTABLE = "/some/explicit/path";
    const result = resolveClaudeCodeExecutable();
    assert.equal(result, "/some/explicit/path");
  } finally {
    if (original === undefined) {
      delete process.env.CLAUDE_CODE_EXECUTABLE;
    } else {
      process.env.CLAUDE_CODE_EXECUTABLE = original;
    }
  }
});

test("resolveClaudeCodeExecutable: 自动探测命中第一个存在的候选路径", async () => {
  const original = process.env.CLAUDE_CODE_EXECUTABLE;
  delete process.env.CLAUDE_CODE_EXECUTABLE;

  const tempDir = await mkdtemp(path.join(tmpdir(), "axon-resolve-exec-"));
  try {
    const fakeBin = path.join(tempDir, "claude");
    await writeFile(fakeBin, "#!/bin/sh\n", "utf8");
    await chmod(fakeBin, 0o755);

    const nonexistent1 = path.join(tempDir, "no-such-a");
    const nonexistent2 = path.join(tempDir, "no-such-b");
    const candidates = [nonexistent1, fakeBin, nonexistent2];

    const result = resolveClaudeCodeExecutable(candidates);
    assert.equal(result, fakeBin);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    if (original === undefined) {
      delete process.env.CLAUDE_CODE_EXECUTABLE;
    } else {
      process.env.CLAUDE_CODE_EXECUTABLE = original;
    }
  }
});

test("resolveClaudeCodeExecutable: 全部候选未命中时抛 Error,消息包含所有候选路径及安装提示", () => {
  const original = process.env.CLAUDE_CODE_EXECUTABLE;
  delete process.env.CLAUDE_CODE_EXECUTABLE;
  try {
    const candidates = ["/no/such/path/a", "/no/such/path/b"];
    assert.throws(
      () => resolveClaudeCodeExecutable(candidates),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("/no/such/path/a"), `message missing candidate a: ${err.message}`);
        assert.ok(err.message.includes("/no/such/path/b"), `message missing candidate b: ${err.message}`);
        assert.ok(err.message.includes("CLAUDE_CODE_EXECUTABLE"), `message missing env var hint: ${err.message}`);
        assert.ok(err.message.includes("brew install"), `message missing brew install hint: ${err.message}`);
        return true;
      }
    );
  } finally {
    if (original === undefined) {
      delete process.env.CLAUDE_CODE_EXECUTABLE;
    } else {
      process.env.CLAUDE_CODE_EXECUTABLE = original;
    }
  }
});
