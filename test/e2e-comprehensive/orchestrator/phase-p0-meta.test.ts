// P0-B-4 meta-tests：故意引入 regression 验证 P0 主套件能拦住。
//
// docs/e2e-comprehensive-testing.md §8 Testing the Test Infrastructure 列三类：
//   - meta-ifs-bug: 注入 IFS bug → B4/D3 该抓到（断言在 set -u 下崩）
//   - meta-redact-leak: 关掉 redact → E1 该抓到（断言 redact event 触发）
//   - meta-deviceid-collision: 让 client-a / client-b 共用同 deviceId → F3 该抓到
//
// 这些 meta-test 通过 `npm run test:e2e:meta` 触发；不进 npm test 默认链路
// （会污染主套件的 toggle 状态）。每个 case 跑前 set toggle、跑后 reset。
//
// 实现细节：toggle 在 process-global，server / agent 各自维护；不需要重启容器。
//   - server: POST /admin/test-toggles { disableRedact?, injectIfsBug? }
//   - agent: POST /admin/toggles { forceDeviceId? | reset }

import test from "node:test";
import assert from "node:assert/strict";
import { mockAdmin, scriptToolUse, scriptText } from "./mock-admin.js";
import { clients } from "./clients.js";
import { serverEvents, cacheAdmin, testToggles } from "./server-events.js";
import { writeFixture, cleanupFixture } from "./fixtures.js";

function clientCwd(caseId: string): string {
  return `/workspace/fixtures/${caseId}`;
}

test.beforeEach(async () => {
  await mockAdmin.reset();
  await testToggles.reset();
  await clients.setForcedDeviceId("client-a", { reset: true });
  await clients.setForcedDeviceId("client-b", { reset: true });
});

test.afterEach(async () => {
  // 双保险：万一 case 中途 throw，也要把 toggle / device-id 恢复
  await testToggles.reset();
  await clients.setForcedDeviceId("client-a", { reset: true });
  await clients.setForcedDeviceId("client-b", { reset: true });
});

// ============================================================
// meta-ifs-bug：注入 _old_ifs="$IFS" 重现 set -u 下 IFS 已 unset 的退出
// 期望 B4 风格 case（多层 ancestor + bootstrap）失败 / namespace 起不来
// ============================================================
test("meta-ifs-bug: 注入 IFS bug → ancestor case 该被拦住", async () => {
  const caseId = "case-meta-ifs";
  await writeFixture(caseId, {
    "CLAUDE.md": "# meta ifs ancestor",
    "lvl1/lvl2/lvl3/marker.txt": "x",
  });
  const cwd = `${clientCwd(caseId)}/lvl1/lvl2/lvl3`;

  await testToggles.set({ injectIfsBug: true });

  await mockAdmin.loadScript({
    name: "meta-ifs-turn1",
    match: { turnIndex: 1 },
    respond: scriptText("meta ifs ok"),
  });

  const baseline = (await serverEvents.fetch({})).at(-1)?.id ?? 0;

  const result = await clients.run("client-a", {
    prompt: "trigger bootstrap [META-IFS-MARKER]",
    cwd,
    timeoutMs: 30_000,
  });

  // 期望：B4 / D3 类不变量被打破。具体表现至少满足以下其一：
  //   (a) client 进程退出非 0（CC PTY 启动失败）
  //   (b) stdout/stderr 含 "IFS: parameter not set"
  //   (c) server 端有 pty.spawn.failed 事件
  // 任一命中即算 meta 抓到了；全部不满足 = 套件失效，meta 失败提醒。
  const allOutput = `${result.stdout}\n${result.stderr}`;
  const ifsErrorVisible = /IFS: parameter not set/.test(allOutput);
  const newEvents = await serverEvents.fetch({ since: baseline });
  const failed = newEvents.find((e) => e.kind === "pty.spawn.failed");
  const exitFailed = result.exitCode !== 0;

  assert.ok(
    exitFailed || ifsErrorVisible || failed !== undefined,
    `meta-ifs-bug 套件失效——注入 IFS bug 后期望抓到 regression 但没抓到。\nexit=${result.exitCode}, ifsErrorVisible=${ifsErrorVisible}, pty.spawn.failed=${!!failed}\nstderr: ${result.stderr.slice(-2000)}`,
  );

  await cleanupFixture(caseId);
});

// ============================================================
// meta-redact-leak：关掉 redact → E1 风格 case 看不到 redact event
// 期望 E1 断言失败 = 套件能抓到 redact 没触发
// ============================================================
test("meta-redact-leak: 关闭 redact → E1 风格 redact event 必须为 0", async () => {
  const caseId = "case-meta-redact";
  await writeFixture(caseId, { ".keep": "" });
  const cwd = clientCwd(caseId);

  // 注意：故意只放 API_KEY，不放 ANTHROPIC_BASE_URL——redact bypass 一旦生效，
  // CC 会按 settings.json 的 BASE_URL 走，example.invalid 之类会卡 DNS；env 里
  // 已经设了 BASE_URL=mock-anthropic，settings 里没 BASE_URL 时 CC 使用 env 值。
  const secret = "sk-ant-fake-meta-redact-XXXXXXXXXX";
  const settingsContent = JSON.stringify(
    { env: { ANTHROPIC_API_KEY: secret } },
    null,
    2,
  );

  await testToggles.set({ disableRedact: true });

  await mockAdmin.loadScript({
    name: "meta-redact-turn1",
    match: { turnIndex: 1 },
    respond: scriptText("meta redact ok"),
  });

  const baseline = (await serverEvents.fetch({})).at(-1)?.id ?? 0;

  const result = await clients.run("client-a", {
    prompt: "trigger redact bypass [META-REDACT-MARKER]",
    cwd,
    homeFixture: { ".claude/settings.json": settingsContent },
  });

  assert.equal(result.exitCode, 0, `client should still exit 0 (redact bypass = silent leak)`);

  const newEvents = await serverEvents.fetch({ since: baseline });
  const redactEvents = newEvents.filter((e) => e.kind === "file-proxy.settings.redacted");
  const bypassEvents = newEvents.filter((e) => e.kind === "file-proxy.settings.redact.bypassed");

  // 套件失效信号：disableRedact 模式下还有 redact event = bypass 没生效
  // → meta 应该跑挂提示套件实现走偏。
  assert.equal(
    redactEvents.length,
    0,
    `meta-redact-leak 套件失效——bypass on 时还有 ${redactEvents.length} 个 redact event`,
  );
  assert.ok(
    bypassEvents.length > 0,
    `meta-redact-leak 套件失效——bypass on 时期望至少 1 个 bypass event 表明 redact 真没跑，实际 ${bypassEvents.length}`,
  );

  await cleanupFixture(caseId);
});

// ============================================================
// meta-deviceid-collision：让 client-a / client-b 共用同 deviceId
// → F3 期望 cache 互相污染（同 deviceId 在 server 端共用 manifest）
// ============================================================
test("meta-deviceid-collision: client-a / client-b 共用 deviceId → cache 串台", async () => {
  const caseIdA = "case-meta-coll-a";
  const caseIdB = "case-meta-coll-b";
  await writeFixture(caseIdA, { ".keep": "" });
  await writeFixture(caseIdB, { ".keep": "" });

  const collidedDeviceId = "00000000-meta-coll-shared-deviceid";
  await clients.setForcedDeviceId("client-a", { forceDeviceId: collidedDeviceId });
  await clients.setForcedDeviceId("client-b", { forceDeviceId: collidedDeviceId });

  await mockAdmin.loadScript({
    name: "meta-coll-a",
    match: { predicate: { path: "messages[0].content", op: "contains", value: "META-COLL-A" } },
    respond: scriptText("coll a"),
  });
  await mockAdmin.loadScript({
    name: "meta-coll-b",
    match: { predicate: { path: "messages[0].content", op: "contains", value: "META-COLL-B" } },
    respond: scriptText("coll b"),
  });

  const [resA, resB] = await Promise.all([
    clients.run("client-a", {
      prompt: "[META-COLL-A]",
      cwd: clientCwd(caseIdA),
      homeFixture: { ".claude/CLAUDE.md": "marker-a-meta-coll" },
    }),
    clients.run("client-b", {
      prompt: "[META-COLL-B]",
      cwd: clientCwd(caseIdB),
      homeFixture: { ".claude/CLAUDE.md": "marker-b-meta-coll" },
    }),
  ]);

  // 两侧 deviceId 都被强制成同一值
  assert.equal(resA.deviceId, collidedDeviceId);
  assert.equal(resB.deviceId, collidedDeviceId);

  // 在 server 端两侧实际指向同一个 manifest
  const sumA = await cacheAdmin.summary(resA.deviceId);
  const sumB = await cacheAdmin.summary(resB.deviceId);
  assert.equal(
    sumA.deviceId,
    sumB.deviceId,
    "deviceId collision: 两侧应该指向同一 manifest",
  );
  assert.equal(
    sumA.revision,
    sumB.revision,
    "deviceId collision: 同 manifest 必须 revision 一致",
  );

  await cleanupFixture(caseIdA);
  await cleanupFixture(caseIdB);
});
