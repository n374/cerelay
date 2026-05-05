// ============================================================
// Phase P2 e2e cases / Phase P2 e2e cases
//
// 当前覆盖:
// - F4-cross-cwd-fileproxy-isolation:F4 P2 case 守 4 条 cross-cwd 隔离深度不变量
//   ((a) fileProxy 三 root 内容不串、(b) 共享 ClientCacheStore 命中污染、
//   (c) cwd-ancestor walk 计算计划不串、(d) project-claude bind mount 严格按 session cwd)
//
// Spec:docs/superpowers/specs/2026-05-02-f4-cross-cwd-fileproxy-isolation-design.md
// Plan:docs/superpowers/plans/2026-05-02-f4-cross-cwd-fileproxy-isolation.md Task 10
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { mockAdmin, scriptText } from "./mock-admin.js";
import { clients } from "./clients.js";
import {
  fileProxyEvents,
  ptyEvents,
  serverEvents,
  serverExec,
  configPreloaderEvents,
  sessionBootstrapEvents,
  assertF4CrossCwdIsolation,
  isUnderDir,
} from "./server-events.js";
import { writeFixture, cleanupFixture } from "./fixtures.js";

import { F4_CROSS_FIXTURE_FILES } from "./phase-p2-fixtures.js";

const CASE_ID = "case-f4-cross";

// killAndVerifyExited: 复制 phase-p1.test.ts 的同名实现，kill child + warn if still running
async function killAndWait(label: string, runId: string): Promise<void> {
  try { await clients.killRun(label, runId); } catch { /* ignore */ }
  try { await clients.waitRun(label, runId, 15_000); } catch { /* ignore */ }
}

async function killAndVerifyExited(label: string, runId: string): Promise<void> {
  await killAndWait(label, runId);
  try {
    const status = await clients.runStatus(label, runId);
    if (status.state === "running") {
      // eslint-disable-next-line no-console
      console.warn(
        `[killAndVerifyExited WARN] runId=${runId} 在 killAndWait(15s) 后仍处于 running;` +
          `可能污染下一 case baseline。请关注 next case 是否假阳性。`,
      );
    }
  } catch {
    // status 查不到(404 / runState evict) → child 已结束清理,正常
  }
}

function clientCwd(caseId: string, sub?: string): string {
  return sub
    ? `/workspace/fixtures/${caseId}/${sub}`
    : `/workspace/fixtures/${caseId}`;
}

// ============================================================
// F4-cross-cwd-fileproxy-isolation:
//   守护 4 条 cross-cwd 隔离深度不变量(spec §5.3)
//   (a) fileProxy 三 root 内容不串
//   (b) 共享 ClientCacheStore 命中污染
//   (c) cwd-ancestor walk 计算计划不串
//   (d) project-claude bind mount 严格按 session cwd
// ============================================================
test("F4-cross-cwd-fileproxy-isolation: 同 device 两 cwd 并发隔离", async () => {
  // 步骤 1: reset + 写 fixture
  await mockAdmin.reset();

  await writeFixture(CASE_ID, F4_CROSS_FIXTURE_FILES);

  const cwdA = clientCwd(CASE_ID, "a");
  const cwdB = clientCwd(CASE_ID, "b");

  // 步骤 2: mock 简单 final response(避免 CC 跑工具,两个并发 session 各自一轮就 end_turn)
  // 用 predicate 按 marker 区分两个 session 的 prompt,保证各自独立匹配
  await mockAdmin.loadScript({
    name: "p2-f4-session-a-final",
    match: { predicate: { path: "messages[0].content", op: "contains", value: "F4-CROSS-CWD-A" } },
    respond: scriptText("f4 cross cwd session a ok"),
  });
  await mockAdmin.loadScript({
    name: "p2-f4-session-b-final",
    match: { predicate: { path: "messages[0].content", op: "contains", value: "F4-CROSS-CWD-B" } },
    respond: scriptText("f4 cross cwd session b ok"),
  });

  // 步骤 3: baseline = 当前最后一条事件 id
  const baseline = (await serverEvents.fetch({})).at(-1)?.id ?? 0;

  // 步骤 4: Promise.all 并发起两 session(同 client-a → 同 deviceId → 不同 cwd)
  // homeFixture inline: 共享 $HOME 里的标记文件,让 home root probe 能验内容
  const homeFixtureFiles: Record<string, string> = {
    ".claude/f4-home-marker.txt": "HOME_SHARED_EXPECTED\n",
    ".claude.json": JSON.stringify({ f4: "HOME_JSON_SHARED_EXPECTED" }),
  };

  const [{ runId: runIdA }, { runId: runIdB }] = await Promise.all([
    clients.runAsync("client-a", {
      prompt: "session a cross-cwd test [F4-CROSS-CWD-A]",
      cwd: cwdA,
      timeoutMs: 90_000,
      homeFixture: homeFixtureFiles,
      homeFixtureKeepAfter: true,
    }),
    clients.runAsync("client-a", {
      prompt: "session b cross-cwd test [F4-CROSS-CWD-B]",
      cwd: cwdB,
      timeoutMs: 90_000,
    }),
  ]);

  try {
    // 步骤 5: 等两个 spawn.ready event，各自 cwd 不同
    const deadline = Date.now() + 45_000;
    let spawnEvtsA: Awaited<ReturnType<typeof ptyEvents.findSpawnReady>> = [];
    let spawnEvtsB: Awaited<ReturnType<typeof ptyEvents.findSpawnReady>> = [];
    while (Date.now() < deadline) {
      [spawnEvtsA, spawnEvtsB] = await Promise.all([
        ptyEvents.findSpawnReady({ expectedCwd: cwdA, since: baseline }),
        ptyEvents.findSpawnReady({ expectedCwd: cwdB, since: baseline }),
      ]);
      if (spawnEvtsA.length >= 1 && spawnEvtsB.length >= 1) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.ok(
      spawnEvtsA.length >= 1,
      `expected >= 1 pty.spawn.ready for cwdA=${cwdA}, got ${spawnEvtsA.length}`,
    );
    assert.ok(
      spawnEvtsB.length >= 1,
      `expected >= 1 pty.spawn.ready for cwdB=${cwdB}, got ${spawnEvtsB.length}`,
    );

    const spawnA = spawnEvtsA[0];
    const spawnB = spawnEvtsB[0];
    const sessionIdA = spawnA.sessionId!;
    const sessionIdB = spawnB.sessionId!;

    assert.notEqual(sessionIdA, sessionIdB, "两个不同 cwd 的 session 必须 sessionId 不同");

    // ================================================================
    // 阶段一: 正向 probe — session A 的 namespace 内 cat 各 root 路径
    // HOME_ABS: /home/clientuser (与 phase-p1.test.ts 一致)
    // ================================================================
    const HOME_ABS = "/home/clientuser";

    // A namespace: cat cwdA project-marker
    const aProject = await serverExec.run(sessionIdA, {
      command: "/bin/sh",
      args: ["-c", `cat ${cwdA}/.claude/project-marker.txt`],
      timeoutMs: 15_000,
    });

    // A namespace: cat home marker
    const aHome = await serverExec.run(sessionIdA, {
      command: "/bin/sh",
      args: ["-c", `cat ${HOME_ABS}/.claude/f4-home-marker.txt 2>/dev/null || true`],
      timeoutMs: 15_000,
    });

    // A namespace: cat home .claude.json
    const aHomeJson = await serverExec.run(sessionIdA, {
      command: "/bin/sh",
      args: ["-c", `cat ${HOME_ABS}/.claude.json 2>/dev/null || true`],
      timeoutMs: 15_000,
    });

    // A namespace: cat settings.local.json(shadow 注入,走 FUSE shadow 路径)
    const aSettings = await serverExec.run(sessionIdA, {
      command: "/bin/sh",
      args: ["-c", `cat ${cwdA}/.claude/settings.local.json 2>/dev/null || true`],
      timeoutMs: 15_000,
    });

    // A namespace: cat cwdA/CLAUDE.md(cwd-local ancestor)
    // 注意: cwd-ancestor FUSE root 在 server 端未注册(INF-12 半成品),namespace 内
    // 访问 cwdA/CLAUDE.md 不经 FUSE,只能看到真实 FS — 通常为空/ENOENT。
    // 不做内容断言，仅作为旁证探针。
    const aClaude = await serverExec.run(sessionIdA, {
      command: "/bin/sh",
      args: ["-c", `cat ${cwdA}/CLAUDE.md 2>/dev/null || true`],
      timeoutMs: 15_000,
    });
    void aClaude; // cwd-ancestor-N 未注册,内容不保证可见,不做断言

    // B namespace: cat cwdB project-marker
    const bProject = await serverExec.run(sessionIdB, {
      command: "/bin/sh",
      args: ["-c", `cat ${cwdB}/.claude/project-marker.txt`],
      timeoutMs: 15_000,
    });

    // B namespace: cat home marker(共享 home,应该看到相同内容)
    const bHome = await serverExec.run(sessionIdB, {
      command: "/bin/sh",
      args: ["-c", `cat ${HOME_ABS}/.claude/f4-home-marker.txt 2>/dev/null || true`],
      timeoutMs: 15_000,
    });

    // B namespace: cat home .claude.json
    const bHomeJson = await serverExec.run(sessionIdB, {
      command: "/bin/sh",
      args: ["-c", `cat ${HOME_ABS}/.claude.json 2>/dev/null || true`],
      timeoutMs: 15_000,
    });

    // B namespace: cat cwdB/CLAUDE.md(cwd-ancestor-N 未注册,旁证探针,不做内容断言)
    const bClaude = await serverExec.run(sessionIdB, {
      command: "/bin/sh",
      args: ["-c", `cat ${cwdB}/CLAUDE.md 2>/dev/null || true`],
      timeoutMs: 15_000,
    });
    void bClaude; // cwd-ancestor-N 未注册,内容不保证可见,不做断言

    // B namespace: cat cwdB/settings.local.json
    const bSettings = await serverExec.run(sessionIdB, {
      command: "/bin/sh",
      args: ["-c", `cat ${cwdB}/.claude/settings.local.json 2>/dev/null || true`],
      timeoutMs: 15_000,
    });

    // ================================================================
    // 阶段二: 负向 probe — session B 主动 cat cwdA 子树
    // 跨 namespace 不可见 → cat 应失败或返空 stdout，不含 PROJECT_A_ONLY
    // 用 "|| true" 确保 sh exit 0，不因 cat 失败中断 probe
    // ================================================================
    const bAttemptA = await serverExec.run(sessionIdB, {
      command: "/bin/sh",
      args: ["-c", `cat ${cwdA}/.claude/project-marker.txt 2>/dev/null || true; echo probe-done`],
      timeoutMs: 15_000,
    });

    // 阶段二完成后等 600ms,让所有阶段一 + bAttemptA 触发的 read.served event 完成
    // admin events buffer 落地(server emit → buffer push 是同步的,但 HTTP 拉取
    // 有 RTT,600ms 在容器局域网下足够)。然后下方 assertNoReadServedForCwd(timeoutMs:500)
    // 用 50ms 间隔轮询的 10 次窗口,任何"漏网" event 也会被捕到。spec §5.4 锚定到
    // "所有 probe 完成后 + 500ms safety margin",此处 600ms settle + 500ms poll
    // 比 spec 更保守。
    await new Promise((r) => setTimeout(r, 600));

    // ================================================================
    // 阶段三: 断言
    // ================================================================

    // (1) stdout 正负 marker 断言
    // session A 的 project probe 应含 A marker 不含 B marker
    assert.ok(
      aProject.exitCode === 0 || aProject.stdout.includes("PROJECT_A_ONLY"),
      `sessionA project probe should succeed; exitCode=${aProject.exitCode}, stdout=${aProject.stdout.slice(0, 200)}`,
    );
    assert.ok(
      aProject.stdout.includes("PROJECT_A_ONLY"),
      `sessionA project probe stdout should contain PROJECT_A_ONLY; got: ${aProject.stdout.slice(0, 200)}`,
    );
    assert.ok(
      !aProject.stdout.includes("PROJECT_B_ONLY"),
      `sessionA project probe must NOT contain PROJECT_B_ONLY; got: ${aProject.stdout.slice(0, 200)}`,
    );

    // session B 的 project probe 应含 B marker 不含 A marker
    assert.ok(
      bProject.stdout.includes("PROJECT_B_ONLY"),
      `sessionB project probe stdout should contain PROJECT_B_ONLY; got: ${bProject.stdout.slice(0, 200)}`,
    );
    assert.ok(
      !bProject.stdout.includes("PROJECT_A_ONLY"),
      `sessionB project probe must NOT contain PROJECT_A_ONLY; got: ${bProject.stdout.slice(0, 200)}`,
    );

    // cwd/CLAUDE.md: cwd-ancestor-N root 在 server 端未注册(INF-12 半成品),
    // namespace 内访问不经 FUSE，内容不保证可见。不做正负 marker 断言。
    // aClaude / bClaude 已在上方 void，断言(c)通过 configPreloaderEvents 计划检查覆盖。

    // home 共享 $HOME(spec §2 第 3 项纠偏:同 client 两并发 session 共享 $HOME 与 deviceId,
    // home root 不是 per-cwd 内容空间)。aHome / bHome / aHomeJson / bHomeJson 仅作 smoke
    // probe 触发 FUSE,不做 enforced stdout 断言——理由:
    //   1. namespace 内 home 路径(/home/clientuser)与 client agent 写 homeFixture 的
    //      $HOME 路径在不同 mount namespace 下不保证 1:1 等价
    //   2. spec §5.3 (a) 守"home root 不被 project cwd 子树污染"靠 read.served event
    //      detail.clientCwd / clientPath 字段(由 assertF4CrossCwdIsolation + 阶段三
    //      assertNoReadServedForCwd 守),而非 stdout includes 字符串
    // 故 void。
    void aHome; void bHome; void aHomeJson; void bHomeJson;

    // settings.local.json:走 shadow FUSE 路径,各 session 必须只见自己 cwd 内容,不串对方
    assert.ok(
      aSettings.stdout.includes("SETTINGS_A_ONLY"),
      `sessionA settings probe must contain SETTINGS_A_ONLY; got: ${aSettings.stdout.slice(0, 200)}`,
    );
    assert.ok(
      !aSettings.stdout.includes("SETTINGS_B_ONLY"),
      `sessionA settings probe must NOT contain SETTINGS_B_ONLY; got: ${aSettings.stdout.slice(0, 200)}`,
    );
    assert.ok(
      bSettings.stdout.includes("SETTINGS_B_ONLY"),
      `sessionB settings probe must contain SETTINGS_B_ONLY; got: ${bSettings.stdout.slice(0, 200)}`,
    );
    assert.ok(
      !bSettings.stdout.includes("SETTINGS_A_ONLY"),
      `sessionB settings probe must NOT contain SETTINGS_A_ONLY; got: ${bSettings.stdout.slice(0, 200)}`,
    );

    // 负向 probe: session B 访问 cwdA 子树应看不到 A 的内容
    assert.ok(
      !bAttemptA.stdout.includes("PROJECT_A_ONLY"),
      `sessionB accessing cwdA project-marker must NOT see PROJECT_A_ONLY (cross-namespace isolation); got: ${bAttemptA.stdout.slice(0, 300)}`,
    );

    // (2) read.served event: sessionA 的 project-claude read.served clientCwd 必须 === cwdA
    // 等 project-claude 下任意 relPath 的 read.served event(不限定具体文件,只要 root 对)
    // 使用 waitForReadServedByRoot 代替自定义轮询(relPath 不约束,只按 root + sessionId 过滤)
    const readEvA = await fileProxyEvents.waitForReadServedByRoot({
      root: "project-claude",
      sessionId: sessionIdA,
      since: baseline,
      timeoutMs: 15_000,
    });
    assert.equal(
      readEvA.detail.clientCwd,
      cwdA,
      `sessionA project-claude read.served clientCwd 必须 === cwdA;detail=${JSON.stringify(readEvA.detail)}`,
    );

    // sessionB 的 project-claude read.served clientCwd 必须 === cwdB
    const readEvB = await fileProxyEvents.waitForReadServedByRoot({
      root: "project-claude",
      sessionId: sessionIdB,
      since: baseline,
      timeoutMs: 15_000,
    });
    assert.equal(
      readEvB.detail.clientCwd,
      cwdB,
      `sessionB project-claude read.served clientCwd 必须 === cwdB;detail=${JSON.stringify(readEvB.detail)}`,
    );

    // (3) negative-assert: session B 没有读取 cwdA 子树的 read.served
    // 等所有 probe 完成 + 500ms safety margin(已在阶段二后 await 600ms)
    await fileProxyEvents.assertNoReadServedForCwd({
      sessionId: sessionIdB,
      foreignCwd: cwdA,
      since: baseline,
      timeoutMs: 500,
    });
    // 对称: session A 没有读取 cwdB 子树的 read.served
    await fileProxyEvents.assertNoReadServedForCwd({
      sessionId: sessionIdA,
      foreignCwd: cwdB,
      since: baseline,
      timeoutMs: 500,
    });

    // (4) ConfigPreloader plan ancestorDirs 不串台
    // sessionA 的 ancestorDirs 不应包含 cwdB 子树，sessionB 同理
    const planA = await configPreloaderEvents.waitForPlan({
      sessionId: sessionIdA,
      since: baseline,
      timeoutMs: 10_000,
    });
    const ancestorLeakA = planA.detail.ancestorDirs.filter((p) => isUnderDir(p, cwdB));
    assert.equal(
      ancestorLeakA.length,
      0,
      `sessionA ancestorDirs 不应包含 cwdB 子树路径; leaked: ${ancestorLeakA.join(", ")}`,
    );
    const prefetchLeakA = planA.detail.prefetchAbsPaths.filter((p) => isUnderDir(p, cwdB));
    assert.equal(
      prefetchLeakA.length,
      0,
      `sessionA prefetchAbsPaths 不应包含 cwdB 子树路径; leaked: ${prefetchLeakA.join(", ")}`,
    );

    const planB = await configPreloaderEvents.waitForPlan({
      sessionId: sessionIdB,
      since: baseline,
      timeoutMs: 10_000,
    });
    const ancestorLeakB = planB.detail.ancestorDirs.filter((p) => isUnderDir(p, cwdA));
    assert.equal(
      ancestorLeakB.length,
      0,
      `sessionB ancestorDirs 不应包含 cwdA 子树路径; leaked: ${ancestorLeakB.join(", ")}`,
    );
    const prefetchLeakB = planB.detail.prefetchAbsPaths.filter((p) => isUnderDir(p, cwdA));
    assert.equal(
      prefetchLeakB.length,
      0,
      `sessionB prefetchAbsPaths 不应包含 cwdA 子树路径; leaked: ${prefetchLeakB.join(", ")}`,
    );

    // (5) session.bootstrap.plan projectClaudeBindTarget 严格按 cwd
    const bootA = await sessionBootstrapEvents.waitForPlan({
      sessionId: sessionIdA,
      since: baseline,
      timeoutMs: 10_000,
    });
    assert.equal(
      bootA.detail.projectClaudeBindTarget,
      `${cwdA}/.claude`,
      `sessionA projectClaudeBindTarget 必须等于 ${cwdA}/.claude; got: ${bootA.detail.projectClaudeBindTarget}`,
    );

    const bootB = await sessionBootstrapEvents.waitForPlan({
      sessionId: sessionIdB,
      since: baseline,
      timeoutMs: 10_000,
    });
    assert.equal(
      bootB.detail.projectClaudeBindTarget,
      `${cwdB}/.claude`,
      `sessionB projectClaudeBindTarget 必须等于 ${cwdB}/.claude; got: ${bootB.detail.projectClaudeBindTarget}`,
    );

    // (6) assertF4CrossCwdIsolation 综合断言(失败时 dump 完整 probe 摘要)
    await assertF4CrossCwdIsolation({
      sessionA: { sessionId: sessionIdA },
      sessionB: { sessionId: sessionIdB },
      cwdA,
      cwdB,
      since: baseline,
    });
  } finally {
    // 步骤 9: killAndVerifyExited 收尾(防 child 残留污染下一 case)
    await Promise.all([
      killAndVerifyExited("client-a", runIdA),
      killAndVerifyExited("client-a", runIdB),
    ]);
    await cleanupFixture(CASE_ID);
  }
});
