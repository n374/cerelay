/**
 * P0-B-Critical-2 (E1 site coverage): 验证 ~/.claude/settings.json redact 三处
 * 出口都正确 emit `file-proxy.settings.redacted` admin event 且 detail.site 命中
 * 对应 site 名（snapshot / cache-hit / passthrough）。
 *
 * 与 file-proxy-manager-redaction.test.ts 的差异：
 * - 那个测试验"redact 输出字节正确"
 * - 本测试验"site 字段精确等值 + bypass on 时切到 redact.bypassed event"
 *
 * 设计依据：docs/e2e-comprehensive-testing.md §11.1 C2——e2e 不可稳定触发
 * cache-hit / passthrough 两种 site，降级 server 单测覆盖。
 */

// I3 加固：setTestToggles / resetTestToggles 在生产路径默认 throw（防误开放水开关）。
// 单测显式 set CERELAY_ADMIN_EVENTS=true 进入 e2e meta-test 等价模式，允许写 toggle。
// 须在 import test-toggles 之前设置（assertWritable 是 call-time 检查，import 时不读）。
process.env.CERELAY_ADMIN_EVENTS = "true";

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm } from "node:fs/promises";
import { FileProxyManager } from "../src/file-proxy-manager.js";
import { AdminEventBuffer } from "../src/admin-events.js";
import { resetTestToggles, setTestToggles } from "../src/test-toggles.js";
import type { CacheEntry, FileProxyResponse } from "../src/protocol.js";

const LEAK_MARKER = "DO-NOT-LEAK-MARKER-SITE";

function settingsWithLoginState(): Buffer {
  return Buffer.from(JSON.stringify({
    theme: "dark",
    apiKeyHelper: `/usr/bin/get-key-${LEAK_MARKER}`,
    env: {
      ANTHROPIC_BASE_URL: `https://${LEAK_MARKER}.example.com`,
      ANTHROPIC_API_KEY: `sk-${LEAK_MARKER}-12345`,
      OTHER_VAR: "preserved",
    },
  }), "utf8");
}

class MockCacheStore {
  blobs = new Map<string, Buffer>();
  manifestEntries = new Map<string, CacheEntry>();

  setBlob(sha: string, buf: Buffer): void { this.blobs.set(sha, buf); }
  setEntry(scope: string, relPath: string, entry: CacheEntry): void {
    this.manifestEntries.set(`${scope}:${relPath}`, entry);
  }
  readBlobSync(_d: string, sha: string): Buffer | null { return this.blobs.get(sha) ?? null; }
  async lookupEntry(_d: string, scope: string, relPath: string): Promise<CacheEntry | null> {
    return this.manifestEntries.get(`${scope}:${relPath}`) ?? null;
  }
  async loadManifest(_d: string): Promise<unknown> {
    return { version: 3, revision: 1, scopes: { "claude-home": { entries: {} }, "claude-json": { entries: {} } } };
  }
}

async function makeHarness(t: { after: (cb: () => Promise<void> | void) => void }): Promise<{
  manager: FileProxyManager;
  cacheStore: MockCacheStore;
  adminEvents: AdminEventBuffer;
}> {
  const tempRoot = path.join(tmpdir(), `fpm-redact-site-${Date.now()}-${Math.random()}`);
  await mkdir(tempRoot, { recursive: true });
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    resetTestToggles();
  });

  const cacheStore = new MockCacheStore();
  // AdminEventBuffer 构造时显式 enabled=true（生产由 env gate，单测直接开）
  const adminEvents = new AdminEventBuffer(true);

  const manager = new FileProxyManager({
    runtimeRoot: tempRoot,
    clientHomeDir: "/home/test-user",
    clientCwd: "/projects/test",
    sessionId: "test-session-redact-site",
    sendToClient: async () => undefined,
    cacheStore: cacheStore as any,
    deviceId: "test-device",
    adminEvents,
  });

  // 拦截 writeToDaemon，避免实际 stdin
  (manager as any).writeToDaemon = (_data: Record<string, unknown>): void => undefined;

  return { manager, cacheStore, adminEvents };
}

function getRedactEvents(adminEvents: AdminEventBuffer): Array<{ kind: string; site?: string; relPath?: string }> {
  return adminEvents.fetch({}).map((e) => ({
    kind: e.kind,
    site: (e.detail as { site?: string } | undefined)?.site,
    relPath: (e.detail as { relPath?: string } | undefined)?.relPath,
  }));
}

// ============================================================
// 出口 #1 snapshot site
// ============================================================

test("E1 site: snapshot 出口 redact emit site=snapshot", async (t) => {
  const { manager, cacheStore, adminEvents } = await makeHarness(t);

  const original = settingsWithLoginState();
  cacheStore.setBlob("sha-snap", original);
  const manifest = {
    revision: 1,
    scopes: {
      "claude-home": { entries: { "settings.json": { size: original.byteLength, mtime: Date.now(), sha256: "sha-snap" } } },
      "claude-json": { entries: {} },
    },
  };
  (manager as any).buildSnapshotFromManifest(manifest);

  const events = getRedactEvents(adminEvents);
  const redactEvents = events.filter((e) => e.kind === "file-proxy.settings.redacted");
  assert.ok(redactEvents.length > 0, `expected redacted event, got: ${JSON.stringify(events)}`);
  assert.equal(redactEvents[0].site, "snapshot", "site 必须等值 snapshot");
  assert.equal(redactEvents[0].relPath, "settings.json");
});

// ============================================================
// 出口 #2 cache-hit site
// ============================================================

test("E1 site: cache-hit 出口 redact emit site=cache-hit", async (t) => {
  const { manager, cacheStore, adminEvents } = await makeHarness(t);

  const original = settingsWithLoginState();
  cacheStore.setBlob("sha-cache", original);
  cacheStore.setEntry("claude-home", "settings.json", {
    size: original.byteLength, mtime: Date.now(), sha256: "sha-cache",
  });

  await (manager as any).tryServeReadFromCache({
    reqId: "rq-cache", op: "read", root: "home-claude", relPath: "settings.json",
    offset: 0, size: original.byteLength,
  });

  const events = getRedactEvents(adminEvents);
  const redactEvents = events.filter((e) => e.kind === "file-proxy.settings.redacted");
  assert.ok(redactEvents.length > 0, `expected redacted event, got: ${JSON.stringify(events)}`);
  assert.equal(redactEvents[0].site, "cache-hit", "site 必须等值 cache-hit");
});

// ============================================================
// 出口 #3 passthrough site
// ============================================================

test("E1 site: passthrough 出口 redact emit site=passthrough", async (t) => {
  const { manager, adminEvents } = await makeHarness(t);

  const original = settingsWithLoginState();
  // 拦截 sendClientRequest 让 getattr / read 同步返回构造的响应
  (manager as any).sendClientRequest = async (req: Record<string, unknown>) => {
    if (req.op === "getattr") {
      return { stat: { mode: 0o644, size: original.byteLength, mtime: 0, atime: 0, uid: 0, gid: 0, isDir: false } };
    }
    if (req.op === "read") {
      return { data: original.toString("base64") };
    }
    return {};
  };
  // tryGetSettingsJsonSizeFromCache 没 cache 时返回 null（默认行为）
  (manager as any).tryGetSettingsJsonSizeFromCache = async () => null;

  await (manager as any).handleSettingsJsonReadPassthrough(
    { reqId: "rq-pt", op: "read", root: "home-claude", relPath: "settings.json", offset: 0, size: 4096 },
    "/home/test-user/.claude",
  );

  const events = getRedactEvents(adminEvents);
  const redactEvents = events.filter((e) => e.kind === "file-proxy.settings.redacted");
  assert.ok(redactEvents.length > 0, `expected redacted event, got: ${JSON.stringify(events)}`);
  assert.equal(redactEvents[0].site, "passthrough", "site 必须等值 passthrough");
});

// ============================================================
// bypass 切换：disableRedact=true → emit redact.bypassed（覆盖 meta-redact-leak 不变量）
// ============================================================

test("E1 site bypass: disableRedact=true 时 snapshot 出口切到 redact.bypassed event", async (t) => {
  const { manager, cacheStore, adminEvents } = await makeHarness(t);

  setTestToggles({ disableRedact: true });

  const original = settingsWithLoginState();
  cacheStore.setBlob("sha-bypass", original);
  const manifest = {
    revision: 1,
    scopes: {
      "claude-home": { entries: { "settings.json": { size: original.byteLength, mtime: Date.now(), sha256: "sha-bypass" } } },
      "claude-json": { entries: {} },
    },
  };
  (manager as any).buildSnapshotFromManifest(manifest);

  const events = getRedactEvents(adminEvents);
  const redactEvents = events.filter((e) => e.kind === "file-proxy.settings.redacted");
  const bypassEvents = events.filter((e) => e.kind === "file-proxy.settings.redact.bypassed");
  assert.equal(redactEvents.length, 0, "bypass on 时不应有 redacted event");
  assert.ok(bypassEvents.length > 0, `expected bypassed event, got: ${JSON.stringify(events)}`);
  assert.equal(bypassEvents[0].site, "snapshot", "bypass event site 必须等值 snapshot");
});
