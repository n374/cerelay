#!/bin/sh

branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo "sha-$(git rev-parse --short HEAD)")
slug=$(echo "$branch" | tr -c 'a-zA-Z0-9' '_' | cut -c1-40)

COMPOSE_PROJECT_NAME="cerelay_${slug}"
HOST_TMP_ROOT="${TMPDIR:-/tmp}/cerelay-test-${slug}"

export COMPOSE_PROJECT_NAME
export HOST_TMP_ROOT
export CERELAY_TEST_ENV_COMMON_LOADED=1
