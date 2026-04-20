# 未提交变更分析报告

生成时间：2026/04/07

---

## 一、变更全貌

### 已修改文件（8 个）

| 文件 | 变更规模 | 类型 |
|---|---|---|
| `server/src/session.ts` | +171/-30 | 功能增强 + 日志 |
| `server/src/server.ts` | +201/-? | 纯日志增强 |
| `server/src/relay.ts` | +34 | 纯日志增强 |
| `server/test/session-routing.test.ts` | +7/-1 | 补测试 |
| `docker-entrypoint.sh` | +35/-7 | 功能修复 |
| `docker-compose.yml` | +20/-8 | 配置优化 |
| `package.json` | +6/-1 | 脚本增加 |
| `README.md` | +123/-10 | 文档补全 |

### 未跟踪文件

| 路径 | 性质 |
|---|---|
| `.tmp-tests/` | 测试运行产物（临时目录）|
| `test/docker-entrypoint.test.mjs` | 新集成测试 |
| `test/package-scripts.test.mjs` | 新集成测试 |
| `server/test/session-flow.test.ts` | 新单元测试 |
| `server/test/session-sdk-spawn.test.ts` | 新集成测试 |

---

## 二、变更分组分析

### 组 A：Docker / 部署体验改善

**涉及文件：**
- `docker-compose.yml`
- `docker-entrypoint.sh`
- `package.json`（`brain:up/down/logs` 脚本）
- `README.md`（Docker 使用方式说明）

**做了什么：**

1. `docker-compose.yml`：
   - 去掉了强制依赖具名 volume（`claude_config`），改用宿主机 bind mount（`${CLAUDE_CONFIG_DIR:-${HOME}/.claude}`），支持用户直接复用本机 Claude Code 凭证，无需单独维护 Docker volume
   - `ANTHROPIC_API_KEY` 从必填改为可选（`${ANTHROPIC_API_KEY-}` 空字符串允许）
   - 新增 `LOG_LEVEL`、`LOG_JSON`、`CLAUDE_CODE_EXECUTABLE` 环境变量透传
   - 去掉了过时的 `version: "3.9"` 字段

2. `docker-entrypoint.sh`：
   - 去掉了强制校验 `ANTHROPIC_API_KEY` 的 `exit 1` 逻辑，改为检测挂载的 `~/.claude` 是否存在，两种方式都可以工作
   - `exec node ...` 改为通过变量组装参数，支持 `--log-level` 和 `--log-json` flag 传入
   - 新增 `CLAUDE_CODE_EXECUTABLE` 环境变量透传

3. `package.json`：新增 `brain:up`、`brain:down`、`brain:logs` 三个快捷脚本；`test` 脚本拆分为 `test:smoke + test:workspaces`

4. `README.md`：补充 Docker 部署作为主流程，本地直跑降级为可选；增加 Web UI 启动步骤说明

**完整度评估：** 完整自洽，逻辑改动闭合，无调试痕迹，无 TODO。

**对应测试：** `test/docker-entrypoint.test.mjs` 和 `test/package-scripts.test.mjs` 专门覆盖了 docker-entrypoint.sh 的新行为和 package.json 脚本验证（见下文组 D 分析）。

---

### 组 B：`resolveClaudeCodeExecutable` 功能 + 测试

**涉及文件：**
- `server/src/session.ts`（新增 `resolveClaudeCodeExecutable` 导出函数、`QueryRunner`/`SessionQueryOptions` 类型、`queryRunner` 依赖注入）
- `server/test/session-routing.test.ts`（补充 `resolveClaudeCodeExecutable` 测试用例）
- `server/test/session-flow.test.ts`（新增，验证 `pathToClaudeCodeExecutable` 传入 queryRunner）
- `server/test/session-sdk-spawn.test.ts`（新增，真实 SDK spawn 路径集成测试）

**做了什么：**

`session.ts` 核心变更：
- 新增 `resolveClaudeCodeExecutable(env?)` 函数（`session.ts:464`），从 `CLAUDE_CODE_EXECUTABLE` 环境变量读取，trim 后使用，fallback 到 `/usr/local/bin/claude`
- `SessionQueryOptions` 接口增加 `pathToClaudeCodeExecutable` 字段（`session.ts:74`），在 `runPrompt` 中传入 SDK
- `queryRunner` 依赖注入：`BrainSessionOptions` 新增可选 `queryRunner` 字段（`session.ts:100`），使测试可以注入 mock runner 替代真实 `query()`，同时保留 `runSdkQuery` 作为默认实现（`session.ts:938`）

`session-routing.test.ts` 增量（`session-routing.test.ts:34-37`）：覆盖 trim + fallback 行为

**完整度评估：** 完整。功能、单元测试、集成测试三层均有覆盖，逻辑闭合。

**注意：** `session.ts` 中 `previewText` 函数在 `session.ts` 和 `server.ts` 各定义了一份，存在重复实现。不过这是存量问题，不影响本次提交。

---

### 组 C：结构化 debug 日志增强

**涉及文件：**
- `server/src/relay.ts`（引入 logger，添加 debug/warn 日志）
- `server/src/server.ts`（大量 debug 日志，各路由/连接生命周期节点）
- `server/src/session.ts`（大量 debug 日志，prompt 生命周期节点）

**做了什么：**

纯日志增强，无任何业务逻辑变更：
- `relay.ts`：为 `createPending`/`resolve`/`reject`/`cleanup` 增加 debug 日志，记录 requestId、toolName、pending 计数
- `server.ts`：为 HTTP 请求、WebSocket 升级、Hand 连接/断开、消息处理、Session 生命周期的每个关键节点增加 debug 日志；增加两个辅助函数 `messageDebugFields`（`server.ts:802`）和 `previewText`（`server.ts:565`）
- `session.ts`：为 prompt 排队、runPrompt 执行、工具调用转发/结果回传的每个节点增加 debug 日志；`close()`、`handlePreToolUse`、`sendSessionEnd` 均有日志覆盖

`server.ts` 的一个有效 bug 修复混入了日志 diff：
```
// 原来（server.ts:136）：
if (!this.auth.verify(token)) {
// 改为：
const tokenId = this.auth.verify(token);
if (!tokenId) {
```
这个改动使 `tokenId` 可以用于后续日志上下文（`tokenId` 字段），是有实际意义的重构，但规模很小。

**完整度评估：** 完整。日志增强本身不需要配套测试（`LOG_LEVEL=debug` 才会触发），全部 debug 级别，不影响正常输出。

---

### 组 D：新集成测试文件

**涉及文件（均为未跟踪）：**
- `test/docker-entrypoint.test.mjs`
- `test/package-scripts.test.mjs`
- `server/test/session-flow.test.ts`
- `server/test/session-sdk-spawn.test.ts`

**各文件分析：**

#### `test/docker-entrypoint.test.mjs`

覆盖 `docker-entrypoint.sh` 的两个场景：带 `ANTHROPIC_API_KEY` 启动、不带 API key 但有挂载的 `~/.claude` 配置。测试逻辑完整，通过 sandbox（临时目录 + fake binary）隔离环境。

**问题：** `WORKDIR` 硬编码为 `/Users/n374/Documents/Code/axon`（`docker-entrypoint.test.mjs:8`）。换机器后测试会失败。建议改为 `path.resolve(import.meta.dirname, "..")`。

#### `test/package-scripts.test.mjs`

验证 `package.json` 中 `brain:up` 脚本包含必要的 `--force-recreate` 等 flag。逻辑完整，同样有 `WORKDIR` 硬编码问题（`package-scripts.test.mjs:6`）。

#### `server/test/session-flow.test.ts`

三个单元测试，覆盖：
1. `queryRunner` 接收到正确的 `pathToClaudeCodeExecutable`
2. 工具调用经 Hand 中转后完成
3. Claude runner 失败时转化为 `session_end` error

逻辑完整，无硬编码路径问题，可独立运行。

#### `server/test/session-sdk-spawn.test.ts`

通过写入一个 fake claude 可执行文件，测试真实的 SDK spawn 路径。测试逻辑较复杂，覆盖了 `CLAUDE_CODE_EXECUTABLE` 注入 + SDK 初始化握手 + hook callback + 工具调用完整链路。

**问题：** `WORKDIR` 硬编码为 `/Users/n374/Documents/Code/axon`（`session-sdk-spawn.test.ts:10`），用于 `cwd` 和期望的 stdout。换机器后断言 `${WORKDIR}\n` 会失败。

---

## 三、未跟踪目录：`.tmp-tests/`

`.tmp-tests/` 包含：
- `axon-fake-claude-*`（5 个目录）：每个内有 `fake-claude.mjs`，是 `session-sdk-spawn.test.ts` 运行时生成的临时可执行文件，对应 `mkdtemp(path.join(tmpdir(), "axon-fake-claude-"))` 调用——但 tmpdir 应该是系统 `/tmp`，这里出现在项目目录里说明有脚本把临时目录改到了项目内（可能是过去实验时硬编码的 tmpdir 路径残留）
- `exec-smoke`：一个 shell 脚本，是历史遗留的临时测试脚本

**结论：** `.tmp-tests/` 是测试运行产物，应当加入 `.gitignore`，不应提交。

---

## 四、分组提交建议

### ✅ 组 A — Docker 部署改善（建议提交）

**可提交原因：** 功能完整闭合，有配套测试（`test/` 目录），无调试痕迹。

**前置条件：** 同时提交 `test/` 目录的测试文件（去掉硬编码路径后），或在知情条件下接受硬编码路径（仅本机使用）。

**建议 commit message：**
```
🐳 优化 Docker 部署体验，支持复用宿主机 Claude 配置 / Improve Docker UX and support host Claude credential reuse
```

---

### ✅ 组 B — `resolveClaudeCodeExecutable` + queryRunner 依赖注入（建议提交）

**可提交原因：** 功能完整，三层测试均有覆盖，逻辑闭合。`session-flow.test.ts` 无硬编码路径问题，可一并提交。

**注意：** 此组变更与组 C（日志）在同一文件（`session.ts`）中混合，实际需要一起提交，或手工拆分 diff 后单独提交。如果选择合并提交，可与组 C 合为一个 commit。

**建议 commit message：**
```
⚙️ 支持 CLAUDE_CODE_EXECUTABLE 注入并重构 queryRunner 依赖 / Support CLAUDE_CODE_EXECUTABLE injection and refactor queryRunner DI
```

---

### ✅ 组 C — 结构化 debug 日志增强（建议提交）

**可提交原因：** 纯日志增强，无业务逻辑风险。`relay.ts`/`server.ts`/`session.ts` 的日志改动与组 B 的功能改动在 `session.ts` 中交织，建议与组 B 合并为一个 commit（按模块命名）。

**如与组 B 合并的 commit message：**
```
🪵 注入 claudeCode 可执行路径并补充结构化调试日志 / Inject claude executable path and add structured debug logs
```

---

### ⚠️ 组 D — 新测试文件（需先修复再提交）

**问题：**
- `test/docker-entrypoint.test.mjs:8`、`test/package-scripts.test.mjs:6`、`server/test/session-sdk-spawn.test.ts:10` 三处 `WORKDIR` 硬编码 `/Users/n374/Documents/Code/axon`
- 建议改为运行时动态推导：
  - `.mjs` 文件：`const WORKDIR = path.resolve(new URL(".", import.meta.url).pathname, "..")`
  - `.ts` 文件：`const WORKDIR = path.resolve(new URL(".", import.meta.url).pathname, "../..")`
- 修复后可一并提交

**`session-flow.test.ts`** 无此问题，可以直接提交。

---

## 五、需要先做的清理工作

### 1. `.tmp-tests/` 加入 `.gitignore`

`.tmp-tests/` 是测试产物，应在 `.gitignore` 中加入：
```
.tmp-tests/
```

### 2. `test/` 目录的 `WORKDIR` 硬编码问题

在提交 `test/` 目录的测试之前，应修复路径硬编码，使测试可在任意机器运行。

### 3. `server/test/session-sdk-spawn.test.ts` 的 `WORKDIR` 硬编码

同上，`server/test/session-sdk-spawn.test.ts:10` 需要将 `WORKDIR` 改为动态推导。

---

## 六、建议的提交顺序

| 顺序 | 内容 | 文件 | 状态 |
|---|---|---|---|
| 1 | 先修复 `WORKDIR` 硬编码 | test/*.test.mjs, session-sdk-spawn.test.ts | 需先改 |
| 2 | `.gitignore` 加入 `.tmp-tests/` | `.gitignore` | 直接提交 |
| 3 | Docker 改善 + 配套 test/ 测试 | docker-compose.yml, docker-entrypoint.sh, package.json, README.md, test/ | 一起提交 |
| 4 | executable 注入 + queryRunner DI + debug 日志 + session 测试 | server/src/*, server/test/session-*.test.ts | 一起提交 |
