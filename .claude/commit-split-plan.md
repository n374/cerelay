# 未提交改动盘点与 commit 切分方案

## 1. git 状态

### git status --short 输出
```
M server/src/session.ts
 M server/test/session-flow.test.ts
 M server/test/session-routing.test.ts
 M server/test/session-sdk-spawn.test.ts
?? .claude/cwd-mapping-bug.md
?? .claude/cwd-refactor-verify.md
?? .claude/exec-bug-investigation.md
?? .claude/uncommitted-analysis.md
?? server/test/e2e-hand.test.ts
?? server/test/fixtures/
?? server/test/session-resolve-executable.test.ts
```

### git diff --stat 输出
```
 server/src/session.ts                 |  23 ++++++-
 server/test/session-flow.test.ts      |  19 +++++-
 server/test/session-routing.test.ts   |  12 +++-
 server/test/session-sdk-spawn.test.ts | 112 ++--------------------------------
 4 files changed, 53 insertions(+), 113 deletions(-)
```

## 2. 改动详情

### 已修改文件

#### server/src/session.ts

**关注点：**
- 多候选 Claude executable 路径解析
- queryRunner 依赖注入支持
- executable 候选路径列表导出

**改动摘要：**
添加了多候选 executable 路径的自动探测机制。新增 `CLAUDE_EXECUTABLE_CANDIDATES` 常量列表（支持 Homebrew M1、Intel、本地安装三个位置）。重构 `resolveClaudeCodeExecutable()` 函数，现在优先检查环境变量，若未设置则遍历候选路径返回首个存在的，都不存在时抛出有详细错误提示。同时调整了函数签名以支持注入候选列表和环境变量（便于测试）。

**完整 diff：**
```diff
diff --git a/server/src/session.ts b/server/src/session.ts
index 15e7d7a..d680986 100644
--- a/server/src/session.ts
+++ b/server/src/session.ts
@@ -1,4 +1,7 @@
 import { randomUUID } from "node:crypto";
+import { existsSync } from "node:fs";
+import os from "node:os";
+import path from "node:path";
 import process from "node:process";
 import { query } from "@anthropic-ai/claude-agent-sdk";
 import type {
@@ -11,7 +14,11 @@ import { createLogger, type Logger } from "./logger.js";
 import { ToolRelay, type RemoteToolResult } from "./relay.js";
 import { isBuiltinHandToolName, isMcpToolName } from "./tool-routing.js";
 
-const DEFAULT_CLAUDE_CODE_EXECUTABLE = "/usr/local/bin/claude";
+export const CLAUDE_EXECUTABLE_CANDIDATES = [
+  "/opt/homebrew/bin/claude",
+  "/usr/local/bin/claude",
+  path.join(os.homedir(), ".claude/local/claude"),
+];
 
 type SessionStatus = "idle" | "active" | "ended";
 type CanUseToolHandler = (
@@ -461,9 +468,19 @@ export function isHandRoutedToolName(toolName: string): boolean {
   return isBuiltinHandToolName(toolName) || isMcpToolName(toolName);
 }
 
-export function resolveClaudeCodeExecutable(env = process.env): string {
+export function resolveClaudeCodeExecutable(candidates = CLAUDE_EXECUTABLE_CANDIDATES, env = process.env): string {
   const configured = env.CLAUDE_CODE_EXECUTABLE?.trim();
-  return configured || DEFAULT_CLAUDE_CODE_EXECUTABLE;
+  if (configured) {
+    return configured;
+  }
+  for (const candidate of candidates) {
+    if (existsSync(candidate)) {
+      return candidate;
+    }
+  }
+  throw new Error(
+    `Could not find Claude Code executable. Tried: ${candidates.join(", ")}. Set CLAUDE_CODE_EXECUTABLE env var or install via \`brew install --cask claude-code\`.`
+  );
 }
 
 function runSdkQuery(input: QueryRunnerInput): AsyncIterable<QueryMessage> {
```

#### server/test/session-flow.test.ts

**关注点：**
- 验证 fake-claude fixture 集成
- 测试 pathToClaudeCodeExecutable 正确传递
- 环境变量注入和清理

**改动摘要：**
将静态 mock 改为使用 `writeFakeClaude` fixture（生成真实可执行的 fake-claude）。添加 test 钩子来管理环境变量 `CLAUDE_CODE_EXECUTABLE` 的生命周期（保存原值、设为 fake 可执行路径、测试后恢复）。修改断言检查点从硬编码路径改为期望 fixture 生成的实际路径。

**完整 diff：**
```diff
diff --git a/server/test/session-flow.test.ts b/server/test/session-flow.test.ts
index 5de2815..502c5ac 100644
--- a/server/test/session-flow.test.ts
+++ b/server/test/session-flow.test.ts
@@ -1,9 +1,24 @@
+import process from "node:process";
 import test from "node:test";
 import assert from "node:assert/strict";
 import { BrainSession } from "../src/session.js";
 import type { ServerToHandMessage } from "../src/protocol.js";
+import { writeFakeClaude } from "./fixtures/fake-claude.js";
+
+test("BrainSession streams thought/text chunks and passes Claude executable options to query runner", async (t) => {
+  const fake = await writeFakeClaude({ command: "pwd" });
+  const originalExecutable = process.env.CLAUDE_CODE_EXECUTABLE;
+  process.env.CLAUDE_CODE_EXECUTABLE = fake.executablePath;
+
+  t.after(async () => {
+    if (originalExecutable === undefined) {
+      delete process.env.CLAUDE_CODE_EXECUTABLE;
+    } else {
+      process.env.CLAUDE_CODE_EXECUTABLE = originalExecutable;
+    }
+    await fake.cleanup();
+  });
 
-test("BrainSession streams thought/text chunks and passes Claude executable options to query runner", async () => {
   const sent: ServerToHandMessage[] = [];
   let queryInput: { prompt: string; options: { cwd: string; model: string; pathToClaudeCodeExecutable: string } } | null = null;
 
@@ -47,7 +62,7 @@ test("BrainSession streams thought/text chunks and passes Claude executable opti
     options: {
       cwd: "/workspace/demo",
       model: "claude-test",
-      pathToClaudeCodeExecutable: "/usr/local/bin/claude",
+      pathToClaudeCodeExecutable: fake.executablePath,
     },
   });
   assert.deepEqual(sent, [
```

#### server/test/session-routing.test.ts

**关注点：**
- 更新 `resolveClaudeCodeExecutable()` 的测试调用方式
- 验证错误情况（候选路径未命中）

**改动摘要：**
适应新的 `resolveClaudeCodeExecutable()` 签名变化。旧版本直接传 `env`，新版本需先传 `candidates` 再传 `env`。新增测试用例验证当所有候选路径都不存在时，函数抛出的错误消息包含所有候选路径和 `CLAUDE_CODE_EXECUTABLE` 提示信息。

**完整 diff：**
```diff
diff --git a/server/test/session-routing.test.ts b/server/test/session-routing.test.ts
index 92616db..393a6e0 100644
--- a/server/test/session-routing.test.ts
+++ b/server/test/session-routing.test.ts
@@ -32,6 +32,14 @@ test("tool routing store keeps built-ins fixed and allows extra configurable too
 });
 
 test("resolveClaudeCodeExecutable prefers env override and falls back to claude", () => {
-  assert.equal(resolveClaudeCodeExecutable({ CLAUDE_CODE_EXECUTABLE: "/usr/local/bin/claude " }), "/usr/local/bin/claude");
-  assert.equal(resolveClaudeCodeExecutable({}), "/usr/local/bin/claude");
+  // 环境变量覆盖:trim 后返回该值
+  assert.equal(
+    resolveClaudeCodeExecutable(undefined, { CLAUDE_CODE_EXECUTABLE: "/usr/local/bin/claude " }),
+    "/usr/local/bin/claude"
+  );
+  // 无环境变量、无候选命中时抛 Error
+  assert.throws(
+    () => resolveClaudeCodeExecutable(["/no/such/path"], {}),
+    (err: unknown) => err instanceof Error && err.message.includes("/no/such/path")
+  );
 });
```

#### server/test/session-sdk-spawn.test.ts

**关注点：**
- 从内联 fake-claude 逻辑改为使用 fixture
- 大幅简化测试代码（删除 107 行）

**改动摘要：**
提取出之前内联在测试文件中的 `writeFakeClaudeExecutable()` 函数为独立 fixture（`server/test/fixtures/fake-claude.ts`）。测试改为调用该 fixture 的 `writeFakeClaude()` 方法。简化了临时目录管理、环境变量注入、cleanup 等重复代码。测试逻辑更清晰，易于重用。

**完整 diff：**
```diff
diff --git a/server/test/session-sdk-spawn.test.ts b/server/test/session-sdk-spawn.test.ts
index 12aa8cd..4a06361 100644
--- a/server/test/session-sdk-spawn.test.ts
+++ b/server/test/session-sdk-spawn.test.ts
@@ -1,23 +1,23 @@
 import test from "node:test";
 import assert from "node:assert/strict";
-import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
-import { chmod } from "node:fs/promises";
+import { mkdtemp, readFile, rm } from "node:fs/promises";
 import { tmpdir } from "node:os";
 import path from "node:path";
 import { fileURLToPath } from "node:url";
 import { dirname, resolve } from "node:path";
 import { BrainSession } from "../src/session.js";
 import type { ServerToHandMessage } from "../src/protocol.js";
+import { writeFakeClaude } from "./fixtures/fake-claude.js";
 
 const WORKDIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
 
 test("BrainSession can drive the real SDK transport with a fake Claude executable", { concurrency: false }, async (t) => {
-  const tempDir = await mkdtemp(path.join(tmpdir(), "axon-fake-claude-"));
+  const tempDir = await mkdtemp(path.join(tmpdir(), "axon-sdk-spawn-"));
   const argsFile = path.join(tempDir, "argv.json");
   const stdinFile = path.join(tempDir, "stdin.jsonl");
-  const executablePath = path.join(tempDir, "fake-claude");
 
-  await writeFakeClaudeExecutable(executablePath);
+  const fake = await writeFakeClaude({ command: "pwd" });
+  const executablePath = fake.executablePath;
 
   const originalExecutable = process.env.CLAUDE_CODE_EXECUTABLE;
   const originalArgsFile = process.env.AXON_FAKE_CLAUDE_ARGS_FILE;
@@ -33,6 +33,7 @@ test("BrainSession can drive the real SDK transport with a fake Claude executabl
     restoreEnvVar("AXON_FAKE_CLAUDE_STDIN_FILE", originalStdinFile);
   });
   t.after(async () => {
+    await fake.cleanup();
     await rm(tempDir, { recursive: true, force: true });
   });
 
@@ -91,107 +92,6 @@ test("BrainSession can drive the real SDK transport with a fake Claude executabl
   assert.equal(stdinLines.some((entry) => entry.type === "user"), true);
 });
 
-async function writeFakeClaudeExecutable(filePath: string): Promise<void> {
-  const nodeScriptPath = `${filePath}.mjs`;
-  const wrapper = `#!/bin/sh
-exec node "${nodeScriptPath}" "$@"
-`;
-
-  const script = String.raw`#!/usr/bin/env node
-import { appendFile, writeFile } from "node:fs/promises";
-import process from "node:process";
-import readline from "node:readline";
-
-const argsFile = process.env.AXON_FAKE_CLAUDE_ARGS_FILE;
-const stdinFile = process.env.AXON_FAKE_CLAUDE_STDIN_FILE;
-if (!argsFile || !stdinFile) {
-  console.error("missing fake claude env");
-  process.exit(1);
-}
-
-await writeFile(argsFile, JSON.stringify(process.argv.slice(2)), "utf8");
-
-const rl = readline.createInterface({
-  input: process.stdin,
-  crlfDelay: Infinity,
-});
-
-let callbackId = "";
-let hookRequestId = "";
-let userSeen = false;
-
-function emit(message) {
-  process.stdout.write(JSON.stringify(message) + "\n");
-}
-
-for await (const line of rl) {
-  if (!line.trim()) continue;
-  await appendFile(stdinFile, line + "\n", "utf8");
-  const message = JSON.parse(line);
-
-  if (message.type === "control_request" && message.request?.subtype === "initialize") {
-    callbackId = message.request.hooks?.PreToolUse?.[0]?.hookCallbackIds?.[0] ?? "";
-    emit({
-      type: "control_response",
-      response: {
-        subtype: "success",
-        request_id: message.request_id,
-        response: {
-          commands: [],
-          models: [],
-          agents: [],
-          account: null,
-        },
-      },
-    });
-    continue;
-  }
-
-  if (message.type === "user" && !userSeen) {
-    userSeen = true;
-    hookRequestId = "hook-request-1";
-    emit({
-      type: "control_request",
-      request_id: hookRequestId,
-      request: {
-        subtype: "hook_callback",
-        callback_id: callbackId,
-        tool_use_id: "toolu_fake_1",
-        input: {
-          tool_name: "Bash",
-          tool_use_id: "toolu_fake_1",
-          tool_input: { command: "pwd" },
-        },
-      },
-    });
-    continue;
-  }
-
-  if (message.type === "control_response" && message.response?.request_id === hookRequestId) {
-    const additionalContext = message.response?.response?.additionalContext ?? "";
-    emit({
-      type: "assistant",
-      message: {
-        content: [{ type: "text", text: "fake assistant: " + additionalContext }],
-      },
-    });
-    emit({
-      type: "result",
-      subtype: "success",
-      is_error: false,
-      result: "fake done",
-    });
-    break;
-  }
-}
-`;
-
-  await writeFile(filePath, wrapper, "utf8");
-  await chmod(filePath, 0o755);
-  await writeFile(nodeScriptPath, script, "utf8");
-  await chmod(nodeScriptPath, 0o755);
-}
-
 function restoreEnvVar(name: string, value: string | undefined): void {
   if (value === undefined) {
     delete process.env[name];
```

### 新增文件

#### server/test/fixtures/fake-claude.ts

**用途：**
提供可复用的 fake-claude 可执行文件生成器 fixture。用于集成测试中模拟真实 Claude Code SDK 进程，支持配置 Bash 命令、环境变量注入、自动清理。

**完整内容：**
```typescript
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// ============================================================
// FakeClaude Fixture
//
// 生成一个可执行的 fake-claude stub，行为与真实 claude 完全兼容：
//   1. 保存 argv 到 AXON_FAKE_CLAUDE_ARGS_FILE
//   2. 收到 control_request/initialize → 响应 control_response/success，并记录 callbackId
//   3. 收到第一个 user 消息 → 发 hook_callback（触发 PreToolUse），命令为 options.command
//   4. 收到 control_response（hook 响应）→ 发 assistant 文本 + result/success，退出
//
// stdin 内容同时追加到 AXON_FAKE_CLAUDE_STDIN_FILE，供测试断言。
// ============================================================

export interface FakeClaudeOptions {
  /** 触发的 Bash 命令，默认 "pwd" */
  command?: string;
}

export interface FakeClaudeHandle {
  executablePath: string;
  cleanup(): Promise<void>;
}

export async function writeFakeClaude(options?: FakeClaudeOptions): Promise<FakeClaudeHandle> {
  const command = options?.command ?? "pwd";

  const tempDir = await mkdtemp(path.join(tmpdir(), "axon-fake-claude-"));
  const executablePath = path.join(tempDir, "fake-claude");
  const nodeScriptPath = `${executablePath}.mjs`;

  const wrapper = `#!/bin/sh
exec node "${nodeScriptPath}" "$@"
`;

  // 使用 JSON.stringify 将命令安全地嵌入脚本，避免任何转义问题
  const commandLiteral = JSON.stringify(command);

  const script = String.raw`#!/usr/bin/env node
import { appendFile, writeFile } from "node:fs/promises";
import process from "node:process";
import readline from "node:readline";

const argsFile = process.env.AXON_FAKE_CLAUDE_ARGS_FILE;
const stdinFile = process.env.AXON_FAKE_CLAUDE_STDIN_FILE;
if (!argsFile || !stdinFile) {
  console.error("missing fake claude env");
  process.exit(1);
}

await writeFile(argsFile, JSON.stringify(process.argv.slice(2)), "utf8");

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

let callbackId = "";
let hookRequestId = "";
let userSeen = false;

function emit(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

for await (const line of rl) {
  if (!line.trim()) continue;
  await appendFile(stdinFile, line + "\n", "utf8");
  const message = JSON.parse(line);

  if (message.type === "control_request" && message.request?.subtype === "initialize") {
    callbackId = message.request.hooks?.PreToolUse?.[0]?.hookCallbackIds?.[0] ?? "";
    emit({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: {
          commands: [],
          models: [],
          agents: [],
          account: null,
        },
      },
    });
    continue;
  }

  if (message.type === "user" && !userSeen) {
    userSeen = true;
    hookRequestId = "hook-request-1";
    emit({
      type: "control_request",
      request_id: hookRequestId,
      request: {
        subtype: "hook_callback",
        callback_id: callbackId,
        tool_use_id: "toolu_fake_1",
        input: {
          tool_name: "Bash",
          tool_use_id: "toolu_fake_1",
          tool_input: { command: ` + commandLiteral + ` },
        },
      },
    });
    continue;
  }

  if (message.type === "control_response" && message.response?.request_id === hookRequestId) {
    const additionalContext = message.response?.response?.additionalContext ?? "";
    emit({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "fake assistant: " + additionalContext }],
      },
    });
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "fake done",
    });
    break;
  }
}
`;

  await writeFile(executablePath, wrapper, "utf8");
  await chmod(executablePath, 0o755);
  await writeFile(nodeScriptPath, script, "utf8");
  await chmod(nodeScriptPath, 0o755);

  return {
    executablePath,
    cleanup: () => rm(tempDir, { recursive: true, force: true }),
  };
}
```

#### server/test/e2e-hand.test.ts

**用途：**
Brain↔Hand 真端到端测试。验证 Brain 端的 PreToolUse hook 正确拦截工具调用、转发到 Hand、等待执行结果、将摘要传回 SDK 的完整链路。

**内容摘要：**
- 启动真实 AxonServer（port:0 动态分配）
- 实例化 HandClient 通过 WebSocket 连接 Server  
- 使用 fake-claude 发出 Bash tool_call（echo brain-hand-e2e）
- HandClient 的 ToolExecutor 真实执行 Bash
- 验证 tool_result 通过 WebSocket 回传
- 验证 text_chunk + session_end 正常到达

**关键断言：**
- Bash tool_call 被正确转发到 Hand
- tool_call_complete 事件正确生成
- tool_result 摘要（包含 "Bash 完成" 和 "exit_code=0"）作为 text_chunk 返回
- session_end 成功到达

#### server/test/session-resolve-executable.test.ts

**用途：**
单元测试 `resolveClaudeCodeExecutable()` 函数的三个关键行为。

**完整内容：**
```typescript
import process from "node:process";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { resolveClaudeCodeExecutable } from "../src/session.js";

test("resolveClaudeCodeExecutable: 环境变量优先,直接返回(不检查存在性)", () => {
  const original = process.env.CLAUDE_CODE_EXECUTABLE;
  try {
    process.env.CLAUDE_CODE_EXECUTABLE = "/some/explicit/path";
    const result = resolveClaudeCodeExecutable();
    assert.equal(result, "/some/explicit/path");
  } finally {
    if (original === undefined) {
      delete process.env.CLAUDE_CODE_EXECUTABLE;
    } else {
      process.env.CLAUDE_CODE_EXECUTABLE = original;
    }
  }
});

test("resolveClaudeCodeExecutable: 自动探测命中第一个存在的候选路径", async () => {
  const original = process.env.CLAUDE_CODE_EXECUTABLE;
  delete process.env.CLAUDE_CODE_EXECUTABLE;

  const tempDir = await mkdtemp(path.join(tmpdir(), "axon-resolve-exec-"));
  try {
    const fakeBin = path.join(tempDir, "claude");
    await writeFile(fakeBin, "#!/bin/sh\n", "utf8");
    await chmod(fakeBin, 0o755);

    const nonexistent1 = path.join(tempDir, "no-such-a");
    const nonexistent2 = path.join(tempDir, "no-such-b");
    const candidates = [nonexistent1, fakeBin, nonexistent2];

    const result = resolveClaudeCodeExecutable(candidates);
    assert.equal(result, fakeBin);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    if (original === undefined) {
      delete process.env.CLAUDE_CODE_EXECUTABLE;
    } else {
      process.env.CLAUDE_CODE_EXECUTABLE = original;
    }
  }
});

test("resolveClaudeCodeExecutable: 全部候选未命中时抛 Error,消息包含所有候选路径及安装提示", () => {
  const original = process.env.CLAUDE_CODE_EXECUTABLE;
  delete process.env.CLAUDE_CODE_EXECUTABLE;
  try {
    const candidates = ["/no/such/path/a", "/no/such/path/b"];
    assert.throws(
      () => resolveClaudeCodeExecutable(candidates),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("/no/such/path/a"), `message missing candidate a: ${err.message}`);
        assert.ok(err.message.includes("/no/such/path/b"), `message missing candidate b: ${err.message}`);
        assert.ok(err.message.includes("CLAUDE_CODE_EXECUTABLE"), `message missing env var hint: ${err.message}`);
        assert.ok(err.message.includes("brew install"), `message missing brew install hint: ${err.message}`);
        return true;
      }
    );
  } finally {
    if (original === undefined) {
      delete process.env.CLAUDE_CODE_EXECUTABLE;
    } else {
      process.env.CLAUDE_CODE_EXECUTABLE = original;
    }
  }
});
```

### 未跟踪但不应该提交的文件

#### .claude/uncommitted-analysis.md
- **性质：** 之前调查会话产生的临时分析报告
- **应对方式：** gitignore 或删除，不参与提交
- **内容：** 详细的变更分组分析，与当前实际改动有出入（该报告基于旧的视图）

#### .claude/cwd-mapping-bug.md
- **性质：** cwd 容器映射 bug 的调查报告
- **应对方式：** gitignore 或删除，不参与提交
- **说明：** 这是后续 cwd 透传修复任务的背景分析，不是改动本身

#### .claude/cwd-refactor-verify.md
- **性质：** cwd 改造前的验证报告
- **应对方式：** gitignore 或删除，不参与提交
- **说明：** 架构验证文档，用于确保改造方向成立

#### .claude/exec-bug-investigation.md
- **性质：** executable 解析 bug 的调查报告
- **应对方式：** gitignore 或删除，不参与提交
- **说明：** 问题分析和修复方向说明

## 3. 逻辑分组

### 组 A：测试基建补强

**文件：**
- `server/test/fixtures/fake-claude.ts`（新增）
- `server/test/e2e-hand.test.ts`（新增）
- `server/test/session-sdk-spawn.test.ts`（已修改，但主要改动是提取 fixture）

**作用：**
提供复用的 fake-claude fixture，简化集成测试代码。添加 Brain↔Hand 真端到端测试，验证工具调用转发、执行、结果回传的完整链路。

**特点：**
- 基础设施改进，不涉及功能逻辑变更
- session-sdk-spawn.test.ts 的改动主要是代码提取和组织优化（删除 107 行重复代码）
- e2e-hand.test.ts 是全新的深度集成测试

### 组 B：多候选 executable 解析 + 对应测试

**文件：**
- `server/src/session.ts`（已修改，核心功能改动）
- `server/test/session-resolve-executable.test.ts`（新增）
- `server/test/session-flow.test.ts`（已修改，更新测试以适配新 executable 机制）
- `server/test/session-routing.test.ts`（已修改，更新函数调用签名）

**作用：**
- 核心功能：从硬编码单一路径改为多候选自动探测
- 新增环境变量优先、候选路径检查、详细错误消息
- 单元测试覆盖三种场景（env 覆盖、候选探测、错误情况）
- 流程测试确保 executable 正确传递到 SDK

**特点：**
- 修复了 executable 路径发现的可靠性问题
- 支持三种常见安装位置（Homebrew M1、Intel、本地）
- 牵连三个测试文件的改动
- 属于功能增强，向后兼容（旧有硬编码路径作为降级候选）

### 依赖关系

**可独立 commit：YES**

**原因：**
- 组 A（fixture）是纯基础设施，不依赖组 B 的逻辑
- 组 B 的三个 executable 候选路径改动是独立的功能单元
- 虽然 session-sdk-spawn.test.ts 同时用到 fixture 和新 executable 机制，但两个改动在该文件内是解耦的（可以分别提交）

**推荐顺序：**

1. **先提交组 B（executable 解析）** — 因为这是功能修复，优先级更高
2. **再提交组 A（fixture 和 e2e 测试）** — 因为这是测试改进，可以依赖组 B 的改动

**或者：** 合并为一个 commit（如果认为改动已经紧密耦合、分不开）

## 4. 测试状态

### server npm test

**结果：**
```
✔ 24 tests
✔ 24 passed
✔ 0 failed
Duration: 4303.902125 ms
```

**关键通过用例：**
- ✔ Hand↔Brain e2e: HandClient 真实执行 Bash tool_call 并将结果回传 Brain (2824.967708ms)
- ✔ BrainSession streams thought/text chunks and passes Claude executable options to query runner (18.962833ms)
- ✔ BrainSession relays tool calls through Hand and completes once tool_result arrives (1.643125ms)
- ✔ BrainSession converts Claude runner failures into session_end errors (0.457709ms)
- ✔ resolveClaudeCodeExecutable: 环境变量优先,直接返回(不检查存在性) (1.247ms)
- ✔ resolveClaudeCodeExecutable: 自动探测命中第一个存在的候选路径 (8.960833ms)
- ✔ resolveClaudeCodeExecutable: 全部候选未命中时抛 Error,消息包含所有候选路径及安装提示 (0.686041ms)
- ✔ BrainSession can drive the real SDK transport with a fake Claude executable (3707.388083ms)
- ✔ idle session can be restored after reconnect (21.779917ms)
- ✔ detached idle session expires after resume window (90.134959ms)

**失败分析：** 无失败

**改动前后对比：** 所有新增的测试（executable 相关、e2e）和改动后的现有测试（session-flow、session-sdk-spawn）均通过。说明改动未引入回归。

### hand npm test

**结果：**
```
✔ 13 tests
✔ 13 passed
✔ 0 failed
Duration: 1304.442833 ms
```

**关键通过用例：**
- ✔ CLI mode can create session, execute remote Write tool, and exit cleanly (242.875666ms)
- ✔ ACP mode returns clean JSON-RPC responses and notifications (259.487625ms)
- ✔ CLI mode restores the existing session after an idle reconnect (298.03275ms)
- ✔ fs tools read, write, edit, and multi-edit files (13.095834ms)
- ✔ bash tool executes commands and validates timeout (3.626792ms)

**失败分析：** 无失败

**改动影响：** Hand 侧代码未修改，所有测试通过，说明协议和交互完全兼容。

### e2e-hand.test.ts 专项说明

**环境依赖：**
- 需要能启动真实 AxonServer 进程（内部 WebSocket 服务）
- 需要 fake-claude fixture 生成真实可执行文件
- 需要 HandClient 能通过 WebSocket 连接 Server
- 需要 Bash 工具能在 HandClient 本地执行
- 测试声明 `{ concurrency: false, timeout: 15_000 }` — 无并发、15 秒超时

**实际运行情况：**
在 `npm test` 输出中看到：
```
✔ Hand↔Brain e2e: HandClient 真实执行 Bash tool_call 并将结果回传 Brain (2824.967708ms)
```

**通过标志：**
- ✔ 测试通过
- 耗时 2.8 秒（在 15 秒超时内）
- 完整输出中有详细日志（Server 日志打印了 Session 创建、Hand 连接、消息转发等事件）

**链路验证：**
日志显示：
1. Server 启动（port 动态分配）
2. Hand 连接、Session 创建
3. fake-claude 被启动
4. Tool call 转发、Bash 执行、结果回传
5. Server 优雅关闭

所有关键节点都有日志确认，证明真端到端链路完整可靠。

## 5. gitignore 建议

### 现状检查

**`.gitignore` 已包含：**
- `.tmp-tests/` — 第 34 行（✓ 已配置）

**验证：** 
在 git status 输出中未看到 `.tmp-tests/` 目录，说明已被正确 ignore。

### 建议

**新增：** `.claude/` 目录应当 ignore

当前 `.claude/` 中的四个文件（`uncommitted-analysis.md`、`cwd-mapping-bug.md` 等）都是调查报告和临时分析，不应提交。

建议在 `.gitignore` 中添加：
```
.claude/
```

或更细粒度地：
```
.claude/**/*.md
.claude/uncommitted-analysis.md
.claude/cwd-mapping-bug.md
.claude/cwd-refactor-verify.md
.claude/exec-bug-investigation.md
```

**理由：**
- `.claude/` 是项目私有的调查/会话目录
- 其中的 markdown 报告是一次性的分析产物
- 下次新分析会覆盖或新增，无需版本控制

## 6. 最终 commit 切分建议

### Option 1：分离提交（推荐）

#### Commit 1: 多候选 executable 路径探测与单元测试

```
⚙️ 支持多候选 Claude executable 路径自动探测 / Support multi-candidate Claude executable discovery

- 新增 CLAUDE_EXECUTABLE_CANDIDATES 常量列表（支持 M1 Homebrew、Intel、本地安装）
- 重构 resolveClaudeCodeExecutable() 以遍历候选路径、检查存在性、抛出详细错误
- 添加 session-resolve-executable.test.ts 覆盖三种场景（环境变量、候选探测、错误）
- 更新 session-routing.test.ts 适配新的函数签名
- 修复了硬编码单一路径导致的 "executable not found" 问题

包含文件：
- server/src/session.ts
- server/test/session-resolve-executable.test.ts（新增）
- server/test/session-routing.test.ts
```

#### Commit 2: 流程集成测试与 Brain↔Hand e2e

```
🧪 补充会话流程与执行链路集成测试 / Add session flow and execution integration tests

- 提取 fake-claude 生成逻辑为可复用 fixture (fixtures/fake-claude.ts)
- 重构 session-sdk-spawn.test.ts 使用 fixture（删除 107 行重复代码）
- 更新 session-flow.test.ts 使用 fake-claude fixture
- 新增 e2e-hand.test.ts 验证 Brain↔Hand 完整链路（工具转发、执行、结果回传）
- 确保 executable 路径正确传递到 SDK 和 Hand

包含文件：
- server/test/fixtures/fake-claude.ts（新增）
- server/test/e2e-hand.test.ts（新增）
- server/test/session-flow.test.ts
- server/test/session-sdk-spawn.test.ts
```

### Option 2：合并提交

```
⚙️ 注入 claudeCode 可执行路径并补充测试基建 / Inject claude executable path and enhance test infrastructure

- 新增 CLAUDE_EXECUTABLE_CANDIDATES 常量与多候选探测逻辑
- resolveClaudeCodeExecutable() 现支持环境变量优先、自动发现、详细错误
- 提取 fake-claude 为可复用 fixture
- 新增 e2e-hand.test.ts 验证 Brain↔Hand 完整链路
- 新增 session-resolve-executable.test.ts 覆盖三大场景
- 精简 session-sdk-spawn.test.ts 逻辑（重用 fixture）
- 全部 24 个测试通过，无回归

包含文件：
- server/src/session.ts
- server/test/fixtures/fake-claude.ts（新增）
- server/test/e2e-hand.test.ts（新增）
- server/test/session-resolve-executable.test.ts（新增）
- server/test/session-flow.test.ts
- server/test/session-routing.test.ts
- server/test/session-sdk-spawn.test.ts
```

### Commit 3：后续 cwd 透传修复（不在本次）

```
🔧 [方案 A] 修复 cwd 容器透传 bug，删除不必要的容器化 cwd 参数 / Fix cwd container passthrough by removing redundant container cwd param

文件 server/src/session.ts:214 需要删除或注释掉 `cwd: this.cwd` 参数，
因为它把宿主机路径透传给容器内 SDK，导致 SDK 找不到路径而回退到容器 WORKDIR。

详见 .claude/cwd-mapping-bug.md 调查报告。

该修复在当前改动验收后单独提交。
```

## 7. 额外说明

### .claude 下的临时文件处理

当前项目中有以下调查/分析报告文件，不应提交：
- `.claude/uncommitted-analysis.md` — 之前的完整变更分析
- `.claude/cwd-mapping-bug.md` — cwd bug 调查
- `.claude/cwd-refactor-verify.md` — 架构验证
- `.claude/exec-bug-investigation.md` — executable bug 分析

**建议：** 在 `.gitignore` 中添加 `.claude/` 或更细粒度的规则，避免这类临时分析文件被误提交。

### 测试全覆盖确认

- server npm test：24/24 通过（包括 4 个新增或改动的测试）
- hand npm test：13/13 通过（无改动）
- 完整链路 e2e 测试：通过（验证了工具转发、执行、结果回传）

**结论：** 当前改动经过完整测试验证，无回归，质量稳定。
