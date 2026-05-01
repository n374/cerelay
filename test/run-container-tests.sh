#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

. "$script_dir/test-env-common.sh"
. "$script_dir/gc-test-resources.sh"

test_gc_resources

compose_cmd="docker compose -p $COMPOSE_PROJECT_NAME -f docker-compose.test.yml"

cleanup() {
  $compose_cmd down --remove-orphans >/dev/null 2>&1 || true
}

trap cleanup EXIT INT TERM

$compose_cmd up --build -d mock-socks mock-dns egress-probe cerelay-socks-test

echo "[container-tests] smoke"
$compose_cmd run --build --rm --entrypoint sh test -lc 'npm run test:smoke'

echo "[container-tests] workspaces (mount namespace disabled)"
$compose_cmd run --rm \
  -e CERELAY_ENABLE_MOUNT_NAMESPACE=false \
  -e CERELAY_EXPECT_MOUNT_NAMESPACE_TESTS=false \
  --entrypoint sh test -lc 'npm run test:workspaces'

echo "[container-tests] namespace suites"
$compose_cmd run --rm \
  -e CERELAY_ENABLE_MOUNT_NAMESPACE=true \
  -e CERELAY_EXPECT_MOUNT_NAMESPACE_TESTS=true \
  --entrypoint sh test -lc 'cd /app/server && node --import tsx --test --test-concurrency=1 test/credentials-mount.test.ts test/pty-tool-relay-bug.test.ts'

# 真实 claude CLI 端到端测试：验证 PreToolUse hook 把 Client tool 输出回注
# 给 LLM 的 tool_result.content（守护 cerelay 通信协议核心不变量）。
# 容器内 Dockerfile.test 已 npm install -g @anthropic-ai/claude-code。
echo "[container-tests] e2e real claude (PreToolUse → tool_result invariant, legacy hook 路径)"
$compose_cmd run --rm \
  -e CERELAY_ENABLE_MOUNT_NAMESPACE=false \
  -e CERELAY_E2E_REAL_CLAUDE=true \
  -e CLAUDE_CODE_EXECUTABLE=/usr/local/bin/claude \
  --entrypoint sh test -lc 'cd /app/server && node --import tsx --test --test-concurrency=1 test/e2e-real-claude-bash.test.ts'

# Plan D shadow MCP 端到端测试：守护 mcp__cerelay__bash 路径下
# tool_result.is_error 必须为 false（区别于 legacy hook 路径的 is_error: true）。
echo "[container-tests] e2e plan-d mcp shadow (mcp__cerelay__bash → is_error:false invariant)"
$compose_cmd run --rm \
  -e CERELAY_ENABLE_MOUNT_NAMESPACE=false \
  -e CERELAY_E2E_REAL_CLAUDE=true \
  -e CLAUDE_CODE_EXECUTABLE=/usr/local/bin/claude \
  --entrypoint sh test -lc 'cd /app/server && node --import tsx --test --test-concurrency=1 test/e2e-mcp-shadow-bash.test.ts'
