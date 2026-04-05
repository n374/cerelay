#!/usr/bin/env bash
# ============================================================================
# lib.sh — Tool Proxy 公共函数库
#
# 各代理脚本通过 source "$CLAUDE_PROXY_DIR/lib.sh" 引入。
# 提供 JSON 解析、决策输出、Mock 数据、路径匹配、审计日志等通用函数。
#
# 依赖：bash, grep, sed, date
# 可选依赖：jq（JSON 解析加速）, python3（jq 不可用时回退）, curl（远程 mock）
# ============================================================================

# 严格模式由调用方设置，此处不重复设置避免覆盖

PROXY_DIR="${CLAUDE_PROXY_DIR:-"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"}"
PROXY_DATA_DIR="${PROXY_DIR}/../proxy-data"
MOCK_DIR="${PROXY_DATA_DIR}/mock"
AUDIT_LOG="${PROXY_DATA_DIR}/audit.jsonl"
SENSITIVE_PATTERNS_FILE="${PROXY_DIR}/sensitive-patterns.txt"

# ============================================================================
# JSON 解析
# ============================================================================

proxy_get_field() {
  # 用法：proxy_get_field "$json_string" ".jq_path"
  # 优先 jq，回退 python3
  local json="$1" path="$2"

  if command -v jq &>/dev/null; then
    printf '%s' "$json" | jq -r "$path" 2>/dev/null
  elif command -v python3 &>/dev/null; then
    printf '%s' "$json" | JPATH="$path" python3 -c "
import json, sys, os
data = json.load(sys.stdin)
keys = os.environ['JPATH'].strip('.').split('.')
val = data
for k in keys:
    if isinstance(val, dict):
        val = val.get(k, '')
    else:
        val = ''
        break
print(val if val is not None else '')
" 2>/dev/null
  else
    # 最低限度回退：仅支持简单一级字段（如 .tool_name）
    # 嵌套路径（如 .tool_input.file_path）在此模式下无法解析
    local field
    field=$(printf '%s' "$path" | sed 's/^\.tool_input\.//' | sed 's/^\.//')
    # 检测嵌套路径：如果 field 中还包含 '.'，说明是多层嵌套，无法可靠解析
    # 安全策略：fail-closed — exit 2 让 Claude Code 拒绝此次工具调用
    if [[ "$field" == *"."* ]]; then
      echo "proxy: JSON parser unavailable (install jq or python3), blocking for safety" >&2
      exit 2
    fi
    printf '%s' "$json" | grep -o "\"$field\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed "s/.*\"$field\"[[:space:]]*:[[:space:]]*\"//;s/\"$//"
  fi
}

# ============================================================================
# 决策输出
# ============================================================================

proxy_allow() {
  # 放行，可选携带 updatedInput
  # 用法：proxy_allow [updatedInput_json]
  if [[ -n "${1:-}" ]]; then
    printf '{"decision":"allow","updatedInput":%s}\n' "$1"
  fi
  exit 0
}

proxy_deny() {
  # 拒绝并输出原因到 stderr
  # 用法：proxy_deny "reason message"
  local reason="${1:-Access denied by proxy}"
  echo "$reason" >&2
  exit 2
}

_json_escape() {
  # JSON 字符串转义：处理反斜杠、双引号、控制字符（U+0000-U+001F）
  printf '%s' "$1" | sed 's/\\/\\\\/g;s/"/\\"/g;s/\t/\\t/g' | tr -d '\000-\011\013-\037' | tr '\n' ' '
}

proxy_deny_with_context() {
  # 拒绝但通过 additionalContext 注入信息（如伪造的错误信息）
  # 用法：proxy_deny_with_context "reason" "context content"
  local reason="$1" context="$2"
  # JSON 转义
  local escaped_reason escaped_context
  escaped_reason=$(_json_escape "$reason")
  escaped_context=$(_json_escape "$context")
  printf '{"decision":"deny","reason":"%s","additionalContext":"%s"}\n' "$escaped_reason" "$escaped_context"
  exit 0
}

proxy_passthrough() {
  # 完全放行，不做任何输出
  exit 0
}

# ============================================================================
# Mock 数据
# ============================================================================

proxy_get_mock_path() {
  # 返回本地 mock 文件路径（如果存在）
  # 用法：proxy_get_mock_path "/absolute/path/to/file"
  local original_path="$1"
  local project_dir="${CLAUDE_PROJECT_DIR:-.}"

  # 计算相对路径
  local rel_path
  rel_path="${original_path#"$project_dir"/}"

  # 如果没变说明不在项目目录下，用绝对路径的 basename
  if [[ "$rel_path" == "$original_path" ]]; then
    rel_path=$(basename "$original_path")
  fi

  local mock_path="$MOCK_DIR/$rel_path"
  if [[ -f "$mock_path" ]]; then
    printf '%s' "$mock_path"
  fi
}

proxy_fetch_remote_mock() {
  # 从远程下载 mock 数据到本地缓存（5 分钟 TTL）
  # 用法：proxy_fetch_remote_mock "/absolute/path/to/file"
  # 需要设置 MOCK_BASE_URL 环境变量
  local original_path="$1"

  if [[ -z "${MOCK_BASE_URL:-}" ]]; then
    return
  fi

  if ! command -v curl &>/dev/null; then
    return
  fi

  local project_dir="${CLAUDE_PROJECT_DIR:-.}"
  local rel_path="${original_path#"$project_dir"/}"
  local cache_path="$MOCK_DIR/.remote-cache/$rel_path"
  local cache_dir
  cache_dir=$(dirname "$cache_path")

  # 检查缓存有效期（5 分钟）
  if [[ -f "$cache_path" ]]; then
    local age
    age=$(( $(date +%s) - $(stat -f %m "$cache_path" 2>/dev/null || stat -c %Y "$cache_path" 2>/dev/null || echo 0) ))
    if (( age < 300 )); then
      printf '%s' "$cache_path"
      return
    fi
  fi

  # 下载
  mkdir -p "$cache_dir"
  if curl -sf --max-time 3 "${MOCK_BASE_URL}/${rel_path}" -o "$cache_path" 2>/dev/null; then
    printf '%s' "$cache_path"
  fi
}

# ============================================================================
# 路径匹配
# ============================================================================

_SENSITIVE_PATTERNS_CACHE=""

_load_sensitive_patterns() {
  if [[ -n "$_SENSITIVE_PATTERNS_CACHE" ]]; then
    return
  fi

  if [[ -f "$SENSITIVE_PATTERNS_FILE" ]]; then
    _SENSITIVE_PATTERNS_CACHE=$(grep -v '^[[:space:]]*$' "$SENSITIVE_PATTERNS_FILE" | grep -v '^#')
  else
    # 内置默认模式
    _SENSITIVE_PATTERNS_CACHE='\.env$
\.env\.
secrets/
credentials/
private/
\.pem$
\.key$
\.p12$
\.jks$
\.pfx$
config/prod
config/production
\.aws/
\.ssh/
id_rsa
password
token
secret
credential
api[_-]?key'
  fi
}

proxy_matches_sensitive() {
  # 检查路径是否匹配敏感文件模式
  # 用法：proxy_matches_sensitive "/path/to/file"
  # 返回：0=匹配（敏感），1=不匹配
  local file_path="$1"

  _load_sensitive_patterns

  # 使用 process substitution 逐行匹配，避免模式拼接导致 | 污染
  printf '%s' "$file_path" | grep -iEqf <(printf '%s\n' "$_SENSITIVE_PATTERNS_CACHE")
}

proxy_is_config_file() {
  # 检查是否是 Claude 配置文件（永远放行）
  # 用法：proxy_is_config_file "/path/to/file"
  # 返回：0=是配置文件，1=不是
  local file_path="$1"

  case "$file_path" in
    */.claude/*|*/CLAUDE.md|*/.claude.json|*/CLAUDE.local.md)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

# ============================================================================
# 审计日志
# ============================================================================

proxy_audit_log() {
  # 同步写入审计日志（避免后台写入竞态）
  # 用法：proxy_audit_log "tool_name" "action" "detail"
  local tool_name="$1" action="$2" detail="${3:-}"
  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  local session_id="${CLAUDE_SESSION_ID:-unknown}"

  local escaped_detail
  escaped_detail=$(_json_escape "$(printf '%s' "$detail" | head -c 500)")

  mkdir -p "$(dirname "$AUDIT_LOG")"

  # 简单轮转：超过 10MB 时重命名为 .1（覆盖旧的 .1）
  if [[ -f "$AUDIT_LOG" ]]; then
    local size
    size=$(stat -f%z "$AUDIT_LOG" 2>/dev/null || stat -c%s "$AUDIT_LOG" 2>/dev/null || echo 0)
    if (( size > 10485760 )); then
      mv -f "$AUDIT_LOG" "${AUDIT_LOG}.1" 2>/dev/null || true
    fi
  fi

  local escaped_session
  escaped_session=$(_json_escape "$session_id")

  printf '{"time":"%s","session":"%s","tool":"%s","action":"%s","detail":"%s"}\n' \
    "$timestamp" "$escaped_session" "$tool_name" "$action" "$escaped_detail" \
    >> "$AUDIT_LOG" 2>/dev/null
}

# ============================================================================
# Axon Hook Relay
# ============================================================================

proxy_emit_deny() {
  # 输出官方 hookSpecificOutput deny JSON / Emit official hookSpecificOutput deny JSON
  # 用法 / Usage: proxy_emit_deny "reason" ["additionalContext"]
  local reason="${1:-Access denied by Axon proxy}"
  local additional_context="${2:-}"
  local escaped_reason escaped_context

  escaped_reason=$(_json_escape "$reason")
  escaped_context=$(_json_escape "$additional_context")

  if [[ -n "$additional_context" ]]; then
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s","additionalContext":"%s"}}\n' \
      "$escaped_reason" "$escaped_context"
  else
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' \
      "$escaped_reason"
  fi
}

proxy_emit_allow() {
  # 输出官方 hookSpecificOutput allow JSON；无参数时 passthrough / Emit official allow JSON; no output when omitted
  # 用法 / Usage: proxy_emit_allow [updatedInput_json]
  local updated_input="${1:-}"

  if [[ -z "$updated_input" ]]; then
    return 0
  fi

  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":%s}}\n' \
    "$updated_input"
}

proxy_relay_to_server() {
  # 中继 Hook 请求到 Axon Server；失败时返回 deny / Relay Hook request to Axon Server; deny on failure
  # 用法 / Usage: proxy_relay_to_server
  local request_body
  local response_body
  local http_code

  if [[ -z "${AXON_CALLBACK_URL:-}" ]]; then
    proxy_emit_deny "AXON_CALLBACK_URL 未设置 / AXON_CALLBACK_URL is not set"
    return 0
  fi

  request_body=$(cat)
  response_body=$(mktemp "${TMPDIR:-/tmp}/axon-hook-response.XXXXXX") || {
    proxy_emit_deny "创建临时文件失败 / Failed to create temp file"
    return 0
  }

  http_code=$(curl -s --max-time 120 -o "$response_body" -w '%{http_code}' \
    -X POST \
    -H 'Content-Type: application/json' \
    --data-binary "$request_body" \
    "$AXON_CALLBACK_URL" 2>/dev/null) || {
      rm -f "$response_body"
      proxy_emit_deny "Axon relay 网络错误或超时 / Axon relay network error or timeout"
      return 0
    }

  if [[ "$http_code" == "200" ]]; then
    cat "$response_body"
    rm -f "$response_body"
    return 0
  fi

  rm -f "$response_body"
  proxy_emit_deny "Axon relay 返回非 200 状态 / Axon relay returned non-200 status"
}
