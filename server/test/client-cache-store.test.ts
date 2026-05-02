import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { ClientCacheStore, sanitizeDeviceId } from "../src/client-cache-store.js";
import type { CacheTaskChange } from "../src/protocol.js";

const DEVICE_ID = "device-abc";

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

test("loadManifest returns empty v3 manifest for a new device", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  const manifest = await store.loadManifest(DEVICE_ID);
  assert.equal(manifest.version, 3);
  assert.equal(manifest.revision, 0);
  assert.deepEqual(manifest.scopes["claude-home"].entries, {});
  assert.deepEqual(manifest.scopes["claude-json"].entries, {});
});

test("old v1/v2 manifest files are treated as empty v3 manifests", async (t) => {
  const { store, dataDir, cleanup } = await makeStore();
  t.after(cleanup);

  const manifestPath = path.join(dataDir, "client-cache", DEVICE_ID, "manifest.json");
  await mkdir(path.dirname(manifestPath), { recursive: true });
  for (const version of [1, 2]) {
    await writeFile(
      manifestPath,
      JSON.stringify({
        version,
        revision: 99,
        scopes: {
          "claude-home": { entries: { "legacy.txt": { size: 1, mtime: 1, sha256: "abc" } } },
          "claude-json": { entries: {} },
        },
      }),
      "utf8",
    );

    const manifest = await store.loadManifest(DEVICE_ID);
    assert.equal(manifest.version, 3);
    assert.equal(manifest.revision, 0);
    assert.deepEqual(manifest.scopes["claude-home"].entries, {});
  }
});

test("applyDelta writes device-level blob and manifest", async (t) => {
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
  assert.ok(existsSync(blobPath), "blob should exist");
  assert.equal(await readFile(blobPath, "utf8"), content);

  const manifest = await store.loadManifest(DEVICE_ID);
  assert.equal(manifest.revision, 1);
  assert.deepEqual(
    manifest.scopes["claude-home"].entries["settings.json"],
    { size: content.length, mtime: 1_700_000_000_000, sha256: sha256(content) },
  );

  assert.ok(existsSync(path.join(dataDir, "client-cache", DEVICE_ID, "manifest.json")));
});

test("applyDelta covers delete, skipped entries, empty blobs, and sha256 validation", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  const emptySha = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
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
    {
      kind: "upsert",
      scope: "claude-home",
      path: "tasks/abc/.lock",
      size: 0,
      mtime: 4,
      sha256: emptySha,
      contentBase64: "",
    },
  ]);

  const result = await store.applyDelta(DEVICE_ID, [
    { kind: "delete", scope: "claude-home", path: "keep.txt" },
  ]);
  assert.equal(result.deleted, 1);
  assert.equal(result.revision, 2);
  assert.ok(existsSync(store.blobPath(DEVICE_ID, emptySha)), "0-byte blob should be written");

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

test("same device writes from multiple cwd-equivalent callers share one manifest and blob pool", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  const content = "shared";
  await store.applyDelta(DEVICE_ID, [
    {
      kind: "upsert",
      scope: "claude-home",
      path: "a.txt",
      size: content.length,
      mtime: 1,
      sha256: sha256(content),
      contentBase64: b64(content),
    },
  ]);
  await store.applyDelta(DEVICE_ID, [
    {
      kind: "upsert",
      scope: "claude-home",
      path: "b.txt",
      size: content.length,
      mtime: 2,
      sha256: sha256(content),
      contentBase64: b64(content),
    },
  ]);

  const manifest = await store.loadManifest(DEVICE_ID);
  assert.ok(manifest.scopes["claude-home"].entries["a.txt"]);
  assert.ok(manifest.scopes["claude-home"].entries["b.txt"]);
  assert.ok(existsSync(store.blobPath(DEVICE_ID, sha256(content))));
});

test("per-device manifest lock serializes concurrent applyDelta calls", async (t) => {
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
    assert.ok(entries.includes(`file-${i}.json`), `missing entry: file-${i}.json`);
  }
});

test("applyDelta increments revision after each successful batch including empty batches", async (t) => {
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

  const second = await store.applyDelta(DEVICE_ID, [] satisfies CacheTaskChange[]);
  assert.equal(second.revision, 2);
  assert.equal(second.written, 0);
  assert.equal(second.deleted, 0);

  const manifest = await store.loadManifest(DEVICE_ID);
  assert.equal(manifest.revision, 2);
});

test("gcOrphanBlobs removes unreferenced blobs and keeps referenced blobs", async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);

  const live = sha256("live");
  const orphan = sha256("orphan");
  await store.applyDelta(DEVICE_ID, [
    {
      kind: "upsert",
      scope: "claude-home",
      path: "live.txt",
      size: 4,
      mtime: 1,
      sha256: live,
      contentBase64: b64("live"),
    },
  ]);
  await mkdir(path.dirname(store.blobPath(DEVICE_ID, orphan)), { recursive: true });
  await writeFile(store.blobPath(DEVICE_ID, orphan), "orphan", "utf8");

  const result = await store.gcOrphanBlobs(DEVICE_ID);
  assert.equal(result.deleted, 1);
  assert.ok(existsSync(store.blobPath(DEVICE_ID, live)));
  assert.equal(existsSync(store.blobPath(DEVICE_ID, orphan)), false);
});

test("sanitizeDeviceId rejects unsafe values", () => {
  assert.equal(sanitizeDeviceId("abc-123_XYZ"), "abc-123_XYZ");
  assert.throws(() => sanitizeDeviceId("../evil"), /非法字符/);
  assert.throws(() => sanitizeDeviceId(""), /invalid/);
  assert.throws(() => sanitizeDeviceId("a".repeat(200)), /invalid/);
  assert.throws(() => sanitizeDeviceId("-starts-with-dash"), /非法字符/);
});
