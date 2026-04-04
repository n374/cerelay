#!/usr/bin/env bash
# ============================================================================
# analyze.sh — 审计日志分析工具
#
# 功能：分析 proxy-data/audit.jsonl，输出统计报告。
#
# 用法：bash .claude/proxy/analyze.sh [N]
#       N = 最近 N 条时间线（默认 20）
# ============================================================================
set -euo pipefail

DATA_DIR="${CLAUDE_PROJECT_DIR:-.}/.claude/proxy-data"
AUDIT_LOG="$DATA_DIR/audit.jsonl"
RECENT_N="${1:-20}"

if [[ ! -f "$AUDIT_LOG" ]]; then
  echo "审计日志不存在: $AUDIT_LOG"
  echo "启用 proxy 后会自动生成。"
  exit 0
fi

TOTAL=$(wc -l < "$AUDIT_LOG" | tr -d ' ')
echo "=== Tool Proxy 审计报告 ==="
echo "日志文件: $AUDIT_LOG"
echo "总记录数: $TOTAL"
echo ""

if ! command -v jq &>/dev/null; then
  echo "⚠ 需要 jq 来解析审计日志。使用 'brew install jq' 安装。"
  echo ""
  echo "--- 原始最近 $RECENT_N 条 ---"
  tail -n "$RECENT_N" "$AUDIT_LOG"
  exit 0
fi

# --- 工具调用次数排名 ---
echo "📊 工具调用次数排名："
jq -r '.tool' "$AUDIT_LOG" | sort | uniq -c | sort -rn | head -20 | while read -r count name; do
  printf "  %-20s %s\n" "$name" "$count"
done
echo ""

# --- 操作类型统计 ---
echo "📋 操作类型统计："
jq -r '.action' "$AUDIT_LOG" | sort | uniq -c | sort -rn | while read -r count action; do
  printf "  %-20s %s\n" "$action" "$count"
done
echo ""

# --- 被拦截（deny）的调用 ---
DENY_COUNT=$(jq -r 'select(.action == "deny") | .tool' "$AUDIT_LOG" | wc -l | tr -d ' ')
echo "🚫 拦截统计: $DENY_COUNT 次"
if [[ "$DENY_COUNT" -gt 0 ]]; then
  jq -r 'select(.action == "deny") | "  \(.time) [\(.tool)] \(.detail)"' "$AUDIT_LOG" | tail -20
fi
echo ""

# --- Mock 替换统计 ---
MOCK_COUNT=$(jq -r 'select(.action == "mock") | .tool' "$AUDIT_LOG" | wc -l | tr -d ' ')
echo "🎭 Mock 替换: $MOCK_COUNT 次"
if [[ "$MOCK_COUNT" -gt 0 ]]; then
  jq -r 'select(.action == "mock") | "  \(.time) [\(.tool)] \(.detail)"' "$AUDIT_LOG" | tail -10
fi
echo ""

# --- 敏感泄露警告 ---
LEAK_COUNT=$(jq -r 'select(.sensitive_leak_warning == true) | .tool' "$AUDIT_LOG" 2>/dev/null | wc -l | tr -d ' ')
echo "⚠️  敏感泄露警告: $LEAK_COUNT 次"
if [[ "$LEAK_COUNT" -gt 0 ]]; then
  jq -r 'select(.sensitive_leak_warning == true) | "  \(.time) [\(.tool)] \(.input_summary[:80])"' "$AUDIT_LOG" 2>/dev/null | tail -10
fi
echo ""

# --- 最近 N 条时间线 ---
echo "🕐 最近 $RECENT_N 条调用："
jq -r '"  \(.time) [\(.tool)] \(.action) \(.detail // "")"' "$AUDIT_LOG" | tail -n "$RECENT_N"
