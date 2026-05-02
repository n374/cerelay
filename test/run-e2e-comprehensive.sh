#!/bin/sh
# ============================================================
# Cerelay E2E 综合测试入口
# 详见 docs/e2e-comprehensive-testing.md §3.5
# ============================================================
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)

cd "$repo_root"

compose_file="docker-compose.e2e.yml"
project="cerelay-e2e-$(date +%s)"

echo "[e2e] project=$project"

cleanup_on_success() {
  echo "[e2e] success: tearing down"
  docker compose -p "$project" -f "$compose_file" down --volumes --remove-orphans >/dev/null 2>&1 || true
}

leave_on_failure() {
  echo "[e2e] FAILURE: containers left for inspection (project=$project)"
  echo "[e2e]   docker compose -p $project -f $compose_file ps"
  echo "[e2e]   docker compose -p $project -f $compose_file logs server"
  echo "[e2e]   清理：docker compose -p $project -f $compose_file down --volumes"
}

# 启动支撑容器（带 healthcheck，等就绪）
echo "[e2e] starting supporting services..."
docker compose -p "$project" -f "$compose_file" up -d --build --wait \
  mock-anthropic server client-a client-b

# 跑 orchestrator
echo "[e2e] running orchestrator..."
if docker compose -p "$project" -f "$compose_file" run --rm --build orchestrator; then
  cleanup_on_success
  exit 0
else
  leave_on_failure
  exit 1
fi
