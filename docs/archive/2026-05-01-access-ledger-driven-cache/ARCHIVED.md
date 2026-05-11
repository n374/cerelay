<!-- doc-init template version: v1.0 (history archive variant) -->
# Archived: access-ledger-driven-cache

- **归档日期**: 2026-05-11
- **归档类型**: implementation-done archive（原 superpowers spec + plan 体系）
- **原路径**:
  - design: `docs/superpowers/specs/2026-05-01-access-ledger-driven-cache-design.md`
  - plan: `docs/superpowers/plans/2026-05-01-access-ledger-driven-cache.md`
- **归档原因**: 7 个 Phase 全部落地（commits `9aba1e2` → `1610514`，server 305 tests / 300 pass / 5 skipped）

## 当前真理来源

- 代码：`server/src/file-agent/` + `server/src/file-proxy-manager.ts` + `server/src/config-preloader.ts`
- 模块文档：[`../../architecture/modules/file-agent-cache.md`](../../architecture/modules/file-agent-cache.md)
- Living spec：[`../../specs/client-config-sync/spec.md`](../../specs/client-config-sync/spec.md)
- 后续重构归档：[`../2026-05-02-file-agent-and-config-preloader/`](../2026-05-02-file-agent-and-config-preloader/)（FileAgent 底座抽象 + ConfigPreloader 分层 + device-only 化）

## 影响 capability

- `client-config-sync`

## 关联 ADR

无（决策直接进了 living spec）

## 一句话总结

把 Server 侧文件代理重构为 access-ledger 驱动：启动期发 ledger snapshot + 运行期增量 sync，修复 phase_syncing 抢跑、持久化 missing 路径、cwd-ancestor `CLAUDE.md` 覆盖。
