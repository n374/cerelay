import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { openScanCache } from "../src/scan-cache.js";

async function makeTempDir(prefix: string) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function cacheFilePath(configDir: string, deviceId: string, cwd: string): string {
  const cwdHash = createHash("sha1").update(cwd).digest("hex").slice(0, 16);
  return path.join(configDir, "scan-cache", `${deviceId}-${cwdHash}.json`);
}

test("openScanCache 文件不存在时返回空 store", async (t) => {
  const { dir, cleanup } = await makeTempDir("cerelay-scan-cache-");
  t.after(cleanup);

  const store = await openScanCache({
    configDir: dir,
    deviceId: "device-1",
    cwd: "/repo",
  });

  assert.equal(store.lookup("claude-home", "settings.json", 1, 1), null);
});

test("openScanCache 文件损坏时按空缓存处理", async (t) => {
  const { dir, cleanup } = await makeTempDir("cerelay-scan-cache-");
  t.after(cleanup);
  const filePath = cacheFilePath(dir, "device-1", "/repo");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "{not json", "utf8");

  const store = await openScanCache({
    configDir: dir,
    deviceId: "device-1",
    cwd: "/repo",
  });

  assert.equal(store.lookup("claude-home", "settings.json", 1, 1), null);
});

test("openScanCache version 不兼容时按空缓存处理", async (t) => {
  const { dir, cleanup } = await makeTempDir("cerelay-scan-cache-");
  t.after(cleanup);
  const filePath = cacheFilePath(dir, "device-1", "/repo");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({ version: 2, scopes: {} }), "utf8");

  const store = await openScanCache({
    configDir: dir,
    deviceId: "device-1",
    cwd: "/repo",
  });

  assert.equal(store.lookup("claude-home", "settings.json", 1, 1), null);
});

test("openScanCache 条目字段错误时按空缓存处理", async (t) => {
  const { dir, cleanup } = await makeTempDir("cerelay-scan-cache-");
  t.after(cleanup);
  const filePath = cacheFilePath(dir, "device-1", "/repo");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({
    version: 1,
    scopes: {
      "claude-home": {
        "settings.json": { size: "1", mtime: 1, sha256: "abc" },
      },
    },
  }), "utf8");

  const store = await openScanCache({
    configDir: dir,
    deviceId: "device-1",
    cwd: "/repo",
  });

  assert.equal(store.lookup("claude-home", "settings.json", 1, 1), null);
});

test("ScanCacheStore lookup 按 size/mtime 判定 hit 或 miss", async (t) => {
  const { dir, cleanup } = await makeTempDir("cerelay-scan-cache-");
  t.after(cleanup);
  const store = await openScanCache({
    configDir: dir,
    deviceId: "device-1",
    cwd: "/repo",
  });

  store.upsert("claude-home", "settings.json", { size: 10, mtime: 20, sha256: "sha-1" });

  assert.equal(store.lookup("claude-home", "settings.json", 10, 20), "sha-1");
  assert.equal(store.lookup("claude-home", "settings.json", 11, 20), null);
  assert.equal(store.lookup("claude-home", "settings.json", 10, 21), null);
});

test("ScanCacheStore pruneToPresent 会删除已不存在的 relPath", async (t) => {
  const { dir, cleanup } = await makeTempDir("cerelay-scan-cache-");
  t.after(cleanup);
  const store = await openScanCache({
    configDir: dir,
    deviceId: "device-1",
    cwd: "/repo",
  });

  store.upsert("claude-home", "keep.json", { size: 1, mtime: 1, sha256: "keep" });
  store.upsert("claude-home", "drop.json", { size: 2, mtime: 2, sha256: "drop" });
  store.pruneToPresent("claude-home", new Set(["keep.json"]));

  assert.equal(store.lookup("claude-home", "keep.json", 1, 1), "keep");
  assert.equal(store.lookup("claude-home", "drop.json", 2, 2), null);
});

test("ScanCacheStore flush 使用 tmp+rename 写入并保留 JSON 内容", async (t) => {
  const { dir, cleanup } = await makeTempDir("cerelay-scan-cache-");
  t.after(cleanup);
  const deviceId = "device-1";
  const cwd = "/repo";
  const filePath = cacheFilePath(dir, deviceId, cwd);
  const store = await openScanCache({
    configDir: dir,
    deviceId,
    cwd,
  });

  store.upsert("claude-home", "settings.json", { size: 10, mtime: 20, sha256: "sha-1" });
  store.upsert("claude-json", "", { size: 30, mtime: 40, sha256: "sha-2" });
  await store.flush();

  const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
    version: number;
    scopes: Record<string, Record<string, { size: number; mtime: number; sha256: string }>>;
  };
  assert.equal(persisted.version, 1);
  assert.deepEqual(persisted.scopes["claude-home"]?.["settings.json"], {
    size: 10,
    mtime: 20,
    sha256: "sha-1",
  });
  assert.deepEqual(persisted.scopes["claude-json"]?.[""], {
    size: 30,
    mtime: 40,
    sha256: "sha-2",
  });

  const siblings = await readDirNames(path.dirname(filePath));
  assert.ok(siblings.every((name) => !name.endsWith(".tmp")));
});

test("openScanCache 遇到 IO 错误时返回 no-op store", async (t) => {
  const { dir, cleanup } = await makeTempDir("cerelay-scan-cache-");
  t.after(cleanup);
  await writeFile(path.join(dir, "scan-cache"), "blocked", "utf8");

  const store = await openScanCache({
    configDir: dir,
    deviceId: "device-1",
    cwd: "/repo",
  });

  store.upsert("claude-home", "settings.json", { size: 1, mtime: 1, sha256: "sha" });
  assert.equal(store.lookup("claude-home", "settings.json", 1, 1), null);
  await assert.doesNotReject(store.flush());
});

test("ScanCacheStore flush 失败时吞掉错误且不影响后续调用", async (t) => {
  const { dir, cleanup } = await makeTempDir("cerelay-scan-cache-");
  t.after(cleanup);
  const store = await openScanCache({
    configDir: dir,
    deviceId: "device-1",
    cwd: "/repo",
  });

  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "scan-cache"), "blocked", "utf8");

  store.upsert("claude-home", "settings.json", { size: 1, mtime: 1, sha256: "sha" });
  await assert.doesNotReject(store.flush());
  await assert.doesNotReject(store.flush());
});

async function readDirNames(dirPath: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return readdir(dirPath);
}
