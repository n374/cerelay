import test from "node:test";
import assert from "node:assert/strict";
import { prepareClaudeHookInjection, mergePreToolUseHook } from "../src/claude-hook-injection.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("mergePreToolUseHook prepends Cerelay hook while preserving existing settings", () => {
  const merged = mergePreToolUseHook(
    JSON.stringify({
      permissions: {
        allow: ["Bash"],
      },
      hooks: {
        PreToolUse: [
          {
            matcher: "^Read$",
            hooks: [
              {
                type: "command",
                command: "node existing-hook.mjs",
              },
            ],
          },
        ],
      },
    }),
    '"/usr/local/bin/node" "/opt/cerelay-runtime/session/hooks/cerelay-pretooluse.mjs"'
  );

  assert.deepEqual(merged.permissions, {
    allow: ["Bash"],
  });
  assert.ok(merged.hooks && typeof merged.hooks === "object");
  const hooks = merged.hooks as { PreToolUse?: unknown[] };
  assert.equal(Array.isArray(hooks.PreToolUse), true);
  assert.equal(hooks.PreToolUse?.length, 2);
  assert.deepEqual(hooks.PreToolUse?.[0], {
    matcher: ".*",
    hooks: [
      {
        type: "command",
        command: '"/usr/local/bin/node" "/opt/cerelay-runtime/session/hooks/cerelay-pretooluse.mjs"',
      },
    ],
  });
  assert.deepEqual(hooks.PreToolUse?.[1], {
    matcher: "^Read$",
    hooks: [
      {
        type: "command",
        command: "node existing-hook.mjs",
      },
    ],
  });
});

test("mergePreToolUseHook keeps project agent definitions so sub-agents inherit the same project-level hook config", () => {
  const merged = mergePreToolUseHook(
    JSON.stringify({
      agents: {
        Explore: {
          model: "haiku",
          description: "子 Agent 用于探索目录",
        },
      },
      permissions: {
        allow: ["Task"],
      },
    }),
    "node cerelay-hook.mjs"
  );

  assert.deepEqual(merged.agents, {
    Explore: {
      model: "haiku",
      description: "子 Agent 用于探索目录",
    },
  });
  assert.deepEqual(merged.permissions, {
    allow: ["Task"],
  });
  assert.ok(merged.hooks && typeof merged.hooks === "object");
  const hooks = merged.hooks as { PreToolUse?: unknown[] };
  assert.equal(Array.isArray(hooks.PreToolUse), true);
  assert.equal(hooks.PreToolUse?.length, 1);
  assert.deepEqual(hooks.PreToolUse?.[0], {
    matcher: ".*",
    hooks: [
      {
        type: "command",
        command: "node cerelay-hook.mjs",
      },
    ],
  });
});

test("mergePreToolUseHook tolerates invalid existing JSON", () => {
  const merged = mergePreToolUseHook("not-json", "node hook.mjs");
  assert.deepEqual(merged, {
    mcpServers: {},
    hooks: {
      PreToolUse: [
        {
          matcher: ".*",
          hooks: [
            {
              type: "command",
              command: "node hook.mjs",
            },
          ],
        },
      ],
    },
  });
});

test("prepareClaudeHookInjection writes a project-level settings.local shadow so child agents can inherit the same hook config", async (t) => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "cerelay-hook-injection-"));
  t.after(async () => {
    await rm(runtimeRoot, { recursive: true, force: true });
  });

  const prepared = await prepareClaudeHookInjection({
    bridgeUrl: "http://127.0.0.1:8765/internal/hooks/pretooluse?sessionId=test",
    existingProjectSettingsLocalContent: JSON.stringify({
      agents: {
        Explore: {
          model: "haiku",
        },
      },
    }),
    runtimeRoot,
    sessionId: "sess-hook-test",
    token: "hook-token",
  });

  const settings = JSON.parse(await readFile(prepared.settingsPath, "utf8")) as {
    agents?: unknown;
    hooks?: { PreToolUse?: unknown[] };
  };
  assert.equal(prepared.settingsPath, path.join(runtimeRoot, "settings.local.json"));
  assert.equal(prepared.scriptPath, path.join(runtimeRoot, "hooks", "cerelay-pretooluse.mjs"));
  assert.deepEqual(settings.agents, {
    Explore: {
      model: "haiku",
    },
  });
  assert.equal(Array.isArray(settings.hooks?.PreToolUse), true);
  assert.equal(settings.hooks?.PreToolUse?.length, 1);
});
