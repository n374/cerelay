<!-- doc-init template version: v1.0 (history archive variant) -->
# Archived: shadow-claude-settings-redaction

- **归档日期**: 2026-05-11
- **归档类型**: implementation-done archive（原 superpowers spec 体系）
- **原路径**: `docs/superpowers/specs/2026-04-30-shadow-claude-settings-login-state-design.md`
- **归档原因**: spec 自带 status 字段为"方案已对齐，待实施"已 stale；`server/src/claude-settings-redaction.ts` 已实装，三处 server→CC 出口（启动 snapshot / 运行时 cache 命中 / 运行时 Client 穿透）全部走 redaction

## 当前真理来源

- 代码：`server/src/claude-settings-redaction.ts`
- 架构模块文档：[`../../architecture/modules/session-runtime.md` §Login-state 字段 redaction](../../architecture/modules/session-runtime.md#login-state-字段-redaction)
- 项目根 [`../../../CLAUDE.md`](../../../CLAUDE.md) 「Filesystem access invariants」段
- 单元测试：`server/test/claude-settings-redaction.test.ts`、`server/test/file-proxy-redact-site.test.ts`

## 影响 capability

- `client-config-sync`（出口 redaction 部分；当前作为 implicit invariant 写在 living spec 里）
- 未来 explicit capability：`claude-settings-redaction`（待 brownfield baseline change 反向补 spec）

## 未结口子

- `~/.claude.json` 中的同类字段（`apiKeyHelper` / `oauthAccount` 等）**暂不过滤**——详见本文档 §9.1。若实现该过滤，请同步更新代码并新起 change

## 关联 ADR

无

## 一句话总结

在 server → CC mount namespace 出口加字段级 redaction 过滤器，剔除 `~/.claude/settings.json` 中 `env.ANTHROPIC_BASE_URL` / `env.ANTHROPIC_API_KEY` / `env.ANTHROPIC_AUTH_TOKEN` / `apiKeyHelper` 4 个登录态字段，三路出口必须全 redact。
