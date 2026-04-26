// ============================================================
// cerelay shadow tools 的 handler 工厂
// Handler factory for cerelay shadow MCP tools.
//
// 设计 / Design:
// - 7 个工具高度同构，只在 builtinName 上不同；用一个 buildHandler 模板生成。
// - handler 不做路径重写——主进程的 dispatcher 持有 cwd/home 上下文，更适合做
//   rewriteToolInputForClient。子进程只把 builtinName + 原始 input forward 过去。
// - 渲染（renderToolResultForClaude）在子进程做：dispatcher 通过 IPC 返回的是
//   原始 RemoteToolResult，handler 渲染成 string 后包装成 CallToolResult。
// - 空字符串渲染：MCP 协议允许 content[] 长度任意，但模型在某些情况下处理空
//   text block 不稳定；这里同 PreToolUse hook 路径不一样，无需 "Tool response
//   ready" 占位——空时直接给 "(empty)" 标记，保留 isError:false 语义。
// ============================================================

import { renderToolResultForClaude } from "../claude-tool-bridge.js";
import type { IpcClient } from "./ipc-client.js";
import type { RoutedToolDefinition } from "./server.js";
import { SHADOW_TOOLS, type ShadowToolSchema } from "./schemas.js";

const EMPTY_TEXT_PLACEHOLDER = "(empty)";

export function buildShadowToolHandler(
  schema: ShadowToolSchema,
  ipc: IpcClient,
): RoutedToolDefinition {
  return {
    name: schema.shortName,
    description: schema.description,
    inputSchema: schema.inputSchema,
    handler: async (input) => {
      const result = await ipc.callTool(schema.builtinName, input);
      const isError = Boolean(result.error);
      const rendered = renderToolResultForClaude(schema.builtinName, result);
      const text = rendered.length > 0 ? rendered : EMPTY_TEXT_PLACEHOLDER;
      return {
        content: [{ type: "text", text }],
        isError,
      };
    },
  };
}

export function buildAllShadowToolHandlers(ipc: IpcClient): RoutedToolDefinition[] {
  return SHADOW_TOOLS.map((schema) => buildShadowToolHandler(schema, ipc));
}
