<!-- doc-init template version: v1.0 -->
# Cerelay 文档规约 / Documentation Conventions

> 本文件是 **Cerelay** 项目的文档规约入口。详细硬规则见 doc-init skill 的 [AGENTS.md](file:///Users/n374/.claude/skills/doc-init/AGENTS.md)（`~/.claude/skills/doc-init/AGENTS.md`）。
> 本文件只列项目特有的扩展约束，不复述 skill 已定义的内容。

## 与标准骨架的对齐情况

Cerelay 项目**完全遵循 doc-init 标准骨架**，不做扁平化覆盖：

| 制品 | 项目实际路径（即 doc-init 标准） |
|---|---|
| project | [`docs/overview/project.md`](./overview/project.md) |
| constitution | [`docs/overview/constitution.md`](./overview/constitution.md) |
| glossary | [`docs/overview/glossary.md`](./overview/glossary.md) |
| ADR | [`docs/decisions/NNNN-<topic>.md`](./decisions/) |
| change | [`docs/changes/<slug>/`](./changes/) |
| spec-delta | [`docs/changes/<slug>/specs/<cap>/spec.md`](./changes/) |
| living spec | [`docs/specs/<cap>/spec.md`](./specs/) |
| archive | [`docs/archive/YYYY-MM-DD-<slug>/`](./archive/) |
| architecture | [`docs/architecture/{README, modules/<m>}.md`](./architecture/README.md) |
| operations | [`docs/operations/{README, <sop>}.md`](./operations/README.md) |
| testing | [`docs/testing/{README, <topic>}.md`](./testing/README.md) |

> 历史上项目曾对 `~/.claude/skills/spec-driven-docs/SKILL.md` 做过扁平化覆盖（project.md / constitution.md 放 `docs/` 根、无 `overview/` 中间层），并把 superpowers skill 的产出放在 `docs/superpowers/`。2026-05-11 docs-restructure 后**全部撤回**，统一对齐 doc-init；superpowers 历史产出已按 topic 归档到 [`archive/`](./archive/)。

## 项目特有扩展

### 已落地的扩展制品

- [`docs/testing/`](./testing/README.md)：因 [`overview/constitution.md` §1](./overview/constitution.md) 「E2E 综合测试覆盖审计」要求 e2e 覆盖矩阵作为硬卡点而落地
- [`docs/operations/`](./operations/README.md)：用于运维 SOP 索引（Docker 部署 / Roadmap 等）

### 暂未落地（按需触发）

- `docs/api/`：当前 client/server 通过 internal protocol 通信，无对外 API 契约；引入对外 RPC/HTTP 时新建
- `docs/security/`：当前由 constitution §2-§3（隔离边界 / 安全约束）覆盖；如出现独立威胁模型再拆
- `docs/observability/` / `docs/performance/` / `docs/release/`：constitution 未触发，暂缓

### 项目特有的运维 SOP 就近规则

当前**所有 SOP 都集中在 [`docs/operations/`](./operations/README.md)**，未启用就近留存（C 选项）。如未来某个代码包的 SOP 涉及代码内部不变式（如 `server/src/file-agent/` 的 cache GC 流程），按 doc-init AGENTS.md §10 判据决定是否就近，并在 `operations/README.md` 中加索引。

### 项目特有的红线（非通用部分）

详见 [`overview/constitution.md`](./overview/constitution.md)。摘要：
- 测试不可绕过、双路径不变量必须 e2e 守护
- Mount namespace 隔离边界（cwd / FUSE / shadow file 等不变式，详见 CLAUDE.md「Filesystem access invariants」）
- 凭证 redaction（server → CC 出口三路必须全 redact，详见归档 [`archive/2026-04-30-shadow-claude-settings-redaction/`](./archive/2026-04-30-shadow-claude-settings-redaction/)）

## 与外部 skill 的集成约束

### 1. superpowers skill 默认路径必须 override

`~/.claude/plugins/.../superpowers/writing-plans/SKILL.md` 与 `superpowers/brainstorming/SKILL.md` 等默认会把产物存到 `docs/superpowers/plans/YYYY-MM-DD-<topic>.md` / `docs/superpowers/specs/...`。skill 本身允许 "user preferences for plan location override this default"。

**项目硬约束**：在 Cerelay 中调用任何 superpowers 产出 skill（brainstorming / writing-plans / writing-specs 等）时，**必须显式 override** 默认路径到 doc-init 制品位置：

| superpowers 默认 | Cerelay 强制路径 |
|---|---|
| `docs/superpowers/plans/<date>-<topic>.md` | `docs/changes/<slug>/tasks.md`（如配套有 change）或 `docs/changes/<slug>/design.md`（设计稿）|
| `docs/superpowers/specs/<date>-<topic>-design.md` | `docs/changes/<slug>/design.md`（在 change 内）；新立 capability 时 `docs/changes/<slug>/specs/<cap>/spec.md` |

**禁止再创建 `docs/superpowers/` 子树**。如发现 skill 产物落在 superpowers 路径下，按以下流程矫正：
1. 立即 `git mv` 到正确位置
2. 修复所有内部相对路径引用
3. 如果是已实现的，归档到 `docs/archive/YYYY-MM-DD-<topic>/`

### 2. spec-driven-docs skill 默认前缀不再覆盖

历史上项目对该 skill 的 `openspec/` 前缀做过覆盖。当前已废除，spec-driven-docs skill 不再被使用——所有 spec/change/archive/decisions 制品由 **doc-init skill** 直接管理在 doc-init 标准路径下。

### 3. CLAUDE.md 与本文件的优先级

| 位置 | 职责 | 谁维护 |
|---|---|---|
| `~/.claude/skills/doc-init/AGENTS.md` | 跨项目通用硬规则（EARS / 分工 / Owner 等） | doc-init skill 维护者 |
| 项目根 [`../CLAUDE.md`](../CLAUDE.md) | 项目级 AI 协作规范、核心技术决策 | 项目 Tech Lead |
| 本文件（[`docs/AGENTS.md`](./AGENTS.md)） | 项目特有文档规约扩展 | 项目 Tech Lead |
| [`overview/constitution.md`](./overview/constitution.md) | 项目红线（治理原则） | 项目架构组 |

冲突时优先级（高 → 低）：用户当下指令 > CLAUDE.md > 本文件 > doc-init AGENTS.md > 默认行为。

## E2E 覆盖审计硬卡点

任何功能开发 / 更新 / 修复完成后（commit 前），必须打开 [`testing/e2e-comprehensive-testing.md`](./testing/e2e-comprehensive-testing.md) §2 覆盖矩阵走三问审计。详见 [`overview/constitution.md` §1](./overview/constitution.md)。

## 强制流程入口

- **新增 capability / 新功能**：建 [`changes/<slug>/`](./changes/) 走 proposal → design → tasks → spec-delta → archive
- **架构决策**：写 [`decisions/NNNN-<topic>.md`](./decisions/)，编号锁定通过编辑 [`decisions/README.md`](./decisions/README.md) 索引表抢占
- **修改 living spec**：必须经过一个 change 的 archive（直接改 [`specs/`](./specs/) 视为违规）
- **写文档前**：doc-init skill 自动加载本文件 + skill AGENTS.md + [`overview/constitution.md`](./overview/constitution.md)
