#!/usr/bin/env bash
# Post-deploy regression auto-pause gate (#5736).
#
# selfhost-post-update-check.sh verifies the service came back up; this verifies it STAYS up once
# real traffic starts flowing. Observes a window of the loopover service's own logs for a dead-job
# spike (every attempt exhausted its retries -- `"event":"job_dead"`, emitted regardless of which
# optional observability profile is enabled, so this never depends on Prometheus/Grafana/Loki being
# opted into) and, if the count exceeds a threshold, automatically flips the DB-backed global
# kill-switch (global_agent_controls.frozen, #audit-§5.2) so a bad deploy that starts silently
# failing jobs pauses every agent write action fleet-wide instead of accumulating failures until a
# human notices. Run this AFTER selfhost-post-update-check.sh passes, once you're ready to let real
# webhook traffic through -- it blocks for the full observation window by design.
#
#   ./scripts/selfhost-post-update-regression-gate.sh
#
# Optional knobs:
#   SELFHOST_REGRESSION_WINDOW_SECONDS=180   (default) how long to observe before evaluating
#   SELFHOST_REGRESSION_JOB_DEAD_THRESHOLD=5 (default) dead-job count that triggers the pause
set -euo pipefail

SERVICE="${SELFHOST_SERVICE:-loopover}"
POSTGRES_SERVICE="${SELFHOST_POSTGRES_SERVICE:-postgres}"
POSTGRES_USER_NAME="${POSTGRES_USER:-loopover}"
POSTGRES_DB_NAME="${POSTGRES_DB:-loopover}"
WINDOW_SECONDS="${SELFHOST_REGRESSION_WINDOW_SECONDS:-180}"
THRESHOLD="${SELFHOST_REGRESSION_JOB_DEAD_THRESHOLD:-5}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/selfhost-deploy-common.sh
. "$SCRIPT_DIR/lib/selfhost-deploy-common.sh"

require_cmd docker
docker compose version >/dev/null

if [[ ! "$WINDOW_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "selfhost regression gate: warning — invalid SELFHOST_REGRESSION_WINDOW_SECONDS=$WINDOW_SECONDS (using 180)" >&2
  WINDOW_SECONDS=180
fi
if [[ ! "$THRESHOLD" =~ ^[0-9]+$ ]]; then
  echo "selfhost regression gate: warning — invalid SELFHOST_REGRESSION_JOB_DEAD_THRESHOLD=$THRESHOLD (using 5)" >&2
  THRESHOLD=5
fi

mapfile -t compose_args < <(compose_file_args)

container_id="$(docker compose "${compose_args[@]}" ps -q "$SERVICE" 2>/dev/null || true)"
if [ -z "$container_id" ]; then
  echo "error: $SERVICE is not running" >&2
  exit 1
fi

# Anchored to NOW, not deploy time: this only ever counts failures from this script's own
# observation window, never carrying over pre-existing failures from before it started.
since_marker="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "selfhost regression gate: observing $SERVICE for ${WINDOW_SECONDS}s (auto-pause threshold: >${THRESHOLD} dead jobs)"
sleep "$WINDOW_SECONDS"

job_dead_count="$(docker compose "${compose_args[@]}" logs --since "$since_marker" "$SERVICE" 2>/dev/null | grep -c '"event":"job_dead"' || true)"

echo "selfhost regression gate: $job_dead_count dead job(s) observed in the last ${WINDOW_SECONDS}s"

if [ "$job_dead_count" -le "$THRESHOLD" ]; then
  echo "selfhost regression gate: ok (within threshold)"
  exit 0
fi

echo "selfhost regression gate: ⚠ $job_dead_count dead job(s) exceeds threshold of $THRESHOLD -- pausing the fleet-wide kill-switch" >&2

if ! docker compose "${compose_args[@]}" exec -T "$POSTGRES_SERVICE" psql -U "$POSTGRES_USER_NAME" -d "$POSTGRES_DB_NAME" -v ON_ERROR_STOP=1 -c \
  "INSERT INTO global_agent_controls (id, frozen, updated_at, updated_by) VALUES ('singleton', 1, CURRENT_TIMESTAMP, 'selfhost-post-update-regression-gate.sh') ON CONFLICT(id) DO UPDATE SET frozen = excluded.frozen, updated_at = excluded.updated_at, updated_by = excluded.updated_by;" \
  >/dev/null; then
  echo "error: failed to write the DB kill-switch -- PAUSE MANUALLY: set AGENT_ACTIONS_PAUSED=true in .env and restart the $SERVICE service, or run the UPDATE above by hand against $POSTGRES_SERVICE" >&2
  exit 1
fi

echo "selfhost regression gate: global_agent_controls.frozen = 1 -- every agent write action is now paused fleet-wide until an operator clears it (UPDATE global_agent_controls SET frozen = 0 WHERE id = 'singleton')" >&2
exit 1
