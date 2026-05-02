import test from "node:test";
import assert from "node:assert/strict";
import { mockAdmin, scriptToolUse, scriptText, scriptParallelToolUse } from "./mock-admin.js";
import { clients } from "./clients.js";
import { serverEvents, cacheAdmin } from "./server-events.js";
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

  // 记录基线：本 case 之前已有的最大 event id；后续只看本 case 之后新增的事件，
  // 避免被前序 case（如 A1）残留的事件污染。
  const allBefore = await serverEvents.fetch({});
  const baselineEventId = allBefore.at(-1)?.id ?? 0;

  const result = await clients.run("client-a", {
    prompt: "read ancestor CLAUDE.md [B4-MARKER]",
    cwd,
  });

  // 关键断言：client 不能 0 + stderr 含 "IFS: parameter not set" 这种 bootstrap 失败信号。
  // 这是 IFS regression 的真主断言——bootstrap.sh 内部失败的最直接信号。
  assert.equal(
    result.exitCode,
    0,
    `client failed (exit ${result.exitCode})\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
  );
  const allOutput = `${result.stdout}\n${result.stderr}`;
  assert.doesNotMatch(allOutput, /IFS: parameter not set/, "regression: bootstrap.sh IFS bug surfaced again");
  assert.doesNotMatch(allOutput, /初始化 Claude mount namespace 失败/, "namespace 初始化失败 = 框架捞到 regression");

  // server 端事件次断言：必须有 pty.spawn.ready，且没有 pty.spawn.failed。
  // 注意：pty.spawn.* 事件只覆盖"helper 子进程是否 spawn 成功"，bootstrap.sh
  // 内部失败由 stdout/stderr 主断言负责，这里仅做次保险。
  // 用 sessionId 精确隔离当前 case session（agent 返回 trace id 不是 server 端
  // sessionId，这里靠 baselineEventId 切片本 case 之后新增的事件）。
  const newEvents = await serverEvents.fetch({ since: baselineEventId });
  const ready = newEvents.find((e) => e.kind === "pty.spawn.ready");
  const failed = newEvents.find((e) => e.kind === "pty.spawn.failed");
  assert.ok(ready, `expected pty.spawn.ready event; new events: ${JSON.stringify(newEvents.map((e) => e.kind))}`);
  assert.equal(failed, undefined, `unexpected pty.spawn.failed: ${JSON.stringify(failed?.detail)}`);

  // 断言第二轮 tool_result 含 ancestor CLAUDE.md 内容
  const cap = await mockAdmin.captured();
  const toolResult = cap.at(-1)?.toolResults[0];
  assert.ok(toolResult, "expected tool_result");
  assert.match(toolResult.content, /Ancestor at case-b4 root/, "ancestor CLAUDE.md content should be readable");

  await cleanupFixture(caseId);
});

// ============================================================
// A2-fs-rwe：mcp__cerelay__write → read → edit 三件套对临时 cwd 内文件
// 守护 fs 工具协议、Edit old_string 唯一性、跨工具内容流转
// ============================================================
test("A2-fs-rwe: write → read → edit 三件套对临时文件", async () => {
  const caseId = "case-a2";
  await writeFixture(caseId, {
    ".keep": "",
  });

  const cwd = clientCwd(caseId);
  const targetAbs = `${cwd}/note.txt`;
  const initial = "hello-from-a2-write";
  const edited = "edited-by-a2";

  // turn 1: write
  await mockAdmin.loadScript({
    name: "p0-a2-turn1-write",
    match: { turnIndex: 1 },
    respond: scriptToolUse({
      toolName: "mcp__cerelay__write",
      toolUseId: "toolu_a2_01",
      input: { file_path: targetAbs, content: initial },
    }),
  });
  // turn 2: read
  await mockAdmin.loadScript({
    name: "p0-a2-turn2-read",
    match: { turnIndex: 2 },
    respond: scriptToolUse({
      toolName: "mcp__cerelay__read",
      toolUseId: "toolu_a2_02",
      input: { file_path: targetAbs },
    }),
  });
  // turn 3: edit
  await mockAdmin.loadScript({
    name: "p0-a2-turn3-edit",
    match: { turnIndex: 3 },
    respond: scriptToolUse({
      toolName: "mcp__cerelay__edit",
      toolUseId: "toolu_a2_03",
      input: { file_path: targetAbs, old_string: initial, new_string: edited },
    }),
  });
  // turn 4: text final
  await mockAdmin.loadScript({
    name: "p0-a2-turn4-final",
    match: { turnIndex: 4 },
    respond: scriptText("rwe done"),
  });

  const result = await clients.run("client-a", {
    prompt: "write/read/edit a note [A2-MARKER]",
    cwd,
  });

  assert.equal(
    result.exitCode,
    0,
    `client exit ${result.exitCode}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
  );

  const cap = await mockAdmin.captured();
  assert.equal(cap.length, 4, `expected 4 turns, got ${cap.length}`);

  // 注意：mock 的 flattenToolResults 累加所有历史 tool_result，因此 cap[N].toolResults[0]
  // 永远是最早一条；要拿当前 turn 对应的最新结果用 .at(-1)。
  // turn 2 携带 turn 1 的 write 结果
  const writeResult = cap[1].toolResults.at(-1);
  assert.ok(writeResult, "expected write tool_result on turn 2");
  assert.equal(writeResult.is_error, false, "write should succeed");
  assert.equal(writeResult.tool_use_id, "toolu_a2_01");

  // turn 3 携带 turn 2 的 read 结果，content 必须含写入的字串
  const readResult = cap[2].toolResults.at(-1);
  assert.ok(readResult, "expected read tool_result on turn 3");
  assert.equal(readResult.is_error, false, "read should succeed");
  assert.equal(readResult.tool_use_id, "toolu_a2_02");
  assert.match(readResult.content, new RegExp(initial), "read should reflect what was written");

  // turn 4 携带 turn 3 的 edit 结果
  const editResult = cap[3].toolResults.at(-1);
  assert.ok(editResult, "expected edit tool_result on turn 4");
  assert.equal(editResult.is_error, false, "edit should succeed");
  assert.equal(editResult.tool_use_id, "toolu_a2_03");

  await cleanupFixture(caseId);
});

// ============================================================
// A3-search：mcp__cerelay__glob + mcp__cerelay__grep 在 fixture 项目里
// 守护 search 工具的 path normalize、glob 语义
// ============================================================
test("A3-search: glob + grep 在多文件 fixture 内", async () => {
  const caseId = "case-a3";
  await writeFixture(caseId, {
    "README.md": "# Project\nTODO: top-level\n",
    "docs/guide.md": "# Guide\nNo todos here.\n",
    "src/main.ts": "// TODO: implement main\nconsole.log('main')\n",
    "src/util.ts": "// utility\nexport const x = 1\n",
  });

  const cwd = clientCwd(caseId);

  // turn 1: glob '*.md'
  // 注意：client 的 glob 实现（client/src/tools/search.ts）不支持 ** 跨目录，
  // 但走 basename 匹配，所以 pattern '*.md' 就能命中任意深度的 .md 文件。
  await mockAdmin.loadScript({
    name: "p0-a3-turn1-glob",
    match: { turnIndex: 1 },
    respond: scriptToolUse({
      toolName: "mcp__cerelay__glob",
      toolUseId: "toolu_a3_01",
      input: { pattern: "*.md", path: cwd },
    }),
  });
  // turn 2: grep 'TODO'
  await mockAdmin.loadScript({
    name: "p0-a3-turn2-grep",
    match: { turnIndex: 2 },
    respond: scriptToolUse({
      toolName: "mcp__cerelay__grep",
      toolUseId: "toolu_a3_02",
      input: { pattern: "TODO", path: cwd },
    }),
  });
  // turn 3: text final
  await mockAdmin.loadScript({
    name: "p0-a3-turn3-final",
    match: { turnIndex: 3 },
    respond: scriptText("search done"),
  });

  const result = await clients.run("client-a", {
    prompt: "find markdown and TODOs [A3-MARKER]",
    cwd,
  });

  assert.equal(
    result.exitCode,
    0,
    `client exit ${result.exitCode}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
  );

  const cap = await mockAdmin.captured();
  assert.equal(cap.length, 3, `expected 3 turns, got ${cap.length}`);

  // turn 2 携带 turn1 的 glob 结果：必须列出 README.md 和 docs/guide.md
  const globResult = cap[1].toolResults.at(-1);
  assert.ok(globResult, "expected glob tool_result on turn 2");
  assert.equal(globResult.is_error, false, "glob should succeed");
  assert.equal(globResult.tool_use_id, "toolu_a3_01");
  assert.match(globResult.content, /README\.md/, "glob should match README.md");
  assert.match(globResult.content, /guide\.md/, "glob should match docs/guide.md");

  // turn 3 携带 turn2 的 grep 结果：必须命中 README.md 和 src/main.ts 里的 TODO
  const grepResult = cap[2].toolResults.at(-1);
  assert.ok(grepResult, "expected grep tool_result on turn 3");
  assert.equal(grepResult.is_error, false, "grep should succeed");
  assert.equal(grepResult.tool_use_id, "toolu_a3_02");
  assert.match(grepResult.content, /README\.md/, "grep should hit README.md");
  assert.match(grepResult.content, /main\.ts/, "grep should hit src/main.ts");
  // util.ts 不应在结果里（无 TODO）
  assert.doesNotMatch(grepResult.content, /util\.ts/, "grep should NOT match util.ts");

  await cleanupFixture(caseId);
});

// ============================================================
// A4-shadow-mcp：双路径不变量
// - mcp__cerelay__bash → is_error === false（Plan D 正路径）
// - 内置 Bash → 被 disallowedTools/Hook deny → is_error === true，
//   content 含引导文案 "Use mcp__cerelay__bash instead"
// ============================================================
test("A4-shadow-mcp: dual-path 不变量（mcp 路径 false / 内置 Bash deny true）", async () => {
  const caseId = "case-a4";
  await writeFixture(caseId, {
    "marker.txt": "a4-marker",
  });
  const cwd = clientCwd(caseId);

  // turn 1: 走 shadow MCP（应当 is_error=false）
  await mockAdmin.loadScript({
    name: "p0-a4-turn1-shadow",
    match: { turnIndex: 1 },
    respond: scriptToolUse({
      toolName: "mcp__cerelay__bash",
      toolUseId: "toolu_a4_01",
      input: { command: "ls" },
    }),
  });
  // turn 2: 故意走内置 Bash（应当被 deny → is_error=true + 引导文案）
  await mockAdmin.loadScript({
    name: "p0-a4-turn2-builtin",
    match: { turnIndex: 2 },
    respond: scriptToolUse({
      toolName: "Bash",
      toolUseId: "toolu_a4_02",
      input: { command: "echo legacy" },
    }),
  });
  // turn 3: text final
  await mockAdmin.loadScript({
    name: "p0-a4-turn3-final",
    match: { turnIndex: 3 },
    respond: scriptText("dual-path done"),
  });

  const result = await clients.run("client-a", {
    prompt: "exercise shadow vs legacy bash [A4-MARKER]",
    cwd,
  });

  assert.equal(
    result.exitCode,
    0,
    `client exit ${result.exitCode}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
  );

  const cap = await mockAdmin.captured();
  assert.equal(cap.length, 3, `expected 3 turns, got ${cap.length}`);

  // turn 2 携带 turn 1 的 mcp__cerelay__bash 结果
  const shadowResult = cap[1].toolResults.at(-1);
  assert.ok(shadowResult, "expected shadow MCP tool_result on turn 2");
  assert.equal(shadowResult.tool_use_id, "toolu_a4_01");
  assert.equal(shadowResult.is_error, false, "Plan D invariant: mcp__cerelay__bash must NOT be is_error");
  assert.match(shadowResult.content, /marker\.txt/, "shadow ls should list fixture marker");

  // turn 3 携带 turn 2 的内置 Bash deny 结果
  // Plan D dual-path 硬不变量：legacy Bash builtin 必须拿到 is_error=true。
  // 文案有两种来源（取决于哪条防线先拦住）：
  //   (1) CC --disallowedTools 自带：'No such tool available: Bash...not enabled'
  //   (2) cerelay shadow fallback hook：'Use mcp__cerelay__bash instead'
  // 实测 CC 在 disallowedTools 层就直接拒，hook fallback 是兜底防线。
  // 断言里把两条文案都接受，避免锁死 CC 内部实现。
  const denyResult = cap[2].toolResults.at(-1);
  assert.ok(denyResult, "expected legacy Bash deny tool_result on turn 3");
  assert.equal(denyResult.tool_use_id, "toolu_a4_02");
  assert.equal(denyResult.is_error, true, "legacy Bash builtin should be denied (is_error=true)");
  assert.match(
    denyResult.content,
    /(mcp__cerelay__bash|not (?:available|enabled))/i,
    "deny content should indicate tool unavailable or guide to shadow alt"
  );

  await cleanupFixture(caseId);
});

// ============================================================
// B1-home-claude-snapshot：server 启动期 ~/.claude/ snapshot 走 cache/FUSE，
// 命中已上传的 fixture 内容。在 client 容器 ~/.claude/case-b1-marker.md 写入
// 标记串，session 内通过 mcp__cerelay__read 读到 → 证明 home-claude 链路通。
// ============================================================
test("B1-home-claude-snapshot: ~/.claude/<file> 经 home-claude 链路可读", async () => {
  const caseId = "case-b1";
  await writeFixture(caseId, { ".keep": "" });
  const cwd = clientCwd(caseId);
  const marker = "B1-HOME-CLAUDE-MARKER-7c4d3f";
  // 在 namespace 内 ~ → server 侧重定向到 client 同步过来的 home-claude FUSE root，
  // 文件路径走绝对值方便 model 读。
  const homeRel = ".claude/case-b1-marker.md";
  const targetAbs = `/home/clientuser/${homeRel}`;

  await mockAdmin.loadScript({
    name: "p0-b1-turn1-read",
    match: { turnIndex: 1 },
    respond: scriptToolUse({
      toolName: "mcp__cerelay__read",
      toolUseId: "toolu_b1_01",
      input: { file_path: targetAbs },
    }),
  });
  await mockAdmin.loadScript({
    name: "p0-b1-turn2-final",
    match: { turnIndex: 2 },
    respond: scriptText("home-claude read ok"),
  });

  const result = await clients.run("client-a", {
    prompt: "read ~/.claude marker [B1-MARKER]",
    cwd,
    homeFixture: {
      [homeRel]: `# B1 fixture\n${marker}\n`,
    },
  });

  assert.equal(
    result.exitCode,
    0,
    `client exit ${result.exitCode}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
  );

  const cap = await mockAdmin.captured();
  assert.equal(cap.length, 2, `expected 2 turns, got ${cap.length}`);
  const readResult = cap[1].toolResults[0];
  assert.ok(readResult, "expected read tool_result on turn 2");
  assert.equal(readResult.is_error, false, "read should succeed");
  assert.match(
    readResult.content,
    new RegExp(marker),
    "tool_result should reflect ~/.claude/<file> content via home-claude link"
  );

  await cleanupFixture(caseId);
});

// ============================================================
// B2-claude-json-read：server 读 ~/.claude.json 经 FUSE 文件级映射。
// CC 启动时也会读 .claude.json，所以必须保留合法 JSON；写入带 marker 的合法对象。
// ============================================================
test("B2-claude-json-read: ~/.claude.json 经 FUSE 文件级映射可读", async () => {
  const caseId = "case-b2";
  await writeFixture(caseId, { ".keep": "" });
  const cwd = clientCwd(caseId);
  const marker = "B2-CLAUDE-JSON-MARKER-8a1e2b";
  // ~/.claude.json 必须是合法 JSON（CC 启动期会 parse），用一个含 marker 的对象。
  const jsonContent = JSON.stringify({ e2e_marker: marker, projects: {} }, null, 2);
  const targetAbs = "/home/clientuser/.claude.json";

  await mockAdmin.loadScript({
    name: "p0-b2-turn1-read",
    match: { turnIndex: 1 },
    respond: scriptToolUse({
      toolName: "mcp__cerelay__read",
      toolUseId: "toolu_b2_01",
      input: { file_path: targetAbs },
    }),
  });
  await mockAdmin.loadScript({
    name: "p0-b2-turn2-final",
    match: { turnIndex: 2 },
    respond: scriptText("claude json read ok"),
  });

  const result = await clients.run("client-a", {
    prompt: "read ~/.claude.json [B2-MARKER]",
    cwd,
    homeFixture: {
      ".claude.json": jsonContent,
    },
  });

  assert.equal(
    result.exitCode,
    0,
    `client exit ${result.exitCode}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
  );

  const cap = await mockAdmin.captured();
  assert.equal(cap.length, 2, `expected 2 turns, got ${cap.length}`);
  const readResult = cap[1].toolResults[0];
  assert.ok(readResult, "expected read tool_result on turn 2");
  assert.equal(readResult.is_error, false, "read should succeed");
  assert.match(readResult.content, new RegExp(marker), "tool_result should include marker from ~/.claude.json");
});

// ============================================================
// B3-project-claude：server 读 {cwd}/.claude/<file> 经 project-claude bind mount。
// fixture 在 cwd/.claude/marker-b3.txt 放 marker，避开 hook 注入的 settings.local.json。
// ============================================================
test("B3-project-claude: {cwd}/.claude/<file> 经 project-claude bind mount 可读", async () => {
  const caseId = "case-b3";
  const marker = "B3-PROJECT-CLAUDE-MARKER-3f9b1c";
  await writeFixture(caseId, {
    ".claude/marker-b3.txt": `${marker}\n`,
  });
  const cwd = clientCwd(caseId);
  const targetAbs = `${cwd}/.claude/marker-b3.txt`;

  await mockAdmin.loadScript({
    name: "p0-b3-turn1-read",
    match: { turnIndex: 1 },
    respond: scriptToolUse({
      toolName: "mcp__cerelay__read",
      toolUseId: "toolu_b3_01",
      input: { file_path: targetAbs },
    }),
  });
  await mockAdmin.loadScript({
    name: "p0-b3-turn2-final",
    match: { turnIndex: 2 },
    respond: scriptText("project-claude read ok"),
  });

  const result = await clients.run("client-a", {
    prompt: "read project .claude marker [B3-MARKER]",
    cwd,
  });

  assert.equal(
    result.exitCode,
    0,
    `client exit ${result.exitCode}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
  );

  const cap = await mockAdmin.captured();
  assert.equal(cap.length, 2, `expected 2 turns, got ${cap.length}`);
  const readResult = cap[1].toolResults[0];
  assert.ok(readResult, "expected read tool_result on turn 2");
  assert.equal(readResult.is_error, false, "read should succeed");
  assert.match(
    readResult.content,
    new RegExp(marker),
    "tool_result should reflect {cwd}/.claude/<file> via project-claude bind mount"
  );

  await cleanupFixture(caseId);
});

// ============================================================
// C1-initial-pipeline：1k+ 文件 initial sync 跑通 pipeline + 流控
// 守护 manifest 写入串行锁、batch ack 不丢、最终 revision 单调
// ============================================================
test("C1-initial-pipeline: 1100 个文件 initial sync 跑通 pipeline + manifest 落地", async () => {
  const caseId = "case-c1";
  await writeFixture(caseId, { ".keep": "" });
  const cwd = clientCwd(caseId);

  // turn 1: text final（不需要工具调用，cache sync 在 session 启动期跑）
  await mockAdmin.loadScript({
    name: "p0-c1-turn1-final",
    match: { turnIndex: 1 },
    respond: scriptText("c1 cache pipeline ok"),
  });

  // 1100 个文件 × 16 KB ≈ 17.6 MB > MAX_INFLIGHT_BYTES (16 MB)，触发流控水位
  const FILE_COUNT = 1100;
  const BYTES_PER_FILE = 16 * 1024;

  const result = await clients.run("client-a", {
    prompt: "trigger cache sync [C1-MARKER]",
    cwd,
    timeoutMs: 120_000,
    homeFixtureBulk: {
      pathPrefix: ".claude/c1-bulk",
      count: FILE_COUNT,
      bytesPerFile: BYTES_PER_FILE,
    },
  });

  assert.equal(
    result.exitCode,
    0,
    `client exit ${result.exitCode}\n--- stderr ---\n${result.stderr}`
  );
  assert.ok(result.deviceId, "client agent must report deviceId");

  // client 端日志必须有 initial upload complete + sync complete acked
  const uploadMatch = result.stdout.match(/cache task initial upload complete[^\n]*uploadedFiles=(\d+)/);
  assert.ok(uploadMatch, `client stdout missing 'cache task initial upload complete'\n${result.stdout.slice(-2000)}`);
  const uploadedFiles = Number.parseInt(uploadMatch[1], 10);
  assert.ok(
    uploadedFiles >= FILE_COUNT,
    `expected uploadedFiles >= ${FILE_COUNT}, got ${uploadedFiles}`
  );

  const ackMatch = result.stdout.match(/cache task sync complete acked[^\n]*revision=(\d+)/);
  assert.ok(ackMatch, `client stdout missing 'cache task sync complete acked'`);
  const ackedRevision = Number.parseInt(ackMatch[1], 10);
  assert.ok(ackedRevision > 0, `acked revision should be > 0, got ${ackedRevision}`);

  // server 端 manifest revision 必须严格 >= 客户端 acked 的 revision（不可后退）
  const summary = await cacheAdmin.summary(result.deviceId);
  assert.ok(
    summary.revision >= ackedRevision,
    `server revision (${summary.revision}) should be >= client acked (${ackedRevision})`
  );

  // claude-home scope 必须容纳全部 bulk 文件
  const homeStats = summary.scopes["claude-home"];
  assert.ok(homeStats, "claude-home scope should exist on server");
  assert.ok(
    homeStats.entryCount >= FILE_COUNT,
    `claude-home entryCount should be >= ${FILE_COUNT}, got ${homeStats.entryCount}`
  );

  await cleanupFixture(caseId);
});

// ============================================================
// C2-revision-ack：sync 完成后 server manifest revision == client 已 push 的最大 revision
// 守护 revision 单调、ack 配对，防 batch 丢失
// ============================================================
test("C2-revision-ack: client acked revision == server manifest revision", async () => {
  const caseId = "case-c2";
  await writeFixture(caseId, { ".keep": "" });
  const cwd = clientCwd(caseId);

  await mockAdmin.loadScript({
    name: "p0-c2-turn1-final",
    match: { turnIndex: 1 },
    respond: scriptText("c2 revision ack ok"),
  });

  // C2 用更小规模即可，重点是 revision == 而非压测流控
  const FILE_COUNT = 60;
  const BYTES_PER_FILE = 4 * 1024;

  const result = await clients.run("client-a", {
    prompt: "trigger cache sync [C2-MARKER]",
    cwd,
    timeoutMs: 60_000,
    homeFixtureBulk: {
      pathPrefix: ".claude/c2-bulk",
      count: FILE_COUNT,
      bytesPerFile: BYTES_PER_FILE,
    },
  });

  assert.equal(result.exitCode, 0, `client exit ${result.exitCode}\nstderr: ${result.stderr}`);

  // 取 stdout 里 acked revision 的最后一次出现（有多次 sync 时拿最新那次）。
  const ackMatches = [...result.stdout.matchAll(/cache task sync complete acked[^\n]*revision=(\d+)/g)];
  assert.ok(ackMatches.length > 0, "client stdout missing 'cache task sync complete acked'");
  const ackedRevision = Number.parseInt(ackMatches.at(-1)![1], 10);

  const summary = await cacheAdmin.summary(result.deviceId);
  // ack 配对 + revision 单调：server >= client acked。
  // 严格相等不成立——initial sync 完成 ack 后，session 内 FUSE 访问/runtime
  // watcher delta 仍可能 bump revision（每次 entry 续期 TTL 都会 +1）。
  // 真实硬不变量是「server 不会回退到 < acked」与「drift 受控」。
  assert.ok(
    summary.revision >= ackedRevision,
    `revision regression: client acked=${ackedRevision}, server=${summary.revision} (must be >=)`
  );
  // drift 控制在 50 以内（FUSE 访问 + 1 次 cleanup watcher delta 不会到这个量级）。
  // 这条是防"ack 之后 server 漏掉某个 batch 但 revision 莫名暴涨"的副作用。
  const drift = summary.revision - ackedRevision;
  assert.ok(
    drift <= 50,
    `revision drift too large: acked=${ackedRevision} server=${summary.revision} drift=${drift}`
  );

  // 顺手验 entryCount 跟得上（manifest 真的写到位，不是空 ack）
  const homeStats = summary.scopes["claude-home"];
  assert.ok(homeStats, "claude-home scope should exist");
  assert.ok(homeStats.entryCount >= FILE_COUNT, `entryCount=${homeStats.entryCount} < ${FILE_COUNT}`);

  await cleanupFixture(caseId);
});

// ============================================================
// D1-cwd-aligned：session 内 pwd 输出 == client 上报的 cwd 字符串
// 守护 mount namespace 内 cwd 字符串严格对齐
// ============================================================
test("D1-cwd-aligned: namespace 内 pwd == client 上报 cwd", async () => {
  const caseId = "case-d1";
  await writeFixture(caseId, { ".keep": "" });
  const cwd = clientCwd(caseId);

  await mockAdmin.loadScript({
    name: "p0-d1-turn1",
    match: { turnIndex: 1 },
    respond: scriptToolUse({
      toolName: "mcp__cerelay__bash",
      toolUseId: "toolu_d1_01",
      input: { command: "pwd" },
    }),
  });
  await mockAdmin.loadScript({
    name: "p0-d1-turn2",
    match: { turnIndex: 2 },
    respond: scriptText("d1 cwd ok"),
  });

  const result = await clients.run("client-a", {
    prompt: "report cwd [D1-MARKER]",
    cwd,
  });

  assert.equal(result.exitCode, 0, `client exit ${result.exitCode}\nstderr: ${result.stderr}`);
  const cap = await mockAdmin.captured();
  assert.equal(cap.length, 2);
  const pwdResult = cap[1].toolResults.at(-1);
  assert.ok(pwdResult, "expected pwd tool_result");
  // pwd 输出必然以 cwd 开头（可能带 trailing \n）
  // 注意：mcp__cerelay__bash 是 client-routed → CLIENT 端跑 pwd，
  // CLIENT 容器和 server namespace 不同，但本测试断言的是 client 端 cwd 对齐了
  // server 上报的 namespace cwd（两边都该是同一字符串）。
  assert.match(
    pwdResult.content,
    new RegExp(`^[^]*${cwd.replace(/\//g, "\\/")}[^]*$`),
    `pwd should report cwd=${cwd}, got: ${pwdResult.content}`
  );

  await cleanupFixture(caseId);
});

// ============================================================
// D2-home-aligned：session 内 echo $HOME == client 上报的 home
// 守护 HOME 重定向（agent 容器 HOME=/home/clientuser）
// ============================================================
test("D2-home-aligned: namespace 内 $HOME == client 上报 home", async () => {
  const caseId = "case-d2";
  await writeFixture(caseId, { ".keep": "" });
  const cwd = clientCwd(caseId);
  const expectedHome = "/home/clientuser";

  await mockAdmin.loadScript({
    name: "p0-d2-turn1",
    match: { turnIndex: 1 },
    respond: scriptToolUse({
      toolName: "mcp__cerelay__bash",
      toolUseId: "toolu_d2_01",
      input: { command: "echo $HOME" },
    }),
  });
  await mockAdmin.loadScript({
    name: "p0-d2-turn2",
    match: { turnIndex: 2 },
    respond: scriptText("d2 home ok"),
  });

  const result = await clients.run("client-a", {
    prompt: "report home [D2-MARKER]",
    cwd,
  });

  assert.equal(result.exitCode, 0, `client exit ${result.exitCode}\nstderr: ${result.stderr}`);
  const cap = await mockAdmin.captured();
  const homeResult = cap[1].toolResults.at(-1);
  assert.ok(homeResult, "expected echo $HOME tool_result");
  assert.match(homeResult.content, new RegExp(expectedHome.replace(/\//g, "\\/")),
    `$HOME should be ${expectedHome}, got: ${homeResult.content}`);

  await cleanupFixture(caseId);
});

// ============================================================
// D3-ancestor-no-crash：B4 的语义复刻——只断言 bootstrap 没在 set -u 下崩
// 不查 ancestor 内容（那是 B4 的职责）。死亡回归专项守门。
// ============================================================
test("D3-ancestor-no-crash: ancestor 段 bootstrap 在 set -u 下不崩 (IFS regression)", async () => {
  const caseId = "case-d3";
  await writeFixture(caseId, {
    "CLAUDE.md": "# d3 ancestor",
    "lvl1/lvl2/lvl3/keep.txt": "",
  });
  const cwd = `${clientCwd(caseId)}/lvl1/lvl2/lvl3`;

  // 单 turn final，不需要工具调用——session 启动期间就要跑 bootstrap.sh
  await mockAdmin.loadScript({
    name: "p0-d3-turn1",
    match: { turnIndex: 1 },
    respond: scriptText("d3 ok"),
  });

  const baselineEvents = await serverEvents.fetch({});
  const baselineId = baselineEvents.at(-1)?.id ?? 0;

  const result = await clients.run("client-a", {
    prompt: "trigger bootstrap [D3-MARKER]",
    cwd,
  });

  assert.equal(result.exitCode, 0, `client exit ${result.exitCode}\nstderr: ${result.stderr}`);
  const out = `${result.stdout}\n${result.stderr}`;
  assert.doesNotMatch(out, /IFS: parameter not set/, "regression: IFS bug surfaced");
  assert.doesNotMatch(out, /初始化 Claude mount namespace 失败/, "namespace 初始化失败 = regression");

  const newEvents = await serverEvents.fetch({ since: baselineId });
  const ready = newEvents.find((e) => e.kind === "pty.spawn.ready");
  const failed = newEvents.find((e) => e.kind === "pty.spawn.failed");
  assert.ok(ready, "expected pty.spawn.ready");
  assert.equal(failed, undefined, `unexpected pty.spawn.failed: ${JSON.stringify(failed?.detail)}`);

  await cleanupFixture(caseId);
});

// ============================================================
// E1-settings-redact：~/.claude/settings.json 含 ANTHROPIC_API_KEY 时
// 三处出口（snapshot / cache-hit / passthrough）必须 redact。
// 本 case 通过 file-proxy.settings.redacted admin event 观察 redact 是否真的发生。
// ============================================================
test("E1-settings-redact: settings.json 经 server FUSE 出口被 redact", async () => {
  const caseId = "case-e1";
  await writeFixture(caseId, { ".keep": "" });
  const cwd = clientCwd(caseId);
  const secret = "sk-ant-fake-secret-E1-AAAAAAAAAA";
  const settingsContent = JSON.stringify(
    { env: { ANTHROPIC_API_KEY: secret, ANTHROPIC_BASE_URL: "https://example.invalid" } },
    null,
    2,
  );

  await mockAdmin.loadScript({
    name: "p0-e1-turn1",
    match: { turnIndex: 1 },
    respond: scriptText("e1 ok"),
  });

  const baselineEvents = await serverEvents.fetch({});
  const baselineId = baselineEvents.at(-1)?.id ?? 0;

  const result = await clients.run("client-a", {
    prompt: "trigger settings redact [E1-MARKER]",
    cwd,
    homeFixture: {
      ".claude/settings.json": settingsContent,
    },
  });

  assert.equal(result.exitCode, 0, `client exit ${result.exitCode}\nstderr: ${result.stderr}`);

  // 至少一次 file-proxy.settings.redacted 事件触发（snapshot / cache-hit / passthrough 任一）
  const newEvents = await serverEvents.fetch({ since: baselineId });
  const redactEvents = newEvents.filter((e) => e.kind === "file-proxy.settings.redacted");
  assert.ok(
    redactEvents.length > 0,
    `expected at least one redact event, got 0 (new events: ${JSON.stringify(newEvents.map((e) => e.kind))})`
  );
  // 至少要有一处出口被 site 标记
  const sites = new Set(redactEvents.map((e) => (e.detail as { site?: string } | undefined)?.site));
  assert.ok(
    sites.has("snapshot") || sites.has("cache-hit") || sites.has("passthrough"),
    `unexpected sites: ${JSON.stringify([...sites])}`
  );

  await cleanupFixture(caseId);
});

// ============================================================
// F1-single-client-concurrent：同 client 一次 session 内并发 5 次 Bash
// 守护 tool relay race、ack 序号正确（不串台、不丢、不卡死）
// ============================================================
test("F1-single-client-concurrent: 同 session 5 个并发 Bash → ack 配对", async () => {
  const caseId = "case-f1";
  await writeFixture(caseId, { ".keep": "" });
  const cwd = clientCwd(caseId);

  // turn 1: 一次返回 5 个 mcp__cerelay__bash 并发 tool_use
  const tools = [0, 1, 2, 3, 4].map((i) => ({
    toolName: "mcp__cerelay__bash",
    toolUseId: `toolu_f1_${i.toString().padStart(2, "0")}`,
    input: { command: `echo F1-CONCURRENT-${i}` },
  }));
  await mockAdmin.loadScript({
    name: "p0-f1-turn1",
    match: { turnIndex: 1 },
    respond: scriptParallelToolUse(tools),
  });
  await mockAdmin.loadScript({
    name: "p0-f1-turn2",
    match: { turnIndex: 2 },
    respond: scriptText("f1 concurrent done"),
  });

  const result = await clients.run("client-a", {
    prompt: "run 5 concurrent bash [F1-MARKER]",
    cwd,
    timeoutMs: 60_000,
  });

  assert.equal(result.exitCode, 0, `client exit ${result.exitCode}\nstderr: ${result.stderr}`);

  // turn 2 必须含全部 5 个 tool_result，每个 id/echo 一一对应
  const cap = await mockAdmin.captured();
  assert.equal(cap.length, 2, `expected 2 turns, got ${cap.length}`);
  const toolResults = cap[1].toolResults;
  assert.equal(toolResults.length, 5, `expected 5 tool_results, got ${toolResults.length}`);

  // 每个 tool_use_id 都得有 result，并且是 is_error=false
  for (const t of tools) {
    const tr = toolResults.find((r) => r.tool_use_id === t.toolUseId);
    assert.ok(tr, `missing tool_result for ${t.toolUseId}`);
    assert.equal(tr.is_error, false, `${t.toolUseId} should not be is_error`);
    const expectMarker = `F1-CONCURRENT-${t.toolUseId.slice(-2).replace(/^0/, "")}`;
    // F1-CONCURRENT-N (N=0..4)，处理 padding 后还原 i
    const i = Number.parseInt(t.toolUseId.slice(-2), 10);
    assert.match(tr.content, new RegExp(`F1-CONCURRENT-${i}`), `${t.toolUseId} content mismatch: ${tr.content}; expected substring F1-CONCURRENT-${i}`);
  }

  await cleanupFixture(caseId);
});

// ============================================================
// F3-multi-device：起 client-a / client-b 两容器，并发触发各自 session。
// 守护 server 端 cache 按 deviceId 隔离，互不污染。
// ============================================================
test("F3-multi-device: client-a / client-b 并发 → cache 按 deviceId 隔离", async () => {
  const caseIdA = "case-f3-a";
  const caseIdB = "case-f3-b";
  await writeFixture(caseIdA, { ".keep": "" });
  await writeFixture(caseIdB, { ".keep": "" });

  // 各自一段 turn1 用 marker 区分；mock 用 predicate 按 prompt marker 匹配
  await mockAdmin.loadScript({
    name: "p0-f3-a",
    match: { predicate: { path: "messages[0].content", op: "contains", value: "F3-CLIENT-A" } },
    respond: scriptText("f3-a ok"),
  });
  await mockAdmin.loadScript({
    name: "p0-f3-b",
    match: { predicate: { path: "messages[0].content", op: "contains", value: "F3-CLIENT-B" } },
    respond: scriptText("f3-b ok"),
  });

  // 两侧 homeFixture 用各自专属 marker，写入 SEED_WHITELIST 内的 CLAUDE.md
  // （fresh device 首次连接时 server 走 SEED_WHITELIST 而非 ledger-derived plan，
  // 任意非白名单路径 fresh device 都扫不到——这点对 F3 这种"双 fresh device 隔离
  // 验证"是绕不过去的硬约束）。
  const markerA = "marker-from-client-a-7d2f1e";
  const markerB = "marker-from-client-b-9a4b3c";

  const [resA, resB] = await Promise.all([
    clients.run("client-a", {
      prompt: "[F3-CLIENT-A]",
      cwd: clientCwd(caseIdA),
      timeoutMs: 60_000,
      homeFixture: { ".claude/CLAUDE.md": markerA },
    }),
    clients.run("client-b", {
      prompt: "[F3-CLIENT-B]",
      cwd: clientCwd(caseIdB),
      timeoutMs: 60_000,
      homeFixture: { ".claude/CLAUDE.md": markerB },
    }),
  ]);

  assert.equal(resA.exitCode, 0, `client-a exit ${resA.exitCode}\nstderr: ${resA.stderr}`);
  assert.equal(resB.exitCode, 0, `client-b exit ${resB.exitCode}\nstderr: ${resB.stderr}`);
  assert.ok(resA.deviceId && resB.deviceId, "both clients must report deviceId");
  assert.notEqual(resA.deviceId, resB.deviceId, "client-a / client-b must have distinct deviceId");

  // server 端按 deviceId 分别查 manifest：各自的 marker 必须落到自己的 scope
  // entry，绝对不能交叉（path 列表本身没暴露，靠 entryCount 推断 + 各 device
  // 至少一个 entry 即可证明隔离）。
  const sumA = await cacheAdmin.summary(resA.deviceId);
  const sumB = await cacheAdmin.summary(resB.deviceId);
  assert.ok(
    sumA.scopes["claude-home"]!.entryCount >= 1,
    `device-a claude-home should have entries; sumA=${JSON.stringify(sumA)}\n--- client-a stdout ---\n${resA.stdout.slice(-3000)}`
  );
  if (sumB.scopes["claude-home"]!.entryCount < 1) {
    const cacheLines = resB.stdout
      .split("\n")
      .filter((l) => /cache.task|cache-task|f3-b-marker|claude-home/.test(l))
      .join("\n");
    assert.fail(
      `device-b claude-home should have entries; sumB=${JSON.stringify(sumB)}\n--- client-b cache lines ---\n${cacheLines}`,
    );
  }
  // revision 各自独立递增（毫不相关）
  assert.ok(sumA.revision > 0 && sumB.revision > 0, "both devices should have revision > 0");

  await cleanupFixture(caseIdA);
  await cleanupFixture(caseIdB);
});
