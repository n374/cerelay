# Proposal: baseline-shadow-mcp-clientcache

> 位置：`docs/changes/baseline-shadow-mcp-clientcache/proposal.md`
> 角色：本 change 是 brownfield baseline 类型——为后续真实 change 反向生成两个 capability 的 living spec，**不实际修改代码**。

## Why

Cerelay 仓库存量代码大、文档分散（CLAUDE.md / `docs/plan-d-mcp-shadow-tools.md` / `docs/superpowers/specs/` / 多处 spec 设计文档），但缺少按 capability 组织的 living spec。下一个真实 change `shadow-mcp-permission-integration` 需要在两个现有 capability 上做 delta（`shadow-mcp-tools` MODIFIED + `client-config-sync` MODIFIED），如果 living spec 不存在，delta 就没有依附点。

按 brownfield 流程的"只为即将动到的部分反向生成 baseline"原则，本 change 仅覆盖这两个 capability，其他能力等后续 change 触达时再分批补。

## What's Changing

| Capability | 动作 | 简述 |
|---|---|---|
| `shadow-mcp-tools` | 反向生成 living spec | 描述 Plan D Shadow MCP 当前实际行为：每 PTY session 注入 routed dispatcher、7 个 shadow tool、双路径 is_error 不变量、tool routing 互斥、fallback 引导、feature flag、降级语义 |
| `client-config-sync` | 反向生成 living spec | 描述 device-only 客户端配置缓存当前实际行为：FileAgent + ConfigPreloader 双层、manifest v3 schema、blob dedup、TTL/GC、pipeline 流控、串行锁、双行进度 UI、FUSE 共享 store |

**新增的 capability**：无（两个 capability 都是反向生成，不是新建）。

## Out of Scope

- **不修改任何代码**。即便反向生成时发现行为与文档描述不一致 / 隐含 bug / 缺测试覆盖，也不在本 change 修复，仅记录到 `plan.md` 的「发现的债务」章节。
- **不覆盖其他 capability**。`mount-namespace-isolation` / `pty-session` / `file-proxy-fuse` / `claude-settings-redaction` / `client-routed-tools` / `mcp-proxy` / `cross-cwd-isolation` 等本批次不做。
- **不重组既有顶层文档**。`docs/architecture.md` / `docs/e2e-comprehensive-testing.md` / `docs/plan-*.md` 等留给独立 change `docs-restructure`。
- **不审计 SKILL 自身**。`~/.claude/skills/spec-driven-docs` 的目录前缀已在批 1 通过项目级覆盖处理，本 change 不再涉及。

## Stakeholders

| 角色 | 关注点 | Review 必需 |
|---|---|---|
| n374（项目所有者） | spec 覆盖范围合理性、与 CLAUDE.md 不变量是否对齐、未来 change 依附性 | 是 |

## Success Metrics

1. `docs/specs/shadow-mcp-tools/spec.md` 与 `docs/specs/client-config-sync/spec.md` 两份 living spec 落盘
2. 每条 Requirement 标注覆盖测试（grep 出对应测试文件）；无对应测试的 Requirement 标注 `[no-test]` 并记入「发现的债务」
3. 本 change 归档后，下一个真实 change `shadow-mcp-permission-integration` 的 spec delta 可以正常按 `MODIFIED` 写入两份 living spec 的对应 Requirement
4. 反向生成的 spec 与 CLAUDE.md / `docs/plan-d-mcp-shadow-tools.md` / `docs/archive/2026-05-02-file-agent-and-config-preloader/plan.md` 中的描述**一致**；如有出入，以**代码现状为准**并在 plan.md 记录差异

---

**创建于**: 2026-05-05
**当前阶段**: Proposal（直接进入 Implement 阶段——baseline change 的特殊性，详见 brownfield.md 第 5 步）
**关联文档**:
- `~/.claude/skills/spec-driven-docs/brownfield.md` — 反向生成方法论
- `docs/README.md` — baseline 覆盖范围声明
- `docs/project.md` §4 — 已知技术债登记
