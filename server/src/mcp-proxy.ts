import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerCatalogEntry } from "./protocol.js";
import type { RemoteToolResult } from "./relay.js";
import type { SdkMcpServerConfig } from "./mcp-types.js";

export function createMcpProxyServers(
  catalog: Record<string, McpServerCatalogEntry> | undefined,
  executeTool: (toolName: string, input: unknown) => Promise<RemoteToolResult>
): Record<string, SdkMcpServerConfig> | undefined {
  if (!catalog || Object.keys(catalog).length === 0) {
    return undefined;
  }

  const servers: Record<string, SdkMcpServerConfig> = {};
  for (const [serverName, entry] of Object.entries(catalog)) {
    const proxy = new McpServer({
      name: serverName,
      version: "0.1.0",
    });

    proxy.server.registerCapabilities({
      tools: {
        listChanged: true,
      },
    });

    proxy.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: entry.tools,
    }));

    proxy.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const tool = entry.tools.find((candidate) => candidate.name === request.params.name);
      if (!tool) {
        throw new McpError(ErrorCode.InvalidParams, `Tool not found: ${request.params.name}`);
      }

      const result = await executeTool(
        `mcp__${serverName}__${request.params.name}`,
        request.params.arguments ?? {}
      );
      return toCallToolResult(result);
    });

    servers[serverName] = {
      type: "sdk",
      name: serverName,
      instance: proxy,
    };
  }

  return servers;
}

function toCallToolResult(result: RemoteToolResult): CallToolResult {
  if (result.error) {
    return {
      content: [{ type: "text", text: result.error }],
      isError: true,
    };
  }

  if (isCallToolResult(result.output)) {
    return result.output;
  }

  if (typeof result.output === "string") {
    return {
      content: [{ type: "text", text: result.output }],
    };
  }

  if (result.output !== undefined) {
    return {
      content: [{ type: "text", text: JSON.stringify(result.output, null, 2) }],
    };
  }

  return {
    content: result.summary ? [{ type: "text", text: result.summary }] : [],
  };
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return Boolean(
    value
    && typeof value === "object"
    && Array.isArray((value as { content?: unknown }).content)
  );
}
