import { test } from "node:test";
import assert from "node:assert/strict";
import { AccessLedgerRuntime } from "../src/access-ledger.js";
import { computeSyncPlan } from "../src/sync-plan.js";
import { SEED_WHITELIST } from "../src/seed-whitelist.js";

test("computeSyncPlan 空 ledger 回 SeedWhitelist", () => {
  const ledger = new AccessLedgerRuntime("dev1");
  const plan = computeSyncPlan({ ledger, homedir: "/Users/foo" });
  assert.deepEqual(plan, SEED_WHITELIST);
});

test("computeSyncPlan 非空 ledger 反向构造 plan: home subtree + files", () => {
  const ledger = new AccessLedgerRuntime("dev1");
  ledger.upsertDirPresent("/Users/foo/.claude/skills", 1, true);
  ledger.upsertFilePresent("/Users/foo/.claude/skills/a.md", 2);
  ledger.upsertFilePresent("/Users/foo/.claude/settings.json", 3);
  ledger.upsertMissing("/Users/foo/.claude/plugins/themes", 4);

  const plan = computeSyncPlan({ ledger, homedir: "/Users/foo" });
  const home = plan.scopes["claude-home"];
  assert.ok(home);
  assert.ok(home.subtrees.some((subtree) => subtree.relPath === "skills"));
  assert.ok(home.files.includes("settings.json"));
  assert.ok(home.knownMissing.includes("plugins/themes"));
});

test("computeSyncPlan readdirObserved=false 的 dir 进 subtree maxDepth=0 (一次 readdir 不下钻)", () => {
  const ledger = new AccessLedgerRuntime("dev1");
  // dir 但 readdirObserved=false (例如 CC 仅 getattr 过, 没 readdir)
  ledger.upsertDirPresent("/Users/foo/.claude/projects", 1, false);
  // 也加一个 readdirObserved=true 的对照
  ledger.upsertDirPresent("/Users/foo/.claude/skills", 2, true);

  const plan = computeSyncPlan({ ledger, homedir: "/Users/foo" });
  const home = plan.scopes["claude-home"];
  // readdirObserved=false dir 进 subtree, 但 maxDepth=0 (只 readdir 自己)
  const projectsSubtree = home?.subtrees.find((s) => s.relPath === "projects");
  assert.ok(projectsSubtree, "readdirObserved=false 的 dir 应进 subtrees");
  assert.equal(projectsSubtree?.maxDepth, 0, "maxDepth=0 - 只 readdir 这一级, 不下钻");
  // readdirObserved=true 的 dir 进 subtree maxDepth=-1 (下钻整棵)
  const skillsSubtree = home?.subtrees.find((s) => s.relPath === "skills");
  assert.ok(skillsSubtree);
  assert.equal(skillsSubtree?.maxDepth, -1);
});

test("computeSyncPlan claude-json scope 永远恒定", () => {
  const ledger = new AccessLedgerRuntime("dev1");
  ledger.upsertFilePresent("/Users/foo/.claude.json", 1);
  const plan = computeSyncPlan({ ledger, homedir: "/Users/foo" });
  assert.deepEqual(plan.scopes["claude-json"]?.subtrees, [{ relPath: "", maxDepth: 0 }]);
});

test("computeSyncPlan 中间目录补齐: 叶子 file 的父链 dir 自动加进 files", () => {
  const ledger = new AccessLedgerRuntime("dev1");
  // ledger 只记叶子 file, 没 readdir 父 dir (复现用户日志中 projects/<sid>/conv.jsonl 场景)
  ledger.upsertFilePresent("/Users/foo/.claude/projects/sid-A/conv.jsonl", 1);
  ledger.upsertFilePresent("/Users/foo/.claude/sessions/x.json", 2);
  ledger.upsertFilePresent("/Users/foo/.claude/backups/old.json", 3);

  const plan = computeSyncPlan({ ledger, homedir: "/Users/foo" });
  const home = plan.scopes["claude-home"];
  assert.ok(home);

  // 中间父目录必须被补齐进 files (让 client walk stat 它们)
  assert.ok(home.files.includes("projects"), "projects 父目录应被补齐");
  assert.ok(home.files.includes("projects/sid-A"), "projects/sid-A 应被补齐");
  assert.ok(home.files.includes("sessions"), "sessions 父目录应被补齐");
  assert.ok(home.files.includes("backups"), "backups 父目录应被补齐");
  // 叶子 file 自身仍在
  assert.ok(home.files.includes("projects/sid-A/conv.jsonl"));
});

test("computeSyncPlan 中间目录补齐: 已被 subtree 覆盖的不重复加", () => {
  const ledger = new AccessLedgerRuntime("dev1");
  ledger.upsertDirPresent("/Users/foo/.claude/skills", 1, true);  // skills 是 subtree
  ledger.upsertFilePresent("/Users/foo/.claude/skills/lark/main.md", 2);

  const plan = computeSyncPlan({ ledger, homedir: "/Users/foo" });
  const home = plan.scopes["claude-home"];

  // skills/lark 不应进 files (被 skills subtree 覆盖)
  assert.ok(!home?.files.includes("skills/lark"));
});

test("computeSyncPlan 中间目录补齐: 父链节点不在 missing 时才加", () => {
  const ledger = new AccessLedgerRuntime("dev1");
  ledger.upsertMissing("/Users/foo/.claude/plugins/themes", 1);

  const plan = computeSyncPlan({ ledger, homedir: "/Users/foo" });
  const home = plan.scopes["claude-home"];

  // plugins 是 themes 的父 — 中间补齐加 plugins (它不在 missing)
  assert.ok(home?.files.includes("plugins"));
  // themes 自身在 knownMissing
  assert.ok(home?.knownMissing.includes("plugins/themes"));
});
