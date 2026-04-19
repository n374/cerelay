import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createLogger } from "./logger.js";

const log = createLogger("hook-injection");

export interface PrepareClaudeHookInjectionOptions {
  bridgeUrl: string;
  existingProjectSettingsLocalContent?: string;
  runtimeRoot: string;
  sessionId: string;
  token: string;
}

export interface PreparedClaudeHookInjection {
  command: string;
  scriptPath: string;
  settingsPath: string;
}

export async function prepareClaudeHookInjection(
  options: PrepareClaudeHookInjectionOptions
): Promise<PreparedClaudeHookInjection> {
  const hookDir = path.join(options.runtimeRoot, "hooks");
  const scriptPath = path.join(hookDir, "axon-pretooluse.mjs");
  const settingsPath = path.join(options.runtimeRoot, "settings.local.json");
  const command = `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;

  await mkdir(hookDir, { recursive: true });
  await writeFile(scriptPath, renderHookScript(options.bridgeUrl, options.token), "utf8");
  await chmod(scriptPath, 0o755);
  await writeFile(
    settingsPath,
    JSON.stringify(
      mergePreToolUseHook(
        options.existingProjectSettingsLocalContent,
        command
      ),
      null,
      2
    ),
    "utf8"
  );

  log.debug("已生成 Claude hook 注入文件", {
    sessionId: options.sessionId,
    hookDir,
    scriptPath,
    settingsPath,
    hasExistingProjectSettings: Boolean(options.existingProjectSettingsLocalContent),
  });

  return {
    command,
    scriptPath,
    settingsPath,
  };
}

export function mergePreToolUseHook(
  existingContent: string | undefined,
  command: string
): Record<string, unknown> {
  const parsed = parseJsonObject(existingContent);
  const existingHooks = parseJsonObject(parsed.hooks as Record<string, unknown> | string | undefined);
  const existingPreToolUse = Array.isArray(existingHooks.PreToolUse)
    ? [...existingHooks.PreToolUse]
    : [];

  return {
    ...parsed,
    // 容器内不启动 MCP 服务器 — 可执行文件不在容器中，会导致 Claude Code 卡在初始化阶段。
    // 常规 session 的 MCP 工具通过 Brain mcp-proxy 代理；PTY session 通过 PreToolUse hook 转发。
    mcpServers: {},
    hooks: {
      ...existingHooks,
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
        ...existingPreToolUse,
      ],
    },
  };
}

function parseJsonObject(content: string | Record<string, unknown> | undefined | null): Record<string, unknown> {
  if (!content) {
    return {};
  }

  if (typeof content === "object" && !Array.isArray(content)) {
    return { ...content };
  }

  if (typeof content !== "string") {
    return {};
  }

  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }

  return {};
}

function renderHookScript(bridgeUrl: string, token: string): string {
  return `#!/usr/bin/env node
import process from "node:process";

const BRIDGE_URL = ${JSON.stringify(bridgeUrl)};
const HOOK_TOKEN = ${JSON.stringify(token)};

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function printBlock(message) {
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
  printBlock(\`Tool hook bridge failed: \${message}\`);
}
`;
}

function shellQuote(value: string): string {
  return `"${value.replace(/(["\\\\$`])/g, "\\$1")}"`;
}
