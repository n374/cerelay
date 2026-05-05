import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  CONFIG_TEMPLATE,
  DEFAULT_EXCLUDE_DIRS,
  DEFAULT_INCLUDE_DIRS,
  createExcludeMatcher,
  createScanFilter,
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

test("loadConfig 存在 [scan] 但缺少 exclude_dirs 时视为空配置", async (t) => {
  const { dir, cleanup } = await makeTempDir("cerelay-config-");
  t.after(cleanup);
  const configPath = path.join(dir, "config.toml");
  await writeFile(configPath, `[scan]\nother = 1\n`, "utf8");

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

test("loadConfig 把空串和纯斜杠 exclude_dirs 规范化为空，并使 matcher 对任意路径返回 false", async (t) => {
  const { dir, cleanup } = await makeTempDir("cerelay-config-");
  t.after(cleanup);
  const configPath = path.join(dir, "config.toml");
  await writeFile(configPath, `[scan]\nexclude_dirs = ["", "/", "//"]\n`, "utf8");

  const config = await loadConfig({ configPath });
  const exclude = createExcludeMatcher(config.scan.excludeDirs);

  assert.deepEqual(config.scan.excludeDirs, ["", "", ""]);
  assert.equal(exclude("repos"), false);
  assert.equal(exclude("nested/path/file.txt"), false);
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

test("loadConfig 把 trailing slash exclude_dirs 规范化为目录前缀", async (t) => {
  const { dir, cleanup } = await makeTempDir("cerelay-config-");
  t.after(cleanup);
  const configPath = path.join(dir, "config.toml");
  await writeFile(configPath, `[scan]\nexclude_dirs = ["repos/"]\n`, "utf8");

  const config = await loadConfig({ configPath });
  const exclude = createExcludeMatcher(config.scan.excludeDirs);

  assert.deepEqual(config.scan.excludeDirs, ["repos"]);
  assert.equal(exclude("repos"), true);
  assert.equal(exclude("repos/demo/file.txt"), true);
  assert.equal(exclude("reposx/demo/file.txt"), false);
});

// ============================================================
// include_dirs / createScanFilter 新增覆盖
// ============================================================

test("DEFAULT_INCLUDE_DIRS 含 CC 启动期必读的顶级目录与文件，且不含个人目录", () => {
  // 启动期 readdir-observed
  for (const required of [
    "plugins", "projects", "sessions", "backups", "skills", "commands", "agents",
    "session-env", "shell-snapshots", "file-history",
    "settings.json", "CLAUDE.md", ".credentials.json",
  ]) {
    assert.ok(
      DEFAULT_INCLUDE_DIRS.includes(required),
      `DEFAULT_INCLUDE_DIRS 必须包含启动期必访问项 "${required}"`,
    );
  }
  // 用户的 ~/.claude 个人目录不该硬编码进默认列表
  for (const personal of ["source_analyze", "rules", "memory", "plans", "proxy", "repos"]) {
    assert.ok(
      !DEFAULT_INCLUDE_DIRS.includes(personal),
      `DEFAULT_INCLUDE_DIRS 不该硬编码个人目录 "${personal}"`,
    );
  }
});

test("DEFAULT_EXCLUDE_DIRS 默认为空（语义已反转，黑名单留给用户按需补）", () => {
  assert.deepEqual([...DEFAULT_EXCLUDE_DIRS], []);
});

test("loadConfig 旧 toml 缺少 include_dirs 时落空数组，向后兼容（放行所有）", async (t) => {
  const { dir, cleanup } = await makeTempDir("cerelay-config-");
  t.after(cleanup);
  const configPath = path.join(dir, "config.toml");
  await writeFile(configPath, `[scan]\nexclude_dirs = ["legacy"]\n`, "utf8");

  const config = await loadConfig({ configPath });

  assert.deepEqual(config.scan.includeDirs, []);
  assert.deepEqual(config.scan.excludeDirs, ["legacy"]);
});

test("loadConfig include_dirs + exclude_dirs 同时合法时按字面值加载", async (t) => {
  const { dir, cleanup } = await makeTempDir("cerelay-config-");
  t.after(cleanup);
  const configPath = path.join(dir, "config.toml");
  await writeFile(
    configPath,
    `[scan]\ninclude_dirs = ["plugins", "settings.json"]\nexclude_dirs = ["plugins/cache/old"]\n`,
    "utf8",
  );

  const config = await loadConfig({ configPath });

  assert.deepEqual(config.scan.includeDirs, ["plugins", "settings.json"]);
  assert.deepEqual(config.scan.excludeDirs, ["plugins/cache/old"]);
});

test("loadConfig include_dirs 字段类型错误时回退模板默认", async (t) => {
  const { dir, cleanup } = await makeTempDir("cerelay-config-");
  t.after(cleanup);
  const configPath = path.join(dir, "config.toml");
  await writeFile(configPath, `[scan]\ninclude_dirs = "wrong"\n`, "utf8");

  const config = await loadConfig({ configPath });

  assert.deepEqual(config.scan.includeDirs, DEFAULT_INCLUDE_DIRS);
});

test("createScanFilter includeDirs 空数组 = 放行所有（兼容旧 toml）", () => {
  const skip = createScanFilter([], []);
  assert.equal(skip("anything"), false);
  assert.equal(skip("plugins/cache/x.json"), false);
});

test("createScanFilter 顶级 entry 默认放行；子项严格按 include 白名单过滤", () => {
  const skip = createScanFilter(["plugins"], []);

  // 顶级 entry（不含 "/"）一律放行——CC 可能读 ~/.claude/ 顶级任意文件，
  // 列名不可穷举；这跟 exclude_dirs 时代行为一致（旧黑名单只针对 dir 子树，
  // 顶级文件从来都同步）
  assert.equal(skip("plugins"), false);
  assert.equal(skip("memory"), false);          // 顶级 dir 即便不在 include 也通过
  assert.equal(skip("source_analyze"), false);  // （walkDir 进入它后子项都被过滤）
  assert.equal(skip("settings.json"), false);   // 顶级文件
  assert.equal(skip("case-b1-marker.md"), false); // e2e fixture 写到 ~/.claude/ 的任意 marker

  // 子项（含 "/"）走 include 白名单
  assert.equal(skip("plugins/cache/marketplace.json"), false);
  assert.equal(skip("memory/notes.md"), true);
  assert.equal(skip("source_analyze/secret.md"), true);

  // prefix 边界精确（pluginsx/foo 不应误中 plugins）
  assert.equal(skip("pluginsx/foo"), true);
});

test("createScanFilter 嵌套 include：祖先链放行、不在子树下的兄弟跳过", () => {
  // 用户写 include = ["plugins/cache"]，期望 walkDir 能进 plugins → plugins/cache，
  // 但 plugins 下其它兄弟（如 plugins/data）被跳过。
  const skip = createScanFilter(["plugins/cache"], []);

  // 祖先链放行（让 walkDir 递归得进去）
  assert.equal(skip("plugins"), false);

  // 子树内放行
  assert.equal(skip("plugins/cache"), false);
  assert.equal(skip("plugins/cache/openai-codex/codex/1.0.4/agents.md"), false);

  // 不在子树下的兄弟（且不是 include 的祖先）跳过
  assert.equal(skip("plugins/data"), true);
  assert.equal(skip("plugins/data/foo.json"), true);
  assert.equal(skip("plugins/foo.json"), true); // plugins 下的叶子文件，不在 cache 子树
});

test("createScanFilter exclude 在 include 范围内剪枝", () => {
  const skip = createScanFilter(["plugins"], ["plugins/cache/old"]);

  // include 通过的部分
  assert.equal(skip("plugins"), false);
  assert.equal(skip("plugins/cache"), false);
  assert.equal(skip("plugins/cache/openai-codex"), false);

  // exclude 子树跳过
  assert.equal(skip("plugins/cache/old"), true);
  assert.equal(skip("plugins/cache/old/foo.json"), true);

  // exclude 边界精确
  assert.equal(skip("plugins/cache/older"), false); // 不是 plugins/cache/old 的子树
});

test("createScanFilter 单文件 include：CLAUDE.md 出现在子目录时仍被过滤", () => {
  const skip = createScanFilter(["plugins"], []);

  // 子目录里同名 CLAUDE.md（如 ancestor 链场景）：不在 include 子树下 → 跳过
  assert.equal(skip("memory/CLAUDE.md"), true);

  // include 列表里写"CLAUDE.md"对顶级文件没意义（顶级文件本就默认放行），
  // 但写了也不会 break，且仍可作为子项 prefix
  const skip2 = createScanFilter(["plugins/CLAUDE.md"], []);
  assert.equal(skip2("plugins/CLAUDE.md"), false);    // 子项匹配 prefix
  assert.equal(skip2("plugins/other.md"), true);      // 其他子项跳过
});

test("createScanFilter 规范化反斜杠和首尾斜杠（与 createExcludeMatcher 一致）", () => {
  const skip = createScanFilter(["\\plugins\\"], ["\\plugins\\cache\\"]);

  assert.equal(skip("plugins"), false);
  assert.equal(skip("plugins/foo"), false);
  assert.equal(skip("plugins/cache"), true);
  assert.equal(skip("plugins/cache/x"), true);
});
