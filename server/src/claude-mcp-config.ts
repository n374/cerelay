import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { McpServerConfig } from "./protocol.js";
import { createLogger } from "./logger.js";

const log = createLogger("claude-mcp-config");

interface SettingsFileShape {
  mcpServers?: Record<string, unknown>;
}

export interface LoadClaudeMcpConfigOptions {
  cwd?: string;
}

export async function loadClaudeMcpServerConfigs(
  options: LoadClaudeMcpConfigOptions = {}
): Promise<Record<string, McpServerConfig>> {
  const homeDir = process.env.HOME?.trim() || os.homedir();
  const candidates = [
    path.join(homeDir, ".claude", "settings.json"),
    path.join(homeDir, ".claude.json"),
    options.cwd ? path.join(options.cwd, ".claude", "settings.local.json") : null,
  ].filter((value): value is string => Boolean(value));

  const merged: Record<string, McpServerConfig> = {};
  for (const filePath of candidates) {
    const loaded = await loadFromFile(filePath);
    Object.assign(merged, loaded);
  }

  log.debug("已解析 Claude MCP 配置", {
    cwd: options.cwd,
    homeDir,
    serverCount: Object.keys(merged).length,
    servers: Object.keys(merged),
  });
  return merged;
}

async function loadFromFile(filePath: string): Promise<Record<string, McpServerConfig>> {
  if (!existsSync(filePath)) {
    return {};
  }

  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as SettingsFileShape;
    const servers = parsed.mcpServers;
    if (!servers || typeof servers !== "object") {
      return {};
    }

    const normalized: Record<string, McpServerConfig> = {};
    for (const [serverName, config] of Object.entries(servers)) {
      const candidate = normalizeMcpServerConfig(config);
      if (!candidate) {
        log.warn("忽略不支持的 MCP server 配置", {
          filePath,
          serverName,
        });
        continue;
      }
      normalized[serverName] = candidate;
    }
    return normalized;
  } catch (error) {
    log.warn("读取 Claude MCP 配置失败，已忽略该文件", {
      filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

function normalizeMcpServerConfig(value: unknown): McpServerConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const type = candidate.type;

  if (type === "sse" || type === "http") {
    const headers = normalizeStringRecord(candidate.headers);
    if (typeof candidate.url !== "string") {
      return null;
    }
    return {
      type,
      url: candidate.url,
      ...(headers ? { headers } : {}),
    };
  }

  if (type === undefined || type === "stdio") {
    const args = normalizeStringArray(candidate.args);
    const env = normalizeStringRecord(candidate.env);
    if (typeof candidate.command !== "string") {
      return null;
    }
    return {
      type: "stdio",
      command: candidate.command,
      ...(args ? { args } : {}),
      ...(env ? { env } : {}),
    };
  }

  return null;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter((entry): entry is string => typeof entry === "string");
  return items.length > 0 ? items : undefined;
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const normalized: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      normalized[key] = entry;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}
