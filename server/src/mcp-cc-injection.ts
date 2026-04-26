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
 * 解析 cerelay-routed 子进程入口：优先编译产物 dist/mcp-routed/index.js，
 * dev 环境 fallback 到 src/mcp-routed/index.ts + tsx loader。
 *
 * 容器场景：build 时已经 tsc 编译，所以 dist 路径会存在。
 * 单元测试 / 本地 dev：dist 可能不存在，走 tsx loader 跑 ts 入口。
 */
export function resolveShadowMcpLaunchSpec(): ShadowMcpLaunchSpec {
  // HERE 在 dev (tsx) 是 server/src，在 prod (tsc 编译) 是 server/dist。
  // 两种场景都从 HERE 出发尝试同 sibling 的 mcp-routed 子目录。
  const compiledEntry = path.resolve(HERE, "./mcp-routed/index.js");
  if (existsSync(compiledEntry)) {
    return { command: process.execPath, args: [compiledEntry] };
  }
  const tsEntry = path.resolve(HERE, "./mcp-routed/index.ts");
  if (existsSync(tsEntry)) {
    return { command: process.execPath, args: ["--import", "tsx", tsEntry] };
  }
  throw new Error(
    `无法定位 cerelay-routed MCP 子进程入口：dist (${compiledEntry}) / src (${tsEntry}) 都不存在`,
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
 * 一次性把 Plan D §4.3 的三组 CLI flag 拼出来，pty-session 调用。
 */
export function buildShadowMcpInjectionArgs(input: ShadowMcpConfigInput): string[] {
  return [
    "--mcp-config",
    buildMcpConfigJson(input),
    "--append-system-prompt",
    buildSteeringPrompt(),
    "--disallowedTools",
    SHADOWED_BUILTIN_TOOLS.join(","),
  ];
}
