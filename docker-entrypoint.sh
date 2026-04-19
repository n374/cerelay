#!/bin/sh
# ============================================================
# Axon Brain 容器入口脚本
# 职责：
#   1. 复用挂载的 ~/.claude 与当前环境变量
#   2. 可选写入额外 claude CLI 配置
#   3. 启动 axon-server
# ============================================================

set -e

# --- 颜色输出 ---
info()  { printf '\033[0;36m[axon-brain] %s\033[0m\n' "$*"; }
warn()  { printf '\033[0;33m[axon-brain] WARNING: %s\033[0m\n' "$*"; }
error() { printf '\033[0;31m[axon-brain] ERROR: %s\033[0m\n' "$*" >&2; }

# --- 参数配置 ---
PORT="${PORT:-8765}"
MODEL="${MODEL:-claude-sonnet-4-20250514}"
LOG_LEVEL="${LOG_LEVEL:-info}"
LOG_JSON="${LOG_JSON:-false}"

info "启动 Axon Brain Server"
info "  端口: ${PORT}"
info "  模型: ${MODEL}"
info "  日志级别: ${LOG_LEVEL}"
info "  JSON 日志: ${LOG_JSON}"
if [ -n "${AXON_KEY}" ]; then
  info "  AXON_KEY: 已配置（Hand 连接需提供匹配的 key）"
fi

# --- 设置 claude CLI 认证 ---
# claude CLI 读取 ~/.claude/ 目录下的凭证
CLAUDE_CONFIG_DIR="${HOME}/.claude"
mkdir -p "${CLAUDE_CONFIG_DIR}"

# 如果提供了 CLAUDE_CONFIG（JSON 字符串），写入配置文件
if [ -n "${CLAUDE_CONFIG}" ]; then
  info "写入 claude CLI 配置..."
  printf '%s' "${CLAUDE_CONFIG}" > "${CLAUDE_CONFIG_DIR}/claude_config.json"
fi

# claude CLI 可使用 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN 等环境变量
# 但如果未显式传入，也允许直接复用挂载的 ~/.claude 认证状态
if [ -n "${ANTHROPIC_API_KEY}" ]; then
  info "检测到 ANTHROPIC_API_KEY 环境变量"
elif [ -n "${ANTHROPIC_AUTH_TOKEN}" ]; then
  info "检测到 ANTHROPIC_AUTH_TOKEN 环境变量"
elif find "${CLAUDE_CONFIG_DIR}" -mindepth 1 -maxdepth 2 -print -quit | grep -q .; then
  info "检测到挂载的 ~/.claude 配置，将复用本机 Claude Code 凭证"
else
  warn "未检测到 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN，也未发现现有 ~/.claude 配置，Claude CLI 可能无法工作"
fi

# 验证 claude CLI 可用
if ! command -v claude > /dev/null 2>&1; then
  error "claude CLI 未找到，请检查镜像构建"
  exit 1
fi

info "claude CLI 版本: $(claude --version 2>/dev/null || echo '未知')"

# --- 启动 Axon Server ---
set -- node /app/server/dist/index.js \
  --port "${PORT}" \
  --model "${MODEL}" \
  --log-level "${LOG_LEVEL}"

if [ "${LOG_JSON}" = "true" ]; then
  set -- "$@" --log-json
fi

exec "$@"
