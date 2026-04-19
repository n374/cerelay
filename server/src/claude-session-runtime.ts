import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createLogger } from "./logger.js";

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
  handHomeDir?: string;
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
  const effectiveHome = options.handHomeDir && existsSync(options.handHomeDir)
    ? options.handHomeDir
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
  const runtimeParent = process.env.AXON_NAMESPACE_RUNTIME_ROOT?.trim() || "/opt/axon-runtime";
  const runtimeRoot = path.join(runtimeParent, sanitizeSessionId(options.sessionId));
  const scriptPath = path.join(runtimeRoot, "bootstrap.sh");
  const readyFile = path.join(runtimeRoot, "ready");
  const handHomeDir = options.handHomeDir?.trim() || process.env.HOME || "/home/node";
  const viewRoots = collectViewRoots(handHomeDir, options.cwd);

  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(scriptPath, renderNamespaceBootstrapScript(), "utf8");
  await chmod(scriptPath, 0o755);

  const anchor = spawn(
    "unshare",
    ["--mount", "--propagation", "private", "--", "/bin/sh", scriptPath],
    {
      env: {
        ...process.env,
        AXON_RUNTIME_ROOT: runtimeRoot,
        AXON_READY_FILE: readyFile,
        AXON_HOME_DIR: handHomeDir,
        AXON_WORK_DIR: options.cwd,
        AXON_VIEW_ROOTS: viewRoots.join(":"),
        AXON_SHARED_CLAUDE_DIR: process.env.AXON_SHARED_CLAUDE_DIR || "/home/node/.claude",
        AXON_SHARED_CLAUDE_JSON: process.env.AXON_SHARED_CLAUDE_JSON || "/home/node/.claude.json",
        AXON_PROJECT_SETTINGS_SOURCE: options.projectSettingsLocalShadowPath || "",
        AXON_FUSE_ROOT: options.fuseRootDir || "",
      },
      stdio: ["ignore", "ignore", "pipe"],
    }
  );

  const stderrChunks: Buffer[] = [];
  anchor.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(Buffer.from(chunk));
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
    homeDir: handHomeDir,
    viewRoots,
  });

  return {
    cwd: options.cwd,
    env: {
      ...process.env,
      HOME: handHomeDir,
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
      'cd "$AXON_TARGET_CWD" && exec "$0" "$@"',
      options.command,
      ...options.args,
    ],
    {
      env: {
        ...options.env,
        AXON_TARGET_CWD: targetCwd,
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
  return process.env.AXON_ENABLE_MOUNT_NAMESPACE === "true";
}

function collectViewRoots(...paths: string[]): string[] {
  return Array.from(new Set(
    paths
      .map(topLevelName)
      .filter((value): value is string => Boolean(value))
  ));
}

function topLevelName(filePath: string): string | null {
  if (!path.isAbsolute(filePath)) {
    return null;
  }
  const parts = filePath.split(path.sep).filter(Boolean);
  return parts[0] ?? null;
}

function renderNamespaceBootstrapScript(): string {
  return `#!/bin/sh
set -eu

echo "[bootstrap] start RUNTIME_ROOT=$AXON_RUNTIME_ROOT FUSE_ROOT=\${AXON_FUSE_ROOT:-none}" >&2

mkdir -p "$AXON_RUNTIME_ROOT/views" "$AXON_RUNTIME_ROOT/staged"

echo "[bootstrap] staging shared claude" >&2
if [ -d "$AXON_SHARED_CLAUDE_DIR" ]; then
  mkdir -p "$AXON_RUNTIME_ROOT/staged/claude"
  mount --bind "$AXON_SHARED_CLAUDE_DIR" "$AXON_RUNTIME_ROOT/staged/claude"
fi

if [ -f "$AXON_SHARED_CLAUDE_JSON" ]; then
  : > "$AXON_RUNTIME_ROOT/staged/claude.json"
  mount --bind "$AXON_SHARED_CLAUDE_JSON" "$AXON_RUNTIME_ROOT/staged/claude.json"
fi

echo "[bootstrap] mounting view roots: $AXON_VIEW_ROOTS" >&2
IFS=':'
for root_name in $AXON_VIEW_ROOTS; do
  [ -n "$root_name" ] || continue
  mkdir -p "/$root_name" "$AXON_RUNTIME_ROOT/views/$root_name"
  mount --bind "$AXON_RUNTIME_ROOT/views/$root_name" "/$root_name"
done
unset IFS

mkdir -p "$AXON_HOME_DIR" "$AXON_WORK_DIR"

echo "[bootstrap] FUSE check: AXON_FUSE_ROOT=\${AXON_FUSE_ROOT:-}" >&2
# ---- FUSE 文件代理模式 vs 宿主机 bind mount 模式 ----
if [ -n "\${AXON_FUSE_ROOT:-}" ] && [ -d "$AXON_FUSE_ROOT/home-claude" ]; then
  echo "[bootstrap] FUSE mode: binding home-claude" >&2
  # FUSE 模式：从 FUSE 挂载点绑定 ~/.claude/ 和 {cwd}/.claude/
  mkdir -p "$AXON_HOME_DIR/.claude"
  mount --bind "$AXON_FUSE_ROOT/home-claude" "$AXON_HOME_DIR/.claude"

  echo "[bootstrap] FUSE mode: checking home-claude-json" >&2
  if [ -f "$AXON_FUSE_ROOT/home-claude-json" ]; then
    mkdir -p "$(dirname "$AXON_HOME_DIR/.claude.json")"
    : > "$AXON_HOME_DIR/.claude.json"
    mount --bind "$AXON_FUSE_ROOT/home-claude-json" "$AXON_HOME_DIR/.claude.json"
  fi

  echo "[bootstrap] FUSE mode: binding project-claude" >&2
  mkdir -p "$AXON_WORK_DIR/.claude"
  mount --bind "$AXON_FUSE_ROOT/project-claude" "$AXON_WORK_DIR/.claude"
else
  echo "[bootstrap] legacy mode" >&2
  # 传统模式：从容器内宿主机 bind mount 挂载
  if [ -d "$AXON_RUNTIME_ROOT/staged/claude" ]; then
    mkdir -p "$AXON_HOME_DIR/.claude"
    mount --bind "$AXON_RUNTIME_ROOT/staged/claude" "$AXON_HOME_DIR/.claude"
  fi

  if [ -f "$AXON_RUNTIME_ROOT/staged/claude.json" ]; then
    mkdir -p "$(dirname "$AXON_HOME_DIR/.claude.json")"
    : > "$AXON_HOME_DIR/.claude.json"
    mount --bind "$AXON_RUNTIME_ROOT/staged/claude.json" "$AXON_HOME_DIR/.claude.json"
  fi
fi

echo "[bootstrap] hook injection check" >&2
# Hook injection overlay
# FUSE 模式下 settings.local.json 由 FUSE daemon 通过 shadow file 机制直接提供，
# 无需在只读 FUSE 上创建文件。仅传统模式需要 bind mount。
if [ -z "\${AXON_FUSE_ROOT:-}" ] && [ -n "\${AXON_PROJECT_SETTINGS_SOURCE:-}" ] && [ -f "$AXON_PROJECT_SETTINGS_SOURCE" ]; then
  echo "[bootstrap] hook: legacy mode bind mount" >&2
  mkdir -p "$AXON_WORK_DIR/.claude"
  : > "$AXON_WORK_DIR/.claude/settings.local.json"
  mount --bind "$AXON_PROJECT_SETTINGS_SOURCE" "$AXON_WORK_DIR/.claude/settings.local.json"
  echo "[bootstrap] hook: done" >&2
fi

echo "[bootstrap] writing ready file" >&2
touch "$AXON_READY_FILE"
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
    const runtimeParent = process.env.AXON_NAMESPACE_RUNTIME_ROOT?.trim() || "/opt/axon-runtime";
    return path.join(runtimeParent, sanitizeSessionId(sessionId));
  }

  return path.join(tmpdir(), `axon-claude-${sanitizeSessionId(sessionId)}`);
}
