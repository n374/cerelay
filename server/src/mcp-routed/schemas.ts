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

// MultiEdit 内部条目 schema：与 client 的 MultiEditItem 对齐——目前 client 不
// 支持每条 edit 单独 replace_all（硬编码 false），所以 schema 不暴露该字段，
// 防止模型期望被实际忽略的功能。
const editEntrySchema = {
  type: "object",
  properties: {
    old_string: { type: "string" },
    new_string: { type: "string" },
  },
  required: ["old_string", "new_string"],
  additionalProperties: false,
} as const;

export const SHADOW_TOOLS: readonly ShadowToolSchema[] = [
  {
    shortName: "bash",
    builtinName: "Bash",
    description:
      "Execute a shell command on the user's actual workspace. Use this in place of the Bash tool in this sandboxed runtime—standard Bash is not available.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        // 注意：client/src/tools/bash.ts 把 timeout 解释为秒（DEFAULT 120s），
        // schema 描述必须与实现一致，避免模型按 ms 传值。
        timeout: { type: "number", description: "Timeout in seconds (default 120)" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    shortName: "read",
    builtinName: "Read",
    description:
      "Read a file from the user's actual workspace. Use this in place of the Read tool in this sandboxed runtime.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path to the file" },
        // 注意：client 按 Unicode 字符切片（rune-aligned），不是按行。
        offset: { type: "number", description: "Character offset to start reading from" },
        limit: { type: "number", description: "Number of characters to read" },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
  },
  {
    shortName: "write",
    builtinName: "Write",
    description:
      "Write a file in the user's actual workspace. Use this in place of the Write tool in this sandboxed runtime.",
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
      "Replace exact text in a file in the user's actual workspace. Use this in place of the Edit tool in this sandboxed runtime.",
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
      "Apply multiple edits to a single file in the user's actual workspace. Use this in place of the MultiEdit tool in this sandboxed runtime.",
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
      "List files matching a glob pattern in the user's actual workspace. Use this in place of the Glob tool in this sandboxed runtime.",
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
      "Search file contents in the user's actual workspace. Use this in place of the Grep tool in this sandboxed runtime. Returns line-level matches; use bash + grep/rg for advanced flags.",
    inputSchema: {
      // 注意：client 当前实现仅支持 pattern/path/glob 三个字段；CC 内置 Grep 的
      // 其他 flag（-i / -n / -A / -B / -C / context / multiline / output_mode /
      // head_limit / offset / type）一律不支持，故不暴露——避免模型期望被
      // 实际忽略的功能。如需扩展，需先扩 client/src/tools/search.ts。
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        glob: { type: "string" },
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
