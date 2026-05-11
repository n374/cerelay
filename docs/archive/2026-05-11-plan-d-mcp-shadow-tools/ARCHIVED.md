<!-- doc-init template version: v1.0 (history archive variant) -->
# Archived: plan-d-mcp-shadow-tools

- **归档日期**: 2026-05-11
- **归档类型**: implementation-done archive
- **原文件**: `docs/plan-d-mcp-shadow-tools.md`（git mv 到 [`./design.md`](./design.md)）
- **关联 commits**: 见 `git log --follow docs/archive/2026-05-11-plan-d-mcp-shadow-tools/design.md`
- **归档原因**: Plan D 已实现并稳定运行；living spec 已建立，本文作为历史设计依据归档

## 当前真理来源

- Living spec：[`../../specs/shadow-mcp-tools/spec.md`](../../specs/shadow-mcp-tools/spec.md)
- 模块文档：[`../../architecture/modules/shadow-mcp.md`](../../architecture/modules/shadow-mcp.md)
- baseline change：[`../2026-05-05-baseline-shadow-mcp-clientcache/`](../2026-05-05-baseline-shadow-mcp-clientcache/)

## 影响 capability

- `shadow-mcp-tools`

## 关联 ADR

无（决策记录直接进了 living spec）

## 红线确认

- 是否触及 constitution 红线：否
- 实现期间 e2e 守护已落地（`e2e-mcp-shadow-bash.test.ts` + `e2e-real-claude-bash.test.ts`），双路径不变量见 living spec

## 一句话总结

通过 inline MCP server 替代 SDK 内置工具，绕开 PreToolUse hook 的 `deny → is_error: true` 协议硬约束，让 cerelay 显式控制工具结果的 `is_error` 字段。
