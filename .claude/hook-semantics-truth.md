# PreToolUse Hook 真实语义溯源

> SDK 版本: `@anthropic-ai/claude-agent-sdk@0.2.92` (claudeCodeVersion: `2.1.92`)
>
> 关键文件:
> - `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` (薄壳，spawn cli.js)
> - `node_modules/@anthropic-ai/claude-agent-sdk/cli.js` (16938 行，hook 真实解析与派发逻辑)

---

## 一句话结论

**deny + additionalContext 能不能替换真实 Claude SDK 的 tool 执行？**

> **NO，证据等级 STRONG。**
>
> 而且更糟糕：axon 当前 session.ts 里写的那种 "deny + additionalContext" 在真实 cli.js 里**根本没生效** ——
> 因为返回值放错了层级，cli.js 的 `BO7` 解析器直接把它丢弃，hook 等同于空返回，
> 然后 `canUseTool` fallback 又返回 `allow`，于是 cli.js 就在容器里**自己直接执行了 Bash**。
> 这正好解释了 `pwd` 返回 `/tmp` 的现象。

---

## Q1: SDK 处理 PreToolUse hook 的实际逻辑

### 整体架构（必须先理解）

`@anthropic-ai/claude-agent-sdk` 的 `query()` 函数其实**不是**自己执行 Claude 推理的。它做两件事：

1. spawn 子进程 `cli.js`（这是真正跑 Claude Code 的内核，13MB 的混淆代码）
2. 在 SDK 进程内维护一个 `pX` (Query) 类，通过 stdio JSON 行协议与 cli.js 双向通信

SDK 进程暴露给用户的 hook 回调，是通过 cli.js 发起的 `control_request {subtype: "hook_callback"}` 反向调用回 SDK 进程的 —— 也就是说，**hook 的执行流程是：cli.js → control_request → SDK 进程跑 callback → control_response → cli.js**。

而**对 hook 返回值的解析与语义分发，全部发生在 cli.js 内部**。SDK 进程对返回值是完全透传的、零解释。

### 源码位置 1: SDK 进程侧的 hook 派发（透明转发）

**文件**: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`
**行 60 + 行 62**: `pX` 类的 `processControlRequest` 与 `handleHookCallbacks`

```js
// sdk.mjs L60 (压缩后所在行)
async processControlRequest($, X) {
    if ($.request.subtype === "can_use_tool") {
        if (!this.canUseTool) throw Error("canUseTool callback is not provided.");
        return {
            ...await this.canUseTool($.request.tool_name, $.request.input, {
                signal: X,
                suggestions: $.request.permission_suggestions,
                blockedPath: $.request.blocked_path,
                decisionReason: $.request.decision_reason,
                title: $.request.title,
                displayName: $.request.display_name,
                description: $.request.description,
                toolUseID: $.request.tool_use_id,
                agentID: $.request.agent_id
            }),
            toolUseID: $.request.tool_use_id
        };
    }
    else if ($.request.subtype === "hook_callback")
        return await this.handleHookCallbacks(
            $.request.callback_id,
            $.request.input,
            $.request.tool_use_id,
            X
        );
    // ... mcp_message / elicitation / ...
    throw Error("Unsupported control request subtype: " + $.request.subtype);
}

// sdk.mjs L62
handleHookCallbacks($, X, J, Q) {
    let Y = this.hookCallbacks.get($);
    if (!Y) throw Error(`No hook callback found for ID: ${$}`);
    return Y(X, J, { signal: Q });
}
```

**自然语言解读**:

- SDK 注册 hook 时（`pX.initialize()`），把每个 callback 存进 `this.hookCallbacks: Map<string, callback>`，给每个 callback 分配一个 `hook_${n}` 形式的 ID，**只把 ID 列表 + matcher 发送给 cli.js**：
  ```js
  // sdk.mjs L60 initialize 方法
  if (this.hooks) {
      $ = {};
      for (let [Y, z] of Object.entries(this.hooks))
          if (z.length > 0)
              $[Y] = z.map((W) => {
                  let G = [];
                  for (let U of W.hooks) {
                      let H = `hook_${this.nextCallbackId++}`;
                      this.hookCallbacks.set(H, U);
                      G.push(H);
                  }
                  return { matcher: W.matcher, hookCallbackIds: G, timeout: W.timeout };
              });
  }
  ```

- 当 cli.js 决定触发 PreToolUse hook 时，它发 `control_request {subtype: "hook_callback", callback_id, input, tool_use_id}` 给 SDK 进程。

- SDK 进程 `handleHookCallbacks` 的实现**只有 3 行**：查表 → 调用用户 callback → 返回值原样返回（包成 `control_response`）。**没有任何对 `permissionDecision` / `additionalContext` 的解析**。

- **结论 1**：所有对返回值的解释权都在 cli.js 那一侧。

### 源码位置 2: cli.js 内部的 hook 输出解析器 `BO7`

**文件**: `node_modules/@anthropic-ai/claude-agent-sdk/cli.js`
**行 7782**: `function BO7({json: q, command: K, ...})` —— 解析任何形态的 hook 输出（HTTP / 命令行 stdout / SDK callback 共用此解析器）。

```js
function BO7({json: q, command: K, hookName: _, toolUseID: z, hookEvent: Y,
              expectedHookEvent: O, stdout: A, stderr: $, exitCode: w, durationMs: j}) {
    let H = {}, J = q;

    // 1. 顶层 continue
    if (J.continue === false) {
        H.preventContinuation = true;
        if (J.stopReason) H.stopReason = J.stopReason;
    }

    // 2. 顶层 decision (legacy "approve"/"block")
    if (q.decision) switch (q.decision) {
        case "approve": H.permissionBehavior = "allow"; break;
        case "block":   H.permissionBehavior = "deny";
                        H.blockingError = {blockingError: q.reason || "Blocked by hook", command: K};
                        break;
        default: throw Error(`Unknown hook decision type: ${q.decision}. Valid types are: approve, block`);
    }

    // 3. systemMessage
    if (q.systemMessage) H.systemMessage = q.systemMessage;

    // 4. (兼容旧版) hookSpecificOutput.permissionDecision
    if (q.hookSpecificOutput?.hookEventName === "PreToolUse"
        && q.hookSpecificOutput.permissionDecision) {
        switch (q.hookSpecificOutput.permissionDecision) {
            case "allow": H.permissionBehavior = "allow"; break;
            case "deny":  H.permissionBehavior = "deny";
                          H.blockingError = {blockingError: q.reason || "Blocked by hook", command: K};
                          break;
            case "ask":   H.permissionBehavior = "ask"; break;
            case "defer": H.permissionBehavior = "defer"; break;
            default: throw Error(`Unknown hook permissionDecision type: ${q.hookSpecificOutput.permissionDecision}. Valid types are: allow, deny, ask, defer`);
        }
    }
    if (H.permissionBehavior !== void 0 && q.reason !== void 0)
        H.hookPermissionDecisionReason = q.reason;

    // 5. ★ 真正的 hookSpecificOutput dispatcher
    if (q.hookSpecificOutput) {
        if (O && q.hookSpecificOutput.hookEventName !== O)
            throw Error(`Hook returned incorrect event name: expected '${O}' but got '${q.hookSpecificOutput.hookEventName}'. Full stdout: ...`);
        switch (q.hookSpecificOutput.hookEventName) {
            case "PreToolUse":
                if (q.hookSpecificOutput.permissionDecision)
                    switch (q.hookSpecificOutput.permissionDecision) {
                        case "allow": H.permissionBehavior = "allow"; break;
                        case "deny":  H.permissionBehavior = "deny";
                                      H.blockingError = {
                                          blockingError: q.hookSpecificOutput.permissionDecisionReason
                                                       || q.reason || "Blocked by hook",
                                          command: K
                                      };
                                      break;
                        case "ask":   H.permissionBehavior = "ask"; break;
                        case "defer": H.permissionBehavior = "defer"; break;
                    }
                H.hookPermissionDecisionReason = q.hookSpecificOutput.permissionDecisionReason;
                if (q.hookSpecificOutput.updatedInput) H.updatedInput = q.hookSpecificOutput.updatedInput;
                H.additionalContext = q.hookSpecificOutput.additionalContext;
                break;
            case "UserPromptSubmit":  H.additionalContext = q.hookSpecificOutput.additionalContext; break;
            case "SessionStart": ...
            case "PostToolUse":
                if (H.additionalContext = q.hookSpecificOutput.additionalContext,
                    q.hookSpecificOutput.updatedMCPToolOutput)
                    H.updatedMCPToolOutput = q.hookSpecificOutput.updatedMCPToolOutput;
                break;
            // ...
        }
    }
    return H;
}
```

**致命点**：`BO7` 只从两个地方读取 `permissionDecision`：
- 顶层 `q.decision`（接受 `"approve"` / `"block"` 老格式）
- `q.hookSpecificOutput.permissionDecision`（接受 `"allow"`/`"deny"`/`"ask"`/`"defer"`）

**`q.permissionDecision`（顶层）会被完全忽略**。同理 `q.additionalContext`（顶层）也会被忽略 —— 它只从 `q.hookSpecificOutput.additionalContext` 读。

### 源码位置 3: SDK callback hook 的接线 `ZpY`

**文件**: cli.js
**行 7803**: `async function ZpY({...})` —— SDK callback hook 调用入口

```js
async function ZpY({toolUseID: q, hook: K, hookEvent: _, hookInput: z,
                    signal: Y, hookIndex: O, toolUseContext: A}) {
    let $ = A ? {getAppState: A.getAppState, updateAttributionState: A.updateAttributionState} : void 0;
    let w = await K.callback(z, q, Y, O, $);   // ★ 调用用户回调
    if (ix(w))
        return { outcome: "success", hook: K };  // 异步标记（async:true），跳过解析
    return {
        ...BO7({                                  // ★ 直接喂给 BO7
            json: w,
            command: "callback",
            hookName: `${_}:Callback`,
            toolUseID: q,
            hookEvent: _,
            expectedHookEvent: _,
            stdout: void 0,
            stderr: void 0,
            exitCode: void 0
        }),
        outcome: "success",
        hook: K
    };
}

// 同文件 line 7751
function ix(q) { return "async" in q && q.async === true; }
```

**自然语言解读**：用户的 callback 返回值 `w` 不经过任何包装、不经过任何字段重命名，**直接作为 `json` 参数喂给 `BO7`**。所以 BO7 的字段读取规则就是 SDK callback hook 的真实契约。

### 源码位置 4: hook 结果如何影响 tool 执行 (`I0K` + `x0K` + 主消费者)

**文件**: cli.js
**行 4111**: `async function x0K(q, K, _, z, Y, O, A)` —— 权限决策融合器
**行 4111**: `async function* I0K(q, K, _, z, Y, O, A, $)` —— PreToolUse hook 跑批生成器
**行 4113**: tool 执行的主流程，消费 I0K 的事件流

```js
// L4111: I0K 把 hook 输出 (BO7 解析后的 H 字段) 转换成 typed events
async function* I0K(q, K, _, z, Y, O, A, $) {
    let w = Date.now(), j, H = !1;
    try {
        let J = q.getAppState();
        for await (let M of Xq7(K.name, z, _, q, J.toolPermissionContext.mode,
                                  q.abortController.signal, void 0,
                                  q.requestPrompt, K.getToolUseSummary?.(_)))
        try {
            if (M.message)
                yield { type: "message", message: { message: M.message } };

            if (M.blockingError) {  // 来自 BO7 第 4 步 (legacy hookSpecificOutput.permissionDecision==="deny" 或顶层 decision==="block")
                H = !0;
                let X = Mq7(`PreToolUse:${K.name}`, M.blockingError);
                yield {
                    type: "hookPermissionResult",
                    hookPermissionResult: {
                        behavior: "deny",
                        message: X,
                        decisionReason: { type: "hook", hookName: `PreToolUse:${K.name}`, reason: X }
                    }
                };
            }

            if (M.preventContinuation) { ... }

            if (M.permissionBehavior !== void 0) {  // 来自 BO7 第 5 步 (新格式 hookSpecificOutput.permissionDecision)
                if (M.permissionBehavior === "defer") { ... continue; }
                if (M.permissionBehavior === "deny") H = !0;
                let X = { type: "hook", hookName: `PreToolUse:${K.name}`, hookSource: M.hookSource,
                          reason: M.hookPermissionDecisionReason };
                if (M.permissionBehavior === "allow")
                    yield { type: "hookPermissionResult",
                            hookPermissionResult: { behavior: "allow", updatedInput: M.updatedInput, decisionReason: X } };
                else if (M.permissionBehavior === "ask")
                    yield { type: "hookPermissionResult",
                            hookPermissionResult: { behavior: "ask", updatedInput: M.updatedInput,
                                                    message: M.hookPermissionDecisionReason || `...`,
                                                    decisionReason: X } };
                else
                    yield { type: "hookPermissionResult",
                            hookPermissionResult: { behavior: M.permissionBehavior,
                                                    message: M.hookPermissionDecisionReason || `...`,
                                                    decisionReason: X } };
            }

            if (M.updatedInput && M.permissionBehavior === void 0)
                yield { type: "hookUpdatedInput", updatedInput: M.updatedInput };

            // ★ additionalContext 是被独立 yield 出去的，不参与 deny 决策
            if (M.additionalContexts && M.additionalContexts.length > 0)
                yield {
                    type: "additionalContext",
                    message: {
                        message: D4({
                            type: "hook_additional_context",
                            content: M.additionalContexts,
                            hookName: `PreToolUse:${K.name}`,
                            toolUseID: z,
                            hookEvent: "PreToolUse"
                        })
                    }
                };

            if (q.abortController.signal.aborted) { ... yield { type: "stop" }; return; }
        } catch (X) { /* ... */ }
        // ...
    }
}

// L4111: x0K 融合 hook 决定 + canUseTool 决定
async function x0K(q, K, _, z, Y, O, A) {
    // q = hookPermissionResult (即 I0K yield 出来的 hookPermissionResult.hookPermissionResult)
    // K = tool 定义
    // _ = 工具入参
    // Y = canUseTool fallback (the user's canUseTool callback adapter)
    let $ = K.requiresUserInteraction?.(),
        w = z.requireCanUseTool;

    if (q?.behavior === "allow") { /* ... */ }

    if (q?.behavior === "deny")
        return N(`Hook denied tool use for ${K.name}`),
               { decision: q, input: _ };  // ★ 直接返回 deny，根本不走 canUseTool

    let j = q?.behavior === "ask" ? q : void 0;
    let H = q?.behavior === "ask" && q.updatedInput ? q.updatedInput : _;
    return { decision: await Y(K, H, z, O, A, j), input: H };  // ★ hook 没决定 → 走 canUseTool
}

// L4113: 主消费者 (在 tool 执行函数内部，PreToolUse 阶段)
let G = !1, Z, v, k = [], V = Date.now();
for await (let r of I0K(z, q, W, K, O.message.id, $, w, j))
    switch (r.type) {
        case "message":            P.push(r.message); break;
        case "hookPermissionResult": v = r.hookPermissionResult; break;  // ★ 收集 deny 决定
        case "hookUpdatedInput":   W = r.updatedInput; break;
        case "preventContinuation": G = r.shouldPreventContinuation; break;
        case "stopReason":         Z = r.stopReason; break;
        case "additionalContext":  P.push(r.message); break;  // ★ additionalContext 作为独立消息进 P
        case "defer": { /* ... */ }
        case "stop":   return Ce()?.observe("pre_tool_hook_duration_ms", Date.now() - V),
                               P.push({ message: i8({ content: [Zq7(K)],
                                                      toolUseResult: `Error: ${Z}`,
                                                      sourceToolAssistantUUID: O.uuid }) }),
                               P;
    }

// hook 跑完，开始权限决策
let R = z.getAppState().toolPermissionContext.mode,
    b = Date.now(),
    I = await x0K(v, q, W, z, Y, O, K),  // ★ 把 v (hook 决定) 喂给 x0K
    m = I.decision;
W = I.input;

if (m.behavior !== "allow") {
    N(`${q.name} tool permission denied`);
    // ... 构造 tool_result 错误内容
    let z6 = [{ type: "tool_result", content: o, is_error: !0, tool_use_id: K }];
    // ...
    P.push({
        message: i8({
            content: z6, imagePasteIds: l,
            toolUseResult: `Error: ${o}`,
            sourceToolAssistantUUID: O.uuid
        })
    });
    // ...
    return P;  // ★ 早返回 —— tool 不会被执行
}

// 只有 allow 才进入实际 tool 执行
if (m.updatedInput !== void 0) W = m.updatedInput;
let S = Qsq(W), g = {};
// ... 实际调用 tool ...
```

### 关键代码片段对总结

| 字段                                                | BO7 是否承认  | 后续行为                                                                                                |
|-----------------------------------------------------|---------------|---------------------------------------------------------------------------------------------------------|
| 顶层 `decision: "approve"`                          | ✅ 承认       | `permissionBehavior = "allow"` → tool 执行                                                              |
| 顶层 `decision: "block"`                            | ✅ 承认       | `permissionBehavior = "deny"` → 提前 return，tool 不执行                                                |
| 顶层 `permissionDecision: "deny"`                   | ❌ **忽略**   | 等同于无决定                                                                                            |
| 顶层 `additionalContext: "..."`                     | ❌ **忽略**   | 完全丢弃                                                                                                |
| 顶层 `hookEventName: "PreToolUse"`                  | ❌ **忽略**   | 完全丢弃                                                                                                |
| `hookSpecificOutput.hookEventName: "PreToolUse"`<br>+ `hookSpecificOutput.permissionDecision: "deny"` | ✅ 承认 | `permissionBehavior = "deny"` → 提前 return，tool 不执行 |
| `hookSpecificOutput.additionalContext: "..."`       | ✅ 承认       | 作为独立的 `hook_additional_context` 消息追加给模型，**不替换** tool_result                             |
| `hookSpecificOutput.updatedInput: {...}`            | ✅ 承认       | 修改 tool 入参                                                                                          |

### 自然语言解读 — 即便正确写法生效，也无法替换 tool 执行

即便 axon 把返回值改成正确的 `{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", additionalContext: "..."}}`，结果也是：

1. cli.js 把 tool 拒掉（`permissionBehavior = "deny"`），早 return，不执行 tool
2. tool_result 是一条 `is_error: true` 的错误消息，content 是 `permissionDecisionReason` 或 `q.reason`（默认 "Blocked by hook"）
3. `additionalContext` 作为一条**独立的** `hook_additional_context` 消息追加到对话流中（在 tool_result 之前）

**也就是说：模型看到的不是「Bash 的 stdout」，而是「Bash 被 hook 拒绝 + 一段额外上下文」**。模型会困惑、可能会重试 Bash、也可能在文本中复述 additionalContext，但**它不可能把 additionalContext 当作真实的 Bash 输出处理**。

### 结论 (Q1)

**deny + additionalContext 不能替换 tool 执行。** 即便：
- 写法正确 (`hookSpecificOutput` 包裹) → tool 被拒，模型看到 error tool_result + 旁路 additionalContext，**不是替换**
- 写法错误（axon 当前写法，顶层字段） → 整个返回值被 BO7 丢弃，hook 等同空操作，tool 在 cli.js 子进程内**正常执行**

---

## Q2: shouldRouteToolToHand 在真实运行时的行为

### 代码追溯

**`server/src/tool-routing.ts` L21-29**:
```ts
const BUILTIN_HAND_TOOL_NAMES = new Set<BuiltinHandToolName>([
  "Read", "Write", "Edit", "MultiEdit", "Bash", "Grep", "Glob",
]);
```

**`server/src/tool-routing.ts` L62-66**:
```ts
shouldRouteToHand(toolName: string): boolean {
  return isBuiltinHandToolName(toolName)
    || this.config.handToolNames.includes(toolName)
    || this.config.handToolPrefixes.some((prefix) => toolName.startsWith(prefix));
}
```

**`server/src/server.ts` L552-556**:
```ts
const session = BrainSession.createSession({
  id: sessionId,
  cwd: message.cwd || ".",
  model: message.model || this.defaultModel,
  shouldRouteToolToHand: (toolName) => this.toolRouting.shouldRouteToHand(toolName),
  // ...
});
```

### 对 Bash 的返回值

**`shouldRouteToolToHand("Bash")` → `true`**（因为 `BUILTIN_HAND_TOOL_NAMES` 默认开启了 7 个 builtin 工具，无需配置）。

### 结论 (Q2)

不是路由条件出问题。Bash 在生产环境下**确实**会进入 axon 的 `handlePreToolUse`，axon 的 hook callback **会被 cli.js 调起**，session.ts L378-383 的 return 语句**会被执行**。

问题出在：返回值的形状对了一半。

---

## Q3: hook 注册的正确性

### 注册代码片段

**`server/src/session.ts` L224-228**:
```ts
hooks: {
  PreToolUse: [
    { matcher: ".*", hooks: [async (input: HookInput) => this.handlePreToolUse(input)] },
  ],
},
```

### 与 SDK .d.ts 签名对比

**SDK 的类型定义** (`sdk.d.ts` L1041-1047)：
```ts
hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
```

**HookCallbackMatcher** (L597-602)：
```ts
export declare interface HookCallbackMatcher {
    matcher?: string;
    hooks: HookCallback[];
    timeout?: number;
}
```

**HookCallback** (L590-592)：
```ts
export declare type HookCallback = (
    input: HookInput,
    toolUseID: string | undefined,
    options: { signal: AbortSignal; }
) => Promise<HookJSONOutput>;
```

**HookJSONOutput → SyncHookJSONOutput** (L4218-4227)：
```ts
export declare type SyncHookJSONOutput = {
    continue?: boolean;
    suppressOutput?: boolean;
    stopReason?: string;
    decision?: 'approve' | 'block';
    systemMessage?: string;
    reason?: string;
    hookSpecificOutput?: PreToolUseHookSpecificOutput | UserPromptSubmitHookSpecificOutput | ...;
};
```

**PreToolUseHookSpecificOutput** (L1545-1551)：
```ts
export declare type PreToolUseHookSpecificOutput = {
    hookEventName: 'PreToolUse';
    permissionDecision?: HookPermissionDecision;
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
};
```

### 比对结论

**注册结构是对的**：
- `matcher: ".*"` ✅ 是个有效的正则字符串，会匹配所有工具名
- `hooks: [...]` ✅ 数组，每项是 async 函数 ✅ 返回 Promise

**返回值结构是错的**：

session.ts L71-76 的内部类型定义和 L378-383 的 return：
```ts
type PreToolUseHookResult = {
  hookEventName: "PreToolUse";
  permissionDecision: "deny";
  permissionDecisionReason: string;
  additionalContext: string;
};

return {
  hookEventName: "PreToolUse",
  permissionDecision: "deny",
  permissionDecisionReason: "Tool executed remotely via Axon Hand",
  additionalContext: summarizeToolResult(result),
};
```

把 `PreToolUseHookSpecificOutput` 的字段**放到了顶层**，而 SDK 真实 `BO7` 解析器只从 `q.hookSpecificOutput.*` 读取这些字段。**正确的形状必须是**：
```ts
{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "...",
    additionalContext: "...",
  }
}
```

session.ts 内部 `PreToolUseHookResult` 类型并没有继承 SDK 的 `SyncHookJSONOutput`，而是自己造了一个错的 shape，TypeScript 也就没有报错。

### 结论 (Q3)

注册位置对、matcher 对、hook 函数会被调起；**但是 hook 的 return 值整个被 cli.js 的解析器丢弃**，等价于 `return {}`。

---

## Q4: e2e-hand.test.ts 的真实测试覆盖

### 测试用的 Claude 实现

测试**不**用真的 `@anthropic-ai/claude-agent-sdk` 内部 cli.js。测试通过 `process.env.CLAUDE_CODE_EXECUTABLE = fake.executablePath` 把 `pathToClaudeCodeExecutable` 替换成 `server/test/fixtures/fake-claude.ts` 生成的临时 stub。

### fake-claude 如何派发 tool_call

**`server/test/fixtures/fake-claude.ts`** 生成的脚本核心逻辑：

```js
// 1. 收 control_request/initialize → 抓 callbackId
if (message.type === "control_request" && message.request?.subtype === "initialize") {
    callbackId = message.request.hooks?.PreToolUse?.[0]?.hookCallbackIds?.[0] ?? "";
    emit({
        type: "control_response",
        response: { subtype: "success", request_id: message.request_id, response: {...} },
    });
    continue;
}

// 2. 收第一个 user 消息 → 直接发 hook_callback control_request
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
                tool_input: { command: "echo brain-hand-e2e" },
            },
        },
    });
    continue;
}

// 3. 收 control_response（hook 返回值） → 直接读顶层 additionalContext
if (message.type === "control_response" && message.response?.request_id === hookRequestId) {
    const additionalContext = message.response?.response?.additionalContext ?? "";
    emit({
        type: "assistant",
        message: {
            content: [{ type: "text", text: "fake assistant: " + additionalContext }],
        },
    });
    emit({ type: "result", subtype: "success", is_error: false, result: "fake done" });
    break;
}
```

**关键事实**：
1. fake-claude **绕过**了真实 cli.js 的整套 hook 路径（没有 `Xq7` 派发器、没有 `BO7` 解析器、没有 `I0K` 生成器、没有 `x0K` 权限融合器、没有 tool 执行流水）。
2. fake-claude **直接从 `control_response.response.additionalContext` 顶层读取**字段 —— 而这正好是 axon session.ts 写入的位置。
3. fake-claude 没有任何"工具实际执行"路径 —— 它根本就不知道什么叫"在 cli.js 子进程内执行 Bash"。它只把 hook 响应内容贴成 text_chunk 输出。

### 测试覆盖能否证明真实 SDK 的 hook 拦截行为？

**不能，强烈不能。** 这个 e2e 测试是一个**对 fake 与生产代码字段命名一致性的测试**，而不是一个**对 SDK 实际语义的测试**。

| 维度                                       | 真实 cli.js                          | fake-claude                          |
|--------------------------------------------|--------------------------------------|--------------------------------------|
| 用什么解析 hook 返回值                     | `BO7({json: w})` → 只看 `hookSpecificOutput.*` | 直接 `response?.response?.additionalContext` |
| `permissionDecision: "deny"` 顶层是否生效 | ❌ 忽略                              | 不读这个字段                         |
| 顶层 `additionalContext` 是否生效         | ❌ 忽略                              | ✅ 直接读                            |
| Bash 是否真的会执行                       | 不是 hook 的事，cli.js 用自己的 Bash 工具实现 | 完全不存在 tool 执行环节            |
| 是否有 `hook_additional_context` 消息       | 有（独立消息追加给模型）             | 没有                                 |
| 是否有 error tool_result                   | 有（"Blocked by hook"）              | 没有                                 |

**结论**：这个 e2e 测试通过，**纯粹是因为 fake-claude 被人为编码成 "假装 hook 拦截生效" 的行为**。它无法证明任何关于真实 SDK 行为的事情。它实际上反向证明了 axon 团队在写代码与写 fake 时**对 SDK 协议的理解是同一个错误**。

---

## Q5: SDK 中"替换 tool 执行"的正确 API

### 候选机制 1: `canUseTool` 回调（已被 axon 使用，但用错了）

**SDK 类型** (`sdk.d.ts` L146-188 + L1445-1457)：
```ts
export declare type CanUseTool = (toolName: string, input: Record<string, unknown>, options: {
    signal: AbortSignal;
    suggestions?: PermissionUpdate[];
    blockedPath?: string;
    decisionReason?: string;
    title?: string;
    displayName?: string;
    description?: string;
    toolUseID: string;
    agentID?: string;
}) => Promise<PermissionResult>;

export declare type PermissionResult = {
    behavior: 'allow';
    updatedInput?: Record<string, unknown>;
    updatedPermissions?: PermissionUpdate[];
    toolUseID?: string;
    decisionClassification?: PermissionDecisionClassification;
} | {
    behavior: 'deny';
    message: string;
    interrupt?: boolean;
    toolUseID?: string;
    decisionClassification?: PermissionDecisionClassification;
};
```

**SDK 怎么开启它** (`sdk.mjs` L53-54)：
```js
if (a4) {  // canUseTool 存在
    if (I) throw Error("canUseTool callback cannot be used with permissionPromptToolName. Please use one or the other.");
    p.push("--permission-prompt-tool", "stdio");  // 给 cli.js 加 CLI flag
}
```

cli.js 看到 `--permission-prompt-tool stdio` 后，会通过 `control_request {subtype: "can_use_tool"}` 反向调用 SDK 进程的 `canUseTool` 回调。

**重要限制**：`canUseTool` 仍然只能返回 allow / deny —— **它不能替换 tool 输出**。它的功能定位是"权限网关"，不是"虚拟 tool 实现"。

并且，axon 当前虽然也注册了 `canUseTool: this.canUseTool`（session.ts L222 + L400-416），但它对路由工具一律返回 `{behavior: "allow"}`，对其他工具返回 deny。等于：当 hook 的 `permissionBehavior` 没生效（即 axon 的 hook 写错了顶层字段那种情况）时，`x0K` 会 fallback 到 canUseTool，canUseTool 又返回 allow，于是 cli.js 直接放行。

### 候选机制 2: 自定义 MCP server / SDK MCP server（真正能"替换"tool 输出的方案）

SDK 提供 `createSdkMcpServer()` 与 `tool()` 函数（见 `sdk.mjs` 末尾导出 `_x as tool, xx as createSdkMcpServer`）。用法是注册一个 MCP server，里面定义同名工具（比如 `Bash`），但因为 MCP 工具的命名空间是 `mcp__<server>__<toolname>`，**无法直接覆盖** builtin 的 `Bash`。

要"替换" Bash 行为，可行的路径是：
- 用 `disallowedTools: ["Bash"]` 屏蔽掉真实 Bash
- 在 MCP server 里注册一个不同名的工具（比如 `mcp__axon__bash`）
- 用 system prompt 引导模型只调 MCP 版本

但这要修改 prompt 与工具名，对透明代理不友好。

### 候选机制 3: PostToolUse + `updatedMCPToolOutput`（仅限 MCP 工具）

cli.js L7782 BO7 解析器中：
```js
case "PostToolUse":
    H.additionalContext = q.hookSpecificOutput.additionalContext;
    if (q.hookSpecificOutput.updatedMCPToolOutput)
        H.updatedMCPToolOutput = q.hookSpecificOutput.updatedMCPToolOutput;
```

`updatedMCPToolOutput` 看名字就只对 MCP 工具有效，**对 builtin 的 Bash/Read/Write 不适用**。

### 候选机制 4: `--allow-dangerously-skip-permissions` + 修改 cli 的 Bash 实现

不可行，需要 fork claude-code。

### 候选机制 5: 改 builtin tool 为 disallowed + 通过自定义 SDK MCP 工具承接

```ts
disallowedTools: ["Bash", "Read", "Write", ...],
mcpServers: {
  axon: {
    type: "sdk",
    instance: createSdkMcpServer({
      name: "axon",
      tools: [
        tool("bash", "Run shell command", { command: z.string() }, async (input) => {
          // 转发到 Hand 执行，返回真实结果
          const result = await routeToHand("Bash", input);
          return { content: [{ type: "text", text: result }] };
        }),
        // Read / Write / ...
      ],
    }),
  },
},
```

这样模型看到的工具列表里只有 `mcp__axon__bash`，调用时通过 MCP 协议（也是通过 control_request 反向）走到 SDK 进程，SDK 进程把请求路由到 Hand，Hand 返回真实输出 → 作为 MCP tool result 交给模型。**这才是"hook 接管 tool 执行"的真实形态**。

代价：模型看到的工具名变了（`mcp__axon__bash` 而非 `Bash`），需要 prompt 微调；且 system prompt 里 cli.js 自己塞的 builtin 工具说明需要被替换。

### 推荐的正确实现方式

**短期止血**（保留现有 hook + canUseTool 架构）：
1. 把 session.ts L378-383 的返回值包到 `hookSpecificOutput` 里，至少让 cli.js 真的把 tool 拒掉（不会再误执行）。
2. 但要意识到：模型仍然会拿到 error tool_result + 旁路 hook_additional_context，**不会**把 additionalContext 当作 Bash 输出。这种用法是 hack，模型行为不可控。

**正确方案**：放弃 hook 拦截路线，改用 **SDK MCP server** 注册替代工具：
1. `disallowedTools` 屏蔽所有 builtin 工具
2. 用 `createSdkMcpServer` + `tool()` 注册 `bash`/`read`/`write`/`edit`/`grep`/`glob`，每个工具的实现都是"通过 ToolRelay 转发到 Hand 并等结果"
3. 在 system prompt 里说明工具使用规范

这样：
- 模型看到的就是 `mcp__axon__bash`
- 调用时 cli.js 走 MCP 协议反向调用 SDK 进程
- SDK 进程在 SDK MCP server 的 `tool()` 回调里转发到 Hand
- Hand 返回结果作为标准 MCP `CallToolResult` 给到 cli.js
- cli.js 把它作为 tool_result 交给模型
- **模型看到的是真实输出，没有 error，没有旁路上下文**

---

## 总结

### 最可能的真相

**不是单一的 A/B/C，而是三者叠加 ——**

1. **C** 部分对：**e2e 测试 fake-claude 假装 hook 生效**，根本没经过真实 SDK 的 BO7/I0K/x0K 路径，所以测试通过不能证明任何事。
2. **B 的变种**：**hook 被调用了，但返回值放错了层级**（顶层 `permissionDecision` / `additionalContext` 而非 `hookSpecificOutput.*`），cli.js 的 `BO7` 解析器**完全忽略**这些顶层字段，等同于 hook 返回了 `{}`。
3. **canUseTool fallback 接管**：因为 hook 没产出任何 `hookPermissionResult`，`x0K(undefined, ...)` 走到 fallback 分支，调用 axon 的 `canUseTool` —— 它对 builtin 工具一律 `{behavior: "allow"}` —— 于是 **cli.js 在容器内自己跑了真实的 Bash**，cwd 是 SDK 在 session.ts L218 设的 `os.tmpdir() = /tmp`，于是 `pwd` 返回 `/tmp`。

**即使** 把返回值改对成 `hookSpecificOutput.*`，也只能让 tool 被拒（拒得干净），**仍然不能用 additionalContext 替换 tool 执行**。

### 修复方向

**短期最小修复**（让 hook 拒得干净，但这不是终态）：
1. session.ts L71-76 的 `PreToolUseHookResult` 改为：
   ```ts
   type PreToolUseHookResult = {
     hookSpecificOutput: {
       hookEventName: "PreToolUse";
       permissionDecision: "deny";
       permissionDecisionReason: string;
       additionalContext: string;
     };
   };
   ```
2. session.ts L315-321 的"拒未配置工具"分支与 L378-383 的"远端执行完毕"分支都改为 `return { hookSpecificOutput: {...} }` 形态。
3. session.ts L71-76 的类型应当从 SDK 导入 `SyncHookJSONOutput`，而不是手写一个不兼容的内部类型。
4. **删除** e2e-hand.test.ts 与 fake-claude.ts，或者把 fake-claude 改成调用 BO7 / 模拟真实 cli.js 的 hook 派发流程。**当前的 fake-claude 是误导性的反向证据**。

**中期正确方案**（让模型真的拿到 Hand 的输出）：
1. `disallowedTools: ["Bash", "Read", "Write", "Edit", "MultiEdit", "Grep", "Glob"]`
2. 用 `createSdkMcpServer` 注册等价的 MCP 工具，每个工具内部把请求转发到 Hand
3. system prompt 里教模型用 `mcp__axon__*` 系列工具
4. PreToolUse hook 可以保留作为审计日志（但不再承担"路由"职责）

**长期**：放弃 "hook 当 tool" 的反模式，转向 SDK 官方支持的"自定义 tool"路径。

---

## 附：调用关系图

```
┌─────────────────────────────────┐
│  Brain 端 (axon server.ts)       │
│  ├─ ToolRoutingStore (默认开启   │
│  │   Bash/Read/Write/Edit/...)    │
│  └─ BrainSession.runPrompt        │
│     ├─ canUseTool: handleCanUse   │ ──┐
│     │   (路由工具 → allow)         │   │
│     └─ hooks.PreToolUse            │   │
│         matcher ".*"               │   │
│         callback handlePreToolUse  │ ─┐│
│           returns {                │  ││
│             hookEventName,         │  ││ ← 这些顶层字段
│             permissionDecision,    │  ││   被 BO7 完全忽略
│             additionalContext      │  ││
│           }                        │  ││
└────────────┬───────────────────────┘  ││
             │                          ││
             │ query() → spawn cli.js   ││
             ▼                          ││
┌─────────────────────────────────┐    ││
│  SDK 进程 (sdk.mjs pX class)     │    ││
│  - hookCallbacks: Map<id, fn>    │    ││
│  - canUseTool: fn                │    ││
│  - 双向 stdio JSON 协议            │    ││
└────────────┬───────────────────────┘   ││
             │ stdio                    ││
             ▼                          ││
┌─────────────────────────────────┐    ││
│  cli.js (真正的 Claude Code)     │    ││
│                                  │    ││
│  PreToolUse hook 触发流程:        │    ││
│  ┌──────────────────────────┐   │    ││
│  │ Xq7 (hook runner)         │   │    ││
│  │ → 对每个 callback:        │   │    ││
│  │   ZpY:                    │   │    ││
│  │   └ control_request →SDK  │ ──┘│   │
│  │   ← control_response       │    │   │
│  │     w = user return value  │ ←──┘   │ 这里
│  │   └ BO7({json: w}) ────────┼────────┘ ★ BO7 只看 hookSpecificOutput.*
│  │     → H = { /*空*/ }         │
│  └──────────────────────────┘   │
│  ┌──────────────────────────┐   │
│  │ I0K (hook event yielder)  │   │
│  │ ← H 是空 → 不 yield        │   │
│  │   hookPermissionResult     │   │
│  │ → 主消费者 v = undefined    │   │
│  └──────────────────────────┘   │
│  ┌──────────────────────────┐   │
│  │ x0K(v=undefined, ...)     │   │
│  │ → fallback 到 canUseTool   │ ──┐
│  │   = {behavior: "allow"}    │   │
│  └──────────────────────────┘   │  │
│  ┌──────────────────────────┐   │  │
│  │ tool 实际执行             │ ←─┘
│  │ Bash 在 cwd=/tmp 里跑      │
│  │ 返回 stdout="/tmp"          │
│  └──────────────────────────┘   │
└─────────────────────────────────┘

  最终结果：模型看到 Bash 工具结果是 "/tmp"，
            完全没经过 Hand。
            Hand 这边收到 tool_call 跑了一次 Bash，
            但结果被丢弃，不影响模型。
```
