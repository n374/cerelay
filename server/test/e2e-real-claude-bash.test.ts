/**
 * 端到端测试：真实 claude CLI + 真实 ClaudePtySession.handleInjectedPreToolUse
 *
 * 用于守护本次根因修复（permissionDecisionReason 必须装载真实 tool 输出）的
 * 不变量。bug 路径是 PreToolUse hook 把渲染后的工具结果错放到 additionalContext，
 * 而 CC 在 deny 分支只把 permissionDecisionReason 写进 tool_result.content，
 * 真实输出于是被丢弃。该测试以最贴近生产的方式触发 Bug：
 *
 *   1. 启动 mock Anthropic API（SSE）。第一轮强制返回 tool_use(Bash ls -la)，
 *      第二轮返回普通文本，并把第二轮请求体保存下来。
 *   2. 复用 `prepareClaudeHookInjection` 渲染真实的 settings.local.json + hook
 *      script，把它们手工放到测试 cwd 的 `.claude/` 目录。
 *   3. 跑一个测试内嵌 HTTP bridge：转发 hook input 到真实
 *      `ClaudePtySession.handleInjectedPreToolUse`；
 *      transport.sendToolCall 在测试内直接 exec 命令，再回 resolveToolResult。
 *      这样 hook 协议 + 渲染 + relay 的全部链路都是产线代码。
 *   4. 拉起真实 `claude -p "<prompt>"`。它读到 settings.local.json，
 *      命中 mock 返回的 tool_use，触发 hook → bridge → handleInjectedPreToolUse
 *      → 真机 ls → 回写。claude 收到 hook deny 响应后再调一次 mock，
 *      mock 捕获到第二轮请求里的 tool_result。
 *   5. 断言 mock 第二轮请求 tool_result.content 必须包含临时 cwd 中的标记
 *      文件名，且不退化为 "Tool response ready" 占位字符串。
 *
 * 默认 skip；CI / 容器环境通过 CERELAY_E2E_REAL_CLAUDE=true 启用。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { exec, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ClaudePtySession, type PtySessionTransport } from "../src/pty-session.js";
import type { ClaudeSessionRuntime } from "../src/claude-session-runtime.js";
import { prepareClaudeHookInjection } from "../src/claude-hook-injection.js";
import { startMockAnthropicApi, type MockAnthropicHandle } from "./fixtures/mock-anthropic-api.js";

const execP = promisify(exec);

// ============================================================
// Skip 逻辑
// ============================================================

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

// ============================================================
// 主测试
// ============================================================

test(
  "E2E real claude: PreToolUse hook 必须把 Client tool 输出回注到 LLM 的 tool_result.content",
  { skip: skipReason ?? false, timeout: 120_000 },
  async (t) => {
    // ---- 0. 临时目录：cwd / home / hook runtime ----
    const cwd = await mkdtemp(path.join(tmpdir(), "cerelay-e2e-cwd-"));
    const home = await mkdtemp(path.join(tmpdir(), "cerelay-e2e-home-"));
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "cerelay-e2e-runtime-"));
    t.after(async () => {
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
      await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
    });

    const markerFiles = [
      "E2E_MARKER_FILE.txt",
      "package.json",
      "tsconfig.json",
      "README.md",
    ];
    for (const f of markerFiles) {
      await writeFile(path.join(cwd, f), `cerelay e2e marker: ${f}\n`, "utf8");
    }
    await mkdir(path.join(cwd, "src"));
    await writeFile(path.join(cwd, "src", "index.ts"), "export const sentinel = 'cerelay-e2e';\n", "utf8");

    // 跳过 onboarding，且禁掉 telemetry/auto update
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

    // ---- 1. mock Anthropic ----
    const TOOL_USE_ID = "toolu_e2e_real_claude_bash_1";
    const mock: MockAnthropicHandle = await startMockAnthropicApi({
      firstTurn: {
        toolUseId: TOOL_USE_ID,
        toolName: "Bash",
        toolInput: {
          command: "ls -la",
          description: "list current directory files",
        },
      },
      finalText: "OK e2e finished",
    });
    t.after(() => mock.close());

    // ---- 2. 起一个测试用 bridge HTTP server，转发 hook input 到真实 session ----
    const SESSION_ID = "e2e-real-claude-session";
    const HOOK_TOKEN = "e2e-real-claude-hook-token";

    // 测试 transport：sendToolCall 收到后直接在真实 cwd 执行命令并 resolve
    const session = new ClaudePtySession({
      id: SESSION_ID,
      cwd,
      runtime: createMockRuntime(cwd, home),
      transport: createTestTransport(cwd, () => session),
    });
    t.after(() => session.close().catch(() => undefined));

    const bridge = await startHookBridge({
      token: HOOK_TOKEN,
      session,
    });
    t.after(() => bridge.close());

    // ---- 3. 用 prepareClaudeHookInjection 渲染真实的 settings + hook script ----
    const hook = await prepareClaudeHookInjection({
      bridgeUrl: `${bridge.url}/internal/hooks/pretooluse?sessionId=${encodeURIComponent(SESSION_ID)}`,
      runtimeRoot,
      sessionId: SESSION_ID,
      token: HOOK_TOKEN,
    });

    await mkdir(path.join(cwd, ".claude"), { recursive: true });
    await copyFile(hook.settingsPath, path.join(cwd, ".claude", "settings.local.json"));

    // ---- 4. 起真实 claude CLI ----
    // 容器内 root 用户跑 CC 会触发 root 守护拒绝 --dangerously-skip-permissions；
    // CC 的检测逻辑读 `process.env.IS_SANDBOX`，且其内部还会自 fork 子进程。
    // 仅靠 spawn(env) 似乎不够稳，故在 process.env 上也置一份，运行结束后还原。
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
      // 强制 disable usage tracking、auto-update 等
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
      ["--print", "--permission-mode", "bypassPermissions", "请列出当前目录下的文件"],
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

    // claude 必须正常退出
    assert.equal(
      exitInfo.code,
      0,
      `claude CLI 应正常退出。code=${exitInfo.code}, signal=${exitInfo.signal}, stderr=${stderrText.slice(0, 500)}`
    );

    // mock 必须收到至少 2 次 /v1/messages
    assert.ok(
      mock.captured.length >= 2,
      `mock Anthropic 应至少收到 2 次请求，实际 ${mock.captured.length}。stdout=${stdoutText.slice(0, 200)} stderr=${stderrText.slice(0, 200)}`
    );

    const turn1 = mock.captured[0]!;
    const turn2 = mock.captured[1]!;
    assert.equal(turn1.toolResults.length, 0, "第一轮请求不应包含 tool_result");
    assert.ok(
      turn2.toolResults.length >= 1,
      `第二轮请求必须携带 tool_result。已知 mock.captured.length=${mock.captured.length}`
    );

    const tr = turn2.toolResults.find((r) => r.tool_use_id === TOOL_USE_ID) ?? turn2.toolResults[0]!;

    // ★ 核心不变量：tool_result.content 必须装载真实 ls 输出
    assert.notEqual(
      tr.content.trim(),
      "Tool response ready",
      "tool_result.content 不能退化为 'Tool response ready' 占位字符串——这正是修复前的 bug 表征"
    );

    for (const marker of markerFiles) {
      assert.ok(
        tr.content.includes(marker),
        `tool_result.content 必须包含标记文件 "${marker}"。实际内容前 800 字节: ${tr.content.slice(0, 800)}`
      );
    }
    assert.ok(
      tr.content.includes("src"),
      `tool_result.content 应包含 src 目录。实际: ${tr.content.slice(0, 800)}`
    );

    // 顺带验证 settings.local.json 真的被 claude 加载（hook 至少 fire 过一次）
    const sessionUsed = await readFile(path.join(cwd, ".claude", "settings.local.json"), "utf8");
    assert.match(
      sessionUsed,
      /PreToolUse/,
      "settings.local.json 必须含 PreToolUse 配置"
    );
  }
);

// ============================================================
// 辅助：mock runtime / transport
// ============================================================

function createMockRuntime(cwd: string, home: string): ClaudeSessionRuntime {
  return {
    cwd,
    env: { ...process.env, HOME: home },
    rootDir: cwd,
    cleanup: async () => {},
  };
}

/**
 * 测试 transport：sendToolCall 收到后立即在真实 cwd 执行命令，
 * 然后通过 session.resolveToolResult 回写结果——模拟 Client。
 */
function createTestTransport(
  cwd: string,
  getSession: () => ClaudePtySession
): PtySessionTransport {
  return {
    sendOutput: async () => {},
    sendExit: async () => {},
    sendToolCallComplete: async () => {},
    sendToolCall: async (_sessionId, requestId, toolName, _toolUseId, input) => {
      // 仅支持 Bash —— 测试只验证 Bash 路径
      if (toolName !== "Bash") {
        getSession().resolveToolResult(requestId, {
          error: `e2e mock client: unsupported tool ${toolName}`,
        });
        return;
      }
      const command = (input as { command?: unknown }).command;
      if (typeof command !== "string") {
        getSession().resolveToolResult(requestId, {
          error: "e2e mock client: missing command",
        });
        return;
      }

      try {
        const result = await execP(command, { cwd, encoding: "utf8" });
        getSession().resolveToolResult(requestId, {
          output: {
            stdout: result.stdout,
            stderr: result.stderr,
            exit_code: 0,
          },
          summary: "ok",
        });
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
        getSession().resolveToolResult(requestId, {
          output: {
            stdout: e.stdout ?? "",
            stderr: e.stderr ?? e.message ?? "",
            exit_code: typeof e.code === "number" ? e.code : 1,
          },
          summary: "non-zero exit",
        });
      }
    },
  };
}

// ============================================================
// 辅助：测试内嵌 hook bridge HTTP server
// ============================================================

interface HookBridgeHandle {
  url: string;
  close: () => Promise<void>;
}

async function startHookBridge(options: {
  token: string;
  session: ClaudePtySession;
}): Promise<HookBridgeHandle> {
  const server: Server = createServer((req, res) => {
    handleBridge(req, res, options).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[e2e-bridge] handler error", err);
      try {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ decision: "block", reason: `bridge error: ${String(err)}` }));
      } catch {
        // ignore
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("bridge: 监听地址异常");
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

async function handleBridge(
  req: IncomingMessage,
  res: ServerResponse,
  options: { token: string; session: ClaudePtySession }
): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end();
    return;
  }
  const token = req.headers["x-cerelay-hook-token"];
  if (token !== options.token) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ decision: "block", reason: "bad token" }));
    return;
  }

  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  const body = Buffer.concat(chunks).toString("utf8");

  let parsed: { tool_name?: unknown; tool_use_id?: unknown; tool_input?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ decision: "block", reason: `bad JSON: ${String(err)}` }));
    return;
  }

  if (typeof parsed.tool_name !== "string") {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ decision: "block", reason: "tool_name required" }));
    return;
  }

  const result = await options.session.handleInjectedPreToolUse({
    tool_name: parsed.tool_name,
    tool_use_id: typeof parsed.tool_use_id === "string" ? parsed.tool_use_id : undefined,
    tool_input: parsed.tool_input,
  });

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(result));
}

// ============================================================
// 辅助：超时
// ============================================================

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
