import path from "node:path";
import process from "node:process";
import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolError } from "../tool-error.js";
import type { McpServerCatalogEntry, McpToolDescriptor } from "../protocol.js";

type StdioMcpServerConfig = {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

type SseMcpServerConfig = {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
};

type HttpMcpServerConfig = {
  type: "http";
  url: string;
  headers?: Record<string, string>;
};

type McpServerConfig = StdioMcpServerConfig | SseMcpServerConfig | HttpMcpServerConfig;

type McpConfigFile = {
  mcpServers?: Record<string, McpServerConfig>;
};

interface ClientHandle {
  client: Client;
  transport: Transport;
}

export class McpRuntime {
  private readonly cwd: string;
  private configPromise: Promise<Record<string, McpServerConfig>> | null = null;
  private readonly clients = new Map<string, Promise<ClientHandle>>();

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  async describeServers(): Promise<Record<string, McpServerCatalogEntry>> {
    const configs = await this.loadConfigs();
    const entries = Object.entries(configs);
    if (entries.length === 0) {
      return {};
    }

    const catalog: Record<string, McpServerCatalogEntry> = {};
    for (const [serverName] of entries) {
      try {
        const client = await this.getClient(serverName);
        const tools = await client.listTools();
        catalog[serverName] = {
          tools: tools.tools.map(normalizeToolDescriptor),
        };
      } catch {
        // 跳过当前不可用的 MCP server；真实执行时仍会在 callTool 路径上报错。
      }
    }

    return catalog;
  }

  async callTool(toolName: string, input: unknown): Promise<CallToolResult> {
    const parsed = parseMcpToolName(toolName);
    if (!parsed) {
      throw new ToolError("tool_unconfigured", toolName, `不是有效的 MCP 工具名: ${toolName}`);
    }

    const client = await this.getClient(parsed.serverName);
    try {
      const result = await client.callTool({
        name: parsed.toolName,
        arguments: toToolArguments(input),
      }, CallToolResultSchema) as unknown;
      if (isCallToolResult(result)) {
        return result;
      }

      return {
        content: [{ type: "text", text: JSON.stringify((result as { toolResult?: unknown }).toolResult, null, 2) }],
      };
    } catch (error) {
      throw new ToolError(
        "tool_execution_failed",
        toolName,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  async close(): Promise<void> {
    const handles = await Promise.allSettled(Array.from(this.clients.values()));
    this.clients.clear();
    this.configPromise = null;

    await Promise.all(
      handles
        .filter((entry): entry is PromiseFulfilledResult<ClientHandle> => entry.status === "fulfilled")
        .map(async ({ value }) => {
          await value.client.close().catch(() => undefined);
          await value.transport.close?.().catch(() => undefined);
        })
    );
  }

  private async getClient(serverName: string): Promise<Client> {
    const pending = this.clients.get(serverName);
    if (pending) {
      return (await pending).client;
    }

    const next = this.createClient(serverName);
    this.clients.set(serverName, next);

    try {
      return (await next).client;
    } catch (error) {
      this.clients.delete(serverName);
      throw error;
    }
  }

  private async createClient(serverName: string): Promise<ClientHandle> {
    const configs = await this.loadConfigs();
    const config = configs[serverName];
    if (!config) {
      throw new ToolError("tool_unconfigured", serverName, `未找到 MCP server 配置: ${serverName}`);
    }

    const client = new Client({
      name: "axon-hand",
      version: "0.1.0",
    });
    const transport = createTransport(config, this.cwd);
    await client.connect(transport);
    return { client, transport };
  }

  private async loadConfigs(): Promise<Record<string, McpServerConfig>> {
    if (!this.configPromise) {
      this.configPromise = loadMcpConfigs(this.cwd);
    }
    return this.configPromise;
  }
}

function parseMcpToolName(toolName: string): { serverName: string; toolName: string } | null {
  const match = /^mcp__([A-Za-z0-9_-]+)__(.+)$/.exec(toolName);
  if (!match) {
    return null;
  }

  return {
    serverName: match[1],
    toolName: match[2],
  };
}

function toToolArguments(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  return input as Record<string, unknown>;
}

function normalizeToolDescriptor(tool: {
  name: string;
  title?: string;
  description?: string;
  inputSchema: McpToolDescriptor["inputSchema"];
  outputSchema?: McpToolDescriptor["outputSchema"];
  annotations?: McpToolDescriptor["annotations"];
  _meta?: Record<string, unknown>;
}): McpToolDescriptor {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
    _meta: tool._meta,
  };
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return Boolean(
    value
    && typeof value === "object"
    && Array.isArray((value as { content?: unknown }).content)
  );
}

async function loadMcpConfigs(cwd: string): Promise<Record<string, McpServerConfig>> {
  const configPath = await resolveMcpConfigPath(cwd);
  if (!configPath) {
    return {};
  }

  const raw = await readFile(configPath, "utf8");
  let parsed: McpConfigFile;
  try {
    parsed = JSON.parse(raw) as McpConfigFile;
  } catch (error) {
    throw new Error(`解析 .mcp.json 失败: ${error instanceof Error ? error.message : String(error)}`);
  }

  const entries = parsed.mcpServers;
  if (!entries || typeof entries !== "object") {
    return {};
  }

  const resolved: Record<string, McpServerConfig> = {};
  for (const [serverName, config] of Object.entries(entries)) {
    resolved[serverName] = resolveConfigInterpolation(config);
  }
  return resolved;
}

async function resolveMcpConfigPath(cwd: string): Promise<string | null> {
  const configured = process.env.AXON_MCP_CONFIG_PATH?.trim();
  if (configured) {
    return configured;
  }

  let current = path.resolve(cwd);
  while (true) {
    const candidate = path.join(current, ".mcp.json");
    if (await fileExists(candidate)) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveConfigInterpolation(config: McpServerConfig): McpServerConfig {
  if (config.type === "sse") {
    return {
      type: "sse",
      url: expandTemplate(config.url),
      headers: expandStringRecord(config.headers),
    };
  }

  if (config.type === "http") {
    return {
      type: "http",
      url: expandTemplate(config.url),
      headers: expandStringRecord(config.headers),
    };
  }

  return {
    type: "stdio",
    command: expandTemplate(config.command),
    args: config.args?.map((value) => expandTemplate(value)),
    env: expandStringRecord(config.env),
  };
}

function expandStringRecord(input: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!input) {
    return undefined;
  }

  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    output[key] = expandTemplate(value);
  }
  return output;
}

function expandTemplate(value: string): string {
  return value.replace(/\$\{([A-Za-z0-9_]+)(:-([^}]*))?\}/g, (_match, name: string, _defaultExpr: string, defaultValue: string | undefined) => {
    const envValue = process.env[name];
    if (envValue !== undefined && envValue !== "") {
      return envValue;
    }
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`.mcp.json 中引用的环境变量未设置: ${name}`);
  });
}

function createTransport(config: McpServerConfig, cwd: string): Transport {
  if (config.type === "sse") {
    return new SSEClientTransport(new URL(config.url), {
      requestInit: {
        headers: config.headers,
      },
    });
  }

  if (config.type === "http") {
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: {
        headers: config.headers,
      },
    });
  }

  return new StdioClientTransport({
    command: config.command,
    args: config.args,
    cwd,
    env: {
      ...collectStringEnv(process.env),
      ...(config.env ?? {}),
    },
    stderr: "pipe",
  });
}

function collectStringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const collected: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      collected[key] = value;
    }
  }
  return collected;
}
