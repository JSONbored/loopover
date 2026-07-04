#!/usr/bin/env bash
# Pull and deploy a published self-host image without rebuilding on the host.
#
# Defaults to the latest official image:
#   ./scripts/deploy-selfhost-image.sh
#
# Pin production rollouts to a release tag or digest:
#   ./scripts/deploy-selfhost-image.sh ghcr.io/jsonbored/gittensory-selfhost:orb-v0.1.0
#   GITTENSORY_IMAGE=ghcr.io/jsonbored/gittensory-selfhost@sha256:... ./scripts/deploy-selfhost-image.sh
#
# The image itself carries official release metadata. Set SENTRY_RELEASE only for custom images whose
# source maps were uploaded under that exact id.
set -euo pipefail

ENV_FILE="${SELFHOST_ENV_FILE:-.env}"
SERVICE="${SELFHOST_SERVICE:-gittensory}"
HEALTH_TIMEOUT_SECONDS="${SELFHOST_HEALTH_TIMEOUT_SECONDS:-180}"
DEFAULT_IMAGE="ghcr.io/jsonbored/gittensory-selfhost:latest"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/selfhost-deploy-common.sh
. "$SCRIPT_DIR/lib/selfhost-deploy-common.sh"

resolve_image() {
  local env_file_image

  if [ "$#" -gt 1 ]; then
    echo "error: expected at most one image argument" >&2
    exit 1
  fi

  env_file_image="$(env_get GITTENSORY_IMAGE || true)"
  printf '%s' "${1:-${GITTENSORY_IMAGE:-${env_file_image:-$DEFAULT_IMAGE}}}"
}

validate_inputs() {
  local image="$1"

  if [ -z "$image" ]; then
    echo "error: image must not be empty" >&2
    exit 1
  fi
  case "$image" in
    *[[:space:]\"\'\\\$\{\}]*)
      echo "error: image contains unsupported whitespace, quote, backslash, or compose interpolation characters" >&2
      exit 1
      ;;
  esac
  if ! [[ "$SERVICE" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "error: SELFHOST_SERVICE contains unsupported characters" >&2
    exit 1
  fi
  if ! [[ "$HEALTH_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]]; then
    echo "error: SELFHOST_HEALTH_TIMEOUT_SECONDS must be a non-negative integer" >&2
    exit 1
  fi
}

wait_for_healthy() {
  local deadline container_id status

  deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
  while [ "$SECONDS" -le "$deadline" ]; do
    container_id="$(docker compose "${compose_args[@]}" ps -q "$SERVICE" 2>/dev/null || true)"
    if [ -n "$container_id" ]; then
      status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
      if [ "$status" = "healthy" ]; then
        echo "selfhost image deploy: $SERVICE is healthy"
        return 0
      fi
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      break
    fi
    sleep 2
  done

  echo "error: $SERVICE did not become healthy within ${HEALTH_TIMEOUT_SECONDS}s" >&2
  docker compose "${compose_args[@]}" ps "$SERVICE" >&2 || true
  docker compose "${compose_args[@]}" logs --tail=80 "$SERVICE" >&2 || true
  exit 1
}

require_cmd docker
docker compose version >/dev/null

IMAGE="$(resolve_image "$@")"
validate_inputs "$IMAGE"

override_file="$(mktemp)"
SELFHOST_GENERATED_COMPOSE_FILE="$override_file"
trap 'rm -f "${SELFHOST_GENERATED_COMPOSE_FILE:-}"' EXIT

cat >"$override_file" <<YAML
services:
  $SERVICE:
    image: "$IMAGE"
YAML

mapfile -t compose_args < <(compose_file_args)
compose_args+=(-f "$override_file")

echo "selfhost image deploy: pulling $IMAGE"
docker compose "${compose_args[@]}" pull --policy always "$SERVICE"

echo "selfhost image deploy: restarting $SERVICE"
docker compose "${compose_args[@]}" up -d --no-build --no-deps "$SERVICE"

wait_for_healthy
env_put GITTENSORY_IMAGE "$IMAGE"

echo "selfhost image deploy: complete ($IMAGE)"
