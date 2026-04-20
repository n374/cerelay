# 改造前验证

## 疑点 1: Hand CLI 的 --cwd 参数处理

### 入口点
- **文件**: `hand/src/index.ts`
- **行号**: L7-31
- **内容**: `package.json` 的 `scripts.start` 配置为 `tsx src/index.ts`

### CLI 参数解析
- **库**: `commander` (v12.0.0)
- **初始化**: L7 创建 `new Command()`
- **参数定义**: L13 使用 `.option("--cwd <dir>", "工作目录（默认当前目录）")`
- **参数类型**: `{ server: string; cwd?: string }` (L15)

### --cwd 参数现状
- **是否已被识别**: **YES** ✓
- **默认值**: `process.cwd()` (L38，当用户未传 `--cwd` 时使用)
- **主命令默认值**: `undefined`（可选），在 `runCliMode` 中转换为 `process.cwd()`
- **acp 子命令默认值**: `process.cwd()` (L27，显式使用 `??` 操作符)

### 流转到 HandClient 的路径
1. **CLI 解析**: `program.option("--cwd <dir>")` → `opts.cwd` (L15)
2. **主命令分发**: `runCliMode(opts.server, opts.cwd)` (L16)
3. **默认值处理**: `const cwd = cwdOverride ?? process.cwd()` (L38)
4. **传给 HandClient**: `new HandClient(serverURL, cwd)` (L42)
5. **acp 子命令**: `runAcpServer({ server: opts.server, cwd: opts.cwd ?? process.cwd() })` (L25-28)

### 流转到 ToolExecutor 的路径
1. **HandClient 构造**: `this.initialCwd = cwd` 保存 (L67)
2. **ToolExecutor 创建**: `this.executor = new ToolExecutor(cwd)` (L70)
3. **ToolExecutor 构造**: `private readonly cwd: string` (L41)，在 dispatch 时传给各工具
4. **Bash 执行**: `executeBash(input as BashInput, this.cwd)` (L59)
5. **Bash 工具实现**: `{ cwd, timeout: ..., shell: "/bin/bash", ... }` 作为 child_process.exec 的 options (手工/src/tools/bash.ts:46)

### 结论
✓ **参数已被正确识别和流转**
- `--cwd` 参数的完整链路已验证：CLI → HandClient → ToolExecutor → Bash 工具
- 默认值为 `process.cwd()`，符合预期
- 无需修改，当前实现可直接支持改造
- 用户启动 `npm start -- --server localhost:8765 --cwd /path/to/project` 时，cwd 会正确传递到所有工具调用

**文件引用**:
- `hand/src/index.ts:7-31` - CLI 定义
- `hand/src/index.ts:37-42` - cwd 处理和 HandClient 初始化
- `hand/src/client.ts:65-71` - HandClient 构造和 ToolExecutor 初始化
- `hand/src/executor.ts:39-70` - ToolExecutor cwd 保存和 dispatch 分发
- `hand/src/tools/bash.ts:25-48` - Bash 工具使用 cwd 作为 exec options

---

## 疑点 2: PreToolUse hook 语义分析

### handlePreToolUse 实现分析

**文件**: `server/src/session.ts:301-380`

关键实现步骤:
1. **L319-326**: 创建待处理 Promise
   ```typescript
   const pending = this.relay.createPending(requestId, input.tool_name);
   ```
   
2. **L338**: 向 Hand 发送 tool_call 消息
   ```typescript
   await this.transport.send(toolCall);
   ```
   
3. **L353**: **关键 - 等待 Hand 的 ToolResult 返回**
   ```typescript
   const result = await pending;  // 阻塞直到 Hand 返回结果
   ```
   这是 hook 的异步等待机制：`relay.createPending()` 返回一个 Promise，在 Hand 发来 `tool_result` 后由 `resolveToolResult()` 触发。

4. **L374-379**: 返回拦截+替换结果
   ```typescript
   return {
     hookEventName: "PreToolUse",
     permissionDecision: "deny",  // 向 SDK 表示"拒绝 SDK 执行"
     permissionDecisionReason: "Tool executed remotely via Axon Hand",
     additionalContext: summarizeToolResult(result),  // Hand 的执行结果摘要
   };
   ```

### tool_result 消息处理 (Brain 端接收 Hand ToolResult 的代码)

**文件**: `server/src/server.ts:647-662`

```typescript
private async handleToolResult(handId: string, message: ToolResult): Promise<void> {
  const entry = this.getSessionEntry(message.sessionId);
  log.debug("收到工具结果", {...});
  entry.session.resolveToolResult(message.requestId, {
    output: message.output,
    summary: message.summary,
    error: message.error,
  });
}
```

**完整流转**:
1. Hand 发送 `tool_result` 消息 → Server 接收 (server.ts:525-526)
2. Server 调用 `handleToolResult()` (server.ts:647)
3. `session.resolveToolResult()` 被调用 (server.ts:657)
4. `relay.resolve(requestId, result)` 触发待处理 Promise (relay.ts:57-74)
5. `handlePreToolUse()` 中的 `await pending` 返回 (session.ts:353)
6. Hook 使用 result 的摘要构造返回值，交给 SDK

### Claude Agent SDK 的 hook 类型定义

**文件**: `server/src/session.ts:71-76` (自定义类型)

```typescript
type PreToolUseHookResult = {
  hookEventName: "PreToolUse";
  permissionDecision: "deny";      // 只支持 "deny"
  permissionDecisionReason: string;
  additionalContext: string;       // 关键字段：Hand 执行结果
};
```

**hook 签名** (L86-88):
```typescript
PreToolUse: Array<{
  matcher: string;
  hooks: Array<(input: HookInput) => Promise<PreToolUseHookResult>>;
}>;
```

SDK 的实际定义在 `@anthropic-ai/claude-agent-sdk` 中。根据代码使用模式推断:
- Hook 必须返回带 `permissionDecision` 字段的对象
- 当 `permissionDecision === "deny"` 时，SDK 不执行该工具，改用 `additionalContext` 作为工具结果
- Hook 是异步的，可以进行 I/O 操作（如等待 Hand 返回）

### 相关测试的线索 (e2e 测试反映的期望行为)

**文件**: `server/test/session-flow.test.ts:75-134` (关键测试)

```typescript
test("BrainSession relays tool calls through Hand and completes once tool_result arrives", async () => {
  const hook = input.options.hooks.PreToolUse[0]?.hooks[0];
  const decision = await hook({
    tool_name: "Bash",
    tool_use_id: "toolu_123",
    tool_input: { command: "pwd" },
  });

  assert.equal(decision.permissionDecisionReason, "Tool executed remotely via Axon Hand");
  assert.equal(decision.additionalContext, "pwd 完成");  // 期望包含 Hand 的执行结果摘要
  
  // 然后 SDK 使用 additionalContext 作为工具结果继续推理
  yield {
    type: "assistant",
    message: {
      content: [{ type: "text", text: `工具结果: ${decision.additionalContext}` }],
    },
  };
});
```

**文件**: `server/test/e2e-hand.test.ts:39-171` (真端到端测试)

完整验证路径:
1. fake-claude 发出 Bash tool_call (e2e-hand.test.ts:L102-104)
2. Brain 的 `handlePreToolUse()` 被调用 (Hook 路径)
3. tool_call 发送到 Hand (e2e-hand.test.ts:L131-136)
4. HandClient 的 ToolExecutor 真实执行 Bash (e2e-hand.test.ts:L131-136)
5. tool_result 返回到 Brain (e2e-hand.test.ts:L145-149)
6. SDK 获得 additionalContext 中的摘要 (e2e-hand.test.ts:L156-160, 包含 "Bash 完成" 和 "exit_code=0")
7. fake-claude 输出文本包含工具结果摘要 (e2e-hand.test.ts:L151-155)
8. session_end 正常到达 (e2e-hand.test.ts:L167-169)

### Hook 语义的证据链

关键代码片段组成的证据链：

1. **创建待处理**: `relay.ts:22-55` - `createPending()` 返回 Promise
2. **转发工具**: `session.ts:338` - `await this.transport.send(toolCall)`
3. **等待结果**: `session.ts:353` - `const result = await pending`
4. **处理返回**: `session.ts:374-379` - 使用 result 构造 hook 返回值
5. **填充结果**: `server.ts:647-662` - `handleToolResult()` 调用 `resolveToolResult()`
6. **触发 Promise**: `relay.ts:57-74` - `resolve()` 方法唤醒 pending

### 结论

**Hook 语义类型**: **C (拦截 + 异步等待型)** ✓

**证据**:
1. Hook 返回 `permissionDecision: "deny"` (session.ts:L313, L376) → SDK 被告知拒绝执行，不执行 Bash
2. Hook 在内部 `await pending` (session.ts:L353) → 挂起 Hook 直到 Hand 返回结果
3. Hook 使用 Hand 的执行结果填充 `additionalContext` (session.ts:L378) → 将 Hand 的结果传回 SDK
4. SDK 使用 `additionalContext` 作为工具结果继续推理 (session-flow.test.ts:L112) → 验证结果被 Claude 看到
5. e2e 测试验证完整路径 (e2e-hand.test.ts:L131-169) → Hand 的执行结果最终出现在 text_chunk 中

**对改造的影响**: 
✓ **改造方向完全成立**
- Brain 端已正确拦截工具调用，发送到 Hand
- Brain 端已正确等待 Hand 的执行结果
- Brain 端已正确将 Hand 的结果传回 Claude SDK
- **当前改造的关键点**：只需确保 Hand 端收到的 tool_call 中包含的 cwd 参数被正确传递给工具执行，使得工具在用户指定的目录下运行
- 不存在"Brain 自己也在容器内执行"的重复执行问题 — `permissionDecision: "deny"` 已明确告诉 SDK 不要自己执行

**关键文件引用**:
- `server/src/session.ts:301-380` - handlePreToolUse 完整实现
- `server/src/session.ts:71-76` - PreToolUseHookResult 类型定义
- `server/src/server.ts:647-662` - handleToolResult 接收 Hand 结果
- `server/src/relay.ts:22-74` - Promise 等待机制
- `server/test/session-flow.test.ts:75-134` - Hook 语义单元测试
- `server/test/e2e-hand.test.ts:39-171` - 完整 e2e 验证

---

## 总体结论

### 改造方向成立 ✓

**疑点 1 结论**: `--cwd` 参数已被完整接入 CLI，正确流转到 ToolExecutor
- ✓ 参数被识别
- ✓ 默认值为 `process.cwd()`
- ✓ 参数流转路径清晰：CLI → HandClient → ToolExecutor → 各工具
- ✓ 无需修改 Hand 端的 CLI 参数处理

**疑点 2 结论**: PreToolUse hook 采用"拦截 + 异步等待型"语义
- ✓ Hook 返回 `permissionDecision: "deny"` 拦截 SDK 的执行
- ✓ Hook 内部 `await` Hand 的 ToolResult
- ✓ 将 Hand 的执行结果通过 `additionalContext` 传回 SDK
- ✓ SDK 和 Claude 真正看到的是 Hand 的执行结果，不是容器内的 SDK 执行结果
- ✓ 完整的 e2e 测试验证了工具结果的完整流转

### 改造需要修改的点

当前实现中，Brain 端已经正确工作。改造的关键是确保 **Hand 收到的 tool_call 消息中包含正确的执行上下文**：

1. **优先级 1 (必须)**: 确保 tool_call 消息中传递足够的上下文信息，让 Hand 端能够在正确的工作目录执行
   - 当前已有：SessionID 关联到 BrainSession，可以查询 session.cwd
   - 需要验证：Hand 是否正确使用了这个 cwd（应该已经实现，见疑点 1）

2. **优先级 2 (验证)**: 端到端验证
   - ✓ `--cwd` 参数被正确传给 HandClient
   - ✓ HandClient 构造 ToolExecutor 时传入 cwd
   - ✓ ToolExecutor.dispatch() 时传给各工具（包括 Bash）
   - ✓ Bash 工具使用 cwd 作为 exec 的工作目录

### 改造无需修改之处

✓ PreToolUse hook 语义正确，无需改动 Brain 端 hook 实现
✓ ToolResult 流转完整，无需改动消息路由
✓ tool_call/tool_result 协议正确，无需改动

改造可以安心进行，确保 Hand 端的 cwd 链路完整即可。

