<!-- doc-init template version: v1.0 (history archive variant) -->
# Archived: multi-worktree-test-isolation

- **归档日期**: 2026-05-11
- **归档类型**: implementation-done archive（原 superpowers spec 体系）
- **原路径**: `docs/superpowers/specs/2026-05-01-multi-worktree-test-isolation-design.md`
- **归档原因**: spec 自带 status 为"用户已批准，进入执行阶段"——`docker-compose.test.yml` 与相关脚本已落地；多 worktree 测试并发隔离已生效

## 当前真理来源

- 代码：`docker-compose.test.yml` / `test/run-e2e-comprehensive.sh` / `test/run-e2e-comprehensive-meta.sh`
- 通用约束：`--test-concurrency=1`（详见 `package.json` 各 workspace script）

## 影响 capability

无 explicit 关联 capability（属于工程基础设施改进，不在反向 spec 范围内）

## 关联 ADR

无

## 一句话总结

通过 git worktree + dynamic compose project name + 自动 GC 残留资源，实现多 worktree 测试并发零冲突；`server:up` 常规调试路径行为完全不变。
