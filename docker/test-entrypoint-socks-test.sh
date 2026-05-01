#!/bin/sh

set -eu

# sing-box 的 outbound 与 dns server 字段如果使用 hostname，会触发
# "DNS query loopback in transport[remote-dns]" —— 因为解析 hostname 需要
# DNS，而 DNS 又走 detour:proxy，proxy 自己又要先解析 hostname。
# 因此本 entrypoint 把 service name 全部预解析为 IP 后再交给下游。

resolve_host_to_ip() {
  host=$1
  resolved=$(getent hosts "$host" | awk 'NR == 1 { print $1 }')
  if [ -z "$resolved" ]; then
    echo "[entrypoint] failed to resolve $host" >&2
    return 1
  fi
  printf '%s' "$resolved"
}

# CERELAY_SOCKS_DNS_SERVER 通常是裸 hostname/IP，可能含 scheme（tcp://、tls:// 等）
if [ -n "${CERELAY_SOCKS_DNS_SERVER:-}" ]; then
  dns_value=$CERELAY_SOCKS_DNS_SERVER
  case "$dns_value" in
    *://*) dns_scheme="${dns_value%%://*}://"; dns_rest="${dns_value#*://}" ;;
    *) dns_scheme=""; dns_rest="$dns_value" ;;
  esac
  dns_host="${dns_rest%%:*}"
  dns_host="${dns_host%%/*}"
  if [ -n "$dns_host" ] && ! printf '%s' "$dns_host" | grep -Eq '^[0-9.]+$'; then
    dns_ip=$(resolve_host_to_ip "$dns_host")
    dns_suffix="${dns_rest#${dns_host}}"
    export CERELAY_SOCKS_DNS_SERVER="${dns_scheme}${dns_ip}${dns_suffix}"
  fi
fi

# CERELAY_SOCKS_PROXY 形如 socks5://[user:pass@]hostname:port
if [ -n "${CERELAY_SOCKS_PROXY:-}" ]; then
  proxy_value=$CERELAY_SOCKS_PROXY
  case "$proxy_value" in
    *://*) proxy_scheme="${proxy_value%%://*}://"; proxy_rest="${proxy_value#*://}" ;;
    *) proxy_scheme=""; proxy_rest="$proxy_value" ;;
  esac
  case "$proxy_rest" in
    *@*) proxy_userinfo="${proxy_rest%%@*}@"; proxy_after_at="${proxy_rest#*@}" ;;
    *) proxy_userinfo=""; proxy_after_at="$proxy_rest" ;;
  esac
  proxy_host="${proxy_after_at%%:*}"
  proxy_host="${proxy_host%%/*}"
  if [ -n "$proxy_host" ] && ! printf '%s' "$proxy_host" | grep -Eq '^[0-9.]+$'; then
    proxy_ip=$(resolve_host_to_ip "$proxy_host")
    proxy_tail="${proxy_after_at#${proxy_host}}"
    export CERELAY_SOCKS_PROXY="${proxy_scheme}${proxy_userinfo}${proxy_ip}${proxy_tail}"
  fi
fi

exec /usr/local/bin/docker-entrypoint.sh "$@"
