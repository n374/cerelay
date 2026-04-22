import test from "node:test";
import assert from "node:assert/strict";
import { renderToolResultForClaude, rewriteToolInputForClient } from "../src/session.js";

// ============================================================
// 路径重写：Write / Edit / MultiEdit / Grep / Glob 全覆盖
// ============================================================

test("rewriteToolInputForClient rewrites Write file_path from server to client", () => {
  const result = rewriteToolInputForClient("Write", {
    file_path: "/tmp/cerelay-claude-sess-1/src/index.ts",
    content: "console.log('hello');",
  }, {
    serverHomeDir: "/home/node",
    clientHomeDir: "/Users/dev",
    serverCwd: "/tmp/cerelay-claude-sess-1",
    clientCwd: "/Users/dev/project",
  });
  assert.deepEqual(result, {
    file_path: "/Users/dev/project/src/index.ts",
    content: "console.log('hello');",
  });
});

test("rewriteToolInputForClient rewrites Edit file_path from server to client", () => {
  const result = rewriteToolInputForClient("Edit", {
    file_path: "/home/node/.claude/CLAUDE.md",
    old_string: "old",
    new_string: "new",
  }, {
    serverHomeDir: "/home/node",
    clientHomeDir: "/Users/dev",
    serverCwd: "/tmp/cerelay-sess",
    clientCwd: "/Users/dev/project",
  });
  assert.deepEqual(result, {
    file_path: "/Users/dev/.claude/CLAUDE.md",
    old_string: "old",
    new_string: "new",
  });
});

test("rewriteToolInputForClient rewrites MultiEdit file_path from server to client", () => {
  const result = rewriteToolInputForClient("MultiEdit", {
    file_path: "/tmp/cerelay-claude-sess-1/package.json",
    edits: [{ old_string: "a", new_string: "b" }],
  }, {
    serverHomeDir: "/home/node",
    clientHomeDir: "/Users/dev",
    serverCwd: "/tmp/cerelay-claude-sess-1",
    clientCwd: "/Users/dev/project",
  });
  assert.deepEqual(result, {
    file_path: "/Users/dev/project/package.json",
    edits: [{ old_string: "a", new_string: "b" }],
  });
});

test("rewriteToolInputForClient rewrites Grep path from server to client", () => {
  const result = rewriteToolInputForClient("Grep", {
    pattern: "TODO",
    path: "/tmp/cerelay-claude-sess-1/src",
    glob: "*.ts",
  }, {
    serverHomeDir: "/home/node",
    clientHomeDir: "/Users/dev",
    serverCwd: "/tmp/cerelay-claude-sess-1",
    clientCwd: "/Users/dev/project",
  });
  assert.deepEqual(result, {
    pattern: "TODO",
    path: "/Users/dev/project/src",
    glob: "*.ts",
  });
});

test("rewriteToolInputForClient rewrites Glob path from server to client", () => {
  const result = rewriteToolInputForClient("Glob", {
    pattern: "*.ts",
    path: "/tmp/cerelay-claude-sess-1",
  }, {
    serverHomeDir: "/home/node",
    clientHomeDir: "/Users/dev",
    serverCwd: "/tmp/cerelay-claude-sess-1",
    clientCwd: "/Users/dev/project",
  });
  assert.deepEqual(result, {
    pattern: "*.ts",
    path: "/Users/dev/project",
  });
});

// ============================================================
// 路径重写：CC 配置文件路径（认证 / 用户配置 / 项目配置）
// ============================================================

test("rewriteToolInputForClient rewrites .credentials.json path for Read", () => {
  const result = rewriteToolInputForClient("Read", {
    file_path: "/home/node/.claude/.credentials.json",
  }, {
    serverHomeDir: "/home/node",
    clientHomeDir: "/Users/dev",
    serverCwd: "/tmp/sess",
    clientCwd: "/Users/dev/project",
  });
  assert.deepEqual(result, {
    file_path: "/Users/dev/.claude/.credentials.json",
  });
});

test("rewriteToolInputForClient rewrites project CLAUDE.md path for Read", () => {
  const result = rewriteToolInputForClient("Read", {
    file_path: "/tmp/cerelay-claude-sess-1/CLAUDE.md",
  }, {
    serverHomeDir: "/home/node",
    clientHomeDir: "/Users/dev",
    serverCwd: "/tmp/cerelay-claude-sess-1",
    clientCwd: "/Users/dev/project",
  });
  assert.deepEqual(result, {
    file_path: "/Users/dev/project/CLAUDE.md",
  });
});

test("rewriteToolInputForClient rewrites project .claude/ directory paths for Read", () => {
  const result = rewriteToolInputForClient("Read", {
    file_path: "/tmp/cerelay-claude-sess-1/.claude/settings.local.json",
  }, {
    serverHomeDir: "/home/node",
    clientHomeDir: "/Users/dev",
    serverCwd: "/tmp/cerelay-claude-sess-1",
    clientCwd: "/Users/dev/project",
  });
  assert.deepEqual(result, {
    file_path: "/Users/dev/project/.claude/settings.local.json",
  });
});

test("rewriteToolInputForClient rewrites Bash command accessing .claude.json", () => {
  const result = rewriteToolInputForClient("Bash", {
    command: "cat /home/node/.claude.json",
  }, {
    serverHomeDir: "/home/node",
    clientHomeDir: "/Users/dev",
    serverCwd: "/tmp/sess",
    clientCwd: "/Users/dev/project",
  });
  assert.deepEqual(result, {
    command: "cat /Users/dev/.claude.json",
  });
});

test("rewriteToolInputForClient rewrites Bash command accessing .credentials.json", () => {
  const result = rewriteToolInputForClient("Bash", {
    command: "cat /home/node/.claude/.credentials.json && echo ok",
  }, {
    serverHomeDir: "/home/node",
    clientHomeDir: "/Users/dev",
    serverCwd: "/tmp/sess",
    clientCwd: "/Users/dev/project",
  });
  assert.deepEqual(result, {
    command: "cat /Users/dev/.claude/.credentials.json && echo ok",
  });
});

test("rewriteToolInputForClient rewrites Grep path targeting ~/.claude for settings search", () => {
  const result = rewriteToolInputForClient("Grep", {
    pattern: "mcpServers",
    path: "/home/node/.claude",
  }, {
    serverHomeDir: "/home/node",
    clientHomeDir: "/Users/dev",
    serverCwd: "/tmp/sess",
    clientCwd: "/Users/dev/project",
  });
  assert.deepEqual(result, {
    pattern: "mcpServers",
    path: "/Users/dev/.claude",
  });
});

test("rewriteToolInputForClient rewrites Glob path targeting project .claude/ directory", () => {
  const result = rewriteToolInputForClient("Glob", {
    pattern: "*.json",
    path: "/tmp/cerelay-claude-sess-1/.claude",
  }, {
    serverHomeDir: "/home/node",
    clientHomeDir: "/Users/dev",
    serverCwd: "/tmp/cerelay-claude-sess-1",
    clientCwd: "/Users/dev/project",
  });
  assert.deepEqual(result, {
    pattern: "*.json",
    path: "/Users/dev/project/.claude",
  });
});

// ============================================================
// renderToolResultForClaude：各工具类型结果格式化
// ============================================================

test("renderToolResultForClaude formats Read result as content string", () => {
  const output = renderToolResultForClaude("Read", {
    output: { content: "line1\nline2\nline3" },
    summary: "Read 成功",
  });
  assert.equal(output, "line1\nline2\nline3");
});

test("renderToolResultForClaude formats Write result as path string", () => {
  const output = renderToolResultForClaude("Write", {
    output: { path: "/Users/dev/project/new-file.ts" },
    summary: "Write 成功",
  });
  assert.equal(output, "/Users/dev/project/new-file.ts");
});

test("renderToolResultForClaude formats Edit result as path string", () => {
  const output = renderToolResultForClaude("Edit", {
    output: { path: "/Users/dev/project/index.ts" },
    summary: "Edit 成功",
  });
  assert.equal(output, "/Users/dev/project/index.ts");
});

test("renderToolResultForClaude formats Bash result with stdout/stderr/exit_code", () => {
  const output = renderToolResultForClaude("Bash", {
    output: { stdout: "hello\n", stderr: "warn: something\n", exit_code: 0 },
    summary: "Bash 成功",
  });
  assert.equal(output, "stdout:\nhello\n\nstderr:\nwarn: something\n\nexit_code: 0");
});

test("renderToolResultForClaude formats Bash result with only stdout", () => {
  const output = renderToolResultForClaude("Bash", {
    output: { stdout: "/Users/dev/project\n", stderr: "", exit_code: 0 },
    summary: "Bash 成功",
  });
  assert.equal(output, "stdout:\n/Users/dev/project\n\nexit_code: 0");
});

test("renderToolResultForClaude formats Grep result as file:line:text", () => {
  const output = renderToolResultForClaude("Grep", {
    output: {
      matches: [
        { file: "src/index.ts", line: 10, text: "const x = 1;" },
        { file: "src/utils.ts", line: 5, text: "export const y = 2;" },
      ],
    },
    summary: "Grep 成功",
  });
  assert.equal(output, "src/index.ts:10:const x = 1;\nsrc/utils.ts:5:export const y = 2;");
});

test("renderToolResultForClaude formats Glob result as newline-separated file list", () => {
  const output = renderToolResultForClaude("Glob", {
    output: {
      files: ["src/index.ts", "src/utils.ts", "package.json"],
    },
    summary: "Glob 成功",
  });
  assert.equal(output, "src/index.ts\nsrc/utils.ts\npackage.json");
});

test("renderToolResultForClaude returns error string when result has error", () => {
  const output = renderToolResultForClaude("Read", {
    error: "ENOENT: no such file or directory",
  });
  assert.equal(output, "ENOENT: no such file or directory");
});

test("renderToolResultForClaude returns summary when output is undefined", () => {
  const output = renderToolResultForClaude("Read", {
    summary: "文件不存在",
  });
  assert.equal(output, "文件不存在");
});
