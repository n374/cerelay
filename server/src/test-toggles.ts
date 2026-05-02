// ============================================================
// 测试用 process-global toggles（仅 e2e meta-test 使用）
//
// 用途：phase-p0-meta.test.ts 故意"引入 regression"验证 P0 case 能拦住。
// 例如把 redact 关掉、把 ancestor IFS bug 重新注入。生产不应该读这些 flag。
//
// 安全约束：
//   - 仅当 CERELAY_ADMIN_EVENTS=true（仅在 e2e compose 设置）时，
//     /admin/test-toggles 端点才挂载（参考 admin-events 同模式）
//   - flag 默认全 false；只有 e2e meta-test 主动 POST 才会变更
//   - meta-test 跑完必须 reset 回 false，避免污染同 process 的后续测试
// ============================================================

interface TestToggles {
  /** true → file-proxy 三处 redact 出口直接回原文（meta-redact-leak 用）。 */
  disableRedact: boolean;
  /**
   * true → claude-session-runtime 生成 bootstrap.sh 时在 ancestor 段前注入
   * `_old_ifs="$IFS"`（meta-ifs-bug 用，触发 set -u + IFS unset 退出）。
   */
  injectIfsBug: boolean;
}

const state: TestToggles = {
  disableRedact: false,
  injectIfsBug: false,
};

export function getTestToggles(): Readonly<TestToggles> {
  return state;
}

export function setTestToggles(patch: Partial<TestToggles>): TestToggles {
  if (patch.disableRedact !== undefined) state.disableRedact = patch.disableRedact;
  if (patch.injectIfsBug !== undefined) state.injectIfsBug = patch.injectIfsBug;
  return { ...state };
}

export function resetTestToggles(): void {
  state.disableRedact = false;
  state.injectIfsBug = false;
}
