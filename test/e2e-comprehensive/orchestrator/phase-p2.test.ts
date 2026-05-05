// ============================================================
// Phase P2 e2e cases / Phase P2 e2e cases
//
// 当前覆盖:
// - F4-cross-cwd-fileproxy-isolation:F4 P2 case 守 4 条 cross-cwd 隔离深度不变量
//   ((a) fileProxy 三 root 内容不串、(b) 共享 ClientCacheStore 命中污染、
//   (c) cwd-ancestor walk 计算计划不串、(d) project-claude bind mount 严格按 session cwd)
//
// Spec:docs/superpowers/specs/2026-05-02-f4-cross-cwd-fileproxy-isolation-design.md
// Plan:docs/superpowers/plans/2026-05-02-f4-cross-cwd-fileproxy-isolation.md Task 10
// ============================================================
import { test } from "node:test";

const CASE_ID = "case-f4-cross";

/**
 * F4 P2 fixture 内容(spec §5.2 Fixture 与拓扑):
 * 父目录共同祖先 + 兄弟 cwd a/b,各放可识别 marker。
 *
 * 每对 marker(A 与 B)互不重叠,断言用 includes 即可分辨。
 * home fixture(共享 $HOME,不进 fixture 树)由 case 在 homeFixture inline 设。
 */
export const F4_CROSS_FIXTURE_FILES: Record<string, string> = {
  // 共同祖先 — ancestor walk 计算时 A 和 B 都会 prefetch 它
  "CLAUDE.md": "ANCESTOR_SHARED\n",

  // session A cwd 子树
  "a/CLAUDE.md": "ANCESTOR_A_ONLY\n",
  "a/.claude/project-marker.txt": "PROJECT_A_ONLY\n",
  "a/.claude/settings.local.json": JSON.stringify({ f4: "SETTINGS_A_ONLY" }) + "\n",

  // session B cwd 子树
  "b/CLAUDE.md": "ANCESTOR_B_ONLY\n",
  "b/.claude/project-marker.txt": "PROJECT_B_ONLY\n",
  "b/.claude/settings.local.json": JSON.stringify({ f4: "SETTINGS_B_ONLY" }) + "\n",
};

// 实际 case 实现在 T10 落地。本文件 commit 时仅含 fixture 定义 + skeleton。
test.todo("F4-cross-cwd-fileproxy-isolation: 同 device 两 cwd 并发隔离 (T10)");
