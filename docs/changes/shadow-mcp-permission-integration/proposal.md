# Proposal: shadow-mcp-permission-integration

> 位置：`openspec/changes/shadow-mcp-permission-integration/proposal.md`
> 角色：本 change 的入口文档。回答"为什么做"和"做什么"，**不涉及"怎么做"**（那是 plan 的事）。

> ⚠️ **OpenSpec 接入状态**：本仓库首次使用 OpenSpec 结构。`openspec/project.md` / `openspec/memory/constitution.md` / `openspec/specs/` baseline **均未生成**。本 change 是 OpenSpec 接入后的第一个变更，proposal/plan/tasks 闭环可正常推进；但 archive 阶段「合并 delta 到 living spec」需要等 brownfield baseline 完成后再回填——届时本 change 的 spec delta 将作为对应 capability 的初始版本之一。
>
> _OpenSpec onboarding status_: First-time adoption. `project.md` / `constitution.md` / `specs/` baseline are pending. This change can proceed through proposal→plan→tasks→implement→verify, but archiving will defer until brownfield baseline is generated.

## Why / 动机

### 用户实测痛点 / Observed Pain

用户从本机 client 连接到 VPS 上的 cerelay server 时，**每一次工具调用都被要求审核**，哪怕 `~/.claude/settings.json` 里早已配置了细粒度 `permissions.allow`（`Bash(git push:*)`、`Bash(npm install:*)` 等）。

_When connecting a local client to a remote cerelay server, every tool invocation triggers an approval prompt — even though the user's `~/.claude/settings.json` already contains fine-grained `permissions.allow` rules._

### 根因 / Root Cause

Plan D Shadow MCP（`docs/plan-d-mcp-shadow-tools.md`）为了规避 PreToolUse hook 协议下 `tool_result.is_error` 永远为 true 的硬约束，把 CC 内置工具（Bash / Read / Write / Edit / MultiEdit / Glob / Grep）整体放进 `--disallowedTools`，并以 `mcp__cerelay__*` 替代。

后果：用户写在 `permissions.allow` 中的 builtin 形式规则（如 `Bash(git push:*)`）**永远不会被 CC 引擎评估**——CC 引擎只会看到 `mcp__cerelay__bash` 这样的 MCP 工具名，而 MCP 工具权限是 tool 级 only，不支持 pattern。每次 `mcp__cerelay__*` 调用都掉到 ask 通道。

_Shadow MCP disallows all CC builtin tools and mirrors them as `mcp__cerelay__*`. Users' native `Bash(...)` permission rules cannot match MCP tool names, and CC's MCP tool permissions are tool-level only — every shadow tool invocation falls into the ask path._

### 期望状态 / Desired State

1. **用户已配置的 `Bash(...)` / `Read(...)` 等规则在 cerelay 启用时自动生效**，不需要重写为 MCP 形式
   _User's existing native permission rules SHOULD apply automatically when cerelay is active._
2. **未命中规则时，给用户原生 CC 风格的审批 UX**（弹窗确认 + "Always" 选项），不要让用户去手改 settings 重启
   _Unmatched commands SHOULD trigger a native-CC-style approval popup with an "Always" option, not require manual settings editing._
3. **"Always" 写回的配置必须跨场景兼容**：写到 `settings.local.json` 的是原生 `Bash(prefix:*)` 格式，用户后续无论是继续走 cerelay 还是裸用 CC binary，同一条规则都应生效
   _"Always" choices MUST be written in native CC format so that the same `settings.local.json` works whether the user continues with cerelay or runs CC standalone._

### 为什么现在做 / Why Now

- 该问题阻塞 **远程 / 多 client 场景的实际使用**——本机直接跑 CC 没问题，但 cerelay 的核心定位（client 远程连 server）下用户体验从"几乎不被打扰"退化到"每次都被打扰"，等于退回了 CC 原生权限引擎诞生前的状态。
- F4 P2（`docs/`/git log 中的 cross-cwd-fileproxy-isolation）已收尾，shadow MCP 这条主路径稳定，正是补齐权限层的窗口期。

## What's Changing / 变更范围

| Capability | 变化类型 | 简述 |
|---|---|---|
| `shadow-mcp-permission` | ADDED | 新 capability：在 cerelay-routed dispatcher 中桥接用户原生 CC permission 规则到 shadow MCP 工具调用，含 mini engine + elicitation 兜底 + 原生格式写回 |
| `shadow-mcp-tools` | MODIFIED | 现有 shadow MCP dispatch 链路（`server/src/mcp-routed/`）在派发 client 之前增加 permission check 步骤；不命中且无 elicitation 支持时退化为 `isError: true` + 结构化错误（不再无脑 ask） |
| `client-config-sync` | MODIFIED | `~/.claude/settings.json` / `{cwd}/.claude/settings.local.json` 的 cache scope 与 watcher 范围已覆盖；本 change 增加对**写回路径**（cerelay → settings.local.json）的协议支持，确保不破坏现有 redaction 不变量 |

**新增的 capability**：
- `shadow-mcp-permission`：把"用户的 CC 原生权限配置"作为 source of truth，在 shadow MCP 路径上还原"匹配 → 命中放行 / 未命中弹审批 / Always 写回原生格式"的完整 UX 链路。

## Out of Scope / 明确不做的事

- ❌ **不实现完整 CC permission DSL**：本 change 的 mini engine 只支持 `Bash(prefix:*)`、exact match 和 tool 级（`Read` / `Write` 等）这三种格式。CC 未来若引入 regex / 环境变量替换 / 复杂条件，本 change **不预先支持**，留给后续 change 补
  _Mini engine supports only `Bash(prefix:*)`, exact match, and tool-level rules. Complex CC pattern syntax (regex/env-var/etc.) is deferred._
- ❌ **不动 hook 路径架构**：保留 hook fallback 作为 shadow MCP 不可用时的兜底（`pty-session.ts:339-388`），不试图用 hook + `updatedInput` 改写复读机方案（E3 思路） 替代 shadow MCP
- ❌ **不替换 FUSE / cache 架构**：`settings.json` 仍走现有 FileAgent + ConfigPreloader 路径
- ❌ **不修 CC binary**：100% userland 解决；任何"如果 CC 加个 X 就更好了"的方向不在本 change
- ❌ **不处理 `~/.claude.json` 的 `apiKeyHelper` / `oauthAccount` 等登录态字段**：CLAUDE.md 已声明该项暂不过滤，与本 change 正交
- ❌ **不引入新 client → server 协议字段**：本 change 完全在 server / cerelay-routed 进程内闭环，client 侧零改动
- ❌ **不处理 `permissions.deny` 的全部语义**：仅识别和尊重 deny 优先于 allow 的基本顺序；deny pattern 复杂语法同 mini engine 支持范围

## Stakeholders / 干系人

| 角色 | 关注点 | Review 必需 |
|---|---|---|
| n374（项目所有者） | 配置可移植性、安全边界、与 Plan D 不变量兼容 | 是 |
| 远程使用者（cerelay client 连 VPS server 的用户） | 不被反复打扰、Always 选择持久化 | 间接（通过 metric 观测） |
| Codex（方案 / 验收对等评审者） | 与 review-workflow 一致的方案共创 | 是（plan / verify 阶段） |

## Success Metrics / 验收指标

1. **匹配命中无打扰**：用户 `~/.claude/settings.json` 写有 `Bash(git push:*)`，连 cerelay 后调用 `git push origin main`、`git push --force` 等，**0 次**审批弹窗（matched-allow path）
2. **Always 写回生效**：用户在弹窗中对 `npm install` 选 Always 后，再次连接 cerelay（重启 session），同一命令**0 次**弹窗；且 `settings.local.json` 中能看到 `Bash(npm install:*)` 形式的条目
3. **跨场景一致性**：步骤 2 写回的 `settings.local.json`，**直接 `claude` CLI（无 cerelay）**也能让同样的命令免审；反向同理（CC 裸用时手写的 allow 规则在 cerelay 下也免审）
4. **Plan D is_error 不变量**：本 change 全部主路径（`mcp__cerelay__*` 调用）的 `tool_result.is_error === false` 与现有 e2e 断言一致；hook fallback 路径仍保留 `is_error === true` 的硬约束（不试图绕开）
5. **降级安全**：CC 不支持 MCP elicitation 时，未命中分支返回结构化错误（`isError: true` + 明确文案告诉用户改哪里），**不静默放过、不卡死、不降级为"全工具开放"**

## Clarifications / 澄清

> 本节由 Clarify 阶段填充。已在用户对话中达成的关键共识先固化在此，避免 plan 阶段重新拉锯。

### Q1: 本 change 解决 Bash 还是所有 builtin 工具的权限？
**A**: 所有 7 个 shadow 化的 builtin（Bash / Read / Write / Edit / MultiEdit / Glob / Grep）。但**复杂度集中在 Bash**——只有 Bash 有 `prefix:*` pattern 实战痛点；Read/Write/Edit 等用户实际配置中绝大多数是 tool 级（直接 `"Read"` 全开），翻译压力小。
**影响**: mini engine 设计上 Bash 是 first-class（pattern matcher），其他工具走 tool-level fast path。

### Q2: 写回格式必须跨场景兼容吗？
**A**: 是。"Always" 写回 `~/.claude/settings.local.json` 的格式必须是 CC 原生 `Bash(prefix:*)` / `Read` / 等，**不能是 `mcp__cerelay__bash`**。这样：
- cerelay 启用时由 mini engine 评估
- cerelay 关闭、用户裸用 CC 时由 CC 原生 engine 评估
- 同一份物理 settings.local.json，零并行配置
**影响**: 写回逻辑需识别"用户的真实命令"而非"MCP 工具名"，并选择合适的 prefix 粒度（用户 confirm 时弹窗里要给出 prefix vs exact 的选项？或固定策略？留给 plan）。

### Q3: 未命中 allow 时的 fallback 优先级？
**A**: 三档优先级：
1. **首选 MCP elicitation 弹窗**——若 CC 当前版本 client 已实现 elicitation handler
2. **退化为结构化 isError**——elicitation 不可用时，返回 `isError: true` + 文案 "Permission denied. Add `Bash(...)` to settings.json or use --dangerously-skip-permissions"
3. **绝不静默放过**：不会因为兜底失败而把命令静默执行
**影响**: plan 阶段必须前置一个 spike：probe CC binary 对 MCP `elicitation/create` 的支持情况。结果决定 fallback 链是 `match → elicit → error` 还是 `match → error`。

### Q4: 是否在本 change 中实现 deny 规则匹配？
**A**: 是，但仅基础语义。`permissions.deny` 中的 `Bash(rm -rf:*)` 等应在 mini engine 中优先于 allow 评估。复杂 deny pattern 同 mini engine 支持范围（prefix / exact / tool-level）。
**影响**: mini engine 接口需要 `evaluate(toolCall) → 'allow' | 'deny' | 'unmatched'` 三态返回，而不是二态。

### Q5: 与 review-workflow 阶段 0 / 阶段 1 / 阶段 2 的关系？
**A**: 本 proposal 等价于 review-workflow 的"阶段 0 需求规格"。后续 plan 阶段进入"阶段 1 并行产方案 + 阶段 2 交叉评审"的双人对齐循环（Claude × Codex）。本 change 的"E1' / E3 / D4 / E2 谁胜出"的最终决策落在 plan.md 与可能的 ADR 中，**不在本 proposal 决**。
**影响**: 阅读 proposal 时不要期待技术方案细节；那是 plan 的事。

---

**创建于**: 2026-05-05
**当前阶段**: Proposal（已完成 → 待进入 Clarify 二轮 / Plan）
**关联文档**:
- `CLAUDE.md` — Shadow MCP Tools (Plan D) 节
- `docs/plan-d-mcp-shadow-tools.md` — Plan D 完整设计与 is_error 协议硬约束证据
- `docs/superpowers/specs/2026-04-30-shadow-claude-settings-login-state-design.md` — settings 出口 redaction 不变量（本 change 的写回路径必须兼容）
