# Spec Delta: shadow-mcp-permission

> 位置：`docs/changes/shadow-mcp-permission-integration/specs/shadow-mcp-permission/spec.md`
> 角色：本 change 对 `shadow-mcp-permission` capability 的**变更声明**（ADDED 完整 capability）。归档时合并到 `docs/specs/shadow-mcp-permission/spec.md`。
>
> 这是一个全新 capability，本 change 中所有 Requirement 都是 ADDED。

## ADDED Requirements

### Requirement: Mini permission engine 三态评估

The system SHALL 在 shadow MCP 派发到 client 之前，由 mini permission engine 对每次工具调用做三态评估：`allow` / `deny` / `unmatched`，**deny 优先于 allow**；`unmatched` 不视为 allow，必须进入兜底流程（elicitation 或结构化 isError）。

#### Scenario: deny 优先于 allow

- **GIVEN** settings 同时含 `Bash(git push:*)` 在 allow 与 `Bash(git push --force:*)` 在 deny
- **WHEN** 评估 `git push --force origin master`
- **THEN** 返回 `deny`，触发 isError；不因 allow 命中而通过

#### Scenario: 命中 allow 直接放行

- **GIVEN** settings 含 `Bash(git push:*)` 在 allow，无 deny 命中
- **WHEN** 评估 `git push origin master`
- **THEN** 返回 `allow`，正常派发到 client，`tool_result.is_error === false`

#### Scenario: 未命中走兜底

- **GIVEN** settings 中无任何 allow/deny 规则匹配
- **WHEN** 评估 `npm install`
- **THEN** 返回 `unmatched`，进入 elicitation / isError 兜底链路，**不**默认放行

---

### Requirement: 支持的规则形式

The system MUST 支持以下三种规则形式（与 CC 原生 `permissions.allow` / `permissions.deny` 解析等价）：

- **Bash prefix**：`Bash(<prefix>:*)`，按命令字符串前缀匹配（去除 leading whitespace 后比较）
- **exact match**：`Bash(<exact>)`，命令完整匹配（含参数）
- **tool-level**：`Bash` / `Read` / `Write` / `Edit` / `MultiEdit` / `Glob` / `Grep`，整个工具放行 / 拒绝

不支持的规则形式（regex / env-var 替换 / 复杂条件）由 engine 标记为 unrecognized 并降级为 `unmatched`，**不抛错、不当作 allow**；同时 server 日志记录 unrecognized 规则原文以便排查。

#### Scenario: prefix 规则匹配

- **GIVEN** allow 含 `Bash(git push:*)`
- **WHEN** 评估 `git push origin main`
- **THEN** 返回 `allow`
- **WHEN** 评估 `gitpush origin main`（前缀不匹配）
- **THEN** 返回 `unmatched`

#### Scenario: exact 规则匹配

- **GIVEN** allow 含 `Bash(ls -la)`
- **WHEN** 评估 `ls -la`
- **THEN** 返回 `allow`
- **WHEN** 评估 `ls -la /tmp`（参数多余）
- **THEN** 返回 `unmatched`

#### Scenario: tool-level 规则匹配

- **GIVEN** allow 含 `Read`
- **WHEN** 评估 `mcp__cerelay__read` 调用 `/tmp/foo.txt`
- **THEN** 返回 `allow`（任意参数都放行）

#### Scenario: 不识别的规则降级为 unmatched

- **GIVEN** allow 含 `Bash(/regex.*pattern/)` 这种 regex 形式
- **WHEN** 评估任意命令
- **THEN** 该规则被标记 unrecognized，不参与匹配；server 日志记录该规则原文；evaluator 整体若无其他规则命中则返回 `unmatched`

---

### Requirement: 多 settings 文件合并顺序

The system SHALL 按 CC 原生顺序合并多 settings 文件中的 `permissions.allow` / `permissions.deny`：enterprise → user → project → project-local（后者覆盖前者中相同条目）。`~/.claude.json` 中的等价字段（如有）按 CC 原生语义参与合并。**不引入 cerelay 私有字段、不区分 cerelay vs 裸用 CC**。

#### Scenario: 不同层级规则合并

- **GIVEN** user `~/.claude/settings.json` 含 `Bash(git:*)` allow，project `{cwd}/.claude/settings.local.json` 含 `Bash(git push --force:*)` deny
- **WHEN** 评估 `git push --force origin main`
- **THEN** 返回 `deny`（project deny 覆盖 user allow）
- **WHEN** 评估 `git status`
- **THEN** 返回 `allow`（user allow 仍生效）

#### Scenario: settings 重读

- **GIVEN** session 已启动，规则集已加载
- **WHEN** `~/.claude/settings.json` 被 client 侧编辑（通过 cache delta 同步到 server）
- **THEN** 下次评估前 engine 重新加载规则；同一 session 内多次评估反映最新规则

---

### Requirement: 未命中 → elicitation 链路（首选兜底）

The system SHALL 在 mini engine 返回 `unmatched` 时**优先**通过 MCP `elicitation/create` 向 CC client 请求审批，文案含：工具名 / 命令 / 命中候选规则的写法（`Bash(<prefix>:*)`）+ 三个选项（一次允许 / Always 允许 / 拒绝）。

只有在 CC client 当前版本支持 elicitation handler 时才走此分支；探测时机为 PTY session 启动时（不在 hot path 反复探测）。

#### Scenario: elicitation 用户选"一次允许"

- **GIVEN** CC 支持 elicitation，命令 `npm install` 进入 unmatched
- **WHEN** server 通过 elicitation 弹审批，用户选"一次允许"
- **THEN** 本次调用放行，`tool_result.is_error === false`；settings.local.json **不**写回；下次 `npm install` 仍走 elicitation

#### Scenario: elicitation 用户选"Always 允许"

- **GIVEN** 同上
- **WHEN** 用户选"Always 允许"
- **THEN** 本次调用放行；server 把 `Bash(npm install:*)` 写到 `{cwd}/.claude/settings.local.json` 的 `permissions.allow`；下次 `npm install` 直接 allow 不弹窗

#### Scenario: elicitation 用户选"拒绝"

- **GIVEN** 同上
- **WHEN** 用户选"拒绝"
- **THEN** 返回 `tool_result.is_error === true`，content 含拒绝原因；settings 不变

---

### Requirement: elicitation 不可用 → 结构化 isError 降级

The system MUST 在 CC client 不支持 elicitation 时降级为返回结构化错误：`tool_result.is_error === true`，content 含明确文案告诉用户**改哪个文件加什么规则**：

```
Permission denied: <toolName>(<input-summary>)

To allow this tool invocation, add the following rule to ~/.claude/settings.json or {cwd}/.claude/settings.local.json:

  "permissions": {
    "allow": ["Bash(<suggested-prefix>:*)"]
  }

Or run with --dangerously-skip-permissions (not recommended).
```

绝不静默放过、不卡死、不降级为"全工具开放"。

#### Scenario: 降级返回结构化 isError

- **GIVEN** CC client 不支持 elicitation handler（探测结果）
- **WHEN** 命令进入 unmatched
- **THEN** `tool_result.is_error === true`，content 含上述文案；session 不被中断；下次同命令仍走同样路径

#### Scenario: 文案中的建议 prefix

- **WHEN** 命令为 `git push origin main` 进入 unmatched
- **THEN** 文案中建议 `Bash(git push:*)`（取命令首两 token）；命令为 `npm install foo` 时建议 `Bash(npm install:*)`

---

### Requirement: Always 写回必须使用原生 CC 格式

The system MUST 在用户选"Always 允许"时，把规则以 **CC 原生格式**写回 `{cwd}/.claude/settings.local.json` 的 `permissions.allow`，**不能**写 `mcp__cerelay__bash` 这种 cerelay 专用名。这样：

- cerelay 启用时由 mini engine 评估
- cerelay 关闭、用户裸用 CC 时由 CC 原生 engine 评估
- 同一份物理 `settings.local.json`，零并行配置

#### Scenario: 写回为 Bash prefix 形式

- **GIVEN** 用户选"Always 允许"，命令 `npm install`
- **WHEN** server 写回
- **THEN** `{cwd}/.claude/settings.local.json` 的 `permissions.allow` 含 `Bash(npm install:*)`；不含 `mcp__cerelay__bash` 等任何 MCP 形式

#### Scenario: 写回为 tool-level 形式（Read/Write 等）

- **GIVEN** 用户选"Always 允许"，命令为 `mcp__cerelay__read /tmp/foo.txt`
- **WHEN** server 写回
- **THEN** `permissions.allow` 含 `Read`（tool-level）

#### Scenario: 写回保持 settings.local.json 既有结构

- **GIVEN** `settings.local.json` 已含其他字段（如 `hooks` / `env`）
- **WHEN** server 写回 permission 规则
- **THEN** 仅追加 / 修改 `permissions.allow` 数组；其他字段保持不变；JSON 缩进与 newline 风格保持原样（或按 CC 默认风格）

---

### Requirement: 写回路径与 redaction 不变量兼容

The system SHALL 在写回 `settings.local.json` 时遵守现有 redaction 不变量（详见 `docs/superpowers/specs/2026-04-30-shadow-claude-settings-login-state-design.md`）：

- 写回路径走 client-routed Write tool（不直接写容器内 FUSE shadow file）
- 写完后 cache delta 通过 watcher 自动同步回 server
- server 侧 redaction 在 server → CC 出口处统一发生，不依赖写回路径"提前清洁"

#### Scenario: 写回不污染 settings.json 登录态

- **GIVEN** `~/.claude/settings.json` 含登录态字段（`env.ANTHROPIC_BASE_URL` 等）
- **WHEN** server 写回 `settings.local.json` permission 规则
- **THEN** **不**触及 `~/.claude/settings.json`；`settings.local.json` 也不引入登录态字段

#### Scenario: 写回后 cache 同步

- **WHEN** server 通过 client Write tool 写完 `settings.local.json`
- **THEN** client watcher 触发 cache delta；server cache manifest 更新；下次 mini engine 重读规则时拿到最新版本

---

### Requirement: 7 个 shadow tool 都接 permission check

The system MUST 把 permission check 应用到全部 7 个 shadow tool（`mcp__cerelay__{bash, read, write, edit, multi_edit, glob, grep}`），不只 Bash。Read / Write / Edit 等若用户配置中是 tool-level（如 `Read`）则走 fast path 直接 allow；若有 path 级 pattern 则按 mini engine 解析。

#### Scenario: tool-level 命中放行 7 工具

- **GIVEN** allow 含 `Read` / `Write` / `Glob` 等 tool-level 规则
- **WHEN** 调用对应 shadow tool
- **THEN** 所有命中的工具直接 allow，不弹 elicitation

#### Scenario: 未配置 tool-level → 进 unmatched

- **GIVEN** settings 中没有 `Read` 也没有任何 path-level 规则
- **WHEN** 调用 `mcp__cerelay__read /etc/hosts`
- **THEN** 返回 unmatched，进入 elicitation / isError 兜底

---

### Requirement: 命中规则 0 打扰

The system MUST 在以下场景下做到**0 次审批弹窗**（既不弹 elicitation 也不返回 isError）：

- 命令命中 user-level 或 project-level allow 规则，且无 deny 命中
- 同一命令在 session 内重复调用（每次都重新评估，但持续命中即持续放行）

#### Scenario: 重复命中不重复打扰

- **GIVEN** allow 含 `Bash(git push:*)`
- **WHEN** 同 session 中多次调用 `git push origin main` / `git push origin feature` / `git push --force`
- **THEN** 每次都返回 `allow`，0 次审批弹窗

---

## 引用与依赖

- 本 capability 依赖 `shadow-mcp-tools` 的 dispatch 链路（在派发到 client 之前做 permission check）
- 本 capability 间接依赖 `client-config-sync` 的 `settings.json` / `settings.local.json` 同步（mini engine 从 cache 读规则集）
- redaction 不变量参考 `docs/superpowers/specs/2026-04-30-shadow-claude-settings-login-state-design.md`
