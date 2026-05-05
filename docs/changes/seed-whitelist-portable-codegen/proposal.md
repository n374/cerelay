# Proposal: seed-whitelist-portable-codegen

> 位置：`docs/changes/seed-whitelist-portable-codegen/proposal.md`
> 角色：本 change 的入口文档。回答"为什么做"和"做什么"，**不涉及"怎么做"**（那是 plan 的事）。

## Why

### 当前痛点

`server/src/seed-whitelist.ts` 是 server 端 cache-task SyncPlan 的**冷启动种子**——仅在 device 首次连接 / ledger 完全空时作为初始同步范围下发给 client。当前实现是 hand-curated minimal fixture（commit a6d389d），文件首注释明确写了"建议跑 capture 后用真实数据覆写"，但**始终没真跑过**。

2026-05-05 在 `seed-whitelist-portable-codegen` 之前，已经做了一次真实 capture（`CERELAY_CAPTURE_SEED` 模式跑通真 claude CLI，291 个 events 落盘到 `.claude/seed-capture-2026-05-05.json`）。但直接把 capture 数据喂给现有 `scripts/seed-whitelist-codegen.ts` 生成的 `SEED_WHITELIST` 含**强烈环境特化的 path**：

- `projects/-Users-n374-Documents-Code-cerelay-capture-cwd`：capture 时用的临时 cwd 编码
- `projects/-Users-n374-Documents-Code-cerelay-capture-cwd/memory`：同上的子目录
- `plugins/cache/openai-codex/codex/1.0.4/...`：开发者本地装的 codex 插件版本号
- `plugins/cache/superpowers-marketplace/superpowers/5.0.7/...`：开发者本地装的 superpowers 插件版本号
- `skills/bytedcli-tce-single-cluster-deploy`、`skills/spec-driven-docs/...`：开发者私有 skills
- `session-env/<random-uuid>`：单次 session 生成的 uuid

这些 path 跟"CC 二进制启动期硬编码会探测的通用路径"**没有任何关系**——它们只是 capture 当时开发者 home 里凑巧有的内容。直接 commit 进 `seed-whitelist.ts` 等于把开发者本地状态硬编码进 release binary，用户拿到的 cerelay-server 上的冷启动种子会去尝试同步**别人电脑上根本不存在**的 path（虽然 client 端 walkScope 会跳过不存在项不报错，但 SEED_WHITELIST 出现这些 path 是设计错误）。

### 期望状态

1. **codegen 输出 portable**：从 capture 数据生成的 SEED_WHITELIST 只包含**通用** path——CC 二进制硬编码会探测的顶级目录与文件名（`plugins`、`projects`、`sessions`、`backups`、`skills`、`commands`、`agents`、`shell-snapshots` 等），**不依赖**生成时的开发者 home 内容、cwd 名、plugin 版本号、session uuid。
2. **重生成 `SEED_WHITELIST`**：用 portable codegen 处理 `.claude/seed-capture-2026-05-05.json`，覆写 `server/src/seed-whitelist.ts` hand-curated 内容。
3. **codegen 工具可重复使用**：未来 CC 启动期访问形态变了（如 CC 新版加了 `~/.claude/<new-dir>/`），跑一次 capture + codegen 即可重生成，**不需要任何手工裁剪**。

### 为什么现在做

- 上一个 change（`include_dirs` 反转，commit `47493f1`）已经把 capture 数据归档进 `.claude/seed-capture-2026-05-05.json`，但 SEED_WHITELIST 文件本身还是 hand-curated minimal fixture——**两个数据源不一致**。
- 当前 SEED_WHITELIST 的 7 个 subtree（plugins/projects/sessions/backups/statsig/shell-snapshots/todos/session-env）是凭印象列的，跟 capture 真相对照后**有遗漏**（如 `commands` / `agents` / `skills` 不在 hand-curated 里，但 capture 显示 CC 启动期会 readdir 这些）。冷启动种子不全 → 新 device 第一次连接时 sync 范围不全 → 第一次 PTY 启动时 daemon snapshot 缺这些 dir 的 readdir entry → 启动期 readdir 穿透 client。这与 `include_dirs` 反转想解决的问题同源。
- 修这件事不依赖任何上线时间窗口，是**纯内部数据更新 + 工具改进**，可以独立 PR 推进。

## What's Changing

| Capability | 变化类型 | 简述 |
|---|---|---|
| `client-config-sync` | MODIFIED | 增加"SeedWhitelist 必须由真实 capture 通过 portable codegen 反向生成"的约束；列出 portable codegen 必须满足的过滤规则。运行时使用语义不变（仍只在 ledger 空时作冷启动种子）。 |

**不新增 capability**——SEED_WHITELIST 是 `client-config-sync` 已有概念的精确化（之前 living spec 没显式描述它的生成约束）。

## Out of Scope

- **不改 SEED_WHITELIST 的运行时行为**：仍然只在 ledger 完全空时作冷启动种子；ledger 有数据后仍以 ledger 为准。
- **不改 cache_task 协议**：SyncPlan 字段、cache_task_assignment 消息结构都不变。
- **不修 `SyncCoordinator.fetchReaddir` stub**：那是另一个独立 follow-up，需要单独 proposal + Codex 评审（涉及协议级 dispatcher 改动）。
- **不动 client 端 `include_dirs` 默认列表**：已在上一个 change 落地（`47493f1`），跟 SEED_WHITELIST 是两条独立路径（client cache-sync 走 `include_dirs`；server 冷启动种子走 SEED_WHITELIST）。
- **不引入新的 capture 跑批工具**：复用现有 `CERELAY_CAPTURE_SEED` 模式 + 已归档的 `.claude/seed-capture-2026-05-05.json`。

## Stakeholders

| 角色 | 关注点 | Review 必需 |
|---|---|---|
| 用户（n374） | codegen 输出不含个人 home / cwd / plugin 版本特化 path | 是 |
| Codex | dev-tool 改动的正确性、过滤规则是否过严或漏过滤 | 是（按 review-workflow） |

## Success Metrics

1. **覆盖完整性**：重生成后的 `SEED_WHITELIST.scopes["claude-home"].subtrees` 至少覆盖 `include_dirs` 默认列表中所有 readdir-observed 顶级目录（`plugins`、`projects`、`sessions`、`backups`、`skills`、`commands`、`agents`、`shell-snapshots`、`session-env`、`file-history`、`paste-cache`、`cache`、`tasks`、`todos`、`telemetry`、`statsig`、`ide` 中实际被 capture 到 readdir 过的子集）。
2. **portable 不变量**：重生成结果中**不含**任何下列形态的 path：
   - `projects/-<encoded-cwd>` 形态（capture 时的临时 cwd）
   - `plugins/cache/<marketplace>/<plugin>/<version>` 这类版本号深路径（最多保留到 `plugins`）
   - `skills/<specific-skill-name>` 这类用户私有 skill 名（最多保留到 `skills`）
   - `session-env/<uuid>` 形态
   - 任何含 `/Users/<dev-username>/` 或 `/home/<dev-username>/` 残留
3. **可重复运行**：跑两次 codegen（同一 capture 数据）输出**字节级一致**——确认无非确定性。
4. **e2e 不退化**：现有 `test/e2e-comprehensive` 全套 30/30 仍通过。
5. **首次 device 连接体验改进**：在干净 device 上跑一次端到端启动，"FUSE 穿透 client 首次出现" 日志中不再出现 `op=readdir root=home-claude relPath=<cc-标准顶级 dir>`（如 `commands` / `agents` 等当前 SEED_WHITELIST 漏掉的 dir）。

## Clarifications

> 由 Clarify 阶段填充。每个澄清以 Q&A 形式记录。

### Q1: portable 过滤规则的边界——"最多保留到 plugins"还是允许 plugins 第一层子目录？
**A**: 待定。倾向"最多保留到 plugins 顶级"，因为 maxDepth=-1 会自动递归同步；列子目录是冗余且容易脏。
**影响**: codegen 算法的折叠逻辑实现。

### Q2: 哪些路径算"用户私有 skill / plugin 版本号"，需要硬编码白名单还是启发式？
**A**: 待定。倾向启发式——任何 capture path 中的 `<top-level>/<sub>` 当 `<top-level>` 是 `plugins` / `skills` / `commands` / `agents` / `projects` 时，subtree 折叠到 `<top-level>` 顶级；不依赖具体子项名匹配。
**影响**: codegen 折叠规则的具体实现 + 是否需要可配置。

### Q3: SEED_WHITELIST 重生成后是否要在 living spec `docs/specs/client-config-sync/spec.md` 增加章节？
**A**: 待定。倾向**是**——该 living spec 当前没显式描述 SEED_WHITELIST，重生成同时把"SeedWhitelist portable 不变量"补进去。
**影响**: archive 阶段是否有 spec delta merge 工作。

---

**创建于**: 2026-05-06
**当前阶段**: Proposal
