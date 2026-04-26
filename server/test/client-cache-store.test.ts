import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { ClientCacheStore, cwdHash, sanitizeDeviceId } from "../src/client-cache-store.js";
import type { CacheTaskChange } from "../src/protocol.js";

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
          truncated: true,
        },
        "claude-json": { entries: {} },
      },
    }),
    "utf8",
  );

  const manifest = await store.loadManifest(DEVICE_ID, CWD);
  assert.equal(manifest.version, 2);
  assert.equal(manifest.revision, 0);
  assert.equal(manifest.scopes["claude-home"].truncated, true);
  assert.deepEqual(
    manifest.scopes["claude-home"].entries["legacy.txt"],
    { size: 1, mtime: 1, sha256: "abc" },
  );
});

test("applyDelta 写入 blob 并更新 manifest", async (t) => {
  const { store, dataDir, cleanup } = await makeStore();
  t.after(cleanup);

  const content = "hello";
  const result = await store.applyDelta(DEVICE_ID, CWD, [
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

  const blobPath = store.blobPath(DEVICE_ID, CWD, sha256(content));
  assert.ok(existsSync(blobPath), "blob 应该存在");
  assert.equal(await readFile(blobPath, "utf8"), content);

  const manifest = await store.loadManifest(DEVICE_ID, CWD);
  assert.equal(manifest.revision, 1);
  assert.deepEqual(
    manifest.scopes["claude-home"].entries["settings.json"],
    { size: content.length, mtime: 1_700_000_000_000, sha256: sha256(content) },
  );

  const expectedSessionDir = path.join(dataDir, "client-cache", DEVICE_ID, cwdHash(CWD));
  assert.ok(existsSync(path.join(expectedSessionDir, "manifest.json")));
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
  assert.deepEqual(manifest.scopes["claude-json"].entries[""], {
    size: 2,
    mtime: 3,
    sha256: sha256("{}"),
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

test("applyDelta 接受 0 字节文件（contentBase64 为空字符串）", async (t) => {
  // 回归：早期 server 用 if (!change.contentBase64) 判存在，
  // 0 字节文件的 base64 是 ""，会被误判为"缺少 contentBase64"。
  // 典型触发：~/.claude/tasks/<uuid>/.lock。
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  const emptySha = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
  const result = await store.applyDelta(DEVICE_ID, CWD, [
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

  const blobPath = store.blobPath(DEVICE_ID, CWD, emptySha);
  assert.ok(existsSync(blobPath), "0 字节 blob 应该被写入（且 sha256 等于空 buffer 的 hash）");
  const blob = await readFile(blobPath);
  assert.equal(blob.length, 0);

  const manifest = await store.loadManifest(DEVICE_ID, CWD);
  assert.deepEqual(manifest.scopes["claude-home"].entries["tasks/abc/.lock"], {
    size: 0,
    mtime: 1_700_000_000_000,
    sha256: emptySha,
  });
});

test("不同 cwd 的缓存互不污染", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  await store.applyDelta(DEVICE_ID, "/a", [
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

  const m1 = await store.loadManifest(DEVICE_ID, "/a");
  const m2 = await store.loadManifest(DEVICE_ID, "/b");
  assert.ok(m1.scopes["claude-home"].entries.f);
  assert.equal(m2.scopes["claude-home"].entries.f, undefined);
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

test("withManifestLock 串行化并发 applyDelta，防止 manifest read-modify-write 丢更新", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  const changes = Array.from({ length: 20 }, (_, i) => {
    const content = `content-${i}`;
    return store.applyDelta(DEVICE_ID, CWD, [
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

  const manifest = await store.loadManifest(DEVICE_ID, CWD);
  const entries = Object.keys(manifest.scopes["claude-home"].entries).sort();
  assert.equal(entries.length, 20);
  for (let i = 0; i < 20; i += 1) {
    assert.ok(entries.includes(`file-${i}.json`), `缺少 entry: file-${i}.json`);
  }
});

test("withManifestLock 不同 (deviceId, cwd) 之间不互相阻塞", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  const longPromise = store.applyDelta(DEVICE_ID, "/long", [
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

  const shortFinished = await store.applyDelta(DEVICE_ID, "/short", [
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
  const longManifest = await store.loadManifest(DEVICE_ID, "/long");
  const shortManifest = await store.loadManifest(DEVICE_ID, "/short");
  assert.ok(longManifest.scopes["claude-home"].entries.f);
  assert.ok(shortManifest.scopes["claude-home"].entries.g);
  assert.equal(longManifest.scopes["claude-home"].entries.g, undefined);
  assert.equal(shortManifest.scopes["claude-home"].entries.f, undefined);
});

test("applyDelta 每次成功应用后 revision 递增", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  const first = await store.applyDelta(DEVICE_ID, CWD, [
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

test("applyDelta 支持空变更批次并递增 revision", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  const result = await store.applyDelta(DEVICE_ID, CWD, [] satisfies CacheTaskChange[]);
  assert.equal(result.revision, 1);
  assert.equal(result.written, 0);
  assert.equal(result.deleted, 0);
});
