import { exec } from "node:child_process";
import * as fsSync from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";

// ============================================================
// 输入/输出类型定义（与 Go internal/hand/tools_search.go 对齐）
// ============================================================

export interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
}

export interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

export interface GrepOutput {
  matches: GrepMatch[];
}

export interface GlobInput {
  pattern: string;
  path?: string;
}

export interface GlobOutput {
  files: string[];
}

// ============================================================
// Grep 实现：优先调用系统 grep，不可用时回退到纯 Node 实现
// ============================================================

export async function grep(
  input: GrepInput,
  cwd: string
): Promise<GrepOutput> {
  if (!input.pattern) {
    throw new Error("Grep 缺少 pattern");
  }

  const searchRoot = input.path
    ? resolvePath(input.path, cwd)
    : cwd;

  // 尝试使用系统 grep
  const grepAvailable = await commandExists("grep");
  if (grepAvailable) {
    return runSystemGrep(searchRoot, input);
  }

  return runNodeGrep(searchRoot, input);
}

// 调用系统 grep -rn
function runSystemGrep(
  searchRoot: string,
  input: GrepInput
): Promise<GrepOutput> {
  const args: string[] = ["-rn", input.pattern, searchRoot];
  if (input.glob) {
    args.push("--include", input.glob);
  }

  return new Promise((resolve, reject) => {
    exec(`grep ${args.map(shellQuote).join(" ")}`, (err, stdout, stderr) => {
      if (err) {
        // grep 返回 1 表示未匹配，不算错误
        if ((err as NodeJS.ErrnoException & { code?: number }).code === 1) {
          resolve({ matches: [] });
          return;
        }
        reject(
          new Error(
            `执行系统 grep 失败: ${err.message}, stderr=${stderr.trim()}`
          )
        );
        return;
      }
      resolve(parseGrepOutput(stdout));
    });
  });
}

// 纯 Node 实现，按行扫描文件内容
async function runNodeGrep(
  searchRoot: string,
  input: GrepInput
): Promise<GrepOutput> {
  const matches: GrepMatch[] = [];

  await walkDir(searchRoot, async (filePath) => {
    // glob 过滤
    if (input.glob) {
      const base = path.basename(filePath);
      if (!minimatch(base, input.glob)) {
        return;
      }
    }

    const fileMatches = await grepFile(filePath, input.pattern);
    matches.push(...fileMatches);
  });

  return { matches };
}

// 逐行扫描单个文件
async function grepFile(
  filePath: string,
  pattern: string
): Promise<GrepMatch[]> {
  const matches: GrepMatch[] = [];

  try {
    const stream = fsSync.createReadStream(filePath, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let lineNo = 0;
    for await (const line of rl) {
      lineNo++;
      if (line.includes(pattern)) {
        matches.push({ file: filePath, line: lineNo, text: line });
      }
    }
  } catch {
    // 忽略无法读取的文件（二进制文件等）
  }

  return matches;
}

// ============================================================
// Glob 实现：使用 Node 原生 fs.walkDir + path.match
// ============================================================

export async function globFiles(
  input: GlobInput,
  cwd: string
): Promise<GlobOutput> {
  if (!input.pattern) {
    throw new Error("Glob 缺少 pattern");
  }

  const searchRoot = input.path
    ? resolvePath(input.path, cwd)
    : cwd;

  const files: string[] = [];
  const seen = new Set<string>();

  await walkDir(searchRoot, async (filePath) => {
    const base = path.basename(filePath);
    const rel = path.relative(searchRoot, filePath);

    // 同 Go 实现：先匹配 basename，再匹配相对路径
    const matchBase = minimatch(base, input.pattern);
    const matchRel = minimatch(rel, input.pattern);

    if ((matchBase || matchRel) && !seen.has(filePath)) {
      seen.add(filePath);
      files.push(filePath);
    }
  });

  return { files };
}

// ============================================================
// 工具函数
// ============================================================

// 递归遍历目录，对每个文件调用 callback
async function walkDir(
  dir: string,
  callback: (filePath: string) => Promise<void>
): Promise<void> {
  let entries: fsSync.Dirent[];
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDir(fullPath, callback);
    } else if (entry.isFile()) {
      await callback(fullPath);
    }
  }
}

// 解析 grep 输出（格式：file:line:text）
function parseGrepOutput(output: string): GrepOutput {
  const matches: GrepMatch[] = [];

  for (const line of output.split("\n")) {
    if (!line) continue;
    const parts = line.split(":");
    if (parts.length < 3) continue;

    const lineNo = parseInt(parts[1], 10);
    if (isNaN(lineNo)) continue;

    matches.push({
      file: parts[0],
      line: lineNo,
      text: parts.slice(2).join(":"),
    });
  }

  return { matches };
}

// 简单的 glob 模式匹配（支持 * 通配符，与 Go filepath.Match 对齐）
function minimatch(str: string, pattern: string): boolean {
  // 将 glob pattern 转为正则表达式
  // 仅处理 * 和 ? 两种通配符（filepath.Match 语义）
  const regexStr = pattern
    .split("*")
    .map((part) =>
      part
        .split("?")
        .map(escapeRegex)
        .join("[^/]")
    )
    .join("[^/]*");

  return new RegExp(`^${regexStr}$`).test(str);
}

function escapeRegex(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

// shell 参数转义
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

// 路径解析
function resolvePath(filePath: string, cwd: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  return path.resolve(cwd, filePath);
}

// 检查命令是否存在
function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    exec(`command -v ${cmd}`, (err) => {
      resolve(!err);
    });
  });
}
