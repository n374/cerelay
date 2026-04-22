import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const CLAUDE_EXECUTABLE_CANDIDATES = [
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
  path.join(os.homedir(), ".claude/local/claude"),
];

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
