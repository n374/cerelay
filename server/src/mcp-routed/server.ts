// ============================================================
// cerelay-routed MCP server：低层 SDK 包装
// Low-level wrapper for the cerelay-routed MCP server.
//
// 设计 / Design:
// - 用 SDK 的 Server class + setRequestHandler 注册 tools/list 与 tools/call，
//   schema 直接写 JSON Schema 对象，避免引入 zod 依赖。
// - Phase 1 仅注册一个内置 echo 工具用于端到端 IPC 联调；Phase 2 起把镜像工具
//   接入到 IpcClient 的 callTool 路径上。
// ============================================================

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

export interface RoutedToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: unknown) => Promise<RoutedToolResult>;
}

export interface RoutedToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
  /** SDK 的 CallToolResult 允许 _meta；保留索引签名以兼容 union 推断。 */
  [extra: string]: unknown;
}

export interface CreateRoutedMcpServerOptions {
  serverName: string;
  serverVersion: string;
  tools: RoutedToolDefinition[];
}

export function createRoutedMcpServer(options: CreateRoutedMcpServerOptions): Server {
  const server = new Server(
    {
      name: options.serverName,
      version: options.serverVersion,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  const toolMap = new Map<string, RoutedToolDefinition>();
  for (const tool of options.tools) {
    toolMap.set(tool.name, tool);
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: Array.from(toolMap.values()).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const params = request.params;
    const tool = toolMap.get(params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `unknown tool: ${params.name}` }],
        isError: true,
      };
    }
    try {
      const result = await tool.handler(params.arguments ?? {});
      return result satisfies RoutedToolResult;
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text }],
        isError: true,
      };
    }
  });

  return server;
}

export async function connectStdio(server: Server): Promise<StdioServerTransport> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return transport;
}

