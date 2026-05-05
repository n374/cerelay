#!/bin/sh
# ============================================================
# Cerelay E2E stale-project + orphan-image GC
# 扫描 cerelay-e2e* docker compose project 与 image，按下面三段清理：
#
#   1. compose project GC：
#      project name 末尾必须是 numeric timestamp（`date +%s`），允许中间出现
#      任意 slug 段，例如 cerelay-e2e-<ts> / cerelay-e2e-meta-<ts> /
#      cerelay-e2e-debug-<ts>。年龄 ≥ STALE_THRESHOLD_SEC（默认 1800 = 30min）
#      的整 project 走 `down --volumes --rmi local --remove-orphans`。
#      末尾不是 timestamp 的 project（如 cerelay-e2e-debug 这种无 ts 调试残留）
#      默认当作 stale 直接清——保留它没有意义且永远不会过期。
#
#   2. orphan image GC：
#      扫 cerelay-e2e-* image，对应 compose project 已经不在 active list 的
#      直接 docker rmi。覆盖两个场景：
#        a. 历史上 down 时没带 --rmi local 留下的 image（即此次修复之前的累积）
#        b. project 名字被 docker compose ls 不识别但 image 还在
#
#   3. --purge-all：
#      跳过 timestamp 判断，把所有 cerelay-e2e-* project 与 image 一次性清空。
#      用于开发者手动一键回收。
#
# 触发场景：
#   - run-e2e-comprehensive.sh / run-e2e-comprehensive-meta.sh 启动前自动调用
#   - 手动：`bash test/cleanup-e2e-stale.sh` 或 `bash test/cleanup-e2e-stale.sh --purge-all`
#
# 调参：
#   CERELAY_E2E_STALE_THRESHOLD_SEC=600 bash test/cleanup-e2e-stale.sh
# ============================================================
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
cd "$repo_root"

threshold=${CERELAY_E2E_STALE_THRESHOLD_SEC:-1800}
purge_all=0
case "${1:-}" in
  --purge-all) purge_all=1 ;;
  "") ;;
  *) echo "usage: $0 [--purge-all]" >&2; exit 2 ;;
esac
now=$(date +%s)

list_e2e_projects() {
  docker compose ls -a --format json 2>/dev/null | \
    python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for p in data:
    name = p.get('Name', '')
    if name.startswith('cerelay-e2e-'):
        print(name)
" 2>/dev/null || true
}

down_project() {
  proj=$1
  docker compose -p "$proj" -f docker-compose.e2e.yml \
    down --volumes --rmi local --remove-orphans >/dev/null 2>&1 || true
}

# ---------- Step 1: project GC ----------
projects=$(list_e2e_projects)

cleaned=0
kept=0
if [ -n "$projects" ]; then
  for proj in $projects; do
    if [ "$purge_all" = 1 ]; then
      echo "[cleanup-stale] purge project: $proj"
      down_project "$proj"
      cleaned=$((cleaned + 1))
      continue
    fi

    # 末尾连续 numeric 段当 timestamp；中间任意 slug 段不影响
    ts=$(printf '%s' "$proj" | sed -nE 's/.*-([0-9]+)$/\1/p')
    if [ -z "$ts" ]; then
      # 末尾不是 timestamp（例如 cerelay-e2e-debug 这种无 ts 命名）
      # → 视为 stale，避免永久残留。开发者若想留 project 调试，
      # 应该用带 ts 的命名（runner 默认生成的）+ KEEP_ON_FAILURE=1 短期保留
      echo "[cleanup-stale] no-timestamp → stale: $proj"
      down_project "$proj"
      cleaned=$((cleaned + 1))
      continue
    fi
    age=$((now - ts))
    if [ "$age" -lt "$threshold" ]; then
      echo "[cleanup-stale] keep (${age}s < ${threshold}s): $proj"
      kept=$((kept + 1))
      continue
    fi
    echo "[cleanup-stale] clean (${age}s >= ${threshold}s): $proj"
    down_project "$proj"
    cleaned=$((cleaned + 1))
  done
else
  echo "[cleanup-stale] 无 cerelay-e2e* project"
fi

# ---------- Step 2: orphan image GC ----------
# 上面 down --rmi local 已处理 active project 的 image。剩下的孤儿 image 来自：
#   a. 此次修复之前历史 teardown 没带 --rmi local 留下的累积
#   b. project 已经被外部手动 down，但 image 没清（compose 此时已不识别 project）
# 反推 project name：cerelay-e2e-<...>-<service>，service ∈ 已知 6 个
active_projects=$(list_e2e_projects)

# service 列表优先动态从 compose 文件读，新增 service 自动覆盖；读不到时
# fallback 到 hardcoded 列表（兼容 compose 文件不可用 / 未在 repo_root 跑等场景）
services=$(docker compose -f docker-compose.e2e.yml config --services 2>/dev/null || true)
if [ -z "$services" ]; then
  echo "[cleanup-stale] WARN: docker compose config --services 失败，fallback 到 hardcoded 列表" >&2
  services="mock-anthropic server client-a client-b client-c orchestrator"
fi

orphan_log=$(mktemp "${TMPDIR:-/tmp}/cerelay-e2e-orphan-images.XXXXXX")
unknown_log=$(mktemp "${TMPDIR:-/tmp}/cerelay-e2e-unknown-images.XXXXXX")
trap 'rm -f "$orphan_log" "$unknown_log"' EXIT INT TERM

docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null \
  | grep -E '^cerelay-e2e' \
  | while IFS= read -r image_ref; do
      [ -n "$image_ref" ] || continue
      repo=${image_ref%%:*}

      proj=""
      for svc in $services; do
        suffix="-$svc"
        case "$repo" in
          *"$suffix")
            proj=${repo%"$suffix"}
            break
            ;;
        esac
      done
      if [ -z "$proj" ]; then
        # 不符合 cerelay-e2e-<...>-<service> 规范：service 段不在已知列表里。
        # 保守跳过（不删），但 warn 记日志——可能是手动 build 的孤儿（如
        # cerelay-e2e-client-agent / cerelay-e2e-mock 这种 plan §5.4 验证残留），
        # 也可能是新增 service 但 docker compose config --services 读不到的退化情况。
        echo "[cleanup-stale] WARN: 未知 service 后缀，跳过: $image_ref" | tee -a "$unknown_log" >&2
        continue
      fi

      if [ "$purge_all" = 1 ]; then
        echo "[cleanup-stale] orphan-image (purge): $image_ref" | tee -a "$orphan_log"
        docker rmi -f "$image_ref" >/dev/null 2>&1 || true
        continue
      fi

      if printf '%s\n' "$active_projects" | grep -Fxq "$proj"; then
        continue  # project 仍 active，image 留着
      fi
      echo "[cleanup-stale] orphan-image: $image_ref" | tee -a "$orphan_log"
      docker rmi -f "$image_ref" >/dev/null 2>&1 || true
    done

orphan_attempted=$(wc -l < "$orphan_log" 2>/dev/null | tr -d ' ' || echo 0)
unknown_skipped=$(wc -l < "$unknown_log" 2>/dev/null | tr -d ' ' || echo 0)
rm -f "$orphan_log" "$unknown_log"
trap - EXIT INT TERM

echo "[cleanup-stale] 完成: project cleaned=$cleaned kept=$kept, orphan image rmi attempted=$orphan_attempted, unknown-suffix skipped=$unknown_skipped (threshold=${threshold}s, purge_all=$purge_all)"
