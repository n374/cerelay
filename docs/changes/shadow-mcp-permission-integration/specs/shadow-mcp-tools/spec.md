# Spec Delta: shadow-mcp-tools

> 位置：`docs/changes/shadow-mcp-permission-integration/specs/shadow-mcp-tools/spec.md`
> 角色：本 change 对 `shadow-mcp-tools` capability 的**变更声明**。归档时合并到 `docs/specs/shadow-mcp-tools/spec.md`。
>
> Living spec 当前版本：[`docs/specs/shadow-mcp-tools/spec.md`](../../../../specs/shadow-mcp-tools/spec.md)（baseline 反向生成于 2026-05-05）。

## ADDED Requirements

### Requirement: Permission check before dispatch

The system MUST 在 cerelay-routed dispatcher 把 shadow tool 调用透传到 client 之前，先经 mini permission engine 评估（详见 capability `shadow-mcp-permission`）：

- `allow`：继续走原 dispatch 链路，`tool_result.is_error === false`
- `deny`：**不**派发，直接返回 `tool_result.is_error === true`，content 含拒绝原因
- `unmatched`：进入兜底链路（elicitation / 结构化 isError），由 `shadow-mcp-permission` capability 决定具体行为

permission check 必须发生在 cerelay-routed 进程**主进程**侧（即 `MCPIpcHost.dispatcher` 内），不能放在 routed 子进程，避免子进程持有完整规则集与 settings 内容。

#### Scenario: allow → 正常 dispatch

- **GIVEN** mini engine 对 `mcp__cerelay__bash` 调用 `git status` 返回 `allow`
- **WHEN** dispatcher 处理该调用
- **THEN** 经原 ToolRelay → ws → client 链路执行；`tool_result.is_error === false`

#### Scenario: deny → 阻断 dispatch

- **GIVEN** mini engine 返回 `deny`
- **WHEN** dispatcher 处理该调用
- **THEN** 不向 client 派发；返回 `tool_result.is_error === true`，content 含 `Permission denied: <reason>`；不污染 client routing 队列

#### Scenario: unmatched → 兜底链路

- **GIVEN** mini engine 返回 `unmatched`
- **WHEN** dispatcher 处理该调用
- **THEN** 移交 `shadow-mcp-permission` capability 的兜底链路（elicitation / isError）；最终结果由 capability 决定

#### Scenario: permission check 失败的 fail-closed 语义

- **GIVEN** mini engine 内部抛错（settings 解析异常等）
- **WHEN** dispatcher 处理任意调用
- **THEN** 返回 `tool_result.is_error === true`，content 含错误诊断；**不**默认放行（fail-closed）

---

## MODIFIED Requirements

### Requirement: Tool result 渲染契约

> **原版本**：[`docs/specs/shadow-mcp-tools/spec.md`](../../../../specs/shadow-mcp-tools/spec.md) 中的 `Tool result 渲染契约`

**新版本**：

The system SHALL 把 `dispatchToolToClient` 返回的结构化结果通过 `renderToolResultForClaude` 渲染成 MCP `tool_result.content`：

- 含 stdout / stderr 的（bash）：分别渲染 stdout / stderr block + exit_code
- 含 path 的（write / edit / multi_edit）：渲染 path
- 含 content 的（read）：纯文本输出
- 含 files 数组的（glob）：换行分隔字符串
- 含 matches 的（grep）：渲染为 `file:line:text`
- dispatcher 返回 error：`isError: true`，content 为 error 文本
- 空渲染：保持空字符串，**不补 `(empty)` 占位**
- ipc.callTool 抛错：收敛为 `isError: true`，不向 SDK 抛 raw stack
- **【新增】**permission deny / unmatched 触发 isError：content 必须遵循 `shadow-mcp-permission` capability 定义的文案模板，不是 raw error trace；fail-closed 内部错误返回独立诊断文案，与 deny / unmatched 区分

**变更要点**：

- 新增 permission deny / unmatched / fail-closed 三种 isError 触发原因
- 文案模板由 `shadow-mcp-permission` capability 定义（见其 `elicitation 不可用 → 结构化 isError 降级` Requirement）
- 三种触发原因在文案中**显式区分**（让用户能定位是规则缺失还是规则解析问题）

#### Scenario: permission deny 触发 isError 的渲染

- **WHEN** mini engine 返回 deny
- **THEN** content 以 `Permission denied:` 开头；不含原 dispatcher error trace；is_error: true

#### Scenario: 现有 dispatcher error 渲染保持不变

- **WHEN** dispatcher 因网络故障 / client 异常返回 error
- **THEN** 渲染为 dispatcher 原 error 文本，is_error: true（与原版本完全一致）

#### Scenario: 空渲染保持空字符串（保留原行为）

- **WHEN** dispatcher 返回空结果
- **THEN** content 保持空字符串，不补占位（与原版本完全一致）

**覆盖测试**（保留原有 + 新增）：

- 保留：`server/test/mcp-routed-handlers.test.ts::handler: dispatcher 返回 error 时 isError:true 且 content 为 error 文本`、`server/test/mcp-routed-handlers.test.ts::handler: 空渲染保持空字符串，不再补 (empty) 占位（Plan §4.6 要求）`、`server/test/mcp-routed-handlers.test.ts::handler: ipc.callTool 抛错时收敛为 isError:true，不向 SDK 抛出 raw stack`
- 新增（本 change 实现阶段补）：permission deny / unmatched / fail-closed 三种 isError 触发的渲染断言

---

### Requirement: 双路径 `is_error` 不变量

> **原版本**：[`docs/specs/shadow-mcp-tools/spec.md`](../../../../specs/shadow-mcp-tools/spec.md) 中的 `双路径 is_error 不变量`

**新版本**：

The system SHALL 在两条工具调用路径上分别保证以下不变量：

- **`mcp__cerelay__*` 路径成功 dispatch**：`tool_result.is_error === false`
- **`mcp__cerelay__*` 路径 permission deny / unmatched / fail-closed**：`tool_result.is_error === true`，由 `shadow-mcp-permission` capability 控制
- **legacy hook fallback 路径**：受 CC 协议硬约束，deny 分支必然 `tool_result.is_error === true`，不试图绕开

任何修改都必须保留 e2e 守护测试中的对应断言。

**变更要点**：

- 原版本说"`mcp__cerelay__*` 路径 is_error 必须为 false"
- 新版本细化为：**成功 dispatch** 才为 false；permission deny / unmatched / fail-closed 仍为 true（由 cerelay 显式控制，不是 CC 协议硬约束）
- e2e 守护测试中的"成功 dispatch is_error: false"断言保留；新增"permission deny → is_error: true"e2e 断言（在 e2e coverage 矩阵补 case）

#### Scenario: 成功 dispatch 时 is_error 为 false（保留）

- **GIVEN** PTY session 启动且 shadow MCP 已注入；命令命中 allow 规则
- **WHEN** CC 通过 `mcp__cerelay__bash` 调用一条命令
- **THEN** 返回的 `tool_result.is_error === false`，且 `content` 含命令输出

**覆盖测试**: `server/test/e2e-mcp-shadow-bash.test.ts::Plan D E2E real claude: mcp__cerelay__bash → tool_result.is_error 必须为 false`

#### Scenario: permission deny 时 is_error 为 true（新增）

- **GIVEN** mini engine 配置含 `Bash(rm -rf:*)` 在 deny
- **WHEN** CC 调 `mcp__cerelay__bash` `rm -rf /tmp/foo`
- **THEN** `tool_result.is_error === true`，content 以 `Permission denied:` 开头；不向 client 派发

**覆盖测试**（本 change 实现阶段补）：`server/test/e2e-mcp-shadow-bash.test.ts::permission deny → is_error: true 且不向 client 派发`（待实现）

#### Scenario: hook fallback 路径回注（保留）

- **GIVEN** shadow MCP 关闭（feature flag 显式 false）
- **WHEN** CC 通过 PreToolUse hook 触发 client 工具
- **THEN** 工具输出被回注到 LLM 的 `tool_result.content`，符合 hook 协议契约

**覆盖测试**: `server/test/e2e-real-claude-bash.test.ts::E2E real claude: PreToolUse hook 必须把 Client tool 输出回注到 LLM 的 tool_result.content`

---

## REMOVED Requirements

无。本 change 不移除任何现有 Requirement。

---

## 影响范围

- 本 delta **不引入**新的 shadow tool / 新协议字段 / 新隔离边界 / 新 cache 维度（按 e2e 三问审计：新引入 permission check 步骤本身是流程内补丁，不算新拓扑）
- e2e coverage 矩阵需要在本 change 实现阶段补两条 case：
  - `mcp__cerelay__bash` 命中 allow → is_error: false 且 dispatch 完成（已被现有 e2e 隐含覆盖）
  - `mcp__cerelay__bash` 命中 deny → is_error: true 且 client 未收到派发（**新增**）
