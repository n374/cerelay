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
// - 错误路径统一：ipc.callTool 抛出异常 与 RemoteToolResult.error 都收敛到
//   `{ content:[{text: errorMessage}], isError:true }`，保持下游处理一致。
// - 空字符串渲染：Plan §4.6 明确"MCP 不需要 Tool response ready 占位，CallToolResult
//   允许 content 长度 0"。我们仍然产出一个 type:text 的 content block（可能 text=""），
//   保持 SDK 序列化稳定但不再人为加占位文本。
// ============================================================

import { renderToolResultForClaude } from "../claude-tool-bridge.js";
import type { IpcClient } from "./ipc-client.js";
import type { RoutedToolDefinition } from "./server.js";
import { SHADOW_TOOLS, type ShadowToolSchema } from "./schemas.js";

export function buildShadowToolHandler(
  schema: ShadowToolSchema,
  ipc: IpcClient,
): RoutedToolDefinition {
  return {
    name: schema.shortName,
    description: schema.description,
    inputSchema: schema.inputSchema,
    handler: async (input) => {
      try {
        const result = await ipc.callTool(schema.builtinName, input);
        const isError = Boolean(result.error);
        const text = renderToolResultForClaude(schema.builtinName, result);
        return {
          content: [{ type: "text", text }],
          isError,
        };
      } catch (err) {
        // ipc.callTool reject（主进程 dispatcher 抛错 / IPC 链路断 / 超时）
        // 跟 RemoteToolResult.error 走同一渲染路径，避免 SDK 通用 catch 把
        // raw stack 暴露给模型。
        const text = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text }],
          isError: true,
        };
      }
    },
  };
}

export function buildAllShadowToolHandlers(ipc: IpcClient): RoutedToolDefinition[] {
  return SHADOW_TOOLS.map((schema) => buildShadowToolHandler(schema, ipc));
}
