import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { AccessLedgerRuntime, AccessLedgerStore } from "../src/access-ledger.js";
import { ClientCacheStore } from "../src/file-agent/store.js";
import { FileProxyManager } from "../src/file-proxy-manager.js";
import { PYTHON_FUSE_HOST_SCRIPT } from "../src/fuse-host-script.js";
import type { FileProxyRequest } from "../src/protocol.js";

/**
 * 回归测试: spec §14.3 "Defect 2 不复现 — 跨 session missing 路径不再穿透 client"。
 *
 * cerelay 在 macOS 上无法 spawn 完整 FUSE daemon (缺 fusepy + macFUSE), 所以
 * "端到端不穿透"分两段验证 + 一段串联：
 *
 * 1. Phase 4.2 端到端: collectAndWriteSnapshot 把持久 ledger.missing 写入
 *    snapshot.json 的 negatives 字段
 * 2. Phase 3.1 daemon 行为: NegativeCache 用 snapshot.negatives 初始化后,
 *    探测路径前缀命中 (包括子路径), 不需要穿透 RPC
 * 3. 串联: 直接把 step1 产出的 snapshot.json.negatives 喂给 step2 的 NegativeCache
 */

const DEVICE_ID = "device-e2e";
const CLIENT_HOME = "/Users/cerelay-e2e";
const CLIENT_CWD = "/Users/cerelay-e2e/work";

async function makeCacheStore() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cerelay-cache-"));
  return {
    dataDir,
    store: new ClientCacheStore({ dataDir }),
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}

async function makeLedgerStore() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cerelay-ledger-"));
  return {
    dataDir,
    store: new AccessLedgerStore({ dataDir }),
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}

/** Step 1: 完整跑 collectAndWriteSnapshot, 返回写出的 snapshot.json 内容 */
async function captureSnapshotWithLedgerMissing(
  cacheStore: ClientCacheStore,
  ledgerStore: AccessLedgerStore,
  missingPaths: string[],
  runtimeRoot: string,
  collectClientRpcs: FileProxyRequest[],
): Promise<{
  stats: Record<string, unknown>;
  readdirs: Record<string, string[]>;
  reads: Record<string, string>;
  negatives: string[];
}> {
  // 预填 ledger missing
  const ledgerRuntime = new AccessLedgerRuntime(DEVICE_ID);
  for (const p of missingPaths) ledgerRuntime.upsertMissing(p, Date.now());
  await ledgerStore.persist(ledgerRuntime);

  const manager = new FileProxyManager({
    runtimeRoot,
    clientHomeDir: CLIENT_HOME,
    clientCwd: CLIENT_CWD,
    sessionId: "e2e-session",
    sendToClient: async (msg) => {
      collectClientRpcs.push(msg);
      // 模拟 client 立即响应空 snapshot 让 collectAndWriteSnapshot 流程能完成
      // (project-claude 仍会走 client RPC, 因为不在 cache 覆盖里)
      manager.resolveResponse({
        type: "file_proxy_response",
        reqId: msg.reqId,
        sessionId: msg.sessionId,
        snapshot: [],
      });
    },
    cacheStore,
    deviceId: DEVICE_ID,
    accessLedgerStore: ledgerStore,
    cacheTaskManager: {
      shouldUseCacheSnapshot: () => true, // phase=ready, 走 cache 反向构造
      shouldBypassCacheRead: () => false,
      registerMutationHintForPath: async () => {},
      describeTaskState: () => ({
        exists: true,
        phase: "ready",
        activeClientId: "client-test",
        assignmentId: "asg-1",
        revision: 1,
        candidateClientCount: 1,
        lastHeartbeatAt: Date.now(),
      }),
    },
  });

  const snapshotFile = path.join(runtimeRoot, "snapshot.json");
  await (manager as unknown as {
    collectAndWriteSnapshot: (file: string) => Promise<void>;
  }).collectAndWriteSnapshot(snapshotFile);

  return JSON.parse(await readFile(snapshotFile, "utf8"));
}

/** Step 2: 把 negatives 列表喂给 daemon NegativeCache 类, 验证 contains() 命中 */
function negativeCacheCheckPaths(
  negatives: string[],
  pathsToCheck: Array<{ path: string; expectHit: boolean }>,
): { ok: boolean; output: string } {
  const script = PYTHON_FUSE_HOST_SCRIPT;
  const startIdx = script.indexOf("class NegativeCache:");
  const endIdx = script.indexOf("class Cache:");
  const cls = script.slice(startIdx, endIdx);

  const checks = pathsToCheck.map((c) => {
    const expected = c.expectHit ? "True" : "False";
    return `assert nc.contains(${JSON.stringify(c.path)}) is ${expected}, "path=${c.path} expected hit=${c.expectHit}"`;
  }).join("\n");

  const code = `
import bisect, os, sys
${cls}
nc = NegativeCache()
# 模拟 daemon 启动时把 snapshot.negatives 灌进 _negative_perm
for p in ${JSON.stringify(negatives)}:
    nc.put(p)

${checks}
print("OK")
`;
  const result = spawnSync("python3", ["-c", code], { encoding: "utf8", timeout: 10_000 });
  return {
    ok: result.status === 0,
    output: (result.stdout || "") + (result.stderr || ""),
  };
}

// =============================================================================
// 实际测试用例
// =============================================================================

test("Step 1: collectAndWriteSnapshot 把 ledger.missing 写入 snapshot.json.negatives", async (t) => {
  const cache = await makeCacheStore();
  const ledger = await makeLedgerStore();
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "e2e-rt-"));
  t.after(async () => {
    await cache.cleanup();
    await ledger.cleanup();
    await rm(runtimeRoot, { recursive: true, force: true });
  });

  const missingPaths = [
    `${CLIENT_HOME}/.claude/plugins/themes`,
    `${CLIENT_HOME}/.claude/output-styles`,
    `${CLIENT_HOME}/.claude/monitors`,
  ];
  const clientRpcs: FileProxyRequest[] = [];
  const snapshot = await captureSnapshotWithLedgerMissing(
    cache.store, ledger.store, missingPaths, runtimeRoot, clientRpcs,
  );

  // 全部 missing 路径必须出现在 snapshot.negatives
  for (const p of missingPaths) {
    assert.ok(
      snapshot.negatives.includes(p),
      `期望 snapshot.negatives 含 ${p}, 实际: ${JSON.stringify(snapshot.negatives)}`,
    );
  }
});

test("Step 2: NegativeCache 启动注入后, 探测同一 path 命中 (前缀语义)", () => {
  const negatives = [`${CLIENT_HOME}/.claude/plugins/themes`];
  const result = negativeCacheCheckPaths(negatives, [
    // 同 path → 命中
    { path: `${CLIENT_HOME}/.claude/plugins/themes`, expectHit: true },
    // 子路径 → 前缀命中 (深层访问也直接 ENOENT, 不穿透)
    { path: `${CLIENT_HOME}/.claude/plugins/themes/some-file`, expectHit: true },
    { path: `${CLIENT_HOME}/.claude/plugins/themes/sub/deep/leaf`, expectHit: true },
    // 兄弟 path → 不命中 (应穿透 RPC 学习)
    { path: `${CLIENT_HOME}/.claude/plugins/output-styles`, expectHit: false },
    // 祖先 path → 不命中 (祖先存在或未知)
    { path: `${CLIENT_HOME}/.claude/plugins`, expectHit: false },
    // 完全无关 → 不命中
    { path: `${CLIENT_HOME}/.claude/skills/foo`, expectHit: false },
  ]);
  assert.ok(result.ok, `python selftest fail: ${result.output}`);
});

test("Defect 2 端到端: 跨 session missing 不再穿透 (ledger 持久化 → snapshot → NegativeCache 命中)", async (t) => {
  const cache = await makeCacheStore();
  const ledger = await makeLedgerStore();
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "e2e-rt-"));
  t.after(async () => {
    await cache.cleanup();
    await ledger.cleanup();
    await rm(runtimeRoot, { recursive: true, force: true });
  });

  // 模拟 session 1: CC 探测了一些不存在路径, ledger 持久化
  const missingFromPriorSession = [
    `${CLIENT_HOME}/.claude/plugins/cache/openai-codex/codex/1.0.4/themes`,
    `${CLIENT_HOME}/.claude/plugins/cache/openai-codex/codex/1.0.4/output-styles`,
    `${CLIENT_HOME}/.claude/plugins/cache/superpowers-marketplace/superpowers/5.0.7/monitors`,
  ];

  // session 2: 启动期 — collectAndWriteSnapshot 应把上述 missing 写入 snapshot
  const clientRpcs: FileProxyRequest[] = [];
  const snapshot = await captureSnapshotWithLedgerMissing(
    cache.store, ledger.store, missingFromPriorSession, runtimeRoot, clientRpcs,
  );

  // 端到端断言: 把 snapshot.negatives 喂给 NegativeCache, 后续 daemon 探测同 path
  // 应当全部命中 — 不需要任何 client RPC (即不穿透)
  const checks = missingFromPriorSession.flatMap((p) => [
    { path: p, expectHit: true },
    { path: `${p}/some-file`, expectHit: true }, // 前缀命中
  ]);
  const result = negativeCacheCheckPaths(snapshot.negatives, checks);
  assert.ok(result.ok, `防穿透端到端 selftest fail: ${result.output}`);
});

test("防穿透: ledger 跨 cwd 共享, missing 投影只覆盖本 session roots", async (t) => {
  const cache = await makeCacheStore();
  const ledger = await makeLedgerStore();
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "e2e-rt-"));
  t.after(async () => {
    await cache.cleanup();
    await ledger.cleanup();
    await rm(runtimeRoot, { recursive: true, force: true });
  });

  // ledger 含跨 device 跨 cwd 学到的 missing — 但有些不在本 session FUSE roots 里
  const missingPaths = [
    `${CLIENT_HOME}/.claude/in-roots`,           // 在 home-claude root
    `${CLIENT_HOME}/.claude.json/nested`,        // 在 home-claude-json root (理论上不该有 nested, 测过滤逻辑)
    `${CLIENT_CWD}/.claude/in-cwd`,              // 在 project-claude root
    `/Users/other-user/.claude/cross-user`,      // 越界 root
    `/etc/passwd-missing`,                        // 完全不在 root 内
  ];
  const clientRpcs: FileProxyRequest[] = [];
  const snapshot = await captureSnapshotWithLedgerMissing(
    cache.store, ledger.store, missingPaths, runtimeRoot, clientRpcs,
  );

  // 在 root 内的 → 必须出现在 negatives
  assert.ok(snapshot.negatives.includes(`${CLIENT_HOME}/.claude/in-roots`));
  assert.ok(snapshot.negatives.includes(`${CLIENT_CWD}/.claude/in-cwd`));

  // 越界的 → 必须不出现 (避免污染本 session 视图)
  assert.ok(!snapshot.negatives.includes(`/Users/other-user/.claude/cross-user`),
    "越界 missing 不应注入本 session snapshot");
  assert.ok(!snapshot.negatives.includes(`/etc/passwd-missing`),
    "完全越界 missing 不应注入本 session snapshot");
});
