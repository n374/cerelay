import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolError } from "../tool-error.js";
import { createLogger } from "../logger.js";
import type { McpServerCatalogEntry, McpServerConfig, McpToolDescriptor } from "../protocol.js";

const log = createLogger("hand-mcp");

interface ClientHandle {
  client: Client;
  transport: Transport;
}

export class McpRuntime {
  private readonly cwd: string;
  private readonly serverConfigs: Record<string, McpServerConfig>;
  private readonly clients = new Map<string, Promise<ClientHandle>>();

  constructor(cwd: string, serverConfigs?: Record<string, McpServerConfig>) {
    this.cwd = cwd;
    this.serverConfigs = serverConfigs ?? {};
  }

  async describeServers(): Promise<Record<string, McpServerCatalogEntry>> {
    const configs = await this.loadConfigs();
    const entries = Object.entries(configs);
    log.debug("开始收集 MCP server 描述", {
      cwd: this.cwd,
      serverCount: entries.length,
      servers: entries.map(([serverName]) => serverName),
    });
    if (entries.length === 0) {
      return {};
    }

    const catalog: Record<string, McpServerCatalogEntry> = {};
    for (const [serverName] of entries) {
      try {
        const client = await this.getClient(serverName);
        const tools = await client.listTools();
        log.debug("MCP server tools/list 成功", {
          cwd: this.cwd,
          serverName,
          toolCount: tools.tools.length,
          tools: tools.tools.map((tool) => tool.name),
        });
        catalog[serverName] = {
          tools: tools.tools.map(normalizeToolDescriptor),
        };
      } catch (error) {
        log.warn("MCP server tools/list 失败，已跳过", {
          cwd: this.cwd,
          serverName,
          error: formatErrorForLog(error),
        });
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
      log.debug("转发 MCP tools/call", {
        cwd: this.cwd,
        serverName: parsed.serverName,
        toolName: parsed.toolName,
        inputSummary: summarizeUnknown(input),
      });
      const result = await client.callTool({
        name: parsed.toolName,
        arguments: toToolArguments(input),
      }, CallToolResultSchema) as unknown;
      if (isCallToolResult(result)) {
        log.debug("MCP tools/call 成功", {
          cwd: this.cwd,
          serverName: parsed.serverName,
          toolName: parsed.toolName,
          contentCount: result.content.length,
          isError: Boolean(result.isError),
        });
        return result;
      }

      log.debug("MCP tools/call 返回兼容结果", {
        cwd: this.cwd,
        serverName: parsed.serverName,
        toolName: parsed.toolName,
        resultSummary: summarizeUnknown((result as { toolResult?: unknown }).toolResult),
      });
      return {
        content: [{ type: "text", text: JSON.stringify((result as { toolResult?: unknown }).toolResult, null, 2) }],
      };
    } catch (error) {
      log.warn("MCP tools/call 失败", {
        cwd: this.cwd,
        serverName: parsed.serverName,
        toolName: parsed.toolName,
        inputSummary: summarizeUnknown(input),
        error: formatErrorForLog(error),
      });
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
    log.debug("连接 MCP server", {
      cwd: this.cwd,
      serverName,
      configType: config.type ?? "stdio",
      configSummary: summarizeConfig(config),
    });
    await client.connect(transport);
    log.debug("MCP server 连接成功", {
      cwd: this.cwd,
      serverName,
      configType: config.type ?? "stdio",
    });
    return { client, transport };
  }

  private async loadConfigs(): Promise<Record<string, McpServerConfig>> {
    return resolveServerConfigs(this.serverConfigs);
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

function resolveServerConfigs(entries: Record<string, McpServerConfig>): Record<string, McpServerConfig> {
  const resolved: Record<string, McpServerConfig> = {};
  for (const [serverName, config] of Object.entries(entries)) {
    resolved[serverName] = resolveConfigInterpolation(config);
  }
  log.debug("已加载 Brain 下发的 MCP 配置", {
    serverCount: Object.keys(resolved).length,
    servers: Object.keys(resolved),
  });
  return resolved;
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
    throw new Error(`MCP 配置中引用的环境变量未设置: ${name}`);
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

function summarizeConfig(config: McpServerConfig): string {
  if (config.type === "sse" || config.type === "http") {
    return `${config.type}:${config.url}`;
  }
  return `stdio:${config.command} ${(config.args ?? []).join(" ")}`.trim();
}

function summarizeUnknown(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }

  if (typeof value === "string") {
    return previewText(value, 120);
  }

  try {
    return previewText(JSON.stringify(value), 120);
  } catch {
    return String(value);
  }
}

function previewText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
}

function formatErrorForLog(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}
