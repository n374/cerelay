# docs/

本目录是 Cerelay 项目的 **Spec-Driven 文档根**，承担三类内容：

1. **Spec-Driven 工作流产出**（来自 `~/.claude/skills/spec-driven-docs`）
   - `project.md`：项目 worldview（技术栈、架构铁律、模块清单）
   - `constitution.md`：项目宪法（治理原则与红线）
   - `specs/<capability>/spec.md`：living spec（按能力组织，source of truth）
   - `changes/<change-name>/`：进行中的变更（proposal/plan/tasks/spec-delta）
   - `archive/YYYY-MM-DD-<change-name>/`：归档（合并 delta 到 living spec 后）
   - `decisions/NNNN-<topic>.md`：架构决策记录（ADR）
2. **既有顶层文档**（待批 3 重组）
   - `architecture.md` / `e2e-comprehensive-testing.md` / `brain-docker.md` / `acp-editor-integration.md` / `plan-acp-relay.md` / `plan-d-mcp-shadow-tools.md`
   - 这些文档**未按 Spec-Driven 模型组织**，等独立 change `docs-restructure` 触达时再做拆分 / 迁移
3. **其他体系产出**：`superpowers/`（superpowers skill 产出，按日期前缀，不属于本流程）

## ⚠️ Baseline 覆盖范围声明

**当前 living spec 只覆盖 `shadow-mcp-tools` 与 `client-config-sync` 两个 capability，不是仓库现状的全量收集。**

其他 capability（`mount-namespace-isolation` / `pty-session` / `file-proxy-fuse` / `claude-settings-redaction` / `client-routed-tools` / `mcp-proxy` / `cross-cwd-isolation` / 等）尚未反向生成 spec。后续如有 change 触达这些能力，按 brownfield 流程**单独走一个 baseline change** 反向补齐（详见 `~/.claude/skills/spec-driven-docs/brownfield.md`）。

如发现现有 spec 与代码实际行为不一致，**以代码为准**，通过新的 change 更新 spec。

## 与 SKILL 默认结构的差异

`~/.claude/skills/spec-driven-docs/SKILL.md` 默认目录前缀是 `openspec/`，本项目通过项目级覆盖将其改为 `docs/`，并去掉了 `memory/` 中间层（`constitution.md` 直接顶层）。详见项目根 `CLAUDE.md` 的「Spec-Driven 目录覆盖」章节。

## 当前阶段

| 内容 | 状态 |
|---|---|
| 骨架与入口（`README.md` / `project.md` / `constitution.md`） | 已建（baseline 第 1 步） |
| baseline change `baseline-shadow-mcp-clientcache` | 进行中（反向生成 2 个 capability spec） |
| 真实 change `shadow-mcp-permission-integration` | proposal 已起草，待 baseline 完成后进入 plan 阶段 |
| 既有顶层文档重组（独立 change `docs-restructure`） | 未启动 |

## 阅读顺序建议

新接手的工程师按以下顺序阅读：

1. 项目根 `CLAUDE.md`（项目总览、约束、核心技术决策）
2. `docs/project.md`（worldview）
3. `docs/constitution.md`（治理原则）
4. `docs/specs/<capability>/spec.md`（具体能力规范）
5. `docs/changes/<change>/proposal.md`（当前进行中的变更）

工作流详见 `~/.claude/skills/spec-driven-docs/SKILL.md` 与 `workflow.md`。
