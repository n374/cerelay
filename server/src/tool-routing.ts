export type BuiltinHandToolName =
  | "Read"
  | "Write"
  | "Edit"
  | "MultiEdit"
  | "Bash"
  | "Grep"
  | "Glob";

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
