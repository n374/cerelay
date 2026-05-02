// ============================================================
// 把 cerelay-routed MCP shadow 工具注入到 Claude Code CLI 启动参数
// Inject cerelay-routed MCP shadow tools into Claude Code CLI launch args.
//
// 输出三件套（Plan D §4.3 / §4.4）:
//   --mcp-config '<json>'         告诉 CC spawn 我们的 mcp-routed 子进程
//   --append-system-prompt <text> 软引导模型用 mcp__cerelay__* 替代内置工具
//   --disallowedTools <list>      硬保险：内置 Bash/Read/... 一律拒绝
// ============================================================

import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { SHADOW_TOOLS, fullyQualifiedShadowToolName } from "./mcp-routed/schemas.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 镜像的 CC 内置工具名集合（与 SHADOW_TOOLS 对应的 builtinName）。 */
export const SHADOWED_BUILTIN_TOOLS: readonly string[] = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Glob",
  "Grep",
];

export interface ShadowMcpLaunchSpec {
  command: string;
  args: string[];
}

/**
 * 解析 cerelay-routed 子进程入口：优先编译产物（不依赖 cwd-aware tsx loader）。
 *
 * - prod (tsc 编译产物执行)：HERE = server/dist，./mcp-routed/index.js 是 sibling
 * - dev (tsx 直跑 src)：HERE = server/src，编译产物在 ../dist/mcp-routed/index.js
 * - dev 且未 prebuild：fallback 到 src/mcp-routed/index.ts + tsx loader
 *
 * 注意 tsx fallback 路径有 cwd 依赖——CC 通过 --mcp-config spawn 子进程时 cwd
 * 是用户 cwd 而非 server/。tsx 包通过 nodejs module resolution 可能找不到。
 * 因此容器 e2e 必须先 `npm run build --workspace=cerelay-server` 让 dist 路径生效。
 */
export function resolveShadowMcpLaunchSpec(): ShadowMcpLaunchSpec {
  const compiledCandidates = [
    path.resolve(HERE, "./mcp-routed/index.js"),       // prod: dist sibling
    path.resolve(HERE, "../dist/mcp-routed/index.js"), // dev with prebuild
  ];
  for (const candidate of compiledCandidates) {
    if (existsSync(candidate)) {
      return { command: process.execPath, args: [candidate] };
    }
  }
  const tsEntry = path.resolve(HERE, "./mcp-routed/index.ts");
  if (existsSync(tsEntry)) {
    return { command: process.execPath, args: ["--import", "tsx", tsEntry] };
  }
  throw new Error(
    `无法定位 cerelay-routed MCP 子进程入口：dist 候选 (${compiledCandidates.join(" / ")}) 与 src (${tsEntry}) 均不存在`,
  );
}

export interface ShadowMcpConfigInput {
  sessionId: string;
  socketPath: string;
  token: string;
  /** 测试 / dev 用：override launch spec */
  launchSpec?: ShadowMcpLaunchSpec;
}

/**
 * 生成 `--mcp-config` 接受的 inline JSON。CC 会把这里的每个 server spawn 起来。
 * env 通过 IPC socket / token 让子进程能连回主进程。
 */
export function buildMcpConfigJson(input: ShadowMcpConfigInput): string {
  const launch = input.launchSpec ?? resolveShadowMcpLaunchSpec();
  return JSON.stringify({
    mcpServers: {
      cerelay: {
        command: launch.command,
        args: launch.args,
        env: {
          CERELAY_MCP_IPC_SOCKET: input.socketPath,
          CERELAY_MCP_IPC_TOKEN: input.token,
          CERELAY_MCP_SESSION_ID: input.sessionId,
        },
      },
    },
  });
}

/**
 * `--append-system-prompt` 注入的软引导文案：告诉模型用 mcp__cerelay__*
 * 替代内置工具。Plan §4.4——append 而非 replace，保留 CC 自带的 system prompt
 * （permissions / TUI hint / skills 都不动）。
 */
export function buildSteeringPrompt(): string {
  const lines: string[] = [
    "<cerelay-tool-routing-policy>",
    "This session runs in a sandboxed runtime. The standard built-in tools",
    "(Bash, Read, Write, Edit, MultiEdit, Glob, Grep) are NOT available here—",
    "calling them will fail with a permission denial. Use the mcp__cerelay__*",
    "equivalents instead, which have identical schemas and route to the user's",
    "actual workspace via the cerelay tool relay:",
    "",
  ];
  for (const tool of SHADOW_TOOLS) {
    lines.push(`  ${tool.builtinName.padEnd(10)} → ${fullyQualifiedShadowToolName(tool.shortName)}`);
  }
  lines.push(
    "",
    "User-installed MCP servers (mcp__<other>__*) work normally; do not",
    "substitute them with cerelay tools.",
    "</cerelay-tool-routing-policy>",
  );
  return lines.join("\n");
}

/**
 * 一次性把 Plan D §4.3 的 CLI flag 拼出来，pty-session 调用。
 *
 * `oneShot=true`（即 server 把 prompt 透传到 `claude -p <prompt>`）时额外
 * 注入 `--allowedTools mcp__cerelay__*`：
 *   - 一次性模式（-p）下 CC 没有 UI 给用户授权 mcp tool，默认 deny → tool_result
 *     "haven't granted it yet"，session 中断。auto-permit 全部 shadow tool 才能跑通
 *   - 交互模式（默认 oneShot=false）保持 CC 的原生权限询问体验，让用户首次使用
 *     mcp__cerelay__bash 时弹出"Claude requested permission"，授权后 CC 自己持久化
 *
 * 安全：仅 one-shot 路径放权。即便如此，shadow tool 实际执行也还在 client 本地，
 * cerelay 只做转发，没有权限放大。
 */
export function buildShadowMcpInjectionArgs(
  input: ShadowMcpConfigInput,
  options?: { oneShot?: boolean }
): string[] {
  const args: string[] = [
    "--mcp-config",
    buildMcpConfigJson(input),
    "--append-system-prompt",
    buildSteeringPrompt(),
    "--disallowedTools",
    SHADOWED_BUILTIN_TOOLS.join(","),
  ];
  if (options?.oneShot) {
    const allowedShadowTools = SHADOW_TOOLS
      .map((tool) => fullyQualifiedShadowToolName(tool.shortName))
      .join(",");
    args.push("--allowedTools", allowedShadowTools);
  }
  return args;
}

/**
 * Plan D §4.5：shadow MCP 启用时模型违规调内置 Bash/Read/... 走到 PreToolUse
 * hook，cerelay 直接 deny 并把 permissionDecisionReason 设成"用 mcp__cerelay__X
 * 替代"的强提示，让模型下一轮改用正确工具。
 *
 * 返回 null 表示该 builtinName 不在 shadow 范围（无对应 mcp__cerelay__ 工具，
 * 应该走原来的 client-routed 转发链）。
 */
export function buildShadowFallbackReason(builtinName: string): string | null {
  const shadow = SHADOW_TOOLS.find((tool) => tool.builtinName === builtinName);
  if (!shadow) {
    return null;
  }
  const fqn = fullyQualifiedShadowToolName(shadow.shortName);
  return (
    `Tool '${builtinName}' is not available in this sandboxed runtime. ` +
    `Use ${fqn} instead—it has the same schema and routes to the user's actual ` +
    `workspace via the cerelay tool relay.`
  );
}

/** SHADOWED_BUILTIN_TOOLS 的 Set 形式，pty-session 快速判断用。 */
export const SHADOWED_BUILTIN_TOOL_SET = new Set<string>(SHADOWED_BUILTIN_TOOLS);
