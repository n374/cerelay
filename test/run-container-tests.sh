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
