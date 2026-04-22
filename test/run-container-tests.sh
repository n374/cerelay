#!/bin/sh

set -eu

compose_cmd="docker compose -f docker-compose.test.yml"

cleanup() {
  $compose_cmd down -v --remove-orphans >/dev/null 2>&1 || true
}

trap cleanup EXIT INT TERM

$compose_cmd up --build -d mock-socks mock-dns egress-probe cerelay-socks-test
$compose_cmd run --build --rm test
