import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createLogger } from "./logger.js";
import { getTestToggles } from "./test-toggles.js";

import { computeAncestorChain } from "./path-utils.js";

const log = createLogger("claude-runtime");
const DEFAULT_READY_TIMEOUT_MS = 5_000;

export interface SpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
  extraPipeCount?: number;
}

export type SpawnedProcess = ChildProcess;

export interface ClaudeSessionRuntime {
  cwd: string;
  env: Record<string, string | undefined>;
  rootDir: string;
  spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess;
  spawnInRuntime?: (options: SpawnOptions) => SpawnedProcess;
  cleanup(): Promise<void>;
}

export interface CreateClaudeSessionRuntimeOptions {
  sessionId: string;
  cwd: string;
  clientHomeDir?: string;
  projectSettingsLocalShadowPath?: string;
  /** FUSE 文件代理挂载点。设置后 bootstrap 从 FUSE 挂载而非宿主机 bind mount */
  fuseRootDir?: string;
}

export async function createClaudeSessionRuntime(
  options: CreateClaudeSessionRuntimeOptions
): Promise<ClaudeSessionRuntime> {
  if (shouldUseMountNamespace() && process.platform === "linux") {
    return createMountNamespaceRuntime(options);
  }
  return createPassthroughRuntime(options);
}

async function createPassthroughRuntime(
  options: CreateClaudeSessionRuntimeOptions
): Promise<ClaudeSessionRuntime> {
  const runtimeRoot = getClaudeSessionRuntimeRoot(options.sessionId);
  await mkdir(runtimeRoot, { recursive: true });
  const fallbackCwd = existsSync(options.cwd) ? options.cwd : runtimeRoot;
  const effectiveHome = options.clientHomeDir && existsSync(options.clientHomeDir)
    ? options.clientHomeDir
    : process.env.HOME;

  log.debug("使用直连 Claude runtime", {
    sessionId: options.sessionId,
    cwd: fallbackCwd,
    homeDir: effectiveHome,
  });

  return {
    cwd: fallbackCwd,
    env: {
      ...process.env,
      HOME: effectiveHome,
    },
    rootDir: runtimeRoot,
    spawnInRuntime: (spawnOptions) => spawn(spawnOptions.command, spawnOptions.args, {
      cwd: spawnOptions.cwd ?? fallbackCwd,
      env: spawnOptions.env,
      stdio: buildStdio(spawnOptions.extraPipeCount),
      signal: spawnOptions.signal,
    }),
    cleanup: async () => {
      await rm(runtimeRoot, { recursive: true, force: true });
    },
  };
}

async function createMountNamespaceRuntime(
  options: CreateClaudeSessionRuntimeOptions
): Promise<ClaudeSessionRuntime> {
  const runtimeParent = process.env.CERELAY_NAMESPACE_RUNTIME_ROOT?.trim() || "/opt/cerelay-runtime";
  const runtimeRoot = path.join(runtimeParent, sanitizeSessionId(options.sessionId));
  const scriptPath = path.join(runtimeRoot, "bootstrap.sh");
  const readyFile = path.join(runtimeRoot, "ready");
  const clientHomeDir = options.clientHomeDir?.trim() || process.env.HOME || "/home/node";
  const viewRoots = collectViewRoots(clientHomeDir, options.cwd);
  const mountEnv = buildMountNamespaceEnv({
    runtimeRoot,
    readyFile,
    cwd: options.cwd,
    clientHomeDir,
    viewRoots,
    projectSettingsLocalShadowPath: options.projectSettingsLocalShadowPath,
    fuseRootDir: options.fuseRootDir,
  });

  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(scriptPath, renderNamespaceBootstrapScript(), "utf8");
  await chmod(scriptPath, 0o755);

  const anchor = spawn(
    "unshare",
    ["--mount", "--propagation", "private", "--", "/bin/sh", scriptPath],
    {
      env: mountEnv,
      stdio: ["ignore", "ignore", "pipe"],
    }
  );

  const stderrChunks: Buffer[] = [];
  anchor.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(Buffer.from(chunk));
    // 实时输出 bootstrap stderr 到服务器日志，便于运维排查
    const text = chunk.toString("utf8").trim();
    if (text) {
      for (const line of text.split("\n")) {
        log.debug(line.trim(), { source: "bootstrap", sessionId: options.sessionId });
      }
    }
  });

  try {
    await waitForReadyFile(readyFile, anchor, DEFAULT_READY_TIMEOUT_MS);
  } catch (error) {
    anchor.kill("SIGKILL");
    // 注意：runtimeRoot 下可能有 FUSE 挂载点（由 FileProxyManager 管理），
    // rm 会因 EBUSY 失败。清理工作交给调用方在关闭 FUSE 后处理。
    try {
      await rm(runtimeRoot, { recursive: true, force: true });
    } catch (cleanupErr) {
      log.warn("清理 namespace runtimeRoot 失败（可能有活跃 FUSE 挂载）", {
        runtimeRoot,
        error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      });
    }
    const stderrText = Buffer.concat(stderrChunks).toString("utf8").trim();
    const detail = stderrText ? `: ${stderrText}` : "";
    throw new Error(`初始化 Claude mount namespace 失败${detail || `: ${String(error)}`}`);
  }

  log.debug("已创建 Claude mount namespace runtime", {
    sessionId: options.sessionId,
    runtimeRoot,
    anchorPid: anchor.pid,
    cwd: options.cwd,
    homeDir: clientHomeDir,
    viewRoots,
  });

  return {
    cwd: options.cwd,
    env: {
      ...process.env,
      HOME: clientHomeDir,
    },
    rootDir: runtimeRoot,
    spawnClaudeCodeProcess: (spawnOptions) => spawnClaudeInNamespace(anchor, spawnOptions, options.cwd),
    spawnInRuntime: (spawnOptions) => spawnClaudeInNamespace(anchor, spawnOptions, options.cwd),
    cleanup: async () => {
      if (!anchor.killed) {
        anchor.kill("SIGTERM");
      }
      await rm(runtimeRoot, { recursive: true, force: true });
    },
  };
}

function spawnClaudeInNamespace(
  anchor: ChildProcess,
  options: SpawnOptions,
  fallbackCwd: string
): SpawnedProcess {
  if (!anchor.pid) {
    throw new Error("Claude mount namespace anchor 进程不存在");
  }

  const targetCwd = options.cwd || fallbackCwd;
  return spawn(
    "nsenter",
    [
      "-m",
      "-t",
      String(anchor.pid),
      "--",
      "/bin/sh",
      "-lc",
      'cd "$CERELAY_TARGET_CWD" && exec "$0" "$@"',
      options.command,
      ...options.args,
    ],
    {
      env: {
        ...options.env,
        CERELAY_TARGET_CWD: targetCwd,
      },
      stdio: buildStdio(options.extraPipeCount),
      signal: options.signal,
    }
  );
}

function buildStdio(extraPipeCount: number | undefined): Array<"pipe"> {
  const stdio: Array<"pipe"> = ["pipe", "pipe", "pipe"];
  for (let index = 0; index < (extraPipeCount ?? 0); index += 1) {
    stdio.push("pipe");
  }
  return stdio;
}

function shouldUseMountNamespace(): boolean {
  return process.env.CERELAY_ENABLE_MOUNT_NAMESPACE === "true";
}

function collectViewRoots(...paths: string[]): string[] {
  return Array.from(new Set(
    paths
      .map(topLevelName)
      .filter((value): value is string => Boolean(value))
  ));
}

interface BuildMountNamespaceEnvOptions {
  runtimeRoot: string;
  readyFile: string;
  cwd: string;
  clientHomeDir: string;
  viewRoots: string[];
  projectSettingsLocalShadowPath?: string;
  fuseRootDir?: string;
}

function buildMountNamespaceEnv(
  options: BuildMountNamespaceEnvOptions
): Record<string, string | undefined> {
  return {
    ...process.env,
    CERELAY_RUNTIME_ROOT: options.runtimeRoot,
    CERELAY_READY_FILE: options.readyFile,
    CERELAY_HOME_DIR: options.clientHomeDir,
    CERELAY_WORK_DIR: options.cwd,
    CERELAY_VIEW_ROOTS: options.viewRoots.join(":"),
    CERELAY_ANCESTOR_DIRS: computeAncestorChain(options.cwd, options.clientHomeDir).join(":"),
    CERELAY_SHARED_CLAUDE_DIR: process.env.CERELAY_SHARED_CLAUDE_DIR || "/home/node/.claude",
    CERELAY_SHARED_CLAUDE_JSON: process.env.CERELAY_SHARED_CLAUDE_JSON || "/home/node/.claude.json",
    CERELAY_PROJECT_SETTINGS_SOURCE: options.projectSettingsLocalShadowPath || "",
    CERELAY_FUSE_ROOT: options.fuseRootDir || "",
  };
}

/** @internal exported for testing */
export function buildMountNamespaceEnvForTest(
  options: BuildMountNamespaceEnvOptions
): Record<string, string | undefined> {
  return buildMountNamespaceEnv(options);
}

function topLevelName(filePath: string): string | null {
  if (!path.isAbsolute(filePath)) {
    return null;
  }
  const parts = filePath.split(path.sep).filter(Boolean);
  return parts[0] ?? null;
}

/** @internal exported for testing */
export function renderNamespaceBootstrapScript(): string {
  // meta-ifs-bug 测试用：在 ancestor 段前注入 _old_ifs="$IFS"，触发 set -u 下
  // IFS 已 unset 时的 "IFS: parameter not set" 退出。仅 e2e 主动 POST
  // /admin/test-toggles { injectIfsBug: true } 时启用，生产恒为 false。
  const ifsBugInjection = getTestToggles().injectIfsBug
    ? "    _old_ifs=\"$IFS\"\n"
    : "";
  return `#!/bin/sh
set -eu

echo "[bootstrap] start RUNTIME_ROOT=$CERELAY_RUNTIME_ROOT FUSE_ROOT=\${CERELAY_FUSE_ROOT:-none}" >&2

mkdir -p "$CERELAY_RUNTIME_ROOT/views" "$CERELAY_RUNTIME_ROOT/staged"

echo "[bootstrap] staging shared claude" >&2
if [ -d "$CERELAY_SHARED_CLAUDE_DIR" ]; then
  mkdir -p "$CERELAY_RUNTIME_ROOT/staged/claude"
  mount --rbind "$CERELAY_SHARED_CLAUDE_DIR" "$CERELAY_RUNTIME_ROOT/staged/claude"
fi

if [ -f "$CERELAY_SHARED_CLAUDE_JSON" ]; then
  : > "$CERELAY_RUNTIME_ROOT/staged/claude.json"
  mount --bind "$CERELAY_SHARED_CLAUDE_JSON" "$CERELAY_RUNTIME_ROOT/staged/claude.json"
fi

echo "[bootstrap] mounting view roots: $CERELAY_VIEW_ROOTS" >&2
IFS=':'
for root_name in $CERELAY_VIEW_ROOTS; do
  [ -n "$root_name" ] || continue
  mkdir -p "/$root_name" "$CERELAY_RUNTIME_ROOT/views/$root_name"
  mount --bind "$CERELAY_RUNTIME_ROOT/views/$root_name" "/$root_name"
done
unset IFS

mkdir -p "$CERELAY_HOME_DIR" "$CERELAY_WORK_DIR"

echo "[bootstrap] FUSE check: CERELAY_FUSE_ROOT=\${CERELAY_FUSE_ROOT:-}" >&2
# ---- FUSE 文件代理模式 vs 宿主机 bind mount 模式 ----
if [ -n "\${CERELAY_FUSE_ROOT:-}" ] && [ -d "$CERELAY_FUSE_ROOT/home-claude" ]; then
  echo "[bootstrap] FUSE mode: binding home-claude" >&2
  # FUSE 模式：从 FUSE 挂载点绑定 ~/.claude/ 和 {cwd}/.claude/
  mkdir -p "$CERELAY_HOME_DIR/.claude"
  mount --bind "$CERELAY_FUSE_ROOT/home-claude" "$CERELAY_HOME_DIR/.claude"

  echo "[bootstrap] FUSE mode: checking home-claude-json" >&2
  if [ -f "$CERELAY_FUSE_ROOT/home-claude-json" ]; then
    mkdir -p "$(dirname "$CERELAY_HOME_DIR/.claude.json")"
    : > "$CERELAY_HOME_DIR/.claude.json"
    mount --bind "$CERELAY_FUSE_ROOT/home-claude-json" "$CERELAY_HOME_DIR/.claude.json"
  fi

  echo "[bootstrap] FUSE mode: binding project-claude" >&2
  mkdir -p "$CERELAY_WORK_DIR/.claude"
  mount --bind "$CERELAY_FUSE_ROOT/project-claude" "$CERELAY_WORK_DIR/.claude"

  if [ -n "\${CERELAY_ANCESTOR_DIRS:-}" ]; then
    echo "[bootstrap] binding ancestor CLAUDE.md files" >&2
    # 注意：上方 view-roots 段已 \`unset IFS\`；在 \`set -u\` 下这里不能再用
    # 旧式 save-IFS 写法（_old_ifs=\$IFS）保存 IFS——会触发 "IFS: parameter
    # not set" 退出。沿用 view-roots 段的模式：临时设置 IFS=':' 用完后
    # \`unset IFS\` 还原默认（unset 等价于默认 IFS=空格/Tab/换行）。
${ifsBugInjection}    IFS=':'
    _anc_level=0
    for _anc_dir in $CERELAY_ANCESTOR_DIRS; do
      [ -n "$_anc_dir" ] || continue
      if [ "$_anc_dir" = "/" ]; then
        echo "[bootstrap] WARN: ancestor dir is fs root, skip" >&2
        _anc_level=$((_anc_level + 1))
        continue
      fi
      mkdir -p "$_anc_dir"
      for _anc_fname in CLAUDE.md CLAUDE.local.md; do
        _anc_fuse="$CERELAY_FUSE_ROOT/cwd-ancestor-$_anc_level/$_anc_fname"
        if [ -f "$_anc_fuse" ]; then
          echo "[bootstrap] binding $_anc_dir/$_anc_fname" >&2
          : > "$_anc_dir/$_anc_fname"
          mount --bind "$_anc_fuse" "$_anc_dir/$_anc_fname"
        fi
      done
      _anc_level=$((_anc_level + 1))
    done
    unset IFS
  fi
else
  echo "[bootstrap] legacy mode" >&2
  # 传统模式：从容器内宿主机 bind mount 挂载
  if [ -d "$CERELAY_RUNTIME_ROOT/staged/claude" ]; then
    mkdir -p "$CERELAY_HOME_DIR/.claude"
    mount --bind "$CERELAY_RUNTIME_ROOT/staged/claude" "$CERELAY_HOME_DIR/.claude"
  fi

  if [ -f "$CERELAY_RUNTIME_ROOT/staged/claude.json" ]; then
    mkdir -p "$(dirname "$CERELAY_HOME_DIR/.claude.json")"
    : > "$CERELAY_HOME_DIR/.claude.json"
    mount --bind "$CERELAY_RUNTIME_ROOT/staged/claude.json" "$CERELAY_HOME_DIR/.claude.json"
  fi
fi

echo "[bootstrap] hook injection check" >&2
# Hook injection overlay
# FUSE 模式下 settings.local.json 由 FUSE daemon 通过 shadow file 机制直接提供，
# 无需在只读 FUSE 上创建文件。仅传统模式需要 bind mount。
if [ -z "\${CERELAY_FUSE_ROOT:-}" ] && [ -n "\${CERELAY_PROJECT_SETTINGS_SOURCE:-}" ] && [ -f "$CERELAY_PROJECT_SETTINGS_SOURCE" ]; then
  echo "[bootstrap] hook: legacy mode bind mount" >&2
  mkdir -p "$CERELAY_WORK_DIR/.claude"
  : > "$CERELAY_WORK_DIR/.claude/settings.local.json"
  mount --bind "$CERELAY_PROJECT_SETTINGS_SOURCE" "$CERELAY_WORK_DIR/.claude/settings.local.json"
  echo "[bootstrap] hook: done" >&2
fi

echo "[bootstrap] writing ready file" >&2
touch "$CERELAY_READY_FILE"
exec sleep infinity
`;
}

async function waitForReadyFile(
  readyFile: string,
  anchor: ChildProcess,
  timeoutMs: number
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (anchor.exitCode !== null) {
      throw new Error(`namespace anchor 提前退出，exitCode=${anchor.exitCode}`);
    }

    if (existsSync(readyFile)) {
      await stat(readyFile);
      return;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`等待 namespace ready 文件超时: ${readyFile}`);
    }

    await sleep(50);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export function getClaudeSessionRuntimeRoot(sessionId: string): string {
  if (shouldUseMountNamespace() && process.platform === "linux") {
    const runtimeParent = process.env.CERELAY_NAMESPACE_RUNTIME_ROOT?.trim() || "/opt/cerelay-runtime";
    return path.join(runtimeParent, sanitizeSessionId(sessionId));
  }

  return path.join(tmpdir(), `cerelay-claude-${sanitizeSessionId(sessionId)}`);
}
