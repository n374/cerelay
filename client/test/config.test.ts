import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  CONFIG_TEMPLATE,
  DEFAULT_EXCLUDE_DIRS,
  createExcludeMatcher,
  loadConfig,
} from "../src/config.js";

async function makeTempDir(prefix: string) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("loadConfig 文件不存在时创建模板并加载默认排除项", async (t) => {
  const { dir, cleanup } = await makeTempDir("cerelay-config-");
  t.after(cleanup);
  const configPath = path.join(dir, "config.toml");

  const config = await loadConfig({ configPath });

  assert.deepEqual(config.scan.excludeDirs, DEFAULT_EXCLUDE_DIRS);
  assert.equal(await readFile(configPath, "utf8"), CONFIG_TEMPLATE);
});

test("loadConfig 文件存在合法 TOML 时按文件值加载", async (t) => {
  const { dir, cleanup } = await makeTempDir("cerelay-config-");
  t.after(cleanup);
  const configPath = path.join(dir, "config.toml");
  await writeFile(configPath, `[scan]\nexclude_dirs = ["custom", "nested/path"]\n`, "utf8");

  const config = await loadConfig({ configPath });

  assert.deepEqual(config.scan.excludeDirs, ["custom", "nested/path"]);
});

test("loadConfig TOML 语法错误时回退模板默认", async (t) => {
  const { dir, cleanup } = await makeTempDir("cerelay-config-");
  t.after(cleanup);
  const configPath = path.join(dir, "config.toml");
  await writeFile(configPath, `[scan]\nexclude_dirs = ["broken"\n`, "utf8");

  const config = await loadConfig({ configPath });

  assert.deepEqual(config.scan.excludeDirs, DEFAULT_EXCLUDE_DIRS);
});

test("loadConfig 缺少 [scan] 段时视为空配置", async (t) => {
  const { dir, cleanup } = await makeTempDir("cerelay-config-");
  t.after(cleanup);
  const configPath = path.join(dir, "config.toml");
  await writeFile(configPath, `[other]\nvalue = 1\n`, "utf8");

  const config = await loadConfig({ configPath });

  assert.deepEqual(config.scan.excludeDirs, []);
});

test("loadConfig exclude_dirs = [] 时保留用户的空配置", async (t) => {
  const { dir, cleanup } = await makeTempDir("cerelay-config-");
  t.after(cleanup);
  const configPath = path.join(dir, "config.toml");
  await writeFile(configPath, `[scan]\nexclude_dirs = []\n`, "utf8");

  const config = await loadConfig({ configPath });

  assert.deepEqual(config.scan.excludeDirs, []);
});

test("loadConfig exclude_dirs 字段类型错误时回退模板默认", async (t) => {
  const { dir, cleanup } = await makeTempDir("cerelay-config-");
  t.after(cleanup);
  const configPath = path.join(dir, "config.toml");
  await writeFile(configPath, `[scan]\nexclude_dirs = "string"\n`, "utf8");

  const config = await loadConfig({ configPath });

  assert.deepEqual(config.scan.excludeDirs, DEFAULT_EXCLUDE_DIRS);
});

test("loadConfig exclude_dirs 含非字符串元素时回退模板默认", async (t) => {
  const { dir, cleanup } = await makeTempDir("cerelay-config-");
  t.after(cleanup);
  const configPath = path.join(dir, "config.toml");
  await writeFile(configPath, `[scan]\nexclude_dirs = ["ok", 1]\n`, "utf8");

  const config = await loadConfig({ configPath });

  assert.deepEqual(config.scan.excludeDirs, DEFAULT_EXCLUDE_DIRS);
});

test("loadConfig 写入模板失败时只在内存中回退默认配置", async (t) => {
  const { dir, cleanup } = await makeTempDir("cerelay-config-");
  t.after(cleanup);
  const blocked = path.join(dir, "blocked");
  await writeFile(blocked, "file", "utf8");
  const configPath = path.join(blocked, "config.toml");

  const config = await loadConfig({ configPath });

  assert.deepEqual(config.scan.excludeDirs, DEFAULT_EXCLUDE_DIRS);
});

test("createExcludeMatcher 按目录边界精确匹配 POSIX 前缀", () => {
  const exclude = createExcludeMatcher(["repos", "a/b"]);

  assert.equal(exclude("repos"), true);
  assert.equal(exclude("repos/foo"), true);
  assert.equal(exclude("reposx/foo"), false);
  assert.equal(exclude("a/b/c.txt"), true);
  assert.equal(exclude("a/bx/c.txt"), false);
});

test("createExcludeMatcher 空数组永远返回 false", () => {
  const exclude = createExcludeMatcher([]);
  assert.equal(exclude("anything"), false);
});

test("createExcludeMatcher 规范化反斜杠和首尾斜杠", () => {
  const exclude = createExcludeMatcher(["\\nested\\repo\\"]);

  assert.equal(exclude("nested/repo"), true);
  assert.equal(exclude("nested/repo/file.txt"), true);
  assert.equal(exclude("nested/repository"), false);
});
