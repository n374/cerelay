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
CERELAY_SOCKS_PROXY="${CERELAY_SOCKS_PROXY:-}"
CERELAY_SOCKS_DNS_SERVER="${CERELAY_SOCKS_DNS_SERVER:-1.1.1.1}"
CERELAY_SOCKS_TUN_ADDRESS="${CERELAY_SOCKS_TUN_ADDRESS:-172.19.0.1/30}"
CERELAY_SOCKS_TUN_MTU="${CERELAY_SOCKS_TUN_MTU:-9000}"
CERELAY_SOCKS_CONFIG_SCRIPT="${CERELAY_SOCKS_CONFIG_SCRIPT:-/opt/cerelay/socks-proxy-config.mjs}"
CERELAY_SOCKS_CONNECT_TIMEOUT_MS="${CERELAY_SOCKS_CONNECT_TIMEOUT_MS:-5000}"
CERELAY_SOCKS_MONITOR_INTERVAL_SECS="${CERELAY_SOCKS_MONITOR_INTERVAL_SECS:-5}"
CERELAY_SOCKS_CONFIG_DIR="${CERELAY_SOCKS_CONFIG_DIR:-/etc/sing-box}"
CERELAY_RESOLV_CONF_PATH="${CERELAY_RESOLV_CONF_PATH:-/etc/resolv.conf}"
_SINGBOX_PID=""
_MONITOR_PID=""
_MAIN_PID=""
PROXY_HOST=""
PROXY_PORT=""

check_tcp_endpoint() {
  node -e "
    const net = require('node:net');
    const host = process.argv[1];
    const port = Number(process.argv[2]);
    const timeout = Number(process.argv[3]);
    const socket = net.createConnection({ host, port, timeout });
    socket.on('connect', () => { socket.end(); process.exit(0); });
    socket.on('timeout', () => { socket.destroy(); process.exit(1); });
    socket.on('error', () => process.exit(1));
  " "$1" "$2" "${CERELAY_SOCKS_CONNECT_TIMEOUT_MS}"
}

cleanup() {
  if [ -n "${_MONITOR_PID}" ] && kill -0 "${_MONITOR_PID}" 2>/dev/null; then
    kill "${_MONITOR_PID}" 2>/dev/null || true
  fi
  if [ -n "${_MAIN_PID}" ] && kill -0 "${_MAIN_PID}" 2>/dev/null; then
    kill "${_MAIN_PID}" 2>/dev/null || true
  fi
  if [ -n "${_SINGBOX_PID}" ] && kill -0 "${_SINGBOX_PID}" 2>/dev/null; then
    kill "${_SINGBOX_PID}" 2>/dev/null || true
  fi
}

start_socks_tun() {
  [ -n "${CERELAY_SOCKS_PROXY}" ] || return 0

  if ! command -v sing-box > /dev/null 2>&1; then
    error "CERELAY_SOCKS_PROXY 已设置，但 sing-box 不可用"
    exit 1
  fi
  if ! command -v ip > /dev/null 2>&1; then
    error "CERELAY_SOCKS_PROXY 已设置，但 iproute2 不可用"
    exit 1
  fi

  unset ALL_PROXY all_proxy HTTP_PROXY http_proxy HTTPS_PROXY https_proxy NO_PROXY no_proxy

  endpoint="$(node "${CERELAY_SOCKS_CONFIG_SCRIPT}" endpoint "${CERELAY_SOCKS_PROXY}")" || exit 1
  PROXY_HOST="$(printf '%s' "${endpoint}" | awk '{print $1}')"
  PROXY_PORT="$(printf '%s' "${endpoint}" | awk '{print $2}')"

  info "启动容器级透明 SOCKS5 代理（fail-closed）"
  info "  代理: ${PROXY_HOST}:${PROXY_PORT}"
  info "  DNS: ${CERELAY_SOCKS_DNS_SERVER}"

  if ! check_tcp_endpoint "${PROXY_HOST}" "${PROXY_PORT}"; then
    error "SOCKS 代理预检查失败，拒绝启动容器"
    exit 1
  fi

  sysctl -w net.ipv6.conf.all.disable_ipv6=1 >/dev/null 2>&1 || true
  sysctl -w net.ipv6.conf.default.disable_ipv6=1 >/dev/null 2>&1 || true

  mkdir -p "${CERELAY_SOCKS_CONFIG_DIR}"
  node "${CERELAY_SOCKS_CONFIG_SCRIPT}" config "${CERELAY_SOCKS_PROXY}" > "${CERELAY_SOCKS_CONFIG_DIR}/config.json"

  sing-box run -c "${CERELAY_SOCKS_CONFIG_DIR}/config.json" &
  _SINGBOX_PID=$!

  i=0
  while [ "${i}" -lt 150 ]; do
    if ip -o link show tun0 >/dev/null 2>&1; then
      break
    fi
    if ! kill -0 "${_SINGBOX_PID}" 2>/dev/null; then
      error "sing-box 在 TUN 就绪前退出"
      exit 1
    fi
    i=$((i + 1))
    sleep 0.05
  done

  if ! ip -o link show tun0 >/dev/null 2>&1; then
    error "等待 tun0 超时"
    exit 1
  fi

  TUN_BASE="${CERELAY_SOCKS_TUN_ADDRESS%/*}"
  TUN_PREFIX="${TUN_BASE%.*}"
  TUN_LAST="${TUN_BASE##*.}"
  TUN_DNS="${TUN_PREFIX}.$((TUN_LAST + 1))"
  printf 'nameserver %s\noptions ndots:0\n' "${TUN_DNS}" > "${CERELAY_RESOLV_CONF_PATH}"
}

start_proxy_monitor() {
  [ -n "${_SINGBOX_PID}" ] || return 0
  (
    while true; do
      sleep "${CERELAY_SOCKS_MONITOR_INTERVAL_SECS}"
      if ! kill -0 "${_SINGBOX_PID}" 2>/dev/null; then
        error "SOCKS TUN 已停止，终止主进程以保持 fail-closed"
        if [ -n "${_MAIN_PID}" ] && kill -0 "${_MAIN_PID}" 2>/dev/null; then
          kill -TERM "${_MAIN_PID}" 2>/dev/null || true
        fi
        exit 0
      fi
      if ! check_tcp_endpoint "${PROXY_HOST}" "${PROXY_PORT}"; then
        error "SOCKS 代理端点不可达，终止主进程以保持 fail-closed"
        if [ -n "${_MAIN_PID}" ] && kill -0 "${_MAIN_PID}" 2>/dev/null; then
          kill -TERM "${_MAIN_PID}" 2>/dev/null || true
        fi
        exit 0
      fi
    done
  ) &
  _MONITOR_PID=$!
}

trap cleanup EXIT INT TERM

info "启动 Cerelay Server"
info "  端口: ${PORT}"
info "  模型: ${MODEL}"
info "  日志级别: ${LOG_LEVEL}"
info "  JSON 日志: ${LOG_JSON}"
if [ -n "${CERELAY_KEY}" ]; then
  info "  CERELAY_KEY: 已配置（Client 连接需提供匹配的 key）"
fi
if [ -n "${CERELAY_SOCKS_PROXY}" ]; then
  info "  SOCKS TUN: 已启用"
else
  info "  SOCKS TUN: 未启用"
fi

start_socks_tun

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

"$@" &
_MAIN_PID=$!
start_proxy_monitor

set +e
wait "${_MAIN_PID}"
EXIT_CODE=$?
set -e
exit "${EXIT_CODE}"
