#!/usr/bin/env bash
# Portable self-host smoke test (#1944): boot one container from a given image, wait for it to become
# healthy, and assert on its /health, /ready, /metrics output plus its startup log events. Mode-agnostic --
# the caller supplies which env vars configure the mode under test and which log events that mode should
# (or must not) produce. See docs/self-hosting-release-checklist for the beta smoke matrix built on this.
#
# Defaults to a plain SQLite + Redis + direct-App boot:
#   ./scripts/smoke-selfhost.sh gittensory:selfhost-ci
#
# Test a specific mode by passing extra env and the events it should produce:
#   SELFHOST_SMOKE_EXTRA_ENV="AI_PROVIDER=claude-code
#   CLAUDE_CODE_OAUTH_TOKEN=..." \
#   SELFHOST_SMOKE_EXPECT_EVENTS="selfhost_ai_provider" \
#   ./scripts/smoke-selfhost.sh gittensory:selfhost-ci
#
# Assert an event must NOT appear (e.g. no AI-CLI-missing warning, no failed relay registration):
#   SELFHOST_SMOKE_FORBID_EVENTS="selfhost_ai_cli_missing" ./scripts/smoke-selfhost.sh gittensory:selfhost-ci
set -euo pipefail

IMAGE="${1:?usage: smoke-selfhost.sh <image>}"
# A caller-supplied network (e.g. one already holding a Postgres or Qdrant container for a cross-service
# scenario) is joined, not owned -- this script neither creates nor removes it. Only the default
# self-generated network is created/removed here.
NETWORK_OWNED=1
if [ -n "${SELFHOST_SMOKE_NETWORK:-}" ]; then
  NETWORK_NAME="$SELFHOST_SMOKE_NETWORK"
  NETWORK_OWNED=0
else
  NETWORK_NAME="gt-smoke-$$"
fi
REDIS_NAME="${SELFHOST_SMOKE_REDIS_NAME:-gt-smoke-redis-$$}"
APP_NAME="${SELFHOST_SMOKE_APP_NAME:-gt-smoke-app-$$}"
PORT="${SELFHOST_SMOKE_PORT:-8787}"
HEALTH_TIMEOUT_SECONDS="${SELFHOST_SMOKE_HEALTH_TIMEOUT_SECONDS:-90}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: required command not found: $1" >&2
    exit 1
  fi
}

require_cmd docker
require_cmd curl
require_cmd od

if [ -n "${SELFHOST_SMOKE_SETUP_TOKEN:-}" ]; then
  SETUP_TOKEN="$SELFHOST_SMOKE_SETUP_TOKEN"
else
  SETUP_TOKEN="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
fi

cleanup() {
  docker rm -f "$APP_NAME" "$REDIS_NAME" >/dev/null 2>&1 || true
  if [ "$NETWORK_OWNED" = "1" ]; then
    docker network rm "$NETWORK_NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [ "$NETWORK_OWNED" = "1" ]; then
  echo "smoke-selfhost: booting Redis + $IMAGE on an isolated network ($NETWORK_NAME)"
  docker network create "$NETWORK_NAME" >/dev/null
else
  echo "smoke-selfhost: booting Redis + $IMAGE on caller-supplied network ($NETWORK_NAME)"
fi
docker run -d --name "$REDIS_NAME" --network "$NETWORK_NAME" redis:7-alpine >/dev/null
redis_ok=0
for _ in $(seq 1 30); do
  if docker exec "$REDIS_NAME" redis-cli ping | grep -q PONG; then
    redis_ok=1
    break
  fi
  sleep 1
done
if [ "$redis_ok" != "1" ]; then
  echo "::error::$REDIS_NAME never responded to PING" >&2
  docker logs "$REDIS_NAME" >&2 || true
  exit 1
fi

# Extra env, one KEY=VALUE per line -- turned into repeated -e flags. Deliberately whitespace/newline
# separated (not comma) so values containing commas (e.g. AI_PROVIDER=claude-code,codex) are unambiguous.
# NOT for multiline secrets like a PEM private key -- a newline inside a value is indistinguishable from
# an entry boundary here. Use SELFHOST_SMOKE_EXTRA_VOLUMES + a _FILE env var instead (see below).
EXTRA_ENV_ARGS=()
if [ -n "${SELFHOST_SMOKE_EXTRA_ENV:-}" ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    EXTRA_ENV_ARGS+=(-e "$line")
  done <<<"$SELFHOST_SMOKE_EXTRA_ENV"
fi

# Extra volumes, one "host_path:container_path[:opts]" per line -- turned into repeated -v flags. This is
# how a multiline secret (e.g. GITHUB_APP_PRIVATE_KEY_FILE) reaches the container safely: mount the file,
# then set the *_FILE env var to its container path via SELFHOST_SMOKE_EXTRA_ENV (a single-line value).
EXTRA_VOLUME_ARGS=()
if [ -n "${SELFHOST_SMOKE_EXTRA_VOLUMES:-}" ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    EXTRA_VOLUME_ARGS+=(-v "$line")
  done <<<"$SELFHOST_SMOKE_EXTRA_VOLUMES"
fi

docker run -d --name "$APP_NAME" --network "$NETWORK_NAME" -p "127.0.0.1:${PORT}:8787" \
  -e "REDIS_URL=redis://${REDIS_NAME}:6379" \
  -e "SELFHOST_SETUP_TOKEN=${SETUP_TOKEN}" \
  -e "PUBLIC_API_ORIGIN=${SELFHOST_SMOKE_PUBLIC_API_ORIGIN:-https://selfhost-smoke.example}" \
  "${EXTRA_ENV_ARGS[@]}" \
  "${EXTRA_VOLUME_ARGS[@]}" \
  "$IMAGE" >/dev/null

ok=0
deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
while [ "$SECONDS" -le "$deadline" ]; do
  if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 2
done
if [ "$ok" != "1" ]; then
  echo "::error::$APP_NAME did not become healthy within ${HEALTH_TIMEOUT_SECONDS}s" >&2
  docker logs "$APP_NAME" >&2 || true
  exit 1
fi

echo "smoke-selfhost: checking /health, /ready, /metrics"
curl -sf "http://127.0.0.1:${PORT}/health" | grep -q '"status":"ok"'
curl -sf "http://127.0.0.1:${PORT}/ready" | grep -q '"ok":true'
curl -sf "http://127.0.0.1:${PORT}/metrics" | grep -q 'gittensory_uptime_seconds'

LOGS="$(docker logs "$APP_NAME" 2>&1)"

if [ -n "${SELFHOST_SMOKE_EXPECT_EVENTS:-}" ]; then
  IFS=',' read -ra EXPECT <<<"$SELFHOST_SMOKE_EXPECT_EVENTS"
  for event in "${EXPECT[@]}"; do
    event="$(echo "$event" | xargs)" # trim
    [ -z "$event" ] && continue
    if ! echo "$LOGS" | grep -q "\"event\":\"${event}\""; then
      echo "::error::expected log event '$event' did not appear" >&2
      echo "$LOGS" >&2
      exit 1
    fi
    echo "smoke-selfhost: found expected event '$event'"
  done
fi

if [ -n "${SELFHOST_SMOKE_FORBID_EVENTS:-}" ]; then
  IFS=',' read -ra FORBID <<<"$SELFHOST_SMOKE_FORBID_EVENTS"
  for event in "${FORBID[@]}"; do
    event="$(echo "$event" | xargs)" # trim
    [ -z "$event" ] && continue
    if echo "$LOGS" | grep -q "\"event\":\"${event}\""; then
      echo "::error::forbidden log event '$event' appeared" >&2
      echo "$LOGS" >&2
      exit 1
    fi
    echo "smoke-selfhost: confirmed absent forbidden event '$event'"
  done
fi

# Always required: migrations must have applied on every mode, every boot.
if ! echo "$LOGS" | grep -q '"event":"selfhost_migrations_applied"'; then
  echo "::error::selfhost_migrations_applied did not appear" >&2
  echo "$LOGS" >&2
  exit 1
fi

echo "smoke-selfhost: passed"
