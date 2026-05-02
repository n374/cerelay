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
keep_on_failure=${KEEP_ON_FAILURE:-0}
logs_root="$repo_root/.claude/e2e-failure-$project"

echo "[e2e-meta] project=$project"

# 启动前 GC:清掉 stale 残留 project
sh "$script_dir/cleanup-e2e-stale.sh" || true

dump_failure_logs() {
  mkdir -p "$logs_root"
  echo "[e2e-meta] dumping logs to $logs_root/"
  docker compose -p "$project" -f "$compose_file" logs --no-color > "$logs_root/all.log" 2>&1 || true
  docker compose -p "$project" -f "$compose_file" logs --no-color server > "$logs_root/server.log" 2>&1 || true
  docker compose -p "$project" -f "$compose_file" ps -a > "$logs_root/ps.txt" 2>&1 || true
}

teardown() {
  docker compose -p "$project" -f "$compose_file" down --volumes --remove-orphans >/dev/null 2>&1 || true
}

_already_handled=0
on_exit() {
  exit_code=$?
  if [ "$_already_handled" = 1 ]; then return; fi
  _already_handled=1
  if [ "$exit_code" = 0 ]; then
    echo "[e2e-meta] success: tearing down"
    teardown
  else
    echo "[e2e-meta] FAILURE (exit=$exit_code)"
    dump_failure_logs
    if [ "$keep_on_failure" = 1 ]; then
      echo "[e2e-meta] KEEP_ON_FAILURE=1: containers left for inspection (project=$project)"
      echo "[e2e-meta]   docker compose -p $project -f $compose_file ps"
      echo "[e2e-meta]   docker compose -p $project -f $compose_file logs server"
      echo "[e2e-meta]   清理:docker compose -p $project -f $compose_file down --volumes"
    else
      echo "[e2e-meta] tearing down (logs preserved at $logs_root/);设 KEEP_ON_FAILURE=1 可保留 container"
      teardown
    fi
  fi
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "[e2e-meta] starting supporting services..."
# client-c 跟主 runner 一致预拉起：orchestrator depends_on client-c,即使
# meta phase 暂未用到也会被自动拉起,显式 wait 让健康问题立即暴露。
docker compose -p "$project" -f "$compose_file" up -d --build --wait \
  mock-anthropic server client-a client-b client-c

echo "[e2e-meta] running meta orchestrator (test:meta)..."
# 复用同一个 orchestrator 镜像，用 npm run test:meta 切换到 phase-p0-meta.test.ts
docker compose -p "$project" -f "$compose_file" run --rm --build \
  --entrypoint sh orchestrator \
  -c "cd /workspace && npm run test:meta"
