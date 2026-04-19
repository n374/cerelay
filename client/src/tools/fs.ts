import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

// ============================================================
// 输入/输出类型定义（与 Go internal/hand/tools_fs.go 对齐）
// ============================================================

export interface ReadInput {
  file_path: string;
  offset?: number;
  limit?: number;
}

export interface ReadOutput {
  content: string;
}

export interface WriteInput {
  file_path: string;
  content: string;
}

export interface PathOutput {
  path: string;
}

export interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface MultiEditItem {
  old_string: string;
  new_string: string;
}

export interface MultiEditInput {
  file_path: string;
  edits: MultiEditItem[];
}

// ============================================================
// 工具实现
// ============================================================

// 读取文件内容，支持 offset/limit（按 Unicode 字符计算，与 Go rune 对齐）
export async function readFile(
  input: ReadInput,
  cwd: string
): Promise<ReadOutput> {
  if (!input.file_path) {
    throw new Error("Read 缺少 file_path");
  }

  const filePath = resolvePath(input.file_path, cwd);
  let data: string;
  try {
    data = await fsPromises.readFile(filePath, "utf-8");
  } catch (err) {
    throw new Error(`读取文件 "${filePath}" 失败: ${errorMessage(err)}`);
  }

  // 按 Unicode 码点切片（与 Go []rune 行为一致）
  const chars = [...data];
  const total = chars.length;

  let start = 0;
  if (input.offset !== undefined) {
    if (input.offset < 0) {
      throw new Error("Read 的 offset 不能为负数");
    }
    start = Math.min(input.offset, total);
  }

  let end = total;
  if (input.limit !== undefined) {
    if (input.limit < 0) {
      throw new Error("Read 的 limit 不能为负数");
    }
    end = Math.min(start + input.limit, total);
  }

  return { content: chars.slice(start, end).join("") };
}

// 将完整内容写入目标文件
export async function writeFile(
  input: WriteInput,
  cwd: string
): Promise<PathOutput> {
  if (!input.file_path) {
    throw new Error("Write 缺少 file_path");
  }

  const filePath = resolvePath(input.file_path, cwd);
  try {
    await fsPromises.writeFile(filePath, input.content, "utf-8");
  } catch (err) {
    throw new Error(`写入文件 "${filePath}" 失败: ${errorMessage(err)}`);
  }

  return { path: filePath };
}

// 对文件做单次或全量字符串替换
export async function editFile(
  input: EditInput,
  cwd: string
): Promise<PathOutput> {
  if (!input.file_path) {
    throw new Error("Edit 缺少 file_path");
  }

  const filePath = resolvePath(input.file_path, cwd);
  let content: string;
  try {
    content = await fsPromises.readFile(filePath, "utf-8");
  } catch (err) {
    throw new Error(`读取文件 "${filePath}" 失败: ${errorMessage(err)}`);
  }

  const { updated, replaced } = replaceContent(
    content,
    input.old_string,
    input.new_string,
    input.replace_all ?? false
  );

  if (!replaced) {
    throw new Error(`编辑文件 "${filePath}" 失败: old_string 不存在`);
  }

  try {
    await fsPromises.writeFile(filePath, updated, "utf-8");
  } catch (err) {
    throw new Error(`写回文件 "${filePath}" 失败: ${errorMessage(err)}`);
  }

  return { path: filePath };
}

// 按顺序应用多组字符串替换
export async function multiEdit(
  input: MultiEditInput,
  cwd: string
): Promise<PathOutput> {
  if (!input.file_path) {
    throw new Error("MultiEdit 缺少 file_path");
  }

  const filePath = resolvePath(input.file_path, cwd);
  let content: string;
  try {
    content = await fsPromises.readFile(filePath, "utf-8");
  } catch (err) {
    throw new Error(`读取文件 "${filePath}" 失败: ${errorMessage(err)}`);
  }

  for (let i = 0; i < input.edits.length; i++) {
    const edit = input.edits[i];
    const { updated, replaced } = replaceContent(
      content,
      edit.old_string,
      edit.new_string,
      false
    );
    if (!replaced) {
      throw new Error(`应用 MultiEdit 第 ${i} 项失败: old_string 不存在`);
    }
    content = updated;
  }

  try {
    await fsPromises.writeFile(filePath, content, "utf-8");
  } catch (err) {
    throw new Error(`写回文件 "${filePath}" 失败: ${errorMessage(err)}`);
  }

  return { path: filePath };
}

// ============================================================
// 工具函数
// ============================================================

// 统一处理单次或全量替换，返回 { updated, replaced }
function replaceContent(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean
): { updated: string; replaced: boolean } {
  if (!oldString) {
    throw new Error("old_string 不能为空");
  }

  if (!content.includes(oldString)) {
    return { updated: content, replaced: false };
  }

  if (replaceAll) {
    return { updated: content.split(oldString).join(newString), replaced: true };
  }

  // 仅替换第一次出现
  const idx = content.indexOf(oldString);
  const updated =
    content.slice(0, idx) + newString + content.slice(idx + oldString.length);
  return { updated, replaced: true };
}

// 路径解析：绝对路径直接使用，相对路径基于 cwd 解析
function resolvePath(filePath: string, cwd: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  return path.resolve(cwd, filePath);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
