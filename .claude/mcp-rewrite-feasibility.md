# 路径 B (MCP 自定义工具) 可行性调研 / Path B (MCP Custom Tools) Feasibility Study

> **一句话裁定 / Verdict**:**YES,证据等级 STRONG**。
>
> 通过 `query()` options 注入 in-process MCP server (`createSdkMcpServer` + `tool()`) + `disallowedTools` 屏蔽 builtin 工具,**完全可以**替代 axon 当前的 PreToolUse hook 拦截方案,并且**不需要修改 `node_modules` 任何文件,不需要写入 `~/.claude` 任何文件**。
>
> 全部数据流闭环已通过 SDK + cli.js 源码逐行验证。

---

## 版本信息 / Version Info

| 项目 / Item | 值 / Value |
|---|---|
| `@anthropic-ai/claude-agent-sdk` | `0.2.92` |
| `claudeCodeVersion`(内置 cli.js) | `2.1.92` |
| package main / 主入口 | `sdk.mjs` |
| package types | `sdk.d.ts` |
| SDK 包路径 | `/Users/n374/Documents/Code/axon/node_modules/@anthropic-ai/claude-agent-sdk/` |
| `sdk.mjs` 大小 / 形态 | 612 KB / 压缩成 106 行(每行很长) |
| `cli.js` 大小 / 形态 | 13 MB / 压缩 |

---

## Q1: `createSdkMcpServer` / `tool()` API

### 存在性 / Existence — yes

`sdk.d.ts` 完整签名(行号为绝对行):

```ts
// sdk.d.ts L357
export declare function createSdkMcpServer(
  _options: CreateSdkMcpServerOptions
): McpSdkServerConfigWithInstance;

// sdk.d.ts L359-363
declare type CreateSdkMcpServerOptions = {
  name: string;
  version?: string;
  tools?: Array<SdkMcpToolDefinition<any>>;
};

// sdk.d.ts L4293-4297
export declare function tool<Schema extends AnyZodRawShape>(
  _name: string,
  _description: string,
  _inputSchema: Schema,
  _handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>,
  _extras?: {
    annotations?: ToolAnnotations;
    searchHint?: string;
    alwaysLoad?: boolean;
  }
): SdkMcpToolDefinition<Schema>;

// sdk.d.ts L2380-2387
export declare type SdkMcpToolDefinition<Schema extends AnyZodRawShape = AnyZodRawShape> = {
  name: string;
  description: string;
  inputSchema: Schema;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
  handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>;
};

// sdk.d.ts L719-721
export declare type McpSdkServerConfigWithInstance = McpSdkServerConfig & {
  instance: McpServer;
};

// sdk.d.ts L710-713
export declare type McpSdkServerConfig = {
  type: 'sdk';
  name: string;
};

// sdk.d.ts L726
export declare type McpServerConfig =
  | McpStdioServerConfig
  | McpSSEServerConfig
  | McpHttpServerConfig
  | McpSdkServerConfigWithInstance;
```

### 导出路径 / Export Path — 主入口直接导出

`sdk.mjs` 末尾(line 106 末尾的 export 语句,被压缩在一行内,token 拆分后定位到 `var xx as createSdkMcpServer / _x as tool`):

```js
export {
  Gs as unstable_v2_resumeSession,
  Us as unstable_v2_prompt,
  Ws as unstable_v2_createSession,
  _x as tool,                       // ← 这里
  Os as tagSession,
  zs as startup,
  Vs as renameSession,
  Qs as query,
  ...
  xx as createSdkMcpServer,         // ← 这里
  TL as HOOK_EVENTS,
  yL as EXIT_REASONS,
  ...
}
```

`package.json` `main` / `exports.default` 都指向 `sdk.mjs`,所以:

```ts
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
```

**直接可用,不需要任何 deep import**。

### 最小用法签名 / Minimal Usage

```ts
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const bashTool = tool(
  "bash",                                          // 工具名(不带 mcp__ 前缀)
  "Execute a shell command via Axon Hand",         // 描述,Claude 看到的
  { command: z.string(), cwd: z.string().optional() },  // Zod schema
  async (args, _extra) => {
    // handler 在 SDK 进程内运行
    const result = await routeToHand("Bash", args);
    return {
      content: [{ type: "text", text: result.output }],
      // isError?: true
    };
  }
);

const axonServer = createSdkMcpServer({
  name: "axon",
  version: "1.0.0",
  tools: [bashTool, /* readTool, writeTool, ... */],
});

for await (const msg of query({
  prompt: "...",
  options: {
    mcpServers: { axon: axonServer },
    disallowedTools: ["Bash", "Read", "Write", "Edit", "MultiEdit", "Grep", "Glob"],
    // 其他 option
  },
})) {
  // 处理消息
}
```

---

## Q2: `createSdkMcpServer` 是不是真的 in-process

### 实现位置 / Implementation Location

`sdk.mjs` 内 `_x` (= `tool`) 与 `xx` (= `createSdkMcpServer`)(token 拆分后所在行,原文件第 100 行末尾的压缩段中):

```js
// sdk.mjs body (token-split L540-547)
function _x($, X, J, Q, Y) {
  let z = {};
  if (Y?.searchHint)  z["anthropic/searchHint"] = Y.searchHint;
  if (Y?.alwaysLoad)  z["anthropic/alwaysLoad"] = !0;
  return {
    name: $,
    description: X,
    inputSchema: J,
    handler: Q,
    annotations: Y?.annotations,
    _meta: Object.keys(z).length > 0 ? z : void 0,
  };
}

function xx($) {
  let X = new kU(                                   // ★ kU = MCP server class (本地实例)
    { name: $.name, version: $.version ?? "1.0.0" },
    { capabilities: { tools: $.tools ? {} : void 0 } }
  );
  if ($.tools) $.tools.forEach((J) => {
    // 把 inputSchema 中带 description 的 zod field 注册到 X6 cache
    X.registerTool(                                  // ★ 直接注册到 in-process MCP server
      J.name,
      { description: J.description, inputSchema: J.inputSchema,
        annotations: J.annotations, _meta: J._meta },
      J.handler                                       // ★ handler 闭包就在 SDK 进程
    );
  });
  return { type: "sdk", name: $.name, instance: X }; // ★ 返回 {type, name, instance}
}
```

**`_x` 只是一个工厂,返回 plain object。`xx` 创建一个本地 `kU` (MCP Server 类) 实例,把 handler 用 `registerTool` 注册到内部的 `_registeredTools` map。完全没有 `spawn` / `child_process` / 文件系统操作。**

### `mcpServers` option 怎么被剥离 / How `mcpServers` is split

`sdk.mjs` HL($) 函数(query options 解析,token-split L626-628):

```js
let fU = {}, gU = new Map;
if (_U)  // _U = options.mcpServers
  for (let [r9, T1] of Object.entries(_U))
    if (T1.type === "sdk" && T1.instance)
      gU.set(r9, T1.instance);    // ★ SDK 类型 → 留在 SDK 进程的 gU Map
    else
      fU[r9] = T1;                 // ★ 其他类型 → 进 fU 对象
```

`fU`(只剩 stdio/sse/http)被包成 `--mcp-config '{"mcpServers": ...}'` 传给 cli.js;
`gU` 被传给 `pX` 类构造函数(line 637):

```js
return {
  queryInstance: new pX(hU, X, L, p, K, gU, yU, ML, o0),  // 第 6 个参数 = gU
  transport: hU,
  abortController: K,
};
```

### `pX` (Query) 类的 in-process MCP 域 / SDK Query Class

`sdk.mjs` 前 99 行内 `class pX`(token-split L11247+):

```js
class pX {
  transport; isSingleUserTurn; canUseTool; hooks;
  abortController; jsonSchema; initConfig; onElicitation;
  pendingControlResponses = new Map;
  cleanupPerformed = !1;
  sdkMessages;
  inputStream = new K1;
  initialization;
  cancelControllers = new Map;
  hookCallbacks = new Map;
  nextCallbackId = 0;
  sdkMcpTransports     = new Map;   // ★ 关键:in-process MCP transports
  sdkMcpServerInstances = new Map;  // ★ 关键:in-process MCP server 实例
  pendingMcpResponses   = new Map;
  ...
  constructor($, X, J, Q, Y, z = new Map, W, G, U) {
    this.transport = $;
    ...
    for (let [H, K] of z)             // z = gU
      this.connectSdkMcpServer(H, K); // ★ 立刻把每个 (name, kU 实例) 连接起来
    ...
  }

  // token-split L11640
  connectSdkMcpServer($, X) {
    let J = new fz((Q) => this.sendMcpServerMessageToCli($, Q));  // ★ fz = in-mem transport
    this.sdkMcpTransports.set($, J);
    this.sdkMcpServerInstances.set($, X);
    X.connect(J).catch((Q) => { /* ... */ });   // ★ MCP server 用 fz transport 启动
  }

  // token-split L11700
  sendMcpServerMessageToCli($, X) {
    if ("id" in X && X.id !== null && X.id !== void 0) {
      let Q = `${$}:${X.id}`,
          Y = this.pendingMcpResponses.get(Q);
      if (Y) { Y.resolve(X); this.pendingMcpResponses.delete(Q); return; }
    }
    let J = {
      type: "control_request",
      request_id: PJ(),
      request: { subtype: "mcp_message", server_name: $, message: X },  // ★ 通过 stdio 发给 cli.js
    };
    Promise.resolve(this.transport.write(q$(J) + "\n")).catch(...);
  }
}

// fz = in-process MCP transport (token-split L11229)
class fz {
  sendMcpMessage; isClosed = !1;
  constructor($) { this.sendMcpMessage = $; }
  onclose; onerror; onmessage;
  async start() {}
  async send($) {
    if (this.isClosed) throw Error("Transport is closed");
    this.sendMcpMessage($);              // ★ 委托到上面的 sendMcpServerMessageToCli
  }
  async close() { /* ... */ }
}
```

### 反向调用入口 / Reverse Call Entry

`pX.processControlRequest`(token-split L11400-),处理 cli.js → SDK 进程的 `mcp_message`:

```js
async processControlRequest($, X) {
  if ($.request.subtype === "can_use_tool")  { /* canUseTool 路径 */ }
  else if ($.request.subtype === "hook_callback") { /* hooks 路径 */ }
  else if ($.request.subtype === "mcp_message") {
    let J = $.request,
        Q = this.sdkMcpTransports.get(J.server_name);  // ★ 拿到 in-process transport
    if (!Q) throw Error(`SDK MCP server not found: ${J.server_name}`);
    if ("method" in J.message && "id" in J.message && J.message.id !== null)
      return { mcp_response: await this.handleMcpControlRequest(J.server_name, J, Q) };
    else {
      if (Q.onmessage) Q.onmessage(J.message);  // ★ 直接路由到 fz transport 的 onmessage
      return { mcp_response: { jsonrpc: "2.0", result: {}, id: 0 } };
    }
  }
  ...
}

handleMcpControlRequest($, X, J) {
  let Q = "id" in X.message ? X.message.id : null,
      Y = `${$}:${Q}`;
  return new Promise((z, W) => {
    let G = () => { this.pendingMcpResponses.delete(Y); },
        U = (K) => { G(); z(K); },
        H = (K) => { G(); W(K); };
    this.pendingMcpResponses.set(Y, { resolve: U, reject: H });
    if (J.onmessage) J.onmessage(X.message);   // ★ 触发 in-process MCP server 的请求处理
    else { G(); W(Error("No message handler registered")); return; }
  });
}
```

### cli.js 端的对偶逻辑 / cli.js Side Dual Logic

cli.js 在 SDK initialize 阶段收到 `sdkMcpServers` 列表,把它们注册成 `{type:"sdk", name}` 占位(`/tmp/axon_cli_split.txt` L464679,即 cli.js 内部的 print.ts main loop):

```js
else if (S6.request.subtype === "initialize") {
  if (S6.request.sdkMcpServers && S6.request.sdkMcpServers.length > 0)
    for (let x6 of S6.request.sdkMcpServers)
      A[x6] = { type: "sdk", name: x6 };  // ★ 占位
  ...
}
```

之后在 `z6()` 周期(server 列表变化时,token-split L4244 area):

```js
let k6 = await xu4(A, (V6, b6) => q.sendMcpMessage(V6, b6));
//                ↑              ↑
//                |              └─ q.sendMcpMessage 把请求经 control_request 发回 SDK 进程
//                └─ A 里的 sdk 占位
U = k6.clients;
n = k6.tools;
```

`xu4` (token-split L232103) 是 cli.js 端的 sdk MCP client 工厂:

```js
async function xu4(q, K) {
  let _ = [], z = [],
      Y = await Promise.allSettled(
        Object.entries(q).map(async ([O, A]) => {
          let $ = new LQ1(O, K),                          // ★ LQ1 = sdk transport (cli.js side)
              w = new $h8(                                 // ★ $h8 = MCP Client (claude-code)
                { name: "claude-code", title: "Claude Code", version: "2.1.92", ... },
                { capabilities: {} }
              );
          try {
            await w.connect($);                            // ★ MCP Client 通过 LQ1 连接
            let j = w.getServerCapabilities(),
                H = {
                  type: "connected", name: O, capabilities: j || {},
                  client: w,                               // ★ MCP client 就绪
                  config: { ...A, scope: "dynamic" },
                  cleanup: async () => { await w.close(); },
                },
                J = [];
            if (j?.tools) {
              let M = await Dh(H);                         // ★ 拉 tools/list
              J.push(...M);
            }
            return { client: H, tools: J };
          } catch (j) { /* failed branch */ }
        })
      );
  // ...
  return { clients: _, tools: z };
}
```

`LQ1` (token-split L229193):

```js
class LQ1 {
  serverName; sendMcpMessage; isClosed = !1;
  onclose; onerror; onmessage;
  constructor(q, K) { this.serverName = q; this.sendMcpMessage = K; }
  async start() {}
  async send(q) {
    if (this.isClosed) throw Error("Transport is closed");
    let K = await this.sendMcpMessage(this.serverName, q);  // ★ 把 MCP 消息经 control_request 发回 SDK 进程
    if (this.onmessage) this.onmessage(K);                  // ★ 同步收到回执
  }
  async close() { /* ... */ }
}
```

### 数据流(完整 / Complete Data Flow)

```
[Claude LLM]
   │ (assistant content[].type === "tool_use", name === "mcp__axon__bash")
   ▼
[cli.js 子进程 / cli.js child process]
   │ tool dispatch identifies it as MCP tool, server="axon", tool="bash"
   │ → 调 client (= $h8 实例).callTool({name:"bash", args})
   │ → MCP Client 通过 LQ1.send() 走自己的 transport
   │ → LQ1.send() 调 sendMcpMessage(serverName, mcpRequest)
   │   即 q.sendMcpMessage,即 cli.js print.ts 那段闭包里的
   │   `(V6, b6) => q.sendMcpMessage(V6, b6)`
   │ → 这个 q.sendMcpMessage 把 MCP 消息包成 control_request
   │   {subtype:"mcp_message", server_name, message}
   │ → 通过 stdio (cli.js → SDK 进程的反向 control 通道) 写到 SDK 进程
   ▼
[SDK 进程 / SDK process]
   │ pX.processControlRequest 收到 subtype="mcp_message"
   │ → 取出 sdkMcpTransports.get(server_name) → fz transport 实例
   │ → 如果 message 是 request (有 id):走 handleMcpControlRequest
   │   - 把 (server, id) 注册到 pendingMcpResponses
   │   - 触发 fz.onmessage(message)
   │ → fz 的 onmessage 是 MCP server (kU 实例) 内部 transport 的回调
   │ → kU 内部 dispatch 到 _registeredTools["bash"].handler
   │ → handler(args) ★ 这是 axon 注册的 in-process 函数!★
   │   handler 内部:
   │   - 通过 ToolRelay 转发到 Hand
   │   - await Hand 返回真实 RemoteToolResult
   │   - 构造 CallToolResult { content: [{type:"text", text:...}] }
   │   - return
   │ → kU 序列化 response,通过同一个 fz transport.send 写出
   │ → fz.send 委托到 sendMcpServerMessageToCli
   │ → 这个函数检查 pendingMcpResponses,找到匹配的 (server, id) 那条,
   │   直接 resolve(response) ★ 不再二次走 stdio,因为这是同一个 SDK 进程
   │   wait...实际上对发出去的 message 是先看 pending 表,如果是回应就本地 resolve;
   │   如果是新请求(没 id 或 id 不在表里),才打包成 control_request 发给 cli.js
   ▼
[handleMcpControlRequest 等待的那个 Promise resolve]
   │ → return { mcp_response: <the response> }
   │ → control_response 写回 cli.js
   ▼
[cli.js 子进程]
   │ pendingControlResponses.get(request_id).handler(response)
   │ → LQ1.send() 那个 await 拿到 mcp_response
   │ → MCP Client.callTool() 返回 CallToolResult
   │ → cli.js tool dispatcher 把它作为 tool_result 加入 message 数组
   │ → 下一轮 API 调用把 tool_result 发给 Claude
   ▼
[Claude LLM]
   收到一个**真实的 tool_result**,内容是 Hand 真正执行的结果。
   没有 error。没有旁路 additionalContext。模型行为完全标准。
```

> 注意:回应路径里 SDK 进程内部 `sendMcpServerMessageToCli` 对"已知 pending"的 message 做了**本地短路**(找到 `pendingMcpResponses[server:id]` 直接 resolve,不再回写 stdio)。这是因为 cli.js 那条 control_request 是 cli.js 主动问 SDK 的,SDK 进程从 fz 收到 MCP server 的 response 后,要把它作为 control_response 的 payload 返回,而不是再重新发一个 control_request。代码逻辑见 `sendMcpServerMessageToCli` 开头的 `if (pendingMcpResponses.get(Q))` 分支。

### 结论 / Conclusion

**真 in-process,YES,证据等级 STRONG。**

- 不 spawn 任何子进程承载 MCP server
- 不写盘
- handler 函数闭包持有 axon 的全部 ToolRelay/Hand 上下文
- Claude 看到的是真实的 MCP `CallToolResult`,**不是** error tool_result + 旁路 additionalContext

---

## Q3: Options 类型完整定义 / Full Options Type

`sdk.d.ts` L886-1394。按"对路径 B 的相关性"标注:

```ts
export declare type Options = {
  // ===== 路径 B 必用 / Required for Path B =====

  /** SDK 类型 MCP server 通过这里注入,key 是 server name */
  mcpServers?: Record<string, McpServerConfig>;
  // McpServerConfig 联合类型包含 McpSdkServerConfigWithInstance,所以 SDK 类型可以直接传

  /** 屏蔽 builtin 工具的核心字段 */
  disallowedTools?: string[];

  /** 反向控制:tools 字段是另一种屏蔽方式 */
  tools?: string[] | { type: 'preset'; preset: 'claude_code' };
  // - string[]    → 只允许这些 builtin 工具(其他全 deny);[] → 全屏蔽
  // - {type:'preset',preset:'claude_code'} → 全开默认 Claude Code 工具集
  // axon 推荐用 disallowedTools(更精确,可保留个别 builtin 如 Task)

  /** system prompt 注入 */
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string };
  // - 字符串 → 完全替换 system prompt(失去 builtin 工具说明,危险!)
  // - preset 形态 → 用默认 + append。axon 应该用这个,在 append 里加 mcp__axon__* 的使用规范

  // ===== 路径 B 重要 / Important =====

  /** 自定义权限决策回调,优先级高于 disallowedTools 之外的 ask/allow 默认逻辑 */
  canUseTool?: CanUseTool;
  // axon 现在注册了一个 deny-by-default 的 canUseTool。改造后可以保留作为安全网,
  // 但实际上 disallowedTools + 只暴露 mcp__axon__* 已经够用,canUseTool 可以一律 allow

  /** 工作目录,SDK 子进程的 cwd */
  cwd?: string;

  /** 模型 */
  model?: string;

  /** Claude Code executable 路径(axon 已经在用) */
  pathToClaudeCodeExecutable?: string;

  /** 权限模式 */
  permissionMode?: PermissionMode;
  // 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'
  // 不影响 mcp tool dispatch,但影响 builtin tool 的 deny 行为(已经被 disallowedTools 屏蔽就不必关心)

  /** Hooks 注册(axon 现在用了 PreToolUse,改造后可以保留作为审计) */
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;

  /** 最大轮次 */
  maxTurns?: number;

  // ===== 路径 B 可选 / Optional =====

  abortController?: AbortController;
  additionalDirectories?: string[];
  agent?: string;
  agents?: Record<string, AgentDefinition>;
  allowedTools?: string[];                          // 跟 disallowedTools 互补,用 deny rule 之外的 allow rule 路径
  continue?: boolean;
  env?: { [envVar: string]: string | undefined };  // 可以塞 CLAUDE_AGENT_SDK_MCP_NO_PREFIX 改命名
  executable?: 'bun' | 'deno' | 'node';
  executableArgs?: string[];
  extraArgs?: Record<string, string | null>;
  fallbackModel?: string;
  enableFileCheckpointing?: boolean;
  toolConfig?: ToolConfig;
  forkSession?: boolean;
  betas?: SdkBeta[];
  onElicitation?: OnElicitation;
  persistSession?: boolean;
  includeHookEvents?: boolean;
  includePartialMessages?: boolean;
  thinking?: ThinkingConfig;
  effort?: EffortLevel;
  maxThinkingTokens?: number;                       // @deprecated
  maxBudgetUsd?: number;
  taskBudget?: { total: number };
  outputFormat?: OutputFormat;                      // JsonSchemaOutputFormat
  allowDangerouslySkipPermissions?: boolean;
  permissionPromptToolName?: string;                // 跟 canUseTool 互斥
  plugins?: SdkPluginConfig[];
  promptSuggestions?: boolean;
  agentProgressSummaries?: boolean;
  resume?: string;
  sessionId?: string;
  resumeSessionAt?: string;
  sandbox?: SandboxSettings;

  /** 这两个 axon 必须避免使用 / These must NOT be used by axon */
  settings?: string | Settings;       // 路径不行(读 ~/.claude/* 之类)
  settingSources?: SettingSource[];   // 默认就是空,即"完全 SDK 隔离模式",不读盘上配置
                                      // axon 必须保持这俩 undefined 或空,严格 SDK 隔离

  debug?: boolean;
  debugFile?: string;
  stderr?: (data: string) => void;
  strictMcpConfig?: boolean;
  spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess;
};
```

> **重点**:文档对 `settingSources` 写得很清楚:"When omitted or empty, no filesystem settings are loaded (SDK isolation mode)"。axon **绝不可以**显式开 `settingSources: ['user']` 等,否则会触发 `~/.claude/settings.json` 读盘。

### `mcpServers` 可以传 SDK 实例 / Can Pass SDK Instance Directly

`sdk.d.ts` L726:

```ts
export declare type McpServerConfig =
  | McpStdioServerConfig
  | McpSSEServerConfig
  | McpHttpServerConfig
  | McpSdkServerConfigWithInstance;   // ← in-process

// L719-721
export declare type McpSdkServerConfigWithInstance = McpSdkServerConfig & {
  instance: McpServer;
};
```

而 `createSdkMcpServer()` 直接返回 `McpSdkServerConfigWithInstance`,所以:

```ts
mcpServers: { axon: createSdkMcpServer({...}) }
```

类型就是对的。

---

## Q4: `disallowedTools` 在 cli.js 内部的实现

### 从 SDK 到 cli.js 的传递 / SDK → cli.js Wire

`sdk.mjs` `cX` 类(transport spawner,token-split L10942-10973):

```js
let { ..., disallowedTools: x$ = [], tools: G6, ... } = options;
// ...
if (x$.length > 0) p.push("--disallowedTools", x$.join(","));
if (G6 !== void 0)
  if (Array.isArray(G6))
    if (G6.length === 0) p.push("--tools", "");
    else                 p.push("--tools", G6.join(","));
  else                   p.push("--tools", "default");
```

**通过 CLI flag,不写文件**。

### cli.js 内部解析(BK7 函数)/ Inside cli.js (BK7)

`/tmp/axon_cli_split.txt` L347726 (`function BK7({allowedToolsCli, disallowedToolsCli, baseToolsCli, ...})`):

```js
async function BK7({ allowedToolsCli: q, disallowedToolsCli: K, baseToolsCli: _,
                     permissionMode: z, allowDangerouslySkipPermissions: Y, addDirs: O }) {
  let A = oC(q).map((k) => k9(C2(k))),     // 解析 allowedTools
      $ = oC(K);                             // ★ 解析 disallowedTools

  if (_ && _.length > 0) {                   // ★ 如果传了 --tools
    let k = bVK(_),
        V = new Set(k.map(YZ)),
        E = Z77().filter((R) => !V.has(R));  // ★ Z77()=全部 builtin → 把没列出的全部加到 deny
    $ = [...$, ...E];                        // ★ 合并到 disallowedTools 列表
  }
  // ...
  let G = VVK({
    mode: z,
    additionalWorkingDirectories: j,
    alwaysAllowRules: { cliArg: A },
    alwaysDenyRules:  { cliArg: $ },         // ★ disallowedTools 进入 toolPermissionContext.alwaysDenyRules.cliArg
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: P,
    ...
  }, W);
  // ...
}
```

### deny 规则的两层效果 / Two-Layer Effect of Deny Rules

#### 第一层:从 main loop 工具清单里物理删除 / Layer 1: Physical removal from main-loop tool list

`/tmp/axon_cli_split.txt` L324498-324516:

```js
function l56() {
  return [ ng8, Vg8, c4, ...bj() ? [] : [kx, Uh], Gf, Iz, MP, XP, tp, Zf, dp,
           Ng8, vg8, eR6, v56, qq8, /* ... */ ];   // 全部 builtin 工具实例
}

function WS6(q, K) {
  return q.filter((_) => !ig8(K, _));            // ★ 用 deny 规则过滤
}

function td(q, K) {                              // q = toolPermissionContext, K = mcp.tools
  let _ = kf(q),                                 // ★ 过滤 builtin
      z = WS6(K, q),                             // ★ 过滤 mcp tools 也会用同一个 deny 规则!
      Y = (O, A) => O.name.localeCompare(A.name);
  return o2([..._].sort(Y).concat(z.sort(Y)), "name");
}

let kf = (q) => {                                 // q = toolPermissionContext
  if (U6(process.env.CLAUDE_CODE_SIMPLE)) { /* ... */ }
  let K = new Set([qa.name, $a.name, wW]),
      _ = l56().filter((O) => !K.has(O.name)),
      z = WS6(_, q);                              // ★ 这就是物理过滤
  // ...
  return z.filter((O, A) => Y[A]);
};
```

cli.js print.ts main session 构造 tools 时(`/tmp/axon_cli_split.txt` L464260):

```js
let _6 = { clients: [], tools: [], configs: {} },
    l = (L6) => {
      let S6 = td(L6.toolPermissionContext, L6.mcp.tools),  // ★ 每次调用都重过滤
          r6 = o2(Jb6([...z, ...n, ..._6.tools], S6, L6.toolPermissionContext.mode), "name");
      // ...
      return r6;
    };
```

`l` 在 line 465068 被调用:

```js
{
  tools: l($()),       // ★ 这里 → main loop 拿到的就是过滤后的 tool 数组
  commands: c,
  mcpClients: [...],
  ...
}
```

**结论**:Bash/Read 等 builtin 在 disallowedTools 里时,**根本不会出现在 Claude 收到的 system prompt / tools schema 里**。Claude 不知道这些工具存在,自然不会去调用。

#### 第二层:dispatch 前的权限决策也会拒 / Layer 2: Permission gate also denies

`/tmp/axon_cli_split.txt` L347106-347149,`m0K` 与 `yJY`(实际权限决策入口):

```js
async function m0K(q, K, _) {                      // q=tool, K=input, _=context
  let z = _.getAppState(),
      Y = ig8(z.toolPermissionContext, q);          // ★ 检查 deny 规则
  if (Y) return {
    behavior: "deny",
    decisionReason: { type: "rule", rule: Y },
    message: `Permission to use ${q.name} has been denied.`,
  };
  // ... 后续 ask/allow/checkPermissions 路径
}
```

即使工具因为某种原因绕过了 layer 1(比如 hardcoded 在 system prompt 里),layer 2 仍会拒。

### deny 规则匹配函数 / Rule Match Function

`/tmp/axon_cli_split.txt` L347024 `function bK7(q, K)`:

```js
function bK7(q, K) {                              // q=tool, K=rule
  if (K.ruleValue.ruleContent !== void 0) return !1;  // 带 ruleContent 的精细规则不匹配整个工具
  let _ = G91(q);                                 // 取出工具的"完整名"(mcp 工具是 mcp__server__name)
  if (K.ruleValue.toolName === _) return !0;      // ★ 精确匹配
  let z = gV(K.ruleValue.toolName),               // 解析 mcp__server__tool 形式
      Y = gV(_);
  return z !== null && Y !== null
    && (z.toolName === void 0 || z.toolName === "*")
    && z.serverName === Y.serverName;             // ★ mcp__server__* 通配
}
```

含义:
- `disallowedTools: ["Bash"]` → 精确匹配 builtin Bash → 物理删除
- `disallowedTools: ["mcp__axon__bash"]` → 精确匹配 axon mcp tool → 物理删除(误伤!)
- `disallowedTools: ["mcp__axon__*"]` → 通配,会删 axon 全部 mcp tools(误伤!)

> **重要**:axon 的 disallowedTools 列表里**绝对不能**包含 `mcp__axon__*`,否则会把自己注册的工具也屏蔽掉。

### 结论 / Conclusion

`disallowedTools: ["Bash", "Read", "Write", "Edit", "MultiEdit", "Grep", "Glob"]` 会:

1. 通过 `--disallowedTools` CLI flag 传给 cli.js
2. 解析后写进 `toolPermissionContext.alwaysDenyRules.cliArg`
3. 每次构造 main loop tools 列表时,`td()` → `kf()` → `WS6()` → `ig8()` 把这些 builtin 工具**从 tool 数组里物理删除**
4. Claude 收到的 system prompt 里**没有这些工具**
5. 即使 Claude 试图调用,`m0K`/`yJY` 也会以 "Permission to use Bash has been denied." 拒掉

**Claude 不会"偷偷调用" Bash 然后绕过 axon 的 mcp 工具**。这条死透了。

---

## Q5: system prompt 注入字段 / system prompt Injection

### Options 字段 / Field

`sdk.d.ts` L1352-1376:

```ts
systemPrompt?: string | {
  type: 'preset';
  preset: 'claude_code';
  append?: string;
};
```

### sdk.mjs 解析 / Parsing in sdk.mjs

token-split L621-624:

```js
function HL($, X) {
  let { systemPrompt: J, settings: Q, settingSources: Y, sandbox: z, ...W } = $ ?? {},
      G, U;
  if (J === void 0)             G = "";
  else if (typeof J === "string") G = J;             // ★ 字符串 → G (完整替换)
  else if (J.type === "preset")  U = J.append;       // ★ preset 形态 → U (作为追加)
  // 注意:string 形式 G 拿全部,preset 形式只拿 append 写到 U
  // ...
  let ML = {
    systemPrompt: G,
    appendSystemPrompt: U,
    agents: N,
    promptSuggestions: W.promptSuggestions,
    agentProgressSummaries: W.agentProgressSummaries,
  };
  return { queryInstance: new pX(hU, X, L, p, K, gU, yU, ML, o0), ... };
}
```

### 通过 control_request initialize 传给 cli.js / Passed to cli.js via control_request

`sdk.mjs` `pX.initialize()`(token-split L11440):

```js
async initialize() {
  // ...
  let X = this.sdkMcpTransports.size > 0 ? Array.from(this.sdkMcpTransports.keys()) : void 0,
      J = {
        subtype: "initialize",
        hooks: $,
        sdkMcpServers: X,                    // ← in-process MCP server 名字列表
        jsonSchema: this.jsonSchema,
        systemPrompt:       this.initConfig?.systemPrompt,        // ★
        appendSystemPrompt: this.initConfig?.appendSystemPrompt,  // ★
        agents: this.initConfig?.agents,
        promptSuggestions: this.initConfig?.promptSuggestions,
        agentProgressSummaries: this.initConfig?.agentProgressSummaries,
      };
  return (await this.request(J)).response;
}
```

### cli.js 端写入会话状态 / cli.js Writes Session State

`/tmp/axon_cli_split.txt` L465256-465260,`function YqO(q, K, _, z, Y, O, A, $, w, j, H)` (initialize handler):

```js
function YqO(q, K, _, z, Y, O, A, $, w, j, H) {
  if (_) { /* already initialized error */ return; }
  if (q.systemPrompt       !== void 0) w.systemPrompt       = q.systemPrompt;       // ★
  if (q.appendSystemPrompt !== void 0) w.appendSystemPrompt = q.appendSystemPrompt; // ★
  if (q.promptSuggestions  !== void 0) w.promptSuggestions  = q.promptSuggestions;
  if (q.agents) { /* ... */ }
  // ...
}
```

之后 `w.systemPrompt` 与 `w.appendSystemPrompt` 被传到 `submitMessage` 的 config(L4250 area):

```js
let g = typeof M === "string" ? M : void 0,
    { defaultSystemPrompt: F, userContext: U, systemContext: n } = await kj7({
      tools: Y,
      mainLoopModel: p,
      additionalWorkingDirectories: ...,
      customSystemPrompt: g,                            // ← 替换 system prompt 的路径
    });
// ...
let z6 = I5([
  ...g !== void 0 ? [g] : F,                            // ★ 如果有 customSystemPrompt 用它,否则用默认
  ...o ? [o] : [],
  ...X ? [X] : [],                                      // ★ X = appendSystemPrompt,追加
]);
```

### 结论 / Conclusion

**axon 必须用 preset 形态 + append**,**不要**用纯字符串 systemPrompt:

```ts
systemPrompt: {
  type: 'preset',
  preset: 'claude_code',
  append: `## Axon Tool Routing
This Claude session runs in Axon's brain process. All filesystem and shell
operations have been moved to the host machine via MCP tools prefixed with
\`mcp__axon__\`. You MUST use these instead of the standard Claude Code
builtin tools (which are unavailable here):

- mcp__axon__bash    — Run shell commands (replaces Bash)
- mcp__axon__read    — Read file contents (replaces Read)
- mcp__axon__write   — Write file contents (replaces Write)
- mcp__axon__edit    — Edit file (replaces Edit)
- mcp__axon__grep    — Search file contents (replaces Grep)
- mcp__axon__glob    — Find files by pattern (replaces Glob)

These tools execute on the host machine where the user's project lives.
Do not attempt to use Bash, Read, Write, Edit, Grep, or Glob — they have
been disabled in this session.`
}
```

> 写纯字符串 `systemPrompt: "..."` 会**完全替换**默认 system prompt(`F` 路径不走),失去 builtin 工具说明、agent 框架说明、所有 Claude Code 默认指令 —— 严重退化模型行为。

---

## Q6: MCP 工具命名约定 / MCP Tool Naming Convention

### 命名规则 / Rule

`/tmp/axon_cli_split.txt` L44215-44233:

```js
function S2(q) {                                    // sanitize
  let K = q.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (q.startsWith("claude.ai ")) K = K.replace(/_+/g, "_").replace(/^_|_$/g, "");
  return K;
}

function gV(q) {                                    // 反向解析
  let K = q.split("__"),
      [_, z, ...Y] = K;
  if (_ !== "mcp" || !z) return null;
  let O = Y.length > 0 ? Y.join("__") : void 0;
  return { serverName: z, toolName: O };
}

function OL(q) {                                    // 前缀
  return `mcp__${S2(q)}__`;
}

function Rz6(q, K) {                                // 完整名
  return `${OL(q)}${S2(K)}`;
}
```

所以:
- `createSdkMcpServer({name:"axon", tools:[tool("bash",...)]})`
- → cli.js 端注册的 tool 名是 `mcp__axon__bash`
- 反向解析:`gV("mcp__axon__bash") = {serverName:"axon", toolName:"bash"}`
- 多个 `__` 在 toolName 里仍然能正确解析(`split` 后剩余部分用 `__` join 回去)

### 字符限制 / Char Restrictions

- 服务器名和工具名中所有非 `[a-zA-Z0-9_-]` 字符会被替换成 `_`
- 没找到长度上限,但 MCP/Anthropic API 通常对工具名长度有 64 字符限制(超出会报 invalid request)。axon 的 `axon` + 6 个工具名都很短,不会触发

### 命名前缀可控吗 / Prefix Removable?

`/tmp/axon_cli_split.txt` L232733:

```js
let K = await q.client.request({ method: "tools/list" }, kp6),
    _ = sy6(K.tools),
    z = q.config.type === "sdk" && U6(process.env.CLAUDE_AGENT_SDK_MCP_NO_PREFIX);

return _.map((Y) => {
  let O = Rz6(q.name, Y.name),                       // 默认带前缀
      // ...
  return {
    ...EU1,
    name: z ? Y.name : O,                            // ★ 环境变量决定是否去前缀
    mcpInfo: { serverName: q.name, toolName: Y.name },
    isMcp: !0,
    // ...
  };
});
```

设置环境变量 `CLAUDE_AGENT_SDK_MCP_NO_PREFIX=true` 可以让 SDK MCP 工具用裸 toolName(`bash` 而不是 `mcp__axon__bash`)。但这会**与 builtin Bash 大小写区分**(`bash` ≠ `Bash`),仍然是不同工具,而且会让权限规则、工具列表显示等多处出现混乱。**axon 不建议用这个环境变量**,保持默认 `mcp__axon__*` 命名。

### Claude 怎么知道 `mcp__axon__bash` 等价于 Bash / How Does Claude Map It

**Claude 不会自动等价**。它只看:
1. 工具列表(已经被 disallowedTools 物理移除 Bash/Read 等)
2. 工具描述(`description` 字段)
3. system prompt 里的指令

所以必须靠 system prompt 明确告知"用 mcp__axon__bash 替代 Bash" + 每个 tool 的 description 写清楚"This is the Axon-routed equivalent of the standard Bash tool"。模型会很快接受这个映射(同 Cursor、Aider、各种 IDE 集成的常见做法)。

---

## Q7: 完整数据流验证 / Full Data Flow Verification

```
[Claude LLM]
  │ tool_use { id: "toolu_xxx", name: "mcp__axon__bash", input: { command: "ls" } }
  ▼
[cli.js 子进程]
  │ tool dispatch:                                                           [证据确凿]
  │   - 在 main loop tools 数组里找 name === "mcp__axon__bash"
  │   - tools 数组由 td() → l56()/builtin + xu4() → mcp tools 构造
  │   - xu4() 生成的 entry.call(input, ...) 是 mcp 调用入口
  │ → mcp call:                                                              [证据确凿]
  │   - tool entry 的 call() 函数(/tmp/axon_cli_split.txt L232760):
  │     await Ey6(q)  → 因 q.config.type==="sdk",直接 return q (不连 db)
  │   - Nfz({client:q, tool:"bash", args:input, ...}) → 调 bu4()
  │   - bu4 = MCP Client.callTool(),实际通过 q.client (= $h8 实例)
  ▼
[cli.js → SDK 进程的 mcp_message control_request]
  │ $h8 (= MCP Client) 通过其 transport (LQ1 实例) 发送 tools/call         [证据确凿]
  │ LQ1.send(mcpRequest):
  │   await sendMcpMessage(serverName, mcpRequest)
  │   = await q.sendMcpMessage(...)  ← 即 print.ts 闭包里那个
  │ q.sendMcpMessage(serverName, mcpRequest):
  │   = sdk.mjs 的 cX.sendMcpMessage 实例方法 (token-split L441625)
  │   把请求包成:
  │     { type:"control_request", request_id, request:
  │       { subtype:"mcp_message", server_name, message: mcpRequest } }
  │   通过 stdio 写到 SDK 进程
  ▼
[SDK 进程]
  │ pX.readMessages 收到 type==="control_request"                          [证据确凿]
  │ → handleControlRequest → processControlRequest
  │ → 命中 subtype==="mcp_message" 分支:
  │     Q = sdkMcpTransports.get(server_name)  // fz transport
  │     handleMcpControlRequest(server, request, Q):
  │       - 把 (server, message.id) 注册到 pendingMcpResponses
  │       - 触发 Q.onmessage(request.message)
  │ → fz.onmessage(message):                                               [证据确凿]
  │     这是 kU (MCP server) 在 X.connect(fz) 时绑上的内部 handler
  │ → kU 的 server 内部 dispatch:                                          [证据确凿]
  │     - 把 mcp request method "tools/call" 路由到 setRequestHandler 的回调
  │     - kU 在 setToolRequestHandlers (sdk.mjs body) 里注册过 tools/call 处理器
  │     - 处理器查 _registeredTools[name] → 拿到 axon 的 handler 函数
  │     - 调用 handler(args, extra):                                       [证据确凿]
  │       这是 axon 在 tool("bash", desc, schema, axonHandler) 注册的 axonHandler
  │       axonHandler 内部:                                                [证据确凿 — 取决于 axon 实现]
  │         const requestId = randomUUID();
  │         const pending = relay.createPending(requestId, "Bash");
  │         await transport.send({ type:"tool_call", sessionId, requestId, ... });
  │         const result = await pending;                                  [证据确凿 — relay 已存在]
  │         return { content: [{ type:"text", text: result.output ?? result.summary }] };
  ▼
[Hand 侧]
  │ Hand 收到 tool_call,执行真实 Bash,返回 ToolCallResult                [证据确凿]
  ▼
[SDK 进程 / Brain]
  │ axonHandler 的 await pending 解出
  │ axonHandler return CallToolResult
  │ kU 内部把 CallToolResult 序列化成 jsonrpc response
  │ kU 通过 fz transport.send(response) 写出
  │ → fz.send(response) → sendMcpMessage(serverName, response)
  │ → 这一步进入 pX.sendMcpServerMessageToCli:                             [证据确凿]
  │     "id" in response && response.id != null → true
  │     Q = `${serverName}:${response.id}`
  │     Y = pendingMcpResponses.get(Q)           // ★ 命中 pending
  │     Y.resolve(response); pendingMcpResponses.delete(Q); return;
  │     ★ 不再二次走 stdio
  │ → handleMcpControlRequest 的 Promise resolve(response)
  │ → processControlRequest 那里 return { mcp_response: response }
  ▼
[SDK → cli.js 的 control_response]
  │ pX.handleControlRequest 把 { mcp_response } 包成 control_response 写回 stdio
  ▼
[cli.js 端]
  │ pendingControlResponses.get(request_id).handler(response)              [证据确凿]
  │ → q.sendMcpMessage 那个 await 拿到 mcp_response
  │ → LQ1.send 的 await 完成
  │ → MCP Client.callTool 返回 CallToolResult
  │ → cli.js 的 tool dispatcher 把它包成 tool_result block
  │ → 加进 message 数组
  │ → 下一轮 API 调用把 tool_result 发给 Claude
  ▼
[Claude LLM]
  收到一个 type:"tool_result" 的 message,content 是 axonHandler return 的内容,
  is_error 默认 false。Claude 把它当真实工具输出处理。
  ★ 没有任何 error,没有任何旁路 additionalContext。模型行为完全标准。
```

**所有 8 个步骤都有代码证据,无需 spike 验证**。

---

## Q8: SDK 自带示例 / 文档 / SDK Examples & Docs

### README

`README.md` 内容很短(43 行),主要指向官方文档:
- https://platform.claude.com/docs/en/agent-sdk/overview
- https://github.com/anthropics/claude-agent-sdk-typescript

没有 examples/ 或 test/ 目录。

### cli.js 内嵌的 markdown 文档 / Embedded Markdown in cli.js

意外发现:cli.js 里(line 458920+)嵌入了一份完整的 Agent SDK 教程 markdown,**包含 In-Process MCP Tools 的示例代码**。这是 cli.js 给 `--help` 或某个 doc 命令用的内嵌文档,但作为权威来源完全可用:

```typescript
// === 摘自 /tmp/axon_cli_split.txt L458934-458980,经过 token-split 还原 ===

// ### In-Process MCP Tools

// You can define custom tools that run in-process using `tool()` and `createSdkMcpServer`:

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const myTool = tool(
  "my-tool",
  "Description",
  { input: z.string() },
  async (args) => {
    return { content: [{ type: "text", text: "result" }] };
  }
);

const server = createSdkMcpServer({ name: "my-server", tools: [myTool] });

// Pass to query
for await (const message of query({
  prompt: "Use my-tool to do something",
  options: { mcpServers: { myServer: server } },
})) {
  if ("result" in message) console.log(message.result);
}
```

cli.js L454000+ 还有 Python 版的对应示例,但里面有一句**重要警告**:

```
Custom tools require an MCP server. Use ClaudeSDKClient for full control
(custom SDK MCP tools require ClaudeSDKClient — query() only supports
external stdio/http MCP servers).
```

这是 **Python SDK 的限制**,**不是 TypeScript 的限制**。TypeScript 版的示例(上面那段)**直接用 `query()`,明确支持 in-process SDK MCP server**。这一条已经在 sdk.mjs 的 HL/pX 代码里逐行验证过。

### upstream / 外部文档链接

- 官方文档:https://platform.claude.com/docs/en/agent-sdk/overview
- TypeScript SDK 仓库:https://github.com/anthropics/claude-agent-sdk-typescript

---

## Q9: axon 代码复用清单 / axon Code Reuse Inventory

### 必须 / 可以保留 / Must / Can Be Preserved

| 模块 / Module | 文件 / File | 理由 / Reason |
|---|---|---|
| `ToolRelay` 类 | `server/src/relay.ts` | 完全不动。axon 的 mcp tool handler 仍然需要 createPending → 等待 Hand 完成 → resolve 的机制。`pX → fz → kU.handler → axonHandler → relay.createPending → await → return CallToolResult` 的整条链都依赖 ToolRelay |
| `protocol.ts` 的 ToolCall / ToolCallComplete / ToolResult / ServerToHandMessage / HandToServerMessage | `server/src/protocol.ts` | Hand 协议本身不需要变。新的 mcp handler 仍然通过 transport.send(toolCall) 给 Hand 发消息 |
| `hand-registry.ts` | `server/src/hand-registry.ts` | Hand 注册/路由完全不变 |
| Hand 侧的 ToolExecutor / Hand 实现 | (不在 axon server 里) | Hand 仍然按原协议执行 Bash/Read/Write,不需要任何改动 |
| `BrainSession` 类的骨架(promptChain / runPrompt / handleAssistantMessage / handleResultMessage / sendSessionEnd / close) | `server/src/session.ts` L113-302, L386-417 | session 生命周期管理跟 hook 无关,可以保留 |
| `resolveClaudeCodeExecutable()` 与 `CLAUDE_EXECUTABLE_CANDIDATES` | `server/src/session.ts` L17-21, L475-488 | 启动 cli.js 的路径解析无关 hook,保留 |
| `cwd: os.tmpdir()` 的 SDK 子进程 cwd | `server/src/session.ts` L218 | 仍然是必要的 — SDK 子进程的 cwd 跟 Hand 的真实 cwd 解耦,保留 |
| `runSdkQuery` runner / `queryRunner` 注入点 | `server/src/session.ts` L137, L490-492 | 测试可注入,保留 |

### 必须重写 / Must Be Rewritten

| 模块 / Module | 文件 / File | 怎么改 / How |
|---|---|---|
| `handlePreToolUse` | `server/src/session.ts` L305-384 | 整段删除。原本"hook 拦截 → relay → return permissionDecision/additionalContext"的模式作废。改造后:在 `runPrompt` 内部用 `createSdkMcpServer({ tools: [tool("bash", desc, schema, this.handleBashToolCall.bind(this)), ...] })` 注册 6 个 mcp tool,每个 handler 内部做 createPending + transport.send + await + return CallToolResult |
| `PreToolUseHookResult` 类型 | `server/src/session.ts` L71-76 | 删除。新代码改为返回 SDK 的 `CallToolResult`,从 `@anthropic-ai/claude-agent-sdk` 或 `@modelcontextprotocol/sdk` 导入 |
| `SessionQueryOptions.hooks` 字段 | `server/src/session.ts` L85-90 | 删除 hooks 字段。如要保留 PreToolUse 作为审计日志,可以注册一个空 callback,return `{}`(BO7 解析后等同于无操作),但这是可选 |
| `runPrompt` 里 `query()` 的 options | `server/src/session.ts` L210-230 | 删除 `hooks` 字段;新增 `mcpServers: { axon: this.createMcpServer() }`;新增 `disallowedTools: ["Bash","Read","Write","Edit","MultiEdit","Grep","Glob"]`;新增 `systemPrompt: { type:"preset", preset:"claude_code", append: AXON_PROMPT_FRAGMENT }` |
| `handleCanUseTool` | `server/src/session.ts` L400-416 | 简化或保留。改造后所有 mcp 工具都是 `mcp__axon__*`,canUseTool 可以一律 allow(因为 axon 自己的 mcp tool handler 内部已经做了路由)。可以删除整个字段或保留作为安全网 |
| `shouldRouteToolToHand` 的注入与使用 | `server/src/session.ts` L122, L135-136, L406; `server/src/server.ts` L552-556 | 大部分可以删除。改造后路由由"哪些工具暴露给 Claude"决定,而不是"对每个 builtin 工具运行时判断是否拦截"。但 `ToolRoutingStore` 的配置语义仍然有用(决定 axon 注册哪些 mcp tools / 哪些不注册) |
| `WebFetch` / `mcp__` prefix 的 hand 路由 | `server/src/tool-routing.ts` `DEFAULT_CONFIG` | WebFetch 改成注册 `mcp__axon__webfetch`(同样需要 `disallowedTools: ["WebFetch"]`)。`mcp__` prefix 路由整个删除 — 因为新方案不再"拦截"任何工具,而是"暴露什么 Claude 才能调什么" |

### 必须删除 / Must Be Deleted

| 文件 / File | 理由 / Reason |
|---|---|
| `server/test/fixtures/fake-claude.ts` | 已被证明是反向证据,断言基于错误的 SDK 协议理解。新方案下完全没用 |
| `server/test/e2e-hand.test.ts` | 同上。如要保留 e2e 测试,需要重写为基于 fake mcp client 模式(模拟 cli.js 通过 control_request mcp_message 调 SDK 进程)。但更简单的方式是改成 unit test 直接测 axon 的 mcp tool handler |
| 任何 `PreToolUseHookResult` 字面量出现的地方 | 字段被 BO7 丢弃,新方案不用 |
| 测试文件中所有 `hooks: { PreToolUse: ... }` 断言 | 改造后注册路径不再用 hooks |

### `tool-routing.ts` 的处境 / `tool-routing.ts` Fate

可以保留**配置语义**,但**应用方式**完全变:

```ts
// 旧:每次工具调用判断是否拦截
shouldRouteToHand("Bash") → true → handlePreToolUse 跑 relay

// 新:启动 session 时根据配置决定注册哪些 mcp tool
const cfg = toolRoutingStore.snapshot();
const tools = [];
for (const name of cfg.builtinToolNames) {
  tools.push(tool(toMcpName(name), descFor(name), schemaFor(name), makeHandler(name)));
}
// cfg.handToolNames (e.g. WebFetch) 和 builtinToolNames 一样处理
// cfg.handToolPrefixes (mcp__) 整段删除 — 没意义了
const axonServer = createSdkMcpServer({ name: "axon", tools });
```

---

## 可行性裁定 / Feasibility Verdict

- **等级 / Level**:**STRONG**
- **理由 / Rationale**:
  1. `createSdkMcpServer` / `tool()` API 在当前 SDK (0.2.92) 主入口直接 export,签名稳定
  2. `xx()` 函数实现是纯 in-process 的,不 spawn / 不写盘 / handler 闭包就在 SDK 进程
  3. `mcpServers: { axon: createSdkMcpServer(...) }` 在 sdk.mjs HL() 里被剥离,SDK 类型走 `gU` Map (in-process) 路径,**绝对不会**经 `--mcp-config` flag 写进 cli.js 启动参数
  4. cli.js 端 `xu4` 工厂用 `LQ1` (in-process transport) + `$h8` MCP Client 建立的 client 是真实 client,可以 `tools/list` / `tools/call`
  5. cli.js → SDK 进程的反向通道 (`control_request {subtype:"mcp_message"}`) 在 sdk.mjs `pX.processControlRequest` 已实现,**已经是生产路径**
  6. `disallowedTools` 通过 `--disallowedTools` flag 注入,在 cli.js 端进入 `alwaysDenyRules.cliArg`,经 `td/kf/WS6/ig8` 把 builtin 工具**从 main loop tools 数组里物理删除**;Claude 根本看不到 Bash 等工具
  7. `systemPrompt: {type:"preset", preset:"claude_code", append: "..."}` 走 cli.js 的 `appendSystemPrompt` 路径,**在保留默认 system prompt 的前提下**追加 axon 自定义指令
  8. cli.js 内嵌的 SDK 教程 markdown 包含 In-Process MCP Tools 的示例代码,**与本文 Q1 给出的最小用法签名一致** — 这是 upstream 官方推荐的用法,axon 是在走 SDK 设计者预期的路径
  9. 整条数据流闭环已逐步验证(Q7),所有 8 步都有代码证据,无需 spike

- **剩余未确定的点(可在实施时一次性 spike)/ Remaining Unknowns**:
  1. ★ `CallToolResult.content` 数组里 axon 实际 return 的内容怎么映射到 Claude 看到的 tool_result block?需要 spike 一次,确认:
     - text 类型直接拼接 string
     - image / audio / resource 类型怎么处理(对于 Bash/Read 大概率只用 text,但 Read 可能要支持 image 类型)
     - 是否需要在 handler 里做 truncation(cli.js 有 `it6 = 2048`、`Vfz` 大输出 → 文件转储 等机制,需要确认是否对 SDK MCP 工具也生效;预期生效,但要验)
  2. ★ `tool` 注册时的 `description` 字段由 `kf6` 之类压缩到 system prompt 里,长度上限是多少?如果 axon 想给 mcp__axon__bash 写很详细的描述,需要测试上限
  3. ★ axon 的 mcp tool handler 是异步的,如果 Hand 侧执行很慢(几分钟),需要验证 SDK MCP 是否会超时。`sdk.d.ts` L355 注释提到 `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT` 默认 60s,可以通过 env 增大 — 但 axon 应该测一下默认值是否够用,不够就在 env 里设置
  4. ★ 错误传播 / Error propagation:axon handler throw 时,`kU` 内部会把 throw 包成 `{content:[{type:"text",text:err.message}], isError:true}`。需要验证 cli.js 收到 isError:true 后会作为 error tool_result 给 Claude,Claude 行为是什么(应该是看到错误后调整策略,但要测)
  5. ★ 并发:同一个 session 内可能有多个 mcp tool 同时调用(当模型连发多个 tool_use)。pX 的 pendingMcpResponses 用 `${server}:${id}` 做 key,理论上无冲突,但要测并发场景下 ToolRelay 的 requestId 与 mcp message id 之间有没有竞态

---

## 改造方案草图 / Implementation Sketch

### 第一阶段:核心改造 / Phase 1: Core Refactor

```ts
// server/src/session.ts (改造后)
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const AXON_SYSTEM_PROMPT_APPEND = `
## Axon Tool Routing
... (上面 Q5 给出的内容)
`;

class BrainSession {
  // ... 保留原有字段

  private buildAxonMcpServer() {
    const wrap = <S extends z.ZodRawShape>(
      mcpName: string,
      handToolName: string,
      desc: string,
      schema: S,
    ) => tool(mcpName, desc, schema, async (args, _extra) => {
      return await this.routeMcpToHand(handToolName, args);
    });

    return createSdkMcpServer({
      name: "axon",
      version: "1.0.0",
      tools: [
        wrap("bash",  "Bash",  "Execute a shell command via Axon Hand",
             { command: z.string(), cwd: z.string().optional(), timeout: z.number().optional() }),
        wrap("read",  "Read",  "Read a file's contents via Axon Hand",
             { file_path: z.string(), offset: z.number().optional(), limit: z.number().optional() }),
        wrap("write", "Write", "Write/create a file via Axon Hand",
             { file_path: z.string(), content: z.string() }),
        wrap("edit",  "Edit",  "Edit a file via Axon Hand (find/replace)",
             { file_path: z.string(), old_string: z.string(), new_string: z.string(),
               replace_all: z.boolean().optional() }),
        wrap("grep",  "Grep",  "Search file contents via Axon Hand",
             { pattern: z.string(), path: z.string().optional(), glob: z.string().optional() /* ... */ }),
        wrap("glob",  "Glob",  "Find files by glob pattern via Axon Hand",
             { pattern: z.string(), path: z.string().optional() }),
        wrap("webfetch", "WebFetch", "Fetch a URL via Axon Hand (proxied)",
             { url: z.string(), prompt: z.string().optional() }),
      ],
    });
  }

  private async routeMcpToHand(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
    const requestId = `mcp-${this.id}-${randomUUID()}`;
    const pending = this.relay.createPending(requestId, toolName);
    try {
      await this.transport.send({
        type: "tool_call",
        sessionId: this.id,
        requestId,
        toolName,
        toolUseId: undefined,  // 现在没有 SDK 的 tool_use_id 透传给 Hand,可以补一个或省略
        input: args,
      });
    } catch (error) {
      this.relay.reject(requestId, asError(error));
      throw error;
    }

    const result = await pending;
    await this.transport.send({
      type: "tool_call_complete",
      sessionId: this.id,
      requestId,
      toolName,
    });

    if (result.error) {
      return {
        content: [{ type: "text", text: result.error }],
        isError: true,
      };
    }
    const text = typeof result.output === "string"
      ? result.output
      : (result.summary ?? JSON.stringify(result.output ?? null));
    return { content: [{ type: "text", text }] };
  }

  private async runPrompt(text: string): Promise<void> {
    // ... (保留原有 status / closed 检查 / sendSessionEnd)
    const stream = this.queryRunner({
      prompt: text,
      options: {
        cwd: os.tmpdir(),
        model: this.model,
        pathToClaudeCodeExecutable: resolveClaudeCodeExecutable(),
        permissionMode: "default",
        // ★ 不再写 hooks
        // ★ 不再写 canUseTool(或保留作为兜底,一律 allow)
        maxTurns: 100,
        mcpServers: {
          axon: this.buildAxonMcpServer(),     // ★ in-process MCP server
        },
        disallowedTools: [                       // ★ 屏蔽所有 builtin
          "Bash", "Read", "Write", "Edit", "MultiEdit",
          "Grep", "Glob", "WebFetch",
        ],
        systemPrompt: {                          // ★ 追加 axon 指令(不替换默认)
          type: "preset",
          preset: "claude_code",
          append: AXON_SYSTEM_PROMPT_APPEND,
        },
        // 严格 SDK 隔离:不要碰 ~/.claude
        // 不显式设置 settingSources(默认就是空数组)
        // 不显式设置 settings
      } satisfies Parameters<typeof query>[0]["options"],
    });
    // ... (保留原有 for await 循环)
  }
}
```

### 第二阶段:测试改造 / Phase 2: Test Refactor

1. **删除** `server/test/fixtures/fake-claude.ts` 和 `server/test/e2e-hand.test.ts`
2. **改写** session 单测为:用 `queryRunner` 注入,直接测试:
   - axon 注册的 mcp tool handler 调用 → relay.createPending → transport.send 工具调用 → 模拟 Hand 返回 → 验证 CallToolResult 的形状
   - disallowedTools / systemPrompt option 是否正确传给 query
3. **新增** 一个最小 in-process 集成测试:
   - 用 SDK 真实的 query() + queryRunner = real
   - 注册一个 dummy MCP tool,handler 立即返回固定 text
   - 验证 query 流确实输出包含 dummy tool 结果的 assistant message
   - 这个测试不需要 fake-claude,直接打 Anthropic API(只要有 key,几秒钟一跑)
4. **保留** 单元测试中所有跟协议无关的部分(promptChain、status 状态机等)

### 第三阶段:Hand 侧改造(可能需要)/ Phase 3: Hand-Side Adjustment (Possibly)

Hand 侧 ToolExecutor 仍然按原 protocol.ts 的 ToolCall 接收。但**注意**:旧路径里 `tool_use_id` 是来自 SDK 的真实 id(从 hook input 拿),新路径里没有这个 id 可用(因为 mcp tool handler 的 `extra` 参数里也没暴露 toolUseID)。如果 Hand 侧依赖 toolUseId 做去重或日志,需要:
- 要么改用 axon 自己生成的 requestId 替代
- 要么在 mcp tool handler 的 `_extra` 参数里查找(需要 spike 验证 _extra 实际包含什么字段)

---

## 推荐的下一步 / Recommended Next Step

可行性 = STRONG,推荐**直接进入实施**,但**实施前先做一个 30-分钟最小 spike** 验证以下几点(防止 Q9 列出的剩余未确定点变成大坑):

### Spike 任务清单 / Spike Task List

1. 写一个 50 行的最小 axon-spike.ts:
   ```ts
   import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
   import { z } from "zod";

   const echoTool = tool("echo", "Echo back the input",
     { text: z.string() },
     async (args) => ({ content: [{ type:"text", text: `you said: ${args.text}` }] })
   );

   const mySrv = createSdkMcpServer({ name: "spike", tools: [echoTool] });

   for await (const msg of query({
     prompt: "Use the mcp__spike__echo tool with text='hello world' and report back what it returned.",
     options: {
       mcpServers: { spike: mySrv },
       disallowedTools: ["Bash","Read","Write","Edit","MultiEdit","Grep","Glob","WebFetch"],
       systemPrompt: { type:"preset", preset:"claude_code",
                       append: "You have an mcp__spike__echo tool. Use it to fulfill any request." },
       maxTurns: 3,
     },
   })) {
     console.log(JSON.stringify(msg, null, 2));
   }
   ```
2. 跑一次,确认:
   - SDK 不报错
   - assistant 消息里出现 `tool_use { name:"mcp__spike__echo", input:{text:"hello world"} }`
   - tool_result 消息里出现 `you said: hello world`(且 is_error: false)
   - 没有 cli.js spawn 任何 mcp 子进程(可以 `lsof -p <pid>` 验证)
   - cwd 是 process.cwd()(这是 SDK 子进程的,handler 闭包仍持有 spike 的进程上下文)
3. 改成 Bash(模拟):
   ```ts
   const bashTool = tool("bash", "Run a shell command (Axon)",
     { command: z.string() },
     async (args) => {
       const { execSync } = await import("node:child_process");
       const out = execSync(args.command, { encoding: "utf8" });
       return { content: [{ type:"text", text: out }] };
     }
   );
   // ... mcpServers: { axon: createSdkMcpServer({ name:"axon", tools:[bashTool] }) }
   // ... disallowedTools: ["Bash"]
   // prompt: "Run pwd"
   ```
4. 跑一次,确认:
   - Claude 不再用 Bash(找不到了),改用 mcp__axon__bash
   - 输出是 spike 进程的 cwd(证明 handler 在 spike 进程跑,**不是** cli.js 子进程)
   - 验证 Q9 剩余未确定的点 1(content 数组映射)、4(error 传播,可以让 handler throw 一次试)
5. 如果 spike 全部通过,**直接实施**,删 fake-claude / e2e-hand,改 session.ts

### 如果 spike 失败 / If Spike Fails

只在以下情况退回 / 重新评估:
- SDK 真的不接受 in-process MCP server(几乎不可能,代码已经验证完)
- 工具调用并发出 race condition(需要 spike 才能发现)
- description 长度上限严重限制 axon 的工具说明能力(需要 spike 才能发现)
- Hand 路径的 toolUseId 缺失成为阻塞(可以在 spike 时一次性确认 _extra 参数包含什么)

实施风险:**低**。

---

## 文件位置 / Key File Locations

| 文件 / File | 用途 / Purpose |
|---|---|
| `/Users/n374/Documents/Code/axon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` | TypeScript 类型定义,Q1/Q3 全部签名来源 |
| `/Users/n374/Documents/Code/axon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` | SDK 进程实现,Q2/Q5 关键证据 |
| `/Users/n374/Documents/Code/axon/node_modules/@anthropic-ai/claude-agent-sdk/cli.js` | cli.js 内核(13MB 压缩),Q4/Q6/Q7/Q8 证据 |
| `/Users/n374/Documents/Code/axon/node_modules/@anthropic-ai/claude-agent-sdk/package.json` | 版本信息(0.2.92 / 2.1.92) |
| `/Users/n374/Documents/Code/axon/node_modules/@anthropic-ai/claude-agent-sdk/README.md` | 上游链接 |
| `/Users/n374/Documents/Code/axon/server/src/session.ts` | 改造主战场,Q9 来源 |
| `/Users/n374/Documents/Code/axon/server/src/relay.ts` | 保留 |
| `/Users/n374/Documents/Code/axon/server/src/tool-routing.ts` | 改造但不删 |
| `/Users/n374/Documents/Code/axon/server/src/server.ts` L552-556 | 改造点 |
| `/Users/n374/Documents/Code/axon/.claude/hook-semantics-truth.md` | 原调研结论(为什么旧路径不行) |

> 调研期间为了搜大文件,生成了 `/tmp/axon_cli_split.txt`(token-split 后的 cli.js,约 47 万行),如果未来需要复查可以重新生成:
> ```
> perl -pe 's/(\bclass\s+\w+|\bvar\s+\w+\s*=|\bfunction\s+\w+\b|\bexport\s*\{|\;|\{|\})/\n$1/g' \
>   /Users/n374/Documents/Code/axon/node_modules/@anthropic-ai/claude-agent-sdk/cli.js \
>   > /tmp/axon_cli_split.txt
> ```
