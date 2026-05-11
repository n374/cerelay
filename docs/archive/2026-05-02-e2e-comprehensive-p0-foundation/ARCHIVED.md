<!-- doc-init template version: v1.0 (history archive variant) -->
# Archived: e2e-comprehensive-p0-foundation

- **归档日期**: 2026-05-11
- **归档类型**: implementation-done archive（原 superpowers plan 体系）
- **原路径**: `docs/superpowers/plans/2026-05-02-e2e-comprehensive-p0-a-foundation.md`
- **归档原因**: P0-A foundation 已落地——`docker-compose.e2e.yml` + `Dockerfile.e2e-*` + `test/e2e-comprehensive/orchestrator/phase-p0*.test.ts` 全部存在且跑通；现处于 P1 推进阶段

## 当前真理来源

- 代码：`test/e2e-comprehensive/orchestrator/` + `docker-compose.e2e.yml` + `Dockerfile.e2e-{orchestrator,client-agent,mock-anthropic}`
- 上游 spec：[`../../testing/e2e-comprehensive-testing.md`](../../testing/e2e-comprehensive-testing.md)
- 入口文档：[`../../testing/README.md`](../../testing/README.md)

## 影响 capability

无 explicit 关联 capability（属于测试基础设施）

## 关联 ADR

无

## 一句话总结

立起 `docs/testing/e2e-comprehensive-testing.md` §3 描述的全链路 e2e 框架（orchestrator + mock-anthropic + server + N×client + thin agent），跑通 2 个 canary case（A1-bash-basic、B4-ancestor-claudemd）证明框架闭环 + 守住 IFS bug 类 regression。
