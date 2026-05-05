# Spec Delta: client-config-sync

> 位置：`docs/changes/shadow-mcp-permission-integration/specs/client-config-sync/spec.md`
> 角色：本 change 对 `client-config-sync` capability 的**变更声明**。归档时合并到 `docs/specs/client-config-sync/spec.md`。
>
> Living spec 当前版本：[`docs/specs/client-config-sync/spec.md`](../../../../specs/client-config-sync/spec.md)（baseline 反向生成于 2026-05-05）。

## ADDED Requirements

### Requirement: settings.local.json 写回路径与 watcher 联动

The system MUST 让 cerelay 在用户选 "Always 允许" 时，通过现有 client-routed Write tool 把规则写到 `{cwd}/.claude/settings.local.json`，并依赖现有 client cache watcher（chokidar）把变更增量同步回 server cache：

- **不引入** server → client 新协议消息（不破坏 v1 协议字段不变性）
- **不引入** server 直接写 client 文件系统的旁路（仍走 ToolRelay → ws → client → 本机执行）
- 写完后下一次 mini engine 评估必须能拿到最新规则（依赖 watcher 快速同步）

#### Scenario: 写回触发 watcher delta

- **GIVEN** `{cwd}/.claude/settings.local.json` 已存在 / 不存在两种情形
- **WHEN** server 通过 client Write tool 写入 / 创建文件
- **THEN** client watcher 触发 cache delta；server cache manifest 更新；revision 递增；mini engine 下次评估读到最新规则

#### Scenario: 写回不破坏 v1 协议

- **WHEN** 写回流程跑完一轮
- **THEN** 全程未发送新增 message 类型；仅复用 `ToolRelay` 的 builtin Write tool 调用 + 现有 `cache_task_delta` / `cache_task_delta_ack`

#### Scenario: 写回失败的降级

- **GIVEN** Write tool 因权限 / 磁盘问题失败
- **WHEN** server 收到 Write tool 的 isError
- **THEN** 把失败原因传给 mini engine 的兜底链路（elicitation 仍可继续，但 Always 写回标记失败让用户知道）；不污染 cache manifest；不卡死 session

---

## MODIFIED Requirements

无。本 change 不修改 `client-config-sync` 的现有 Requirement——读路径、scope 适配、TTL、串行锁、pipeline、FUSE 共享 store 等行为保持不变。新写回路径以**新增 Requirement** 的形式出现，归档时追加到 living spec 末尾。

---

## REMOVED Requirements

无。

---

## 影响范围

- **不**改 v1 协议字段
- **不**改 manifest schema / 串行锁 / GC 行为
- **不**改 FUSE 读路径
- 仅复用现有 client-routed Write tool + 现有 cache watcher → delta → ack 链路
- e2e coverage 矩阵审计：新写回路径**不引入新协议字段 / 工具 / 拓扑 / 隔离边界 / cache 维度**（依旧用现有 Write tool + 现有 cache scope `project-claude` 的子路径），按 CLAUDE.md 三问可豁免新增 e2e；但本 change 实现阶段仍建议补一条 e2e 验证 "Always 选择 → settings.local.json 落地 → 下次同命令 0 打扰"

---

## 备注：本 change 在该 capability 上为何不算 MODIFIED

原 proposal 的 What's Changing 表格把 `client-config-sync` 标为 MODIFIED，理由是"增加对写回路径的协议支持"。澄清后实际边界：

- 写回**不引入**新协议字段（用 Write tool + 现有 cache delta）
- 写回**不修改**任何现有 Requirement 的行为
- 写回是**新增**一条独立 Requirement，挂在 capability 名下

因此 spec delta 按 ADDED 写而不是 MODIFIED；proposal 的 What's Changing 表格表述偏粗（流程上 capability 被涉及），实际 spec 影响是 ADDED-only。归档时把 ADDED Requirement 追加到 living spec 即可。
