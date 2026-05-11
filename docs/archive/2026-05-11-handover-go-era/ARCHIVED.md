<!-- doc-init template version: v1.0 (history archive variant) -->
# Archived: handover-go-era

- **归档日期**: 2026-05-11
- **归档类型**: 过时交接文档（outdated archive）
- **原文件**: `.claude/HANDOVER.md`（最后更新 2026-04-05）
- **归档原因**: 文档描述的还是 Go 时代 + ACP bridge 架构，已被「选项 C：TypeScript Server + Claude Agent SDK 直接集成」替代；保留作为架构演进史料

## 当前架构真理来源

- 项目根 [`../../../CLAUDE.md`](../../../CLAUDE.md)：项目总览 + 核心技术决策
- [`../../architecture/README.md`](../../architecture/README.md)：技术架构主文档
- [`../../overview/project.md`](../../overview/project.md)：项目 worldview

## 影响 capability

无（架构整体演进，与单 capability 无关）

## 关联 ADR

无（架构切换发生在 spec-driven 体系建立前；后续如需追溯请看本归档的 design + project.md「与 CLAUDE.md 的关系」段）

## 一句话总结

记录了 Cerelay 早期 Go 实现 + ACP bridge 阶段的交接信息；现已切换到 TypeScript + SDK 直连。
