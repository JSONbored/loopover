#!/usr/bin/env bash
# Build and deploy the self-host runtime from a prebuilt bundle without relying on host Node/npm.
#
# After a successful run, verify with: ./scripts/selfhost-post-update-check.sh
#
# Defaults are intentionally operator-friendly:
#   ./scripts/deploy-selfhost-prebuilt.sh
#
# Optional knobs:
#   POSTHOG_RELEASE=loopover-selfhost@edge-abc123 ./scripts/deploy-selfhost-prebuilt.sh
#   SELFHOST_COMPOSE_FILES="docker-compose.yml docker-compose.override.yml" ./scripts/deploy-selfhost-prebuilt.sh
#   SELFHOST_SKIP_POSTHOG_UPLOAD=1 ./scripts/deploy-selfhost-prebuilt.sh
#   SELFHOST_USE_INFISICAL=1 ./scripts/deploy-selfhost-prebuilt.sh   # opt-in Infisical secrets (#5120), see docs
set -euo pipefail

ENV_FILE="${SELFHOST_ENV_FILE:-.env}"
NODE_IMAGE="${SELFHOST_NODE_IMAGE:-public.ecr.aws/docker/library/node:24-slim}"
SERVICE="${SELFHOST_SERVICE:-loopover}"
# #8395: same override + default deploy-selfhost-image.sh already uses, so both deploy paths honour one
# health-check budget.
HEALTH_TIMEOUT_SECONDS="${SELFHOST_HEALTH_TIMEOUT_SECONDS:-180}"
SKIP_POSTHOG_UPLOAD="${SELFHOST_SKIP_POSTHOG_UPLOAD:-0}"
POSTHOG_CLI_PACKAGE="${POSTHOG_CLI_PACKAGE:-@posthog/cli@0.9.1}"

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

run_posthog_upload() {
  local api_key project_id host uid gid release_name release_version

  api_key="${POSTHOG_CLI_API_KEY:-$(env_get POSTHOG_CLI_API_KEY || true)}"
  project_id="${POSTHOG_CLI_PROJECT_ID:-$(env_get POSTHOG_CLI_PROJECT_ID || true)}"
  host="${POSTHOG_CLI_HOST:-$(env_get POSTHOG_CLI_HOST || true)}"

  if [ "$SKIP_POSTHOG_UPLOAD" = "1" ]; then
    echo "selfhost deploy: skipping PostHog upload (SELFHOST_SKIP_POSTHOG_UPLOAD=1)"
    return 0
  fi

  if [ -z "$api_key" ] || [ -z "$project_id" ]; then
    echo "selfhost deploy: skipping PostHog upload (POSTHOG_CLI_API_KEY or POSTHOG_CLI_PROJECT_ID is missing)"
    return 0
  fi

  uid="$(id -u)"
  gid="$(id -g)"
  # posthog-cli's sourcemap inject/upload take --release-name and --release-version as SEPARATE flags,
  # combined server-side into "{name}@{version}". Passing our already-combined POSTHOG_RELEASE as
  # --release-version alone leaves --release-name unset, so the CLI auto-derives one from git/package.json
  # instead -- silently doubling the stored release id and breaking "Validate PostHog release"-style lookups.
  release_name="${POSTHOG_RELEASE%%@*}"
  release_version="${POSTHOG_RELEASE#*@}"

  echo "selfhost deploy: injecting and uploading PostHog source maps for $POSTHOG_RELEASE"
  docker run --rm \
    -e HOME=/tmp \
    -e npm_config_cache=/tmp/.npm \
    -e POSTHOG_RELEASE_NAME="$release_name" \
    -e POSTHOG_RELEASE_VERSION="$release_version" \
    -e POSTHOG_CLI_API_KEY="$api_key" \
    -e POSTHOG_CLI_PROJECT_ID="$project_id" \
    ${host:+-e POSTHOG_CLI_HOST="$host"} \
    -e POSTHOG_CLI_PACKAGE="$POSTHOG_CLI_PACKAGE" \
    -e HOST_UID="$uid" \
    -e HOST_GID="$gid" \
    -v "$PWD:/work" \
    -w /work \
    "$NODE_IMAGE" \
    sh -lc 'apt-get update >/dev/null && apt-get install -y --no-install-recommends ca-certificates >/dev/null && npx -y "$POSTHOG_CLI_PACKAGE" sourcemap inject --directory dist --release-name "$POSTHOG_RELEASE_NAME" --release-version "$POSTHOG_RELEASE_VERSION" && node --experimental-strip-types scripts/validate-selfhost-sourcemap.ts && npx -y "$POSTHOG_CLI_PACKAGE" sourcemap upload --directory dist --release-name "$POSTHOG_RELEASE_NAME" --release-version "$POSTHOG_RELEASE_VERSION" && chown -R "$HOST_UID:$HOST_GID" dist node_modules package-lock.json'
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
        LOOPOVER_VERSION: "\${POSTHOG_RELEASE}"
        INSTALL_AI_CLIS: "\${INSTALL_AI_CLIS:-true}"
        INSTALL_VISUAL_REVIEW: "\${INSTALL_VISUAL_REVIEW:-false}"
    environment:
      POSTHOG_RELEASE: "\${POSTHOG_RELEASE}"
      LOOPOVER_VERSION: "\${POSTHOG_RELEASE}"
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

  # #8395: `up -d` only confirms the container was CREATED and STARTED -- without this, a crash-looping
  # or never-healthy image still reported "selfhost deploy: complete". Called here (not at the top level)
  # because compose_args is function-local, and it includes the generated override file. Exits non-zero
  # with the same ps/logs diagnostics deploy-selfhost-image.sh produces; the EXIT trap above still cleans
  # up the temp override file on that path.
  wait_for_healthy "$SERVICE" "$HEALTH_TIMEOUT_SECONDS" "selfhost deploy" "${compose_args[@]}"
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
POSTHOG_RELEASE="${POSTHOG_RELEASE:-loopover-selfhost@$(git rev-parse --short=8 HEAD)}"
export POSTHOG_RELEASE

env_put POSTHOG_RELEASE "$POSTHOG_RELEASE"
env_put LOOPOVER_VERSION "$POSTHOG_RELEASE"

run_node_build
run_init_secrets
run_posthog_upload
run_compose_deploy

echo "selfhost deploy: complete ($POSTHOG_RELEASE)"
