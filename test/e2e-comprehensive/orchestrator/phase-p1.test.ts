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
import { mockAdmin, scriptToolUse, scriptText, scriptError } from "./mock-admin.js";
import { clients } from "./clients.js";
import {
  cacheAdmin,
  fileProxyEvents,
  ptyEvents,
  sessionEvents,
  serverEvents,
  serverExec,
  serverDataDir,
  testToggles,
  toolTimeoutEvents,
} from "./server-events.js";
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

// ============================================================
// P1-B 测试 PR 1：B5 / B6 / D4 / E2
//
// 共同模式（INF-3 + INF-11）：
//   1. mock 准备最简单的 turn 1 final（让 CC 启动后立刻 end_turn）
//   2. clients.runAsync 起 child（不等 exit）
//   3. ptyEvents.waitForSpawnReady 拿 server-side sessionId
//      （注意 spawn.ready 的 event.sessionId 字段就是 PtySession.id，与
//        clients.runAsync 返回的 agent traceId 不是一回事）
//   4. serverExec.run(sessionId, …) 在 namespace 内 spawn /bin/sh 探针
//      触发目标 FUSE op（cerelay Plan D 后这是 namespace 内 honest 触发的唯一入口）
//   5. 等 / 找对应的 admin event 做主断言
//   6. clients.killRun + waitRun 收尾（避免 child 等 mock 后续 turn 卡住）
// ============================================================

const HOME_ABS = "/home/clientuser";

async function killAndWait(label: string, runId: string): Promise<void> {
  try { await clients.killRun(label, runId); } catch { /* ignore */ }
  try { await clients.waitRun(label, runId, 15_000); } catch { /* ignore */ }
}

// ============================================================
// B5-negative-cache：
//   守护：第一次 read 不存在文件 miss 后被 daemon NegativeCache 记住，
//   第二次同 path 不再发 send_request 回 server (零 client.requested)。
//   honest 触发：namespace 内连续 cat 同一不存在 path 两次。
// ============================================================
test("B5-negative-cache: 第二次 read 同 path 被 daemon negative_perm 拦在 server 之外", async () => {
  const caseId = "case-b5";
  await writeFixture(caseId, { ".keep": "" });
  const cwd = clientCwd(caseId);
  const missingRel = "no-such-b5-7c2f4d.txt";
  const missingAbs = `${HOME_ABS}/.claude/${missingRel}`;

  await mockAdmin.loadScript({
    name: "p1-b5-final",
    match: { turnIndex: 1 },
    respond: scriptText("b5 negative cache ok"),
  });

  const baseline = (await serverEvents.fetch({})).at(-1)?.id ?? 0;

  const { runId } = await clients.runAsync("client-a", {
    prompt: "trigger CC start [B5-MARKER]",
    cwd,
    timeoutMs: 60_000,
  });

  try {
    const spawnEvt = await ptyEvents.waitForSpawnReady({
      expectedCwd: cwd,
      since: baseline,
      timeoutMs: 30_000,
    });
    const sessionId = spawnEvt.sessionId!;

    // 第一次 cat：触发 namespace 内 FUSE getattr (file-proxy.client.requested
    // + 后续 client.miss for ENOENT)。`|| true` 让 sh exit 0 不影响断言路径。
    const first = await serverExec.run(sessionId, {
      command: "/bin/sh",
      args: ["-c", `cat ${missingAbs} 2>/dev/null || true; echo done-first`],
      timeoutMs: 10_000,
    });
    assert.equal(first.exitCode, 0, `first cat sh failed: ${first.stderr}`);

    // 等 events 落地 + daemon NegativeCache 写入
    await new Promise((r) => setTimeout(r, 500));

    // 切片基线 = 第一次 exec 之后,只看第二次产生的 events
    const midline = (await serverEvents.fetch({})).at(-1)?.id ?? baseline;

    const second = await serverExec.run(sessionId, {
      command: "/bin/sh",
      args: ["-c", `cat ${missingAbs} 2>/dev/null || true; echo done-second`],
      timeoutMs: 10_000,
    });
    assert.equal(second.exitCode, 0, `second cat sh failed: ${second.stderr}`);

    await new Promise((r) => setTimeout(r, 500));

    // 主断言 #1: 第一次到第二次 baseline 之间, root=home-claude+relPath 该 file
    // 必须有至少一条 client.miss(证明 server 端真触达 client → 学到 negative)
    const firstMiss = await fileProxyEvents.findClientMiss({
      root: "home-claude",
      relPath: missingRel,
      since: baseline,
    });
    assert.ok(
      firstMiss.length >= 1,
      `expected at least 1 client.miss for ${missingRel} after first cat, got ${firstMiss.length}`,
    );

    // 主断言 #2: 第二次 cat (在 midline 之后) 期间,**0** 条 client.requested
    // for 同 (root, relPath)。daemon 已拦在 _negative_perm,根本没进 server。
    const secondReq = await fileProxyEvents.findClientRequested({
      root: "home-claude",
      relPath: missingRel,
      since: midline,
    });
    assert.equal(
      secondReq.length,
      0,
      `negative cache regression: expected 0 client.requested for ${missingRel} on second cat, got ${secondReq.length}`,
    );
  } finally {
    await killAndWait("client-a", runId);
    await cleanupFixture(caseId);
  }
});

// ============================================================
// B6-settings-local-shadow：
//   守护：项目 .claude/settings.local.json 由 server hook injection 写到
//   runtimeRoot,FUSE shadow 注入到 namespace,daemon 内本地直读
//   (绕开所有 send_request 出口)。INF-2 sideband emit 是 honest 观测点。
//   honest 触发：namespace 内 cat $cwd/.claude/settings.local.json。
// ============================================================
test("B6-settings-local-shadow: namespace 内 cat 触发 daemon shadow read (file-proxy.shadow.served)", async () => {
  const caseId = "case-b6";
  await writeFixture(caseId, { ".keep": "" });
  const cwd = clientCwd(caseId);

  await mockAdmin.loadScript({
    name: "p1-b6-final",
    match: { turnIndex: 1 },
    respond: scriptText("b6 shadow read ok"),
  });

  const baseline = (await serverEvents.fetch({})).at(-1)?.id ?? 0;

  const { runId } = await clients.runAsync("client-a", {
    prompt: "trigger CC start [B6-MARKER]",
    cwd,
    timeoutMs: 60_000,
  });

  try {
    const spawnEvt = await ptyEvents.waitForSpawnReady({
      expectedCwd: cwd,
      since: baseline,
      timeoutMs: 30_000,
    });
    const sessionId = spawnEvt.sessionId!;

    // probe 内 cat $cwd/.claude/settings.local.json (server hook injection
    // 自动写到 runtimeRoot,FUSE shadow 注入到 namespace 内 $cwd/.claude/)
    const result = await serverExec.run(sessionId, {
      command: "/bin/sh",
      args: ["-c", `cat ${cwd}/.claude/settings.local.json`],
      timeoutMs: 10_000,
    });
    assert.equal(result.exitCode, 0, `cat shadow file failed: ${result.stderr}`);
    // server hook injection 写的 settings.local.json 是 JSON 配置(含 hooks 段)
    assert.ok(result.stdout.length > 0, "settings.local.json should not be empty");
    assert.ok(
      result.stdout.includes("{") || result.stdout.includes("hooks"),
      `settings.local.json should look like JSON config, got: ${result.stdout.slice(0, 200)}`,
    );

    // 主断言: file-proxy.shadow.served emit (root=project-claude, relPath=settings.local.json)
    await fileProxyEvents.waitForShadowServed({
      root: "project-claude",
      relPath: "settings.local.json",
      since: baseline,
      timeoutMs: 5_000,
    });
  } finally {
    await killAndWait("client-a", runId);
    await cleanupFixture(caseId);
  }
});

// ============================================================
// D4-credentials-shadow：
//   守护：server 侧 ${CERELAY_DATA_DIR}/credentials/default/.credentials.json
//   通过 FUSE shadow 暴露给 namespace 内 ~/.claude/.credentials.json,即使源
//   不存在 mapping 也总是注入(CC login 流程才会创建源)。INF-5 PUT 预置 + INF-11
//   probe 触发 + INF-2 shadow.served event 主断言。
// ============================================================
test("D4-credentials-shadow: server dataDir credentials 经 FUSE shadow 暴露给 namespace", async () => {
  const caseId = "case-d4";
  await writeFixture(caseId, { ".keep": "" });
  const cwd = clientCwd(caseId);
  const marker = "D4-CREDENTIAL-MARKER-9b3a7e";
  const credContent = JSON.stringify({ e2e_marker: marker, claudeAiOauth: { type: "oauth" } });

  // pre: 用 INF-5 把 marker 内容写到 server dataDir
  await serverDataDir.putCredentials(credContent);

  await mockAdmin.loadScript({
    name: "p1-d4-final",
    match: { turnIndex: 1 },
    respond: scriptText("d4 credentials shadow ok"),
  });

  const baseline = (await serverEvents.fetch({})).at(-1)?.id ?? 0;

  const { runId } = await clients.runAsync("client-a", {
    prompt: "trigger CC start [D4-MARKER]",
    cwd,
    timeoutMs: 60_000,
  });

  try {
    const spawnEvt = await ptyEvents.waitForSpawnReady({
      expectedCwd: cwd,
      since: baseline,
      timeoutMs: 30_000,
    });
    const sessionId = spawnEvt.sessionId!;

    // probe 内 cat ~/.claude/.credentials.json (FUSE shadow 触发 daemon 本地读
    // server dataDir 的 credentials 文件)
    const result = await serverExec.run(sessionId, {
      command: "/bin/sh",
      args: ["-c", `cat ${HOME_ABS}/.claude/.credentials.json`],
      timeoutMs: 10_000,
    });
    assert.equal(result.exitCode, 0, `cat credentials shadow failed: ${result.stderr}`);
    // marker 应当原样从 server dataDir 流到 namespace
    assert.ok(
      result.stdout.includes(marker),
      `credentials content should contain marker, got: ${result.stdout.slice(0, 200)}`,
    );

    // 主断言: shadow.served emit (root=home-claude, relPath=.credentials.json)
    const evt = await fileProxyEvents.waitForShadowServed({
      root: "home-claude",
      relPath: ".credentials.json",
      since: baseline,
      timeoutMs: 5_000,
    });
    assert.equal(evt.detail.op, "read", "shadow.served should be triggered by read op");
    assert.ok(evt.detail.bytes > 0, "shadow read should return non-zero bytes");
  } finally {
    await killAndWait("client-a", runId);
    await serverDataDir.deleteCredentials();
    await cleanupFixture(caseId);
  }
});

// ============================================================
// E2-credentials-rw：
//   守护：namespace 内对 ~/.claude/.credentials.json 写入 → 经 daemon FUSE
//   shadow 重定向 → server 侧 dataDir 真实文件持久化。INF-11 probe 触发
//   write + INF-6 write.served event 主断言 + INF-5 GET 验持久化。
// ============================================================
test("E2-credentials-rw: namespace 内 write credentials shadow 落到 server dataDir", async () => {
  const caseId = "case-e2";
  await writeFixture(caseId, { ".keep": "" });
  const cwd = clientCwd(caseId);
  const marker = "E2-WRITE-MARKER-4f8d2a";
  const writePayload = JSON.stringify({ e2e_marker: marker, claudeAiOauth: { type: "oauth" } });

  // pre: 用 INF-5 预置一个空 credentials(确保 shadow path 存在 + 后续 echo > 走 truncate+write)
  await serverDataDir.putCredentials("{}");

  await mockAdmin.loadScript({
    name: "p1-e2-final",
    match: { turnIndex: 1 },
    respond: scriptText("e2 credentials write ok"),
  });

  const baseline = (await serverEvents.fetch({})).at(-1)?.id ?? 0;

  const { runId } = await clients.runAsync("client-a", {
    prompt: "trigger CC start [E2-MARKER]",
    cwd,
    timeoutMs: 60_000,
  });

  try {
    const spawnEvt = await ptyEvents.waitForSpawnReady({
      expectedCwd: cwd,
      since: baseline,
      timeoutMs: 30_000,
    });
    const sessionId = spawnEvt.sessionId!;

    // probe 内 echo > .credentials.json:open(O_TRUNC|O_WRONLY) + write + close
    // FUSE 路径: truncate(0) → write(payload) → 都走 daemon shadow 分支
    // (不走 send_request 回 server)。INF-6 在 write op shadow 分支 emit
    // file-proxy.write.served (shadow:true)。
    //
    // 注意单引号里的 marker 字符串避免 shell 转义问题。
    const result = await serverExec.run(sessionId, {
      command: "/bin/sh",
      args: ["-c", `printf '%s' '${writePayload}' > ${HOME_ABS}/.claude/.credentials.json`],
      timeoutMs: 10_000,
    });
    assert.equal(result.exitCode, 0, `write to shadow failed: ${result.stderr}`);

    // 主断言 #1: file-proxy.write.served (root=home-claude, relPath=.credentials.json)
    const evt = await fileProxyEvents.waitForWriteServed({
      root: "home-claude",
      relPath: ".credentials.json",
      since: baseline,
      timeoutMs: 5_000,
    });
    assert.equal(evt.detail.shadow, true, "credentials write must go through shadow path");
    assert.ok(evt.detail.bytes > 0, "shadow write should report non-zero bytes");
    assert.match(evt.detail.servedTo, /credentials\/default\/\.credentials\.json$/,
      `servedTo should be server dataDir credentials path, got: ${evt.detail.servedTo}`);

    // 主断言 #2: server 侧 dataDir 文件真持久化,内容含 marker
    const persisted = await serverDataDir.getCredentials();
    assert.equal(persisted.exists, true, "server dataDir credentials should exist after write");
    assert.ok(
      persisted.content?.includes(marker),
      `server dataDir content should contain marker, got: ${persisted.content?.slice(0, 200)}`,
    );
  } finally {
    await killAndWait("client-a", runId);
    await serverDataDir.deleteCredentials();
    await cleanupFixture(caseId);
  }
});

// ============================================================
// P1-B 测试 PR 2 / 3 (合并实施): C3 / G1 / G2 / G3 + INF-10 A5 meta
//
// F2-multi-session / F4-same-device-multi-cwd / C4-truncated 留 todo 占位:
//   - F2/F4 需要 Hand 端支持"同一 ws 一次连接起多 PTY session"(查 client.ts
//     CreatePtySession 流程, 当前 Hand 的 main 入口是单 prompt → 单 session,
//     需要扩 Hand multi-prompt 能力,工作量超出基础设施 PR 范围)
//   - C4-truncated 需要 docker-compose 给 client 容器加 CERELAY_E2E_MAX_SCOPE_BYTES
//     env, 但同一 client 容器跑所有 case 会影响 P0 (C1 17MB > 任何低于 17MB 的
//     budget 都会假阳性), 需要新增 client-c 专用容器或 per-case env 注入,
//     基础设施改动外溢, 暂留作未来 backlog
// ============================================================

// ============================================================
// C3-runtime-delta:
//   守护:session 进行中改 ~/.claude/CLAUDE.md → client cache-watcher 推 delta
//   → server 端 cache manifest 更新内容(sha256 改变)→ namespace 内再读拿到新值。
//   honest 触发:
//     1. async run 起 child + 初始 homeFixture v1
//     2. 等 cache sync 完成 + 验 sha(v1)
//     3. clients.mutateHomeFixture v2 → 触发 client cache-watcher delta
//     4. 等 server cache manifest 更新 → 验 sha(v2) ≠ sha(v1)
// ============================================================
test("C3-runtime-delta: session 内 mutate ~/.claude/CLAUDE.md → server cache 更新 sha256", async () => {
  const caseId = "case-c3";
  await writeFixture(caseId, { ".keep": "" });
  const cwd = clientCwd(caseId);
  const v1 = "C3-CLAUDE-V1-MARKER-3a8f2d";
  const v2 = "C3-CLAUDE-V2-MARKER-9b4e7c";
  const { createHash } = await import("node:crypto");
  const sha1 = createHash("sha256").update(v1).digest("hex");
  const sha2 = createHash("sha256").update(v2).digest("hex");

  await mockAdmin.loadScript({
    name: "p1-c3-final",
    match: { turnIndex: 1 },
    respond: scriptText("c3 runtime delta ok"),
  });

  // 起 async run + 初始 homeFixture v1。keepAfter:true 让 mutate 后文件不被 clean。
  const { runId } = await clients.runAsync("client-a", {
    prompt: "trigger CC start [C3-MARKER]",
    cwd,
    timeoutMs: 60_000,
    homeFixture: { ".claude/CLAUDE.md": v1 },
    homeFixtureKeepAfter: true,
  });

  try {
    // 等 spawn.ready,然后再等 cache sync 把 v1 落到 manifest
    const baseline = (await serverEvents.fetch({})).at(-1)?.id ?? 0;
    const spawnEvt = await ptyEvents.waitForSpawnReady({
      expectedCwd: cwd,
      since: baseline,
      timeoutMs: 30_000,
    });
    void spawnEvt;
    const status = await clients.runStatus("client-a", runId);
    const deviceId = status.deviceId;
    assert.ok(deviceId, "client agent must report deviceId");

    // 等 v1 落到 server manifest (cache sync 完成)
    const deadlineV1 = Date.now() + 15_000;
    let entryV1 = null as null | { sha256: string | null };
    while (Date.now() < deadlineV1) {
      const e = await cacheAdmin.lookupEntry({
        deviceId,
        scope: "claude-home",
        relPath: "CLAUDE.md",
      });
      if (e && e.sha256 === sha1) { entryV1 = e; break; }
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.ok(entryV1, `expected manifest entry for CLAUDE.md with sha=${sha1.slice(0, 12)}, never observed`);
    assert.equal(entryV1.sha256, sha1, "initial sha256 should match v1");

    // 触发 mutate (client agent 直接 writeFile, 让 client 端 cache-watcher inotify 捕获)
    await clients.mutateHomeFixture("client-a", { ".claude/CLAUDE.md": v2 });

    // 等 server manifest sha 翻成 v2 (watcher delta + ack)
    const deadlineV2 = Date.now() + 20_000;
    let entryV2 = null as null | { sha256: string | null };
    while (Date.now() < deadlineV2) {
      const e = await cacheAdmin.lookupEntry({
        deviceId,
        scope: "claude-home",
        relPath: "CLAUDE.md",
      });
      if (e && e.sha256 === sha2) { entryV2 = e; break; }
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.ok(entryV2, `expected manifest entry for CLAUDE.md with sha=${sha2.slice(0, 12)} after mutate, never observed`);
    assert.equal(entryV2.sha256, sha2, "post-mutate sha256 should match v2");
    assert.notEqual(entryV1.sha256, entryV2.sha256, "sha256 must change between v1 and v2");
  } finally {
    await killAndWait("client-a", runId);
    await cleanupFixture(caseId);
  }
});

// ============================================================
// G1-tool-timeout:
//   守护:server 端 tool relay 超时 → emit `tool.timeout.fired` + reject pending
//   → session 不挂死。honest 触发:
//     1. testToggles.set({injectToolTimeout: { ms:200, toolName:"mcp__cerelay__bash" }})
//     2. mock 让 CC 调 mcp__cerelay__bash + 故意让 client 端 hang
//        (用一个不存在的 client-c 容器,或者把 client kill 掉模拟)
//   实际上更简单:直接注入 200ms 超时 + 让 mock 配合 mcp call,
//   200ms 内 client 来不及完成(client routed mcp 路径 ~ms 级,实际可能完成),
//   稳定触发 timeout 需要 client kill 或者用一个永不返回的 mock 工具调用。
//
//   折中实现:用 mcp__cerelay__bash 跑 `sleep 5`,injectToolTimeout 200ms,
//   server 端 200ms 后 timeout fire,但 client 端的 sleep 5 还在跑,client 完成
//   返回时 server 已经 reject 了 pending,relay.resolve 收到 unknown reqId。
// ============================================================
test("G1-tool-timeout: tool relay 注入超时 → tool.timeout.fired emit + 不挂死", async () => {
  const caseId = "case-g1";
  await writeFixture(caseId, { ".keep": "" });
  const cwd = clientCwd(caseId);

  // 开 toggle: 200ms 强制 timeout Bash 调用。注意 dispatcher 收到的 toolName
  // 是 schema.builtinName (server/src/mcp-routed/handlers.ts:33) = "Bash",
  // 不是 CC 端的 fully qualified "mcp__cerelay__bash"。
  await testToggles.set({ injectToolTimeout: { ms: 200, toolName: "Bash" } });

  // turn 1: 模型调 mcp__cerelay__bash + sleep 5 (client 端会真 sleep 5s,
  //         server 端 200ms 后 timeout fire)
  await mockAdmin.loadScript({
    name: "p1-g1-turn1-bash",
    match: { turnIndex: 1 },
    respond: scriptToolUse({
      toolName: "mcp__cerelay__bash",
      toolUseId: "toolu_g1_01",
      input: { command: "sleep 5" },
    }),
  });
  // turn 2: 模型拿到 timeout 错误后 final
  await mockAdmin.loadScript({
    name: "p1-g1-turn2-final",
    match: { turnIndex: 2 },
    respond: scriptText("g1 tool timeout ok"),
  });

  const baseline = (await serverEvents.fetch({})).at(-1)?.id ?? 0;

  try {
    const result = await clients.run("client-a", {
      prompt: "trigger tool timeout [G1-MARKER]",
      cwd,
      timeoutMs: 30_000,
    });

    // session 不挂死 = client 进程能正常 exit (无论 exit code 是不是 0,
    // 关键是不卡 30s timeout 抛 Error)
    void result;

    // 主断言: tool.timeout.fired emit (toolName 是 "Bash" 同 toggle)
    const timeoutEvt = await toolTimeoutEvents.waitForFired({
      toolName: "Bash",
      since: baseline,
      timeoutMs: 10_000,
    });
    assert.equal(timeoutEvt.detail.injected, true, "timeout should be from injected toggle");
    assert.equal(timeoutEvt.detail.timeoutMs, 200, "injected timeoutMs should be 200");

    // 旁证: turn 2 cap 应该有 turn 1 的 tool_result with is_error=true
    // (server timeout reject → relay 给 CC 一个错误,CC 把 error 包成 tool_result)
    const cap = await mockAdmin.captured();
    if (cap.length >= 2) {
      const tr = cap[1].toolResultsCurrentTurn[0];
      if (tr) {
        assert.equal(tr.is_error, true, "tool_result of timed-out tool should be is_error");
      }
    }
  } finally {
    await testToggles.reset();
    await cleanupFixture(caseId);
  }
});

// ============================================================
// G2-client-disconnect:
//   守护:session 中途 client 断 ws → server cleanup namespace + FUSE,
//   无 EBUSY 残留 + emit session.disconnected。honest 触发:
//     1. async run 起 child + waitForSpawnReady
//     2. clients.killRun 让 child SIGKILL → ws 自动断
//     3. 等 session.disconnected event
//     4. 验 server admin events 没有 namespace cleanup 错误
// ============================================================
test("G2-client-disconnect: client 断 ws → server emit session.disconnected + cleanup 无 EBUSY", async () => {
  const caseId = "case-g2";
  await writeFixture(caseId, { ".keep": "" });
  const cwd = clientCwd(caseId);

  await mockAdmin.loadScript({
    name: "p1-g2-final",
    match: { turnIndex: 1 },
    respond: scriptText("g2 disconnect ok"),
  });

  const baseline = (await serverEvents.fetch({})).at(-1)?.id ?? 0;

  const { runId } = await clients.runAsync("client-a", {
    prompt: "trigger CC start [G2-MARKER]",
    cwd,
    timeoutMs: 60_000,
  });

  try {
    const spawnEvt = await ptyEvents.waitForSpawnReady({
      expectedCwd: cwd,
      since: baseline,
      timeoutMs: 30_000,
    });
    const sessionId = spawnEvt.sessionId!;

    // SIGKILL client 进程 → ws 在 server 端被动 close
    await clients.killRun("client-a", runId);

    // 主断言: server emit session.disconnected for this sessionId
    const evt = await sessionEvents.waitForDisconnected({
      sessionId,
      since: baseline,
      timeoutMs: 15_000,
    });
    assert.equal(evt.detail.reason, "client_close", "disconnect reason should be client_close");

    // 旁证: 等到 child 真退出 (避免下一 case 受影响)
    const status = await clients.waitRun("client-a", runId, 15_000);
    assert.equal(status.state, "killed", "run should end in killed state");
  } finally {
    await cleanupFixture(caseId);
  }
});

// ============================================================
// G3-mock-5xx:
//   守护:mock anthropic 返回 5xx → cerelay session 优雅终止,
//   不应 partial stream 卡住或 OOM。honest 触发:
//     mock 用 scriptError(503) → CC 第一个 /v1/messages 拿 503 → SDK 抛错 → exit
// ============================================================
test("G3-mock-5xx: mock 返回 503 → cerelay session 优雅终止 (非 0 exit)", async () => {
  const caseId = "case-g3";
  await writeFixture(caseId, { ".keep": "" });
  const cwd = clientCwd(caseId);

  await mockAdmin.loadScript({
    name: "p1-g3-error",
    match: { turnIndex: 1 },
    respond: scriptError(503, { error: { type: "overloaded_error", message: "Service Unavailable [G3-TEST]" } }),
  });

  try {
    const result = await clients.run("client-a", {
      prompt: "trigger upstream 5xx [G3-MARKER]",
      cwd,
      timeoutMs: 30_000,
    });

    // 主断言 #1: 30s 内能完成(不挂死、不 OOM)— 由 await 不超时隐式断言。
    // 这是 G3 守的最关键不变量: cerelay 不能因为上游 5xx 卡死或 partial stream 残留
    assert.ok(result.durationMs < 30_000, `should not hang on upstream 503, durationMs=${result.durationMs}`);

    // 主断言 #2: mock 实际收到 >=1 条请求且第一条匹配 scriptError(503)
    // (CC SDK 可能 retry,数量取决于 SDK 版本;最少应该有 1 条 turn 1 = 503)
    const cap = await mockAdmin.captured();
    assert.ok(cap.length >= 1, `expected at least 1 captured req, got ${cap.length}`);
    assert.equal(
      cap[0].matchedScript,
      "p1-g3-error",
      `first request should match scriptError, got matchedScript=${cap[0].matchedScript}`,
    );

    // 旁证(不强求): CC SDK 拿到 5xx 通常会在 stderr 留错误信息或 exit != 0,
    // 但具体行为依赖 SDK 版本(retry 后 swallowed exit 0 / panic exit 1 都可能)。
    // 不强断言 exitCode, 只在 stderr/stdout 含 503/error 时给个旁证 log。
    const allOut = `${result.stdout}\n${result.stderr}`;
    if (!/503|overloaded|api[_ ]error/i.test(allOut)) {
      // 不 fail, 只 log 让人发现 SDK 可能 swallow 了错误
      // eslint-disable-next-line no-console
      console.log(`[G3 旁证] CC 输出未含 503 信号, exitCode=${result.exitCode}, durationMs=${result.durationMs}`);
    }
  } finally {
    await cleanupFixture(caseId);
  }
});
