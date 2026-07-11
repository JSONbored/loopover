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

# Retry, don't single-probe: `docker compose up -d` returns as soon as the container STARTS, well before
# the app inside has bound its port -- a single immediate curl reliably false-fails on a normal boot. Budget
# matches the gittensory service's own Docker healthcheck start_period (60s, docker-compose.yml) plus margin,
# polling often enough that a normal ~15-20s boot returns almost immediately once actually ready.
READY_RETRIES="${SELFHOST_READY_RETRIES:-45}"
READY_RETRY_DELAY_SECONDS="${SELFHOST_READY_RETRY_DELAY_SECONDS:-2}"

echo "selfhost post-update check: probing $READY_URL"
ready=0
for _ in $(seq 1 "$READY_RETRIES"); do
  if curl -sf "$READY_URL" >/dev/null; then
    ready=1
    break
  fi
  sleep "$READY_RETRY_DELAY_SECONDS"
done
if [ "$ready" -ne 1 ]; then
  echo "error: $READY_URL did not return HTTP 2xx after $READY_RETRIES attempts ($((READY_RETRIES * READY_RETRY_DELAY_SECONDS))s)" >&2
  exit 1
fi

# Same race as the /ready probe above, one layer down: Docker's OWN healthcheck (docker-compose.yml)
# reports "starting" until its FIRST probe completes, which can still be true here even though /ready
# already answered 2xx (the two checks run on independent schedules) -- a normal boot must not fail on
# a state that is expected to resolve on its own within seconds. Only "starting" is worth waiting
# through; any other non-healthy/running status (unhealthy, exited, restarting, ...) is a real problem
# and fails immediately rather than burning the full retry budget on something that will not resolve.
status=""
for _ in $(seq 1 "$READY_RETRIES"); do
  status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
  if [ "$status" = "healthy" ] || [ "$status" = "running" ]; then
    break
  fi
  if [ "$status" != "starting" ]; then
    break
  fi
  sleep "$READY_RETRY_DELAY_SECONDS"
done
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
