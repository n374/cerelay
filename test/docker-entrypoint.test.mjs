import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const WORKDIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRYPOINT = path.join(WORKDIR, "docker-entrypoint.sh");

test("docker entrypoint forwards startup flags and preserves Claude executable env", async () => {
  const sandbox = await createSandbox();
  const configJson = JSON.stringify({ apiKeySource: "test" });

  const result = await runEntrypoint(sandbox, {
    PORT: "9999",
    MODEL: "claude-test",
    LOG_LEVEL: "debug",
    LOG_JSON: "true",
    CLAUDE_CODE_EXECUTABLE: "/custom/claude",
    CLAUDE_CONFIG: configJson,
    ANTHROPIC_API_KEY: "test-key",
    ANTHROPIC_AUTH_TOKEN: "auth-token",
    ANTHROPIC_BASE_URL: "https://example.invalid",
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /启动 Cerelay Server/);
  assert.match(result.stdout, /claude CLI 版本: 9\.9\.9-test/);
  assert.match(
    result.stdout,
    /NODE_ARGS:\/app\/server\/dist\/index\.js --port 9999 --model claude-test --log-level debug --log-json/
  );
  assert.match(result.stdout, /CLAUDE_CODE_EXECUTABLE_ENV:\/custom\/claude/);
  assert.match(result.stdout, /ANTHROPIC_AUTH_TOKEN_ENV:auth-token/);
  assert.match(result.stdout, /ANTHROPIC_BASE_URL_ENV:https:\/\/example\.invalid/);

  const writtenConfig = await readFile(path.join(sandbox.homeDir, ".claude", "claude_config.json"), "utf8");
  assert.equal(writtenConfig, configJson);
});

test("docker entrypoint warns when no credentials file is found", async () => {
  const sandbox = await createSandbox();

  const result = await runEntrypoint(sandbox, {
    PORT: "8765",
    MODEL: "claude-sonnet-4",
    LOG_LEVEL: "info",
    LOG_JSON: "false",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
    ANTHROPIC_BASE_URL: "",
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /未找到 Claude Code 登录凭证/);
  assert.match(
    result.stdout,
    /NODE_ARGS:\/app\/server\/dist\/index\.js --port 8765 --model claude-sonnet-4 --log-level info/
  );
  assert.doesNotMatch(result.stdout, /--log-json/);
});

test("docker entrypoint writes credentials from CLAUDE_CREDENTIALS env var", async () => {
  const sandbox = await createSandbox();
  const credentials = '{"claudeAiOauth":{"accessToken":"test-token"}}';

  const result = await runEntrypoint(sandbox, {
    PORT: "8765",
    MODEL: "claude-sonnet-4",
    LOG_LEVEL: "info",
    LOG_JSON: "false",
    CLAUDE_CREDENTIALS: credentials,
    ANTHROPIC_API_KEY: "key",
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /已通过 CLAUDE_CREDENTIALS 环境变量写入登录凭证/);

  const written = await readFile(path.join(sandbox.homeDir, ".claude", ".credentials.json"), "utf8");
  assert.equal(written.trim(), credentials);
});

test("docker entrypoint detects mounted credentials file", async () => {
  const sandbox = await createSandbox();
  // 模拟已挂载的 credentials 文件
  await mkdir(path.join(sandbox.homeDir, ".claude"), { recursive: true });
  await writeFile(path.join(sandbox.homeDir, ".claude", ".credentials.json"), '{"ok":true}\n', "utf8");

  const result = await runEntrypoint(sandbox, {
    PORT: "8765",
    MODEL: "claude-sonnet-4",
    LOG_LEVEL: "info",
    LOG_JSON: "false",
    ANTHROPIC_API_KEY: "key",
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /检测到已挂载的 Claude Code 登录凭证/);
});

test("docker entrypoint merges .claude.json preserving existing fields", async () => {
  const sandbox = await createSandbox();

  // 模拟已有 .claude.json（例如用户的自定义配置已通过 bind mount 注入）
  const existing = { customField: "keep-me", permissions: { allow: ["Read"] } };
  await writeFile(path.join(sandbox.homeDir, ".claude.json"), JSON.stringify(existing), "utf8");

  const result = await runEntrypoint(sandbox, {
    PORT: "8765",
    MODEL: "claude-sonnet-4",
    LOG_LEVEL: "info",
    LOG_JSON: "false",
    ANTHROPIC_API_KEY: "key",
  });

  assert.equal(result.exitCode, 0, result.stderr);

  const merged = JSON.parse(await readFile(path.join(sandbox.homeDir, ".claude.json"), "utf8"));
  // 新字段被写入
  assert.equal(merged.hasCompletedOnboarding, true);
  assert.equal(merged.installMethod, "native");
  // 已有字段被保留
  assert.equal(merged.customField, "keep-me");
  assert.deepEqual(merged.permissions, { allow: ["Read"] });
});

test("docker entrypoint creates .claude.json when it does not exist", async () => {
  const sandbox = await createSandbox();
  // 不预创建 .claude.json

  const result = await runEntrypoint(sandbox, {
    PORT: "8765",
    MODEL: "claude-sonnet-4",
    LOG_LEVEL: "info",
    LOG_JSON: "false",
    ANTHROPIC_API_KEY: "key",
  });

  assert.equal(result.exitCode, 0, result.stderr);

  const created = JSON.parse(await readFile(path.join(sandbox.homeDir, ".claude.json"), "utf8"));
  assert.equal(created.hasCompletedOnboarding, true);
  assert.equal(created.installMethod, "native");
});

test("docker entrypoint logs UDP policy at startup", async () => {
  const sandbox = await createSandbox();
  const result = await runEntrypoint(sandbox, {
    PORT: "8765",
    MODEL: "claude-sonnet-4",
    LOG_LEVEL: "info",
    LOG_JSON: "false",
    ANTHROPIC_API_KEY: "key",
    CERELAY_SOCKS_PROXY: "socks5://proxy.example.com:1080",
    CERELAY_SOCKS_CONFIG_SCRIPT: path.join(WORKDIR, "docker", "socks-proxy-config.mjs"),
    CERELAY_TEST_NET_RESPONSES: "success",
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /SOCKS TUN: 已启用/);
  assert.match(result.stdout, /启动容器级透明 SOCKS5 代理/);
  assert.match(result.stdout, /代理: proxy\.example\.com:1080/);
  assert.match(result.stdout, /SOCKS UDP 策略: forward/);
  assert.match(result.stdout, /SOCKS DNS: 1\.1\.1\.1（默认 TCP）/);
  assert.match(result.stdout, /NODE_ARGS:\/app\/server\/dist\/index\.js --port 8765 --model claude-sonnet-4 --log-level info/);
});

test("docker entrypoint refuses to start when SOCKS proxy preflight fails", async () => {
  const sandbox = await createSandbox();

  const result = await runEntrypoint(sandbox, {
    PORT: "8765",
    MODEL: "claude-sonnet-4",
    LOG_LEVEL: "info",
    LOG_JSON: "false",
    ANTHROPIC_API_KEY: "key",
    CERELAY_SOCKS_PROXY: "socks5://proxy.example.com:1080",
    CERELAY_SOCKS_CONFIG_SCRIPT: path.join(WORKDIR, "docker", "socks-proxy-config.mjs"),
    CERELAY_SOCKS_CONNECT_TIMEOUT_MS: "100",
    CERELAY_TEST_NET_RESPONSES: "fail",
  });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stdout + result.stderr, /SOCKS 代理预检查失败/);
});

test("docker entrypoint propagates CERELAY_SOCKS_UDP=block into generated sing-box config", async () => {
  const sandbox = await createSandbox();
  const result = await runEntrypoint(sandbox, {
    PORT: "8765",
    MODEL: "claude-sonnet-4",
    LOG_LEVEL: "info",
    LOG_JSON: "false",
    ANTHROPIC_API_KEY: "key",
    CERELAY_SOCKS_PROXY: "socks5://proxy.example.com:1080",
    CERELAY_SOCKS_UDP: "block",
    CERELAY_SOCKS_CONFIG_SCRIPT: path.join(WORKDIR, "docker", "socks-proxy-config.mjs"),
    CERELAY_TEST_NET_RESPONSES: "success",
  });

  assert.equal(result.exitCode, 0, result.stderr);

  const config = JSON.parse(await readFile(path.join(sandbox.etcDir, "config.json"), "utf8"));
  assert.deepEqual(config.route.rules.at(-1), { network: "udp", action: "reject" });
});

test("docker entrypoint fail-closes when SOCKS proxy endpoint becomes unreachable mid-flight", async () => {
  const sandbox = await createSandbox();
  const result = await runEntrypoint(sandbox, {
    PORT: "8765",
    MODEL: "claude-sonnet-4",
    LOG_LEVEL: "info",
    LOG_JSON: "false",
    ANTHROPIC_API_KEY: "key",
    CERELAY_SOCKS_PROXY: "socks5://proxy.example.com:1080",
    CERELAY_SOCKS_CONFIG_SCRIPT: path.join(WORKDIR, "docker", "socks-proxy-config.mjs"),
    CERELAY_SOCKS_MONITOR_INTERVAL_SECS: "0.1",
    CERELAY_TEST_NODE_MODE: "server-sleep",
    CERELAY_TEST_NET_RESPONSES: "success,fail",
  });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stdout + result.stderr, /SOCKS 代理端点不可达，终止主进程以保持 fail-closed/);
});

async function createSandbox() {
  const rootDir = await mkdtemp(path.join(tmpdir(), "cerelay-entrypoint-"));
  const binDir = path.join(rootDir, "bin");
  const homeDir = path.join(rootDir, "home");
  const tunFlag = path.join(rootDir, "tun-ready");
  const etcDir = path.join(rootDir, "etc");
  const netStateFile = path.join(rootDir, "net-state");
  const resolvConf = path.join(rootDir, "resolv.conf");

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(etcDir, { recursive: true });

  await writeExecutable(
    path.join(binDir, "claude"),
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '9.9.9-test\\n'
  exit 0
fi
printf 'unexpected claude args: %s\\n' "$*" >&2
exit 1
`
  );

  // fake node: -e 参数透传给真实 node（docker-entrypoint 的合并脚本需要真正执行），
  // 其余（如启动 server）只打印参数
  const realNode = process.execPath;
  await writeExecutable(
    path.join(binDir, "node"),
    `#!/bin/sh
	if [ "$1" = "-e" ]; then
	  case "$2" in
	    *"const net = require('node:net');"*)
	      if [ -n "$CERELAY_TEST_NET_RESPONSES" ]; then
	        state_file="$CERELAY_TEST_NET_STATE_FILE"
	        index=0
	        if [ -f "$state_file" ]; then
	          index=$(cat "$state_file")
	        fi
	        response=$(printf '%s\n' "$CERELAY_TEST_NET_RESPONSES" | awk -F, -v n=$((index + 1)) '{ if (n <= NF) print $n; else print $NF }')
	        printf '%s' $((index + 1)) > "$state_file"
	        if [ "$response" = "success" ]; then
	          exit 0
	        fi
	        exit 1
	      fi
	      ;;
	  esac
	  exec "${realNode}" "$@"
	fi
	if [ -n "$CERELAY_SOCKS_CONFIG_SCRIPT" ] && [ "$1" = "$CERELAY_SOCKS_CONFIG_SCRIPT" ]; then
	  exec "${realNode}" "$@"
	fi
	if [ "$CERELAY_TEST_NODE_MODE" = "server-sleep" ]; then
	  trap 'exit 143' TERM
	  printf 'NODE_ARGS:%s\\n' "$*"
	  while true; do sleep 1; done
	fi
	printf 'NODE_ARGS:%s\\n' "$*"
	printf 'CLAUDE_CODE_EXECUTABLE_ENV:%s\\n' "$CLAUDE_CODE_EXECUTABLE"
	printf 'ANTHROPIC_AUTH_TOKEN_ENV:%s\\n' "$ANTHROPIC_AUTH_TOKEN"
printf 'ANTHROPIC_BASE_URL_ENV:%s\\n' "$ANTHROPIC_BASE_URL"
printf 'PORT_ENV:%s\\n' "$PORT"
printf 'MODEL_ENV:%s\\n' "$MODEL"
printf 'LOG_LEVEL_ENV:%s\\n' "$LOG_LEVEL"
printf 'LOG_JSON_ENV:%s\\n' "$LOG_JSON"
	exit 0
	`
  );

  await writeExecutable(
    path.join(binDir, "sing-box"),
    `#!/bin/sh
mode="\${CERELAY_TEST_SINGBOX_MODE:-stay-alive}"
flag="\${CERELAY_TEST_TUN_FLAG:?missing CERELAY_TEST_TUN_FLAG}"
touch "$flag"
if [ "$mode" = "exit-after-start" ]; then
  sleep "\${CERELAY_TEST_SINGBOX_EXIT_DELAY_SECS:-0.2}"
  exit 0
fi
trap 'exit 0' TERM INT
while true; do sleep 1; done
`
  );

  await writeExecutable(
    path.join(binDir, "ip"),
    `#!/bin/sh
if [ "$1" = "-o" ] && [ "$2" = "link" ] && [ "$3" = "show" ] && [ "$4" = "tun0" ]; then
  if [ -f "\${CERELAY_TEST_TUN_FLAG:?missing CERELAY_TEST_TUN_FLAG}" ]; then
    printf '7: tun0: <POINTOPOINT,MULTICAST,NOARP,UP,LOWER_UP> mtu 9000 qdisc fq_codel state UNKNOWN mode DEFAULT group default qlen 500\\n'
    exit 0
  fi
  exit 1
fi
exec /usr/sbin/ip "$@"
`
  );

  await writeExecutable(
    path.join(binDir, "sysctl"),
    `#!/bin/sh
exit 0
`
  );

  return { rootDir, binDir, homeDir, tunFlag, etcDir, netStateFile, resolvConf };
}

async function writeExecutable(filePath, content) {
  await writeFile(filePath, content, { mode: 0o755 });
}

function runEntrypoint(sandbox, overrides) {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", [ENTRYPOINT], {
      cwd: WORKDIR,
      env: {
        ...process.env,
        HOME: sandbox.homeDir,
        PATH: `${sandbox.binDir}:${process.env.PATH ?? ""}`,
        CERELAY_TEST_TUN_FLAG: sandbox.tunFlag,
        CERELAY_TEST_NET_STATE_FILE: sandbox.netStateFile,
        CERELAY_SOCKS_CONFIG_DIR: sandbox.etcDir,
        CERELAY_RESOLV_CONF_PATH: sandbox.resolvConf,
        ...overrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}
