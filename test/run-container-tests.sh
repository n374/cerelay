#!/bin/sh

set -eu

compose_cmd="docker compose -f docker-compose.test.yml"

cleanup() {
  $compose_cmd down -v --remove-orphans >/dev/null 2>&1 || true
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
echo "[container-tests] e2e real claude (PreToolUse → tool_result invariant)"
$compose_cmd run --rm \
  -e CERELAY_ENABLE_MOUNT_NAMESPACE=false \
  -e CERELAY_E2E_REAL_CLAUDE=true \
  -e CLAUDE_CODE_EXECUTABLE=/usr/local/bin/claude \
  --entrypoint sh test -lc 'cd /app/server && node --import tsx --test --test-concurrency=1 test/e2e-real-claude-bash.test.ts'
