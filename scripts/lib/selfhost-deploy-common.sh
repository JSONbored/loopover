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
  local dir base tmp mode

  touch "$file"
  # Preserve the target file's mode across the atomic rename below. mktemp creates $tmp at 0600, so a bare
  # `mv "$tmp" "$file"` would silently narrow $file's permissions to 0600 on every write (#7766). Capture the
  # existing mode first and re-apply it to $tmp before the swap. GNU stat with a BSD `stat -f` fallback,
  # matching backup-metrics.sh's own stat-portability idiom.
  mode="$(stat -c '%a' "$file" 2>/dev/null || stat -f '%Lp' "$file")"
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
  # Atomic swap: a rename can't leave $file truncated/corrupted if the process is killed mid-write, unlike the
  # previous `cat "$tmp" >"$file"` truncate-then-copy the same-directory temp file was always meant to enable
  # (#7766). chmod first so the rename preserves the target's original mode (see the stat above).
  chmod "$mode" "$tmp"
  mv "$tmp" "$file"
}

# Optional Infisical wrapper (#5120): when SELFHOST_USE_INFISICAL=1 (opt-in, off by default), prefixes the
# given command with `infisical run --` so Infisical-sourced secrets are injected as real process env vars at
# launch -- Infisical's own intended integration shape, requiring zero changes to how src/ reads env.SOMETHING.
# Strictly additive: with the flag unset/0, this is a transparent passthrough and the existing .env/Docker
# Compose secrets: path is completely unaffected.
#
# `infisical run --` only injects vars into ITS OWN child process's environment, so this must wrap the compose
# `up` invocation directly (the container's actual process launch), not some earlier step -- a var it injects
# is visible to `docker compose up` for interpolating `${VAR}` in docker-compose.yml's own `environment:`
# blocks, but NOT to a blanket `env_file: .env` passthrough (that reads the FILE's literal contents at
# container-runtime, unaffected by the calling shell's environment). See the self-hosting docs for which
# variables can actually be Infisical-sourced today given that distinction.
maybe_infisical_run() {
  if [ "${SELFHOST_USE_INFISICAL:-0}" = "1" ]; then
    require_cmd infisical
    infisical run -- "$@"
  else
    "$@"
  fi
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
