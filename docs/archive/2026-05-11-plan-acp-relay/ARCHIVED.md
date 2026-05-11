<!-- doc-init template version: v1.0 (history archive variant) -->
# Archived: plan-acp-relay

- **归档日期**: 2026-05-11
- **归档类型**: deprecated archive
- **原文件**:
  - `docs/plan-acp-relay.md` → [`./design.md`](./design.md)
  - `.claude/acp-research.md` → [`./research.md`](./research.md)
- **状态**: **deprecated** —— ACP relay 未在主 src 上落地；`client/dist/acp` 仅存历史构建残留，`client/src/` / `server/src/` 已无 ACP 实现

## 当前真理来源

- 无主 src 实现（capability 未落地）
- 协议参考（保留）：[`../../architecture/modules/acp-editor-integration.md`](../../architecture/modules/acp-editor-integration.md)（标 ⚠️ 历史文档）

## 归档原因

1. ACP 路径在当前 main 上**未启用**：`client/src` 中没有 acp 入口、`server/src` 中没有对应 relay 实现
2. 早期 POC 阶段的设计稿，方向已被「TypeScript + Claude Agent SDK 直连」（选项 C）替代
3. 关联的研究笔记（`research.md`）也一并归档至本目录

## 内容

- [`design.md`](./design.md)：ACP relay 完整设计稿（620 行；含协议、cerelay-client/server 改造、实现任务分解）
- [`research.md`](./research.md)：ACP 协议早期研究笔记（原 `.claude/acp-research.md`）

## 如未来重新启动 ACP 集成

- 起点参考：本目录 + [`../../architecture/modules/acp-editor-integration.md`](../../architecture/modules/acp-editor-integration.md)（保留的协议参考）
- 必须重新走 change 流程（proposal → design → tasks → spec-delta → archive），不可直接复用本设计稿（措辞已陈旧 / hand 命名已废弃 / 部分接口设计可能已不适用）

## 影响 capability

无（未落地）

## 关联 ADR

无

## 一句话总结

让编辑器（Zed / VS Code）通过 ACP stdio 协议把 Cerelay 当 Claude Code 用的 relay 方案；未实施。
