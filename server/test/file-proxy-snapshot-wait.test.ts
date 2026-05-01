import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * 单元测试 `waitForCacheReadyOrDegraded` 行为，不依赖完整 spawn FUSE daemon
 * 基础设施。复制等待逻辑出来直接测断言（参考 spec §7.2 Defect 1 修复）。
 *
 * Defect 1: snapshot 收集发生在 cache task 进入 ready 之前导致的 fallback 抢跑。
 * 新设计: phase=syncing 时阻塞等 ready, 仅 phase=degraded/idle/不存在 时才 fallback.
 */

type Phase = "idle" | "syncing" | "ready" | "degraded";

interface TaskState {
  exists: boolean;
  phase: Phase | null;
}

class FakeGate {
  private readonly states: TaskState[];
  public describeCalls = 0;

  constructor(states: TaskState[]) {
    this.states = states;
  }

  describeTaskState(_deviceId: string, _cwd: string): TaskState {
    this.describeCalls += 1;
    const idx = Math.min(this.describeCalls - 1, this.states.length - 1);
    return this.states[idx];
  }
}

/** 把 file-proxy-manager 的 waitForCacheReadyOrDegraded 抽出来直测。
 *  实现必须跟产品代码一致 — 测试与产品改动同步。 */
async function waitForCacheReadyOrDegraded(
  gate: FakeGate,
  deviceId: string,
  cwd: string,
  sleepImpl: (ms: number) => Promise<void>,
): Promise<{ phase: Phase | null; exists: boolean; iterations: number }> {
  let iterations = 0;
  while (true) {
    iterations++;
    const state = gate.describeTaskState(deviceId, cwd);
    if (state.phase === "ready") return { ...state, iterations };
    if (!state.exists || state.phase === "degraded" || state.phase === "idle") {
      return { ...state, iterations };
    }
    await sleepImpl(50);
  }
}

const noWait = (_ms: number) => Promise.resolve();

test("phase=ready 立即返回, 不轮询", async () => {
  const gate = new FakeGate([{ exists: true, phase: "ready" }]);
  const result = await waitForCacheReadyOrDegraded(gate, "dev1", "/cwd", noWait);
  assert.equal(result.phase, "ready");
  assert.equal(result.iterations, 1);
});

test("phase=syncing 阻塞等到 ready (Defect 1 修复)", async () => {
  // 序列: syncing, syncing, syncing, ready
  const gate = new FakeGate([
    { exists: true, phase: "syncing" },
    { exists: true, phase: "syncing" },
    { exists: true, phase: "syncing" },
    { exists: true, phase: "ready" },
  ]);
  const result = await waitForCacheReadyOrDegraded(gate, "dev1", "/cwd", noWait);
  assert.equal(result.phase, "ready");
  assert.equal(result.iterations, 4, "应当轮询直到 ready");
});

test("phase=degraded 立即退化, 走 fallback", async () => {
  const gate = new FakeGate([{ exists: true, phase: "degraded" }]);
  const result = await waitForCacheReadyOrDegraded(gate, "dev1", "/cwd", noWait);
  assert.equal(result.phase, "degraded");
  assert.equal(result.iterations, 1);
});

test("phase=idle 立即退化, 走 fallback", async () => {
  const gate = new FakeGate([{ exists: true, phase: "idle" }]);
  const result = await waitForCacheReadyOrDegraded(gate, "dev1", "/cwd", noWait);
  assert.equal(result.phase, "idle");
});

test("task 不存在 (exists=false) 立即返回, 不阻塞", async () => {
  const gate = new FakeGate([{ exists: false, phase: null }]);
  const result = await waitForCacheReadyOrDegraded(gate, "dev1", "/cwd", noWait);
  assert.equal(result.exists, false);
  assert.equal(result.iterations, 1);
});

test("syncing 中转为 degraded 时退化 (不无限阻塞)", async () => {
  const gate = new FakeGate([
    { exists: true, phase: "syncing" },
    { exists: true, phase: "syncing" },
    { exists: true, phase: "degraded" },
  ]);
  const result = await waitForCacheReadyOrDegraded(gate, "dev1", "/cwd", noWait);
  assert.equal(result.phase, "degraded");
  assert.equal(result.iterations, 3);
});
