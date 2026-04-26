import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { ToolError } from "../tool-error.js";

export type ExternalToolOutput =
  | string
  | number
  | boolean
  | null
  | Record<string, unknown>
  | Array<unknown>;

export async function executeExternalTool(
  toolName: string,
  input: unknown,
  cwd: string
): Promise<ExternalToolOutput> {
  const script = await resolveToolScript(toolName, cwd);
  const stdout = await runScript(script, toolName, input, cwd);
  if (!stdout.trim()) {
    return null;
  }

  try {
    return JSON.parse(stdout) as ExternalToolOutput;
  } catch {
    return stdout;
  }
}

async function resolveToolScript(toolName: string, cwd: string): Promise<string> {
  const toolDir = process.env.CERELAY_TOOL_PROXY_DIR?.trim()
    || process.env.CERELAY_MCP_PROXY_DIR?.trim()
    || process.env.CLAUDE_PROXY_DIR?.trim()
    || path.resolve(cwd, ".cerelay-tools");

  const exact = path.join(toolDir, `${toolName}.sh`);
  if (await isExecutable(exact)) {
    return exact;
  }

  if (isMcpToolName(toolName)) {
    const serverName = toolName.split("__").slice(0, 2).join("__");
    const wildcard = path.join(toolDir, `${serverName}.sh`);
    if (await isExecutable(wildcard)) {
      return wildcard;
    }
  }

  throw new ToolError("tool_unconfigured", toolName, `未找到 Hand 代理脚本: ${toolName}`);
}

function isMcpToolName(toolName: string): boolean {
  return /^mcp__[A-Za-z0-9_-]+__.+$/.test(toolName);
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await fsPromises.access(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function runScript(
  script: string,
  toolName: string,
  input: unknown,
  cwd: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(script, {
      cwd,
      env: {
        ...process.env,
        CERELAY_TOOL_NAME: toolName,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      reject(new ToolError("tool_execution_failed", toolName, error.message));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      const details = stderr.trim() || stdout.trim() || `exit code ${code ?? "unknown"}`;
      reject(new ToolError("tool_execution_failed", toolName, details));
    });

    child.stdin.end(JSON.stringify({
      tool_name: toolName,
      tool_input: input,
    }));
  });
}
