# cwd 容器映射 bug 调查报告

## 1. 现象回顾

用户在 Hand 本地指定工作目录（例如 `/Users/n374/project`），Hand 通过 WebSocket 向 Server 发送 `create_session` 消息并携带该 cwd。Server 接收后在容器内启动 Claude 子进程。然而，Claude 子进程报告的实际工作目录是 `/app`（容器内部的默认工作目录），而非用户指定的本地目录。

当用户问"上一个层级有什么文件"时，Claude 返回容器根目录 `/` 的内容，包括 `.dockerenv` 标志文件，确认了进程实际运行在容器内 `/app` 目录。

**根本问题：** 用户指定的宿主机绝对路径（如 `/Users/n374/project`）被直接透传到容器内的 Claude Code SDK，但该路径在容器内根本不存在。SDK 作为可靠的默认行为，应该是回退到进程当前工作目录或给出错误；实际上似乎回退到了容器的 WORKDIR（`/app`）。

---

## 2. 架构链路图

```
┌─────────────────────────────────────────────────────────────────┐
│ 宿主机 (macOS / Linux)                                          │
│                                                                 │
│  Hand CLI                                                       │
│  ├─ options: cwd=/Users/n374/project (用户本地目录)             │
│  └─ send: { type: "create_session", cwd: "/Users/n374/project" }
│        │                                                         │
│        │ WebSocket                                              │
│        │                                                         │
│        ↓                                                         │
│  ┌─────────────────────────────────────────────────────────────┐
│  │ Server (TypeScript)                                         │
│  │ ├─ receive: CreateSession {cwd: "/Users/n374/project"}      │
│  │ └─ pass to BrainSession: {cwd: "/Users/n374/project"}       │
│  │        │                                                     │
│  │        ↓                                                     │
│  │  BrainSession.queryRunner({                                 │
│  │    options: {cwd: "/Users/n374/project", ...}               │
│  │  })                                                          │
│  │        │                                                     │
│  │        ↓                                                     │
│  │  SDK query() → Claude Code CLI                              │
│  │    (receives cwd="/Users/n374/project")                      │
│  │        │                                                     │
│  │        ↓ [PROBLEM: path doesn't exist in container]         │
│  │  Claude subprocess                                          │
│  │    actual cwd = ??? (either /app or error)                  │
│  └─────────────────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ 容器内部 (Docker)                                               │
│ WORKDIR: /app                                                   │
│ volumes:                                                         │
│   - ~/.claude → /home/node/.claude (认证凭证)                   │
│   - (no workspace mount!)                                       │
│                                                                 │
│ 结果: Claude cwd = /app (默认兜底 or SDK fallback)             │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. 代码证据

### 3.1 Docker 部署 / bind mount 配置

#### Dockerfile (Line 32)
```dockerfile
WORKDIR /app
```
**要点：** 容器的默认工作目录是 `/app`。

#### docker-compose.yml (Lines 39-44)
```yaml
volumes:
  - type: bind
    source: ${CLAUDE_CONFIG_DIR:-${HOME}/.claude}
    target: /home/node/.claude
  # 可选：挂载工作目录（Brain 执行工具时的默认 cwd）
  # - ./workspace:/workspace
```
**要点：**
1. 仅挂载了 `~/.claude`（认证凭证），这是 bind mount
2. 工作目录挂载被注释掉且是可选的（`# - ./workspace:/workspace`）
3. **没有任何机制来动态地将用户指定的 Hand 本地目录挂载到容器内**
4. `CLAUDE_CONFIG_DIR` 只用于 Claude 认证凭证，不用于工作目录

**关键发现：** docker-compose 配置根本不支持动态映射用户工作目录。这意味着用户在 Hand 指定的本地路径无法在容器内被访问。

---

### 3.2 Hand 端 cwd 采集和发送

#### hand/src/index.ts (Line 38)
```typescript
const cwd = cwdOverride ?? process.cwd();
```
**要点：** Hand 采集的 `cwd` 是宿主机的绝对路径（通过 `process.cwd()` 或 `--cwd` 选项）。

#### hand/src/client.ts (Lines 114-119)
```typescript
async sendCreateSession(cwd: string, model?: string): Promise<void> {
  const msg: CreateSession = {
    type: "create_session",
    cwd,  // ← 直接传入，未做任何映射
    model,
  };
  await this.writeJSON(msg);
```
**要点：**
1. 构建的消息中，`cwd` 就是宿主机绝对路径（例如 `/Users/n374/project`）
2. **没有任何路径转换或映射逻辑**
3. 直接序列化为 JSON 通过 WebSocket 发送到 Server

---

### 3.3 Server 端 handleCreateSession 处理

#### server/src/server.ts (Lines 544-554)
```typescript
private async handleCreateSession(handId: string, message: CreateSession): Promise<void> {
  log.debug("收到创建 Session 请求", {
    handId,
    cwd: message.cwd || ".",
    model: message.model || this.defaultModel,
  });
  const sessionId = `sess-${Date.now()}-${randomUUID()}`;

  const session = BrainSession.createSession({
    id: sessionId,
    cwd: message.cwd || ".",  // ← 原封不动透传
    model: message.model || this.defaultModel,
    // ...
```
**要点：**
1. Server 收到 Hand 发来的 `message.cwd`（宿主机路径，如 `/Users/n374/project`）
2. **原封不动地透传给 `BrainSession.createSession()`**，没有任何路径映射或验证
3. 如果为空，默认使用 `"."`（当前目录），但仍然是宿主机路径的逻辑

#### server/src/session.ts (Lines 129-132)
```typescript
private constructor(options: BrainSessionOptions) {
  this.id = options.id;
  this.cwd = options.cwd;  // ← 直接赋值，未做任何验证或映射
  this.model = options.model;
  this.transport = options.transport;
```
**要点：**
1. `BrainSession` 构造函数直接存储传入的 `cwd`，未做任何验证
2. **不检查路径是否存在，不做容器内映射**

---

### 3.4 session.ts 向 SDK 传 cwd 的位置

#### server/src/session.ts (Lines 211-226)
```typescript
private async runPrompt(text: string): Promise<void> {
  // ...
  try {
    const stream = this.queryRunner({
      prompt: text,
      options: {
        cwd: this.cwd,  // ← 这里直接传入存储的 cwd 值
        model: this.model,
        pathToClaudeCodeExecutable: resolveClaudeCodeExecutable(),
        permissionMode: "default",
        canUseTool: this.canUseTool,
        maxTurns: 100,
        hooks: { /* ... */ },
      },
    });
```
**要点：**
1. `this.queryRunner()` 调用会触发 `@anthropic-ai/claude-agent-sdk` 的 `query()` 函数
2. `options.cwd` 的值就是从 Hand 端原封不动传递过来的宿主机路径
3. **此时 cwd 是 `/Users/n374/project`（宿主机路径），但进程运行在容器内**

#### server/src/session.ts (Line 487)
```typescript
function runSdkQuery(input: QueryRunnerInput): AsyncIterable<QueryMessage> {
  return query(input as unknown as Parameters<typeof query>[0]) as AsyncIterable<QueryMessage>;
}
```
**要点：** 直接调用 SDK 的 `query()` 函数，没有路径处理或验证。

---

### 3.5 SDK 类型定义与默认行为

#### @anthropic-ai/claude-agent-sdk/sdk.d.ts (Lines 949-951)
```typescript
/**
 * Current working directory for the session. Defaults to `process.cwd()`.
 */
cwd?: string;
```
**要点：**
1. SDK 类型声明中，`cwd` 是可选参数
2. **如果不提供，默认使用 `process.cwd()`** - 此时进程的 cwd 就是容器的 WORKDIR（`/app`）
3. 如果提供了一个不存在的路径（如 `/Users/n374/project`），**SDK 的处理策略未明确**，但根据现象推断：
   - SDK 可能尝试 `chdir()` 到该路径，失败时回退到进程当前工作目录
   - 或者 SDK 根本没有验证路径存在性，而是让进程在 `process.cwd()`（即 `/app`）下运行

---

## 4. 链路串联：从 Hand 输入到 SDK 实际 cwd 的完整追踪

```
Step 1: 宿主机用户指定 cwd
  输入: /Users/n374/project  (本地 macOS 路径)
    ↓

Step 2: Hand CLI 采集并发送
  hand/src/index.ts:38   cwd = process.cwd() = "/Users/n374/project"
  hand/src/client.ts:117 sendCreateSession(cwd = "/Users/n374/project")
    ↓
  JSON 消息: { type: "create_session", cwd: "/Users/n374/project" }
    ↓ (WebSocket 传输)

Step 3: Server 端接收与处理
  server/src/server.ts:544 handleCreateSession(message: CreateSession)
  server/src/server.ts:554 BrainSession.createSession({cwd: "/Users/n374/project", ...})
    ↓ (无路径映射，原封不动透传)

Step 4: BrainSession 存储
  server/src/session.ts:131 this.cwd = "/Users/n374/project"
    ↓

Step 5: 运行 prompt 时调用 SDK
  server/src/session.ts:214 const stream = this.queryRunner({
    options: {
      cwd: "/Users/n374/project",  // ← 仍然是宿主机路径！
      ...
    }
  })
    ↓

Step 6: SDK 处理
  @anthropic-ai/claude-agent-sdk/sdk.d.ts:951
  SDK 接收到 cwd = "/Users/n374/project"
  
  在容器内 (process.cwd() = /app)，SDK 尝试：
    - 可能尝试 chdir("/Users/n374/project") → 失败（路径不存在）
    - 回退到 process.cwd() = "/app"
    OR
    - SDK 根本不检查，假设路径有效，claude CLI 子进程默认 cwd = /app
    ↓

Step 7: Claude 子进程实际 cwd
  cwd = /app  (容器的 WORKDIR，未被改变)
    ↓ (结果：用户看到 Claude 在 /app 工作)
```

---

## 5. 对关键问题的回答

### 问题 1: bind mount 把宿主机什么路径挂到容器什么路径？

**答：** 仅挂载了 `${HOME}/.claude` → `/home/node/.claude`（认证凭证目录）。
- **没有任何动态或固定的工作目录 bind mount**
- docker-compose.yml 中的工作目录挂载被注释掉：`# - ./workspace:/workspace`
- **用户指定的工作目录（如 `/Users/n374/project`）没有被挂载到容器内的任何地方**

**结论：** bind mount 策略不支持用户工作目录映射。

---

### 问题 2: Hand 发给 Server 的 cwd 是宿主机绝对路径、容器内路径、还是相对路径？

**答：** **宿主机绝对路径**
- hand/src/index.ts:38: `cwd = process.cwd()` 获取宿主机当前工作目录
- hand/src/client.ts:117: 直接将其传入 `CreateSession` 消息
- 例如：`/Users/n374/project`（macOS 路径）或 `/home/user/project`（Linux 路径）
- **没有任何转换或映射**

---

### 问题 3: Server 有没有做路径映射？如果没有，为什么？

**答：** **没有做任何路径映射**
- server/src/server.ts:554: `cwd: message.cwd || "."` 原封不动使用
- server/src/session.ts:131: `this.cwd = options.cwd` 直接赋值
- **没有检查路径是否存在、没有转换为容器内路径、没有验证**

**为什么没有做映射？**
1. **架构设计缺陷：** 协议设计时假设了宿主机路径和容器内路径是对齐的，但实际上：
   - Hand 运行在宿主机，获取宿主机路径
   - Server 运行在容器内，无法直接访问宿主机路径
   - 两端没有共识的路径映射表
   
2. **bind mount 策略不完整：** docker-compose 中只挂载了认证凭证，没有挂载工作目录，导致即使 Server 想要映射也无处可映射

3. **缺少设计文档：** 没有明确的"用户工作目录映射方案"，是使用固定 `/workspace` 还是环境变量控制，还是 Hand 端就应该发送容器内路径

---

### 问题 4: 当 Hand 传入 `/Users/n374/foo/bar` 到容器里的 Server，Server 又把它透传给 SDK 时，SDK 在 /app 容器里启动 claude 子进程的实际 cwd 会变成什么？

**答：** **cwd = /app** (或可能是错误)
- SDK 接收到 `cwd = "/Users/n374/foo/bar"`（一个在容器内不存在的路径）
- SDK 尝试使用该路径时，假设使用 `chdir()` 失败（路径不存在）
- **可能的行为：**
  1. SDK 捕获 `chdir()` 失败，回退到 `process.cwd()` = `/app`（容器的 WORKDIR）
  2. 或者 SDK 抛出错误，导致 session 创建失败
  3. 或者 SDK 忽略无效的 cwd，直接使用进程默认 cwd = `/app`

**从用户观察来看，第一种情况最可能**：Claude 在 `/app` 工作，能看到容器根目录 `/` 的内容（通过 `ls ../`）。

---

### 问题 5: 这个 bug 的最小根因是什么？应该修哪一环？

**答：** 有 **三个互相关联的根因**，都需要修复：

#### 根因 A：Docker 部署策略不完整（最直接的根因）
- **位置：** docker-compose.yml
- **问题：** 工作目录 bind mount 被注释掉，没有配置
- **为什么这是根因：** 即使 Server 想做路径映射，也无法将容器外的用户目录映射到容器内

#### 根因 B：Hand ↔ Server 协议缺乏路径映射的设计（设计缺陷）
- **位置：** 
  - hand/src/client.ts: 发送宿主机路径
  - server/src/server.ts: 接收但不做任何处理
- **问题：** 协议和实现都没有考虑 Hand（宿主机）和 Server（容器）的路径命名空间差异
- **为什么这是根因：** 即使配置了 bind mount，Server 也不知道应该如何将宿主机路径映射到容器内路径

#### 根因 C：Server 缺少路径验证和错误处理（容错不足）
- **位置：** server/src/session.ts
- **问题：** 接收的 cwd 未经验证就直接传给 SDK，不检查路径是否存在
- **为什么这是根因：** 如果 cwd 无效，应该立即失败而不是回退到默认值，导致用户困惑

#### 优先级修复顺序：

**第一步（部署层）：** 启用工作目录 bind mount
- 修改 docker-compose.yml，从某个固定目录（如 `/workspace`）或环境变量指定的目录开始
- 缺点：仍然只能映射一个固定目录，多个用户 Hand 会有冲突

**第二步（协议层 → 需要架构决策）：**
选择以下方案之一：
  a. **方案 A - 固定工作区（简单但不灵活）**
     - Server 总是使用容器内固定路径（如 `/workspace`）
     - Hand 在启动时需要告诉 Server 本地目录，Server 不使用 Hand 的 cwd
  
  b. **方案 B - 环境变量映射（中等复杂度）**
     - Hand 将本地工作目录路径传给 Server
     - docker-compose 通过 `-v /user/path:/workspace` 动态挂载
     - Server 统一使用 `/workspace` 作为 cwd
  
  c. **方案 C - 动态 bind mount（复杂但最灵活）**
     - Server 启动时接收宿主机路径列表，通过 Docker API 动态挂载
     - Server 维护宿主机路径 ↔ 容器路径的映射表
     - 需要 Server 有 Docker socket 访问权限

**第三步（容错层）：**
- Server 应该在 cwd 不存在时立即报错，而不是默默回退
- 添加路径验证逻辑，在 BrainSession 构造时检查 cwd 是否可访问

---

## 6. 根因判断

### 最可疑的是（从现象反推）：

1. **最直接：** docker-compose.yml 中没有启用工作目录挂载
   - 证据：工作目录 bind mount 被注释掉，只有 `.claude` 被挂载
   - 影响：宿主机用户目录根本不可能在容器内被访问

2. **次级：** Hand ↔ Server 协议/实现没有考虑跨命名空间的路径映射
   - 证据：
     - hand/src/client.ts:117 直接发送宿主机路径，无转换
     - server/src/server.ts:554 原封不动接收，无验证或映射
   - 影响：即使配置了 bind mount，Server 也不知道如何利用

3. **更深层：** SDK 的 cwd 参数验证不足
   - 证据：SDK 接收无效 cwd 时，悄悄回退到 process.cwd()（`/app`），不报错
   - 影响：用户得到的是沉默的失败，而不是明确的错误信息

### 最小根因（最上游的问题）：
**架构设计时未明确定义 Hand（宿主机）和 Server（容器）之间的工作目录映射策略。**

这导致：
- docker-compose 没有配置 bind mount
- 协议没有定义映射表
- 代码没有验证和错误处理

---

## 7. 修复方向（不写代码，只列候选方案，带 trade-off）

### 方案 A：启用固定工作区（Workspace）
**原理：** Server 总是在容器内的固定目录（如 `/workspace`）工作，Hand 的本地路径被挂载到该位置

**步骤：**
1. docker-compose.yml：启用 `- ./workspace:/workspace` 或 `-v ${WORKSPACE_DIR}:/workspace`
2. server/src/server.ts：忽略 Hand 发来的 cwd，总是使用 `/workspace`
3. hand/src/ 可选：提示用户需要指定或使用默认工作目录

**优点：**
- 简单，无需复杂的路径映射逻辑
- 每个 Hand 连接时明确指定本地目录即可

**缺点：**
- 不灵活：同时只能有一个工作目录被挂载
- Hand 侧本地目录选择受限
- 多用户场景需要重启容器或使用不同实例

**Trade-off：** 优先适合单用户或 Docker Compose 场景

---

### 方案 B：Hand 本地路径 → 环境变量 → Server 映射
**原理：** Hand 启动时通过环境变量或配置告诉 Server 本地工作目录，Server 在容器内使用映射后的路径

**步骤：**
1. docker-compose.yml：支持环境变量 `HAND_LOCAL_DIR`，挂载到 `/app/hand-workspace`
2. hand/src/index.ts：启动时发送 `{ handId, localDir: process.cwd() }`
3. server/src/server.ts：
   - 维护 Hand ID → 容器内路径的映射表
   - 当收到 create_session 时，查表替换 cwd
   - 例如：`/Users/n374/project` → `/app/hand-workspace/project`

**优点：**
- 相对灵活，支持多个 Hand 连接
- 映射逻辑集中在 Server
- 向后兼容性好

**缺点：**
- 需要维护 Hand ↔ 映射的生命周期（Hand 连接/断开时清理）
- 容器内需要提前知道映射目标目录
- 目录结构受限（无法访问容器外的任意目录）

**Trade-off：** 适合小规模 Hand 连接，适合开发/测试场景

---

### 方案 C：Server 动态 bind mount（高级，需要 Docker API）
**原理：** Server 运行时通过 Docker API 动态挂载 Hand 本地目录到容器

**步骤：**
1. docker-compose.yml：提供 Docker socket 访问权限 `-v /var/run/docker.sock:/var/run/docker.sock`
2. server/src/：实现 Docker API 客户端，在收到 create_session 时动态挂载
3. hand/src/client.ts：发送本地目录路径和唯一标识（handId）
4. server/src/server.ts：
   - 调用 Docker API 挂载 `handId:/workspace`
   - 维护映射表：handId → `/workspace`
   - 返回容器内路径给 BrainSession

**优点：**
- 完全灵活，每个 Hand 都能挂载独立的目录
- 容器路径完全由 Server 控制，无需预先配置
- 支持并发多用户

**缺点：**
- 复杂度最高，需要错误处理和清理逻辑
- 容器需要 Docker daemon 访问权限（安全隐患）
- 依赖 Docker API 可用性
- 挂载/卸载有延迟，不适合频繁创建销毁 session

**Trade-off：** 适合生产环境、多租户场景，但增加了运维复杂度和安全风险

---

### 推荐修复方案

**短期（最小化修复）：** 方案 A + 错误处理
1. docker-compose.yml：取消注释工作目录 bind mount
2. server/src/session.ts：添加 cwd 存在性验证，不存在时立即报错
3. 文档：明确说明用户需要在 Hand 启动前配置工作目录

**中期（更好的体验）：** 方案 B
1. 支持环境变量 `HAND_WORKSPACE_DIR` 传入
2. Server 维护映射表
3. 协议扩展：`create_session` 消息中添加 `localPath` 字段（原 cwd 字段作为兼容）

**长期（最灵活）：** 方案 C
1. 实现 Docker API 客户端库
2. 动态挂载与映射管理
3. 支持并发多 Hand 场景

---

## 总结

**Bug 根因链：**
```
容器无法访问宿主机目录
       ↑
  docker-compose 没启用工作目录 bind mount
       ↑
  设计时未明确跨命名空间路径映射策略
       ↑
  Hand 和 Server 没有路径映射协议
```

**最小修复：** 启用 docker-compose 中的工作目录 bind mount + Server 添加 cwd 验证

**建议方向：** 先采用方案 A（简单），根据需求逐步升级到方案 B 或 C（灵活）

