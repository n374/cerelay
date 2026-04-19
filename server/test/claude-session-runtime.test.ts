import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClaudeSessionRuntime, getClaudeSessionRuntimeRoot } from "../src/claude-session-runtime.js";

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

test("createClaudeSessionRuntime preserves pre-created runtime files such as injected hook settings", async (t) => {
  const originalMountNamespace = process.env.AXON_ENABLE_MOUNT_NAMESPACE;
  process.env.AXON_ENABLE_MOUNT_NAMESPACE = "false";
  t.after(() => {
    restoreEnvVar("AXON_ENABLE_MOUNT_NAMESPACE", originalMountNamespace);
  });

  const sessionId = `runtime-preserve-${Date.now()}`;
  const runtimeRoot = getClaudeSessionRuntimeRoot(sessionId);
  await rm(runtimeRoot, { recursive: true, force: true });
  await mkdir(path.join(runtimeRoot, "hooks"), { recursive: true });
  await writeFile(path.join(runtimeRoot, "settings.local.json"), '{"hooks":{"PreToolUse":[]}}', "utf8");
  await writeFile(path.join(runtimeRoot, "hooks", "axon-pretooluse.mjs"), "console.log('ok')\n", "utf8");

  const runtime = await createClaudeSessionRuntime({
    sessionId,
    cwd: "/tmp",
  });

  t.after(async () => {
    await runtime.cleanup().catch(() => undefined);
  });

  assert.equal(runtime.rootDir, runtimeRoot);
  assert.equal(
    await readFile(path.join(runtimeRoot, "settings.local.json"), "utf8"),
    '{"hooks":{"PreToolUse":[]}}'
  );
  assert.equal(
    await readFile(path.join(runtimeRoot, "hooks", "axon-pretooluse.mjs"), "utf8"),
    "console.log('ok')\n"
  );
});
