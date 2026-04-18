import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

export interface ClaudeHookInjectionOptions {
  bridgeUrl: string;
  sessionId: string;
  token: string;
}

export interface ClaudeHookInjectionWorkspace {
  cwd: string;
  scriptPath: string;
  settingsPath: string;
  cleanup(): Promise<void>;
}

export async function createClaudeHookInjectionWorkspace(
  options: ClaudeHookInjectionOptions
): Promise<ClaudeHookInjectionWorkspace> {
  const root = await mkdtemp(path.join(tmpdir(), `axon-claude-${sanitizeSessionId(options.sessionId)}-`));
  const claudeDir = path.join(root, ".claude");
  const scriptPath = path.join(claudeDir, "axon-pretooluse.mjs");
  const settingsPath = path.join(claudeDir, "settings.local.json");

  await mkdir(claudeDir, { recursive: true });
  await writeFile(scriptPath, renderHookScript(options), "utf8");
  await chmod(scriptPath, 0o755);
  await writeFile(settingsPath, renderSettingsJson(scriptPath), "utf8");

  return {
    cwd: root,
    scriptPath,
    settingsPath,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function renderSettingsJson(scriptPath: string): string {
  const command = `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
  return JSON.stringify(
    {
      hooks: {
        PreToolUse: [
          {
            matcher: ".*",
            hooks: [
              {
                type: "command",
                command,
              },
            ],
          },
        ],
      },
    },
    null,
    2
  );
}

function renderHookScript(options: ClaudeHookInjectionOptions): string {
  const urlLiteral = JSON.stringify(options.bridgeUrl);
  const tokenLiteral = JSON.stringify(options.token);

  return `#!/usr/bin/env node
import process from "node:process";

const BRIDGE_URL = ${urlLiteral};
const HOOK_TOKEN = ${tokenLiteral};

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function block(message) {
  process.stdout.write(JSON.stringify({
    decision: "block",
    reason: message,
  }));
}

try {
  const body = await readStdin();
  const response = await fetch(BRIDGE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-axon-hook-token": HOOK_TOKEN,
    },
    body,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(\`HTTP \${response.status}: \${text || "bridge request failed"}\`);
  }

  process.stdout.write(text || "{}");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  block(\`Axon hook bridge request failed: \${message}\`);
}
`;
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function shellQuote(value: string): string {
  return `"${value.replace(/(["\\\\$`])/g, "\\$1")}"`;
}
