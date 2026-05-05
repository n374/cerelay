// ============================================================
// Phase P2 共享 fixture 定义
//
// 抽到独立文件防止 meta case import 主 case 时触发 node:test 自动注册。
// 之前 phase-p2-meta.test.ts `import { F4_CROSS_FIXTURE_FILES } from './phase-p2.test.js'`
// 会让 phase-p2 主 case 的 test() 也在 meta script 进程内注册执行,造成 isolation 污染。
//
// Spec:docs/superpowers/specs/2026-05-02-f4-cross-cwd-fileproxy-isolation-design.md §5.2
// ============================================================

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
