// ============================================================
// Phase P2 meta failure case
// 故意把 project-claude root 错挂到另一 cwd → 期望 assertF4CrossCwdIsolation throw
// 这是 PR1 helper assertF4CrossCwdIsolation 的反向回归测试,防止 helper 自身退化
// (例如未来重构 assertF4 时不小心改成"event 缺失就跳过",此 meta case 会立即拦下)。
//
// 串台检测机制:
//   toggle injectCrossCwdRootCollision(fromCwd=cwdB, toCwd=cwdA) 触发时:
//   1. FileProxyManager.roots["project-claude"] 被改成 cwdA/.claude (构造时 gate)
//   2. session.bootstrap.plan 的 projectClaudeBindTarget 也反映为 cwdA/.claude (server.ts 对称)
//   assertF4CrossCwdIsolation (d) 检查 sessionB.projectClaudeBindTarget !== cwdB/.claude
//   → 捕获串台 → throw。不需要 serverExec.run cat probe，spawn.ready 后立即可断言。
//
// Spec: docs/superpowers/specs/2026-05-02-f4-cross-cwd-fileproxy-isolation-design.md §5.4
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { mockAdmin, scriptText } from "./mock-admin.js";
import { clients } from "./clients.js";
import {
  ptyEvents,
  serverEvents,
  testToggles,
  assertF4CrossCwdIsolation,
} from "./server-events.js";
import { writeFixture, cleanupFixture } from "./fixtures.js";
import { F4_CROSS_FIXTURE_FILES } from "./phase-p2.test.js";

const CASE_ID = "case-f4-cross-meta";
const FIXTURES_BASE = "/workspace/fixtures";

test("F4-cross-cwd-meta: 故意串台 → assertF4CrossCwdIsolation 期望 throw", async () => {
  await mockAdmin.reset();
  await writeFixture(CASE_ID, F4_CROSS_FIXTURE_FILES);

  const cwdA = `${FIXTURES_BASE}/${CASE_ID}/a`;
  const cwdB = `${FIXTURES_BASE}/${CASE_ID}/b`;

  // mock 简单 final response
  await mockAdmin.loadScript({
    name: "p2-meta-a",
    match: { predicate: { path: "messages[0].content", op: "contains", value: "META-A" } },
    respond: scriptText("meta a ok"),
  });
  await mockAdmin.loadScript({
    name: "p2-meta-b",
    match: { predicate: { path: "messages[0].content", op: "contains", value: "META-B" } },
    respond: scriptText("meta b ok"),
  });

  // 注入 toggle:让 cwdB 的 session 把 project-claude root 错挂到 cwdA。
  // 双重效果(file-proxy-manager.ts + server.ts 对称):
  //   - FileProxyManager.roots["project-claude"] 改为 cwdA/.claude
  //   - session.bootstrap.plan projectClaudeBindTarget 改为 cwdA/.claude
  // assertF4CrossCwdIsolation (d) 检查后者 → 期望 throw。
  await testToggles.injectCrossCwdRootCollision({ fromCwd: cwdB, toCwd: cwdA });

  try {
    const baseline = (await serverEvents.fetch({})).at(-1)?.id ?? 0;

    const [{ runId: runIdA }, { runId: runIdB }] = await Promise.all([
      clients.runAsync("client-a", {
        prompt: "meta session a [META-A]",
        cwd: cwdA,
        timeoutMs: 90_000,
      }),
      clients.runAsync("client-a", {
        prompt: "meta session b [META-B]",
        cwd: cwdB,
        timeoutMs: 90_000,
      }),
    ]);

    try {
      // 等两 spawn.ready——spawn.ready 后 session.bootstrap.plan 已 emit
      // (bootstrap.plan 在 server.ts 的 spawn 前 emit,早于 pty.spawn.ready)
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
      assert.ok(spawnEvtsA[0] && spawnEvtsB[0], "两 spawn.ready 都必须就绪");

      const sessionIdA = spawnEvtsA[0].sessionId!;
      const sessionIdB = spawnEvtsB[0].sessionId!;

      // ⚠ 期望 assertF4CrossCwdIsolation throw —— 因为 toggle 让 sessionB 的
      // session.bootstrap.plan projectClaudeBindTarget = cwdA/.claude（而非 cwdB/.claude）:
      //   (d) bootB.detail.projectClaudeBindTarget !== cwdB/.claude → 断言失败 → throw
      // 生产路径中 gate(CERELAY_ADMIN_EVENTS=true + toggle 非空)确保零开销。
      await assert.rejects(
        () => assertF4CrossCwdIsolation({
          sessionA: { sessionId: sessionIdA },
          sessionB: { sessionId: sessionIdB },
          cwdA, cwdB,
          since: baseline,
        }),
        /assertF4CrossCwdIsolation FAIL/,
        "故意串台时 assertF4CrossCwdIsolation 必须 throw,否则 helper 退化为'什么都过'",
      );
    } finally {
      await Promise.all([
        clients.killRun("client-a", runIdA).catch(() => {}),
        clients.killRun("client-a", runIdB).catch(() => {}),
      ]);
    }
  } finally {
    // cleanup:无论 case 成功失败,都必须清 toggle 防泄漏到下一 case
    await testToggles.injectCrossCwdRootCollision(null);
    await cleanupFixture(CASE_ID);
  }
});
