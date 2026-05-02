// ============================================================
// P1 阶段 e2e case（详见 docs/e2e-comprehensive-testing.md §2.2 / §5）
//
// P1-A 当前批次（无基础设施改动、纯测试代码即可 honest 落地）：
//   - A5-fallback-guidance：shadow MCP 启用 + 内置 Bash 被 deny → 模型下一轮自动改用
//                          mcp__cerelay__bash（Plan D §4.5 fallback 闭环）
//   - C4-large-skipped(skipped 半段)：> 1MB 文件被 manifest 标记 skipped，
//                                     server 仅同步元数据
//
// 故意"延迟"到 P1-B 一起做的 case（详见 §11 / 待新增的 §12 P1 split 记录）：
//   - B5/C3/D4/B6/C4-truncated 半段/E2/F2/F4/G1/G2/G3
//   原因均为 honest 测必须依赖一项基础设施改动（admin event 新增 / agent 异步 run /
//   server toggle 注入 / mock error builder / cache 阈值 env 等），不能在 P0 helpers
//   覆盖范围内通过测试代码绕过。强行写就是绕过守护意图——见 P0-B Codex 终审教训。
// ============================================================

import test from "node:test";
import assert from "node:assert/strict";
import { mockAdmin, scriptToolUse, scriptText } from "./mock-admin.js";
import { clients } from "./clients.js";
import { cacheAdmin } from "./server-events.js";
import { writeFixture, cleanupFixture } from "./fixtures.js";

function clientCwd(caseId: string): string {
  return `/workspace/fixtures/${caseId}`;
}

test.beforeEach(async () => {
  await mockAdmin.reset();
});

// ============================================================
// A5-fallback-guidance: shadow MCP 启用 + builtin Bash deny + 脚本化下一轮 fallback 闭环
//
// 守护的不变量（Plan D §4.5）：
//   1. 内置 Bash 被 disallowedTools / hook deny → tool_result.is_error === true
//   2. deny 的 content 含引导文案，命中 "not (?:available|enabled)" 或
//      "mcp__cerelay__bash"（CC --disallowedTools 与 cerelay shadow fallback hook
//      两条防线择一即可）
//   3. **脚本化下一轮**改用 mcp__cerelay__bash → is_error === false → 端到端
//      可达 cwd marker → 证明"deny 之后 fallback 链路真在 client 端跑通"
//
// A4 已验"单次 deny 文案"（dual-path 不变量），A5 增量验"deny → 下一轮 mcp 路径"
// 这条 fallback 通路是闭环可执行的——把 §4.5 描述的两步流程作为整体守护。
//
// 注意：本 case **不验 CC 模型基于 deny 文案自动推理选择 mcp** 这件事——mock 第二
// turn 直接给 mcp__cerelay__bash，是脚本化的；模型推理选 mcp 由真实 CC + 真实模型
// 在 server/test/e2e-real-claude-bash.test.ts 之类的真模型 e2e 守护，不是本套件的
// 职责（本套件用 mock anthropic 不可能验模型推理本身）。
// ============================================================
test("A5-fallback-guidance: builtin Bash deny → 模型下一轮自动改用 mcp__cerelay__bash", async () => {
  const caseId = "case-a5";
  const marker = "a5-fallback-marker";
  await writeFixture(caseId, {
    "marker.txt": marker,
  });
  const cwd = clientCwd(caseId);

  // turn 1: 模型故意调内置 Bash → 被 deny
  await mockAdmin.loadScript({
    name: "p1-a5-turn1-builtin",
    match: { turnIndex: 1 },
    respond: scriptToolUse({
      toolName: "Bash",
      toolUseId: "toolu_a5_01",
      input: { command: "ls" },
    }),
  });
  // turn 2: 模型读到 deny 文案后改用 mcp__cerelay__bash
  await mockAdmin.loadScript({
    name: "p1-a5-turn2-fallback",
    match: { turnIndex: 2 },
    respond: scriptToolUse({
      toolName: "mcp__cerelay__bash",
      toolUseId: "toolu_a5_02",
      input: { command: "ls" },
    }),
  });
  // turn 3: text final
  await mockAdmin.loadScript({
    name: "p1-a5-turn3-final",
    match: { turnIndex: 3 },
    respond: scriptText("a5 fallback closed loop ok"),
  });

  const result = await clients.run("client-a", {
    prompt: "list cwd via fallback path [A5-MARKER]",
    cwd,
  });

  assert.equal(
    result.exitCode,
    0,
    `client exit ${result.exitCode}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
  );

  const cap = await mockAdmin.captured();
  assert.equal(cap.length, 3, `expected 3 turns, got ${cap.length}`);

  // 主断言 #1：turn 2 携带 turn 1 内置 Bash 的 deny tool_result
  // is_error=true + 文案命中（与 A4 同口径，接受两条防线之一）
  const denyResult = cap[1].toolResultsCurrentTurn[0];
  assert.ok(denyResult, "expected builtin Bash deny tool_result on turn 2");
  assert.equal(denyResult.tool_use_id, "toolu_a5_01");
  assert.equal(denyResult.is_error, true, "Plan D: builtin Bash must be denied");
  assert.match(
    denyResult.content,
    /(mcp__cerelay__bash|not (?:available|enabled))/i,
    `deny content should guide to shadow alt or mark unavailable; got: ${denyResult.content}`,
  );

  // 主断言 #2：turn 3 携带 turn 2 mcp__cerelay__bash 的 fallback tool_result
  // is_error=false + 真的列出了 cwd 内 marker 文件名（fallback 闭环可执行）
  const fallbackResult = cap[2].toolResultsCurrentTurn[0];
  assert.ok(fallbackResult, "expected mcp__cerelay__bash fallback tool_result on turn 3");
  assert.equal(fallbackResult.tool_use_id, "toolu_a5_02");
  assert.equal(
    fallbackResult.is_error,
    false,
    "Plan D fallback must succeed via mcp__cerelay__bash on next turn",
  );
  assert.match(
    fallbackResult.content,
    /marker\.txt/,
    "fallback ls should list cwd marker.txt (闭环可执行证据)",
  );

  await cleanupFixture(caseId);
});

// ============================================================
// C4-large-skipped(skipped 半段): > MAX_FILE_BYTES (1MB) 的文件被 cache sync 标
// skipped，server 仅同步元数据（无 blob，读取时穿透 client）。
//
// 守护的不变量（CLAUDE.md §5 + cache-sync.ts MAX_FILE_BYTES=1MB）：
//   1. client cache-sync 把 size > 1MB 的文件标 skipped:true 上报 manifest
//   2. server 落地 manifest 时保留 skipped 标记（不要错把它当成正常 entry 缓存）
//   3. cache summary scopes[*].skippedCount >= 1
//   4. 单项 lookupEntry 返回 skipped:true（且 sha256 可能为 null/有 hash 不限）
//
// 注：scope > 100MB 触发 truncated 的 truncated 半段不在 P1-A 内——100MB 在 e2e
// 启动期同步太慢，必须配合 P1-B 增加 MAX_SCOPE_BYTES env override 才能可控触发。
// ============================================================
test("C4-large-skipped(skipped 半段): > 1MB 文件被 manifest 标记 skipped", async () => {
  const caseId = "case-c4-skipped";
  await writeFixture(caseId, { ".keep": "" });
  const cwd = clientCwd(caseId);

  // 单 turn final——cache sync 在 session 启动期完成，不需要工具调用
  await mockAdmin.loadScript({
    name: "p1-c4-turn1-final",
    match: { turnIndex: 1 },
    respond: scriptText("c4 skipped ok"),
  });

  // homeFixtureBulk count=1 + bytesPerFile=1.5MB 触发 skipped。
  // agent applyHomeFixtureBulk 写 ${HOME}/${pathPrefix}/bulk_000000.txt
  // → 完整路径 ~/.claude/c4-large/bulk_000000.txt
  // → cache scope=claude-home, relPath=c4-large/bulk_000000.txt
  const LARGE_BYTES = 1_500_000; // 1.5 MB > MAX_FILE_BYTES=1MB
  const result = await clients.run("client-a", {
    prompt: "trigger cache sync with one large file [C4-MARKER]",
    cwd,
    timeoutMs: 60_000,
    homeFixtureBulk: {
      pathPrefix: ".claude/c4-large",
      count: 1,
      bytesPerFile: LARGE_BYTES,
    },
  });

  assert.equal(
    result.exitCode,
    0,
    `client exit ${result.exitCode}\n--- stderr ---\n${result.stderr}`,
  );
  assert.ok(result.deviceId, "client agent must report deviceId");

  // 旁证：client 端 stdout 应显示 cache sync 完成
  assert.match(
    result.stdout,
    /cache task initial upload complete/,
    "client should complete initial cache sync",
  );

  // 主断言 #1：单项 lookupEntry 返回 skipped=true
  const entry = await cacheAdmin.lookupEntry({
    deviceId: result.deviceId,
    scope: "claude-home",
    relPath: "c4-large/bulk_000000.txt",
  });
  assert.ok(
    entry,
    "expected manifest entry for large file (got null) — server is not even recording metadata",
  );
  assert.equal(
    entry.skipped,
    true,
    `large file should be marked skipped (size=${entry.size}, sha256=${entry.sha256})`,
  );
  // size 字段应反映实际文件大小（agent 写的字节数），不是 0
  assert.equal(
    entry.size,
    LARGE_BYTES,
    `skipped entry size should equal source file size (${LARGE_BYTES}), got ${entry.size}`,
  );

  // 主断言 #2：scope summary 反映出 skippedCount >= 1
  const summary = await cacheAdmin.summary(result.deviceId);
  const homeStats = summary.scopes["claude-home"];
  assert.ok(homeStats, "claude-home scope should exist on server");
  assert.ok(
    homeStats.skippedCount >= 1,
    `claude-home.skippedCount should be >= 1, got ${homeStats.skippedCount}`,
  );

  await cleanupFixture(caseId);
});
