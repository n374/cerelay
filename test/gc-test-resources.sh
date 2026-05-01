#!/bin/sh

set -eu

if [ -z "${CERELAY_TEST_ENV_COMMON_LOADED:-}" ]; then
  script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  . "$script_dir/test-env-common.sh"
fi

test_slug_for_branch() {
  branch=$1
  slug=$(echo "$branch" | tr -c 'a-zA-Z0-9' '_' | cut -c1-40)
  printf '%s\n' "$slug"
}

test_lower() {
  tr '[:upper:]' '[:lower:]'
}

test_active_slugs_file() {
  slugs_file=$1

  git for-each-ref --format='%(refname:short)' refs/heads/ 2>/dev/null | while IFS= read -r branch_name; do
    [ -n "$branch_name" ] || continue
    test_slug_for_branch "$branch_name" | test_lower
  done | sort -u > "$slugs_file"
}

test_slug_is_active() {
  slug_value=$1
  slugs_file=$2

  grep -Fx "$slug_value" "$slugs_file" >/dev/null 2>&1
}

test_should_gc_slug() {
  slug_value=$1
  slugs_file=$2
  all_flag=$3

  if [ "$all_flag" = "true" ]; then
    return 0
  fi

  case "$slug_value" in
    sha_*)
      return 1
      ;;
  esac

  if test_slug_is_active "$slug_value" "$slugs_file"; then
    return 1
  fi

  return 0
}

test_list_compose_projects() {
  command -v docker >/dev/null 2>&1 || return 0

  if command -v jq >/dev/null 2>&1; then
    json=$(docker compose ls --all --format json 2>/dev/null || true)
    if [ -n "$json" ]; then
      printf '%s\n' "$json" | jq -r '.[]? | .Name // .name // empty' 2>/dev/null || true
      return 0
    fi
  fi

  docker compose ls --all 2>/dev/null | awk 'NR > 1 { print $1 }' || true
}

test_gc_compose_projects() {
  slugs_file=$1
  all_flag=$2

  test_list_compose_projects | while IFS= read -r project_name; do
    [ -n "$project_name" ] || continue
    project_normalized=$(printf '%s\n' "$project_name" | test_lower)

    case "$project_normalized" in
      cerelay_*)
        project_slug=${project_normalized#cerelay_}
        ;;
      *)
        continue
        ;;
    esac

    if test_should_gc_slug "$project_slug" "$slugs_file" "$all_flag"; then
      echo "[test-gc] removing compose project: $project_normalized"
      docker compose -p "$project_normalized" -f docker-compose.test.yml down -v --rmi local --remove-orphans >/dev/null 2>&1 || true
    fi
  done
}

test_gc_host_tmp() {
  slugs_file=$1
  all_flag=$2
  tmp_base=${TMPDIR:-/tmp}

  [ -d "$tmp_base" ] || return 0

  find "$tmp_base" -maxdepth 1 -type d -name 'cerelay-test-*' 2>/dev/null | while IFS= read -r tmp_dir; do
    tmp_name=${tmp_dir##*/}
    tmp_slug=${tmp_name#cerelay-test-}
    tmp_slug_normalized=$(printf '%s\n' "$tmp_slug" | test_lower)

    if test_should_gc_slug "$tmp_slug_normalized" "$slugs_file" "$all_flag"; then
      echo "[test-gc] removing host tmp: $tmp_dir"
      rm -rf "$tmp_dir"
    fi
  done
}

test_gc_resources() {
  all_flag=false

  case "${1:-}" in
    --all)
      all_flag=true
      ;;
    "")
      ;;
    *)
      echo "usage: $0 [--all]" >&2
      return 2
      ;;
  esac

  slugs_file=$(mktemp "${TMPDIR:-/tmp}/cerelay-active-slugs.XXXXXX")
  trap 'rm -f "$slugs_file"' EXIT INT TERM

  test_active_slugs_file "$slugs_file"
  test_gc_compose_projects "$slugs_file" "$all_flag"
  test_gc_host_tmp "$slugs_file" "$all_flag"

  rm -f "$slugs_file"
  trap - EXIT INT TERM
}

if (return 0 2>/dev/null); then
  :
else
  test_gc_resources "$@"
fi
