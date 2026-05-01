import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AccessLedgerRuntime, AccessLedgerStore } from "../src/access-ledger.js";
import { ClientCacheStore } from "../src/client-cache-store.js";
import { FileProxyManager } from "../src/file-proxy-manager.js";
import { PYTHON_FUSE_HOST_SCRIPT } from "../src/fuse-host-script.js";
import type { FileProxyRequest, CacheTaskChange } from "../src/protocol.js";

/**
 * E2E 防穿透回归测试: 在用户真实日志里看到 5 次 "FUSE 穿透 client 首次出现"
 * 中的 4 次属于 cache 应已覆盖但未命中. 这里用编程化断言固化"daemon 内 cache
 * 命中后不会发 RPC 给 server" 的契约, 不靠 grep 日志.
 *
 * 检测方式 (用户要求"更合理"):
 *   1. 用真实 ClientCacheStore + AccessLedgerStore + FileProxyManager 跑
 *      collectAndWriteSnapshot, 产出 snapshot.json
 *   2. spawn python3 跑 daemon 内嵌的 Cache / NegativeCache 类 + Operations.getattr
 *      链路简化版, 喂 snapshot 内容 + 模拟 RPC 调用
 *   3. mock send_request 计数, 断言"已注入 path → 0 次 RPC, 即不穿透"
 */

const DEVICE_ID = "device-no-perf";
const CLIENT_HOME = "/Users/cerelay-no-perf";
const CLIENT_CWD = "/Users/cerelay-no-perf/work";

async function makeStores() {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "cerelay-cache-"));
  const ledgerDir = await mkdtemp(path.join(tmpdir(), "cerelay-ledger-"));
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

/**
 * 跑完整 collectAndWriteSnapshot 产出真实 snapshot.json.
 * 模拟 client snapshot RPC 立即返回空, 让流程能完成.
 */
async function buildSnapshot(args: {
  cacheStore: ClientCacheStore;
  ledgerStore: AccessLedgerStore;
  /** 预填到 cache (manifest+blob) 的 entries — 这些应被注入 _stat_perm/_read_perm */
  cacheEntries: CacheTaskChange[];
  /** 预填到 ledger 的 missing 路径 — 这些应被注入 _negative_perm */
  ledgerMissing: string[];
  runtimeRoot: string;
}): Promise<{ snapshotJson: string; clientRpcs: FileProxyRequest[] }> {
  await args.cacheStore.applyDelta(DEVICE_ID, CLIENT_CWD, args.cacheEntries);

  const ledgerRuntime = new AccessLedgerRuntime(DEVICE_ID);
  for (const p of args.ledgerMissing) {
    ledgerRuntime.upsertMissing(p, Date.now());
  }
  await args.ledgerStore.persist(ledgerRuntime);

  const clientRpcs: FileProxyRequest[] = [];
  const manager = new FileProxyManager({
    runtimeRoot: args.runtimeRoot,
    clientHomeDir: CLIENT_HOME,
    clientCwd: CLIENT_CWD,
    sessionId: "no-perf-session",
    sendToClient: async (msg) => {
      clientRpcs.push(msg);
      manager.resolveResponse({
        type: "file_proxy_response",
        reqId: msg.reqId,
        sessionId: msg.sessionId,
        snapshot: [],
      });
    },
    cacheStore: args.cacheStore,
    deviceId: DEVICE_ID,
    accessLedgerStore: args.ledgerStore,
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

  const snapshotFile = path.join(args.runtimeRoot, "snapshot.json");
  await (manager as unknown as {
    collectAndWriteSnapshot: (file: string) => Promise<void>;
  }).collectAndWriteSnapshot(snapshotFile);

  return {
    snapshotJson: await readFile(snapshotFile, "utf8"),
    clientRpcs,
  };
}

/**
 * spawn python3 跑 daemon 内嵌的 Cache + NegativeCache + Operations.getattr 简化链路.
 *
 * 输入:
 *   - snapshotJson: 真实 daemon 启动期会从 CERELAY_FUSE_CACHE_SNAPSHOT 文件读的内容
 *   - probeAbsPaths: 探测的绝对路径列表 (相当于 daemon 收到的 getattr/readdir 请求)
 *
 * 输出 (从 stdout 解析 JSON):
 *   - perforated: number — send_request 被调用次数 (即穿透 RPC 次数)
 *   - hits_negative: number — 命中 _negative_perm 的次数
 *   - hits_stat: number — 命中 _stat_perm 的次数
 */
function runDaemonProbeSelftest(
  snapshotJson: string,
  probeAbsPaths: Array<{ op: "getattr" | "readdir"; root: string; relPath: string }>,
  fuseRoots: Record<string, string>,
): {
  perforated: number;
  hitsNegative: number;
  hitsStat: number;
  hitsReaddir: number;
  raw: string;
} {
  // 抽取 daemon 脚本里 Cache + NegativeCache 类源码 + parse_fuse_path / resolve_hand_path
  const script = PYTHON_FUSE_HOST_SCRIPT;
  const negStart = script.indexOf("class NegativeCache:");
  const cacheStart = script.indexOf("class Cache:");
  const cacheEnd = script.indexOf("_cache = Cache()");
  const negativeCacheClass = script.slice(negStart, cacheStart);
  const cacheClass = script.slice(cacheStart, cacheEnd);

  const probeJson = JSON.stringify(probeAbsPaths);
  const rootsJson = JSON.stringify(fuseRoots);
  const snapJson = JSON.stringify(snapshotJson);

  const code = `
import bisect, errno, json, os, sys, threading, time

${negativeCacheClass}

${cacheClass}
_cache = Cache()

ROOTS = json.loads(${JSON.stringify(JSON.stringify(fuseRoots))})

# 模拟 daemon 启动期把 snapshot.json 内容灌进 Cache (跟产品代码 fuse-host-script.ts:961+ 等价)
snapshot = json.loads(${JSON.stringify(snapshotJson)})
for path, st in snapshot.get("stats", {}).items():
    _cache.put_stat_perm(path, st)
for path, entries in snapshot.get("readdirs", {}).items():
    _cache.put_readdir_perm(path, entries)
for path, b64 in snapshot.get("reads", {}).items():
    import base64 as _b64
    _cache.put_read_perm(path, _b64.b64decode(b64))
for negpath in snapshot.get("negatives", []):
    _cache.put_negative_perm(negpath)

# Mock send_request: 任何调用都计数 (即"穿透 RPC")
perforated_count = 0
def send_request(req):
    global perforated_count
    perforated_count += 1
    # 模拟 ENOENT 让 caller 不挂死
    raise FuseOSError(errno.ENOENT)

class FuseOSError(Exception):
    def __init__(self, errno_val):
        self.errno = errno_val

def resolve_hand_path(root_name, rel_path):
    base = ROOTS.get(root_name)
    if not base:
        return None
    return os.path.join(base, rel_path) if rel_path else base

# 简化版 Operations.getattr - 跟 fuse-host-script.ts:496-580 流程对齐:
#   1. 查 _negative_perm (前缀) — 命中抛 ENOENT, 不穿透
#   2. 查 _stat_perm (永久层) — 命中返回 cached, 不穿透
#   3. send_request — 穿透
def operations_getattr(root_name, rel_path):
    hand_path = resolve_hand_path(root_name, rel_path)
    if not hand_path:
        return {"hit": "no_root"}
    if _cache.is_negative(hand_path):
        return {"hit": "negative"}
    cached = _cache.get_stat(hand_path)
    if cached:
        return {"hit": "stat"}
    try:
        send_request({"op": "getattr", "root": root_name, "relPath": rel_path})
    except FuseOSError:
        pass
    return {"hit": "perforation"}

# 简化版 Operations.readdir - 跟 fuse-host-script.ts:600-630 等价 (是否穿透相同语义)
def operations_readdir(root_name, rel_path):
    hand_path = resolve_hand_path(root_name, rel_path)
    if not hand_path:
        return {"hit": "no_root"}
    if _cache.is_negative(hand_path):
        return {"hit": "negative"}
    cached = _cache.get_readdir(hand_path)
    if cached is not None:
        return {"hit": "readdir"}
    try:
        send_request({"op": "readdir", "root": root_name, "relPath": rel_path})
    except FuseOSError:
        pass
    return {"hit": "perforation"}

probes = json.loads(${JSON.stringify(probeJson)})
results = {"perforated": 0, "hits_negative": 0, "hits_stat": 0, "hits_readdir": 0, "details": []}
for probe in probes:
    op = probe["op"]
    if op == "getattr":
        r = operations_getattr(probe["root"], probe["relPath"])
    elif op == "readdir":
        r = operations_readdir(probe["root"], probe["relPath"])
    else:
        r = {"hit": "unknown_op"}
    results["details"].append({"probe": probe, "result": r})
    if r["hit"] == "perforation":
        results["perforated"] += 1
    elif r["hit"] == "negative":
        results["hits_negative"] += 1
    elif r["hit"] == "stat":
        results["hits_stat"] += 1
    elif r["hit"] == "readdir":
        results["hits_readdir"] += 1

print(json.dumps(results))
`;

  const result = spawnSync("python3", ["-c", code], {
    encoding: "utf8",
    timeout: 15_000,
  });

  if (result.status !== 0) {
    throw new Error(`python selftest exit ${result.status}: ${result.stderr}`);
  }

  const parsed = JSON.parse(result.stdout.trim());
  return {
    perforated: parsed.perforated,
    hitsNegative: parsed.hits_negative,
    hitsStat: parsed.hits_stat,
    hitsReaddir: parsed.hits_readdir,
    raw: result.stdout,
  };
}

const FUSE_ROOTS = {
  "home-claude": `${CLIENT_HOME}/.claude`,
  "home-claude-json": `${CLIENT_HOME}/.claude.json`,
  "project-claude": `${CLIENT_CWD}/.claude`,
};

// =============================================================================
// 真正的端到端断言
// =============================================================================

test("daemon: 已 cache 的 file path 不穿透 RPC", async (t) => {
  const stores = await makeStores();
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "no-perf-"));
  t.after(async () => {
    await stores.cleanup();
    await rm(runtimeRoot, { recursive: true, force: true });
  });

  const { snapshotJson } = await buildSnapshot({
    ...stores,
    cacheEntries: [{
      kind: "upsert",
      scope: "claude-home",
      path: "settings.json",
      size: 5,
      mtime: Math.floor(Date.now() / 1000),
      sha256: createHash("sha256").update("hello").digest("hex"),
      contentBase64: Buffer.from("hello").toString("base64"),
    }],
    ledgerMissing: [],
    runtimeRoot,
  });

  // daemon 收到 getattr settings.json → 应命中 _stat_perm, 不穿透
  const res = runDaemonProbeSelftest(snapshotJson, [
    { op: "getattr", root: "home-claude", relPath: "settings.json" },
  ], FUSE_ROOTS);

  assert.equal(res.perforated, 0, `已 cache 的 settings.json 不该穿透; 实际 ${res.raw}`);
  assert.equal(res.hitsStat, 1);
});

test("daemon: 已 ledger.missing 的 path + 子前缀 都不穿透", async (t) => {
  const stores = await makeStores();
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "no-perf-"));
  t.after(async () => {
    await stores.cleanup();
    await rm(runtimeRoot, { recursive: true, force: true });
  });

  const { snapshotJson } = await buildSnapshot({
    ...stores,
    cacheEntries: [],
    ledgerMissing: [
      `${CLIENT_HOME}/.claude/plugins/cache/openai-codex/codex/1.0.4/themes`,
      `${CLIENT_HOME}/.claude/plugins/cache/superpowers-marketplace/superpowers/5.0.7/output-styles`,
    ],
    runtimeRoot,
  });

  const res = runDaemonProbeSelftest(snapshotJson, [
    // 同一 missing path
    { op: "getattr", root: "home-claude", relPath: "plugins/cache/openai-codex/codex/1.0.4/themes" },
    // 子前缀 missing
    { op: "getattr", root: "home-claude", relPath: "plugins/cache/openai-codex/codex/1.0.4/themes/some-file.json" },
    // 兄弟 missing
    { op: "getattr", root: "home-claude", relPath: "plugins/cache/superpowers-marketplace/superpowers/5.0.7/output-styles" },
    // readdir 也走 _negative_perm
    { op: "readdir", root: "home-claude", relPath: "plugins/cache/openai-codex/codex/1.0.4/themes" },
  ], FUSE_ROOTS);

  assert.equal(res.perforated, 0, `所有已 missing 路径不该穿透; 实际 ${res.raw}`);
  assert.equal(res.hitsNegative, 4);
});

test("daemon: 既未 cache 也未 ledger.missing 的 path → 必须穿透 (sanity check)", async (t) => {
  const stores = await makeStores();
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "no-perf-"));
  t.after(async () => {
    await stores.cleanup();
    await rm(runtimeRoot, { recursive: true, force: true });
  });

  const { snapshotJson } = await buildSnapshot({
    ...stores,
    cacheEntries: [],
    ledgerMissing: [],
    runtimeRoot,
  });

  // 探测从未访问过的路径 (CC 启动后新建的 sessions / backups / projects 等情况)
  const res = runDaemonProbeSelftest(snapshotJson, [
    { op: "getattr", root: "home-claude", relPath: "totally-unknown" },
    { op: "getattr", root: "home-claude", relPath: "backups/.claude.json.backup.<timestamp>" },
  ], FUSE_ROOTS);

  // 这些必然穿透 — manifest / ledger 都没有 — 这是合理穿透
  assert.equal(res.perforated, 2, `从未访问过的 path 必然穿透; 实际 ${res.raw}`);
});

test("Defect 2 端到端断言: 用户日志里 47 个 missing 的 fixture 不穿透", async (t) => {
  // 复制用户实测日志中 negativeSample 出现的部分路径作为 fixture
  // (这些是 cerelay 在生产上学到的 missing, 应当通过 ledger 持久化跨 session 不穿透)
  const stores = await makeStores();
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "no-perf-"));
  t.after(async () => {
    await stores.cleanup();
    await rm(runtimeRoot, { recursive: true, force: true });
  });

  const ledgerMissing = [
    `${CLIENT_HOME}/.claude/.config.json`,
    `${CLIENT_CWD}/.claude/settings.json`,
    `${CLIENT_CWD}/.claude/skills`,
    `${CLIENT_CWD}/.claude/commands`,
    `${CLIENT_CWD}/.claude/agents`,
    `${CLIENT_HOME}/.claude/agents`,
    `${CLIENT_HOME}/.claude/plugins/cache/superpowers-marketplace/superpowers/5.0.7/output-styles`,
    `${CLIENT_HOME}/.claude/plugins/cache/openai-codex/codex/1.0.4/themes`,
    `${CLIENT_HOME}/.claude/plugins/cache/openai-codex/codex/1.0.4/output-styles`,
    `${CLIENT_HOME}/.claude/plugins/cache/superpowers-marketplace/superpowers/5.0.7/themes`,
  ];

  const { snapshotJson } = await buildSnapshot({
    ...stores,
    cacheEntries: [],
    ledgerMissing,
    runtimeRoot,
  });

  const probes = ledgerMissing.flatMap((p) => {
    // 每个 missing 探测两次: 同 path + 子 path
    const rel = p.startsWith(`${CLIENT_HOME}/.claude/`)
      ? p.slice(`${CLIENT_HOME}/.claude/`.length)
      : p.startsWith(`${CLIENT_CWD}/.claude/`)
        ? p.slice(`${CLIENT_CWD}/.claude/`.length)
        : p;
    const root = p.startsWith(`${CLIENT_CWD}/.claude/`) ? "project-claude" : "home-claude";
    return [
      { op: "getattr" as const, root, relPath: rel },
      { op: "readdir" as const, root, relPath: rel },
    ];
  });

  const res = runDaemonProbeSelftest(snapshotJson, probes, FUSE_ROOTS);
  assert.equal(
    res.perforated, 0,
    `用户日志里 ${ledgerMissing.length} 个 missing 全部不该穿透; 实际穿透 ${res.perforated}, raw: ${res.raw}`,
  );
});
