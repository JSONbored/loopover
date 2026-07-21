#!/usr/bin/env bash
# Build and deploy the self-host runtime from a prebuilt bundle without relying on host Node/npm.
#
# After a successful run, verify with: ./scripts/selfhost-post-update-check.sh
#
# Defaults are intentionally operator-friendly:
#   ./scripts/deploy-selfhost-prebuilt.sh
#
# Optional knobs:
#   SENTRY_RELEASE=loopover-selfhost@edge-abc123 ./scripts/deploy-selfhost-prebuilt.sh
#   SELFHOST_COMPOSE_FILES="docker-compose.yml docker-compose.override.yml" ./scripts/deploy-selfhost-prebuilt.sh
#   SELFHOST_SKIP_SENTRY_UPLOAD=1 ./scripts/deploy-selfhost-prebuilt.sh
#   SELFHOST_USE_INFISICAL=1 ./scripts/deploy-selfhost-prebuilt.sh   # opt-in Infisical secrets (#5120), see docs
set -euo pipefail

ENV_FILE="${SELFHOST_ENV_FILE:-.env}"
NODE_IMAGE="${SELFHOST_NODE_IMAGE:-public.ecr.aws/docker/library/node:24-slim}"
SERVICE="${SELFHOST_SERVICE:-loopover}"
SKIP_SENTRY_UPLOAD="${SELFHOST_SKIP_SENTRY_UPLOAD:-0}"
SENTRY_CLI_PACKAGE="${SENTRY_CLI_PACKAGE:-@sentry/cli@3.6.0}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/selfhost-deploy-common.sh
. "$SCRIPT_DIR/lib/selfhost-deploy-common.sh"

run_node_build() {
  local uid gid
  uid="$(id -u)"
  gid="$(id -g)"

  echo "selfhost deploy: building bundle with Dockerized Node"
  docker run --rm \
    --user "$uid:$gid" \
    -e HOME=/tmp \
    -e npm_config_cache=/tmp/.npm \
    -v "$PWD:/work" \
    -w /work \
    "$NODE_IMAGE" \
    sh -lc 'npm ci --ignore-scripts && npm --workspace @loopover/engine run build && node --experimental-strip-types scripts/build-selfhost.ts --all && node --experimental-strip-types scripts/validate-selfhost-sourcemap.ts'
}

run_sentry_upload() {
  local auth_token org project uid gid

  auth_token="${SENTRY_AUTH_TOKEN:-$(env_get SENTRY_AUTH_TOKEN || true)}"
  org="${SENTRY_ORG:-$(env_get SENTRY_ORG || true)}"
  project="${SENTRY_PROJECT:-$(env_get SENTRY_PROJECT || true)}"

  if [ "$SKIP_SENTRY_UPLOAD" = "1" ]; then
    echo "selfhost deploy: skipping Sentry upload (SELFHOST_SKIP_SENTRY_UPLOAD=1)"
    return 0
  fi

  if [ -z "$auth_token" ] || [ -z "$org" ] || [ -z "$project" ]; then
    echo "selfhost deploy: skipping Sentry upload (SENTRY_AUTH_TOKEN, SENTRY_ORG, or SENTRY_PROJECT is missing)"
    return 0
  fi

  uid="$(id -u)"
  gid="$(id -g)"

  echo "selfhost deploy: injecting and uploading Sentry source maps for $SENTRY_RELEASE"
  docker run --rm \
    -e HOME=/tmp \
    -e npm_config_cache=/tmp/.npm \
    -e SENTRY_LOAD_DOTENV=0 \
    -e SENTRY_RELEASE \
    -e SENTRY_AUTH_TOKEN="$auth_token" \
    -e SENTRY_ORG="$org" \
    -e SENTRY_PROJECT="$project" \
    -e SENTRY_CLI_PACKAGE="$SENTRY_CLI_PACKAGE" \
    -e HOST_UID="$uid" \
    -e HOST_GID="$gid" \
    -v "$PWD:/work" \
    -w /work \
    "$NODE_IMAGE" \
    sh -lc 'apt-get update >/dev/null && apt-get install -y --no-install-recommends ca-certificates git >/dev/null && git config --global --add safe.directory /work && (npx -y "$SENTRY_CLI_PACKAGE" releases new "$SENTRY_RELEASE" >/tmp/loopover-sentry-release-new.log 2>&1 || true) && npx -y "$SENTRY_CLI_PACKAGE" releases set-commits "$SENTRY_RELEASE" --auto && npx -y "$SENTRY_CLI_PACKAGE" sourcemaps inject dist && node --experimental-strip-types scripts/validate-selfhost-sourcemap.ts && npx -y "$SENTRY_CLI_PACKAGE" sourcemaps upload --release="$SENTRY_RELEASE" dist && npx -y "$SENTRY_CLI_PACKAGE" releases finalize "$SENTRY_RELEASE" && chown -R "$HOST_UID:$HOST_GID" dist node_modules package-lock.json'
}

run_init_secrets() {
  echo "selfhost deploy: ensuring secret placeholder files exist"
  "$SCRIPT_DIR/selfhost-init-secrets.sh"
}

run_compose_deploy() {
  local override_file
  local -a compose_args

  override_file="$(mktemp)"
  SELFHOST_GENERATED_COMPOSE_FILE="$override_file"
  trap 'rm -f "${SELFHOST_GENERATED_COMPOSE_FILE:-}"' EXIT

  cat >"$override_file" <<YAML
services:
  $SERVICE:
    build:
      target: runtime-prebuilt
      args:
        LOOPOVER_VERSION: "\${SENTRY_RELEASE}"
        INSTALL_AI_CLIS: "\${INSTALL_AI_CLIS:-true}"
        INSTALL_VISUAL_REVIEW: "\${INSTALL_VISUAL_REVIEW:-false}"
    environment:
      SENTRY_RELEASE: "\${SENTRY_RELEASE}"
      LOOPOVER_VERSION: "\${SENTRY_RELEASE}"
YAML

  # #7765: capture via a checked assignment so compose_file_args's `exit 1` on a missing compose file
  # actually aborts this script -- `mapfile < <(compose_file_args)` ran it in a subshell whose non-zero
  # exit was swallowed (mapfile itself returns 0), leaving compose_args empty/truncated.
  if ! compose_args_raw="$(compose_file_args)"; then
    exit 1
  fi
  mapfile -t compose_args <<< "$compose_args_raw"
  compose_args+=(-f "$override_file")

  echo "selfhost deploy: building $SERVICE runtime-prebuilt image"
  docker compose "${compose_args[@]}" build "$SERVICE"

  echo "selfhost deploy: restarting $SERVICE"
  maybe_infisical_run docker compose "${compose_args[@]}" up -d --no-deps "$SERVICE"
}

require_cmd docker
docker compose version >/dev/null

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: run this script from the loopover git checkout" >&2
  exit 1
fi

# Default to the current checkout on every deploy. Do not reuse a persisted .env value here:
# that value is written by the previous deploy and would make future updates report stale
# release/version metadata unless the operator remembered to override it manually.
SENTRY_RELEASE="${SENTRY_RELEASE:-loopover-selfhost@$(git rev-parse --short=8 HEAD)}"
export SENTRY_RELEASE

env_put SENTRY_RELEASE "$SENTRY_RELEASE"
env_put LOOPOVER_VERSION "$SENTRY_RELEASE"

run_node_build
run_init_secrets
run_sentry_upload
run_compose_deploy

echo "selfhost deploy: complete ($SENTRY_RELEASE)"
