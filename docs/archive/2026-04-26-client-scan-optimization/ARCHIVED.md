<!-- doc-init template version: v1.0 (history archive variant) -->
# Archived: client-scan-optimization

- **归档日期**: 2026-05-11
- **归档类型**: implementation-done archive（原 superpowers spec 体系）
- **原路径**: `docs/superpowers/specs/2026-04-26-client-scan-optimization-design.md`
- **归档原因**: spec 自带 status 字段为"待实施"已 stale；2026-05-05 起 `include_dirs` 白名单语义反转已落地（见 commit `47493f1`），相关测试覆盖在 `client/test/config.test.ts`

## 当前真理来源

- 代码：`client/src/config.ts`（`DEFAULT_INCLUDE_DIRS` + `createScanFilter`）
- 测试：`client/test/config.test.ts`
- 架构模块文档：[`../../architecture/modules/file-agent-cache.md` §5](../../architecture/modules/file-agent-cache.md#5-扫描范围include_dirs-白名单--exclude_dirs-黑名单)
- 项目根 [`../../../CLAUDE.md`](../../../CLAUDE.md) 「Client 文件缓存 → 扫描范围」段

## 影响 capability

- `client-config-sync`（扫描过滤规则部分）

## 关联 ADR

无

## 一句话总结

把 client 端 `~/.claude/` 扫描默认从黑名单（exclude_dirs）反转为白名单（include_dirs），列表来自一次真实 CC 启动期 capture，避免 hand-curate 漂移。
