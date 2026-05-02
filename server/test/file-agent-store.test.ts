import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { ClientCacheStore, sanitizeDeviceId } from "../src/file-agent/store.js";
import type { CacheTaskChange } from "../src/protocol.js";

const DEVICE_ID = "device-abc";
const DEVICE_ID_2 = "device-xyz";

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

test("loadManifest 对新设备返回空 v3 manifest", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  const manifest = await store.loadManifest(DEVICE_ID);
  assert.equal(manifest.version, 3);
  assert.equal(manifest.revision, 0);
  assert.deepEqual(manifest.scopes["claude-home"].entries, {});
  assert.deepEqual(manifest.scopes["claude-json"].entries, {});
});

test("loadManifest 遇到老 v1/v2 manifest 直接当空处理（无迁移）", async (t) => {
  const { store, dataDir, cleanup } = await makeStore();
  t.after(cleanup);

  const manifestPath = path.join(dataDir, "client-cache", DEVICE_ID, "manifest.json");
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 2,
      revision: 5,
      scopes: {
        "claude-home": {
          entries: { "legacy.txt": { size: 1, mtime: 1, sha256: "abc" } },
        },
        "claude-json": { entries: {} },
      },
    }),
    "utf8",
  );

  const manifest = await store.loadManifest(DEVICE_ID);
  // 老 manifest 的 entries 不被读取，整体当空处理
  assert.equal(manifest.version, 3);
  assert.equal(manifest.revision, 0);
  assert.deepEqual(manifest.scopes["claude-home"].entries, {});
});

test("applyDelta 写入 blob 并更新 manifest（device-only 路径）", async (t) => {
  const { store, dataDir, cleanup } = await makeStore();
  t.after(cleanup);

  const content = "hello";
  const result = await store.applyDelta(DEVICE_ID, [
    {
      kind: "upsert",
      scope: "claude-home",
      path: "settings.json",
      size: content.length,
      mtime: 1_700_000_000_000,
      sha256: sha256(content),
      contentBase64: b64(content),
    },
  ]);

  assert.equal(result.revision, 1);
  assert.equal(result.written, 1);
  assert.equal(result.deleted, 0);

  const blobPath = store.blobPath(DEVICE_ID, sha256(content));
  assert.ok(existsSync(blobPath), "blob 应该存在");
  assert.equal(await readFile(blobPath, "utf8"), content);

  const manifest = await store.loadManifest(DEVICE_ID);
  assert.equal(manifest.revision, 1);
  assert.deepEqual(
    manifest.scopes["claude-home"].entries["settings.json"],
    { size: content.length, mtime: 1_700_000_000_000, sha256: sha256(content) },
  );

  // device-only：物理路径不再含 cwdHash 子层；deviceDir 直接含 manifest.json + blobs/
  const expectedDeviceDir = path.join(dataDir, "client-cache", DEVICE_ID);
  assert.ok(existsSync(path.join(expectedDeviceDir, "manifest.json")));
  const { readdir } = await import("node:fs/promises");
  const deviceContents = (await readdir(expectedDeviceDir)).sort();
  assert.deepEqual(deviceContents, ["blobs", "manifest.json"]);
});

test("applyDelta 覆盖 delete、skipped 与 sha256 校验", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  await store.applyDelta(DEVICE_ID, [
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
    {
      kind: "upsert",
      scope: "claude-json",
      path: "",
      size: 2,
      mtime: 3,
      sha256: sha256("{}"),
      contentBase64: b64("{}"),
    },
  ]);

  const result = await store.applyDelta(DEVICE_ID, [
    {
      kind: "delete",
      scope: "claude-home",
      path: "keep.txt",
    },
  ]);
  assert.equal(result.deleted, 1);
  assert.equal(result.revision, 2);

  const manifest = await store.loadManifest(DEVICE_ID);
  assert.equal(manifest.scopes["claude-home"].entries["keep.txt"], undefined);
  assert.deepEqual(manifest.scopes["claude-home"].entries["big.bin"], {
    size: 8 * 1024 * 1024,
    mtime: 2,
    sha256: null,
    skipped: true,
  });
  assert.deepEqual(manifest.scopes["claude-json"].entries[""], {
    size: 2,
    mtime: 3,
    sha256: sha256("{}"),
  });

  await assert.rejects(
    store.applyDelta(DEVICE_ID, [
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

test("applyDelta 接受 0 字节文件（contentBase64 为空字符串）", async (t) => {
  // 回归：早期 server 用 if (!change.contentBase64) 判存在，
  // 0 字节文件的 base64 是 ""，会被误判为"缺少 contentBase64"。
  // 典型触发：~/.claude/tasks/<uuid>/.lock。
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  const emptySha = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
  const result = await store.applyDelta(DEVICE_ID, [
    {
      kind: "upsert",
      scope: "claude-home",
      path: "tasks/abc/.lock",
      size: 0,
      mtime: 1_700_000_000_000,
      sha256: emptySha,
      contentBase64: "",
    },
  ]);

  assert.equal(result.written, 1);
  assert.equal(result.deleted, 0);

  const blobPath = store.blobPath(DEVICE_ID, emptySha);
  assert.ok(existsSync(blobPath), "0 字节 blob 应该被写入（且 sha256 等于空 buffer 的 hash）");
  const blob = await readFile(blobPath);
  assert.equal(blob.length, 0);

  const manifest = await store.loadManifest(DEVICE_ID);
  assert.deepEqual(manifest.scopes["claude-home"].entries["tasks/abc/.lock"], {
    size: 0,
    mtime: 1_700_000_000_000,
    sha256: emptySha,
  });
});

test("跨 cwd 数据共享：同 device 的 entries 都进同一 manifest（device-only 核心特征）", async (t) => {
  // 旧版 (deviceId, cwd) 时不同 cwd 的 entries 互不可见；device-only 后所有 cwd 共享一份 manifest。
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  await store.applyDelta(DEVICE_ID, [
    {
      kind: "upsert",
      scope: "claude-home",
      path: "from-session-A.txt",
      size: 1,
      mtime: 1,
      sha256: sha256("a"),
      contentBase64: b64("a"),
    },
  ]);
  await store.applyDelta(DEVICE_ID, [
    {
      kind: "upsert",
      scope: "claude-home",
      path: "from-session-B.txt",
      size: 1,
      mtime: 2,
      sha256: sha256("b"),
      contentBase64: b64("b"),
    },
  ]);

  const manifest = await store.loadManifest(DEVICE_ID);
  assert.ok(manifest.scopes["claude-home"].entries["from-session-A.txt"]);
  assert.ok(manifest.scopes["claude-home"].entries["from-session-B.txt"]);
});

test("不同 device 的 manifest 互相隔离", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  await store.applyDelta(DEVICE_ID, [
    {
      kind: "upsert",
      scope: "claude-home",
      path: "f",
      size: 1,
      mtime: 1,
      sha256: sha256("x"),
      contentBase64: b64("x"),
    },
  ]);

  const m1 = await store.loadManifest(DEVICE_ID);
  const m2 = await store.loadManifest(DEVICE_ID_2);
  assert.ok(m1.scopes["claude-home"].entries.f);
  assert.equal(m2.scopes["claude-home"].entries.f, undefined);
});

test("blob 跨 cwd 内容寻址 dedup（同 sha 只写一份）", async (t) => {
  const { store, dataDir, cleanup } = await makeStore();
  t.after(cleanup);

  const content = "shared-content";
  const sha = sha256(content);

  // Session A
  await store.applyDelta(DEVICE_ID, [
    {
      kind: "upsert",
      scope: "claude-home",
      path: "from-A/file.txt",
      size: content.length,
      mtime: 1,
      sha256: sha,
      contentBase64: b64(content),
    },
  ]);
  // Session B 写同一内容（不同路径）
  await store.applyDelta(DEVICE_ID, [
    {
      kind: "upsert",
      scope: "claude-home",
      path: "from-B/file.txt",
      size: content.length,
      mtime: 2,
      sha256: sha,
      contentBase64: b64(content),
    },
  ]);

  // 物理上只有一份 blob 文件
  const blobsDir = path.join(dataDir, "client-cache", DEVICE_ID, "blobs");
  const { readdir } = await import("node:fs/promises");
  const blobNames = await readdir(blobsDir);
  assert.equal(blobNames.length, 1);
  assert.equal(blobNames[0], sha);
});

test("gcOrphanBlobs 清掉未引用的 blob，保留 manifest 引用的", async (t) => {
  const { store, dataDir, cleanup } = await makeStore();
  t.after(cleanup);

  // 写一个 entry → 产生 blob A
  await store.applyDelta(DEVICE_ID, [
    {
      kind: "upsert",
      scope: "claude-home",
      path: "a.txt",
      size: 1,
      mtime: 1,
      sha256: sha256("a"),
      contentBase64: b64("a"),
    },
  ]);
  // 手动放一个 orphan blob（不在 manifest 里）
  const blobsDir = path.join(dataDir, "client-cache", DEVICE_ID, "blobs");
  await writeFile(path.join(blobsDir, "orphan-deadbeef"), "orphan", "utf8");

  const result = await store.gcOrphanBlobs(DEVICE_ID);
  assert.equal(result.deleted, 1);
  assert.ok(existsSync(path.join(blobsDir, sha256("a"))), "active blob 不应被删");
  assert.ok(!existsSync(path.join(blobsDir, "orphan-deadbeef")), "orphan blob 应被删");
});

test("gcOrphanBlobs 对没有 blobs 目录的 device 不报错", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);
  const result = await store.gcOrphanBlobs("never-used-device");
  assert.equal(result.deleted, 0);
});

test("sanitizeDeviceId 拒绝非法字符", () => {
  assert.equal(sanitizeDeviceId("abc-123_XYZ"), "abc-123_XYZ");
  assert.throws(() => sanitizeDeviceId("../evil"), /非法字符/);
  assert.throws(() => sanitizeDeviceId(""), /invalid/);
  assert.throws(() => sanitizeDeviceId("a".repeat(200)), /invalid/);
  assert.throws(() => sanitizeDeviceId("-starts-with-dash"), /非法字符/);
});

test("withManifestLock 串行化并发 applyDelta，防止 manifest read-modify-write 丢更新", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  const changes = Array.from({ length: 20 }, (_, i) => {
    const content = `content-${i}`;
    return store.applyDelta(DEVICE_ID, [
      {
        kind: "upsert",
        scope: "claude-home",
        path: `file-${i}.json`,
        size: content.length,
        mtime: 1_700_000_000_000 + i,
        sha256: sha256(content),
        contentBase64: b64(content),
      },
    ]);
  });

  await Promise.all(changes);

  const manifest = await store.loadManifest(DEVICE_ID);
  const entries = Object.keys(manifest.scopes["claude-home"].entries).sort();
  assert.equal(entries.length, 20);
  for (let i = 0; i < 20; i += 1) {
    assert.ok(entries.includes(`file-${i}.json`), `缺少 entry: file-${i}.json`);
  }
});

test("withManifestLock 不同 deviceId 之间不互相阻塞", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  const longPromise = store.applyDelta(DEVICE_ID, [
    {
      kind: "upsert",
      scope: "claude-home",
      path: "f",
      size: 100,
      mtime: 1,
      sha256: sha256("a".repeat(100)),
      contentBase64: b64("a".repeat(100)),
    },
  ]);

  const shortFinished = await store.applyDelta(DEVICE_ID_2, [
    {
      kind: "upsert",
      scope: "claude-home",
      path: "g",
      size: 1,
      mtime: 1,
      sha256: sha256("b"),
      contentBase64: b64("b"),
    },
  ]).then(() => Date.now());

  await longPromise;

  assert.ok(shortFinished > 0);
  const m1 = await store.loadManifest(DEVICE_ID);
  const m2 = await store.loadManifest(DEVICE_ID_2);
  assert.ok(m1.scopes["claude-home"].entries.f);
  assert.ok(m2.scopes["claude-home"].entries.g);
  assert.equal(m1.scopes["claude-home"].entries.g, undefined);
  assert.equal(m2.scopes["claude-home"].entries.f, undefined);
});

test("applyDelta 每次成功应用后 revision 递增", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  const first = await store.applyDelta(DEVICE_ID, [
    {
      kind: "upsert",
      scope: "claude-home",
      path: "alpha.txt",
      size: 5,
      mtime: 10,
      sha256: sha256("alpha"),
      contentBase64: b64("alpha"),
    },
  ]);
  assert.equal(first.revision, 1);

  const second = await store.applyDelta(DEVICE_ID, [
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

  const manifest = await store.loadManifest(DEVICE_ID);
  assert.equal(manifest.revision, 2);
});

test("applyDelta 支持空变更批次并递增 revision", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  const result = await store.applyDelta(DEVICE_ID, [] satisfies CacheTaskChange[]);
  assert.equal(result.revision, 1);
  assert.equal(result.written, 0);
  assert.equal(result.deleted, 0);
});
