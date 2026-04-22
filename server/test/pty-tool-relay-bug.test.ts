/**
 * PTY 工具链路 Bug 复现测试
 *
 * 针对 "BashTool 查看当前目录文件返回空" 的四个嫌疑场景编写测试：
 *
 * 嫌疑 1: PTY 模式 permissionDecisionReason 不能为空（必须是 "Tool response ready"）
 * 嫌疑 2: Passthrough 模式当 Client cwd 不存在时回退到空的 runtimeRoot
 * 嫌疑 3: Mount namespace bootstrap 后 cwd 内无项目文件（只有 .claude/）
 * 嫌疑 4: PTY hook 链路断裂时的错误处理（transport 失败 / session 关闭 / 超时）
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { ClaudePtySession, type PtySessionTransport } from "../src/pty-session.js";
import type { ClaudeSessionRuntime } from "../src/claude-session-runtime.js";
import { createClaudeSessionRuntime, renderNamespaceBootstrapScript } from "../src/claude-session-runtime.js";

// ============================================================
// 辅助函数：创建 mock runtime 和 transport
// ============================================================

function createMockRuntime(overrides?: Partial<ClaudeSessionRuntime>): ClaudeSessionRuntime {
  return {
    cwd: overrides?.cwd ?? "/tmp/mock-runtime-cwd",
    env: overrides?.env ?? { HOME: "/home/node", PATH: "/usr/bin" },
    rootDir: overrides?.rootDir ?? "/tmp/mock-runtime-root",
    cleanup: overrides?.cleanup ?? (async () => {}),
    ...overrides,
  };
}

interface MockTransportCapture {
  toolCalls: Array<{ sessionId: string; requestId: string; toolName: string; toolUseId: string | undefined; input: unknown }>;
  toolCallCompletes: Array<{ sessionId: string; requestId: string; toolName: string }>;
  outputs: Buffer[];
  exits: Array<{ sessionId: string; exitCode?: number; signal?: string }>;
}

function createMockTransport(
  capture: MockTransportCapture,
  options?: {
    onToolCall?: (requestId: string, toolName: string, input: unknown) => void;
    throwOnSendToolCall?: Error;
  }
): PtySessionTransport {
  return {
    sendOutput: async (sessionId, data) => {
      capture.outputs.push(data);
    },
    sendExit: async (sessionId, exitCode, signal) => {
      capture.exits.push({ sessionId, exitCode, signal });
    },
    sendToolCall: async (sessionId, requestId, toolName, toolUseId, input) => {
      if (options?.throwOnSendToolCall) {
        throw options.throwOnSendToolCall;
      }
      capture.toolCalls.push({ sessionId, requestId, toolName, toolUseId, input });
      options?.onToolCall?.(requestId, toolName, input);
    },
    sendToolCallComplete: async (sessionId, requestId, toolName) => {
      capture.toolCallCompletes.push({ sessionId, requestId, toolName });
    },
  };
}

function createEmptyCapture(): MockTransportCapture {
  return {
    toolCalls: [],
    toolCallCompletes: [],
    outputs: [],
    exits: [],
  };
}

// ============================================================
// 嫌疑 1: PTY permissionDecisionReason 不能为空
// ============================================================

test("嫌疑1: PTY handleInjectedPreToolUse 对 client-routed 工具应返回 'Tool response ready'", async () => {
  const capture = createEmptyCapture();
  const ptySession = new ClaudePtySession({
    id: "pty-bug-test-1",
    cwd: "/Users/developer/project",
    runtime: createMockRuntime({
      cwd: "/Users/developer/project",
      env: { HOME: "/home/node" },
    }),
    transport: createMockTransport(capture, {
      onToolCall: (requestId) => {
        // 模拟 Client 立即返回 Bash 结果
        ptySession.resolveToolResult(requestId, {
          output: { stdout: "file1.ts\nfile2.ts\n", stderr: "", exit_code: 0 },
          summary: "ls 成功",
        });
      },
    }),
  });

  const hookResult = await ptySession.handleInjectedPreToolUse({
    tool_name: "Bash",
    tool_use_id: "toolu_bash_1",
    tool_input: { command: "ls" },
  });

  // ★ 核心断言：permissionDecisionReason 必须是 "Tool response ready"
  // CC 的 hook 协议：deny + 空 reason 可能被解读为 "工具被策略拒绝"，
  // 而非 "结果已注入"，会导致 CC 重新 fallback 本地执行。
  assert.equal(
    hookResult.hookSpecificOutput?.permissionDecisionReason,
    "Tool response ready",
    "PTY 的 permissionDecisionReason 必须为 'Tool response ready'；" +
    "空串会让 CC 把 deny 解读为策略拒绝而非结果已注入"
  );

  await ptySession.close();
});

// ============================================================
// 嫌疑 2: Passthrough 模式 cwd 不存在时回退到空的 runtimeRoot
// ============================================================

test("嫌疑2: Passthrough 模式当 Client cwd 不存在时，runtime.cwd 不应回退到空目录", async (t) => {
  // 确保 CERELAY_ENABLE_MOUNT_NAMESPACE 不为 true，走 passthrough 路径
  const originalMountNs = process.env.CERELAY_ENABLE_MOUNT_NAMESPACE;
  process.env.CERELAY_ENABLE_MOUNT_NAMESPACE = "false";
  t.after(() => {
    if (originalMountNs === undefined) {
      delete process.env.CERELAY_ENABLE_MOUNT_NAMESPACE;
    } else {
      process.env.CERELAY_ENABLE_MOUNT_NAMESPACE = originalMountNs;
    }
  });

  // 直接构造一个明确不存在的 Client cwd，避免依赖宿主机 / 容器路径差异
  const nonExistentClientCwd = `/tmp/cerelay-passthrough-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  assert.ok(!existsSync(nonExistentClientCwd), "测试前提：Client cwd 必须不存在");

  const runtime = await createClaudeSessionRuntime({
    sessionId: `passthrough-fallback-${Date.now()}`,
    cwd: nonExistentClientCwd,
  });
  t.after(async () => {
    await runtime.cleanup();
  });

  // ★ 核心断言：runtime.cwd 回退到了 runtimeRoot（空目录）
  // 这意味着 CC 在 passthrough 模式下的 ls 会看到空目录
  assert.notEqual(
    runtime.cwd,
    nonExistentClientCwd,
    "Passthrough 模式下不存在的 cwd 应回退"
  );

  // 回退后的 cwd 是 runtimeRoot，验证它是空的
  const files = await readdir(runtime.cwd);
  assert.deepEqual(
    files,
    [],
    `回退的 runtimeRoot 应为空目录，但实际包含: ${files.join(", ")}。` +
    "这就是 BashTool ls 返回空的原因——CC 在空目录中执行"
  );
});

test("嫌疑2-对照: Passthrough 模式当 Client cwd 存在时，runtime.cwd 应为原始路径", async (t) => {
  const originalMountNs = process.env.CERELAY_ENABLE_MOUNT_NAMESPACE;
  process.env.CERELAY_ENABLE_MOUNT_NAMESPACE = "false";
  t.after(() => {
    if (originalMountNs === undefined) {
      delete process.env.CERELAY_ENABLE_MOUNT_NAMESPACE;
    } else {
      process.env.CERELAY_ENABLE_MOUNT_NAMESPACE = originalMountNs;
    }
  });

  const existingCwd = tmpdir();
  const runtime = await createClaudeSessionRuntime({
    sessionId: `passthrough-existing-${Date.now()}`,
    cwd: existingCwd,
  });
  t.after(async () => {
    await runtime.cleanup();
  });

  assert.equal(
    runtime.cwd,
    existingCwd,
    "Passthrough 模式下存在的 cwd 应直接使用"
  );
});

test("嫌疑2: Bash ls 在 fallback cwd 中执行结果为空", async (t) => {
  const originalMountNs = process.env.CERELAY_ENABLE_MOUNT_NAMESPACE;
  process.env.CERELAY_ENABLE_MOUNT_NAMESPACE = "false";
  t.after(() => {
    if (originalMountNs === undefined) {
      delete process.env.CERELAY_ENABLE_MOUNT_NAMESPACE;
    } else {
      process.env.CERELAY_ENABLE_MOUNT_NAMESPACE = originalMountNs;
    }
  });

  // 构造一个明确不存在的路径
  const nonExistentCwd = `/tmp/cerelay-nonexistent-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  assert.ok(!existsSync(nonExistentCwd), "确保路径不存在");

  const runtime = await createClaudeSessionRuntime({
    sessionId: `passthrough-bash-empty-${Date.now()}`,
    cwd: nonExistentCwd,
  });
  t.after(async () => {
    await runtime.cleanup();
  });

  // runtime.cwd 回退到 runtimeRoot
  assert.notEqual(runtime.cwd, nonExistentCwd);

  // 验证回退目录是空的
  const filesInFallback = await readdir(runtime.cwd);
  assert.deepEqual(
    filesInFallback,
    [],
    "回退 cwd 应为空——如果 hook 链路断裂，CC 在此执行 ls 将返回空"
  );

  // 模拟 PTY session 在此 runtime 上执行工具
  const capture = createEmptyCapture();
  const ptySession = new ClaudePtySession({
    id: "pty-empty-cwd-test",
    cwd: nonExistentCwd, // Client 报告的真实 cwd
    runtime,
    transport: createMockTransport(capture, {
      onToolCall: (requestId) => {
        // 模拟 Client 返回真实目录内容（hook 正常工作时）
        ptySession.resolveToolResult(requestId, {
          output: { stdout: "src/\npackage.json\nREADME.md\n", stderr: "", exit_code: 0 },
          summary: "ls 成功",
        });
      },
    }),
  });

  const hookResult = await ptySession.handleInjectedPreToolUse({
    tool_name: "Bash",
    tool_use_id: "toolu_bash_ls",
    tool_input: { command: "ls" },
  });

  // 当 hook 正常工作时，结果来自 Client（宿主机），应包含文件
  assert.ok(
    hookResult.hookSpecificOutput?.additionalContext?.includes("package.json"),
    "hook 正常时应返回 Client 侧的 ls 结果"
  );

  // 但如果 hook 失败，CC 会在 runtime.cwd（空目录）中本地执行 ls
  // 这就是 bug 的根因：hook 链路断裂 + 空 cwd = 空结果
  const localLsResult = await readdir(runtime.cwd);
  assert.deepEqual(
    localLsResult,
    [],
    "★ BUG 复现：runtime.cwd 为空，如果 hook 断裂，CC 本地 ls 将返回空"
  );

  await ptySession.close();
});

// ============================================================
// 嫌疑 3: Mount namespace bootstrap 后 cwd 内无项目文件
// ============================================================

test("嫌疑3: bootstrap 脚本中 cwd 只做 mkdir -p，不挂载项目文件", () => {
  const script = renderNamespaceBootstrapScript();

  // 验证 cwd 只是被 mkdir -p 创建，没有任何文件挂载
  assert.match(
    script,
    /mkdir -p "\$CERELAY_HOME_DIR" "\$CERELAY_WORK_DIR"/,
    "bootstrap 通过 mkdir -p 创建 cwd"
  );

  // ★ 核心断言：CERELAY_WORK_DIR 没有项目文件的 bind mount
  // FUSE 模式只挂载 .claude/ 目录，不挂载项目源文件
  // 传统模式同样不挂载项目源文件
  // 所以 namespace 内的 cwd 只有 .claude/ 子目录

  // 验证 FUSE 模式只挂载 .claude 相关目录
  assert.match(
    script,
    /mount --bind "\$CERELAY_FUSE_ROOT\/project-claude" "\$CERELAY_WORK_DIR\/\.claude"/,
    "FUSE 模式只挂载 {cwd}/.claude"
  );

  // 验证没有挂载项目源文件（如 src/、package.json 等）的逻辑
  // 获取所有涉及 CERELAY_WORK_DIR 的 mount 行（完整行）
  const workDirMountLines = script.split("\n").filter(
    (line) => /mount\s+--(?:r?bind)/.test(line) && line.includes("$CERELAY_WORK_DIR")
  );
  // 每一行 mount 到 WORK_DIR 的目标都应该是 .claude 相关路径
  const nonClaudeMounts = workDirMountLines.filter(
    (line) => !line.includes(".claude")
  );
  assert.deepEqual(
    nonClaudeMounts,
    [],
    "WORK_DIR 下所有 mount 都应该指向 .claude 相关路径（项目源文件不可见）"
  );
});

test("嫌疑3: view root 覆盖后顶层目录为空（用户文件被遮盖）", () => {
  const script = renderNamespaceBootstrapScript();

  // 验证 view root 覆盖逻辑：用空目录 bind mount 覆盖顶层路径
  assert.match(
    script,
    /mount --bind "\$CERELAY_RUNTIME_ROOT\/views\/\$root_name" "\/\$root_name"/,
    "view root 用空目录覆盖顶层路径"
  );

  // 这意味着 /Users（或 /home）下的所有原始文件被空目录覆盖
  // 之后只有 mkdir -p 创建空的 cwd 和 home 目录
  // 所以项目文件完全不可见

  // 验证 view 目录被空创建
  assert.match(
    script,
    /mkdir -p "\/\$root_name" "\$CERELAY_RUNTIME_ROOT\/views\/\$root_name"/,
    "view 目录作为空目录创建"
  );
});

// Linux 集成测试：验证 namespace 内 cwd 确实为空
const isLinux = process.platform === "linux";
const expectMountNamespaceTests = process.env.CERELAY_EXPECT_MOUNT_NAMESPACE_TESTS === "true";
const hasSysAdmin = (() => {
  if (!isLinux) return false;
  try {
    execSync("unshare --mount echo ok", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

if (expectMountNamespaceTests) {
  assert.ok(isLinux, "容器测试环境应在 Linux 内运行 mount namespace 集成测试");
  assert.ok(hasSysAdmin, "容器测试环境应提供 unshare --mount / SYS_ADMIN 能力");
}

test("嫌疑3-集成: namespace 内 cwd 只有 .claude/ 没有项目文件", { skip: !hasSysAdmin }, async (t) => {
  const { execSync } = await import("node:child_process");
  const tempDir = await mkdir(path.join(tmpdir(), `ns-empty-cwd-${Date.now()}`), { recursive: true });
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // 准备 "项目" 目录（模拟宿主机 cwd 有文件）
  const projectDir = path.join(tempDir, "project");
  await mkdir(path.join(projectDir, "src"), { recursive: true });
  await writeFile(path.join(projectDir, "package.json"), '{"name":"test"}', "utf8");
  await writeFile(path.join(projectDir, "src", "index.ts"), "export default {};", "utf8");

  // 验证 "项目" 目录有文件
  const beforeFiles = await readdir(projectDir);
  assert.ok(beforeFiles.includes("package.json"), "项目目录应包含 package.json");
  assert.ok(beforeFiles.includes("src"), "项目目录应包含 src");

  const runtimeRoot = path.join(tempDir, "runtime");
  await mkdir(path.join(runtimeRoot, "views"), { recursive: true });
  await mkdir(path.join(runtimeRoot, "staged"), { recursive: true });

  // 模拟 namespace bootstrap：view root 覆盖后 mkdir -p cwd
  const topLevelName = projectDir.split(path.sep).filter(Boolean)[0] || "tmp";
  const viewDir = path.join(runtimeRoot, "views", topLevelName);
  await mkdir(viewDir, { recursive: true });

  // 在 mount namespace 内模拟 bootstrap 行为
  const result = execSync(`
    unshare --mount --propagation private /bin/sh -c '
      # 用空目录覆盖顶层路径
      mount --bind "${viewDir}" "/${topLevelName}"
      # 重建 cwd（空目录）
      mkdir -p "${projectDir}"
      # 列出 cwd 内容
      ls "${projectDir}" 2>&1 || echo "__EMPTY__"
    '
  `, { encoding: "utf8" }).trim();

  // ★ 核心断言：namespace 内 cwd 应该是空的（项目文件被 view root 遮盖）
  assert.equal(
    result,
    "",
    "namespace 内 cwd 应为空——项目文件被 view root 覆盖后不可见，" +
    "这就是 CC 本地 ls 返回空的原因"
  );
});

// ============================================================
// 嫌疑 4: PTY hook 链路断裂场景
// ============================================================

test("嫌疑4a: transport.sendToolCall 抛出异常时，handleInjectedPreToolUse 应正确传播错误并清理 relay", async () => {
  const capture = createEmptyCapture();
  const transportError = new Error("WebSocket connection lost");

  const ptySession = new ClaudePtySession({
    id: "pty-transport-fail-1",
    cwd: "/Users/developer/project",
    runtime: createMockRuntime(),
    transport: createMockTransport(capture, {
      throwOnSendToolCall: transportError,
    }),
  });

  // transport 失败时应抛出错误，而非静默失败
  await assert.rejects(
    () => ptySession.handleInjectedPreToolUse({
      tool_name: "Bash",
      tool_use_id: "toolu_bash_fail",
      tool_input: { command: "ls" },
    }),
    (error: Error) => {
      assert.match(error.message, /WebSocket connection lost/);
      return true;
    },
    "transport 失败应抛出错误，否则 hook 脚本会返回空响应导致 CC 本地执行"
  );

  // 修复验证（pty-session.ts executeToolViaClient 的 catch 分支会调用 relay.reject）：
  // transport 失败后 relay 中不应有 dangling pending，close() 时不会触发 unhandledRejection。
  await ptySession.close();
});

test("嫌疑4b: session 关闭后调用 handleInjectedPreToolUse 应抛出错误", async () => {
  const capture = createEmptyCapture();
  const ptySession = new ClaudePtySession({
    id: "pty-closed-test-1",
    cwd: "/Users/developer/project",
    runtime: createMockRuntime(),
    transport: createMockTransport(capture),
  });

  await ptySession.close();

  await assert.rejects(
    () => ptySession.handleInjectedPreToolUse({
      tool_name: "Bash",
      tool_use_id: "toolu_bash_closed",
      tool_input: { command: "ls" },
    }),
    (error: Error) => {
      assert.match(error.message, /已关闭/);
      return true;
    },
    "关闭的 session 应拒绝新的工具调用"
  );
});

test("嫌疑4c: session 在等待工具结果期间被关闭，pending 应被 reject", async () => {
  const capture = createEmptyCapture();
  const ptySession = new ClaudePtySession({
    id: "pty-close-during-wait-1",
    cwd: "/Users/developer/project",
    runtime: createMockRuntime(),
    transport: createMockTransport(capture, {
      onToolCall: () => {
        // 不 resolve 结果，而是在短暂延迟后关闭 session
        setTimeout(() => {
          void ptySession.close();
        }, 50);
      },
    }),
  });

  await assert.rejects(
    () => ptySession.handleInjectedPreToolUse({
      tool_name: "Bash",
      tool_use_id: "toolu_bash_mid_close",
      tool_input: { command: "ls -la" },
    }),
    (error: Error) => {
      // 预期 relay.cleanup() 拒绝所有 pending
      return error.message.includes("已关闭") || error.message.includes("closed");
    },
    "等待工具结果期间 session 关闭应导致 pending 被 reject"
  );
});

test("嫌疑4d: 非 client-routed 工具应放行（不走 hook 链路）", async () => {
  const capture = createEmptyCapture();
  const ptySession = new ClaudePtySession({
    id: "pty-non-routed-1",
    cwd: "/Users/developer/project",
    runtime: createMockRuntime(),
    transport: createMockTransport(capture),
  });

  // "TodoRead" 等内部工具不应路由到 Client
  const hookResult = await ptySession.handleInjectedPreToolUse({
    tool_name: "TodoRead",
    tool_use_id: "toolu_todo_1",
    tool_input: {},
  });

  // 非 client-routed 工具应被放行
  assert.equal(
    hookResult.hookSpecificOutput?.permissionDecision,
    "allow",
    "非 client-routed 工具应放行"
  );
  assert.equal(
    hookResult.hookSpecificOutput?.permissionDecisionReason,
    "Tool TodoRead approved",
    "放行理由应包含工具名"
  );
  // 不应有工具调用发送到 Client
  assert.equal(capture.toolCalls.length, 0, "不应有工具调用发送到 Client");

  await ptySession.close();
});

test("嫌疑4e: PTY 路径重写一致性 — runtime.cwd 与 client cwd 不同时必须重写", async () => {
  // 模拟 Docker 环境：runtime.cwd 是容器内路径，client cwd 是宿主机路径
  const capture = createEmptyCapture();
  const containerCwd = "/tmp/cerelay-runtime-abc";
  const clientCwd = "/Users/developer/project";

  const ptySession = new ClaudePtySession({
    id: "pty-rewrite-test-1",
    cwd: clientCwd,
    clientHomeDir: "/Users/developer",
    runtime: createMockRuntime({
      cwd: containerCwd,
      env: { HOME: "/home/node" },
    }),
    transport: createMockTransport(capture, {
      onToolCall: (requestId) => {
        ptySession.resolveToolResult(requestId, {
          output: { content: "file contents" },
          summary: "Read 成功",
        });
      },
    }),
  });

  await ptySession.handleInjectedPreToolUse({
    tool_name: "Read",
    tool_use_id: "toolu_read_rewrite",
    tool_input: { file_path: `${containerCwd}/src/index.ts` },
  });

  // 验证发送到 Client 的路径已被重写
  assert.equal(capture.toolCalls.length, 1);
  const sentInput = capture.toolCalls[0]!.input as { file_path: string };
  assert.equal(
    sentInput.file_path,
    `${clientCwd}/src/index.ts`,
    "容器内路径应被重写为 Client 侧路径"
  );

  await ptySession.close();
});

test("嫌疑4f: PTY Bash 命令中 cd sdkCwd 应被重写为 cd clientCwd", async () => {
  const capture = createEmptyCapture();
  const containerCwd = "/tmp/cerelay-runtime-xyz";
  const clientCwd = "/Users/developer/myapp";

  const ptySession = new ClaudePtySession({
    id: "pty-bash-rewrite-1",
    cwd: clientCwd,
    clientHomeDir: "/Users/developer",
    runtime: createMockRuntime({
      cwd: containerCwd,
      env: { HOME: "/home/node" },
    }),
    transport: createMockTransport(capture, {
      onToolCall: (requestId) => {
        ptySession.resolveToolResult(requestId, {
          output: { stdout: "src/\npackage.json\n", stderr: "", exit_code: 0 },
          summary: "ls 成功",
        });
      },
    }),
  });

  await ptySession.handleInjectedPreToolUse({
    tool_name: "Bash",
    tool_use_id: "toolu_bash_cd",
    tool_input: { command: `cd ${containerCwd} && ls` },
  });

  assert.equal(capture.toolCalls.length, 1);
  const sentInput = capture.toolCalls[0]!.input as { command: string };
  assert.equal(
    sentInput.command,
    `cd ${clientCwd} && ls`,
    "Bash 命令中的容器 cwd 应被重写为 Client cwd"
  );

  await ptySession.close();
});

// ============================================================
// 嫌疑 4 补充: hook 脚本的响应格式验证
// ============================================================

test("嫌疑4g: PTY hook 响应的 JSON 格式应被 CC 正确解读为工具结果注入", async () => {
  const capture = createEmptyCapture();
  const ptySession = new ClaudePtySession({
    id: "pty-response-format-1",
    cwd: "/Users/developer/project",
    runtime: createMockRuntime({
      cwd: "/Users/developer/project",
      env: { HOME: "/home/node" },
    }),
    transport: createMockTransport(capture, {
      onToolCall: (requestId) => {
        ptySession.resolveToolResult(requestId, {
          output: { stdout: "src/\npackage.json\nREADME.md\n", stderr: "", exit_code: 0 },
          summary: "ls 成功",
        });
      },
    }),
  });

  const hookResult = await ptySession.handleInjectedPreToolUse({
    tool_name: "Bash",
    tool_use_id: "toolu_bash_format",
    tool_input: { command: "ls" },
  });

  const output = hookResult.hookSpecificOutput!;

  // CC 的 hook 协议要求：
  // 1. hookEventName 必须是 "PreToolUse"
  assert.equal(output.hookEventName, "PreToolUse");

  // 2. permissionDecision 必须是 "deny"（阻止 CC 本地执行）
  assert.equal(output.permissionDecision, "deny",
    "必须是 deny 才能阻止 CC 本地执行工具");

  // 3. additionalContext 必须包含工具结果
  assert.ok(output.additionalContext?.includes("src/"),
    "additionalContext 应包含 ls 结果");
  assert.ok(output.additionalContext?.includes("package.json"),
    "additionalContext 应包含 ls 结果中的文件名");

  // 4. ★ permissionDecisionReason 不应为空
  //    CC 可能将空 reason + deny 解释为 "工具被策略拒绝"（而非 "结果已注入"）
  assert.ok(
    output.permissionDecisionReason && output.permissionDecisionReason.length > 0,
    `permissionDecisionReason 不应为空串，当前值: "${output.permissionDecisionReason}"。` +
    "空串可能导致 CC 认为工具被拒绝而非结果已注入"
  );

  await ptySession.close();
});
