export type BuiltinHandToolName =
  | "Read"
  | "Write"
  | "Edit"
  | "MultiEdit"
  | "Bash"
  | "Grep"
  | "Glob";

/**
 * cerelay 自己的 shadow MCP server (mcp-routed) 注册的工具命名前缀。
 * 这些工具由 cerelay 主进程通过 IPC 直接 dispatch，不走 PreToolUse hook
 * → client-routed 路径，否则会跟 stdio MCP 路径双重执行。
 */
export const CERELAY_SHADOW_MCP_PREFIX = "mcp__cerelay__";

export function isCerelayShadowMcpTool(toolName: string): boolean {
  return toolName.startsWith(CERELAY_SHADOW_MCP_PREFIX);
}

export interface ToolRoutingConfig {
  builtinToolNames: string[];
  handToolNames: string[];
  handToolPrefixes: string[];
}

export interface ToolRoutingUpdate {
  handToolNames?: string[];
  handToolPrefixes?: string[];
}

const BUILTIN_HAND_TOOL_NAMES = new Set<BuiltinHandToolName>([
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Bash",
  "Grep",
  "Glob",
]);

const DEFAULT_CONFIG = {
  handToolNames: ["WebFetch"],
  handToolPrefixes: ["mcp__"],
};

export class ToolRoutingStore {
  private config = {
    handToolNames: [...DEFAULT_CONFIG.handToolNames],
    handToolPrefixes: [...DEFAULT_CONFIG.handToolPrefixes],
  };

  snapshot(): ToolRoutingConfig {
    return {
      builtinToolNames: Array.from(BUILTIN_HAND_TOOL_NAMES),
      handToolNames: [...this.config.handToolNames],
      handToolPrefixes: [...this.config.handToolPrefixes],
    };
  }

  update(next: ToolRoutingUpdate): ToolRoutingConfig {
    if (next.handToolNames !== undefined) {
      this.config.handToolNames = normalizeNames(next.handToolNames);
    }

    if (next.handToolPrefixes !== undefined) {
      this.config.handToolPrefixes = normalizeNames(next.handToolPrefixes);
    }

    return this.snapshot();
  }

  shouldRouteToHand(toolName: string): boolean {
    // cerelay 自己的 shadow MCP 工具走 stdio MCP 路径，不能再回 client-routed
    // 链路（否则双重执行）。这条排除必须在 builtin / prefix 检查之前。
    if (isCerelayShadowMcpTool(toolName)) {
      return false;
    }
    return isBuiltinHandToolName(toolName)
      || this.config.handToolNames.includes(toolName)
      || this.config.handToolPrefixes.some((prefix) => toolName.startsWith(prefix));
  }
}

export function isBuiltinHandToolName(toolName: string): boolean {
  return BUILTIN_HAND_TOOL_NAMES.has(toolName as BuiltinHandToolName);
}

export function isMcpToolName(toolName: string): boolean {
  return /^mcp__[A-Za-z0-9_-]+__.+$/.test(toolName);
}

export function isClientRoutedToolName(toolName: string): boolean {
  // 同 shouldRouteToHand：cerelay shadow MCP 工具不走 client-routed 路径。
  if (isCerelayShadowMcpTool(toolName)) {
    return false;
  }
  return isBuiltinHandToolName(toolName) || isMcpToolName(toolName);
}

function normalizeNames(values: string[]): string[] {
  const deduped = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) {
      continue;
    }
    deduped.add(normalized);
  }
  return Array.from(deduped);
}
