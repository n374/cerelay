/**
 * 端到端测试（Plan D）：真实 claude CLI + cerelay-routed MCP 子进程
 *
 * 守护 Plan D 的核心不变量：当模型调用 mcp__cerelay__bash 时，反馈给 LLM 的
 * tool_result 必须 is_error: false（与 legacy hook 路径的 is_error: true 形成
 * 对照）。这是 plan §1.4 / §5 列出的"PreToolUse hook 协议硬约束下唯一靠谱的
 * 修复路径"。
 *
 * 流程:
 *   1. 启动 mock Anthropic API。第一轮强制返回 tool_use(mcp__cerelay__bash, ls -la)
 *   2. 启动 MCPIpcHost（per-test）+ dispatcher：直接在测试 cwd 内 exec 命令
 *   3. 用 buildShadowMcpInjectionArgs 拼 --mcp-config / --append-system-prompt /
 *      --disallowedTools 三件套
 *   4. spawn 真实 claude CLI；CC 通过 stdio JSON-RPC 跟我们 spawn 的 mcp-routed
 *      子进程握手，模型调 mcp__cerelay__bash → 子进程 → IPC → dispatcher → exec
 *   5. CC 第二轮 messages 请求带 tool_result；mock 捕获后断言：
 *      - is_error === false（核心，对照 legacy hook 的 is_error === true）
 *      - content 含临时 cwd 中的 marker 文件名
 *
 * 默认 skip；CI / 容器环境通过 CERELAY_E2E_REAL_CLAUDE=true 启用。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { exec, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  MCPIpcHost,
  buildMcpIpcSocketPath,
  type ToolCallDispatcher,
} from "../src/mcp-ipc-host.js";
import { buildShadowMcpInjectionArgs } from "../src/mcp-cc-injection.js";
import { startMockAnthropicApi, type MockAnthropicHandle } from "./fixtures/mock-anthropic-api.js";

const execP = promisify(exec);

const explicitlyEnabled = process.env.CERELAY_E2E_REAL_CLAUDE === "true";
const claudeBin = resolveClaudeExecutable();

const skipReason = !explicitlyEnabled
  ? "需 CERELAY_E2E_REAL_CLAUDE=true 才会启用真实 claude CLI 测试"
  : !claudeBin
  ? "未在常见路径下找到 claude 可执行文件，请通过 CLAUDE_CODE_EXECUTABLE 指向"
  : null;

function resolveClaudeExecutable(): string | null {
  const explicit = process.env.CLAUDE_CODE_EXECUTABLE?.trim();
  if (explicit && existsSync(explicit)) return explicit;
  const candidates = [
    "/usr/local/bin/claude",
    "/usr/bin/claude",
    `${process.env.HOME ?? ""}/.local/bin/claude`,
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

test(
  "Plan D E2E real claude: mcp__cerelay__bash → tool_result.is_error 必须为 false",
  { skip: skipReason ?? false, timeout: 120_000 },
  async (t) => {
    // ---- 0. 临时目录 + marker 文件 ----
    const cwd = await mkdtemp(path.join("/tmp", "cerelay-e2e-mcp-cwd-"));
    const home = await mkdtemp(path.join("/tmp", "cerelay-e2e-mcp-home-"));
    const socketDir = await mkdtemp(path.join("/tmp", "cerelay-e2e-mcp-sock-"));
    t.after(async () => {
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
      await rm(socketDir, { recursive: true, force: true }).catch(() => undefined);
    });

    const markerFiles = [
      "PLAN_D_MARKER.txt",
      "package.json",
      "tsconfig.json",
      "README.md",
    ];
    for (const f of markerFiles) {
      await writeFile(path.join(cwd, f), `cerelay plan-d e2e: ${f}\n`, "utf8");
    }
    await mkdir(path.join(cwd, "src"));
    await writeFile(path.join(cwd, "src", "index.ts"), "export const sentinel = 'cerelay-plan-d';\n", "utf8");

    // 跳过 onboarding
    await writeFile(
      path.join(home, ".claude.json"),
      JSON.stringify({
        hasCompletedOnboarding: true,
        installMethod: "test",
        autoUpdaterStatus: "disabled",
      }) + "\n",
      "utf8"
    );
    await mkdir(path.join(home, ".claude"), { recursive: true });

    // ---- 1. mock Anthropic：第一轮强制 tool_use(mcp__cerelay__bash, ls -la) ----
    const TOOL_USE_ID = "toolu_plan_d_mcp_shadow_bash";
    const mock: MockAnthropicHandle = await startMockAnthropicApi({
      firstTurn: {
        toolUseId: TOOL_USE_ID,
        toolName: "mcp__cerelay__bash",
        toolInput: {
          command: "ls -la",
        },
      },
      finalText: "OK plan-d e2e finished",
    });
    t.after(() => mock.close());

    // ---- 2. 启动 MCPIpcHost（test 进程内）+ dispatcher 直接 exec ----
    const SESSION_ID = `e2e-mcp-${randomUUID()}`;
    const SOCKET_PATH = buildMcpIpcSocketPath(socketDir, SESSION_ID);
    const TOKEN = `e2e-token-${randomUUID()}`;

    const dispatcher: ToolCallDispatcher = async (toolName, input) => {
      if (toolName !== "Bash") {
        return { error: `e2e dispatcher: unsupported tool ${toolName}` };
      }
      const command = (input as { command?: unknown }).command;
      if (typeof command !== "string") {
        return { error: "e2e dispatcher: missing command" };
      }
      try {
        const result = await execP(command, { cwd, encoding: "utf8" });
        return {
          output: { stdout: result.stdout, stderr: result.stderr, exit_code: 0 },
        };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
        return {
          output: {
            stdout: e.stdout ?? "",
            stderr: e.stderr ?? e.message ?? "",
            exit_code: typeof e.code === "number" ? e.code : 1,
          },
        };
      }
    };

    const host = new MCPIpcHost({
      sessionId: SESSION_ID,
      socketPath: SOCKET_PATH,
      token: TOKEN,
      dispatcher,
    });
    await host.start();
    t.after(() => host.close().catch(() => undefined));

    // ---- 3. 拼 CC CLI flags ----
    const injectionArgs = buildShadowMcpInjectionArgs({
      sessionId: SESSION_ID,
      socketPath: SOCKET_PATH,
      token: TOKEN,
    });

    // ---- 4. 起真实 claude CLI ----
    const previousIsSandbox = process.env.IS_SANDBOX;
    process.env.IS_SANDBOX = "1";
    t.after(() => {
      if (previousIsSandbox === undefined) delete process.env.IS_SANDBOX;
      else process.env.IS_SANDBOX = previousIsSandbox;
    });

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOME: home,
      ANTHROPIC_API_KEY: "sk-test-mock-key",
      ANTHROPIC_BASE_URL: mock.url,
      DISABLE_TELEMETRY: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      IS_SANDBOX: "1",
    };
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.CLAUDE_CODE_USE_BEDROCK;
    delete env.CLAUDE_CODE_USE_VERTEX;

    const claudeStdout: Buffer[] = [];
    const claudeStderr: Buffer[] = [];
    const child = spawn(
      claudeBin!,
      [
        "--print",
        "--permission-mode", "bypassPermissions",
        ...injectionArgs,
        "请用 mcp__cerelay__bash 列出当前目录下的文件",
      ],
      {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    child.stdout?.on("data", (chunk: Buffer) => claudeStdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => claudeStderr.push(Buffer.from(chunk)));

    const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const exitInfo = await raceWithTimeout(childExit, 90_000, "等待 claude CLI 退出超时");

    const stdoutText = Buffer.concat(claudeStdout).toString("utf8");
    const stderrText = Buffer.concat(claudeStderr).toString("utf8");

    // ---- 5. 断言 ----

    assert.equal(
      exitInfo.code,
      0,
      `claude CLI 应正常退出。code=${exitInfo.code}, signal=${exitInfo.signal}, stderr=${stderrText.slice(0, 800)}`
    );

    assert.ok(
      mock.captured.length >= 2,
      `mock Anthropic 应至少收到 2 次请求，实际 ${mock.captured.length}。stdout=${stdoutText.slice(0, 200)} stderr=${stderrText.slice(0, 800)}`
    );

    const turn1 = mock.captured[0]!;
    const turn2 = mock.captured[1]!;
    assert.equal(turn1.toolResults.length, 0, "第一轮请求不应包含 tool_result");
    assert.ok(
      turn2.toolResults.length >= 1,
      `第二轮请求必须携带 tool_result，实际 ${turn2.toolResults.length}`
    );

    const tr = turn2.toolResults.find((r) => r.tool_use_id === TOOL_USE_ID) ?? turn2.toolResults[0]!;

    // ★★★ 核心不变量：is_error === false，与 legacy hook 路径形成对照 ★★★
    assert.equal(
      tr.is_error,
      false,
      `Plan D 核心不变量违反：mcp__cerelay__bash 路径下 tool_result.is_error 必须是 false。` +
      `legacy hook 路径会是 true（参见 e2e-real-claude-bash.test.ts），那是 deny+reason 的协议性副作用；` +
      `MCP 路径走 stdio CallToolResult，isError 由 cerelay 显式控制。实际 is_error=${tr.is_error}, content=${tr.content.slice(0, 400)}`
    );

    // 内容必须真实（说明 dispatcher 真的转发到 exec ls 而不是空内容）
    for (const marker of markerFiles) {
      assert.ok(
        tr.content.includes(marker),
        `tool_result.content 必须包含标记文件 "${marker}"。实际前 800 字节: ${tr.content.slice(0, 800)}`
      );
    }
    assert.ok(
      tr.content.includes("src"),
      `tool_result.content 应包含 src 目录。实际: ${tr.content.slice(0, 800)}`
    );
  }
);

function raceWithTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}（${ms}ms）`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
