import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AccessLedgerStore } from "../src/access-ledger.js";
import { ClientCacheStore } from "../src/client-cache-store.js";
import { FileProxyManager } from "../src/file-proxy-manager.js";
import { SEED_WHITELIST } from "../src/seed-whitelist.js";
import type { FileProxyRequest } from "../src/protocol.js";

/**
 * 回归: 冷启动 (ledger 完全空) 场景下 SeedWhitelist.knownMissing 必须也注入
 * snapshot.negatives, 否则 daemon 启动后 _negative_perm 没条目, CC 启动期常探的
 * agents/skills/commands/.config.json 全部穿透 client.
 *
 * 这个 fix 来自 docker 实测发现的 hole: 当 ledger volume 是新建的 (用户首次跑
 * 带 access-ledger feature 的版本), totalLedgerMissing=0, 但 SeedWhitelist 里
 * 列的 knownMissing 没作用到 daemon 端. 结果实测看到 home-claude/skills /agents
 * /commands 等全部"FUSE 穿透 client 首次出现".
 */

const DEVICE = "device-seed";
const CLIENT_HOME = "/Users/cerelay-seed";
const CLIENT_CWD = "/Users/cerelay-seed/work";

async function makeStores() {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "cerelay-seed-cache-"));
  const ledgerDir = await mkdtemp(path.join(tmpdir(), "cerelay-seed-ledger-"));
  return {
    cacheDir,
    ledgerDir,
    cacheStore: new ClientCacheStore({ dataDir: cacheDir }),
    ledgerStore: new AccessLedgerStore({ dataDir: ledgerDir }),
    cleanup: async () => {
      await rm(cacheDir, { recursive: true, force: true });
      await rm(ledgerDir, { recursive: true, force: true });
    },
  };
}

test("冷启动: ledger 空时 SeedWhitelist.knownMissing 注入 snapshot.negatives", async (t) => {
  const stores = await makeStores();
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "seed-rt-"));
  t.after(async () => {
    await stores.cleanup();
    await rm(runtimeRoot, { recursive: true, force: true });
  });

  // ledger 完全空 (新 device 首次连接), 不预填任何 missing

  const clientRpcs: FileProxyRequest[] = [];
  const manager = new FileProxyManager({
    runtimeRoot,
    clientHomeDir: CLIENT_HOME,
    clientCwd: CLIENT_CWD,
    sessionId: "seed-test",
    sendToClient: async (msg) => {
      clientRpcs.push(msg);
      manager.resolveResponse({
        type: "file_proxy_response",
        reqId: msg.reqId,
        sessionId: msg.sessionId,
        snapshot: [],
      });
    },
    cacheStore: stores.cacheStore,
    deviceId: DEVICE,
    accessLedgerStore: stores.ledgerStore,
    cacheTaskManager: {
      shouldUseCacheSnapshot: () => true,
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

  const snapshot = JSON.parse(await readFile(snapshotFile, "utf8")) as {
    negatives: string[];
  };

  // SeedWhitelist 的 home-claude knownMissing 应当全部出现在 snapshot.negatives
  // (路径转成绝对: home-claude root + relPath)
  const homeRoot = `${CLIENT_HOME}/.claude`;
  const seedKnownMissing = SEED_WHITELIST.scopes["claude-home"]?.knownMissing ?? [];
  for (const rel of seedKnownMissing) {
    const expected = rel ? `${homeRoot}/${rel}` : homeRoot;
    assert.ok(
      snapshot.negatives.includes(expected),
      `SeedWhitelist knownMissing "${rel}" 应被注入 snapshot.negatives; 实际: ${JSON.stringify(snapshot.negatives)}`,
    );
  }
});

test("温启动: ledger 含 missing + SeedWhitelist 同时注入, 不重复", async (t) => {
  const stores = await makeStores();
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "seed-rt-"));
  t.after(async () => {
    await stores.cleanup();
    await rm(runtimeRoot, { recursive: true, force: true });
  });

  // 预填 ledger missing — 包括一个跟 SeedWhitelist 重叠的路径
  const { AccessLedgerRuntime } = await import("../src/access-ledger.js");
  const ledger = new AccessLedgerRuntime(DEVICE);
  // 注: SeedWhitelist 里有 "agents", 这里也加进 ledger - 验证不会重复出现
  ledger.upsertMissing(`${CLIENT_HOME}/.claude/agents`, Date.now());
  // 一个 ledger 独有的 missing
  ledger.upsertMissing(`${CLIENT_HOME}/.claude/plugins/themes`, Date.now());
  await stores.ledgerStore.persist(ledger);

  const manager = new FileProxyManager({
    runtimeRoot,
    clientHomeDir: CLIENT_HOME,
    clientCwd: CLIENT_CWD,
    sessionId: "warm-test",
    sendToClient: async (msg) => {
      manager.resolveResponse({
        type: "file_proxy_response",
        reqId: msg.reqId,
        sessionId: msg.sessionId,
        snapshot: [],
      });
    },
    cacheStore: stores.cacheStore,
    deviceId: DEVICE,
    accessLedgerStore: stores.ledgerStore,
    cacheTaskManager: {
      shouldUseCacheSnapshot: () => true,
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

  const snapshot = JSON.parse(await readFile(snapshotFile, "utf8")) as {
    negatives: string[];
  };

  // ledger 独有的 missing 在
  assert.ok(snapshot.negatives.includes(`${CLIENT_HOME}/.claude/plugins/themes`));
  // SeedWhitelist + ledger 重叠的 agents 在 (但不重复)
  const agentsCount = snapshot.negatives.filter(
    (p) => p === `${CLIENT_HOME}/.claude/agents`,
  ).length;
  assert.equal(agentsCount, 1, "ledger + SeedWhitelist 重叠条目不应重复");
  // SeedWhitelist 独有的也在 (skills / commands / .config.json)
  assert.ok(snapshot.negatives.includes(`${CLIENT_HOME}/.claude/skills`));
  assert.ok(snapshot.negatives.includes(`${CLIENT_HOME}/.claude/commands`));
  assert.ok(snapshot.negatives.includes(`${CLIENT_HOME}/.claude/.config.json`));
});
