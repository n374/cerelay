<!-- doc-init template version: v1.0 -->
# Capability Specs 索引

> 本目录承载 Cerelay 各 capability 的 **living spec**（source of truth）。每个 capability 一份独立目录，`spec.md` 为入口。
> Living spec 修改必须通过 change 流程：在 `changes/<slug>/specs/<cap>/spec.md` 写 delta，归档时合并到 living spec。**禁止直接编辑本目录下的 spec.md。**

## ⚠️ Baseline 覆盖范围

**当前 living spec 只覆盖下表中的 capability，不是仓库现状的全量收集。**

其他能力（`mount-namespace-isolation` / `pty-session` / `file-proxy-fuse` / `claude-settings-redaction` / `client-routed-tools` / `mcp-proxy` / `cross-cwd-isolation` 等）尚未反向生成 spec。后续触达这些能力时按 brownfield 流程**单独走一个 baseline change** 反向补齐——参考已有案例 [`../archive/2026-05-05-baseline-shadow-mcp-clientcache/`](../archive/2026-05-05-baseline-shadow-mcp-clientcache/)，流程套用 doc-init AGENTS.md §5（change 治理）+ §6（archive 流程）。

如发现现有 spec 与代码实际行为不一致，**以代码为准**，通过新的 change 更新 spec。

## Capability 索引

| Capability | 入口 | 描述 | Baseline change |
|---|---|---|---|
| `shadow-mcp-tools` | [`shadow-mcp-tools/spec.md`](./shadow-mcp-tools/spec.md) | 通过 inline MCP server 替代 SDK 内置工具，让 `is_error` 由 cerelay 显式控制（Plan D 落地） | `archive/2026-05-05-baseline-shadow-mcp-clientcache` |
| `client-config-sync` | [`client-config-sync/spec.md`](./client-config-sync/spec.md) | Client → Server 的 `~/.claude/` & `~/.claude.json` 配置同步（device-only 缓存维度） | `archive/2026-05-05-baseline-shadow-mcp-clientcache` |

## 新增 capability 流程

1. 起 change：`docs/changes/<slug>/` + `proposal.md` + `design.md` + `tasks.md`
2. 在 `changes/<slug>/specs/<new-cap>/spec.md` 写完整 spec（首次创建即等价于 ADDED）
3. archive 时把 `changes/<slug>/specs/<new-cap>/spec.md` move 到 `specs/<new-cap>/spec.md`

## 关联资源

- [文档规约](../AGENTS.md)
- [项目宪法](../overview/constitution.md)
- [架构总览](../architecture/README.md)
- 进行中的 changes：[`../changes/`](../changes/)
- 已归档变更：[`../archive/`](../archive/)
