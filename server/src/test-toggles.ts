// ============================================================
// 测试用 process-global toggles（仅 e2e meta-test 使用）
//
// !!!! DO NOT IMPORT FROM PRODUCTION CODE PATHS WITHOUT GATE !!!!
//
// 用途：phase-p0-meta.test.ts 故意"引入 regression"验证 P0 case 能拦住。
// 例如把 redact 关掉、把 ancestor IFS bug 重新注入。
//
// 生产约束（I3 加固）：
//   - getTestToggles 在生产路径**只允许返回默认全 false 状态**——文件级 const state
//     初始化为全 false，setTestToggles 加了 runtime assert（必须 CERELAY_ADMIN_EVENTS=true
//     才允许写）。即使 production code 误 import getTestToggles，也只能拿到默认值。
//   - 真正的运行期 toggle 改写仅在 e2e（CERELAY_ADMIN_EVENTS=true + admin endpoint
//     /admin/test-toggles）路径上发生。
//   - 生产模块（file-proxy-manager.ts / claude-session-runtime.ts）依然 import
//     getTestToggles 是有意为之——这是单文件实现 e2e 故意放水的最简方案。如果未来
//     要做完全 DI 重构，参见 docs §11.2 I3 备选方案。
// ============================================================

interface TestToggles {
  /** true → file-proxy 三处 redact 出口直接回原文（meta-redact-leak 用）。 */
  disableRedact: boolean;
  /**
   * true → claude-session-runtime 生成 bootstrap.sh 时在 ancestor 段前注入
   * `_old_ifs="$IFS"`（meta-ifs-bug 用，触发 set -u + IFS unset 退出）。
   */
  injectIfsBug: boolean;
  /**
   * INF-8：tool relay 超时注入。null = 不注入(沿用 DEFAULT_TOOL_TIMEOUT_MS=120s);
   * { ms: 50, toolName: "mcp__cerelay__bash" } = 强制下次 toolName 匹配的工具
   * relay 等待 50ms 后超时(给 G1-tool-timeout 用)。
   * - toolName 缺省 = 任意工具都匹配(慎用)
   * - toolName 提供 = 精确匹配，全等比较
   */
  injectToolTimeout: { ms: number; toolName?: string } | null;
  /**
   * F4 P2 meta failure case 用：在 CERELAY_ADMIN_EVENTS=true + toggle 非空时，
   * 故意把 fromCwd session 的 project-claude root 错挂到 toCwd，
   * 验证 assertF4CrossCwdIsolation 能捕获 (a)/(d) 不变量违反。
   * 生产路径：双重 gate（env + toggle 字段非空）确保零开销。
   */
  injectCrossCwdRootCollision: { fromCwd: string; toCwd: string } | null;
}

const state: TestToggles = {
  disableRedact: false,
  injectIfsBug: false,
  injectToolTimeout: null,
  injectCrossCwdRootCollision: null,
};

/**
 * 生产路径与测试路径都可以调；生产路径只会拿到默认全 false 状态（因为
 * setTestToggles 在生产路径会 throw，state 永远不会被改）。
 */
export function getTestToggles(): Readonly<TestToggles> {
  return state;
}

/**
 * I3 加固：runtime assert——只允许在 CERELAY_ADMIN_EVENTS=true 时改 toggle。
 *
 * 为什么不在 import 时 assert：file-proxy-manager.ts / claude-session-runtime.ts
 * 在生产 path 也 import 这个模块来 read state（getTestToggles），生产 read 拿默认
 * false 是合法的。真正不允许的是"生产路径写 state"——所以 assert 放在 setter。
 *
 * `process.env.NODE_ENV === "test"` 也被允许（server unit test 用，无 CERELAY_ADMIN_EVENTS env）。
 */
function assertWritable(): void {
  if (process.env.CERELAY_ADMIN_EVENTS === "true") return;
  if (process.env.NODE_ENV === "test") return;
  throw new Error(
    "test-toggles: setTestToggles/resetTestToggles 仅允许在 CERELAY_ADMIN_EVENTS=true 或 NODE_ENV=test 时调用。" +
      "生产路径误调 = 测试用放水开关被打开，应当 throw 暴露问题。",
  );
}

export function setTestToggles(patch: Partial<TestToggles>): TestToggles {
  assertWritable();
  if (patch.disableRedact !== undefined) state.disableRedact = patch.disableRedact;
  if (patch.injectIfsBug !== undefined) state.injectIfsBug = patch.injectIfsBug;
  if (patch.injectToolTimeout !== undefined) state.injectToolTimeout = patch.injectToolTimeout;
  if (patch.injectCrossCwdRootCollision !== undefined) state.injectCrossCwdRootCollision = patch.injectCrossCwdRootCollision;
  return { ...state };
}

export function resetTestToggles(): void {
  assertWritable();
  state.disableRedact = false;
  state.injectIfsBug = false;
  state.injectToolTimeout = null;
  state.injectCrossCwdRootCollision = null;
}
