<!-- doc-init template version: v1.0 -->
# constitution.md — Cerelay 项目宪法

> **Owner**: 项目架构组
> **Reviewers**: 全员（修改红线需要 ≥2 人 review + ADR 记录）

> 本文件定义项目的**治理原则与红线**：测试要求、隔离边界、安全约束、协作流程。
>
> 与 [`project.md`](./project.md) 的区别：project.md 描述事实（系统是什么样），本文件描述要求（系统必须遵守什么）。
>
> **修改规则**：本文件每一条原则都应有出处（用户共识 / 实际事故 / 上游规范）。新增 / 修改 / 删除原则必须通过 change 流程并记录到 ADR。

## 1. 测试治理

### 1.1 E2E 综合测试覆盖审计（硬卡点）

**强制约束**：任何功能开发 / 更新 / 修复完成后（commit 前），必须打开 [`../testing/e2e-comprehensive-testing.md`](../testing/e2e-comprehensive-testing.md) §2 覆盖矩阵，按以下三问审计；不允许"功能合入但矩阵未审计"。

1. 本次变更是否引入了**新的协议字段、新的工具、新的拓扑、新的隔离边界、新的 cache 维度**之一？
2. 如果是，§2.1 / §2.2 / §2.3 是否已有 case 覆盖？
3. 如果未覆盖，**本次 PR 必须同步**：
   - 在矩阵对应阶段表格里加一行（按当前阶段归类 P0 / P1 / P2）
   - 在对应 `phase-pX.test.ts` 加 case；尚未到该阶段则加 `test.todo` 占位 + issue link

豁免：纯注释 / 文档微调 / 内部 refactor 不改外部行为。豁免时在 commit / PR 描述中写 "e2e coverage: N/A — 不引入新协议字段 / 工具 / 拓扑 / 隔离边界 / cache 维度"。

### 1.2 测试不可绕过

- 测试失败 → 定位根因修复，**禁止** `--no-verify` / 注释测试 / 删 lint 规则
- 测试运行使用 `--test-concurrency=1` 防止资源竞争（已写入各 workspace `package.json`）
- 新增工具 / 新增 capability 必须有对应的单元测试 + 集成测试

### 1.3 双路径不变量必须有 e2e 守护

涉及到 Plan D Shadow MCP 双路径（`mcp__cerelay__*` vs hook fallback）的任何改动，必须保留 `e2e-mcp-shadow-bash.test.ts` + `e2e-real-claude-bash.test.ts` 中的 `is_error` 双路径断言。

## 2. 隔离边界

### 2.1 三层隔离不可弱化

| 层 | 边界 | 强制点 |
|---|---|---|
| FUSE file proxy | 仅 Claude 配置范围（`~/.claude/`、`~/.claude.json`、`{cwd}/.claude/`） | 项目源码不允许通过 FUSE 暴露给 CC |
| Mount namespace | 容器内 per-session 隔离的文件系统视图 | `unshare` / `nsenter`，HOME 与 cwd 对齐 Client 上报值 |
| Cache scope | device-only（不再 cwdHash） | 跨 device 不共享，跨 cwd 共享 |

### 2.2 凭证与登录态零穿透

- Server 端凭证仅在 `${CERELAY_DATA_DIR}/credentials/default/.credentials.json`
- shadow file 映射**总是注入**，不得因为文件不存在就跳过
- `~/.claude/settings.json` 登录态字段 redaction 必须发生在 server → namespace 最后一公里（三处出口）
- 不允许信任 Client 侧清洁

### 2.3 cache 数据生命周期

- TTL 必须有限正数；GC 期间跳过 in-flight blob
- 单文件 > 1MB 标记 skipped；单 scope 累计 > 100MB 按 mtime 倒序截断
- 缓存同步失败不阻塞 PTY session 启动（降级穿透模式）

## 3. 红线禁令

### 3.1 不破坏现有功能

修改 / 重构 / 重命名已有代码前，必须：
- `Grep` 调用方
- 读相关测试
- 列出影响面后再动手
- 改完跑一次相关测试确认未破坏

### 3.2 不仅改签名不改调用

修改函数 / 方法 / 类型 / 接口签名时：
- `Grep` 全量调用方
- 同一 PR 内全部更新
- 编译 / 类型检查必须过

### 3.3 不"幻觉"修改

- 用户描述某个 API / 函数 / 配置存在 → 先 `Grep` / `Read` 确认
- 引用第三方库 API → `WebFetch` 官方文档验证语法
- 不确定就问，不要猜

### 3.4 不制造重复

新增工具函数 / 配置项 / 类型定义前：
- `Grep` 关键词找现有实现
- 找到优先复用或扩展，找不到再新增

### 3.5 不盲目执行

- 需求模糊 / 多种合理方案 / 不熟悉的领域 / 跨模块影响 → 使用 `AskUserQuestion` 让用户拍板
- 调研型任务先派 Explore subagent 搜证据

### 3.6 不用绕过取代修复

- 测试失败 / lint 报错 / pre-commit hook 拦截 → 定位根因修复
- 不允许 `--no-verify` / 注释测试 / 删 lint 规则

### 3.7 不破坏性 git 操作不确认

`git push --force` / `git reset --hard` / `git clean -fd` / 删分支 / amend 已发布的 commit 等：
- 先确认操作影响（是否覆盖他人提交、是否丢失未提交改动）
- 除明确指令外必须先问用户

## 4. 协作流程

### 4.1 Spec-Driven Docs 流程

所有非豁免任务必须按 doc-init skill（`~/.claude/skills/doc-init/AGENTS.md` + `workflow.md`）执行：proposal → design → tasks → spec-delta → archive。详见项目 [`../AGENTS.md`](../AGENTS.md)。

豁免清单：
- bug 修复 / typo / 纯格式调整
- 单文件 < 50 行的小改动且不引入新 capability
- 纯重构无功能变化（沿用现有架构）
- 紧急 hotfix（事后可补 proposal 归档）
- 探索 / spike 代码（落地时再补 proposal）
- 用户明确说"快速干"或"不要文档化"

### 4.2 Claude × Codex 方案共创流程

所有实质性任务（编码 / 重构 / 分析 / 决策 / 文档等）默认走 `~/.claude/rules/review-workflow.md`：
- 方案阶段双方并行独立产方案 → 交叉评审（≤3 轮）
- 执行阶段 Codex 主笔，Claude 监工
- 验收阶段双方并行独立评审 → 交叉对齐（≤3 轮）

豁免：`~/.claude` 目录下所有操作；纯信息收集；Codex 不可用时（标注 `[Codex 不可用]`）。

### 4.3 文档规范

- 所有文档使用纯中文（唯一例外是 git commit message / MR title，详见 `~/.claude/rules/git-conventions.md`）
- 标准 Markdown 语法
- 提供可执行代码示例（如适用）
- 图表使用 ASCII 或 Mermaid

## 5. 变更管理

### 5.1 living spec 修改时机

`docs/specs/<capability>/spec.md` 只在 archive 阶段或 baseline 反向生成阶段被修改，其他时候只读。运行中的 change 通过 `docs/changes/<name>/specs/<capability>/spec.md` delta 表达变更意图。

### 5.2 ADR 编号

`docs/decisions/NNNN-<topic>.md`，4 位数字递增，从 0001 起，不跳号、不复用。

### 5.3 archive 命名

`docs/archive/YYYY-MM-DD-<change-name>/`，按归档日期排序。

## 6. 出处与约束依据

| 章节 | 出处 |
|---|---|
| 1.1 E2E 三问 | 项目 CLAUDE.md 顶部硬卡点条款 |
| 2.1 / 2.2 / 2.3 隔离边界 | F4 P2 cross-cwd-fileproxy-isolation 收尾后的事实约束 + Plan D 双路径不变量 |
| 3.x 红线 | 用户全局 CLAUDE.md `~/.claude/CLAUDE.md` 红线禁令 |
| 4.1 / 4.2 / 4.3 流程 | `~/.claude/skills/doc-init/AGENTS.md` + `~/.claude/rules/review-workflow.md` + `~/.claude/rules/git-conventions.md` |
| 5.x 变更管理 | doc-init skill AGENTS.md §5-§7 |
