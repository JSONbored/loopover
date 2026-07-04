#!/usr/bin/env bash
# Shared helpers for the self-host deploy scripts (deploy-selfhost-image.sh, deploy-selfhost-prebuilt.sh).
# Sourced, not executed: this file has no shebang-driven side effects and defines functions only.
# Both callers set ENV_FILE before sourcing this; env_get/env_put fall back to it when no file arg is given.

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: required command not found: $1" >&2
    exit 1
  fi
}

env_get() {
  local key="$1"
  local file="${2:-$ENV_FILE}"

  [ -f "$file" ] || return 1

  awk -v key="$key" '
    /^[[:space:]]*(#|$)/ { next }
    {
      line = $0
      sub(/^[[:space:]]*/, "", line)
      if (line !~ "^" key "[[:space:]]*=") {
        next
      }
      sub(/^[^=]*=/, "", line)
      sub(/^[[:space:]]*/, "", line)
      sub(/[[:space:]]*$/, "", line)
      if (length(line) >= 2) {
        first = substr(line, 1, 1)
        last = substr(line, length(line), 1)
        if ((first == "\"" && last == "\"") || (first == "'\''" && last == "'\''")) {
          line = substr(line, 2, length(line) - 2)
        }
      }
      print line
      found = 1
      exit
    }
    END { exit found ? 0 : 1 }
  ' "$file"
}

# Same-directory temp file (not the system tmpdir): guarantees `cat "$tmp" >"$file"` never crosses a
# filesystem boundary, which a plain `mktemp` could when $ENV_FILE lives on a different mount than the
# default tmp directory (#2910 -- this was previously only true for deploy-selfhost-image.sh's copy of
# this function; deploy-selfhost-prebuilt.sh's copy used a plain `mktemp` with no documented reason for
# the difference, so consolidating adopts the more defensive behavior for both callers).
env_put() {
  local key="$1"
  local value="$2"
  local file="${3:-$ENV_FILE}"
  local dir base tmp

  touch "$file"
  dir="$(dirname "$file")"
  base="$(basename "$file")"
  tmp="$(mktemp "$dir/.${base}.tmp.XXXXXX")"
  awk -v key="$key" -v value="$value" '
    BEGIN { written = 0 }
    {
      line = $0
      sub(/^[[:space:]]*/, "", line)
      if (line ~ "^" key "[[:space:]]*=") {
        print key "=" value
        written = 1
      } else {
        print $0
      }
    }
    END {
      if (!written) {
        print key "=" value
      }
    }
  ' "$file" >"$tmp"
  cat "$tmp" >"$file"
  rm -f "$tmp"
}

compose_file_args() {
  local files=()
  local file

  if [ -n "${SELFHOST_COMPOSE_FILES:-}" ]; then
    # shellcheck disable=SC2206
    files=(${SELFHOST_COMPOSE_FILES})
  else
    files=(docker-compose.yml)
    [ -f docker-compose.override.yml ] && files+=(docker-compose.override.yml)
  fi

  for file in "${files[@]}"; do
    if [ ! -f "$file" ]; then
      echo "error: compose file not found: $file" >&2
      exit 1
    fi
    printf '%s\n' -f "$file"
  done
}
