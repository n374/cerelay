import { readFile, writeFile, editFile, multiEdit } from "./tools/fs.js";
import { executeBash } from "./tools/bash.js";
import { grep, globFiles } from "./tools/search.js";
import { executeExternalTool, type ExternalToolOutput } from "./tools/external.js";
import { webFetch, type WebFetchInput, type WebFetchOutput } from "./tools/web.js";
import { McpRuntime } from "./mcp/runtime.js";
import { ToolError } from "./tool-error.js";
import { createLogger } from "./logger.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerCatalogEntry, McpServerConfig } from "./protocol.js";
import type {
  ReadInput,
  ReadOutput,
  WriteInput,
  PathOutput,
  EditInput,
  MultiEditInput,
} from "./tools/fs.js";
import type { BashInput, BashOutput } from "./tools/bash.js";
import type {
  GrepInput,
  GrepOutput,
  GlobInput,
  GlobOutput,
} from "./tools/search.js";

export { ToolError } from "./tool-error.js";

const log = createLogger("hand-executor");

// 工具执行结果联合类型
export type ToolOutput =
  | ReadOutput
  | PathOutput
  | BashOutput
  | GrepOutput
  | GlobOutput
  | WebFetchOutput
  | CallToolResult
  | ExternalToolOutput;

// ============================================================
// ToolExecutor：根据工具名分发到对应实现
// ============================================================

export class ToolExecutor {
  // 会话工作目录，影响相对路径解析和 Bash 的 CWD
  private readonly cwd: string;
  private readonly mcpRuntime: McpRuntime;
  private readonly ownsMcpRuntime: boolean;

  constructor(cwd: string, mcpServerConfigs?: Record<string, McpServerConfig>);
  constructor(cwd: string, mcpRuntime: McpRuntime);
  constructor(cwd: string, configsOrRuntime?: Record<string, McpServerConfig> | McpRuntime) {
    this.cwd = cwd;
    if (configsOrRuntime instanceof McpRuntime) {
      this.mcpRuntime = configsOrRuntime;
      this.ownsMcpRuntime = false;
    } else {
      this.mcpRuntime = new McpRuntime(cwd, configsOrRuntime);
      this.ownsMcpRuntime = true;
    }
  }

  // 根据工具名分发，与 Go Executor.Execute 完全对齐
  async dispatch(toolName: string, input: unknown): Promise<ToolOutput> {
    log.info("开始分发工具调用", {
      cwd: this.cwd,
      toolName,
      inputSummary: summarizeUnknown(input),
    });

    try {
      let result: ToolOutput;
      switch (toolName) {
        case "Read":
          result = await readFile(input as ReadInput, this.cwd);
          break;
        case "Write":
          result = await writeFile(input as WriteInput, this.cwd);
          break;
        case "Edit":
          result = await editFile(input as EditInput, this.cwd);
          break;
        case "MultiEdit":
          result = await multiEdit(input as MultiEditInput, this.cwd);
          break;
        case "Bash":
          result = await executeBash(input as BashInput, this.cwd);
          break;
        case "Grep":
          result = await grep(input as GrepInput, this.cwd);
          break;
        case "Glob":
          result = await globFiles(input as GlobInput, this.cwd);
          break;
        case "WebFetch":
          result = await webFetch(input as WebFetchInput);
          break;
        default:
          if (isMcpToolName(toolName)) {
            try {
              result = await this.mcpRuntime.callTool(toolName, input);
              break;
            } catch (error) {
              if (!(error instanceof ToolError) || error.code !== "tool_unconfigured") {
                throw error;
              }
            }
          }
          result = await executeExternalTool(toolName, input, this.cwd);
          break;
      }

      log.info("工具调用分发完成", {
        cwd: this.cwd,
        toolName,
        summary: summarizeToolResult(toolName, result),
        outputSummary: summarizeUnknown(result),
      });
      return result;
    } catch (error) {
      log.warn("工具调用分发失败", {
        cwd: this.cwd,
        toolName,
        inputSummary: summarizeUnknown(input),
        error: formatToolError(error),
      });
      throw error;
    }
  }

  async describeMcpServers(): Promise<Record<string, McpServerCatalogEntry>> {
    return this.mcpRuntime.describeServers();
  }

  async close(): Promise<void> {
    // 仅关闭自建的 McpRuntime；外部传入的由调用方管理生命周期
    if (this.ownsMcpRuntime) {
      await this.mcpRuntime.close();
    }
  }
}

// ============================================================
// 摘要生成（与 Go summarizeToolResult 对齐）
// ============================================================

export function summarizeToolResult(
  toolName: string,
  result: ToolOutput
): string {
  if (toolName === "Read") {
    const r = result as ReadOutput;
    // 与 Go []rune 一致，按 Unicode 码点计字符数
    const charCount = [...r.content].length;
    return `Read 成功，返回 ${charCount} 字符`;
  }

  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") {
    const r = result as PathOutput;
    return `${toolName} 成功: ${r.path}`;
  }

  if (toolName === "Bash") {
    const r = result as BashOutput;
    return `Bash 完成，exit_code=${r.exit_code}, stdout=${r.stdout.length}B, stderr=${r.stderr.length}B`;
  }

  if (toolName === "Grep") {
    const r = result as GrepOutput;
    return `Grep 完成，匹配 ${r.matches.length} 项`;
  }

  if (toolName === "Glob") {
    const r = result as GlobOutput;
    return `Glob 完成，匹配 ${r.files.length} 个路径`;
  }

  if (toolName === "WebFetch") {
    const r = result as WebFetchOutput;
    return `WebFetch 完成，status=${r.status}, body=${r.body.length}B`;
  }

  if (!BUILTIN_TOOL_NAMES.has(toolName as BuiltinToolName)) {
    return `${toolName} 完成`;
  }

  return `${toolName} 执行成功`;
}

// ============================================================
// 工具错误格式化（与 Go formatToolError 对齐）
// ============================================================

export function formatToolError(err: unknown): string {
  if (!err) return "";
  if (err instanceof ToolError) {
    return JSON.stringify(err.toJSON());
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

type BuiltinToolName = "Read" | "Write" | "Edit" | "MultiEdit" | "Bash" | "Grep" | "Glob" | "WebFetch";

const BUILTIN_TOOL_NAMES = new Set<BuiltinToolName>([
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Bash",
  "Grep",
  "Glob",
  "WebFetch",
]);

function isMcpToolName(toolName: string): boolean {
  return /^mcp__[A-Za-z0-9_-]+__.+$/.test(toolName);
}

function summarizeUnknown(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "string") {
    return previewText(value, 120);
  }
  try {
    return previewText(JSON.stringify(value), 120);
  } catch {
    return String(value);
  }
}

function previewText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
}
