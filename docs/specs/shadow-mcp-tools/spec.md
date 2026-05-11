<!-- doc-init template version: v1.0 -->
# Capability: shadow-mcp-tools

> **Owner**: server 架构组
> **Reviewers**: 全员（涉及双路径不变量与协议硬约束，修改 living spec 必须经 change archive 阶段）

> 位置：`docs/specs/shadow-mcp-tools/spec.md`
> 角色：本 capability 的 **living spec**（source of truth）。**只在归档阶段被修改**。
> 历史变更可在 [`../../archive/`](../../archive/) 中追溯。
>
> **Baseline 反向生成**于 2026-05-05，代码版本 `54f69d3`，由 change `baseline-shadow-mcp-clientcache` 产生（已归档于 [`../../archive/2026-05-05-baseline-shadow-mcp-clientcache/`](../../archive/2026-05-05-baseline-shadow-mcp-clientcache/)）。

## 概述

Shadow MCP Tools（俗称 Plan D）的目的：把 CC 内置工具（Bash / Read / Write / Edit / MultiEdit / Glob / Grep）以 MCP 工具的形式重新暴露给 Claude Code，绕开 CC PreToolUse hook 协议下 deny 分支必然 `tool_result.is_error: true` 的硬约束。模型看到的工具结果 `is_error` 由 cerelay 显式控制。

每个 PTY session 启动时，cerelay 在 spawn `claude` CLI 子进程之前注入：

- **Routed dispatcher**：CC 通过 stdio JSON-RPC 与 cerelay-routed 子进程对话，子进程通过 unix socket 反向把 `tools/call` 派发回 cerelay 主进程，最终由 ToolRelay → WebSocket → Client 完成本机执行。
- **CLI flags**：`--mcp-config <inline JSON>`、`--append-system-prompt <steering>`、`--disallowedTools "Bash,Read,Write,Edit,MultiEdit,Glob,Grep"`。
- **Hook fallback**：当 shadow MCP 未启用 / 模型违规调用了被 disallowed 的内置工具时，PreToolUse hook 仍然兜底，并向模型返回结构化引导文案让其改用 `mcp__cerelay__*`。

**对外暴露**：

- 7 个 fully-qualified MCP tool name：`mcp__cerelay__{bash,read,write,edit,multi_edit,glob,grep}`
- 1 个环境变量：`CERELAY_ENABLE_SHADOW_MCP`（默认 true）
- 1 个环境变量：`CERELAY_SHADOW_MCP_SOCKET_DIR`（默认 `${CERELAY_DATA_DIR}/sockets/`，缺省兜底 `/tmp`）

**内部依赖的其他 capability**：

- `client-routed-tools`（待 baseline 反向生成）：Bash/Read/Write/Edit/MultiEdit/Glob/Grep 在 Client 侧的本机执行链路；shadow MCP 把派发结果交给 client-routed dispatch 复用同一条链路。
- `pty-session`（待 baseline 反向生成）：每个 PTY session 启动时挂接 MCPIpcHost、追加 CLI flags、close 时按序清理。

## Requirements

### Requirement: Shadow tool 名与字段必须与 Client 内置工具严格对齐

The system MUST 维护 7 个 shadow tool（`bash` / `read` / `write` / `edit` / `multi_edit` / `glob` / `grep`），每个 shadow tool 的 fully-qualified name 为 `mcp__cerelay__<short>`，其入参 schema 字段集合**严格匹配** `client/src/tools/{fs,bash,search}.ts` 实际接受的字段，不允许字段漂移。

#### Scenario: 7 个 shadow tool 完整存在且名字唯一

- **WHEN** 加载 `SHADOW_TOOLS` 集合
- **THEN** 长度等于 7，每个条目的 `shortName` 与 `builtinName` 一一对应；`shortName` 在集合内唯一

**覆盖测试**: `server/test/mcp-routed-schemas.test.ts::SHADOW_TOOLS 包含 7 个工具，shortName/builtinName 一一对应`、`server/test/mcp-routed-schemas.test.ts::SHADOW_TOOLS shortName 唯一`、`server/test/mcp-cc-injection.test.ts::SHADOWED_BUILTIN_TOOLS 含 7 个 CC 内置工具名`

#### Scenario: schema 防字段漂移

- **WHEN** 检查每个 shadow tool 的 JSON Schema
- **THEN** schema 顶层 `type === "object"` 且 `additionalProperties === false`；字段集合与对应 client builtin 实现一致；`bash.timeout` 描述含 `seconds`；`read.offset/limit` 描述含 `character`；`multi_edit.edits[*]` 不暴露 `replace_all`

**覆盖测试**: `server/test/mcp-routed-schemas.test.ts::每个 schema 必须 type:object + additionalProperties:false（防字段漂移）`、`server/test/mcp-routed-schemas.test.ts::每个 shadow tool 的字段必须严格匹配 client/src/tools 实际接受的字段`、`server/test/mcp-routed-schemas.test.ts::bash.timeout 描述包含 'seconds'`、`server/test/mcp-routed-schemas.test.ts::read.offset/limit 描述包含 'character'`、`server/test/mcp-routed-schemas.test.ts::multi_edit edits[*] 不暴露 replace_all`

#### Scenario: 名字前缀辨识

- **WHEN** 调用 `isCerelayShadowToolName` / `fullyQualifiedShadowToolName`
- **THEN** 仅匹配 `mcp__cerelay__*` 前缀；fully-qualified 名拼接结果与 `SHADOW_TOOL_NAME_PREFIX` 一致；同时被 `isMcpToolName` 视为 MCP 工具

**覆盖测试**: `server/test/mcp-routed-schemas.test.ts::fullyQualifiedShadowToolName: 加 mcp__cerelay__ 前缀`、`server/test/mcp-routed-schemas.test.ts::isCerelayShadowToolName: 仅匹配 mcp__cerelay__* 前缀`、`server/test/mcp-routed-schemas.test.ts::fully-qualified shadow tool 名仍然被 isMcpToolName 视为 MCP 工具`

---

### Requirement: PTY session 启动时必须注入 shadow MCP

The system MUST 在每个 PTY session spawn `claude` CLI 之前，启动 per-session MCPIpcHost 并向 CC 追加三组 CLI flags（`--mcp-config <inline JSON>` / `--append-system-prompt <steering>` / `--disallowedTools <7 个 builtin>`），让 CC 启动后通过 stdio JSON-RPC 与 cerelay-routed 子进程对接。

#### Scenario: 注入的 mcp-config 含 cerelay server + env 三件套

- **WHEN** 调用 `buildMcpConfigJson(launchSpec)`
- **THEN** 输出 JSON 含 `cerelay` MCP server 条目；条目内含 socket path、token、sessionId 三件套 env；`launchSpec` 可注入

**覆盖测试**: `server/test/mcp-cc-injection.test.ts::buildMcpConfigJson 含 cerelay server、env 三件套、可注入 launchSpec`

#### Scenario: steering prompt 含 7 个 builtin → shadow 映射

- **WHEN** 调用 `buildSteeringPrompt()`
- **THEN** 输出 prompt 含 7 个 builtin 工具名到 `mcp__cerelay__*` 的对照映射，并以 append 风格标签结尾

**覆盖测试**: `server/test/mcp-cc-injection.test.ts::buildSteeringPrompt 含 7 个 builtin → mcp__cerelay__ 映射 + append 风格标签`

#### Scenario: 默认不注入 --allowedTools，oneShot=true 时才注入

- **WHEN** 调用 `buildShadowMcpInjectionArgs()`，参数 `oneShot=false`
- **THEN** 输出 args 不含 `--allowedTools`（保护交互模式权限询问）
- **WHEN** 同上但 `oneShot=true`
- **THEN** 输出 args 追加 `--allowedTools` 覆盖所有 7 个 shadow tool

**覆盖测试**: `server/test/mcp-cc-injection.test.ts::buildShadowMcpInjectionArgs 默认不注入 --allowedTools（保护交互模式权限询问）`、`server/test/mcp-cc-injection.test.ts::buildShadowMcpInjectionArgs 在 oneShot=true 时追加 --allowedTools 覆盖所有 shadow tool`

#### Scenario: dev 环境用 tsx loader 形式 launch

- **WHEN** 在 dev 环境（仅有 .ts 源文件）调用 `resolveShadowMcpLaunchSpec`
- **THEN** 返回 tsx loader 形式的 launchSpec

**覆盖测试**: `server/test/mcp-cc-injection.test.ts::resolveShadowMcpLaunchSpec 在 dev 环境（仅有 .ts）返回 tsx loader 形式`

---

### Requirement: 双路径 `is_error` 不变量

The system SHALL 在两条工具调用路径上分别保证以下不变量：

- **`mcp__cerelay__*` 路径**：`tool_result.is_error === false`
- **legacy hook fallback 路径**：受 CC 协议硬约束，deny 分支必然 `tool_result.is_error === true`，不试图绕开

任何修改都必须保留 e2e 守护测试中两条断言。

#### Scenario: shadow 路径成功调用 bash 时 is_error 为 false

- **GIVEN** PTY session 启动且 shadow MCP 已注入
- **WHEN** CC 通过 `mcp__cerelay__bash` 调用一条命令
- **THEN** 返回的 `tool_result.is_error === false`，且 `content` 含命令输出

**覆盖测试**: `server/test/e2e-mcp-shadow-bash.test.ts::Plan D E2E real claude: mcp__cerelay__bash → tool_result.is_error 必须为 false`

#### Scenario: hook fallback 路径下 PreToolUse 仍然把 client tool 输出回注

- **GIVEN** shadow MCP 关闭（feature flag 显式 false）
- **WHEN** CC 通过 PreToolUse hook 触发 client 工具
- **THEN** 工具输出被回注到 LLM 的 `tool_result.content`，符合 hook 协议契约

**覆盖测试**: `server/test/e2e-real-claude-bash.test.ts::E2E real claude: PreToolUse hook 必须把 Client tool 输出回注到 LLM 的 tool_result.content`

---

### Requirement: Tool routing 互斥

The system MUST 把 `mcp__cerelay__*` 视为 shadow MCP 路径，**不**视为 client-routed，避免双重执行；其他 `mcp__<other>__*` 工具仍然走 client routing（兼容用户自配 MCP server）。

#### Scenario: shadow tool 在 hook 路径直接 allow，不进 client 转发

- **GIVEN** PreToolUse hook 收到 `mcp__cerelay__bash`
- **WHEN** 进入 `handleInjectedPreToolUse`
- **THEN** 直接 allow，不发起 client 转发

**覆盖测试**: `server/test/pty-shadow-mcp.test.ts::Phase 3: handleInjectedPreToolUse 收到 mcp__cerelay__bash 直接 allow，不进 client 转发`

#### Scenario: 用户自配 mcp__user__* 仍走 client 转发

- **GIVEN** 用户配置了 `mcp__user__foo` 工具
- **WHEN** PreToolUse hook 收到该工具调用
- **THEN** 走 client 转发链路，**不**被 shadow 排除规则误伤

**覆盖测试**: `server/test/pty-shadow-mcp.test.ts::Phase 3: 用户自配 mcp__user__* 仍然走 client 转发（不被 shadow 排除规则误伤）`

#### Scenario: dispatch 路径与 hook 路径 requestId 前缀互斥

- **WHEN** shadow MCP dispatch 链路给 client tool 转发请求
- **THEN** requestId 用 `mcp-` 前缀；hook 路径用 `hook-` 前缀；两者不冲突

**覆盖测试**: `server/test/pty-shadow-mcp.test.ts::Phase 3: dispatch 路径 requestId 用 mcp- 前缀，跟 hook- 前缀区分`

---

### Requirement: Fallback 引导文案

The system SHALL 在 shadow MCP 启用且模型违反 disallowed 约束调用 builtin 工具时，PreToolUse hook 返回 deny + 引导文案，文案必须含正确的 `mcp__cerelay__<对应名>` 提示。当 shadow MCP 未启用时，hook 路径不返回引导文案，沿用旧的 client 转发逻辑。

#### Scenario: 模型违规调 Bash → hook deny + 引导改用 mcp__cerelay__bash

- **GIVEN** shadow MCP 已启用，CC `--disallowedTools` 含 `Bash`
- **WHEN** 模型仍调用 `Bash`
- **THEN** hook 返回 deny，reason 文案含 `Tool 'Bash' is not available... Use mcp__cerelay__bash instead...`

**覆盖测试**: `server/test/pty-shadow-mcp.test.ts::Phase 4: shadow MCP 启用 + 模型违规调内置 Bash → hook deny + 引导改用 mcp__cerelay__bash`

#### Scenario: 7 个 shadowed builtin 都触发引导文案

- **WHEN** 7 个 shadowed builtin 中任意一个被违规调用
- **THEN** hook 返回的引导文案对应正确的 `mcp__cerelay__*` 名

**覆盖测试**: `server/test/pty-shadow-mcp.test.ts::Phase 4: 7 个 shadowed builtin 都触发引导文案`、`server/test/mcp-cc-injection.test.ts::buildShadowFallbackReason: 7 个 builtin → 引导文案含正确 mcp__cerelay__*`

#### Scenario: 不在 shadow 范围的工具不被引导

- **WHEN** 调用 `buildShadowFallbackReason(toolName)`，`toolName` 不在 shadow 范围
- **THEN** 返回 null

**覆盖测试**: `server/test/mcp-cc-injection.test.ts::buildShadowFallbackReason: 不在 shadow 范围的工具返回 null`

#### Scenario: shadow MCP 未启用时 hook 不引导

- **GIVEN** shadow MCP feature flag 显式关闭
- **WHEN** PreToolUse hook 收到 builtin 工具调用
- **THEN** 走旧的 client 转发逻辑，不返回引导文案

**覆盖测试**: `server/test/pty-shadow-mcp.test.ts::Phase 4: shadow MCP 未启用时 hook 路径仍走旧的 client 转发逻辑（不引导）`

---

### Requirement: Feature flag 与 socket 路径

The system SHALL 通过环境变量 `CERELAY_ENABLE_SHADOW_MCP` 控制 shadow MCP 是否启用，**默认 true**，仅显式 `false` / `0` / `no` / `off`（大小写不敏感）可关闭。Unix socket 父目录通过 `CERELAY_SHADOW_MCP_SOCKET_DIR` 配置，**默认 `${CERELAY_DATA_DIR}/sockets/`**，缺省兜底 `/tmp`。

#### Scenario: env 解析仅在显式关闭时为 false

- **WHEN** `CERELAY_ENABLE_SHADOW_MCP` 取值 `"false" | "0" | "no" | "off"`（大小写不敏感）
- **THEN** shadow MCP 被关闭
- **WHEN** 取值未设置 / 空 / 其他任意字符串
- **THEN** shadow MCP 保持默认启用

**覆盖测试**: `server/test/pty-shadow-mcp.test.ts::Phase 6: CERELAY_ENABLE_SHADOW_MCP env 解析（默认 true，仅显式 0/false/no/off 关）`

#### Scenario: socket path sha256 截短 sessionId 防 sun_path 溢出

- **WHEN** 调用 `buildMcpIpcSocketPath(sessionId, rootDir)`
- **THEN** 用 sha256 截短 sessionId 拼接到 rootDir 下，总长度 ≤ macOS `MAX_UNIX_SOCKET_PATH_LENGTH`；`rootDir` 过长时直接抛错防溢出

**覆盖测试**: `server/test/mcp-ipc-host.test.ts::buildMcpIpcSocketPath 用 sha256 截短 sessionId，总长度 ≤ MAX_UNIX_SOCKET_PATH_LENGTH（macOS 安全）`、`server/test/mcp-ipc-host.test.ts::buildMcpIpcSocketPath rootDir 过长时抛错（防 sun_path 溢出）`

---

### Requirement: MCPIpcHost 握手与隔离

The system MUST 在 cerelay-routed 子进程接入 MCPIpcHost 时强制执行三项约束：

1. **必须先握手再接 tool_call**：未完成 hello 握手的连接发 `tool_call` 直接拒绝
2. **token 必须匹配**：握手 token 与 host 配置不一致时拒绝连接
3. **同时只允许一个活跃 child**：并发连接时拒绝后来的，避免一份 session 派出多个 routed 子进程

#### Scenario: 握手成功后才接 tool_call

- **WHEN** child 完成 hello 握手后发 `tool_call`
- **THEN** dispatcher 收到调用并响应；未握手就发 `tool_call` 时连接被拒绝

**覆盖测试**: `server/test/mcp-ipc-host.test.ts::MCPIpcHost hello 握手成功后才接受 tool_call`、`server/test/mcp-ipc-host.test.ts::MCPIpcHost 拒绝未握手即发 tool_call 的连接`

#### Scenario: token 错误拒绝

- **WHEN** child 用错误 token 握手
- **THEN** host 立即拒绝连接

**覆盖测试**: `server/test/mcp-ipc-host.test.ts::MCPIpcHost token 错误会拒绝连接`

#### Scenario: 拒绝并发 child

- **GIVEN** 已有一个 routed child 在线
- **WHEN** 第二个 child 同时接入
- **THEN** 第二个连接被拒绝

**覆盖测试**: `server/test/mcp-ipc-host.test.ts::MCPIpcHost 拒绝并发连接（同时只允许一个活跃 child）`

#### Scenario: dispatcher 抛错时回 error 响应

- **WHEN** host 内部 dispatcher 抛出异常
- **THEN** 向 child 回 error 响应（而不是连接 hang 死）

**覆盖测试**: `server/test/mcp-ipc-host.test.ts::MCPIpcHost dispatcher 抛错时回 error 响应`

---

### Requirement: Tool result 渲染契约

The system SHALL 把 `dispatchToolToClient` 返回的结构化结果通过 `renderToolResultForClaude` 渲染成 MCP `tool_result.content`：

- 含 stdout / stderr 的（bash）：分别渲染 stdout / stderr block + exit_code
- 含 path 的（write / edit / multi_edit）：渲染 path
- 含 content 的（read）：纯文本输出
- 含 files 数组的（glob）：换行分隔字符串
- 含 matches 的（grep）：渲染为 `file:line:text`
- dispatcher 返回 error：`isError: true`，content 为 error 文本
- 空渲染：保持空字符串，**不补 `(empty)` 占位**（Plan §4.6 要求）
- ipc.callTool 抛错：收敛为 `isError: true`，不向 SDK 抛 raw stack

#### Scenario: bash handler 渲染 stdout / stderr / exit_code

- **WHEN** bash handler 收到 dispatcher 返回 `{stdout, stderr, exit_code}`
- **THEN** 输出渲染含 stdout / stderr / exit_code 三个块；stderr 非空时也渲染 stderr block

**覆盖测试**: `server/test/mcp-routed-handlers.test.ts::bash handler: input 透传、output 走 renderToolResultForClaude（含 stdout/stderr/exit_code）`、`server/test/mcp-routed-handlers.test.ts::bash handler: stderr 非空时也渲染 stderr block`

#### Scenario: 各 handler 字段透传与渲染

- **WHEN** read / write / edit / multi_edit / glob / grep handler 各自收到对应输入
- **THEN** input 透传到 dispatcher；output 按上述规则渲染

**覆盖测试**: `server/test/mcp-routed-handlers.test.ts::read handler: output.content 渲染成纯文本`、`server/test/mcp-routed-handlers.test.ts::write handler: input 透传 + 渲染 output.path`、`server/test/mcp-routed-handlers.test.ts::edit handler: input 透传（含 replace_all） + 渲染 output.path`、`server/test/mcp-routed-handlers.test.ts::multi_edit handler: edits 数组透传（不含 replace_all，与 client 实现一致） + 渲染 output.path`、`server/test/mcp-routed-handlers.test.ts::glob handler: output.files 数组渲染为换行分隔字符串`、`server/test/mcp-routed-handlers.test.ts::grep handler: output.matches 渲染为 file:line:text`

#### Scenario: error 收敛与空渲染

- **WHEN** dispatcher 返回 error
- **THEN** `isError: true`，content 为 error 文本
- **WHEN** dispatcher 返回空结果
- **THEN** content 保持空字符串，不补占位
- **WHEN** ipc.callTool 抛错
- **THEN** 收敛为 `isError: true`

**覆盖测试**: `server/test/mcp-routed-handlers.test.ts::handler: dispatcher 返回 error 时 isError:true 且 content 为 error 文本`、`server/test/mcp-routed-handlers.test.ts::handler: 空渲染保持空字符串，不再补 (empty) 占位（Plan §4.6 要求）`、`server/test/mcp-routed-handlers.test.ts::handler: ipc.callTool 抛错时收敛为 isError:true，不向 SDK 抛出 raw stack`

---

### Requirement: 路径重写与 close 顺序

The system MUST 在 `dispatchToolToClient` 把 builtin 工具调用透传到 client 时，把 server 端 cwd 重写为 client 上报的 clientCwd（路径重写不变量）；在 PTY session close 时按"先关 mcp host，再清 helperDir/runtime"的顺序，避免 fd 阻塞。

#### Scenario: dispatchToolToClient 路径重写

- **WHEN** dispatch builtin Bash 到 client
- **THEN** 入参中的 `cwd` 字段从 server 端 cwd 重写为 clientCwd

**覆盖测试**: `server/test/pty-shadow-mcp.test.ts::Phase 3: dispatchToolToClient 把 builtin Bash 透传到 client，路径重写 cwd→clientCwd`

#### Scenario: close 时先关 host 再清 runtime

- **WHEN** PTY session close
- **THEN** 先关 mcp host，再清 helperDir / runtime；倒序会触发 fd 阻塞

**覆盖测试**: `server/test/pty-shadow-mcp.test.ts::Phase 3: close 顺序——先关 mcp host，再清 helperDir/runtime（防 fd 阻塞）`

---

### Requirement: IPC 协议帧规则

The system SHALL 遵循以下 IPC 帧规则：

- 编码：每条 IPC 消息以 `\n` 结尾的 JSON 行
- 解码：跨多 chunk 累积才能切出完整行（半包重组）；损坏行静默丢弃；不完整缓冲不抛错
- 校验：拒绝缺少必填字段的 `tool_call`（防 toolName=undefined 进 dispatcher）；拒绝 hello 缺 token / hello_ack 缺 ok / tool_result 缺 id

#### Scenario: 编解码与校验

- **WHEN** `encodeIpcMessage(msg)` 输出
- **THEN** 以 `\n` 结尾的 JSON 行
- **WHEN** `decodeIpcLines` 收到多条消息混合 + 残余 + 损坏行 + 半包
- **THEN** 切分多条消息并保留残余；损坏行静默丢弃；半包跨 chunk 重组
- **WHEN** 收到缺必填字段的消息
- **THEN** 拒绝并丢弃

**覆盖测试**: `server/test/mcp-ipc-protocol.test.ts::encodeIpcMessage 输出以 \n 结尾的 JSON 行`、`server/test/mcp-ipc-protocol.test.ts::decodeIpcLines 切分多条消息并保留残余`、`server/test/mcp-ipc-protocol.test.ts::decodeIpcLines 对损坏行静默丢弃`、`server/test/mcp-ipc-protocol.test.ts::decodeIpcLines 处理无 \n 收尾的不完整缓冲`、`server/test/mcp-ipc-protocol.test.ts::decodeIpcLines 拒绝缺少必填字段的 tool_call（防 toolName=undefined 进 dispatcher）`、`server/test/mcp-ipc-protocol.test.ts::decodeIpcLines 拒绝 hello 缺 token / hello_ack 缺 ok / tool_result 缺 id`、`server/test/mcp-ipc-protocol.test.ts::decodeIpcLines 跨多 chunk 累积才能切出完整行（半包重组）`

---

### Requirement: 端到端 tools/list 可见性

The system SHALL 让 CC 通过 `tools/list` 看到 7 个 shadow tools，且 `callTool` 调用任意一个能走通"CC → routed → ipc host → dispatchToolToClient → ToolRelay → ws → client → 回程渲染"完整链路。

#### Scenario: 端到端 bash 走通完整链路

- **GIVEN** PTY session 启动且 shadow MCP 注入完成
- **WHEN** CC `tools/list`
- **THEN** 返回 7 个 shadow tools
- **WHEN** CC `tools/call mcp__cerelay__bash`
- **THEN** 完整链路通；返回 tool_result 含命令输出且 `isError: false`

**覆盖测试**: `server/test/mcp-routed-skeleton.test.ts::mcp-routed 端到端：CC tools/list 看到 7 个 shadow tools 且 callTool bash 走通完整渲染`

---

### Requirement: IPC 客户端鲁棒性

The system MUST 让 routed 子进程的 IPC 客户端在以下异常场景下立即 reject 而不悬挂：

- hello 期间对端 close → 立即 reject
- hello ack 超时（server 不响应）→ reject
- hello_ack ok:false → 抛错且 socket destroy
- callTool 飞行期间 socket 被对端关闭 → pending promise 立即 reject

#### Scenario: 异常场景下不悬挂

- **WHEN** IpcClient 经历上述任一异常场景
- **THEN** 对应 promise 立即 reject 并清理 socket

**覆盖测试**: `server/test/mcp-ipc-client.test.ts::IpcClient hello 期间对端 close 立即 reject，不悬挂`、`server/test/mcp-ipc-client.test.ts::IpcClient hello ack 超时（server 不响应）时 reject，不悬挂`、`server/test/mcp-ipc-client.test.ts::IpcClient hello_ack ok:false 抛错且 socket 被 destroy`、`server/test/mcp-ipc-client.test.ts::IpcClient 在 callTool 飞行期间 socket 被对端关闭，pending promise 立即 reject`

---

## 非功能需求

### NFR-1: 降级安全

- **目标**：MCPIpcHost 启动失败时仅 warn 不阻塞 PTY session
- **测量方式**：手动注入故障（占用 socket 路径 / 权限不足）观察 session 是否仍能通过 hook fallback 路径完成工具调用
- **当前覆盖**：`[no-test]`——无显式 e2e 守护，依赖代码 try/catch 实现（`server/src/mcp-ipc-host.ts`）。**已记入 baseline-shadow-mcp-clientcache 的「发现的债务」**

### NFR-2: socket 路径长度安全

- **目标**：socket 父目录 + sessionId hash 总长度 ≤ macOS `sun_path` 限制
- **测量方式**：`buildMcpIpcSocketPath` 在 rootDir 过长时直接抛错（已有测试守护）

### NFR-3: 工具调用 hot path 性能

- **目标**：shadow MCP dispatch 路径相对 hook fallback 路径不增加显著延迟
- **测量方式**：未量化，依赖 e2e 测试整体耗时观察
- **当前覆盖**：`[no-test]`，记入「发现的债务」

---

## 变更历史

| 日期 | Change | 变更摘要 |
|---|---|---|
| 2026-05-05 | [baseline-shadow-mcp-clientcache](../../archive/2026-05-05-baseline-shadow-mcp-clientcache/) | Baseline 反向生成首次创建 |

---

**首次创建**: 2026-05-05
**最后更新**: 2026-05-05（baseline-shadow-mcp-clientcache）
