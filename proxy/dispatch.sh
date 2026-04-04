#!/usr/bin/env bash
# ============================================================================
# dispatch.sh — Tool Proxy 统一分发器（唯一的 PreToolUse hook 入口）
#
# 功能：接收 Claude Code 工具调用的 JSON（stdin），根据 tool_name 查找
#       对应的代理脚本（$PROXY_DIR/<tool_name>.sh），存在则委托执行，
#       不存在则直接放行（exit 0，无输出）。
#
# stdin:  Claude Code PreToolUse hook JSON
#         {"tool_name":"Read","tool_input":{"file_path":"/foo/bar"}}
# stdout: 代理脚本的输出（如果有），或无输出（放行）
# stderr: 代理脚本的 stderr（如果有）
#
# exit code:
#   0 — 放行（无代理脚本 / 代理脚本决定放行）
#   2 — 拒绝（代理脚本返回 deny）
#   其他 — 代理脚本的退出码透传
#
# 性能目标：无代理脚本时 < 5ms（仅一次文件检查 + exit）
# ============================================================================
set -euo pipefail

PROXY_DIR="${CLAUDE_PROXY_DIR:-"${CLAUDE_PROJECT_DIR:-.}"/.claude/proxy}"

# 一次性读取 stdin
INPUT=$(cat)

# 提取 tool_name（轻量解析，避免依赖 jq）
TOOL_NAME=$(printf '%s' "$INPUT" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"tool_name"[[:space:]]*:[[:space:]]*"//;s/"//')

if [[ -z "$TOOL_NAME" ]]; then
  exit 0
fi

# 安全校验：TOOL_NAME 仅允许字母、数字、下划线、连字符（防路径穿越）
if [[ "$TOOL_NAME" =~ [^a-zA-Z0-9_-] ]]; then
  exit 0
fi

# 查找代理脚本
SCRIPT=""

# 精确匹配
if [[ -x "$PROXY_DIR/$TOOL_NAME.sh" ]]; then
  SCRIPT="$PROXY_DIR/$TOOL_NAME.sh"
# MCP 工具：mcp__server__tool → 先找精确，再找 server 级通配
elif [[ "$TOOL_NAME" == mcp__*__* ]]; then
  # 提取 server 名：mcp__server__tool → mcp__server
  MCP_SERVER="${TOOL_NAME%__*}"
  if [[ -x "$PROXY_DIR/$MCP_SERVER.sh" ]]; then
    SCRIPT="$PROXY_DIR/$MCP_SERVER.sh"
  fi
fi

# 无代理脚本 → 放行
if [[ -z "$SCRIPT" ]]; then
  exit 0
fi

# 委托给代理脚本，传递环境变量
export CLAUDE_PROXY_DIR="$PROXY_DIR"
printf '%s' "$INPUT" | "$SCRIPT"
