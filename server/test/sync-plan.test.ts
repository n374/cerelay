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
