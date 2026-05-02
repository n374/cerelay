#!/bin/sh
# ============================================================
# Cerelay E2E stale-project GC
# 扫描 cerelay-e2e-* / cerelay-e2e-meta-* docker compose project,
# 把 project name 内 timestamp 早于 STALE_THRESHOLD_SEC 的整个 project
# down 掉(包括 container / volume / network)。
#
# 触发场景:
#   1. run-e2e-comprehensive.sh 启动前自动调用,防 implementer 历史遗留
#      的残留累积影响新跑
#   2. 手动:`bash test/cleanup-e2e-stale.sh` 一键清所有 stale e2e
#
# 设计:
#   project name 格式 `cerelay-e2e-<sec>` / `cerelay-e2e-meta-<sec>`,
#   <sec> 由 `date +%s` 生成(运行 runner 时刻)。GC 解析 timestamp,
#   超过 STALE_THRESHOLD_SEC(默认 1800 = 30min)清掉。
#
#   30min 阈值的理由:e2e 套件正常 5min 跑完 + 安全裕量;并发跑两个
#   套件时不会误伤(两次启动间隔不会 > 30min)。
#
# 调参:
#   CERELAY_E2E_STALE_THRESHOLD_SEC=600 bash test/cleanup-e2e-stale.sh
# ============================================================
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
cd "$repo_root"

threshold=${CERELAY_E2E_STALE_THRESHOLD_SEC:-1800}
now=$(date +%s)

# 用 docker compose ls 拿所有 e2e project,过滤 cerelay-e2e* 前缀
projects=$(docker compose ls -a --format json 2>/dev/null | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
for p in data:
    name = p.get('Name', '')
    if name.startswith('cerelay-e2e-') or name.startswith('cerelay-e2e-meta-'):
        print(name)
" 2>/dev/null || true)

if [ -z "$projects" ]; then
  echo "[cleanup-stale] 无 cerelay-e2e* project,跳过"
  exit 0
fi

cleaned=0
kept=0
for proj in $projects; do
  # 从 project name 末尾抽 timestamp(纯数字)。失败则跳过(name 不符合约定)
  ts=$(echo "$proj" | sed -E 's/^cerelay-e2e(-meta)?-([0-9]+)$/\2/')
  case "$ts" in
    *[!0-9]*|"") echo "[cleanup-stale] skip (timestamp 解析失败): $proj"; continue ;;
  esac
  age=$((now - ts))
  if [ "$age" -lt "$threshold" ]; then
    echo "[cleanup-stale] keep (${age}s < ${threshold}s): $proj"
    kept=$((kept + 1))
    continue
  fi
  echo "[cleanup-stale] clean (${age}s >= ${threshold}s): $proj"
  docker compose -p "$proj" -f docker-compose.e2e.yml down --volumes --remove-orphans >/dev/null 2>&1 || true
  cleaned=$((cleaned + 1))
done

echo "[cleanup-stale] 完成: cleaned=$cleaned, kept=$kept (threshold=${threshold}s)"
