// ============================================================
// cerelay shadow tools 的 schema 定义
// Schemas for the cerelay shadow MCP tools.
//
// 设计 / Design:
// - 短名（shortName）注册到 SDK，CC 看到的 fully-qualified name 是
//   `mcp__cerelay__<shortName>`（CC 命名规则：mcp__<server>__<tool>）。
// - builtinName 是镜像的 CC 内置工具名，用于 IPC dispatcher 调用 rewrite/render
//   流水线，跟 PreToolUse hook 路径完全一致。
// - inputSchema 跟 client/src/tools 接收的字段对齐——保留 CC 内置工具的字段
//   命名（file_path / command / pattern / edits / replace_all 等），让模型按
//   原生 schema 习惯调用即可。
// ============================================================

export interface ShadowToolSchema {
  /** 注册到 MCP server 的短名；CC 看到的 fqn 是 `mcp__cerelay__${shortName}`。 */
  shortName: string;
  /** 镜像的 CC 内置工具名（client routing / rewriteToolInputForClient / renderToolResultForClaude 用）。 */
  builtinName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const editEntrySchema = {
  type: "object",
  properties: {
    old_string: { type: "string" },
    new_string: { type: "string" },
    replace_all: { type: "boolean", default: false },
  },
  required: ["old_string", "new_string"],
  additionalProperties: false,
} as const;

export const SHADOW_TOOLS: readonly ShadowToolSchema[] = [
  {
    shortName: "bash",
    builtinName: "Bash",
    description:
      "Execute a shell command on the user's actual workspace. Mirrors the standard Bash tool; use this in place of Bash in this sandboxed runtime.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        description: { type: "string", description: "Short human-readable description" },
        timeout: { type: "number", description: "Optional timeout in milliseconds" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    shortName: "read",
    builtinName: "Read",
    description:
      "Read a file from the user's actual workspace. Mirrors the standard Read tool; use this in place of Read in this sandboxed runtime.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path to the file" },
        offset: { type: "number", description: "Line offset to start reading from" },
        limit: { type: "number", description: "Number of lines to read" },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
  },
  {
    shortName: "write",
    builtinName: "Write",
    description:
      "Write a file in the user's actual workspace. Mirrors the standard Write tool; use this in place of Write in this sandboxed runtime.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        content: { type: "string" },
      },
      required: ["file_path", "content"],
      additionalProperties: false,
    },
  },
  {
    shortName: "edit",
    builtinName: "Edit",
    description:
      "Replace exact text in a file in the user's actual workspace. Mirrors the standard Edit tool.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean", default: false },
      },
      required: ["file_path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  {
    shortName: "multi_edit",
    builtinName: "MultiEdit",
    description:
      "Apply multiple edits to a single file in the user's actual workspace. Mirrors the standard MultiEdit tool.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        edits: {
          type: "array",
          minItems: 1,
          items: editEntrySchema,
        },
      },
      required: ["file_path", "edits"],
      additionalProperties: false,
    },
  },
  {
    shortName: "glob",
    builtinName: "Glob",
    description:
      "List files matching a glob pattern in the user's actual workspace. Mirrors the standard Glob tool.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    shortName: "grep",
    builtinName: "Grep",
    description:
      "Search file contents with ripgrep in the user's actual workspace. Mirrors the standard Grep tool.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        glob: { type: "string" },
        type: { type: "string" },
        output_mode: { type: "string", enum: ["content", "files_with_matches", "count"] },
        "-i": { type: "boolean" },
        "-n": { type: "boolean" },
        "-A": { type: "number" },
        "-B": { type: "number" },
        "-C": { type: "number" },
        context: { type: "number" },
        multiline: { type: "boolean" },
        head_limit: { type: "number" },
        offset: { type: "number" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
] as const;

export const SHADOW_TOOL_NAME_PREFIX = "mcp__cerelay__";

/** 把 shortName 转成 CC 看到的 fully-qualified name。 */
export function fullyQualifiedShadowToolName(shortName: string): string {
  return `${SHADOW_TOOL_NAME_PREFIX}${shortName}`;
}

/** 反向解析：fully-qualified name 是否是 cerelay shadow tool？ */
export function isCerelayShadowToolName(name: string): boolean {
  return name.startsWith(SHADOW_TOOL_NAME_PREFIX);
}
