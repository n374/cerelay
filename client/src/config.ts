import os from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parse, stringify } from "smol-toml";
import { createLogger } from "./logger.js";

const log = createLogger("config");

export interface ScanConfig {
  excludeDirs: string[];
}

export interface CerelayConfig {
  scan: ScanConfig;
}

export const CONFIG_TEMPLATE = `# Cerelay Client 配置文件
# 此文件由 cerelay 首次启动时自动生成；后续修改不会被覆盖。
# 修改后，下次启动 cerelay 生效。
#
# ============================================================
# 不熟悉 TOML 的话，先看这段语法说明
# ============================================================
# 1. 以 "#" 开头的行是注释，cerelay 不会读取它
# 2. 字符串必须用双引号包起来，例如：  "my-folder"
# 3. 数组里的元素用英文逗号 "," 分隔；最后一个元素后面也可以带逗号
# 4. 修改时请保留双引号和逗号，否则启动时会解析失败
#    （如果解析失败，cerelay 会忽略本配置并在日志里打印 warn）
# ============================================================


[scan]
# 启动时 cerelay 会扫描 ~/.claude/ 并把内容同步到 Server 端缓存。
# 列在 exclude_dirs 里的目录会被跳过；这些目录在 Server 缓存里
# 没有副本，但 Claude Code 第一次访问它们时 cerelay 会自动从你的
# 本机读取文件 —— 只是少了一次缓存加速，功能完全不受影响。
#
# ------ 怎么添加你想跳过的目录 ------
# 假如你想跳过 ~/.claude/my-folder/：
#
#   1. 在下面的 exclude_dirs = [ ... ] 数组里新增一行
#   2. 这一行写成        "my-folder",
#      （双引号包起来，结尾的逗号别忘）
#   3. 保存文件
#   4. 下次启动 cerelay 时生效
#
# ------ 怎么取消跳过某个目录 ------
# 找到对应那一行，要么直接删掉整行，要么在行首加上 "#" 把它注释掉。
#
# ------ 启用下方被注释掉的条目 ------
# 找到带 "# " 前缀的那一行（例如  # "cache",）
# 把行首的 "# " 删掉就是启用；保留就是不启用。

exclude_dirs = [
  # —— CC 启动时不读取（运行时按需访问，跳过完全安全）——
  "projects",        # 历史会话 JSONL，仅 /resume 时按需读
  "file-history",    # Edit 工具的文件备份
  "backups",         # .claude.json 的自动备份
  "paste-cache",     # paste 命令的中间文件
  "shell-snapshots", # 启动会写新文件，旧的不再读
  "telemetry",       # 遥测，写为主
  "todos",           # TodoWrite 工具状态
  "tasks",           # 任务锁文件

  # —— 用途不确定，CC 启动时可能读取（默认未启用，按需取舍）——
  # 启用方式：把行首的 "# " 删掉。如果启用后 CC 表现异常，
  #          把 "# " 加回去即可恢复。
  # "cache",         # CC 内部缓存（含更新检查 changelog）
  # "plans",         # 计划/笔记（多设备同步场景建议保留）
  # "session-env",   # 含 sessionstart-hook，启动时会执行
  # "sessions",      # 会话索引
  # "statsig",       # feature flags 缓存

  # —— 在下面添加你自己想跳过的目录 ——
  # 例如：
  # "my-folder",
]
`;

const templateDefaults = parseFallbackDefaults(CONFIG_TEMPLATE);

export const DEFAULT_EXCLUDE_DIRS = Object.freeze([...templateDefaults]);

export async function loadConfig(opts: {
  configPath?: string;
} = {}): Promise<CerelayConfig> {
  const configPath = opts.configPath ?? path.join(defaultConfigDir(), "config.toml");
  let content: string;

  try {
    content = await readFile(configPath, "utf8");
  } catch (error) {
    if (!isMissingFileError(error)) {
      log.warn("读取 cerelay config 失败，回退模板默认", {
        configPath,
        error: asErrorMessage(error),
        fallbackToml: fallbackTomlString(),
      });
      return fallbackConfig();
    }

    try {
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, CONFIG_TEMPLATE, "utf8");
    } catch (writeError) {
      log.warn("写入 cerelay config 模板失败，回退模板默认", {
        configPath,
        error: asErrorMessage(writeError),
        fallbackToml: fallbackTomlString(),
      });
      return fallbackConfig();
    }

    content = CONFIG_TEMPLATE;
  }

  return parseLoadedConfig(content, configPath);
}

export function createExcludeMatcher(
  excludeDirs: string[],
): (relPath: string) => boolean {
  const prefixes = excludeDirs
    .map((value) => normalizeRelativePath(value))
    .filter((value) => value.length > 0);

  if (prefixes.length === 0) {
    return () => false;
  }

  return (relPath: string): boolean => {
    const normalized = normalizeRelativePath(relPath);
    for (const prefix of prefixes) {
      if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
        return true;
      }
    }
    return false;
  };
}

function parseLoadedConfig(content: string, configPath: string): CerelayConfig {
  let parsed: unknown;
  try {
    parsed = parse(content);
  } catch (error) {
    log.warn("解析 cerelay config 失败，回退模板默认", {
      configPath,
      error: asErrorMessage(error),
      fallbackToml: fallbackTomlString(),
    });
    return fallbackConfig();
  }

  const decoded = decodeConfig(parsed);
  if (!decoded.ok) {
    log.warn("cerelay config 字段类型错误，回退模板默认", {
      configPath,
      error: decoded.reason,
      fallbackToml: fallbackTomlString(),
    });
    return fallbackConfig();
  }
  return decoded.config;
}

function decodeConfig(value: unknown):
  | { ok: true; config: CerelayConfig }
  | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return { ok: false, reason: "root 必须是 TOML table" };
  }

  const scan = value.scan;
  if (scan === undefined) {
    return { ok: true, config: { scan: { excludeDirs: [] } } };
  }
  if (!isRecord(scan)) {
    return { ok: false, reason: "[scan] 必须是 table" };
  }

  const excludeDirs = scan.exclude_dirs;
  if (excludeDirs === undefined) {
    return { ok: true, config: { scan: { excludeDirs: [] } } };
  }
  if (!Array.isArray(excludeDirs) || !excludeDirs.every((entry) => typeof entry === "string")) {
    return { ok: false, reason: "scan.exclude_dirs 必须是字符串数组" };
  }

  return {
    ok: true,
    config: {
      scan: {
        excludeDirs: excludeDirs.map((entry) => normalizeRelativePath(entry)),
      },
    },
  };
}

function fallbackConfig(): CerelayConfig {
  return {
    scan: {
      excludeDirs: [...DEFAULT_EXCLUDE_DIRS],
    },
  };
}

function parseFallbackDefaults(template: string): string[] {
  const decoded = decodeConfig(parse(template));
  if (!decoded.ok) {
    throw new Error(`CONFIG_TEMPLATE 无法解析为默认配置: ${decoded.reason}`);
  }
  return decoded.config.scan.excludeDirs;
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
}

function defaultConfigDir(): string {
  return path.join(os.homedir(), ".config", "cerelay");
}

function fallbackTomlString(): string {
  return stringify({
    scan: {
      exclude_dirs: [...DEFAULT_EXCLUDE_DIRS],
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMissingFileError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
