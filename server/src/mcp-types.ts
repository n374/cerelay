import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface SdkMcpServerConfig {
  type: "sdk";
  name: string;
  instance: McpServer;
}
