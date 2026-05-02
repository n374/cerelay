#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

. "$script_dir/test-env-common.sh"
. "$script_dir/gc-test-resources.sh"

test_gc_resources

rm -rf "$HOST_TMP_ROOT"
mkdir -p "$HOST_TMP_ROOT/data" "$HOST_TMP_ROOT/sockets" "$HOST_TMP_ROOT/namespace-runtime"

export TMPDIR="$HOST_TMP_ROOT"
export CERELAY_DATA_DIR="$HOST_TMP_ROOT/data"
export CERELAY_SHADOW_MCP_SOCKET_DIR="$HOST_TMP_ROOT/sockets"
export CERELAY_NAMESPACE_RUNTIME_ROOT="$HOST_TMP_ROOT/namespace-runtime"

npm run test:smoke
npm run test:workspaces

echo "[host-tests] e2e comprehensive (in containers)"
sh "$script_dir/run-e2e-comprehensive.sh"
