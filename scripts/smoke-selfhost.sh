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
#
# Visual review (#3608): also boots a browserless/chromium sidecar, wires BROWSER_WS_ENDPOINT +
# PUBLIC_SITE_ORIGIN automatically, and asserts the on-demand /gittensory/shot?url= route returns a real
# PNG -- proving captureShot() actually renders through the self-host stub end to end, not just that the
# app boots. The IMAGE under test must have been built with --build-arg INSTALL_VISUAL_REVIEW=true.
#   SELFHOST_SMOKE_VISUAL_REVIEW=1 ./scripts/smoke-selfhost.sh gittensory:selfhost-ci-visual
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
VISUAL_REVIEW="${SELFHOST_SMOKE_VISUAL_REVIEW:-0}"
BROWSERLESS_NAME="${SELFHOST_SMOKE_BROWSERLESS_NAME:-gt-smoke-browserless-$$}"

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
  docker rm -f "$APP_NAME" "$REDIS_NAME" "$BROWSERLESS_NAME" >/dev/null 2>&1 || true
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

VISUAL_EXTRA_ENV_ARGS=()
if [ "$VISUAL_REVIEW" = "1" ]; then
  echo "smoke-selfhost: booting browserless/chromium for visual-review mode"
  BROWSERLESS_TOKEN_SMOKE="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  docker run -d --name "$BROWSERLESS_NAME" --network "$NETWORK_NAME" --shm-size 2g \
    -e "TOKEN=${BROWSERLESS_TOKEN_SMOKE}" \
    ghcr.io/browserless/chromium:latest >/dev/null
  browserless_ok=0
  for _ in $(seq 1 30); do
    if docker exec "$BROWSERLESS_NAME" curl -sf "http://127.0.0.1:3000/docs" >/dev/null 2>&1; then
      browserless_ok=1
      break
    fi
    sleep 2
  done
  if [ "$browserless_ok" != "1" ]; then
    echo "::error::$BROWSERLESS_NAME never became ready" >&2
    docker logs "$BROWSERLESS_NAME" >&2 || true
    exit 1
  fi
  # GITTENSORY_REVIEW_SCREENSHOTS must be on: the /gittensory/shot route itself 404s when it's off
  # (deliberately "truly inert" by design, src/api/routes.ts), independent of BROWSER_WS_ENDPOINT.
  #
  # SMOKE_SHOT_TARGET must be a REAL, publicly resolvable URL, unlike this script's other *.example
  # placeholder values -- those are only ever used as opaque header/origin STRINGS, never fetched. This
  # one IS fetched: the browser inside the browserless container actually navigates to it, so a fake
  # .example domain would fail DNS resolution and captureShot() would correctly (but uselessly, for this
  # test) degrade to null -- silently turning the assertion below into a no-op rather than a real proof.
  # Defaults to example.com (IANA-reserved for exactly this kind of testing, stable, minimal). isSafeHttpUrl
  # (SSRF guard) also means this can't be pointed at a docker-internal hostname -- it must stay a real
  # public host, matching how production actually uses this endpoint (real preview-deploy URLs, never
  # internal addresses). Placed BEFORE the caller's own EXTRA_ENV_ARGS so an explicit override still wins.
  SMOKE_SHOT_TARGET="${SELFHOST_SMOKE_VISUAL_TARGET_URL:-https://example.com}"
  VISUAL_EXTRA_ENV_ARGS=(
    -e "GITTENSORY_REVIEW_SCREENSHOTS=true"
    -e "BROWSER_WS_ENDPOINT=ws://${BROWSERLESS_NAME}:3000?token=${BROWSERLESS_TOKEN_SMOKE}"
    -e "PUBLIC_SITE_ORIGIN=${SMOKE_SHOT_TARGET}"
  )
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
  "${VISUAL_EXTRA_ENV_ARGS[@]}" \
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
curl -sf "http://127.0.0.1:${PORT}/metrics" | grep -q 'loopover_uptime_seconds'

if [ "$VISUAL_REVIEW" = "1" ]; then
  echo "smoke-selfhost: checking /gittensory/shot renders a real PNG through the self-host browser stub"
  SHOT_URL="http://127.0.0.1:${PORT}/gittensory/shot?url=$(printf '%s' "$SMOKE_SHOT_TARGET" | tr -d '\n')"
  SHOT_HEADERS="$(curl -sf -D - -o /tmp/gt-smoke-shot.png "$SHOT_URL")"
  echo "$SHOT_HEADERS" | grep -qi '^content-type: image/png' || {
    echo "::error::/gittensory/shot did not return image/png" >&2
    echo "$SHOT_HEADERS" >&2
    docker logs "$APP_NAME" >&2 || true
    docker logs "$BROWSERLESS_NAME" >&2 || true
    exit 1
  }
  SHOT_BYTES="$(wc -c </tmp/gt-smoke-shot.png | tr -d ' ')"
  # A real rendered page is comfortably more than a placeholder/error graphic would be; catches a "PNG
  # content-type but empty/near-empty body" false pass.
  if [ "$SHOT_BYTES" -lt 1024 ]; then
    echo "::error::/gittensory/shot returned a suspiciously small PNG (${SHOT_BYTES} bytes)" >&2
    docker logs "$APP_NAME" >&2 || true
    exit 1
  fi
  echo "smoke-selfhost: /gittensory/shot returned a real PNG (${SHOT_BYTES} bytes)"
  rm -f /tmp/gt-smoke-shot.png
fi

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
