#!/bin/sh

set -eu

if [ -z "${CERELAY_SOCKS_DNS_SERVER:-}" ] || ! echo "${CERELAY_SOCKS_DNS_SERVER}" | grep -Eq '^[0-9.]+$'; then
  resolved=$(getent hosts "${CERELAY_SOCKS_DNS_SERVER:-mock-dns}" | awk 'NR == 1 { print $1 }')
  if [ -z "$resolved" ]; then
    echo "[entrypoint] failed to resolve ${CERELAY_SOCKS_DNS_SERVER:-mock-dns}" >&2
    exit 1
  fi
  export CERELAY_SOCKS_DNS_SERVER="$resolved"
fi

exec /usr/local/bin/docker-entrypoint.sh "$@"
