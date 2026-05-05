import os from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parse, stringify } from "smol-toml";
import { createLogger } from "./logger.js";

const log = createLogger("config");

export interface ScanConfig {
  /**
   * 同步白名单（CC 启动期会读取的目录或单文件）。
   * 取值规则：
   *   - 顶级 dir 名（如 "plugins"） → 整子树同步
   *   - 顶级文件名（如 "settings.json"） → 该单文件同步
   *   - 嵌套 dir（如 "plugins/cache"） → 仅该子树同步，walk 时其祖先链放行
   *   - 空数组 → 放行所有（向后兼容；老 toml 没有 include_dirs 字段时落空数组）
   * 与 excludeDirs 共同生效：先 include 通过、再 exclude 剪枝。
   */
  includeDirs: string[];
  /**
   * 同步黑名单：从 includeDirs 内再剪掉哪些子树。
   * 取值规则同 includeDirs，语义"在 prefix 之下都跳过"。
   */
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
# cerelay 启动时会扫描 ~/.claude/ 并把内容同步到 Server 端缓存。
#
# 扫描规则：先按 include_dirs 白名单挑出"要同步的范围"，
# 再按 exclude_dirs 黑名单从范围里剪掉"明确不要的子树"。
#
# 默认 include_dirs 仅列 Claude Code 启动期会读取的目录与文件
# （plugins / projects / sessions / settings.json 等）。这些目录里的
# 内容会进入 Server 缓存，CC 启动时不会反复穿透回你本机。
#
# include_dirs 之外的路径（例如你自己放在 ~/.claude/ 下的笔记目录）
# 不会被同步——CC 不会读它们，所以不需要缓存。如果某天 CC 真的去读了
# 一个未列入的路径，cerelay 会自动从你本机直接读取（功能不受影响、
# 只是少了一次缓存加速）。
#
# ------ 想让 cerelay 同步你额外的目录/文件 ------
# 在下方 include_dirs = [ ... ] 数组里新增一行，例如  "my-folder",
#
# ------ 想让 cerelay 跳过 include 范围内某个子目录 ------
# 在下方 exclude_dirs = [ ... ] 数组里新增对应路径
# （路径写法与 include_dirs 一致，比如 "plugins/cache/old-stuff"）
#
# ------ 想完全恢复"全量同步整个 ~/.claude/" 的旧行为 ------
# 把 include_dirs = [] 写空即可（或整行删掉）。空数组 = 放行所有。

include_dirs = [
  # —— Claude Code 启动期会 readdir 的目录（必须缓存，否则启动有大量穿透）——
  "plugins",         # 插件子树（含 marketplace、cache、data）
  "projects",        # 历史会话索引（CC 启动会列出可恢复 session）
  "sessions",        # 会话索引
  "backups",         # .claude.json 自动备份
  "skills",          # 用户级 skills
  "commands",        # 用户级 slash commands
  "agents",          # 用户级 agents

  # —— Claude Code 启动期会 stat 的目录（缓存顶级 stat 即可）——
  "shell-snapshots", # 启动会写新文件、stat 旧文件
  "session-env",     # 含 sessionstart-hook，CC 启动时会执行
  "file-history",    # Edit 工具的文件备份
  "paste-cache",     # paste 命令的中间文件
  "cache",           # CC 内部缓存（含更新检查 changelog）
  "tasks",           # 任务锁
  "todos",           # TodoWrite 状态
  "telemetry",       # 遥测
  "statsig",         # feature flags 缓存
  "ide",             # IDE 集成

  # —— Claude Code 启动期必读的顶级单文件 ——
  "settings.json",
  "settings.local.json",
  "CLAUDE.md",
  "CLAUDE.local.md",
  ".credentials.json",
  "history.jsonl",

  # —— 在下面添加你想额外同步的目录或文件 ——
  # 例如：
  # "my-notes",
]

exclude_dirs = [
  # —— include_dirs 范围内还想剪掉的子树写在这里 ——
  # 例如：
  # "plugins/cache/old-stuff",
]
`;

const templateDefaults = parseFallbackDefaults(CONFIG_TEMPLATE);

export const DEFAULT_INCLUDE_DIRS = Object.freeze([...templateDefaults.includeDirs]);
export const DEFAULT_EXCLUDE_DIRS = Object.freeze([...templateDefaults.excludeDirs]);

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

/**
 * 仅根据 exclude_dirs 决定是否跳过。保留以兼容仍在直接调用的代码（cache-watcher
 * 之外的旧调用点）；新逻辑应改用 createScanFilter。
 */
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

/**
 * 同步阶段的复合过滤器：
 *   - includeDirs 非空时，**仅对含 "/" 的子项做白名单过滤**：relPath 必须在某个
 *     include prefix 之下、或者是某个 include prefix 的祖先（保证 walkDir
 *     递归能进到 include 子树）。
 *   - **顶级 entry（不含 "/"）一律放行**——CC 二进制可能读 ~/.claude/ 顶级
 *     任意配置文件（settings.json / .config.json / 任意 marker），列名不可穷举；
 *     语义跟 exclude_dirs 时代一致（旧黑名单只针对 dir 子树，顶级文件从来都同步）。
 *     顶级 dir 没列在 include_dirs 时，dir 自身的 relPath 通过，但 walkDir 进它
 *     后所有子项都含 "/" → 都被过滤掉，等价于"dir 进不去"。manifest 不存 dir
 *     entry，所以无副作用。
 *   - includeDirs 为空 → 视为"放行所有"（保留旧 toml 没有 include_dirs 字段时
 *     的兼容语义）。
 *   - excludeDirs 永远生效：在 prefix 之下的一律跳过（语义同 createExcludeMatcher）。
 *
 * 函数返回值：true = 跳过该 relPath，false = 继续 walk / 收入 manifest。
 */
export function createScanFilter(
  includeDirs: string[],
  excludeDirs: string[],
): (relPath: string) => boolean {
  const includes = includeDirs
    .map((value) => normalizeRelativePath(value))
    .filter((value) => value.length > 0);
  const excludes = excludeDirs
    .map((value) => normalizeRelativePath(value))
    .filter((value) => value.length > 0);

  return (relPath: string): boolean => {
    const normalized = normalizeRelativePath(relPath);
    // includes 非空且 relPath 是子项（含 "/"）才走白名单过滤；顶级 entry 直接通过
    if (includes.length > 0 && normalized.includes("/")) {
      const passIncludes = includes.some((prefix) =>
        isUnderOrAncestorOf(normalized, prefix),
      );
      if (!passIncludes) return true; // 子项不在白名单范围 → 跳过
    }
    for (const prefix of excludes) {
      if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
        return true; // 落在黑名单子树 → 跳过
      }
    }
    return false;
  };
}

function isUnderOrAncestorOf(relPath: string, prefix: string): boolean {
  if (prefix === "" || relPath === "") return true;
  if (relPath === prefix) return true;
  // relPath 在 prefix 之下：rel = "plugins/cache/x"  prefix = "plugins/cache"
  if (relPath.startsWith(`${prefix}/`)) return true;
  // relPath 是 prefix 的祖先：rel = "plugins"  prefix = "plugins/cache"
  if (prefix.startsWith(`${relPath}/`)) return true;
  return false;
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
    return { ok: true, config: { scan: { includeDirs: [], excludeDirs: [] } } };
  }
  if (!isRecord(scan)) {
    return { ok: false, reason: "[scan] 必须是 table" };
  }

  const includeDirsRaw = scan.include_dirs;
  let includeDirs: string[];
  if (includeDirsRaw === undefined) {
    // 旧 toml 没有 include_dirs 字段 → 视为空数组（"放行所有"），
    // 跟 v1 行为兼容（用户升级后行为不变直到主动改 toml）。
    includeDirs = [];
  } else if (
    !Array.isArray(includeDirsRaw) ||
    !includeDirsRaw.every((entry) => typeof entry === "string")
  ) {
    return { ok: false, reason: "scan.include_dirs 必须是字符串数组" };
  } else {
    includeDirs = includeDirsRaw.map((entry) => normalizeRelativePath(entry));
  }

  const excludeDirsRaw = scan.exclude_dirs;
  let excludeDirs: string[];
  if (excludeDirsRaw === undefined) {
    excludeDirs = [];
  } else if (
    !Array.isArray(excludeDirsRaw) ||
    !excludeDirsRaw.every((entry) => typeof entry === "string")
  ) {
    return { ok: false, reason: "scan.exclude_dirs 必须是字符串数组" };
  } else {
    excludeDirs = excludeDirsRaw.map((entry) => normalizeRelativePath(entry));
  }

  return {
    ok: true,
    config: {
      scan: { includeDirs, excludeDirs },
    },
  };
}

function fallbackConfig(): CerelayConfig {
  return {
    scan: {
      includeDirs: [...DEFAULT_INCLUDE_DIRS],
      excludeDirs: [...DEFAULT_EXCLUDE_DIRS],
    },
  };
}

function parseFallbackDefaults(template: string): {
  includeDirs: string[];
  excludeDirs: string[];
} {
  const decoded = decodeConfig(parse(template));
  if (!decoded.ok) {
    throw new Error(`CONFIG_TEMPLATE 无法解析为默认配置: ${decoded.reason}`);
  }
  return {
    includeDirs: decoded.config.scan.includeDirs,
    excludeDirs: decoded.config.scan.excludeDirs,
  };
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
      include_dirs: [...DEFAULT_INCLUDE_DIRS],
      exclude_dirs: [...DEFAULT_EXCLUDE_DIRS],
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: string }).code === "ENOENT"
  );
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
