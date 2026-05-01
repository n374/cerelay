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

test("computeSyncPlan 不要把 readdirObserved=false 的 dir 当 subtree", () => {
  const ledger = new AccessLedgerRuntime("dev1");
  ledger.upsertDirPresent("/Users/foo/.claude/skills", 1, false);
  ledger.upsertFilePresent("/Users/foo/.claude/skills/a.md", 2);
  const plan = computeSyncPlan({ ledger, homedir: "/Users/foo" });
  const home = plan.scopes["claude-home"];
  assert.ok(!home?.subtrees.some((subtree) => subtree.relPath === "skills"));
  assert.ok(home?.files.includes("skills/a.md"));
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
