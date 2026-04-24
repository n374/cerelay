/**
 * ClientCacheStore 单元测试：manifest 持久化、blob 写入、diff 应用、
 * skipped 大文件的元数据处理、truncated 标记、sha256 校验失败场景。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { ClientCacheStore, cwdHash, sanitizeDeviceId } from "../src/client-cache-store.js";
import type { CachePush } from "../src/protocol.js";

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
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.scopes["claude-home"].entries, {});
  assert.deepEqual(manifest.scopes["claude-json"].entries, {});
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
  assert.equal(result.written, 1);
  assert.equal(result.deleted, 0);

  // Blob 被写到 content-addressable 路径
  const blobPath = store.blobPath(DEVICE_ID, CWD, sha256(content));
  assert.ok(existsSync(blobPath), "blob 应该存在");
  assert.equal(await readFile(blobPath, "utf8"), content);

  // Manifest 被更新
  const manifest = await store.loadManifest(DEVICE_ID, CWD);
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
    adds: [],
    deletes: ["a.txt"],
  });

  assert.equal(result.deleted, 1);
  const manifest = await store.loadManifest(DEVICE_ID, CWD);
  assert.equal(manifest.scopes["claude-home"].entries["a.txt"], undefined);
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
    adds: [],
    deletes: [],
  });
  const manifest2 = await store.loadManifest(DEVICE_ID, CWD);
  assert.equal(manifest2.scopes["claude-home"].truncated, undefined);
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
