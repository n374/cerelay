import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createLogger } from "./logger.js";

const log = createLogger("claude-runtime");
const DEFAULT_READY_TIMEOUT_MS = 5_000;

interface SpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}

type SpawnedProcess = ChildProcess;

export interface ClaudeSessionRuntime {
  cwd: string;
  env: Record<string, string | undefined>;
  spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess;
  cleanup(): Promise<void>;
}

export interface CreateClaudeSessionRuntimeOptions {
  sessionId: string;
  cwd: string;
  handHomeDir?: string;
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
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), `axon-claude-${sanitizeSessionId(options.sessionId)}-`));
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
    await rm(runtimeRoot, { recursive: true, force: true });
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
    spawnClaudeCodeProcess: (spawnOptions) => spawnClaudeInNamespace(anchor, spawnOptions, options.cwd),
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
      stdio: ["pipe", "pipe", "pipe"],
      signal: options.signal,
    }
  );
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

mkdir -p "$AXON_RUNTIME_ROOT/views" "$AXON_RUNTIME_ROOT/staged"

if [ -d "$AXON_SHARED_CLAUDE_DIR" ]; then
  mkdir -p "$AXON_RUNTIME_ROOT/staged/claude"
  mount --bind "$AXON_SHARED_CLAUDE_DIR" "$AXON_RUNTIME_ROOT/staged/claude"
fi

if [ -f "$AXON_SHARED_CLAUDE_JSON" ]; then
  : > "$AXON_RUNTIME_ROOT/staged/claude.json"
  mount --bind "$AXON_SHARED_CLAUDE_JSON" "$AXON_RUNTIME_ROOT/staged/claude.json"
fi

IFS=':'
for root_name in $AXON_VIEW_ROOTS; do
  [ -n "$root_name" ] || continue
  mkdir -p "/$root_name" "$AXON_RUNTIME_ROOT/views/$root_name"
  mount --bind "$AXON_RUNTIME_ROOT/views/$root_name" "/$root_name"
done
unset IFS

mkdir -p "$AXON_HOME_DIR" "$AXON_WORK_DIR"

if [ -d "$AXON_RUNTIME_ROOT/staged/claude" ]; then
  mkdir -p "$AXON_HOME_DIR/.claude"
  mount --bind "$AXON_RUNTIME_ROOT/staged/claude" "$AXON_HOME_DIR/.claude"
fi

if [ -f "$AXON_RUNTIME_ROOT/staged/claude.json" ]; then
  mkdir -p "$(dirname "$AXON_HOME_DIR/.claude.json")"
  : > "$AXON_HOME_DIR/.claude.json"
  mount --bind "$AXON_RUNTIME_ROOT/staged/claude.json" "$AXON_HOME_DIR/.claude.json"
fi

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
