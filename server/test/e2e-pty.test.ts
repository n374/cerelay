import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import WebSocket from "ws";
import { CerelayServer } from "../src/server.js";
import { getClaudeSessionRuntimeRoot } from "../src/claude-session-runtime.js";
import { writeFakeClaudePty, type FakeClaudePtyHandle } from "./fixtures/fake-claude-pty.js";

// ============================================================
// PTY 端到端测试
//
// 覆盖原 SDK e2e-hand / e2e-hand-mock-api / e2e-tool-access 的场景：
//   - PTY session 创建 + 生命周期（对应 e2e-hand）
//   - 通过 hook bridge 从 fake-claude 触发工具调用并回传给 Client（对应 e2e-hand-mock-api）
//   - Read / Write / Grep / Glob / Bash 完整路径（对应 e2e-tool-access）
//   - Client 断开时 session 清理（对应 session-resume 的 detached 清理）
//
// 实现方式：
//   - 启动真实 CerelayServer（passthrough runtime，关闭 mount namespace）
//   - 裸 WebSocket 连接而非 CerelayClient（避免 runPtyPassthrough 劫持 stdin/stdout）
//   - 通过 CERELAY_PTY_COMMAND 环境变量注入 fake-claude，代替真实 Claude CLI
//   - fake-claude 启动后通过 runtimeRoot hint 文件和 script 文件接收测试指令，
//     调用 server 生成的 hook script 发起 PreToolUse，走完整 relay 链路
// ============================================================

interface TestContextState {
  server: CerelayServer;
  port: number;
  fake: FakeClaudePtyHandle;
  cwd: string;
  home: string;
}

async function setupTestContext(t: TestContext): Promise<TestContextState> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "cerelay-pty-e2e-cwd-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "cerelay-pty-e2e-home-"));
  const fake = await writeFakeClaudePty();

  const originalEnv: Record<string, string | undefined> = {
    CERELAY_ENABLE_MOUNT_NAMESPACE: process.env.CERELAY_ENABLE_MOUNT_NAMESPACE,
    CERELAY_PTY_COMMAND: process.env.CERELAY_PTY_COMMAND,
    CERELAY_FAKE_PTY_RUNTIMEROOT_FILE: process.env.CERELAY_FAKE_PTY_RUNTIMEROOT_FILE,
    CERELAY_FAKE_PTY_SCRIPT_FILE: process.env.CERELAY_FAKE_PTY_SCRIPT_FILE,
  };

  process.env.CERELAY_ENABLE_MOUNT_NAMESPACE = "false";
  // shell 下执行 exec 让 fake-claude 直接接管 PID，避免额外 shell 进程影响 pty 退出事件
  process.env.CERELAY_PTY_COMMAND = `exec ${shellQuote(fake.executablePath)}`;
  process.env.CERELAY_FAKE_PTY_RUNTIMEROOT_FILE = fake.runtimeRootHintFile;
  process.env.CERELAY_FAKE_PTY_SCRIPT_FILE = fake.scriptFile;

  const server = new CerelayServer({
    model: "claude-test",
    port: 0,
  });
  await server.start();
  const port = server.getListenPort();

  t.after(async () => {
    await server.shutdown().catch(() => undefined);
    await fake.cleanup().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  return { server, port, fake, cwd, home };
}

test("E2E PTY: fake-claude 通过 hook bridge 触发 Bash 工具调用，Client 返回结果后 fake-claude 输出到 PTY stdout", { concurrency: false, timeout: 30_000 }, async (t) => {
  const ctx = await setupTestContext(t);
  const harness = await connectHarness(t, ctx);

  await harness.expectPtyOutput("FAKE_CLAUDE_READY");

  // fake-claude 需要知道 runtimeRoot 才能找到 hook script；passthrough 模式下
  // runtimeRoot 为 <tmpdir>/cerelay-claude-<sanitized sessionId>，由 getClaudeSessionRuntimeRoot 生成。
  const expectedRuntimeRoot = getClaudeSessionRuntimeRoot(harness.sessionId);
  await writeFile(ctx.fake.runtimeRootHintFile, expectedRuntimeRoot, "utf8");
  await harness.expectPtyOutput("FAKE_CLAUDE_RUNTIME_READY");

  // 脚本第一步：让 fake-claude 发起一次 Bash pwd 工具调用
  await appendFile(ctx.fake.scriptFile, JSON.stringify({
    op: "call_tool",
    toolName: "Bash",
    toolInput: { command: "pwd" },
    toolUseId: "toolu_bash_pwd",
  }) + "\n", "utf8");

  const toolCall = await harness.waitForMessage<{
    type: "tool_call";
    requestId: string;
    toolName: string;
    toolUseId?: string;
    input: { command: string };
  }>("tool_call");
  assert.equal(toolCall.toolName, "Bash");
  assert.equal(toolCall.toolUseId, "toolu_bash_pwd");
  assert.equal(toolCall.input.command, "pwd");

  // Client 回 tool_result
  harness.send({
    type: "tool_result",
    sessionId: harness.sessionId,
    requestId: toolCall.requestId,
    output: { stdout: "/virtual/client/cwd\n", stderr: "", exit_code: 0 },
    summary: "pwd ok",
  });

  await harness.waitForMessage("tool_call_complete");

  // fake-claude 把整段 hook JSON 响应打印到 PTY stdout。修复后真实 tool 输出
  // 同时出现在 permissionDecisionReason 和 additionalContext 两个字段里。
  const toolResultLine = await harness.expectPtyOutput("FAKE_CLAUDE_TOOL_RESULT");
  assert.match(toolResultLine, /stdout:\\n\/virtual\/client\/cwd/);
  assert.match(toolResultLine, /"permissionDecisionReason":"stdout:/);
  assert.match(toolResultLine, /"additionalContext":"stdout:/);

  // 脚本第二步：让 fake-claude 主动退出
  await appendFile(ctx.fake.scriptFile, JSON.stringify({ op: "exit", code: 0 }) + "\n", "utf8");
  const exitMsg = await harness.waitForMessage<{ type: "pty_exit"; exitCode?: number }>("pty_exit");
  assert.equal(exitMsg.exitCode, 0);

  await harness.close();
});

test("E2E PTY: Read/Write/Grep/Glob 连续工具调用，链路内每步都经 hook bridge 转发到 Client", { concurrency: false, timeout: 30_000 }, async (t) => {
  const ctx = await setupTestContext(t);
  const harness = await connectHarness(t, ctx);

  await harness.expectPtyOutput("FAKE_CLAUDE_READY");
  const expectedRuntimeRoot = getClaudeSessionRuntimeRoot(harness.sessionId);
  await writeFile(ctx.fake.runtimeRootHintFile, expectedRuntimeRoot, "utf8");
  await harness.expectPtyOutput("FAKE_CLAUDE_RUNTIME_READY");

  const steps: Array<{
    toolName: string;
    toolInput: Record<string, unknown>;
    toolUseId: string;
    clientResult: { output: Record<string, unknown>; summary: string };
    expectMatch: RegExp;
  }> = [
    {
      toolName: "Write",
      toolInput: { file_path: `${ctx.cwd}/hello.txt`, content: "hello" },
      toolUseId: "toolu_write",
      clientResult: { output: { path: `${ctx.cwd}/hello.txt` }, summary: "Write 成功" },
      expectMatch: /\/hello\.txt/,
    },
    {
      toolName: "Read",
      toolInput: { file_path: `${ctx.cwd}/hello.txt` },
      toolUseId: "toolu_read",
      clientResult: { output: { content: "hello" }, summary: "Read 成功" },
      expectMatch: /hello/,
    },
    {
      toolName: "Grep",
      toolInput: { pattern: "hello", path: ctx.cwd },
      toolUseId: "toolu_grep",
      clientResult: {
        output: { matches: [{ file: "hello.txt", line: 1, text: "hello" }] },
        summary: "Grep 成功",
      },
      expectMatch: /hello\.txt:1:hello/,
    },
    {
      toolName: "Glob",
      toolInput: { pattern: "*.txt", path: ctx.cwd },
      toolUseId: "toolu_glob",
      clientResult: {
        output: { files: ["hello.txt"] },
        summary: "Glob 成功",
      },
      expectMatch: /hello\.txt/,
    },
  ];

  for (const step of steps) {
    await appendFile(ctx.fake.scriptFile, JSON.stringify({
      op: "call_tool",
      toolName: step.toolName,
      toolInput: step.toolInput,
      toolUseId: step.toolUseId,
    }) + "\n", "utf8");

    const toolCall = await harness.waitForMessage<{
      type: "tool_call";
      requestId: string;
      toolName: string;
      toolUseId?: string;
      input: Record<string, unknown>;
    }>("tool_call");
    assert.equal(toolCall.toolName, step.toolName, `第 ${step.toolName} 步 toolName 不匹配`);
    assert.equal(toolCall.toolUseId, step.toolUseId);

    harness.send({
      type: "tool_result",
      sessionId: harness.sessionId,
      requestId: toolCall.requestId,
      output: step.clientResult.output,
      summary: step.clientResult.summary,
    });
    await harness.waitForMessage("tool_call_complete");
    const line = await harness.expectPtyOutput("FAKE_CLAUDE_TOOL_RESULT");
    assert.match(line, step.expectMatch, `第 ${step.toolName} 步 PTY 输出未包含预期结果`);
  }

  await appendFile(ctx.fake.scriptFile, JSON.stringify({ op: "exit", code: 0 }) + "\n", "utf8");
  await harness.waitForMessage("pty_exit");
  await harness.close();
});

test("E2E PTY: Client 断开时 server 自动销毁对应 PTY session，避免孤儿进程", { concurrency: false, timeout: 30_000 }, async (t) => {
  const ctx = await setupTestContext(t);
  const harness = await connectHarness(t, ctx);
  await harness.expectPtyOutput("FAKE_CLAUDE_READY");

  // 记录 sessionId 后直接断开 WebSocket
  const sessionId = harness.sessionId;
  harness.forceClose();

  // 等一小段时间，server 端的 socket.on("close") → destroyPtySession 应该已执行
  await new Promise((resolve) => setTimeout(resolve, 300));

  // 重新连一个 WebSocket 验证：再次发 close_session 期望收到"会话不存在"错误
  const probe = await openProbeWebSocket(`ws://127.0.0.1:${ctx.port}/ws`);
  t.after(() => probe.close());
  await probe.waitFor("connected", 3_000);
  probe.send({ type: "close_session", sessionId });
  const err = await probe.waitFor<{ type: "error"; message: string }>("error", 5_000);
  assert.match(err.message, /不存在/);
});

test("E2E PTY: 未知 toolName 透传回 Client 由 Client 决定（server 不做内置工具拦截）", { concurrency: false, timeout: 30_000 }, async (t) => {
  const ctx = await setupTestContext(t);
  const harness = await connectHarness(t, ctx);

  await harness.expectPtyOutput("FAKE_CLAUDE_READY");
  await writeFile(ctx.fake.runtimeRootHintFile, getClaudeSessionRuntimeRoot(harness.sessionId), "utf8");
  await harness.expectPtyOutput("FAKE_CLAUDE_RUNTIME_READY");

  await appendFile(ctx.fake.scriptFile, JSON.stringify({
    op: "call_tool",
    toolName: "WebFetch",
    toolInput: { url: "http://example.test" },
    toolUseId: "toolu_webfetch",
  }) + "\n", "utf8");

  const toolCall = await harness.waitForMessage<{
    type: "tool_call";
    requestId: string;
    toolName: string;
    input: { url: string };
  }>("tool_call");
  assert.equal(toolCall.toolName, "WebFetch");
  assert.equal(toolCall.input.url, "http://example.test");

  harness.send({
    type: "tool_result",
    sessionId: harness.sessionId,
    requestId: toolCall.requestId,
    output: { status: 200, body: "ok" },
    summary: "WebFetch 完成",
  });
  await harness.waitForMessage("tool_call_complete");
  const line = await harness.expectPtyOutput("FAKE_CLAUDE_TOOL_RESULT");
  assert.match(line, /ok/);

  await appendFile(ctx.fake.scriptFile, JSON.stringify({ op: "exit", code: 0 }) + "\n", "utf8");
  await harness.waitForMessage("pty_exit");
  await harness.close();
});

// ============================================================
// 辅助：裸 WebSocket harness
// ============================================================

interface Harness {
  sessionId: string;
  send(payload: Record<string, unknown>): void;
  waitForMessage<T extends { type: string } = { type: string }>(type: string, timeoutMs?: number): Promise<T>;
  expectPtyOutput(marker: string, timeoutMs?: number): Promise<string>;
  close(): Promise<void>;
  forceClose(): void;
}

async function connectHarness(t: TestContext, ctx: TestContextState): Promise<Harness> {
  // 先创建 WebSocket 并注册 message 监听，再等待 open。
  // 否则 server 在 open 事件触发后立即发送的 connected 消息会被错过。
  const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws`);
  const messages: Array<{ type: string; payload: Record<string, unknown>; raw: string }> = [];
  const ptyChunks: Buffer[] = [];
  let ptyBuffer = "";
  const ptyWaiters: Array<{ marker: string; resolve: (line: string) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }> = [];
  const messageWaiters: Array<{ type: string; resolve: (msg: Record<string, unknown>) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }> = [];

  ws.on("message", (raw, isBinary) => {
    if (isBinary) return;
    const text = raw.toString("utf8");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    const msgType = typeof parsed.type === "string" ? parsed.type : "";
    if (msgType === "pty_output") {
      const data = typeof parsed.data === "string" ? parsed.data : "";
      const buffer = Buffer.from(data, "base64");
      ptyChunks.push(buffer);
      ptyBuffer += buffer.toString("utf8");
      drainPtyWaiters();
      return;
    }
    messages.push({ type: msgType, payload: parsed, raw: text });
    for (let i = messageWaiters.length - 1; i >= 0; i--) {
      const waiter = messageWaiters[i];
      if (waiter.type === msgType) {
        messageWaiters.splice(i, 1);
        clearTimeout(waiter.timer);
        // 从缓冲中把这条消息移除，避免 waiter 消费后 messages 里仍残留，
        // 导致后续同类型消息请求拿到旧值。
        const bufferIndex = messages.findIndex((entry) => entry.raw === text && entry.type === msgType);
        if (bufferIndex >= 0) messages.splice(bufferIndex, 1);
        waiter.resolve(parsed);
        break;
      }
    }
  });

  function drainPtyWaiters(): void {
    for (let i = 0; i < ptyWaiters.length; /* noop */) {
      const waiter = ptyWaiters[i];
      const index = ptyBuffer.indexOf(waiter.marker);
      if (index < 0) {
        i++;
        continue;
      }
      const lineEnd = ptyBuffer.indexOf("\n", index);
      const endPos = lineEnd === -1 ? ptyBuffer.length : lineEnd + 1;
      const lineSlice = lineEnd === -1
        ? ptyBuffer.slice(index)
        : ptyBuffer.slice(index, lineEnd);
      // 命中后把已消费的前缀丢弃，避免下一次 expectPtyOutput(sameMarker) 命中老值。
      ptyBuffer = ptyBuffer.slice(endPos);
      ptyWaiters.splice(i, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(lineSlice);
      // 重新从头扫（因为 buffer 刚被裁剪），i 不递增
      i = 0;
    }
  }

  ws.on("close", () => {
    const error = new Error("WebSocket 已关闭");
    for (const waiter of ptyWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    for (const waiter of messageWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      ws.off("open", onOpen);
      reject(err);
    };
    const onOpen = () => {
      ws.off("error", onError);
      resolve();
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
  });

  const waitForMessage = <T extends { type: string } = { type: string }>(type: string, timeoutMs = 10_000): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      // 先扫缓冲
      const index = messages.findIndex((entry) => entry.type === type);
      if (index >= 0) {
        const [existing] = messages.splice(index, 1);
        resolve(existing.payload as unknown as T);
        return;
      }
      const timer = setTimeout(() => {
        const idx = messageWaiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) messageWaiters.splice(idx, 1);
        reject(new Error(`等待消息 ${type} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      messageWaiters.push({
        type,
        resolve: (m) => resolve(m as unknown as T),
        reject,
        timer,
      });
    });
  };

  const expectPtyOutput = (marker: string, timeoutMs = 10_000): Promise<string> => {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = ptyWaiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) ptyWaiters.splice(idx, 1);
        reject(new Error(
          `等待 PTY 输出 "${marker}" 超时（${timeoutMs}ms）。已收到 ${ptyBuffer.length} 字节，` +
          `前 200 字节：${JSON.stringify(ptyBuffer.slice(0, 200))}`
        ));
      }, timeoutMs);
      ptyWaiters.push({ marker, resolve, reject, timer });
      drainPtyWaiters();
    });
  };

  // 等 connected
  await waitForMessage("connected", 3_000);

  // 发 create_pty_session
  ws.send(JSON.stringify({
    type: "create_pty_session",
    cwd: ctx.cwd,
    homeDir: ctx.home,
    cols: 80,
    rows: 24,
  }));
  const created = await waitForMessage<{ type: "pty_session_created"; sessionId: string }>("pty_session_created", 10_000);
  const sessionId = created.sessionId;

  t.after(() => {
    if (ws.readyState === WebSocket.OPEN) ws.close();
  });

  return {
    sessionId,
    send: (payload) => ws.send(JSON.stringify(payload)),
    waitForMessage,
    expectPtyOutput,
    close: async () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
        await new Promise<void>((resolve) => ws.once("close", () => resolve()));
      }
    },
    forceClose: () => {
      ws.terminate();
    },
  };
}

async function closeWebSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), 500);
    ws.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    if (ws.readyState === WebSocket.OPEN) ws.close();
  });
}

interface ProbeSocket {
  send(payload: Record<string, unknown>): void;
  waitFor<T extends { type: string } = { type: string }>(type: string, timeoutMs?: number): Promise<T>;
  close(): Promise<void>;
}

async function openProbeWebSocket(url: string): Promise<ProbeSocket> {
  // 在 WebSocket 构造阶段就注册 message listener，避免 open 后的首条消息被错过。
  const ws = new WebSocket(url);
  const buffered: Record<string, unknown>[] = [];
  const waiters: Array<{ type: string; resolve: (msg: Record<string, unknown>) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }> = [];

  ws.on("message", (raw, isBinary) => {
    if (isBinary) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    } catch {
      return;
    }
    const msgType = typeof parsed.type === "string" ? parsed.type : "";
    const idx = waiters.findIndex((w) => w.type === msgType);
    if (idx >= 0) {
      const waiter = waiters[idx];
      waiters.splice(idx, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(parsed);
    } else {
      buffered.push(parsed);
    }
  });

  ws.on("close", () => {
    const error = new Error("WebSocket 已关闭");
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      ws.off("open", onOpen);
      reject(err);
    };
    const onOpen = () => {
      ws.off("error", onError);
      resolve();
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
  });

  return {
    send: (payload) => ws.send(JSON.stringify(payload)),
    waitFor: <T extends { type: string } = { type: string }>(type: string, timeoutMs = 5_000): Promise<T> => {
      return new Promise<T>((resolve, reject) => {
        const idx = buffered.findIndex((m) => m.type === type);
        if (idx >= 0) {
          const [existing] = buffered.splice(idx, 1);
          resolve(existing as unknown as T);
          return;
        }
        const timer = setTimeout(() => {
          const waiterIdx = waiters.findIndex((w) => w.timer === timer);
          if (waiterIdx >= 0) waiters.splice(waiterIdx, 1);
          reject(new Error(`等待消息 ${type} 超时`));
        }, timeoutMs);
        waiters.push({
          type,
          resolve: (m) => resolve(m as unknown as T),
          reject,
          timer,
        });
      });
    },
    close: () => closeWebSocket(ws),
  };
}

function shellQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}
