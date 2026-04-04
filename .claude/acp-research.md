# ACP 与 Claude Code 编程接口调研报告

> 调研日期: 2026-04-05
> 调研目的: 评估能否通过程序化方式启动和控制 Claude Code 子进程

---

## 一、整体结论

**完全可行，且有三条成熟路径**，从简单到完整：

| 路径 | 复杂度 | 控制粒度 | 适用场景 |
|------|--------|---------|---------|
| Claude CLI `--print` | 最低 | 单次问答 | 脚本、CI/CD、简单自动化 |
| Claude Agent SDK (`query()`) | 中等 | 流式消息、工具拦截、多轮对话 | 编排器、Agent 框架 |
| ACP 协议 (stdio) | 最高 | 完整会话管理、权限控制、终端管理 | IDE 集成、编辑器插件 |

---

## 二、ACP (Agent Client Protocol) 协议

### 2.1 协议概述

ACP 是 **代码编辑器与 AI Coding Agent 之间的标准通信协议**，由 Zed 编辑器团队主导，类似 LSP 但面向 AI Agent。

- **协议版本**: `PROTOCOL_VERSION = 1`（首个正式版）
- **稳定性**: 核心方法稳定，部分方法标记 `UNSTABLE`
- **传输层**: **NDJSON over stdio**（换行分隔的 JSON，通过子进程的 stdin/stdout）
- **消息格式**: **JSON-RPC 2.0**（标准的 `{ jsonrpc: "2.0", id, method, params }` / `{ jsonrpc: "2.0", id, result }` / `{ jsonrpc: "2.0", method, params }` 通知）
- **TypeScript SDK**: `@agentclientprotocol/sdk` v0.18.0（Apache-2.0）

### 2.2 核心 RPC 方法

#### Agent 侧方法（Client -> Agent 调用）

| 方法 | JSON-RPC method | 说明 | 稳定性 |
|------|----------------|------|--------|
| `initialize` | `initialize` | 协议握手，协商版本和能力 | 稳定 |
| `authenticate` | `authenticate` | 认证 | 稳定 |
| `newSession` | `session/new` | 创建新会话 | 稳定 |
| `loadSession` | `session/load` | 加载已有会话 | 稳定 |
| `listSessions` | `session/list` | 列出会话 | 稳定 |
| `prompt` | `session/prompt` | 发送 prompt，等待完成 | 稳定 |
| `cancel` | `session/cancel` | 取消正在执行的 prompt | 稳定 |
| `setSessionMode` | `session/set_mode` | 切换模式（ask/architect/code） | 稳定 |
| `setSessionConfigOption` | `session/set_config_option` | 设置会话配置 | 稳定 |
| `forkSession` | `session/fork` | 分叉会话 | UNSTABLE |
| `resumeSession` | `session/resume` | 恢复会话（不回放历史） | UNSTABLE |
| `closeSession` | `session/close` | 关闭会话 | UNSTABLE |
| `setSessionModel` | `session/set_model` | 切换模型 | UNSTABLE |
| `logout` | `logout` | 登出 | UNSTABLE |

#### Client 侧方法（Agent -> Client 调用）

| 方法 | JSON-RPC method | 说明 |
|------|----------------|------|
| `sessionUpdate` | `session/update` | Agent 推送更新（文本块、工具调用、计划等） |
| `requestPermission` | `session/request_permission` | Agent 请求用户授权工具执行 |
| `readTextFile` | `fs/read_text_file` | Agent 读取客户端文件系统 |
| `writeTextFile` | `fs/write_text_file` | Agent 写入客户端文件系统 |
| `createTerminal` | `terminal/create` | Agent 创建终端执行命令 |
| `terminalOutput` | `terminal/output` | 获取终端当前输出 |
| `waitForTerminalExit` | `terminal/wait_for_exit` | 等待终端命令完成 |
| `killTerminal` | `terminal/kill` | 终止终端命令 |
| `releaseTerminal` | `terminal/release` | 释放终端资源 |

### 2.3 SessionUpdate 事件类型

Agent 通过 `session/update` 通知推送：

- `agent_message_chunk` — 文本/图像内容块
- `agent_thought_chunk` — 思考过程
- `user_message_chunk` — 用户消息回放
- `tool_call` — 工具调用（pending/completed/error）
- `tool_call_update` — 工具调用状态更新
- `plan` — 执行计划

---

## 三、Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)

### 3.1 概述

这是 **Anthropic 官方的 Agent SDK**（前身为 `@anthropic-ai/claude-code` SDK），版本 v0.2.92。

**核心机制**：SDK 内部 spawn 一个 Claude Code CLI 子进程，通过 stdio 通信。`query()` 返回一个 `AsyncGenerator<SDKMessage>`。

### 3.2 核心 API

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

// 单次问答
const q = query({
  prompt: "帮我分析这个项目的架构",
  options: {
    cwd: "/path/to/project",
    model: "claude-sonnet-4-6",
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    // 工具拦截
    canUseTool: async (toolName, input, opts) => {
      return { behavior: "allow" };
    },
    // 流式部分消息
    includePartialMessages: true,
    // 自定义 MCP 服务器
    mcpServers: { ... },
    // 自定义子 Agent
    agents: { ... },
    // 结构化输出
    outputFormat: {
      type: "json_schema",
      schema: { ... }
    },
  }
});

// 流式消费
for await (const message of q) {
  switch (message.type) {
    case "assistant": // 完整助手消息（含 tool_use）
    case "system":    // 系统消息
    case "result":    // 最终结果
  }
}

// 控制方法（流式输入模式下）
await q.interrupt();
await q.setModel("claude-opus-4-6");
await q.setPermissionMode("default");
await q.close();
```

### 3.3 关键特性

- **`Query` 是 `AsyncGenerator<SDKMessage>`**: 支持 `for await...of` 流式消费
- **工具拦截**: `canUseTool` 回调在每次工具执行前触发，可 allow/deny
- **Hook 系统**: `PreToolUse`, `PostToolUse`, `PermissionRequest` 等 26 种钩子事件
- **多轮对话**: `prompt` 支持 `AsyncIterable<SDKUserMessage>` 实现流式输入
- **会话管理**: `listSessions()`, `getSessionInfo()`, `getSessionMessages()`, `forkSession()`, `renameSession()`
- **子 Agent**: 通过 `agents` 定义，支持不同模型、工具集、权限模式
- **自定义 spawn**: `spawnClaudeCodeProcess` 选项支持 VM/容器/远程执行
- **MCP 集成**: 支持 stdio/SSE/HTTP 和进程内 SDK MCP 服务器

---

## 四、Claude Code CLI `--print` 模式

### 4.1 基本用法

```bash
# 文本输出
claude -p "帮我写个函数" --model sonnet

# JSON 输出
claude -p "分析代码" --output-format json

# 流式 JSON
claude -p "重构代码" --output-format stream-json --include-partial-messages

# 流式输入+输出（双向 JSON-RPC 流）
claude --input-format stream-json --output-format stream-json
```

### 4.2 关键 Flag

- `--print` / `-p`: 非交互模式，输出结果后退出
- `--output-format json|stream-json|text`: 输出格式
- `--input-format stream-json`: 流式输入（多轮对话）
- `--model <model>`: 模型选择
- `--dangerously-skip-permissions`: 跳过所有权限检查
- `--permission-mode <mode>`: 权限模式
- `--allowedTools`: 白名单工具
- `--disallowedTools`: 黑名单工具
- `--system-prompt`: 自定义系统提示
- `--mcp-config`: MCP 服务器配置
- `--max-budget-usd`: 预算限制
- `--json-schema`: 结构化输出 schema
- `--session-id`: 指定会话 ID
- `--resume`: 恢复会话
- `--agents`: JSON 定义自定义 Agent

---

## 五、`@agentclientprotocol/claude-agent-acp`

### 5.1 概述

这是 **ACP 协议到 Claude Agent SDK 的桥接适配器**，v0.25.0。由 ACP 社区（Zed 团队）维护。

它实现了 `Agent` 接口，内部使用 `@anthropic-ai/claude-agent-sdk` 的 `query()` 来驱动 Claude Code。

### 5.2 架构

```
ACP Client (Zed / 自定义编辑器)
    |
    | NDJSON over stdio (JSON-RPC 2.0)
    |
claude-agent-acp (桥接层)
    |
    | spawn 子进程 + stdio
    |
Claude Code CLI
    |
    | HTTPS
    |
Claude API
```

### 5.3 支持的特性

- 上下文 @-mentions
- 图片
- 工具调用（含权限请求）
- Following（编辑跟踪）
- Edit Review
- TODO 列表
- 交互式和后台终端
- Slash Commands
- Client MCP 服务器

### 5.4 使用方式

```bash
# 安装
npm install @agentclientprotocol/claude-agent-acp

# 运行（作为 ACP Agent 进程，等待 stdio 输入）
npx claude-agent-acp
```

---

## 六、推荐集成方式

### 场景 1: 简单编排 / CI

直接使用 Claude Agent SDK：

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

const result = query({
  prompt: "分析并修复这个 bug",
  options: {
    cwd: "/project",
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  }
});

for await (const msg of result) {
  if (msg.type === "result") {
    console.log(msg.subtype === "success" ? msg.result : msg.error);
  }
}
```

### 场景 2: 带工具拦截的 Agent 编排

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

const q = query({
  prompt: "重构认证模块",
  options: {
    cwd: "/project",
    canUseTool: async (toolName, input, opts) => {
      if (toolName === "Bash" && String(input.command).includes("rm")) {
        return { behavior: "deny", message: "禁止删除操作" };
      }
      return { behavior: "allow" };
    },
    hooks: {
      PostToolUse: [{
        hooks: [async (input) => {
          console.log(`工具执行完成: ${input.tool_name}`);
          return {};
        }]
      }]
    }
  }
});
```

### 场景 3: IDE/编辑器集成

使用 ACP 协议：

```typescript
import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { Writable, Readable } from "node:stream";

// 启动 claude-agent-acp 子进程
const agent = spawn("npx", ["claude-agent-acp"], {
  stdio: ["pipe", "pipe", "inherit"]
});

const stream = acp.ndJsonStream(
  Writable.toWeb(agent.stdin!),
  Readable.toWeb(agent.stdout!)
);

const client = new acp.ClientSideConnection(
  (_agent) => ({
    requestPermission: async (params) => ({
      outcome: { outcome: "selected", optionId: params.options[0].optionId }
    }),
    sessionUpdate: async (params) => {
      const update = params.update;
      if (update.sessionUpdate === "agent_message_chunk") {
        process.stdout.write(update.content.text);
      }
    }
  }),
  stream
);

// 握手
await client.initialize({
  protocolVersion: acp.PROTOCOL_VERSION,
  clientCapabilities: {}
});

// 创建会话
const { sessionId } = await client.newSession({
  cwd: process.cwd(),
  mcpServers: []
});

// 发送 prompt
const result = await client.prompt({
  sessionId,
  prompt: [{ type: "text", text: "帮我分析项目架构" }]
});

console.log("完成:", result.stopReason);
```

---

## 七、最小 POC 推荐

**推荐使用 Claude Agent SDK**，而非直接用 ACP 协议。原因：

1. SDK 封装了子进程管理、消息序列化、重连等细节
2. `query()` 返回 `AsyncGenerator`，API 简洁
3. 直接支持工具拦截（`canUseTool`）、Hook、多轮对话
4. ACP 协议适合 IDE 集成场景，对于 Agent 编排来说过于底层

### 最小 POC（TypeScript）

```typescript
// poc.ts
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

async function main() {
  const q = query({
    prompt: "用一句话总结当前目录的项目结构",
    options: {
      cwd: process.cwd(),
      model: "claude-sonnet-4-6",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
    }
  });

  for await (const message of q) {
    switch (message.type) {
      case "assistant":
        // 完整的助手回复
        for (const block of message.message.content) {
          if (block.type === "text") {
            process.stdout.write(block.text);
          }
        }
        break;
      case "result":
        if (message.subtype === "success") {
          console.log("\n\n结果:", message.result);
        } else {
          console.error("错误:", message.error);
        }
        break;
    }
  }
}

main();
```

```bash
npm init -y
npm install @anthropic-ai/claude-agent-sdk
npx tsx poc.ts
```

---

## 八、关键注意事项

1. **认证**: SDK 复用 Claude Code 的认证（OAuth / API Key）。确保 `claude auth` 已完成或设置 `ANTHROPIC_API_KEY`。
2. **权限模式**: 生产环境建议用 `canUseTool` 回调精确控制，而非 `bypassPermissions`。
3. **成本控制**: 使用 `maxBudgetUsd` 或 `maxTurns` 限制。
4. **SDK 命名变更**: `@anthropic-ai/claude-code` -> `@anthropic-ai/claude-agent-sdk`（已更名，有迁移指南）。
5. **ACP 协议版本**: 当前 v1，核心稳定，但 `session/fork`、`session/resume`、`session/close` 等仍为 UNSTABLE。
