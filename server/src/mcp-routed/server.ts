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
import type { IpcClient } from "./ipc-client.js";

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

/**
 * 仅用于端到端 IPC 联调的内置 echo tool。
 * 收到 input 后通过 IpcClient 发一个 toolName="__cerelay_echo" 的 tool_call，
 * 主进程侧测试桩可以根据 toolName 直接回 echo。这条工具仅 Phase 1 使用，
 * Phase 2 加完真实 handlers 后会从默认列表移除。
 */
export function buildEchoTool(ipc: IpcClient): RoutedToolDefinition {
  return {
    name: "__cerelay_echo",
    description: "internal IPC smoke-test tool",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string" },
      },
      required: ["message"],
      additionalProperties: false,
    },
    handler: async (rawInput) => {
      const result = await ipc.callTool("__cerelay_echo", rawInput);
      if (result.error) {
        return {
          content: [{ type: "text", text: result.error }],
          isError: true,
        };
      }
      const text = typeof result.output === "string"
        ? result.output
        : JSON.stringify(result.output ?? null);
      return {
        content: [{ type: "text", text }],
        isError: false,
      };
    },
  };
}
