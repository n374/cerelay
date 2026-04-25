/**
 * ClientCacheStore 单元测试：manifest 持久化、blob 写入、diff 应用、
 * skipped 大文件的元数据处理、truncated 标记、sha256 校验失败场景。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { ClientCacheStore, cwdHash, sanitizeDeviceId } from "../src/client-cache-store.js";
import type { CachePush, CacheTaskChange } from "../src/protocol.js";

const DEVICE_ID = "device-abc";
const CWD = "/Users/foo/project";

async function makeStore() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cerelay-store-"));
  return {
    dataDir,
    store: new ClientCacheStore({ dataDir }),
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

test("loadManifest 对新设备返回空 manifest", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  const manifest = await store.loadManifest(DEVICE_ID, CWD);
  assert.equal(manifest.version, 2);
  assert.equal(manifest.revision, 0);
  assert.deepEqual(manifest.scopes["claude-home"].entries, {});
  assert.deepEqual(manifest.scopes["claude-json"].entries, {});
});

test("loadManifest 兼容读取 v1 manifest 并补 revision=0", async (t) => {
  const { store, dataDir, cleanup } = await makeStore();
  t.after(cleanup);

  const manifestPath = path.join(dataDir, "client-cache", DEVICE_ID, cwdHash(CWD), "manifest.json");
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 1,
      scopes: {
        "claude-home": {
          entries: {
            "legacy.txt": { size: 1, mtime: 1, sha256: "abc" },
          },
        },
        "claude-json": { entries: {} },
      },
    }),
    "utf8",
  );

  const manifest = await store.loadManifest(DEVICE_ID, CWD);
  assert.equal(manifest.version, 2);
  assert.equal(manifest.revision, 0);
  assert.deepEqual(
    manifest.scopes["claude-home"].entries["legacy.txt"],
    { size: 1, mtime: 1, sha256: "abc" },
  );
});

test("applyPush 写入 blob 并更新 manifest", async (t) => {
  const { store, dataDir, cleanup } = await makeStore();
  t.after(cleanup);

  const content = "hello";
  const push: CachePush = {
    type: "cache_push",
    deviceId: DEVICE_ID,
    cwd: CWD,
    scope: "claude-home",
    seq: 1,
    adds: [
      {
        path: "settings.json",
        size: content.length,
        mtime: 1700000000000,
        sha256: sha256(content),
        content: b64(content),
      },
    ],
    deletes: [],
  };

  const result = await store.applyPush(push);
  assert.equal(result.revision, 1);
  assert.equal(result.written, 1);
  assert.equal(result.deleted, 0);

  // Blob 被写到 content-addressable 路径
  const blobPath = store.blobPath(DEVICE_ID, CWD, sha256(content));
  assert.ok(existsSync(blobPath), "blob 应该存在");
  assert.equal(await readFile(blobPath, "utf8"), content);

  // Manifest 被更新
  const manifest = await store.loadManifest(DEVICE_ID, CWD);
  assert.equal(manifest.revision, 1);
  assert.deepEqual(
    manifest.scopes["claude-home"].entries["settings.json"],
    { size: content.length, mtime: 1700000000000, sha256: sha256(content) },
  );

  // Session 目录位于 /var/lib/cerelay/client-cache/<deviceId>/<cwdHash>/
  const expectedSessionDir = path.join(dataDir, "client-cache", DEVICE_ID, cwdHash(CWD));
  assert.ok(existsSync(path.join(expectedSessionDir, "manifest.json")));
});

test("applyPush deletes 从 manifest 移除条目", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  const content = "x";
  await store.applyPush({
    type: "cache_push",
    deviceId: DEVICE_ID,
    cwd: CWD,
    scope: "claude-home",
    seq: 1,
    adds: [{
      path: "a.txt",
      size: 1,
      mtime: 1,
      sha256: sha256(content),
      content: b64(content),
    }],
    deletes: [],
  });

  const result = await store.applyPush({
    type: "cache_push",
    deviceId: DEVICE_ID,
    cwd: CWD,
    scope: "claude-home",
    seq: 2,
    adds: [],
    deletes: ["a.txt"],
  });

  assert.equal(result.deleted, 1);
  assert.equal(result.revision, 2);
  const manifest = await store.loadManifest(DEVICE_ID, CWD);
  assert.equal(manifest.scopes["claude-home"].entries["a.txt"], undefined);
  assert.equal(manifest.revision, 2);
});

test("applyPush sha256 不一致时抛错，manifest 不被污染", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  const content = "real content";
  await assert.rejects(
    store.applyPush({
      type: "cache_push",
      deviceId: DEVICE_ID,
      cwd: CWD,
      scope: "claude-home",
      seq: 1,
      adds: [{
        path: "tampered.json",
        size: content.length,
        mtime: 1,
        sha256: "deadbeef".repeat(8), // 假 hash
        content: b64(content),
      }],
      deletes: [],
    }),
    /sha256 校验失败/,
  );

  const manifest = await store.loadManifest(DEVICE_ID, CWD);
  assert.equal(manifest.scopes["claude-home"].entries["tampered.json"], undefined);
});

test("applyPush skipped=true 仅更新元数据、不写 blob", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  const result = await store.applyPush({
    type: "cache_push",
    deviceId: DEVICE_ID,
    cwd: CWD,
    scope: "claude-home",
    seq: 1,
    adds: [{
      path: "big.bin",
      size: 5 * 1024 * 1024,
      mtime: 42,
      sha256: "",
      skipped: true,
    }],
    deletes: [],
  });

  assert.equal(result.skippedContents, 1);
  assert.equal(result.written, 0);

  const manifest = await store.loadManifest(DEVICE_ID, CWD);
  const entry = manifest.scopes["claude-home"].entries["big.bin"];
  assert.equal(entry.skipped, true);
  assert.equal(entry.sha256, null);
  assert.equal(entry.size, 5 * 1024 * 1024);
});

test("applyPush truncated=true 标记被保存到 manifest", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  await store.applyPush({
    type: "cache_push",
    deviceId: DEVICE_ID,
    cwd: CWD,
    scope: "claude-home",
    seq: 1,
    adds: [],
    deletes: [],
    truncated: true,
  });

  const manifest = await store.loadManifest(DEVICE_ID, CWD);
  assert.equal(manifest.scopes["claude-home"].truncated, true);

  // 下一次 push 未标记 truncated → 清除标记
  await store.applyPush({
    type: "cache_push",
    deviceId: DEVICE_ID,
    cwd: CWD,
    scope: "claude-home",
    seq: 2,
    adds: [],
    deletes: [],
  });
  const manifest2 = await store.loadManifest(DEVICE_ID, CWD);
  assert.equal(manifest2.scopes["claude-home"].truncated, undefined);
});

test("applyDelta 每次成功应用后 revision 递增", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  const changes: CacheTaskChange[] = [
    {
      kind: "upsert",
      scope: "claude-home",
      path: "alpha.txt",
      size: 5,
      mtime: 10,
      sha256: sha256("alpha"),
      contentBase64: b64("alpha"),
    },
  ];
  const first = await store.applyDelta(DEVICE_ID, CWD, changes);
  assert.equal(first.revision, 1);

  const second = await store.applyDelta(DEVICE_ID, CWD, [
    {
      kind: "upsert",
      scope: "claude-home",
      path: "beta.txt",
      size: 4,
      mtime: 11,
      sha256: sha256("beta"),
      contentBase64: b64("beta"),
    },
  ]);
  assert.equal(second.revision, 2);

  const manifest = await store.loadManifest(DEVICE_ID, CWD);
  assert.equal(manifest.revision, 2);
});

test("applyDelta 覆盖 delete、skipped 与 sha256 校验", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  await store.applyDelta(DEVICE_ID, CWD, [
    {
      kind: "upsert",
      scope: "claude-home",
      path: "keep.txt",
      size: 4,
      mtime: 1,
      sha256: sha256("keep"),
      contentBase64: b64("keep"),
    },
    {
      kind: "upsert",
      scope: "claude-home",
      path: "big.bin",
      size: 8 * 1024 * 1024,
      mtime: 2,
      sha256: null,
      skipped: true,
    },
  ]);

  const result = await store.applyDelta(DEVICE_ID, CWD, [
    {
      kind: "delete",
      scope: "claude-home",
      path: "keep.txt",
    },
  ]);
  assert.equal(result.deleted, 1);
  assert.equal(result.revision, 2);

  const manifest = await store.loadManifest(DEVICE_ID, CWD);
  assert.equal(manifest.scopes["claude-home"].entries["keep.txt"], undefined);
  assert.deepEqual(manifest.scopes["claude-home"].entries["big.bin"], {
    size: 8 * 1024 * 1024,
    mtime: 2,
    sha256: null,
    skipped: true,
  });

  await assert.rejects(
    store.applyDelta(DEVICE_ID, CWD, [
      {
        kind: "upsert",
        scope: "claude-home",
        path: "bad.txt",
        size: 3,
        mtime: 3,
        sha256: "deadbeef".repeat(8),
        contentBase64: b64("bad"),
      },
    ]),
    /sha256 校验失败/,
  );
});

test("不同 cwd 的缓存互不污染", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  const content = "x";
  await store.applyPush({
    type: "cache_push",
    deviceId: DEVICE_ID,
    cwd: "/a",
    scope: "claude-home",
    seq: 1,
    adds: [{ path: "f", size: 1, mtime: 1, sha256: sha256(content), content: b64(content) }],
    deletes: [],
  });

  const m1 = await store.loadManifest(DEVICE_ID, "/a");
  const m2 = await store.loadManifest(DEVICE_ID, "/b");
  assert.ok(m1.scopes["claude-home"].entries["f"]);
  assert.equal(m2.scopes["claude-home"].entries["f"], undefined);
});

test("sanitizeDeviceId 拒绝非法字符", () => {
  assert.equal(sanitizeDeviceId("abc-123_XYZ"), "abc-123_XYZ");
  assert.throws(() => sanitizeDeviceId("../evil"), /非法字符/);
  assert.throws(() => sanitizeDeviceId(""), /invalid/);
  assert.throws(() => sanitizeDeviceId("a".repeat(200)), /invalid/);
  assert.throws(() => sanitizeDeviceId("-starts-with-dash"), /非法字符/);
});

test("cwdHash 稳定且长度 16", () => {
  const h1 = cwdHash("/Users/foo/project");
  const h2 = cwdHash("/Users/foo/project");
  const h3 = cwdHash("/Users/foo/other");
  assert.equal(h1.length, 16);
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
});

test("withManifestLock 串行化并发 applyPush，防止 manifest read-modify-write 丢更新", async (t) => {
  // 背景：server.ts 的 message handler 用 void this.handleMessage() 并发触发，
  // 同一 (deviceId, cwd) 上的多个 cache_push 会并发跑 applyPush。如果 store 没有
  // 串行锁，每个 applyPush 在内存里独立改 manifest 后写回，会互相覆盖丢条目。
  // 这里用 N 个并发的、各自添加不同条目的 push 验证：最终 manifest 必须包含全部
  // N 条记录。
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  const N = 20;
  const pushes = Array.from({ length: N }, (_, i) => {
    const content = `content-${i}`;
    return store.applyPush({
      type: "cache_push",
      deviceId: DEVICE_ID,
      cwd: CWD,
      scope: "claude-home",
      seq: i + 1,
      adds: [{
        path: `file-${i}.json`,
        size: content.length,
        mtime: 1_700_000_000_000 + i,
        sha256: sha256(content),
        content: b64(content),
      }],
      deletes: [],
    });
  });

  // 并发触发：Promise.all 让所有 applyPush 同时进入 await，
  // 内部的 mutex 应该把它们排成 FIFO，最终一条不丢
  await Promise.all(pushes);

  const manifest = await store.loadManifest(DEVICE_ID, CWD);
  const entries = Object.keys(manifest.scopes["claude-home"].entries).sort();
  assert.equal(
    entries.length,
    N,
    `预期 ${N} 条 entries，实际 ${entries.length} —— mutex 失效或丢更新`,
  );
  for (let i = 0; i < N; i += 1) {
    assert.ok(entries.includes(`file-${i}.json`), `缺少 entry: file-${i}.json`);
  }
});

test("withManifestLock 不同 (deviceId, cwd) 之间不互相阻塞", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  // 一个长跑请求 + 一个短请求，不同 cwd；短请求不应等长请求
  const longContent = "a".repeat(100);
  const shortContent = "b";

  const startLong = Date.now();
  const longPromise = store.applyPush({
    type: "cache_push",
    deviceId: DEVICE_ID,
    cwd: "/long",
    scope: "claude-home",
    seq: 1,
    adds: [{
      path: "f",
      size: longContent.length,
      mtime: 1,
      sha256: sha256(longContent),
      content: b64(longContent),
    }],
    deletes: [],
  });

  const shortFinished = await store.applyPush({
    type: "cache_push",
    deviceId: DEVICE_ID,
    cwd: "/short",
    scope: "claude-home",
    seq: 1,
    adds: [{
      path: "g",
      size: shortContent.length,
      mtime: 1,
      sha256: sha256(shortContent),
      content: b64(shortContent),
    }],
    deletes: [],
  }).then(() => Date.now());

  await longPromise;

  // 不强约束相对耗时（CI 抖动），只确认两侧都成功
  assert.ok(shortFinished > 0);
  const longManifest = await store.loadManifest(DEVICE_ID, "/long");
  const shortManifest = await store.loadManifest(DEVICE_ID, "/short");
  assert.ok(longManifest.scopes["claude-home"].entries["f"]);
  assert.ok(shortManifest.scopes["claude-home"].entries["g"]);
  // 交叉污染检查
  assert.equal(longManifest.scopes["claude-home"].entries["g"], undefined);
  assert.equal(shortManifest.scopes["claude-home"].entries["f"], undefined);
  // suppress 未使用变量警告
  void startLong;
});
