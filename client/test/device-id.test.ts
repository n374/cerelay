import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { getOrCreateDeviceId } from "../src/device-id.js";

async function makeTempConfigDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "cerelay-devid-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("首次调用生成新 deviceId 并持久化", async (t) => {
  const { dir, cleanup } = await makeTempConfigDir();
  t.after(cleanup);

  const id = getOrCreateDeviceId({ configDir: dir });
  assert.match(id, /^[A-Za-z0-9][A-Za-z0-9_-]*$/);
  assert.ok(id.length > 0);

  const persisted = (await readFile(path.join(dir, "device-id"), "utf8")).trim();
  assert.equal(persisted, id);
});

test("后续调用读取已有 deviceId", async (t) => {
  const { dir, cleanup } = await makeTempConfigDir();
  t.after(cleanup);

  const a = getOrCreateDeviceId({ configDir: dir });
  const b = getOrCreateDeviceId({ configDir: dir });
  assert.equal(a, b);
});

test("文件损坏时重新生成", async (t) => {
  const { dir, cleanup } = await makeTempConfigDir();
  t.after(cleanup);

  await writeFile(path.join(dir, "device-id"), "../evil\n", "utf8");
  const id = getOrCreateDeviceId({ configDir: dir });
  assert.notEqual(id, "../evil");
  assert.match(id, /^[A-Za-z0-9][A-Za-z0-9_-]*$/);
});
