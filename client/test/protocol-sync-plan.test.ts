import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  CacheTaskAssignment,
  FileProxyResponse,
  ScopeWalkInstruction,
  SyncPlan,
} from "../src/protocol.js";

test("protocol exports sync plan types used by cache assignment", () => {
  const instruction: ScopeWalkInstruction = {
    subtrees: [{ relPath: "skills", maxDepth: -1 }],
    files: ["settings.json"],
    knownMissing: ["missing.json"],
  };
  const syncPlan: SyncPlan = {
    scopes: {
      "claude-home": instruction,
    },
  };
  const assignment: CacheTaskAssignment = {
    type: "cache_task_assignment",
    deviceId: "device-1",
    cwd: "/repo",
    assignmentId: "assignment-1",
    role: "active",
    reason: "elected",
    heartbeatIntervalMs: 1_000,
    heartbeatTimeoutMs: 5_000,
    syncPlan,
  };

  assert.equal(assignment.syncPlan?.scopes["claude-home"]?.files[0], "settings.json");
});

test("file proxy response can carry shallowest missing ancestor", () => {
  const response: FileProxyResponse = {
    type: "file_proxy_response",
    reqId: "req-1",
    sessionId: "session-1",
    error: { code: -2, message: "ENOENT" },
    shallowestMissingAncestor: "/Users/foo/.claude/missing",
  };

  assert.equal(response.shallowestMissingAncestor, "/Users/foo/.claude/missing");
});
