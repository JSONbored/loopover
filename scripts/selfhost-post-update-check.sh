#!/usr/bin/env bash
# Post-update verification for a self-host instance (#1823).
#
# Run after deploy-selfhost-image.sh, deploy-selfhost-prebuilt.sh, or any manual
# `docker compose up -d --no-deps gittensory` that ships a new app image.
#
# Checks /ready, compose health, .env release metadata, and the running container image.
# Does not modify .env, volumes, gittensory-config/, or any profile service.
set -euo pipefail

ENV_FILE="${SELFHOST_ENV_FILE:-.env}"
SERVICE="${SELFHOST_SERVICE:-gittensory}"
PORT="${PORT:-8787}"
READY_URL="${SELFHOST_READY_URL:-http://127.0.0.1:${PORT}/ready}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/selfhost-deploy-common.sh
. "$SCRIPT_DIR/lib/selfhost-deploy-common.sh"

require_cmd docker
require_cmd curl
docker compose version >/dev/null

mapfile -t compose_args < <(compose_file_args)

container_id="$(docker compose "${compose_args[@]}" ps -q "$SERVICE" 2>/dev/null || true)"
if [ -z "$container_id" ]; then
  echo "error: $SERVICE is not running" >&2
  docker compose "${compose_args[@]}" ps "$SERVICE" >&2 || true
  exit 1
fi

echo "selfhost post-update check: probing $READY_URL"
if ! curl -sf "$READY_URL" >/dev/null; then
  echo "error: $READY_URL did not return HTTP 2xx" >&2
  exit 1
fi

status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
echo "selfhost post-update check: $SERVICE container status=$status"
if [ "$status" != "healthy" ] && [ "$status" != "running" ]; then
  echo "error: expected healthy or running, got $status" >&2
  docker compose "${compose_args[@]}" ps "$SERVICE" >&2 || true
  exit 1
fi

if [ -f "$ENV_FILE" ]; then
  echo "selfhost post-update check: release metadata from $ENV_FILE"
  grep -E '^(GITTENSORY_IMAGE|GITTENSORY_VERSION|SENTRY_RELEASE)=' "$ENV_FILE" || true
else
  echo "selfhost post-update check: warning — $ENV_FILE not found (skipping release metadata grep)" >&2
fi

running_image="$(docker inspect --format '{{.Config.Image}}' "$container_id")"
echo "selfhost post-update check: running image=$running_image"
echo "selfhost post-update check: ok"
