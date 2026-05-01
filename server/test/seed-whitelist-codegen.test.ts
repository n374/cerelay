import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * 验证 scripts/seed-whitelist-codegen.ts 把 capture JSON 转成合法 ts SEED_WHITELIST.
 *
 * 测试逻辑:
 * 1. 写一个 mock capture JSON
 * 2. spawn `node --import tsx scripts/seed-whitelist-codegen.ts <input>` 拿 stdout
 * 3. 断言输出是合法 ts (含 SEED_WHITELIST const + claude-home subtrees/files/knownMissing)
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const CODEGEN = path.join(REPO_ROOT, "scripts/seed-whitelist-codegen.ts");

function runCodegen(captureJson: object, homeDir = "/Users/test"): string {
  const dir = mkdtempSync(path.join(tmpdir(), "codegen-"));
  const inputPath = path.join(dir, "capture.json");
  writeFileSync(inputPath, JSON.stringify(captureJson), "utf8");
  const result = spawnSync("node", ["--import", "tsx", CODEGEN, inputPath], {
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, HOME: homeDir },
  });
  if (result.status !== 0) {
    throw new Error(`codegen failed (status=${result.status}): ${result.stderr}`);
  }
  return result.stdout;
}

test("codegen: readdir 路径 → subtrees, getattr file → files, missing → knownMissing", () => {
  const home = "/Users/test";
  const out = runCodegen({
    events: [
      // readdir → subtree
      { op: "readdir", path: `${home}/.claude/skills`, result: "ok" },
      { op: "readdir", path: `${home}/.claude/agents`, result: "ok" },
      // getattr file → files (不在 readdir 子树下)
      { op: "getattr", path: `${home}/.claude/settings.json`, result: "ok", isDir: false, mtime: 1 },
      // missing → knownMissing
      { op: "getattr", path: `${home}/.claude/plugins/themes`, result: "missing" },
      { op: "getattr", path: `${home}/.claude/output-styles`, result: "missing" },
      // 在 subtree 下的 file → 应被去重 (subtree 已覆盖)
      { op: "getattr", path: `${home}/.claude/skills/lark.md`, result: "ok", isDir: false, mtime: 1 },
    ],
  }, home);

  // 输出含 SEED_WHITELIST 定义
  assert.match(out, /export const SEED_WHITELIST/);
  assert.match(out, /claude-home/);
  assert.match(out, /claude-json/);

  // subtrees 包含 skills 和 agents
  assert.match(out, /relPath: "skills"/);
  assert.match(out, /relPath: "agents"/);

  // files 包含 settings.json 但**不**包含 skills/lark.md (被 subtree 覆盖)
  assert.match(out, /"settings\.json"/);
  assert.ok(!out.includes('"skills/lark.md"'), "应去重 subtree 下的子文件");

  // knownMissing 包含 missing 路径
  assert.match(out, /"plugins\/themes"/);
  assert.match(out, /"output-styles"/);
});

test("codegen: claude-json scope 永远恒定", () => {
  const out = runCodegen({ events: [] });
  assert.match(out, /"claude-json": Object\.freeze\(\{[\s\S]*relPath: ""[\s\S]*maxDepth: 0/);
});

test("codegen: 跨 ~/.claude 边界的事件被忽略", () => {
  const home = "/Users/test";
  const out = runCodegen({
    events: [
      { op: "getattr", path: `/etc/passwd`, result: "ok", isDir: false, mtime: 1 },
      { op: "getattr", path: `${home}/Documents/foo`, result: "ok", isDir: false, mtime: 1 },
      // 唯一应进 fixture 的:
      { op: "readdir", path: `${home}/.claude/skills`, result: "ok" },
    ],
  }, home);

  // /etc/passwd 不应出现
  assert.ok(!out.includes("/etc/passwd"), "跨 root 事件应忽略");
  assert.ok(!out.includes("/Documents/foo"), "跨 root 事件应忽略");
  assert.match(out, /relPath: "skills"/);
});

test("codegen: 输出可以被 ts 解析 (语法合法)", async () => {
  const out = runCodegen({
    events: [
      { op: "readdir", path: "/Users/test/.claude/skills", result: "ok" },
      { op: "getattr", path: "/Users/test/.claude/settings.json", result: "ok", isDir: false, mtime: 1 },
      { op: "getattr", path: "/Users/test/.claude/missing", result: "missing" },
    ],
  });
  // 简单语法检查: 顶层结构正确
  assert.match(out, /^\/\/ 由 scripts/);  // header comment
  assert.match(out, /import type \{ SyncPlan \}/);
  assert.match(out, /export const SEED_WHITELIST/);
  assert.match(out, /} as const\) as SyncPlan;\s*$/);
});
