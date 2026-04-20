# cwd 透传删除 — 独立评审

## 评审对象

**文件**: `server/src/session.ts` 第 213 行(改动前)

**改动**: 在 `runPrompt` 调用 `queryRunner` 时，删除 `cwd: this.cwd` 字段，改为注释"故意不传 cwd"。配套 `server/test/session-flow.test.ts` 把断言从 `cwd: "/workspace/demo"` 改成 `cwd: undefined`。

**保留不动**: `BrainSession.cwd` 字段、`info()` 中的 cwd、日志中的 cwd、`SessionQueryOptions` 接口的 `cwd: string` 属性（本地接口），以及 `server/src/server.ts` 里 `handleCreateSession` 依然把 `message.cwd` 传给 `BrainSession`。

---

## Q1: 是否真正修复原 bug

**评级: PASS (但见 Q2d 的编译错误 — 合起来当前改动不能直接 commit)**

### 证据链

1. **原始故障**: Hand 传 `/Users/n374/.../hand` → Brain 容器透传给 SDK → SDK 内部 `child_process.spawn(claude, { cwd: "/Users/n374/.../hand" })` → 容器内该路径不存在 → spawn 报 ENOENT → SDK 误判为"找不到 executable"。

2. **SDK 运行时证据** (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` 第 58 行, `class cX` ProcessTransport):
   ```js
   initialize(){
     let{additionalDirectories:$=[], agent:X, betas:J, cwd:Q, executable:Y=..., ...} = this.options;
     ...
     let d9 = {command: t0, args: s4, cwd: Q, env: U, signal: this.abortController.signal};
     this.process = this.spawnLocalProcess(d9);
   }
   spawnLocalProcess($){
     let {command:X, args:J, cwd:Q, env:Y, signal:z} = $;
     let G = qM(X, J, {cwd: Q, stdio:["pipe","pipe",W], signal:z, env:Y, windowsHide:!0});
     ...
   }
   ```
   `qM` 是 `child_process.spawn`。SDK 内部**不做默认填充** — 当 `options.cwd` 未传时，`Q=undefined`，直接透传给 `child_process.spawn({cwd: undefined, ...})`。

3. **Node 官方行为**: `child_process.spawn` 文档明确说，当 `options.cwd == null/undefined` 时，子进程继承**父进程 `process.cwd()`**。

4. **容器内的父进程 cwd**: `Dockerfile` 设了 `WORKDIR /app`，`docker-entrypoint.sh` 用 `exec node /app/server/dist/index.js`，没有 `cd` 到别处。所以 Brain Node 的 `process.cwd()` = `/app`。该目录在镜像里是 `chown node:node` 的合法目录，必定存在。

5. **结论**: 改后 SDK spawn claude 子进程时，cwd = `/app`，存在 → spawn 成功 → 原 bug 修复。

### 结论

**修复机制正确**。但"不传 cwd 由 `child_process.spawn` 回退到 `process.cwd()`"的机制和注释里写的"继承默认 WORKDIR"**不是同一件事** — 后者暗示"Docker 层面的 WORKDIR"，实际上是"Node 父进程的当前 cwd"。两者在容器内恰好相等，但在非容器环境下会不同，见 Q4。

---

## Q2a: 项目级配置加载副作用

**评级: CONCERN (容器场景 PASS，本地开发场景 CONCERN)**

### 证据

`node_modules/@anthropic-ai/claude-agent-sdk/cli.js` 第 509 行附近：

```js
function q$6(q){
  let K=A7();
  switch(q){
    case"User":     return QL(Y7(), "CLAUDE.md");
    case"Local":    return QL(K, "CLAUDE.local.md");
    case"Project":  return QL(K, "CLAUDE.md");
    case"Managed":  return QL(mP(), "CLAUDE.md");
    ...
  }
}
function A7(){ return v8.originalCwd; }
```

`A7()` 返回 `v8.originalCwd`，而 `originalCwd` 在 Claude CLI 启动时通过 `process.cwd()` 初始化。也就是说 **Claude CLI 会根据它启动时的 `process.cwd()` 去查找 `CLAUDE.md` / `CLAUDE.local.md` / `.claude/settings.json` / `.claude/settings.local.json`**。

cli.js 明确引用了 `settings.json` 和 `settings.local.json` 23 处，`CLAUDE.md` 66 处。并且可以看到加载逻辑:
```js
settingSources... let j=A7();
if(j!==H) O.push(r$6(j,".claude","settings.json")),
          O.push(r$6(j,".claude","settings.local.json"))
```

### 容器场景 (PASS)

- `/app` 里只有 `package.json`、workspace `package.json`、`node_modules`、`server/dist`（见 Dockerfile 第 29-49 行）。
- **没有** `CLAUDE.md`、没有 `.claude/settings.json`、没有 `.claude/settings.local.json`。
- 改后 Claude CLI 起在 `/app`，查这几个文件都 miss，加载"空项目"状态，干净安全。

### 本地开发场景 (CONCERN)

- 开发时 `npm start`（`tsx src/index.ts`）或 `node dist/index.js` 通常在 `/Users/n374/Documents/Code/axon/server` 或 `/Users/n374/Documents/Code/axon` 下执行。
- axon 自己有 `.claude/settings.local.json`（我已读过，内容全是 `permissions.allow` 白名单，主要是 WebFetch 域名）。
- **Claude CLI 起在 `axon/server` 或 `axon/` 时，会递归向上查找并加载 `axon/.claude/settings.local.json`**。因为 axon 架构里所有 tool 都走 Hook 拦截 → `permissionDecision: "deny"`，permissions 白名单事实上不起作用；但这里存在两个隐患：
  1. **语义不一致**: 本地开发时 Brain 的 Claude 子进程会加载 axon 自己的项目配置，测试/调试时行为和生产容器不一致。
  2. **未来 SDK/CLI 变更风险**: 如果未来 Claude CLI 对 settings 的处理发生变化（比如某些设置无论 hook 返回什么都生效），axon 自己 repo 的设置会意外生效。
- 用户级 `~/.claude/CLAUDE.md` 是**另一回事** — 不由 cwd 决定，是按 `os.homedir()` 查的，改不改这一行都会被加载（并且是生产路径：`/home/node/.claude` bind mount 会把宿主的 `~/.claude/CLAUDE.md` 也带进容器）。这**不是本 PR 引入的新问题**，但应当知晓。

### 结论

- 容器场景 `/app` 干净，无副作用。
- 本地开发场景会沾染 `axon/.claude/settings.local.json`，目前因为 hook 拦截不会真正生效，但属于**隐式依赖**。**建议**在本地开发模式下主动 set `process.chdir("/tmp")` 或传一个确定的 cwd 参数，让行为和容器一致。

---

## Q2b: MCP cwd 副作用

**评级: PASS**

### 证据

- Claude CLI 的 `.mcp.json` 读取是在项目 cwd 下（和 `CLAUDE.md` 同样由 `A7()`/`originalCwd` 决定）。
- `/app` 里没有 `.mcp.json`，所以容器里 MCP 也不会误加载任何东西。
- axon 本身在 `BrainSession.runPrompt` 没传 `mcpServers` 给 SDK，`_U = undefined`（见 sdk.mjs `HL` 函数），SDK 不会主动启任何 stdio MCP server。
- Claude CLI 本身如果读到 `.mcp.json` 会尝试 spawn 配置里的 MCP server，但 `/app` 没这文件。
- 非容器本地开发: axon 根目录和 server 目录都没有 `.mcp.json`。已确认过。

### 结论

MCP 不受影响。

---

## Q2c: session-sdk-spawn 真实 spawn 的鲁棒性

**评级: PASS with note**

### 证据

- `test/session-sdk-spawn.test.ts` 第 46 行传了 `cwd: WORKDIR`，但改动后 `runPrompt` 直接丢掉不传给 SDK，所以这个 `WORKDIR` 现在只存进 `BrainSession.cwd` 的 bookkeeping 字段。
- fake-claude 脚本（`test/fixtures/fake-claude.ts`）不依赖 cwd:
  - 写入文件用的都是 `AXON_FAKE_CLAUDE_ARGS_FILE` / `AXON_FAKE_CLAUDE_STDIN_FILE` 这两个**绝对路径**环境变量。
  - stdin/stdout 都是 JSON 流，与文件系统无关。
- 实际 SDK spawn fake-claude 时 cwd = `process.cwd()` = 测试进程当前目录。只要该目录存在（`node --test` 启动时 `process.cwd()` 必定存在），spawn 就 OK。
- 断言也只检查了 argv 里有 `--model/--permission-mode/stream-json` 等，**没有**任何关于 cwd 的断言。

### Note

- 测试仍然通过，但该测试**再也验证不了"axon 是否传对了 cwd"** — 因为根本就不传了。这并不是此次改动的 regression，而是一个"测试原本就没覆盖这条路径"的事实。
- CI 环境下 `process.cwd()` 可能是 `/home/runner/work/...`，同样存在，不会翻车。

### 结论

测试在当前改动下继续稳定通过，且 fake-claude 本身不依赖 cwd，没有隐藏风险。

---

## Q2d: 类型兼容性

**评级: FAIL — 必须修**

### 证据

`server/src/session.ts` 第 78-91 行仍声明:
```ts
interface SessionQueryOptions {
  cwd: string;  // ← 依然是 required，不是 optional
  model: string;
  pathToClaudeCodeExecutable: string;
  ...
}
```

但第 211-226 行新的对象字面量**不再传 cwd**:
```ts
const stream = this.queryRunner({
  prompt: text,
  options: {
    // 此处故意不传 cwd
    model: this.model,
    ...
  },
});
```

我直接跑了 `npx tsc --noEmit`（tsconfig: `strict: true`），结果：
```
src/session.ts(213,9): error TS2741: Property 'cwd' is missing in type
'{ model: string; pathToClaudeCodeExecutable: string; permissionMode: "default";
   canUseTool: CanUseToolHandler; maxTurns: number; hooks: {...}; }'
but required in type 'SessionQueryOptions'.
```

### 为什么 `npm test` 没挂？

`server/package.json` 的 test 脚本用 `node --import tsx --test test/**/*.test.ts`，tsx 是**运行时编译**（esbuild），默认**不做类型检查**。所以 24/24 通过掩盖了 tsc 报错。

### 为什么这很致命？

`server/package.json` 的 build 脚本是 `tsc`，Dockerfile 第 27 行:
```dockerfile
RUN npm run build --workspace server
```
会跑 `tsc`，遇到上面的 TS2741 **直接失败**，Docker 镜像构建会挂。这意味着**这次改动当前无法上生产**，直到 SessionQueryOptions 接口同步改成 `cwd?: string`（或直接从本地接口里删掉 cwd 字段）。

### 修复建议

方案 A (推荐 — 最小改动):
```ts
// server/src/session.ts 第 79 行
interface SessionQueryOptions {
  cwd?: string;   // 从 string 改为 string | undefined
  ...
}
```

方案 B (更彻底 — 保持局部接口与 runtime 一致):
```ts
// 直接从 SessionQueryOptions 中删除 cwd 字段
// 同步在 QueryRunnerInput 中的类型约束里也删除 cwd
```

### 结论

**这个是 blocker，必须在 commit 前修掉**，否则 docker build 挂。

---

## Q2e: 非容器 / CI 场景

**评级: CONCERN**

### 场景枚举

| 场景 | Brain 进程 cwd | 不传 cwd 的结果 | 评估 |
|------|----------------|-----------------|------|
| Docker 容器（WORKDIR /app） | `/app` | Claude cwd=/app，无配置文件 | 安全 |
| 本地 `npm start`（在 `server/`） | `.../axon/server` | Claude cwd=`.../axon/server`，向上找到 `axon/.claude/settings.local.json` | **隐式依赖**，虽然被 hook 兜底但不干净 |
| 本地 `tsx src/index.ts`（在 `axon/` 根目录） | `.../axon` | 同上 | 同上 |
| CI 跑 test（`.../axon/server`） | 同上 | 不影响测试因为测试用 fake-claude | 无影响 |
| 用户自定义 WORKDIR 的容器 | 自定义 | 如果那个目录里放了项目配置 → 会加载 | 低概率 |

### 关键隐患

最担心的不是崩溃，而是**"dev mode 跑的 Brain 会意外加载 axon 自己的项目配置"**。这会导致：
- 开发者在 axon 目录下做"Brain 联调"时，Claude 子进程看到的 permissions 白名单和生产不一致。
- 假如有人给 axon 加了 `.claude/settings.json` 配置 `hooks.PreToolUse` 或 `autoApprove` 之类的 setting，会和 axon 自己注册的 hook 冲突，行为不可预测。

### 建议

在 runPrompt 里显式传一个**可控的 cwd**，比如:
```ts
cwd: process.env.AXON_BRAIN_SDK_CWD ?? os.tmpdir(),
```
或在容器外的开发模式显式 `process.chdir(os.tmpdir())`。这样本地和容器行为一致，且不会沾染任何项目。

### 结论

"不传 cwd"在**容器里**能解决原 bug，但**隐式依赖 `process.cwd()`** 的行为在本地开发场景下会让 Brain 的 Claude 子进程意外地看到 axon 自己的项目配置。不是致命，但不干净。

---

## Q3: 替代方案对比

| 方案 | 描述 | 优点 | 缺点 | 推荐度 |
|------|------|------|------|--------|
| 0 | 保持现状不动 | 零风险 | 原 bug 不修 | 0★ |
| **1** | **当前作者方案：不传 cwd** | 最小改动；容器内直接可用；注释清晰 | 隐式依赖 `process.cwd()`；**当前破坏 TS 编译**（Q2d）；本地 dev 模式下会误沾 axon 项目配置；注释不够准确 | **3★** |
| 2 | 传 cwd 但 existsSync 校验后只传存在的 | 保留 cwd 语义；不会误加载其他项目配置 | 校验发生在**容器里**，Hand 传的宿主路径必然 miss，等价于"始终不传" | 2★ |
| **3** | **映射到固定安全路径（如 `/tmp` 或 `os.tmpdir()`）** | 显式、可预测；本地和容器行为一致；不会加载任何项目配置；自文档化 | 需要决定到底用哪个路径；多了一行代码 | **★★★★★** |
| 4 | Hand 侧不发送宿主 cwd | 从源头消除路径不匹配 | 大改 protocol；违背"cwd 是会话业务语义"的设计；web/info 里 cwd 会退化 | 2★ |
| 5 | 从 BrainSession 彻底删除 cwd 字段 | 最干净 | SessionInfo 的 cwd 也要删，Hand/Web 可能会观察到变化；大改 | 2★ |
| 6 | 传 `additionalDirectories: [cwd]` 而非 `cwd: cwd` | 让 Claude 知道"逻辑项目目录"，但不影响 spawn cwd | 该目录在容器内依然不存在，--add-dir 也会校验存在性，估计同样报错 | 1★ |

### 最终推荐

**方案 3** (映射到 `os.tmpdir()` 或 `/tmp`)：

```ts
import os from "node:os";

const stream = this.queryRunner({
  prompt: text,
  options: {
    // cwd 不使用 Hand 传来的宿主路径(容器内不存在)。
    // 工具实际 cwd 由 Hand 侧 ToolExecutor 决定。这里给 SDK 一个
    // 确定存在的安全目录,避免隐式依赖 process.cwd() 和意外加载项目配置。
    cwd: os.tmpdir(),
    model: this.model,
    ...
  },
});
```

为什么它严格优于方案 1：
- **显式 > 隐式**：明确告诉 SDK "我知道我在给你一个不重要的 cwd"，而不是依赖 "Node spawn 默认行为 + Docker WORKDIR 恰好吻合" 这条脆弱链。
- **本地=容器**：macOS `/tmp`（实为 `/private/tmp`）和容器 `/tmp` 都必定存在且为空；行为一致。
- **不加载任何项目配置**：`/tmp` 下没人会放 `.claude/` 或 `CLAUDE.md`，彻底避免 Q2a 的隐患。
- **TS 安全**：不动 SessionQueryOptions 接口，不会破坏编译。
- 改动成本几乎等于方案 1，多一行 import。

### 当前作者方案在排序里的位置

第 **2** 位（仅次于方案 3）。作者方案**方向正确**（确实不该传宿主路径），但**执行细节不够严**：①没同步改接口导致 tsc 挂；②选择了最依赖上下文的路径（`process.cwd()` 默认行为）而不是显式安全路径。

---

## Q4: 注释准确性

**评级: CONCERN — 建议改**

### 原注释

```ts
// 此处故意不传 cwd:SDK 在容器内继承默认 WORKDIR,工具执行的 cwd 由 Hand 侧 ToolExecutor 决定
```

### 问题

1. **"SDK 在容器内继承默认 WORKDIR"的因果表述不准确**: 实际机制是 `child_process.spawn({cwd: undefined})` 回退到**父进程 `process.cwd()`**。"WORKDIR /app" 只是**恰好**让父进程 cwd 等于 `/app`。把机制说成"继承 WORKDIR"会让后续读代码的人以为 SDK 或 Docker 有什么魔法，实际没有。
2. **"容器内"假设误导**: axon 也可能以本地 dev 模式运行（非容器），注释完全没覆盖这种情况。
3. **"由 Hand 侧 ToolExecutor 决定"是对的**，但应该强调前半句只是"给 SDK 一个合法的占位 cwd"。

### 建议改法

如果采纳方案 3:
```ts
// SDK 不使用 Hand 传来的宿主路径(容器内不存在 → child_process.spawn ENOENT)。
// 工具实际 cwd 由 Hand 侧 ToolExecutor 决定;这里给 SDK 一个确定存在的
// 占位目录即可,避免隐式依赖 process.cwd() 以及误加载 CLAUDE.md/.claude 配置。
cwd: os.tmpdir(),
```

如果坚持方案 1（不传）:
```ts
// 故意不传 cwd。Hand 发来的是宿主路径,容器内不存在,会让 child_process.spawn
// 抛 ENOENT(并被 SDK 误报为 "Claude Code native binary not found")。
// 不传时 node 的 child_process.spawn 会回退到父进程 process.cwd():
//   - 容器内:Dockerfile WORKDIR=/app + docker-entrypoint exec,父进程 cwd=/app,存在。
//   - 本地 dev:继承启动 shell 的 cwd,需开发者自行确保。
// 工具实际 cwd 由 Hand 侧 ToolExecutor 决定,此处 cwd 只用于 SDK spawn claude 子进程。
```

### 结论

现有注释**不全对**，至少要把"继承 WORKDIR"改成"回退到父进程 process.cwd()"，并说明本地 dev 场景下的隐含约束。

---

## Q5: 测试覆盖充分性

**评级: CONCERN**

### 当前覆盖

- `session-flow.test.ts` 把断言改成 `cwd: undefined` — 这能验证 "runPrompt 没给 queryRunner 传 cwd"。
- `session-sdk-spawn.test.ts` 依然给 BrainSession 传了 `cwd: WORKDIR`，但整个测试**完全不关心**这个字段 — fake-claude 不读 cwd，断言也不检查。
- `session-routing.test.ts` / `session-resolve-executable.test.ts` / `e2e-hand.test.ts` 都不涉及 cwd 语义。

### 缺口

1. **没有测试证明"即便 Hand 传一个不存在的宿主路径，Brain 仍然能 spawn claude 成功"** — 这正是原 bug 要避免的现象。现在只是证明"没传 cwd 给 SDK"，但**没证明"没传 cwd 时 SDK 真的能起来"**。真实的 SDK spawn 测试 `session-sdk-spawn.test.ts` 在修改前后跑出来都是 pass，说明改动前和改动后都能跑，但两次 pass 的原因不一样：改动前是因为测试给了一个**真实存在的** `WORKDIR`，改动后是因为不传 cwd 后回退到了测试进程的 cwd。**真正的 regression 场景（Hand 传宿主路径）没覆盖**。
2. **没有测试验证 `BrainSession.cwd` 字段只用于 info/log，不用于 SDK** — 当前改动后该字段成了纯 bookkeeping，但没有测试防止后人"好心"把它再加回 queryRunner 调用。
3. **没有测试覆盖本地 dev 场景下的 cwd 行为** — 这也是 Q2a/Q2e 担忧的场景。

### 建议新增的测试

**必加**（推荐方案 3 后）:
```ts
test("runPrompt 给 SDK 的 cwd 是确定性安全路径(而非 Hand 宿主路径)", async () => {
  let capturedCwd: unknown;
  const session = BrainSession.createSession({
    id: "t1",
    cwd: "/Users/alice/some/host/path/does/not/exist/in/container",
    model: "claude-test",
    transport: { send: async () => {} },
    queryRunner: (input) => {
      capturedCwd = input.options.cwd;
      return (async function*() {
        yield { type: "result", result: "ok" };
      })();
    },
  });
  await session.prompt("hi");
  assert.notEqual(capturedCwd, "/Users/alice/some/host/path/does/not/exist/in/container");
  // 方案 3: 断言是 os.tmpdir()；方案 1: 断言是 undefined
  assert.equal(capturedCwd, os.tmpdir());  // or undefined
});
```

**可选**: 在 `session-sdk-spawn.test.ts` 中把 BrainSession 的 `cwd` 设为 `"/nonexistent/host/path"`，验证 SDK spawn 依然成功(原 bug 的最直接复现)。

### 结论

覆盖**不够充分**。只改一行断言不足以防止 regression。建议至少加一个"Hand 传不存在路径时 Brain 不传递给 SDK"的单元测试。

---

## Q6: Commit message 建议

### 方案 1 版本（假设作者坚持当前做法，但**必须**先修 SessionQueryOptions 接口）

```
🐛 修复 SDK 误传宿主 cwd 导致 spawn ENOENT / Drop host cwd when spawning Claude SDK

Hand 发送的 cwd 是宿主机绝对路径(如 /Users/xxx/project),Brain 在容器内把
该路径透传给 Claude Agent SDK 的 options.cwd,最终 child_process.spawn 以
不存在目录为 cwd,抛 ENOENT,被 SDK 误格式化为 "native binary not found"
的误导性错误。

修复思路:SDK 子进程的 cwd 对 axon 场景没有实际意义(所有 builtin 工具都
被 PreToolUse hook 拦截并改由 Hand 侧 ToolExecutor 以正确 cwd 执行),因此
不再把 Hand 的 cwd 传给 SDK,让 Node child_process.spawn 回退到父进程
process.cwd() —— 容器内由 Dockerfile WORKDIR 保证为 /app。

- session.ts: runPrompt 调用 queryRunner 时不再传 cwd,并同步将
  SessionQueryOptions.cwd 标记为 optional,避免破坏 tsc 编译。
- session-flow.test.ts: 断言 queryRunner 收到的 cwd 为 undefined。
- BrainSession.cwd 字段及 SessionInfo.cwd 保留供观测/日志使用,不影响
  SDK spawn 路径。

Refs: .claude/cwd-mapping-bug.md
```

### 方案 3 版本（如果采纳推荐的 `os.tmpdir()` 方案）

```
🐛 SDK cwd 改用安全占位路径修复 spawn ENOENT / Use safe placeholder cwd for SDK spawn

Hand 发送的 cwd 是宿主机绝对路径,Brain 容器内透传给 Claude Agent SDK 后
child_process.spawn 以不存在目录为 cwd 抛 ENOENT,并被 SDK 误报为 "native
binary not found"。

由于 axon 把所有 builtin 工具拦截到 Hand 侧 ToolExecutor 执行,SDK 子进程
的 cwd 对业务无意义,改为显式传入 os.tmpdir() 作为占位:

- 容器内外行为一致,不再依赖父进程 process.cwd()
- 避免本地 dev 模式下 Claude 子进程误加载 axon 项目的 .claude/settings.*
- 保持 SessionQueryOptions 类型稳定,不破坏 tsc 编译

BrainSession.cwd 字段保留用于 SessionInfo/日志观测,仅在 runPrompt 路径上
不再传给 SDK。

- session.ts: queryRunner options 改为 cwd=os.tmpdir(),注释说明原因
- session-flow.test.ts: 断言 queryRunner 收到的 cwd 为 os.tmpdir()
- 新增测试:验证 Hand 传入不存在宿主路径时 Brain 不会把它传给 SDK

Refs: .claude/cwd-mapping-bug.md
```

---

## 总结

- **是否可以 commit: NO（当前状态会挂 tsc / docker build）**
- **变成 YES 需要修的必改项**:
  1. **[blocker]** 修 `SessionQueryOptions` 接口把 `cwd: string` 改成 `cwd?: string`（或删除），否则 `npm run build` / docker build 会因 TS2741 失败。这是直接阻塞项。
  2. **[blocker]** 验证在真实 docker build 环境下 `tsc` 通过（重跑 `docker compose build axon-brain` 或本地 `npm run build --workspace server`）。
- **强烈建议改的点**:
  3. **[强建议]** 从方案 1（不传）换成方案 3（显式传 `os.tmpdir()`）。消除隐式依赖，本地 dev 和容器行为一致，几乎零成本。
  4. **[强建议]** 更新注释 — 现注释的"继承 WORKDIR"因果关系不准确，且没覆盖本地 dev 模式。
  5. **[强建议]** 新增一条测试，用"明显不存在的宿主路径"作为 BrainSession.cwd，断言 SDK 收到的 cwd 不会等于它。防止未来有人"好心"把 this.cwd 加回 queryRunner 调用。
- **可选**:
  6. 考虑在 `session-sdk-spawn.test.ts` 中把 WORKDIR 换成不存在的宿主路径字符串，真实复现原 bug。

### 核心结论一句话

**方向对了，但执行漏了 TS 接口同步（导致编译挂）、并且选择了隐式的 spawn 回退行为而不是显式的安全路径 —— 前者是 blocker，后者是可以顺手提升的鲁棒性问题。**
