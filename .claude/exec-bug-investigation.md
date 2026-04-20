# Session executable/cwd 参数 bug 调查

## 1. 错误信息

用户执行 Prompt 时，收到来自 Claude Code SDK 的错误：

```
Claude Code native binary not found at /usr/local/bin/claude. Please ensure Claude Code is installed via native installer or specify a valid path with options.pathToClaudeCodeExecutable.
```

这意味着：
- SDK 接收到的 `pathToClaudeCodeExecutable` 被解析为 `/usr/local/bin/claude`
- 该路径不存在或不可执行
- 用户很可能将 Claude Code 安装在了其他位置（如 `/opt/homebrew/bin/claude` 或 `~/.claude/local/claude`）

## 2. 当前 session.ts 的解析逻辑

### 关键代码片段

**问题版本（已提交，fed6dff）**：
```typescript
// server/src/session.ts:L471-474
export function resolveClaudeCodeExecutable(env = process.env): string {
  const configured = env.CLAUDE_CODE_EXECUTABLE?.trim();
  return configured || DEFAULT_CLAUDE_CODE_EXECUTABLE;  // 默认返回 "/usr/local/bin/claude"
}
```

其中 `DEFAULT_CLAUDE_CODE_EXECUTABLE = "/usr/local/bin/claude"` (L14)

**新版本（未提交，未保存的修改）**：
```typescript
// server/src/session.ts (working directory):L471-485
export const CLAUDE_EXECUTABLE_CANDIDATES = [
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
  path.join(os.homedir(), ".claude/local/claude"),
];

export function resolveClaudeCodeExecutable(candidates = CLAUDE_EXECUTABLE_CANDIDATES, env = process.env): string {
  const configured = env.CLAUDE_CODE_EXECUTABLE?.trim();
  if (configured) {
    return configured;
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `Could not find Claude Code executable. Tried: ${candidates.join(", ")}. Set CLAUDE_CODE_EXECUTABLE env var or install via \`brew install --cask claude-code\`.`
  );
}
```

### 流程对比

| 阶段 | 问题版本（fed6dff） | 新版本（未提交）|
|------|------------------|-----------------|
| 环境变量检查 | ✓ 检查 `CLAUDE_CODE_EXECUTABLE` | ✓ 检查 `CLAUDE_CODE_EXECUTABLE` |
| 实际存在性检查 | ✗ **不检查** | ✓ 逐个检查候选路径是否存在 |
| 多候选位置支持 | ✗ 只有一个硬编码路径 | ✓ 支持三个常见位置 |
| 找不到时的行为 | 返回不存在的路径 | 抛出详细错误 |

### 关键调用点

**server/src/session.ts:L207, L216**
```typescript
this.log.debug("开始执行 prompt", {
  textLength: text.length,
  preview: previewText(text),
  claudeCodeExecutable: resolveClaudeCodeExecutable(),  // <-- 问题在这里
});

const stream = this.queryRunner({
  prompt: text,
  options: {
    cwd: this.cwd,
    model: this.model,
    pathToClaudeCodeExecutable: resolveClaudeCodeExecutable(),  // <-- 和这里
    // ...
  },
});
```

## 3. Hand 配置 schema

根据代码分析，**Hand 配置中不存在 executable 字段**。Hand 创建 Session 的流程如下：

**server/src/protocol.ts:L51-55**
```typescript
export interface CreateSession {
  type: "create_session";
  cwd: string;        // 用户可以指定 cwd
  model?: string;     // 用户可以指定 model
  // 注：没有 executable 字段
}
```

**hand/src/protocol.ts:L81-85**
```typescript
export interface CreateSession {
  type: "create_session";
  cwd: string;
  model?: string;
}
```

**server/src/server.ts:L544-576**
```typescript
private async handleCreateSession(handId: string, message: CreateSession): Promise<void> {
  // ...
  const session = BrainSession.createSession({
    id: sessionId,
    cwd: message.cwd || ".",                           // 从 Hand 请求中获取
    model: message.model || this.defaultModel,         // 从 Hand 请求中获取
    shouldRouteToolToHand: (toolName) => this.toolRouting.shouldRouteToHand(toolName),
    transport: { /* ... */ },
  });
  // 注：executable 不可配置，完全依赖 resolveClaudeCodeExecutable()
}
```

## 4. 复现路径

### 用户场景：
1. 用户系统上已安装 Claude Code，位置为 `/opt/homebrew/bin/claude`（或 `~/.claude/local/claude`）
2. 用户通过 Hand CLI 或 Web UI 创建 Session，指定某个 `cwd`（不涉及 executable 参数）
3. Hand 发送 `create_session` 消息到 Server

### Server 处理流程：
1. **server.ts:L544** - 收到 `create_session` 请求
2. **server.ts:L552-576** - 创建 BrainSession，传入 `cwd`（此时 executable 不可配置）
3. **session.ts:L196-251** - 用户发送 prompt
4. **session.ts:L207, L216** - 调用 `resolveClaudeCodeExecutable()`

### Bug 触发：
**问题版本（fed6dff）**：
```
resolveClaudeCodeExecutable()
  → 检查 CLAUDE_CODE_EXECUTABLE 环境变量
  → 环境变量未设置（或未在 Server 进程中设置）
  → 返回硬编码的 "/usr/local/bin/claude"（不检查是否存在）
  → 传给 SDK，SDK 报错：文件不存在
```

**假如用户设置了环境变量**：
```bash
export CLAUDE_CODE_EXECUTABLE="/opt/homebrew/bin/claude"
# 然后启动 Axon Server
```
此时流程会正确，因为环境变量被检查到了。

## 5. 根因判断

### 明确的设计缺陷

**fd6dff 提交中的 `resolveClaudeCodeExecutable()` 有两个致命缺陷：**

#### 缺陷1：路径硬编码，不检查存在性
- 问题版本直接返回 `/usr/local/bin/claude`，**从不检查该路径是否真实存在**
- 新版本改进：遍历候选列表，**仅返回实际存在的第一个**
- 证据：见上面的代码对比，问题版本缺少 `existsSync()` 调用

#### 缺陷2：候选路径不完整
- 问题版本只有一个候选：`/usr/local/bin/claude`
- 新版本支持三个位置：
  - `/opt/homebrew/bin/claude` （Homebrew M1/M2 macOS 标准）
  - `/usr/local/bin/claude` （Intel macOS、Linux）
  - `~/.claude/local/claude` （用户本地安装）
- 证据：sed diff 中新增了 `CLAUDE_EXECUTABLE_CANDIDATES` 数组

#### 缺陷3：不存在时的行为不友好
- 问题版本：返回不存在的路径，错误由 SDK 抛出（用户不知道是什么原因）
- 新版本：主动抛出详细错误，指出所有尝试的路径和解决方法

### 关键证据链

1. **代码审视**：问题版本 `resolveClaudeCodeExecutable()` 的实现（fedff:L471-474）
   - 没有 `existsSync()` 检查
   - 没有候选列表遍历
   - 硬编码返回单一路径

2. **测试覆盖**：
   - server/test/session-resolve-executable.test.ts (新增，未提交)
   - 三个测试用例验证环境变量优先、候选探测、错误消息完整性
   - 这些测试在问题版本中会失败

3. **根本原因**：
   - **设计错误**：`resolveClaudeCodeExecutable()` 的原始设计过于简化
   - **发布前未完成**：fed6dff commit message 提到"新增 resolveClaudeCodeExecutable()"，但实现不完整
   - **当前修复**：未提交的改动是对该函数的完整重写，已解决所有缺陷

## 6. 修复方向（仅方向，不写代码）

### 方案：采纳未提交的改动

1. **提交 session-resolve-executable.test.ts**
   - 包含三个测试用例，覆盖环境变量、候选路径检查、错误情况
   - 确保 `resolveClaudeCodeExecutable()` 行为符合预期

2. **更新 session.ts 中的 `resolveClaudeCodeExecutable()`**
   - 引入 `fs.existsSync()` 以检查路径存在性
   - 使用 `CLAUDE_EXECUTABLE_CANDIDATES` 数组而非硬编码
   - 在找不到可执行文件时抛出详细错误

3. **更新相关测试**
   - session-flow.test.ts：验证执行路径正确传递
   - session-sdk-spawn.test.ts：验证 SDK 收到有效的 executable 路径
   - session-routing.test.ts：验证工具路由与 executable 解析独立

4. **可选：支持 Hand 侧配置**（技术债）
   - 当前 `CreateSession` 协议不支持指定 executable
   - 如需支持，可扩展协议增加 `executable?: string` 字段
   - Server 侧 `handleCreateSession()` 接收后进行基准目录解析（相对于 cwd 或绝对路径）
   - 当前用户只能通过环境变量 `CLAUDE_CODE_EXECUTABLE` 全局配置

### 为什么不是 cwd 参数设计有问题

- ✓ cwd 参数工作正常，在 session.ts:L214、hand/src/executor.ts:L44 中正确传递和使用
- ✗ 问题不在 cwd，而在 executable 路径的**发现和验证逻辑**
- cwd 用于工具执行的相对路径基准，executable 用于 SDK 进程启动，两者独立无关

