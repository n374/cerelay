import { readFile, writeFile, editFile, multiEdit } from "./tools/fs.js";
import { executeBash } from "./tools/bash.js";
import { grep, globFiles } from "./tools/search.js";
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

// ============================================================
// 工具错误类型（与 Go ToolError 对齐）
// ============================================================

export class ToolError extends Error {
  code: string;
  tool: string;

  constructor(code: string, tool: string, message: string) {
    super(`${code}(${tool}): ${message}`);
    this.name = "ToolError";
    this.code = code;
    this.tool = tool;
  }

  // 序列化为 JSON 字符串（跨进程传输用）
  toJSON(): object {
    return {
      code: this.code,
      tool: this.tool,
      message: this.message,
    };
  }
}

// 工具执行结果联合类型
export type ToolOutput =
  | ReadOutput
  | PathOutput
  | BashOutput
  | GrepOutput
  | GlobOutput;

// ============================================================
// ToolExecutor：根据工具名分发到对应实现
// ============================================================

export class ToolExecutor {
  // 会话工作目录，影响相对路径解析和 Bash 的 CWD
  private readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  // 根据工具名分发，与 Go Executor.Execute 完全对齐
  async dispatch(toolName: string, input: unknown): Promise<ToolOutput> {
    switch (toolName) {
      case "Read":
        return readFile(input as ReadInput, this.cwd);
      case "Write":
        return writeFile(input as WriteInput, this.cwd);
      case "Edit":
        return editFile(input as EditInput, this.cwd);
      case "MultiEdit":
        return multiEdit(input as MultiEditInput, this.cwd);
      case "Bash":
        return executeBash(input as BashInput, this.cwd);
      case "Grep":
        return grep(input as GrepInput, this.cwd);
      case "Glob":
        return globFiles(input as GlobInput, this.cwd);
      default:
        throw new ToolError(
          "unknown_tool",
          toolName,
          `未知工具: ${toolName}`
        );
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
