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
keep_on_failure=${KEEP_ON_FAILURE:-0}
logs_root="$repo_root/.claude/e2e-failure-$project"

echo "[e2e] project=$project"

# 启动前 GC:清掉 stale 残留 project,防 implementer 历史遗留累积
sh "$script_dir/cleanup-e2e-stale.sh" || true

dump_failure_logs() {
  mkdir -p "$logs_root"
  echo "[e2e] dumping logs to $logs_root/"
  docker compose -p "$project" -f "$compose_file" logs --no-color > "$logs_root/all.log" 2>&1 || true
  docker compose -p "$project" -f "$compose_file" logs --no-color server > "$logs_root/server.log" 2>&1 || true
  docker compose -p "$project" -f "$compose_file" ps -a > "$logs_root/ps.txt" 2>&1 || true
}

teardown() {
  docker compose -p "$project" -f "$compose_file" down --volumes --remove-orphans >/dev/null 2>&1 || true
}

# trap 兜底:任何退出路径都要清(成功 / 失败 / Ctrl+C / SIGTERM)。
# 失败时先 dump logs 到 .claude/e2e-failure-<project>/ 再清——避免 container 残留,
# 同时保留排错素材。
# 显式保留 container(老行为)用 KEEP_ON_FAILURE=1 opt-in。
_already_handled=0
on_exit() {
  exit_code=$?
  if [ "$_already_handled" = 1 ]; then return; fi
  _already_handled=1
  if [ "$exit_code" = 0 ]; then
    echo "[e2e] success: tearing down"
    teardown
  else
    echo "[e2e] FAILURE (exit=$exit_code)"
    dump_failure_logs
    if [ "$keep_on_failure" = 1 ]; then
      echo "[e2e] KEEP_ON_FAILURE=1: containers left for inspection (project=$project)"
      echo "[e2e]   docker compose -p $project -f $compose_file ps"
      echo "[e2e]   docker compose -p $project -f $compose_file logs server"
      echo "[e2e]   清理:docker compose -p $project -f $compose_file down --volumes"
    else
      echo "[e2e] tearing down (logs preserved at $logs_root/);设 KEEP_ON_FAILURE=1 可保留 container"
      teardown
    fi
  fi
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# 启动支撑容器(带 healthcheck,等就绪)
# client-c 是 C4-truncated 专用容器(cache scope budget 256KB),跟 client-a/b
# 一起 wait 让其健康问题立即暴露(而不是延迟到 C4 case 才报错)。
echo "[e2e] starting supporting services..."
docker compose -p "$project" -f "$compose_file" up -d --build --wait \
  mock-anthropic server client-a client-b client-c

# 跑 orchestrator
echo "[e2e] running orchestrator..."
docker compose -p "$project" -f "$compose_file" run --rm --build orchestrator
