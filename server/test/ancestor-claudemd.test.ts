import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMountNamespaceEnvForTest,
  renderNamespaceBootstrapScript,
} from "../src/claude-session-runtime.js";
import { PYTHON_FUSE_HOST_SCRIPT } from "../src/fuse-host-script.js";

test("bootstrap script binds ancestor CLAUDE files from cwd-ancestor roots", () => {
  const script = renderNamespaceBootstrapScript();

  assert.match(script, /CERELAY_ANCESTOR_DIRS/);
  assert.match(script, /cwd-ancestor-\$_anc_level/);
  assert.match(script, /CLAUDE\.md/);
  assert.match(script, /CLAUDE\.local\.md/);
  assert.match(script, /ancestor dir is fs root, skip/);
});

// 回归守护：bootstrap 顶层 \`set -eu\` 下，view-roots 段会在用完后 \`unset IFS\`。
// 之后 ancestor 段如果再用 \`_old_ifs="$IFS"\` 保存 IFS，nounset 会触发
// "IFS: parameter not set" 直接退出 → 整个 PTY session 启动失败。
// 该测试确保以后没人重新引入这个反模式。
test("bootstrap script never reads $IFS after the view-roots unset", () => {
  const script = renderNamespaceBootstrapScript();

  assert.ok(
    script.includes("set -eu"),
    "bootstrap 必须保留 set -eu（这是 IFS 反模式触发的前提）"
  );
  assert.ok(
    !/_old_ifs="\$IFS"/.test(script),
    "禁止再用 _old_ifs=\"$IFS\" 保存 IFS（unset 后访问会触发 IFS: parameter not set）"
  );
  // 顶层只有 view-roots 段在用 IFS，且必须以 unset 结束；ancestor 段同理。
  const ifsAssignments = script.match(/^\s*IFS=/gm) ?? [];
  const ifsUnsets = script.match(/^\s*unset IFS\b/gm) ?? [];
  assert.equal(
    ifsAssignments.length,
    ifsUnsets.length,
    `每次设置 IFS 后必须有配对的 unset IFS 还原默认（设置 ${ifsAssignments.length} 次，unset ${ifsUnsets.length} 次）`
  );
});

test("mount namespace env includes colon-joined ancestor dirs", () => {
  const env = buildMountNamespaceEnvForTest({
    runtimeRoot: "/runtime/session",
    readyFile: "/runtime/session/ready",
    cwd: "/Users/foo/work/project",
    clientHomeDir: "/Users/foo",
    viewRoots: ["Users"],
    projectSettingsLocalShadowPath: "/shadow/settings.local.json",
    fuseRootDir: "/runtime/session/fuse",
  });

  assert.equal(env.CERELAY_ANCESTOR_DIRS, "/Users/foo/work/project:/Users/foo/work");
});

test("mount namespace env uses empty ancestor dirs when cwd equals home", () => {
  const env = buildMountNamespaceEnvForTest({
    runtimeRoot: "/runtime/session",
    readyFile: "/runtime/session/ready",
    cwd: "/Users/foo",
    clientHomeDir: "/Users/foo",
    viewRoots: ["Users"],
  });

  assert.equal(env.CERELAY_ANCESTOR_DIRS, "");
});

test("fuse host restricts cwd-ancestor roots to allowed Claude files", () => {
  assert.match(PYTHON_FUSE_HOST_SCRIPT, /ANCESTOR_ROOT_ALLOWED_FILES/);
  assert.match(PYTHON_FUSE_HOST_SCRIPT, /root_name\.startswith\("cwd-ancestor-"\)/);
  assert.match(PYTHON_FUSE_HOST_SCRIPT, /rel_path not in ANCESTOR_ROOT_ALLOWED_FILES/);
  assert.match(PYTHON_FUSE_HOST_SCRIPT, /return \["\.", "\.\."\] \+ list\(ANCESTOR_ROOT_ALLOWED_FILES\)/);
});
