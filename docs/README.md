# docs/

本目录是 Cerelay 项目的文档根，**完全遵循 doc-init skill 标准骨架**（见 [`AGENTS.md`](./AGENTS.md)）。

## 目录结构

```
docs/
├── README.md              # 本入口
├── AGENTS.md              # 项目文档规约（含与外部 skill 的集成约束）
├── overview/              # 项目世界观（事实 + 要求 + 术语）
│   ├── project.md         # worldview（事实层：系统是什么）
│   ├── constitution.md    # 项目宪法（要求层：必须遵守什么）
│   └── glossary.md        # 术语表（业务 / 技术 / 缩略语）
├── architecture/          # 架构（README + modules/ 专题）
│   ├── README.md          # 架构总览、技术选型、核心机制模块地图
│   └── modules/           # 各核心机制深度展开
├── operations/            # 运维 SOP 索引（brain-docker / roadmap 等）
├── testing/               # 测试体系（e2e 覆盖矩阵硬卡点）
├── specs/                 # Living capability specs（source of truth；禁直接编辑）
├── changes/               # 进行中的 change（proposal / design / tasks / spec-delta）
├── archive/               # 已归档：完成的 change + 历史设计文档
└── decisions/             # ADR（4 位编号锁定表）
```

## ⚠️ Baseline 覆盖范围声明

**当前 living spec 只覆盖 `shadow-mcp-tools` 与 `client-config-sync` 两个 capability，不是仓库现状的全量收集。**

其他 capability（`mount-namespace-isolation` / `pty-session` / `file-proxy-fuse` / `claude-settings-redaction` / `client-routed-tools` / `mcp-proxy` / `cross-cwd-isolation` 等）尚未反向生成 spec。后续如有 change 触达这些能力，按 brownfield 流程**单独走一个 baseline change** 反向补齐（详见 [`specs/README.md`](./specs/README.md)）。

如发现现有 spec 与代码实际行为不一致，**以代码为准**，通过新的 change 更新 spec。

## 阅读顺序建议

新接手的工程师按以下顺序阅读：

1. 项目根 [`../CLAUDE.md`](../CLAUDE.md)：项目总览、约束、核心技术决策
2. [`overview/project.md`](./overview/project.md)：项目 worldview
3. [`overview/constitution.md`](./overview/constitution.md)：治理原则与红线
4. [`overview/glossary.md`](./overview/glossary.md)：术语表（按需查阅）
5. [`architecture/README.md`](./architecture/README.md)：架构总览（技术选型、核心机制模块地图）
6. [`architecture/modules/<module>.md`](./architecture/modules/)：感兴趣模块的深度展开
7. [`specs/<capability>/spec.md`](./specs/)：具体能力规范
8. [`changes/<change>/proposal.md`](./changes/)：当前进行中的变更

## 按角色入口

| 角色 | 入口 |
|---|---|
| 用户 | 项目根 [`../README.md`](../README.md) |
| 贡献者 / 开发者 | [`architecture/README.md`](./architecture/README.md) + [`AGENTS.md`](./AGENTS.md) |
| 部署 / 运维 | [`operations/README.md`](./operations/README.md) |
| QA / 测试 | [`testing/README.md`](./testing/README.md) |
| 设计决策 | [`decisions/README.md`](./decisions/README.md) + [`specs/README.md`](./specs/README.md) |
| AI 协作 | 项目根 [`../CLAUDE.md`](../CLAUDE.md) + [`AGENTS.md`](./AGENTS.md) |

## 强制约束一览

| 约束 | 文档 | 触发场景 |
|---|---|---|
| E2E 覆盖审计硬卡点 | [`overview/constitution.md` §1.1](./overview/constitution.md) + [`testing/README.md`](./testing/README.md) | commit 前必审 |
| 修改 living spec 必须走 change | [`AGENTS.md`](./AGENTS.md) + [`specs/README.md`](./specs/README.md) | 任何 spec 改动 |
| ADR 编号锁定 | [`decisions/README.md`](./decisions/README.md) | 新增 ADR |
| 启动期进度 UI Phase 抽象 | [`architecture/modules/startup-progress-ui.md`](./architecture/modules/startup-progress-ui.md) | 新增任何启动期 / 多阶段进度 UI |
| Mount namespace 文件系统不变量 | [`architecture/modules/session-runtime.md`](./architecture/modules/session-runtime.md) + [`../CLAUDE.md`](../CLAUDE.md) | 修改隔离边界 |
| 凭证字段 redaction | [`architecture/modules/session-runtime.md`](./architecture/modules/session-runtime.md) + 归档 [`archive/2026-04-30-shadow-claude-settings-redaction/`](./archive/2026-04-30-shadow-claude-settings-redaction/) | server → namespace 出口 |
| superpowers skill override | [`AGENTS.md` § 与外部 skill 的集成约束](./AGENTS.md) | 用 brainstorming/writing-plans 等 skill 时 |

## 工作流

详见 `~/.claude/skills/doc-init/workflow.md` 与项目 [`AGENTS.md`](./AGENTS.md)。

> **历史说明**：项目曾在 `docs/superpowers/` 下保留 superpowers skill 产出（按日期前缀的 specs/plans），并对 spec-driven-docs skill 默认目录做过扁平化覆盖（`project.md` / `constitution.md` 放 `docs/` 根）。2026-05-11 docs-restructure 全部统一到 doc-init 标准，superpowers 历史产出已按 topic 归档到 [`archive/`](./archive/)。详见 [`AGENTS.md` § 与外部 skill 的集成约束](./AGENTS.md)。

## 历史变更（本目录骨架）

- **2026-05-11**：完成 `docs-restructure` 迁移
  - 拆分 `architecture.md` 为 `architecture/{README, modules/}`
  - 新建 `overview/{project, constitution, glossary}.md` / `operations/` / `testing/`
  - 归档历史设计文档：`plan-d-mcp-shadow-tools` / `plan-acp-relay` / `handover-go-era` / `codex-f4-design`
  - 把 `docs/superpowers/` 全部按 topic 拆归档：access-ledger-driven-cache / shadow-claude-settings-redaction / f4-cross-cwd-fileproxy-isolation / multi-worktree-test-isolation / client-scan-optimization / e2e-comprehensive-p0-foundation / file-agent-and-config-preloader
  - 建立 `AGENTS.md` / `decisions/README.md` / `specs/README.md` / `archive/README.md` / `overview/glossary.md` 等索引
  - 撤回所有 spec-driven-docs / superpowers skill 路径 override，对齐 doc-init 标准
  - 迁移过程的中间产物（`.migration-plan.md` / `.migration-checklist.md`）已在迁移完成后删除；如需查看历史完整变更范围请回到本次 docs-restructure 的 commit 系列
- **2026-05-05**：baseline change `baseline-shadow-mcp-clientcache` 归档（首次建立 living spec 体系）
