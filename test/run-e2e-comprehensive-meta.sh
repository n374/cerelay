#!/bin/sh
# ============================================================
# Cerelay E2E meta-tests 入口（仅手动触发）
# docs/e2e-comprehensive-testing.md §8 Testing the Test Infrastructure
#
# 跑 phase-p0-meta.test.ts：故意引入 regression（IFS bug / redact-leak /
# deviceid-collision），验证主套件 phase-p0 能拦住对应失效场景。
#
# 故意 NOT 进 npm test 默认链路——meta 会改 process-global toggle，与主套件
# 串跑会污染。开发者验证套件有效性时手动调起。
# ============================================================
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)

cd "$repo_root"

compose_file="docker-compose.e2e.yml"
project="cerelay-e2e-meta-$(date +%s)"

echo "[e2e-meta] project=$project"

cleanup_on_success() {
  echo "[e2e-meta] success: tearing down"
  docker compose -p "$project" -f "$compose_file" down --volumes --remove-orphans >/dev/null 2>&1 || true
}

leave_on_failure() {
  echo "[e2e-meta] FAILURE: containers left for inspection (project=$project)"
  echo "[e2e-meta]   docker compose -p $project -f $compose_file ps"
  echo "[e2e-meta]   docker compose -p $project -f $compose_file logs server"
  echo "[e2e-meta]   清理：docker compose -p $project -f $compose_file down --volumes"
}

echo "[e2e-meta] starting supporting services..."
docker compose -p "$project" -f "$compose_file" up -d --build --wait \
  mock-anthropic server client-a client-b

echo "[e2e-meta] running meta orchestrator (test:meta)..."
# 复用同一个 orchestrator 镜像，用 npm run test:meta 切换到 phase-p0-meta.test.ts
if docker compose -p "$project" -f "$compose_file" run --rm --build \
     --entrypoint sh orchestrator \
     -c "cd /workspace && npm run test:meta"; then
  cleanup_on_success
  exit 0
else
  leave_on_failure
  exit 1
fi
