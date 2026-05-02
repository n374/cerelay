import test from "node:test";
import assert from "node:assert/strict";
import { mockAdmin, scriptToolUse, scriptText } from "./mock-admin.js";
import { clients } from "./clients.js";
import { serverEvents } from "./server-events.js";
import { writeFixture, cleanupFixture } from "./fixtures.js";

// 容器内 fixture 路径转 client cwd 视角
function clientCwd(caseId: string): string {
  return `/workspace/fixtures/${caseId}`;
}

test.beforeEach(async () => {
  await mockAdmin.reset();
});

// ============================================================
// A1-bash-basic
// ============================================================
test("A1-bash-basic: model 触发 Bash → server 中转 client 执行 → tool_result 回写", async () => {
  const caseId = "case-a1";
  await writeFixture(caseId, {
    "marker.txt": "hello-from-a1",
    "src/main.ts": "console.log('main')",
  });

  // 第一轮：模型返回 Bash tool_use
  await mockAdmin.loadScript({
    name: "p0-a1-turn1",
    match: { turnIndex: 1 },
    respond: scriptToolUse({
      toolName: "mcp__cerelay__bash",
      toolUseId: "toolu_a1_01",
      input: { command: "ls -la" },
    }),
  });
  // 第二轮：模型拿到 tool_result 后输出 final text
  await mockAdmin.loadScript({
    name: "p0-a1-turn2",
    match: { turnIndex: 2 },
    respond: scriptText("listing complete"),
  });

  const result = await clients.run("client-a", {
    prompt: "list files in current dir [A1-MARKER]",
    cwd: clientCwd(caseId),
  });

  assert.equal(
    result.exitCode,
    0,
    `client exit ${result.exitCode}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
  );

  // 断言 mock 收到了两轮请求
  const cap = await mockAdmin.captured();
  assert.equal(cap.length, 2, `expected 2 messages, got ${cap.length}\ncaptured: ${JSON.stringify(cap.map((c) => ({ idx: c.index, matched: c.matchedScript })), null, 2)}`);

  // 断言第二轮的 tool_result 含 marker 文件名
  const toolResult = cap[1].toolResults[0];
  assert.ok(toolResult, "expected tool_result in turn 2");
  assert.match(toolResult.content, /marker\.txt/, "tool_result.content should mention marker.txt");
  assert.equal(toolResult.is_error, false, "Bash via shadow MCP should not be error");

  await cleanupFixture(caseId);
});

// ============================================================
// B4-ancestor-claudemd（同时守 D3 IFS bug regression）
// ============================================================
test("B4-ancestor-claudemd: ancestor 段 bootstrap 不在 set -u 下崩 + ancestor CLAUDE.md 可读", async () => {
  const caseId = "case-b4";
  await writeFixture(caseId, {
    "CLAUDE.md": "# Ancestor at case-b4 root\nThis is the closest ancestor CLAUDE.md.",
    "sub/proj/CLAUDE.md": "# Project-level\nThis is the cwd CLAUDE.md.",
    "sub/proj/marker.txt": "hello-from-b4",
  });

  const cwd = `${clientCwd(caseId)}/sub/proj`;

  await mockAdmin.loadScript({
    name: "p0-b4-turn1",
    match: { turnIndex: 1 },
    respond: scriptToolUse({
      toolName: "mcp__cerelay__bash",
      toolUseId: "toolu_b4_01",
      input: { command: "cat ../../CLAUDE.md" },
    }),
  });
  await mockAdmin.loadScript({
    name: "p0-b4-turn2",
    match: { turnIndex: 2 },
    respond: scriptText("ok"),
  });

  const result = await clients.run("client-a", {
    prompt: "read ancestor CLAUDE.md [B4-MARKER]",
    cwd,
  });

  // 关键断言：client 不能 0 + stderr 含 "IFS: parameter not set" 这种 bootstrap 失败信号
  assert.equal(
    result.exitCode,
    0,
    `client failed (exit ${result.exitCode})\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
  );
  const allOutput = `${result.stdout}\n${result.stderr}`;
  assert.doesNotMatch(allOutput, /IFS: parameter not set/, "regression: bootstrap.sh IFS bug surfaced again");
  assert.doesNotMatch(allOutput, /初始化 Claude mount namespace 失败/, "namespace 初始化失败 = 框架捞到 regression");

  // server 端事件：必须有 namespace.bootstrap.ready，且没有 namespace.bootstrap.failed
  const events = await serverEvents.fetch({});
  const ready = events.find((e) => e.kind === "namespace.bootstrap.ready");
  const failed = events.find((e) => e.kind === "namespace.bootstrap.failed");
  assert.ok(ready, "expected namespace.bootstrap.ready event");
  assert.equal(failed, undefined, `unexpected bootstrap.failed: ${JSON.stringify(failed?.detail)}`);

  // 断言第二轮 tool_result 含 ancestor CLAUDE.md 内容
  const cap = await mockAdmin.captured();
  const toolResult = cap.at(-1)?.toolResults[0];
  assert.ok(toolResult, "expected tool_result");
  assert.match(toolResult.content, /Ancestor at case-b4 root/, "ancestor CLAUDE.md content should be readable");

  await cleanupFixture(caseId);
});
