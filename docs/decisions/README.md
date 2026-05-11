<!-- doc-init template version: v1.0 -->
# 架构决策记录 / Architecture Decision Records

> 本目录承载 Cerelay 的 ADR。每个 ADR 一份独立文件，命名 `NNNN-<topic>.md`，4 位编号**不跳号、不复用**。

## 命名与编号规则

- 正式编号 `NNNN`（从 `0001` 起）通过编辑下方「编号锁定表」抢占
- 草稿期使用 `9XXX-DRAFT-<topic>.md`；合入时由 doc-init skill 重命名为正式编号
- 并发情况下，先 PR 锁定编号者拿号，后写者顺延

## 编号锁定表

| 编号 | 状态 | 主题 | Owner | 链接 |
|---|---|---|---|---|
| 0001 | （未占用） | | | |

> 当前项目历史决策大量散落在 CLAUDE.md「核心技术决策」与既有 spec 中；未来正式立 ADR 时按 doc-init AGENTS.md §8 走，依次填充本表。

## 模板

新增 ADR 时使用 `~/.claude/skills/doc-init/templates/adr.md`，每个 ADR 必须包含：
- Owner（决策者）
- Context（背景）
- Decision（决策）
- Consequences（后果，含正面 / 负面）
- 关联 capability spec / change

## 关联资源

- [架构总览](../architecture/README.md)
- [项目宪法](../overview/constitution.md)
- [文档规约](../AGENTS.md)
