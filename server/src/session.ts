import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { isBuiltinHandToolName, isMcpToolName } from "./tool-routing.js";
import type { RemoteToolResult } from "./relay.js";

export const CLAUDE_EXECUTABLE_CANDIDATES = [
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
  path.join(os.homedir(), ".claude/local/claude"),
];

export interface HookInput {
  tool_name: string;
  tool_use_id?: string;
  tool_input: unknown;
}

export type SyncHookJsonOutput = {
  decision?: "approve" | "block";
  reason?: string;
  hookSpecificOutput?: {
    hookEventName: "PreToolUse";
    permissionDecision?: "allow" | "deny" | "ask" | "defer";
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
  };
};

export function renderToolResultForClaude(toolName: string, result: RemoteToolResult): string {
  if (result.error) {
    return result.error;
  }

  const output = result.output;
  if (output === undefined) {
    return result.summary ?? "";
  }

  if (typeof output === "string") {
    return output;
  }

  if (!output || typeof output !== "object") {
    return String(output);
  }

  if (toolName === "Read" && typeof (output as { content?: unknown }).content === "string") {
    return (output as { content: string }).content;
  }

  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") {
    const pathValue = (output as { path?: unknown }).path;
    if (typeof pathValue === "string") {
      return pathValue;
    }
  }

  if (toolName === "Bash") {
    const bash = output as { stdout?: unknown; stderr?: unknown; exit_code?: unknown };
    const parts: string[] = [];
    if (typeof bash.stdout === "string" && bash.stdout.length > 0) {
      parts.push(`stdout:\n${bash.stdout}`);
    }
    if (typeof bash.stderr === "string" && bash.stderr.length > 0) {
      parts.push(`stderr:\n${bash.stderr}`);
    }
    if (typeof bash.exit_code === "number") {
      parts.push(`exit_code: ${bash.exit_code}`);
    }
    return parts.join("\n");
  }

  if (toolName === "Glob" && Array.isArray((output as { files?: unknown }).files)) {
    return ((output as { files: unknown[] }).files)
      .filter((file): file is string => typeof file === "string")
      .join("\n");
  }

  if (toolName === "Grep" && Array.isArray((output as { matches?: unknown }).matches)) {
    return ((output as { matches: unknown[] }).matches)
      .flatMap((match) => {
        if (!match || typeof match !== "object") {
          return [];
        }
        const file = (match as { file?: unknown }).file;
        const line = (match as { line?: unknown }).line;
        const text = (match as { text?: unknown }).text;
        if (typeof file !== "string" || typeof line !== "number" || typeof text !== "string") {
          return [];
        }
        return [`${file}:${line}:${text}`];
      })
      .join("\n");
  }

  return JSON.stringify(output, null, 2);
}

export function isClientRoutedToolName(toolName: string): boolean {
  return isBuiltinHandToolName(toolName) || isMcpToolName(toolName);
}

/** @deprecated Use isClientRoutedToolName */
export function isHandRoutedToolName(toolName: string): boolean {
  return isClientRoutedToolName(toolName);
}

export function resolveClaudeCodeExecutable(candidates = CLAUDE_EXECUTABLE_CANDIDATES, env = process.env): string {
  const configured = env.CLAUDE_CODE_EXECUTABLE?.trim();
  if (configured) {
    return configured;
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `Could not find Claude Code executable. Tried: ${candidates.join(", ")}. Set CLAUDE_CODE_EXECUTABLE env var or install via \`brew install --cask claude-code\`.`
  );
}

export function rewriteToolInputForClient(
  toolName: string,
  input: unknown,
  options: {
    serverHomeDir: string;
    clientHomeDir?: string;
    serverCwd: string;
    clientCwd: string;
  }
): unknown {
  if (!input || typeof input !== "object") {
    return input;
  }

  const inputRecord = { ...(input as Record<string, unknown>) };

  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      if (typeof inputRecord.file_path === "string") {
        inputRecord.file_path = rewriteClaudePathForClient(inputRecord.file_path, options);
      }
      return inputRecord;
    case "Grep":
    case "Glob":
      if (typeof inputRecord.path === "string") {
        inputRecord.path = rewriteClaudePathForClient(inputRecord.path, options);
      }
      return inputRecord;
    case "Bash":
      if (typeof inputRecord.command === "string") {
        inputRecord.command = rewriteClaudeCommandForClient(inputRecord.command, options);
      }
      return inputRecord;
    default:
      return input;
  }
}

/** @deprecated Use rewriteToolInputForClient */
export function rewriteToolInputForHand(
  toolName: string,
  input: unknown,
  options: {
    brainHomeDir: string;
    handHomeDir?: string;
    brainCwd: string;
    handCwd: string;
  }
): unknown {
  return rewriteToolInputForClient(toolName, input, {
    serverHomeDir: options.brainHomeDir,
    clientHomeDir: options.handHomeDir,
    serverCwd: options.brainCwd,
    clientCwd: options.handCwd,
  });
}

function rewriteClaudeCommandForClient(
  command: string,
  options: {
    serverHomeDir: string;
    clientHomeDir?: string;
    serverCwd: string;
    clientCwd: string;
  }
): string {
  let rewritten = command;
  rewritten = rewritten.split(options.serverCwd).join(options.clientCwd);

  if (options.clientHomeDir) {
    rewritten = rewritten.split(path.join(options.serverHomeDir, ".claude.json")).join(path.join(options.clientHomeDir, ".claude.json"));
    rewritten = rewritten.split(path.join(options.serverHomeDir, ".claude")).join(path.join(options.clientHomeDir, ".claude"));
    rewritten = rewritten.split(options.serverHomeDir).join(options.clientHomeDir);
  }

  return rewritten;
}

function rewriteClaudePathForClient(
  filePath: string,
  options: {
    serverHomeDir: string;
    clientHomeDir?: string;
    serverCwd: string;
    clientCwd: string;
  }
): string {
  if (filePath === options.serverCwd || filePath.startsWith(`${options.serverCwd}${path.sep}`)) {
    return `${options.clientCwd}${filePath.slice(options.serverCwd.length)}`;
  }

  if (options.clientHomeDir && (filePath === options.serverHomeDir || filePath.startsWith(`${options.serverHomeDir}${path.sep}`))) {
    return `${options.clientHomeDir}${filePath.slice(options.serverHomeDir.length)}`;
  }

  return filePath;
}
