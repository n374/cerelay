<!-- doc-init template version: v1.0 -->
# Testing

> **Owner**: QA / 全员（e2e 覆盖矩阵审计是项目级硬卡点）

## 文档地图

| 主题 | 文件 | 提要 |
|---|---|---|
| E2E 综合测试 | [`e2e-comprehensive-testing.md`](./e2e-comprehensive-testing.md) | 全链路 e2e 综合测试（多容器：真 server + N 真 client + mock anthropic + orchestrator）；P0/P1/P2 三阶段覆盖矩阵；强制审计约束 |

## 强制约束（E2E 覆盖审计硬卡点）

任何功能开发 / 更新 / 修复完成后（commit 前），必须打开 [`e2e-comprehensive-testing.md`](./e2e-comprehensive-testing.md) §2 覆盖矩阵走三问审计：

1. 本次变更是否引入了**新的协议字段、新的工具、新的拓扑、新的隔离边界、新的 cache 维度**之一？
2. 如果是，§2.1 / §2.2 / §2.3 是否已有 case 覆盖？
3. 如果未覆盖，**本次 PR 必须同步**：
   - 在矩阵对应阶段表格里加一行（按当前阶段归类 P0/P1/P2）
   - 在对应 `phase-pX.test.ts` 加 case；尚未到该阶段则加 `test.todo` 占位 + issue link

豁免：纯注释 / 文档微调 / 内部 refactor 不改外部行为。豁免时在 commit / PR 描述中写 `e2e coverage: N/A — 不引入新协议字段 / 工具 / 拓扑 / 隔离边界 / cache 维度`。

详见 [`../overview/constitution.md`](../overview/constitution.md) §1.1。

## 测试栈

- 单元测试：Node.js 原生 `node --test`，位置 `**/test/*.test.ts`
- 集成 / e2e：见 [`e2e-comprehensive-testing.md`](./e2e-comprehensive-testing.md) 与 [`../architecture/README.md`](../architecture/README.md) §9
- 并发约束：`--test-concurrency=1`（PTY / unix socket / FUSE 等资源易踩踏）

## 关联资源

- [架构总览 §9 测试架构](../architecture/README.md#9-测试架构--testing-architecture)
- [项目宪法 §1 测试治理](../overview/constitution.md)
- [文档规约](../AGENTS.md)
