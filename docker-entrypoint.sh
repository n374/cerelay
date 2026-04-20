#!/bin/sh
# ============================================================
# Cerelay Server 容器入口脚本
# 职责：
#   1. 初始化 Claude Code 登录态
#   2. 可选写入额外 claude CLI 配置
#   3. 启动 cerelay-server
# ============================================================

set -e

# --- 颜色输出 ---
info()  { printf '\033[0;36m[cerelay-server] %s\033[0m\n' "$*"; }
warn()  { printf '\033[0;33m[cerelay-server] WARNING: %s\033[0m\n' "$*"; }
error() { printf '\033[0;31m[cerelay-server] ERROR: %s\033[0m\n' "$*" >&2; }

# --- 参数配置 ---
PORT="${PORT:-8765}"
MODEL="${MODEL:-claude-sonnet-4-20250514}"
LOG_LEVEL="${LOG_LEVEL:-info}"
LOG_JSON="${LOG_JSON:-false}"

info "启动 Cerelay Server"
info "  端口: ${PORT}"
info "  模型: ${MODEL}"
info "  日志级别: ${LOG_LEVEL}"
info "  JSON 日志: ${LOG_JSON}"
if [ -n "${CERELAY_KEY}" ]; then
  info "  CERELAY_KEY: 已配置（Client 连接需提供匹配的 key）"
fi

# --- Claude Code 登录态初始化 ---
CLAUDE_CONFIG_DIR="${HOME}/.claude"
mkdir -p "${CLAUDE_CONFIG_DIR}"

# 写入 onboarding 标记，防止 Claude Code 进入首次安装向导
# 使用 node 合并而非覆盖，保留已有字段
node -e "
const fs = require('fs');
const p = process.env.HOME + '/.claude.json';
let obj = {};
try { obj = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
obj.hasCompletedOnboarding = true;
obj.installMethod = 'native';
fs.writeFileSync(p, JSON.stringify(obj) + '\n');
"

# 登录凭证：优先通过 CLAUDE_CREDENTIALS 环境变量注入，否则依赖 bind mount
if [ -n "${CLAUDE_CREDENTIALS}" ]; then
  printf '%s\n' "${CLAUDE_CREDENTIALS}" > "${CLAUDE_CONFIG_DIR}/.credentials.json"
  info "已通过 CLAUDE_CREDENTIALS 环境变量写入登录凭证"
elif [ -f "${CLAUDE_CONFIG_DIR}/.credentials.json" ]; then
  info "检测到已挂载的 Claude Code 登录凭证"
else
  warn "未找到 Claude Code 登录凭证（~/.claude/.credentials.json），Claude CLI 可能无法认证"
fi

# --- DEBUG: 容器级文件诊断 ---
info "=== [DEBUG] 容器级凭证文件诊断 ==="
info ".claude/ 目录内容:"
ls -la "${CLAUDE_CONFIG_DIR}/" 2>&1 | while IFS= read -r line; do info "  $line"; done
info ".credentials.json 大小与权限:"
ls -la "${CLAUDE_CONFIG_DIR}/.credentials.json" 2>&1 | while IFS= read -r line; do info "  $line"; done
info ".credentials.json 内容（前200字符，脱敏）:"
if [ -f "${CLAUDE_CONFIG_DIR}/.credentials.json" ]; then
  cred_preview=$(head -c 200 "${CLAUDE_CONFIG_DIR}/.credentials.json" | sed 's/"[a-zA-Z0-9_-]\{20,\}"/"***REDACTED***"/g')
  info "  ${cred_preview}"
else
  info "  文件不存在"
fi
info ".claude.json 内容:"
if [ -f "${HOME}/.claude.json" ]; then
  claude_json=$(cat "${HOME}/.claude.json")
  info "  ${claude_json}"
else
  info "  文件不存在"
fi
info "=== [DEBUG] 容器级凭证诊断结束 ==="

# 如果提供了 CLAUDE_CONFIG（JSON 字符串），写入配置文件
if [ -n "${CLAUDE_CONFIG}" ]; then
  info "写入 claude CLI 额外配置..."
  printf '%s' "${CLAUDE_CONFIG}" > "${CLAUDE_CONFIG_DIR}/claude_config.json"
fi

# API Key 检测（与 credentials 互补，均可用于认证）
if [ -n "${ANTHROPIC_API_KEY}" ]; then
  info "检测到 ANTHROPIC_API_KEY 环境变量"
elif [ -n "${ANTHROPIC_AUTH_TOKEN}" ]; then
  info "检测到 ANTHROPIC_AUTH_TOKEN 环境变量"
fi

# 验证 claude CLI 可用
if ! command -v claude > /dev/null 2>&1; then
  error "claude CLI 未找到，请检查镜像构建"
  exit 1
fi

info "claude CLI 版本: $(claude --version 2>/dev/null || echo '未知')"

# --- 启动 Cerelay Server ---
set -- node /app/server/dist/index.js \
  --port "${PORT}" \
  --model "${MODEL}" \
  --log-level "${LOG_LEVEL}"

if [ "${LOG_JSON}" = "true" ]; then
  set -- "$@" --log-json
fi

exec "$@"
