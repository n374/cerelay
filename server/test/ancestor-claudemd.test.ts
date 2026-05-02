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
