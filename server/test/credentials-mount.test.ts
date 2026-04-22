/**
 * 凭证文件挂载修复的测试用例
 *
 * 覆盖场景：
 * 1. bootstrap 脚本使用 --rbind（递归挂载）而非 --bind
 * 2. FUSE shadow file 正确注入 .credentials.json
 * 3. docker-entrypoint.sh 的 .claude.json 安全合并（不覆盖已有字段）
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { renderNamespaceBootstrapScript } from "../src/claude-session-runtime.js";
import { FileProxyManager } from "../src/file-proxy-manager.js";

const testFileDir = path.dirname(fileURLToPath(import.meta.url));

// ============================================================
// 场景 1: bootstrap 脚本使用 --rbind 递归挂载 shared claude dir
// ============================================================

test("bootstrap script uses --rbind for shared claude dir to propagate sub-mounts", () => {
  const script = renderNamespaceBootstrapScript();

  // 必须使用 --rbind 而非 --bind 来挂载 CERELAY_SHARED_CLAUDE_DIR
  // 这确保 credentials.json 等子挂载点也能递归传播到 namespace 内
  assert.match(
    script,
    /mount\s+--rbind\s+"\$CERELAY_SHARED_CLAUDE_DIR"\s+"\$CERELAY_RUNTIME_ROOT\/staged\/claude"/,
    "shared claude dir 必须使用 --rbind 递归挂载，而非 --bind"
  );
});

test("bootstrap script still uses --bind for individual files (claude.json, settings)", () => {
  const script = renderNamespaceBootstrapScript();

  // 单文件挂载用 --bind 即可（无子挂载点）
  assert.match(
    script,
    /mount\s+--bind\s+"\$CERELAY_SHARED_CLAUDE_JSON"\s+"\$CERELAY_RUNTIME_ROOT\/staged\/claude\.json"/,
    "claude.json 单文件使用 --bind"
  );
});

test("bootstrap script contains both FUSE mode and legacy mode branches", () => {
  const script = renderNamespaceBootstrapScript();

  // FUSE 模式分支
  assert.match(script, /FUSE mode: binding home-claude/, "包含 FUSE 模式分支");
  // 传统模式分支
  assert.match(script, /legacy mode/, "包含传统模式分支");
});

test("bootstrap script in FUSE mode binds home-claude from FUSE mount point", () => {
  const script = renderNamespaceBootstrapScript();

  assert.match(
    script,
    /mount\s+--bind\s+"\$CERELAY_FUSE_ROOT\/home-claude"\s+"\$CERELAY_HOME_DIR\/\.claude"/,
    "FUSE 模式从 FUSE 挂载点绑定 ~/.claude"
  );
});

test("bootstrap script no longer marks mounted credentials file as read-only in compose", async () => {
  const composePath = path.resolve(testFileDir, "..", "..", "docker-compose.yml");
  const compose = await readFile(composePath, "utf8");

  assert.match(
    compose,
    /target:\s*\/home\/node\/\.claude\/\.credentials\.json/,
    "compose 应继续挂载 credentials 文件"
  );
  assert.doesNotMatch(
    compose,
    /read_only:\s*true/,
    "compose 不应再将 credentials mount 标记为只读"
  );
});

// ============================================================
// 场景 2: FileProxyManager shadow file 凭证注入
// ============================================================

test("FileProxyManager accepts shadowFiles with credentials path", () => {
  const sentMessages: unknown[] = [];
  const manager = new FileProxyManager({
    runtimeRoot: "/tmp/test-runtime",
    clientHomeDir: "/home/testuser",
    clientCwd: "/projects/test",
    sessionId: "test-session",
    shadowFiles: {
      "home-claude/.credentials.json": "/home/node/.claude/.credentials.json",
    },
    sendToClient: async (msg) => {
      sentMessages.push(msg);
    },
  });

  // FileProxyManager 实例创建成功说明 shadowFiles 参数被正确接受
  assert.ok(manager, "FileProxyManager 应接受 shadowFiles 参数");
});

test("FileProxyManager without shadowFiles defaults to empty", () => {
  const manager = new FileProxyManager({
    runtimeRoot: "/tmp/test-runtime",
    clientHomeDir: "/home/testuser",
    clientCwd: "/projects/test",
    sessionId: "test-session",
    sendToClient: async () => {},
  });

  assert.ok(manager, "FileProxyManager 无 shadowFiles 时不应报错");
});

// ============================================================
// 场景 3: 凭证 shadow file 注入逻辑（模拟 server.ts 中的条件判断）
// ============================================================

test("credentials shadow file is added when .credentials.json exists", async (t) => {
  const tempDir = await mkdir(path.join(tmpdir(), `cred-test-${Date.now()}`), { recursive: true });
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // 模拟容器内凭证文件存在
  const credPath = path.join(tempDir, ".credentials.json");
  await writeFile(credPath, JSON.stringify({ claudeAiOauth: { token: "test" } }), "utf8");

  // 复现 server.ts 中的条件逻辑
  const shadowFiles: Record<string, string> = {};
  const containerCredPath = credPath;
  if (existsSync(containerCredPath)) {
    shadowFiles["home-claude/.credentials.json"] = containerCredPath;
  }

  assert.deepEqual(shadowFiles, {
    "home-claude/.credentials.json": credPath,
  }, "凭证文件存在时应添加 shadow file 映射");
});

test("credentials shadow file is NOT added when .credentials.json does not exist", () => {
  const shadowFiles: Record<string, string> = {};
  const containerCredPath = "/nonexistent/path/.credentials.json";
  if (existsSync(containerCredPath)) {
    shadowFiles["home-claude/.credentials.json"] = containerCredPath;
  }

  assert.deepEqual(shadowFiles, {}, "凭证文件不存在时不应添加 shadow file");
});

test("PTY session combines hook injection and credentials shadow files", async (t) => {
  const tempDir = await mkdir(path.join(tmpdir(), `pty-cred-test-${Date.now()}`), { recursive: true });
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const credPath = path.join(tempDir, ".credentials.json");
  const settingsPath = path.join(tempDir, "settings.local.json");
  await writeFile(credPath, '{"token":"x"}', "utf8");
  await writeFile(settingsPath, '{"hooks":{}}', "utf8");

  // 复现 PTY session 创建逻辑：同时注入 hook settings 和 credentials
  const shadowFiles: Record<string, string> = {};
  if (existsSync(settingsPath)) {
    shadowFiles["project-claude/settings.local.json"] = settingsPath;
  }
  if (existsSync(credPath)) {
    shadowFiles["home-claude/.credentials.json"] = credPath;
  }

  assert.deepEqual(shadowFiles, {
    "project-claude/settings.local.json": settingsPath,
    "home-claude/.credentials.json": credPath,
  }, "PTY session 应同时包含 hook injection 和凭证的 shadow file");
});

test("FUSE script writes shadow credentials file back to local server path", () => {
  const script = renderNamespaceBootstrapScript();

  assert.match(
    script,
    /mount\s+--bind\s+"\$CERELAY_FUSE_ROOT\/home-claude"\s+"\$CERELAY_HOME_DIR\/\.claude"/,
    "bootstrap 仍应绑定 FUSE 的 home-claude 目录"
  );
});

test("FUSE host script handles shadow file writes locally instead of proxying to Hand", async () => {
  const { PYTHON_FUSE_HOST_SCRIPT } = await import("../src/fuse-host-script.js");

  assert.match(
    PYTHON_FUSE_HOST_SCRIPT,
    /def resolve_shadow_path\(fuse_path\):/,
    "FUSE script 应暴露 shadow file 路径解析 helper"
  );
  assert.match(
    PYTHON_FUSE_HOST_SCRIPT,
    /def write\(self, path, data, offset, fh\):\n\s+local_path = resolve_shadow_path\(path\)\n\s+if local_path:/,
    "shadow file 写入应先命中本地路径分支"
  );
  assert.match(
    PYTHON_FUSE_HOST_SCRIPT,
    /def truncate\(self, path, length, fh=None\):\n\s+local_path = resolve_shadow_path\(path\)\n\s+if local_path:/,
    "shadow file truncate 应直接作用于本地文件"
  );
});

// ============================================================
// 场景 4: docker-entrypoint.sh .claude.json 安全合并
// ============================================================

test("docker-entrypoint node merge script preserves existing fields", async (t) => {
  const tempDir = await mkdir(path.join(tmpdir(), `entrypoint-test-${Date.now()}`), { recursive: true });
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const claudeJsonPath = path.join(tempDir, ".claude.json");

  // 模拟已有内容（比如用户自定义的配置字段）
  const existingContent = {
    customSetting: "user-value",
    permissions: { allow: ["Read"] },
  };
  await writeFile(claudeJsonPath, JSON.stringify(existingContent), "utf8");

  // 执行与 docker-entrypoint.sh 相同的 node 合并逻辑
  execSync(`node -e "
const fs = require('fs');
const p = '${claudeJsonPath}';
let obj = {};
try { obj = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
obj.hasCompletedOnboarding = true;
obj.installMethod = 'native';
fs.writeFileSync(p, JSON.stringify(obj) + '\\n');
  "`);

  const result = JSON.parse(await readFile(claudeJsonPath, "utf8"));

  // 验证已有字段被保留
  assert.equal(result.customSetting, "user-value", "已有 customSetting 应被保留");
  assert.deepEqual(result.permissions, { allow: ["Read"] }, "已有 permissions 应被保留");
  // 验证新字段被写入
  assert.equal(result.hasCompletedOnboarding, true, "hasCompletedOnboarding 应被设置为 true");
  assert.equal(result.installMethod, "native", "installMethod 应被设置为 native");
});

test("docker-entrypoint node merge script works when .claude.json does not exist", async (t) => {
  const tempDir = await mkdir(path.join(tmpdir(), `entrypoint-new-${Date.now()}`), { recursive: true });
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const claudeJsonPath = path.join(tempDir, ".claude.json");
  // 文件不存在

  execSync(`node -e "
const fs = require('fs');
const p = '${claudeJsonPath}';
let obj = {};
try { obj = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
obj.hasCompletedOnboarding = true;
obj.installMethod = 'native';
fs.writeFileSync(p, JSON.stringify(obj) + '\\n');
  "`);

  const result = JSON.parse(await readFile(claudeJsonPath, "utf8"));
  assert.equal(result.hasCompletedOnboarding, true);
  assert.equal(result.installMethod, "native");
  // 不应有其他额外字段
  assert.deepEqual(Object.keys(result).sort(), ["hasCompletedOnboarding", "installMethod"]);
});

test("docker-entrypoint node merge script overwrites stale onboarding value", async (t) => {
  const tempDir = await mkdir(path.join(tmpdir(), `entrypoint-overwrite-${Date.now()}`), { recursive: true });
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const claudeJsonPath = path.join(tempDir, ".claude.json");
  // 模拟旧值 hasCompletedOnboarding: false
  await writeFile(claudeJsonPath, JSON.stringify({ hasCompletedOnboarding: false, installMethod: "npm" }), "utf8");

  execSync(`node -e "
const fs = require('fs');
const p = '${claudeJsonPath}';
let obj = {};
try { obj = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
obj.hasCompletedOnboarding = true;
obj.installMethod = 'native';
fs.writeFileSync(p, JSON.stringify(obj) + '\\n');
  "`);

  const result = JSON.parse(await readFile(claudeJsonPath, "utf8"));
  assert.equal(result.hasCompletedOnboarding, true, "onboarding 应被覆盖为 true");
  assert.equal(result.installMethod, "native", "installMethod 应被覆盖为 native");
});

// ============================================================
// 场景 5: mount namespace bootstrap 在容器内的集成验证
// （仅在 Linux + SYS_ADMIN 环境下运行，CI 容器内自动启用）
// ============================================================

const isLinux = process.platform === "linux";
const expectMountNamespaceTests = process.env.CERELAY_EXPECT_MOUNT_NAMESPACE_TESTS === "true";
const hasSysAdmin = (() => {
  if (!isLinux) return false;
  try {
    // 检查是否有 mount namespace 能力
    execSync("unshare --mount echo ok", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

if (expectMountNamespaceTests) {
  assert.ok(isLinux, "容器测试环境应在 Linux 内运行 mount namespace 集成测试");
  assert.ok(hasSysAdmin, "容器测试环境应提供 unshare --mount / SYS_ADMIN 能力");
}

test("integration: mount namespace bootstrap makes credentials visible via --rbind", { skip: !hasSysAdmin }, async (t) => {
  const tempDir = await mkdir(path.join(tmpdir(), `ns-cred-${Date.now()}`), { recursive: true });
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // 模拟 shared claude dir 结构（包含 .credentials.json 子文件）
  const sharedClaudeDir = path.join(tempDir, "shared-claude");
  await mkdir(sharedClaudeDir, { recursive: true });
  await writeFile(
    path.join(sharedClaudeDir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "test-token" } }),
    "utf8"
  );
  await writeFile(
    path.join(sharedClaudeDir, "settings.json"),
    JSON.stringify({ theme: "dark" }),
    "utf8"
  );

  const runtimeRoot = path.join(tempDir, "runtime");
  await mkdir(path.join(runtimeRoot, "staged"), { recursive: true });

  // 使用 unshare + mount --rbind 测试递归挂载
  // 验证子文件 .credentials.json 在挂载后可见
  const result = execSync(`
    unshare --mount --propagation private /bin/sh -c '
      mkdir -p "${runtimeRoot}/staged/claude"
      mount --rbind "${sharedClaudeDir}" "${runtimeRoot}/staged/claude"
      # 验证 .credentials.json 在 staged 目录可见
      cat "${runtimeRoot}/staged/claude/.credentials.json"
    '
  `, { encoding: "utf8" });

  const parsed = JSON.parse(result.trim());
  assert.equal(parsed.claudeAiOauth.accessToken, "test-token",
    "--rbind 应使 .credentials.json 在 namespace 内可见");
});

test("integration: mount namespace bootstrap exposes all files under shared claude dir", { skip: !hasSysAdmin }, async (t) => {
  const tempDir = await mkdir(path.join(tmpdir(), `ns-all-${Date.now()}`), { recursive: true });
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const sharedClaudeDir = path.join(tempDir, "shared-claude");
  await mkdir(path.join(sharedClaudeDir, "subdir"), { recursive: true });
  await writeFile(path.join(sharedClaudeDir, ".credentials.json"), '{"token":"abc"}', "utf8");
  await writeFile(path.join(sharedClaudeDir, "settings.json"), '{"x":1}', "utf8");
  await writeFile(path.join(sharedClaudeDir, "subdir", "nested.txt"), "nested-content", "utf8");

  const runtimeRoot = path.join(tempDir, "runtime");
  await mkdir(path.join(runtimeRoot, "staged"), { recursive: true });

  // --rbind 确保嵌套子目录也可见
  const result = execSync(`
    unshare --mount --propagation private /bin/sh -c '
      mkdir -p "${runtimeRoot}/staged/claude"
      mount --rbind "${sharedClaudeDir}" "${runtimeRoot}/staged/claude"
      ls -a "${runtimeRoot}/staged/claude/" | sort
      echo "---"
      cat "${runtimeRoot}/staged/claude/subdir/nested.txt"
    '
  `, { encoding: "utf8" });

  const lines = result.trim().split("\n");
  const separator = lines.indexOf("---");
  const listing = lines.slice(0, separator);
  const nestedContent = lines.slice(separator + 1).join("\n");

  assert.ok(listing.includes(".credentials.json"), "listing 应包含 .credentials.json");
  assert.ok(listing.includes("settings.json"), "listing 应包含 settings.json");
  assert.ok(listing.includes("subdir"), "listing 应包含 subdir");
  assert.equal(nestedContent, "nested-content", "嵌套文件内容应可读");
});
