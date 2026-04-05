#!/bin/sh
# ============================================================
# Axon Brain 容器入口脚本
# 职责：
#   1. 验证必要环境变量（ANTHROPIC_API_KEY）
#   2. 设置 claude CLI 认证（写入 ~/.claude/credentials.json）
#   3. 启动 axon-server
# ============================================================

set -e

# --- 颜色输出 ---
info()  { printf '\033[0;36m[axon-brain] %s\033[0m\n' "$*"; }
warn()  { printf '\033[0;33m[axon-brain] WARNING: %s\033[0m\n' "$*"; }
error() { printf '\033[0;31m[axon-brain] ERROR: %s\033[0m\n' "$*" >&2; }

# --- 验证必要环境变量 ---
if [ -z "${ANTHROPIC_API_KEY}" ]; then
  error "ANTHROPIC_API_KEY 未设置"
  error "请通过 -e ANTHROPIC_API_KEY=<your-key> 传入，或在 .env 文件中配置"
  exit 1
fi

# --- 参数配置 ---
PORT="${PORT:-8765}"
MODEL="${MODEL:-claude-sonnet-4-20250514}"

info "启动 Axon Brain Server"
info "  端口: ${PORT}"
info "  模型: ${MODEL}"

# --- 设置 claude CLI 认证 ---
# claude CLI 读取 ~/.claude/ 目录下的凭证
CLAUDE_CONFIG_DIR="${HOME}/.claude"
mkdir -p "${CLAUDE_CONFIG_DIR}"

# 如果提供了 CLAUDE_CONFIG（JSON 字符串），写入配置文件
if [ -n "${CLAUDE_CONFIG}" ]; then
  info "写入 claude CLI 配置..."
  printf '%s' "${CLAUDE_CONFIG}" > "${CLAUDE_CONFIG_DIR}/claude_config.json"
fi

# claude CLI 使用 ANTHROPIC_API_KEY 环境变量，无需额外写入凭证文件
# 验证 claude CLI 可用
if ! command -v claude > /dev/null 2>&1; then
  error "claude CLI 未找到，请检查镜像构建"
  exit 1
fi

info "claude CLI 版本: $(claude --version 2>/dev/null || echo '未知')"

# --- 启动 Axon Server ---
exec node /app/server/dist/index.js --port "${PORT}" --model "${MODEL}"
