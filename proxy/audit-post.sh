#!/usr/bin/env bash
# ============================================================================
# audit-post.sh — PostToolUse 审计钩子
#
# 功能：异步记录工具调用完成情况，扫描响应中是否出现敏感数据泄露。
#       注册在 settings.local.json 的 PostToolUse hook 中，async=true。
#
# stdin:  Claude Code PostToolUse hook JSON
#         {"tool_name":"...","tool_input":{...},"tool_response":"..."}
# stdout: 无（审计脚本不干预工具响应）
# exit:   始终 0
# ============================================================================
set -euo pipefail

PROXY_DIR="${CLAUDE_PROXY_DIR:-"${CLAUDE_PROJECT_DIR:-.}"/.claude/proxy}"
PROXY_DATA_DIR="${PROXY_DIR}/../proxy-data"
AUDIT_LOG="${PROXY_DATA_DIR}/audit.jsonl"

INPUT=$(cat)

# 提取字段（轻量解析）
TOOL_NAME=$(printf '%s' "$INPUT" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"tool_name"[[:space:]]*:[[:space:]]*"//;s/"//')
# 获取 tool_response（可能很长，只取前 2000 字符用于泄露扫描）
if command -v jq &>/dev/null; then
  TOOL_RESPONSE=$(printf '%s' "$INPUT" | jq -r '.tool_response // ""' 2>/dev/null | head -c 2000)
elif command -v python3 &>/dev/null; then
  TOOL_RESPONSE=$(printf '%s' "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_response','')[:2000])" 2>/dev/null)
else
  # 回退：简单提取，可能因转义引号而截断（仅用于泄露扫描，非关键路径）
  TOOL_RESPONSE=$(printf '%s' "$INPUT" | grep -o '"tool_response"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"tool_response"[[:space:]]*:[[:space:]]*"//' | sed 's/"$//' | head -c 2000)
fi

# 敏感泄露扫描
LEAK_WARNING="false"
LEAK_PATTERNS='(BEGIN RSA|BEGIN CERTIFICATE|BEGIN PRIVATE|BEGIN EC PRIVATE|password[[:space:]]*=|secret[[:space:]]*=|token[[:space:]]*=|api_key[[:space:]]*=|AWS_SECRET|PRIVATE_KEY)'
if printf '%s' "$TOOL_RESPONSE" | grep -iEq "$LEAK_PATTERNS" 2>/dev/null; then
  LEAK_WARNING="true"
fi

# 写入审计日志
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
SESSION_ID="${CLAUDE_SESSION_ID:-unknown}"

# 生成 input 摘要（取前 200 字符）
INPUT_SUMMARY=$(printf '%s' "$INPUT" | grep -o '"tool_input"[[:space:]]*:[[:space:]]*{[^}]*}' | head -1 | head -c 200 | sed 's/\\/\\\\/g;s/"/\\"/g')

mkdir -p "$(dirname "$AUDIT_LOG")"

printf '{"time":"%s","session":"%s","tool":"%s","action":"completed","input_summary":"%s","sensitive_leak_warning":%s}\n' \
  "$TIMESTAMP" "$SESSION_ID" "$TOOL_NAME" "$INPUT_SUMMARY" "$LEAK_WARNING" \
  >> "$AUDIT_LOG" 2>/dev/null

exit 0
