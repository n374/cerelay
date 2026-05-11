<!-- doc-init template version: v1.0 (history archive variant) -->
# Archived: f4-cross-cwd-fileproxy-isolation

- **归档日期**: 2026-05-11
- **归档类型**: implementation-done archive（原 superpowers spec + plan 体系）
- **原路径**:
  - design: `docs/superpowers/specs/2026-05-02-f4-cross-cwd-fileproxy-isolation-design.md`
  - plan: `docs/superpowers/plans/2026-05-02-f4-cross-cwd-fileproxy-isolation.md`
- **归档原因**: 完整交付 2026-05-05；PR1+PR2 双方 Codex 终审通过；13 task 全部闭环

## 当前真理来源

- 代码：`server/src/file-proxy-manager.ts` + `server/src/file-agent/`
- 测试：`test/e2e-comprehensive/orchestrator/phase-p2*.test.ts` + `server/test/e2e-cross-cwd-and-mutations.test.ts`
- 测试覆盖矩阵入口：[`../../testing/e2e-comprehensive-testing.md` §2.3 P2 backlog](../../testing/e2e-comprehensive-testing.md)
- 模块文档：[`../../architecture/modules/file-agent-cache.md`](../../architecture/modules/file-agent-cache.md)

## 影响 capability

- `client-config-sync`（cross-cwd 维度的隔离 invariant）
- 未来 explicit capability：`cross-cwd-isolation`（待 brownfield baseline change）

## 关联 ADR

无

## 一句话总结

让同 device 多 cwd 下的 FUSE file proxy 行为相互隔离：metadata cache 不互相穿越、blob hit 仍可跨 cwd 复用，确保不同 cwd 看到的 namespace 视图独立。
