<!-- doc-init template version: v1.0 (history archive variant) -->
# Archived: codex-f4-design

- **归档日期**: 2026-05-11
- **归档类型**: 历史设计文档（implementation-done archive）
- **原文件**: `.claude/codex-f4-design.md`
- **归档原因**: F4 阶段（FileAgent + ConfigPreloader）已实装；当前 living 文档 已经覆盖该设计

## 当前真理来源

- 模块文档：[`../../architecture/modules/file-agent-cache.md`](../../architecture/modules/file-agent-cache.md)
- Plan：[`../../archive/2026-05-02-file-agent-and-config-preloader/plan.md`](../../archive/2026-05-02-file-agent-and-config-preloader/plan.md)
- Spec：[`../../archive/2026-05-01-access-ledger-driven-cache/design.md`](../../archive/2026-05-01-access-ledger-driven-cache/design.md)
- 代码：`server/src/file-agent/`、`server/src/config-preloader.ts`

## 影响 capability

- `client-config-sync`（部分）—— FileAgent 是该 capability 的底层实现

## 关联 ADR

无

## 一句话总结

把 Server 侧文件代理从「per-cwd cache + 全量 snapshot」重构为「per-device FileAgent 底座 + 启动期 ConfigPreloader 同步预热 + 运行期双路写入 manifest」。
