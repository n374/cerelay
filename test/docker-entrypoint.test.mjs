import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const WORKDIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRYPOINT = path.join(WORKDIR, "docker-entrypoint.sh");

test("docker entrypoint forwards startup flags and preserves Claude executable env", async () => {
  const sandbox = await createSandbox();
  const configJson = JSON.stringify({ apiKeySource: "test" });

  const result = await runEntrypoint(sandbox, {
    PORT: "9999",
    MODEL: "claude-test",
    LOG_LEVEL: "debug",
    LOG_JSON: "true",
    CLAUDE_CODE_EXECUTABLE: "/custom/claude",
    CLAUDE_CONFIG: configJson,
    ANTHROPIC_API_KEY: "test-key",
    ANTHROPIC_AUTH_TOKEN: "auth-token",
    ANTHROPIC_BASE_URL: "https://example.invalid",
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /启动 Axon Brain Server/);
  assert.match(result.stdout, /claude CLI 版本: 9\.9\.9-test/);
  assert.match(
    result.stdout,
    /NODE_ARGS:\/app\/server\/dist\/index\.js --port 9999 --model claude-test --log-level debug --log-json/
  );
  assert.match(result.stdout, /CLAUDE_CODE_EXECUTABLE_ENV:\/custom\/claude/);
  assert.match(result.stdout, /ANTHROPIC_AUTH_TOKEN_ENV:auth-token/);
  assert.match(result.stdout, /ANTHROPIC_BASE_URL_ENV:https:\/\/example\.invalid/);

  const writtenConfig = await readFile(path.join(sandbox.homeDir, ".claude", "claude_config.json"), "utf8");
  assert.equal(writtenConfig, configJson);
});

test("docker entrypoint warns when no API key or auth token is set", async () => {
  const sandbox = await createSandbox();

  const result = await runEntrypoint(sandbox, {
    PORT: "8765",
    MODEL: "claude-sonnet-4",
    LOG_LEVEL: "info",
    LOG_JSON: "false",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
    ANTHROPIC_BASE_URL: "",
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /未检测到 ANTHROPIC_API_KEY \/ ANTHROPIC_AUTH_TOKEN，Claude CLI 可能无法工作/);
  assert.match(
    result.stdout,
    /NODE_ARGS:\/app\/server\/dist\/index\.js --port 8765 --model claude-sonnet-4 --log-level info/
  );
  assert.doesNotMatch(result.stdout, /--log-json/);
});

async function createSandbox() {
  const rootDir = await mkdtemp(path.join(tmpdir(), "axon-entrypoint-"));
  const binDir = path.join(rootDir, "bin");
  const homeDir = path.join(rootDir, "home");

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });

  await writeExecutable(
    path.join(binDir, "claude"),
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '9.9.9-test\\n'
  exit 0
fi
printf 'unexpected claude args: %s\\n' "$*" >&2
exit 1
`
  );

  await writeExecutable(
    path.join(binDir, "node"),
    `#!/bin/sh
printf 'NODE_ARGS:%s\\n' "$*"
printf 'CLAUDE_CODE_EXECUTABLE_ENV:%s\\n' "$CLAUDE_CODE_EXECUTABLE"
printf 'ANTHROPIC_AUTH_TOKEN_ENV:%s\\n' "$ANTHROPIC_AUTH_TOKEN"
printf 'ANTHROPIC_BASE_URL_ENV:%s\\n' "$ANTHROPIC_BASE_URL"
printf 'PORT_ENV:%s\\n' "$PORT"
printf 'MODEL_ENV:%s\\n' "$MODEL"
printf 'LOG_LEVEL_ENV:%s\\n' "$LOG_LEVEL"
printf 'LOG_JSON_ENV:%s\\n' "$LOG_JSON"
exit 0
`
  );

  return { rootDir, binDir, homeDir };
}

async function writeExecutable(filePath, content) {
  await writeFile(filePath, content, { mode: 0o755 });
}

function runEntrypoint(sandbox, overrides) {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", [ENTRYPOINT], {
      cwd: WORKDIR,
      env: {
        ...process.env,
        HOME: sandbox.homeDir,
        PATH: `${sandbox.binDir}:${process.env.PATH ?? ""}`,
        ...overrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}
