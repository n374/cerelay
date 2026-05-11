<!-- doc-init template version: v1.0 -->
# 归档索引 / Archive Index

> 本目录承载已归档的 change 与历史文档。条目按日期前缀命名（`YYYY-MM-DD-<slug>`）。

## 归档列表（按日期倒序）

| 日期 | Slug | 类型 | 一句话 |
|---|---|---|---|
| 2026-05-11 | [`2026-05-11-plan-d-mcp-shadow-tools/`](./2026-05-11-plan-d-mcp-shadow-tools/) | implementation-done | Plan D 历史设计稿（已实现；living spec 在 [`../specs/shadow-mcp-tools/`](../specs/shadow-mcp-tools/)） |
| 2026-05-11 | [`2026-05-11-plan-acp-relay/`](./2026-05-11-plan-acp-relay/) | deprecated | ACP relay 设计稿（未落地；与早期 ACP 研究笔记一起归档） |
| 2026-05-11 | [`2026-05-11-handover-go-era/`](./2026-05-11-handover-go-era/) | outdated | Go 时代交接文档（已被 TS + SDK 直连架构替代） |
| 2026-05-11 | [`2026-05-11-codex-f4-design/`](./2026-05-11-codex-f4-design/) | implementation-done | F4 阶段 FileAgent + ConfigPreloader 设计稿（已实装） |
| 2026-05-05 | [`2026-05-05-baseline-shadow-mcp-clientcache/`](./2026-05-05-baseline-shadow-mcp-clientcache/) | baseline change | 反向生成 `shadow-mcp-tools` + `client-config-sync` 两个 capability 的 living spec |
| 2026-05-02 | [`2026-05-02-file-agent-and-config-preloader/`](./2026-05-02-file-agent-and-config-preloader/) | implementation-done（原 superpowers plan） | FileAgent 底座 + ConfigPreloader 分层 + device-only 化 |
| 2026-05-02 | [`2026-05-02-f4-cross-cwd-fileproxy-isolation/`](./2026-05-02-f4-cross-cwd-fileproxy-isolation/) | implementation-done（原 superpowers spec+plan） | cross-cwd FUSE file proxy 隔离深度的 4 条不变量 + P2 e2e case 守护 |
| 2026-05-02 | [`2026-05-02-e2e-comprehensive-p0-foundation/`](./2026-05-02-e2e-comprehensive-p0-foundation/) | implementation-done（原 superpowers plan） | 立起全链路 e2e 框架（orchestrator + mock-anthropic + server + N×client + thin agent）并跑通 2 个 canary case |
| 2026-05-01 | [`2026-05-01-access-ledger-driven-cache/`](./2026-05-01-access-ledger-driven-cache/) | implementation-done（原 superpowers spec+plan） | access-ledger 驱动的统一启动期文件加速架构 |
| 2026-05-01 | [`2026-05-01-multi-worktree-test-isolation/`](./2026-05-01-multi-worktree-test-isolation/) | implementation-done（原 superpowers spec） | 多 worktree 测试并发零冲突 + 自动 GC 残留资源 |
| 2026-04-30 | [`2026-04-30-shadow-claude-settings-redaction/`](./2026-04-30-shadow-claude-settings-redaction/) | implementation-done（原 superpowers spec） | server → CC 出口 settings.json 登录态字段 redaction |
| 2026-04-26 | [`2026-04-26-client-scan-optimization/`](./2026-04-26-client-scan-optimization/) | implementation-done（原 superpowers spec） | client 扫描默认从黑名单反转为白名单（include_dirs） |

## 归档类型说明

| 类型 | 含义 |
|---|---|
| `baseline change` | 反向补 spec 的 brownfield change |
| `change` | 标准 spec-driven change 完成后的归档 |
| `implementation-done` | 历史设计 / plan 文档；已实现并有 living 真理来源 |
| `deprecated` | 设计稿未落地或已废弃 |
| `outdated` | 过时但有史料价值（架构演进史） |

## 归档流程

详见 `~/.claude/skills/doc-init/references/archive-flow.md` 与 [`templates/archive-checklist.md`](file:///Users/n374/.claude/skills/doc-init/templates/archive-checklist.md)。

## 关联资源

- [Living capability specs](../specs/README.md)
- [Decisions / ADRs](../decisions/README.md)
- [文档规约](../AGENTS.md)
