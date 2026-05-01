/**
 * 集成测试：~/.claude/settings.json 三处出口都要 redact 登录态字段。
 *
 * 出口 #1 buildSnapshotFromManifest（启动期 snapshot 预热）
 * 出口 #2 tryServeReadFromCache（运行时 cache 命中）
 * 出口 #3 handleSettingsJsonReadPassthrough（运行时 Client 穿透）
 *
 * 测试通过直接调用 FileProxyManager 的 private 方法（用 `as any` cast）来覆盖
 * 行为，不启动真实 FUSE daemon。同步链路不变量（cache delta 后仍过滤）通过
 * 出口 #2 的"切换 blob 内容 → 再次调用"模式验证。
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { FileProxyManager } from "../src/file-proxy-manager.js";
import type { CacheEntry, FileProxyResponse } from "../src/protocol.js";

// ============================================================
// 测试 fixture：含全部 4 个登录态字段 + 一些 user 偏好字段的 settings.json
// ============================================================

const LEAK_MARKER = "DO-NOT-LEAK-MARKER";

function settingsWithLoginState(): Buffer {
  return Buffer.from(JSON.stringify({
    theme: "dark",
    statusLine: "git",
    apiKeyHelper: `/usr/bin/get-key-${LEAK_MARKER}`,
    env: {
      ANTHROPIC_BASE_URL: `https://${LEAK_MARKER}.example.com`,
      ANTHROPIC_API_KEY: `sk-${LEAK_MARKER}-12345`,
      ANTHROPIC_AUTH_TOKEN: `oauth-${LEAK_MARKER}-tok`,
      OTHER_VAR: "preserved",
    },
    hooks: { PreToolUse: [] },
  }), "utf8");
}

function settingsWithoutLoginState(): Buffer {
  return Buffer.from(JSON.stringify({
    theme: "light",
    statusLine: "default",
    hooks: { PostToolUse: [] },
  }), "utf8");
}

interface RecordedDaemonWrite {
  data: Record<string, unknown>;
}

// ============================================================
// Mock CacheStore：实现 FileProxyManager 用到的 lookupEntry / readBlobSync 等接口。
// ============================================================

class MockCacheStore {
  blobs = new Map<string, Buffer>();
  manifestEntries = new Map<string, CacheEntry>(); // key: `${scope}:${relPath}`

  setBlob(sha: string, buf: Buffer): void {
    this.blobs.set(sha, buf);
  }

  setEntry(scope: string, relPath: string, entry: CacheEntry): void {
    this.manifestEntries.set(`${scope}:${relPath}`, entry);
  }

  readBlobSync(_deviceId: string, _cwd: string, sha: string): Buffer | null {
    return this.blobs.get(sha) ?? null;
  }

  async lookupEntry(
    _deviceId: string,
    _cwd: string,
    scope: string,
    relPath: string,
  ): Promise<CacheEntry | null> {
    return this.manifestEntries.get(`${scope}:${relPath}`) ?? null;
  }

  async loadManifest(_deviceId: string, _cwd: string): Promise<unknown> {
    // 用于 buildSnapshotFromManifest，但测试直接喂 manifest 进去
    return { version: 2, revision: 1, scopes: { "claude-home": { entries: {} }, "claude-json": { entries: {} } } };
  }
}

// ============================================================
// 工具：构造 FileProxyManager + stub writeToDaemon + sendToClient
// ============================================================

interface ManagerHarness {
  manager: FileProxyManager;
  cacheStore: MockCacheStore;
  daemonWrites: RecordedDaemonWrite[];
  clientRequests: Array<Record<string, unknown>>;
  /** 注入对 sendToClient 的响应：调用方在 push 之前 sendToClient resolve 之后由测试触发 resolveResponse */
  respondToClient: (resp: FileProxyResponse) => void;
}

async function makeHarness(t: { after: (cb: () => Promise<void> | void) => void }): Promise<ManagerHarness> {
  const tempRoot = path.join(tmpdir(), `fpm-redact-test-${Date.now()}-${Math.random()}`);
  await mkdir(tempRoot, { recursive: true });
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const cacheStore = new MockCacheStore();
  const daemonWrites: RecordedDaemonWrite[] = [];
  const clientRequests: Array<Record<string, unknown>> = [];

  const manager = new FileProxyManager({
    runtimeRoot: tempRoot,
    clientHomeDir: "/home/test-user",
    clientCwd: "/projects/test",
    sessionId: "test-session",
    sendToClient: async (msg) => {
      clientRequests.push(msg as unknown as Record<string, unknown>);
    },
    cacheStore: cacheStore as any,
    deviceId: "test-device",
  });

  // 拦截 writeToDaemon（FUSE daemon 还没启动，不能真写 stdin）
  (manager as any).writeToDaemon = (data: Record<string, unknown>): void => {
    daemonWrites.push({ data });
  };

  return {
    manager,
    cacheStore,
    daemonWrites,
    clientRequests,
    respondToClient: (resp: FileProxyResponse) => manager.resolveResponse(resp),
  };
}

// ============================================================
// 出口 #1: buildSnapshotFromManifest
// ============================================================

test("出口 #1: settings.json 含登录态字段时 snapshot data 已 redact 且 size 不变", async (t) => {
  const harness = await makeHarness(t);
  const { manager, cacheStore } = harness;

  const original = settingsWithLoginState();
  const sha = "abc123settings";
  cacheStore.setBlob(sha, original);

  const manifest = {
    revision: 1,
    scopes: {
      "claude-home": {
        entries: {
          "settings.json": { size: original.byteLength, mtime: Date.now(), sha256: sha },
        },
      },
      "claude-json": { entries: {} },
    },
  };

  const entries = (manager as any).buildSnapshotFromManifest(manifest);
  const settingsEntry = entries.find((e: any) =>
    e.path === path.join("/home/test-user", ".claude", "settings.json"),
  );

  assert.ok(settingsEntry, "snapshot 应包含 settings.json 条目");
  assert.equal(settingsEntry.stat.size, original.byteLength, "stat.size 必须等于原 size");
  assert.ok(settingsEntry.data, "settings.json 必须带 data");

  const decoded = Buffer.from(settingsEntry.data, "base64");
  assert.equal(decoded.byteLength, original.byteLength, "data 字节数必须等于原 size（size-preserving）");

  const text = decoded.toString("utf8");
  assert.doesNotMatch(text, new RegExp(LEAK_MARKER), "登录态字段值不能出现在 snapshot 中");

  // 末尾 padding 必须是空格（trailing whitespace 是合法 JSON）
  const closingBrace = text.lastIndexOf("}");
  const tail = text.slice(closingBrace + 1);
  assert.match(tail, /^ *$/, "} 之后必须全是空格");

  const parsed = JSON.parse(text);
  assert.equal(parsed.theme, "dark", "非登录态字段必须保留");
  assert.equal(parsed.env.OTHER_VAR, "preserved", "env 中其他字段必须保留");
  assert.equal(parsed.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(parsed.apiKeyHelper, undefined);
});

test("出口 #1: 非 settings.json 文件 byte-equal 灌入 snapshot", async (t) => {
  const harness = await makeHarness(t);
  const { manager, cacheStore } = harness;

  // 同样 marker，但路径是 settings.local.json（不该过滤）
  const original = settingsWithLoginState();
  const sha = "local-settings-sha";
  cacheStore.setBlob(sha, original);

  const manifest = {
    revision: 1,
    scopes: {
      "claude-home": {
        entries: {
          "settings.local.json": { size: original.byteLength, mtime: Date.now(), sha256: sha },
        },
      },
      "claude-json": { entries: {} },
    },
  };

  const entries = (manager as any).buildSnapshotFromManifest(manifest);
  const localEntry = entries.find((e: any) =>
    e.path === path.join("/home/test-user", ".claude", "settings.local.json"),
  );

  assert.ok(localEntry, "snapshot 应包含 settings.local.json 条目");
  const decoded = Buffer.from(localEntry.data, "base64");
  assert.deepEqual(decoded, original, "settings.local.json 必须 byte-equal 原文");
});

// ============================================================
// 出口 #2: tryServeReadFromCache
// ============================================================

test("出口 #2: settings.json 命中 cache 后切片是 redact 后字节", async (t) => {
  const harness = await makeHarness(t);
  const { manager, cacheStore, daemonWrites } = harness;

  const original = settingsWithLoginState();
  const sha = "settings-sha-runtime";
  cacheStore.setBlob(sha, original);
  cacheStore.setEntry("claude-home", "settings.json", {
    size: original.byteLength,
    mtime: Date.now(),
    sha256: sha,
  });

  const handled = await (manager as any).tryServeReadFromCache({
    reqId: "rq-1",
    op: "read",
    root: "home-claude",
    relPath: "settings.json",
    offset: 0,
    size: original.byteLength,
  });

  assert.equal(handled.served, true, "tryServeReadFromCache 必须命中");
  assert.equal(daemonWrites.length, 1, "必须正好写一次 daemon");
  const written = daemonWrites[0].data;
  assert.equal(written.reqId, "rq-1");
  const data = Buffer.from(written.data as string, "base64");
  assert.equal(data.byteLength, original.byteLength, "size-preserving");
  assert.doesNotMatch(data.toString("utf8"), new RegExp(LEAK_MARKER));
});

test("出口 #2: 同步循环 — Client 改了 settings.json 之后 cache blob 更新，下次读仍 redact", async (t) => {
  const harness = await makeHarness(t);
  const { manager, cacheStore, daemonWrites } = harness;

  // 第一版 blob
  const v1 = settingsWithLoginState();
  cacheStore.setBlob("sha-v1", v1);
  cacheStore.setEntry("claude-home", "settings.json", {
    size: v1.byteLength, mtime: 1, sha256: "sha-v1",
  });

  await (manager as any).tryServeReadFromCache({
    reqId: "r1", op: "read", root: "home-claude", relPath: "settings.json", offset: 0, size: v1.byteLength,
  });

  // 模拟 Client 改文件后 cache delta 推到 server：blob 替换、manifest entry 替换
  const v2 = Buffer.from(JSON.stringify({
    theme: "dark",
    env: {
      ANTHROPIC_API_KEY: `${LEAK_MARKER}-NEW-VALUE`,  // 新的 leak 内容
    },
  }), "utf8");
  cacheStore.setBlob("sha-v2", v2);
  cacheStore.setEntry("claude-home", "settings.json", {
    size: v2.byteLength, mtime: 2, sha256: "sha-v2",
  });

  await (manager as any).tryServeReadFromCache({
    reqId: "r2", op: "read", root: "home-claude", relPath: "settings.json", offset: 0, size: v2.byteLength,
  });

  assert.equal(daemonWrites.length, 2);
  const data2 = Buffer.from(daemonWrites[1].data.data as string, "base64");
  assert.doesNotMatch(
    data2.toString("utf8"),
    new RegExp(LEAK_MARKER),
    "cache 同步更新后再次读取仍然不能泄漏登录态字段",
  );
});

test("出口 #2: 非 settings.json 文件不过滤", async (t) => {
  const harness = await makeHarness(t);
  const { manager, cacheStore, daemonWrites } = harness;

  const original = settingsWithLoginState();
  cacheStore.setBlob("sha-local", original);
  cacheStore.setEntry("claude-home", "settings.local.json", {
    size: original.byteLength, mtime: 1, sha256: "sha-local",
  });

  await (manager as any).tryServeReadFromCache({
    reqId: "r-local", op: "read", root: "home-claude", relPath: "settings.local.json",
    offset: 0, size: original.byteLength,
  });

  const data = Buffer.from(daemonWrites[0].data.data as string, "base64");
  assert.deepEqual(data, original, "settings.local.json 必须 byte-equal 原文");
});

// ============================================================
// 出口 #3: handleSettingsJsonReadPassthrough
// ============================================================

test("出口 #3: cache 没有 entry 时先发 getattr，再发全文 read，回 Python 的 slice 是过滤版", async (t) => {
  const harness = await makeHarness(t);
  const { manager, daemonWrites, clientRequests } = harness;

  const original = settingsWithLoginState();
  const fullSize = original.byteLength;

  // 模拟 Client 响应序列：第一个响应 getattr，第二个响应 read
  const respond = (req: Record<string, unknown>) => {
    const reqId = req.reqId as string;
    if (req.op === "getattr") {
      manager.resolveResponse({
        type: "file_proxy_response",
        reqId,
        sessionId: "test-session",
        stat: {
          mode: 0o644, size: fullSize, mtime: 0, atime: 0, uid: 0, gid: 0, isDir: false,
        },
      });
    } else if (req.op === "read") {
      manager.resolveResponse({
        type: "file_proxy_response",
        reqId,
        sessionId: "test-session",
        data: original.toString("base64"),
      });
    }
  };

  // 拦截 sendToClient：每次发请求后立刻同步触发响应
  const origSend = (manager as any).sendToClient;
  (manager as any).sendToClient = async (msg: Record<string, unknown>) => {
    clientRequests.push(msg);
    queueMicrotask(() => respond(msg));
  };

  await (manager as any).handleSettingsJsonReadPassthrough(
    { reqId: "fuse-req-1", op: "read", root: "home-claude", relPath: "settings.json", offset: 0, size: 4096 },
    "/home/test-user/.claude",
  );

  assert.equal(clientRequests.length, 2, "无 cache entry 时应发 getattr + read 两次 round-trip");
  assert.equal(clientRequests[0].op, "getattr");
  assert.equal(clientRequests[1].op, "read");
  assert.equal((clientRequests[1] as any).offset, 0, "read 必须从 0 偏移拉全文");
  assert.equal((clientRequests[1] as any).size, fullSize, "read 必须用全文 size");

  assert.equal(daemonWrites.length, 1, "必须写一次 daemon");
  const written = daemonWrites[0].data;
  assert.equal(written.reqId, "fuse-req-1");
  const data = Buffer.from(written.data as string, "base64");
  assert.doesNotMatch(data.toString("utf8"), new RegExp(LEAK_MARKER), "登录态字段不能透传到 Python");

  void origSend;
});

test("出口 #3: cache 中有 manifest entry 时跳过 getattr，直接 read", async (t) => {
  const harness = await makeHarness(t);
  const { manager, cacheStore, daemonWrites, clientRequests } = harness;

  const original = settingsWithLoginState();
  const fullSize = original.byteLength;

  // cache 有 manifest entry（但没有 blob，所以会走 #3 而非 #2）
  cacheStore.setEntry("claude-home", "settings.json", {
    size: fullSize, mtime: 1, sha256: null,
  });

  (manager as any).sendToClient = async (msg: Record<string, unknown>) => {
    clientRequests.push(msg);
    queueMicrotask(() => {
      manager.resolveResponse({
        type: "file_proxy_response",
        reqId: msg.reqId as string,
        sessionId: "test-session",
        data: original.toString("base64"),
      });
    });
  };

  await (manager as any).handleSettingsJsonReadPassthrough(
    { reqId: "fuse-req-2", op: "read", root: "home-claude", relPath: "settings.json", offset: 0, size: fullSize },
    "/home/test-user/.claude",
  );

  assert.equal(clientRequests.length, 1, "cache 有 entry 时只发 read，不发 getattr");
  assert.equal(clientRequests[0].op, "read");

  const data = Buffer.from(daemonWrites[0].data.data as string, "base64");
  assert.doesNotMatch(data.toString("utf8"), new RegExp(LEAK_MARKER));
});

test("出口 #3: 非零 offset 切片正确（请求 settings.json 的中段）", async (t) => {
  const harness = await makeHarness(t);
  const { manager, cacheStore, daemonWrites } = harness;

  const original = settingsWithLoginState();
  cacheStore.setEntry("claude-home", "settings.json", {
    size: original.byteLength, mtime: 1, sha256: null,
  });

  (manager as any).sendToClient = async (msg: Record<string, unknown>) => {
    queueMicrotask(() => {
      manager.resolveResponse({
        type: "file_proxy_response",
        reqId: msg.reqId as string,
        sessionId: "test-session",
        data: original.toString("base64"),
      });
    });
  };

  // 请求 offset=10, size=20 中间一段
  await (manager as any).handleSettingsJsonReadPassthrough(
    { reqId: "fuse-mid", op: "read", root: "home-claude", relPath: "settings.json", offset: 10, size: 20 },
    "/home/test-user/.claude",
  );

  const data = Buffer.from(daemonWrites[0].data.data as string, "base64");
  assert.equal(data.byteLength, 20, "切片长度必须等于 size 参数");
  // 该切片不应含登录态 marker
  assert.doesNotMatch(data.toString("utf8"), new RegExp(LEAK_MARKER));
});

test("出口 #3: getattr 失败时回 EIO 不挂", async (t) => {
  const harness = await makeHarness(t);
  const { manager, daemonWrites } = harness;

  (manager as any).sendToClient = async (msg: Record<string, unknown>) => {
    queueMicrotask(() => {
      manager.resolveResponse({
        type: "file_proxy_response",
        reqId: msg.reqId as string,
        sessionId: "test-session",
        error: { code: 2, message: "ENOENT" },
      });
    });
  };

  await (manager as any).handleSettingsJsonReadPassthrough(
    { reqId: "fuse-err", op: "read", root: "home-claude", relPath: "settings.json", offset: 0, size: 4096 },
    "/home/test-user/.claude",
  );

  assert.equal(daemonWrites.length, 1);
  const written = daemonWrites[0].data;
  assert.equal(written.reqId, "fuse-err");
  assert.ok(written.error, "失败时必须回 error 而非挂起");
});

// ============================================================
// 整体不变量：非 settings.json 完全不动
// ============================================================

test("非 settings.json 文件 cache 命中 byte-equal 原文（防止误伤）", async (t) => {
  const harness = await makeHarness(t);
  const { manager, cacheStore, daemonWrites } = harness;

  const original = settingsWithoutLoginState();
  cacheStore.setBlob("plain-sha", original);
  cacheStore.setEntry("claude-home", "settings.json", {
    size: original.byteLength, mtime: 1, sha256: "plain-sha",
  });

  await (manager as any).tryServeReadFromCache({
    reqId: "rq-plain", op: "read", root: "home-claude", relPath: "settings.json",
    offset: 0, size: original.byteLength,
  });

  const data = Buffer.from(daemonWrites[0].data.data as string, "base64");
  assert.deepEqual(
    data, original,
    "无登录态字段的 settings.json 必须 byte-equal 原文（不重新 stringify）",
  );
});

void writeFile; // silence unused import linter if applicable
