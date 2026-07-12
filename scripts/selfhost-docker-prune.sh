#!/bin/sh
# Automated Docker resource hygiene for a 24/7 self-hosted loopover stack (#audit-rate-headroom). Runs on
# the HOST (via the systemd timer in systemd/loopover-docker-prune.{service,timer}.example), not as a
# compose service: reclaiming unused images and build cache needs real Docker daemon access, which this
# repo deliberately does not grant to any container (see docker-compose.yml's docker-proxy and runner
# service comments on why raw docker.sock exposure into a container is avoided).
#
# Age-filtered so nothing built/pulled recently is touched -- a rollback within the retention window still
# has its image available. `docker image prune -a` and `docker builder prune` only ever remove resources
# Docker itself already reports as unused (a running container's own image, or an active build-cache entry
# a build is currently using, are never candidates) -- this script does not change that safety property, it
# only adds the age floor on top of it. Docker's own `until=` filter for both is CREATION time, which is
# fine there: an in-use image/cache entry can never be a prune candidate in the first place regardless of
# how old it is, so the age floor only ever protects a recently built one that isn't in use yet.
#
# Containers are handled differently and deliberately do NOT use `docker container prune --filter until=`:
# that filter is ALSO creation time, not stop time (verified against Docker's own docs) -- a long-running
# container stopped moments ago (e.g. an operator's `docker compose stop <svc>` to inspect a live issue)
# would already be older than the retention window by creation date, so a creation-time filter deletes it
# on the very next scheduled run instead of giving the intended grace period. prune_stopped_containers()
# below inspects each exited container's ACTUAL State.FinishedAt instead, so only a container that has
# itself been stopped for at least RETAIN_HOURS is ever removed.
#
# SAFE BY DESIGN: only prunes stopped containers, unused images, and build cache -- NEVER volumes
# (loopover-data, loopover-backups, postgres-data, qdrant-storage, runner-work, etc.), so it cannot
# delete application data, backups, vector-store state, or a runner's registration/job data.
#
# Usage:
#   sh scripts/selfhost-docker-prune.sh              # prune for real -- the systemd timer's default call
#   sh scripts/selfhost-docker-prune.sh --dry-run     # preview only: report disk usage, delete nothing
set -eu

RETAIN_HOURS=${GITTENSORY_DOCKER_PRUNE_RETAIN_HOURS:-168} # 7 days

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *)
      echo "[docker-prune] unknown argument: $arg (expected --dry-run)" >&2
      exit 1
      ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "[docker-prune] docker not found on PATH" >&2
  exit 1
fi

# Prunes (real mode) or reports (dry-run) stopped containers whose ACTUAL stop time is at least
# RETAIN_HOURS in the past -- see the header comment for why `docker container prune --filter until=`
# itself is not used. Walks each exited container's `docker inspect` State.FinishedAt individually.
#
# Deliberately never parses FinishedAt's ISO-8601 string with `date -d` -- GNU coreutils' `date -d` accepts
# it, but BusyBox `date` (Alpine and other minimal Linux hosts, a common lightweight Docker host choice)
# only understands a small fixed set of `-d` inputs (`@<epoch>`, `hh:mm[:ss]`, `YYYY-MM-DD hh:mm[:ss]`, ...)
# and rejects FinishedAt's fractional-second form outright. Because that failure was wrapped in
# `2>/dev/null || continue`, it used to fail SILENTLY -- every container would be skipped forever, with no
# error, defeating this feature's whole purpose on a BusyBox host without so much as a warning.
#
# Instead: format the cutoff (an EPOCH INTEGER computed by plain arithmetic, never parsed from a string) as
# an ISO-8601-prefix string via `date -d @<epoch>` -- the `@<epoch>` form IS in BusyBox's small supported
# set, unlike arbitrary ISO-8601 parsing -- then compare that against FinishedAt's own first-19-characters
# prefix LEXICOGRAPHICALLY. That comparison is chronologically correct because both sides are the same
# fixed-width, zero-padded, UTC "YYYY-MM-DDTHH:MM:SS" shape, and needs no date-string PARSING at all.
prune_stopped_containers() {
  now_epoch=$(date -u +%s)
  cutoff_epoch=$((now_epoch - RETAIN_HOURS * 3600))
  cutoff_iso=$(date -u -d "@${cutoff_epoch}" +%Y-%m-%dT%H:%M:%S)
  container_list=$(mktemp)
  docker ps -a --filter status=exited --format '{{.ID}}' > "$container_list"
  # Reads from a FILE (not a pipe) deliberately: `cmd | while read; do ...; done` runs the loop body in a
  # subshell under POSIX sh, silently discarding any variable set inside it once the loop ends -- harmless
  # today (nothing here is read after the loop), but a real trap for a future edit that adds e.g. a
  # removed-count summary. `done < file` has no such subshell.
  while IFS= read -r cid; do
    [ -n "$cid" ] || continue
    finished_at=$(docker inspect -f '{{.State.FinishedAt}}' "$cid" 2>/dev/null) || continue
    finished_prefix=$(printf '%s' "$finished_at" | cut -c1-19)
    case "$finished_prefix" in
      [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]) ;;
      *) continue ;; # not a recognizable timestamp shape -- skip rather than guess
    esac
    # `[ a \< b ]` is not defined by POSIX test for strings; `expr` IS specified to compare non-numeric
    # operands lexicographically, so it's used here for a portable string-ordering check.
    expr "$finished_prefix" '<' "$cutoff_iso" >/dev/null || continue
    if [ "$DRY_RUN" = 1 ]; then
      echo "[docker-prune] DRY RUN -- would remove stopped container $cid (stopped before ${cutoff_iso}Z)"
    elif docker rm "$cid" >/dev/null 2>&1; then
      echo "[docker-prune] removed stopped container $cid (stopped before ${cutoff_iso}Z)"
    else
      echo "[docker-prune] WARNING: failed to remove stopped container $cid" >&2
    fi
  done < "$container_list"
  rm -f "$container_list"
}

echo "[docker-prune] $(date -u +%FT%TZ) starting (retain: ${RETAIN_HOURS}h, dry-run: ${DRY_RUN})"
echo "[docker-prune] before:"
docker system df
echo "[docker-prune] root filesystem usage:"
df -h / 2>/dev/null || true

echo "[docker-prune] pruning stopped containers older than ${RETAIN_HOURS}h (by actual stop time)..."
prune_stopped_containers

if [ "$DRY_RUN" = 1 ]; then
  echo "[docker-prune] DRY RUN -- would run: docker image prune -af --filter until=${RETAIN_HOURS}h"
  echo "[docker-prune] DRY RUN -- would run: docker builder prune -af --filter until=${RETAIN_HOURS}h"
  echo "[docker-prune] volumes are NEVER pruned by this script -- application data, backups, and runner state are always safe."
  exit 0
fi

echo "[docker-prune] pruning unused images older than ${RETAIN_HOURS}h..."
docker image prune -af --filter "until=${RETAIN_HOURS}h"

echo "[docker-prune] pruning build cache older than ${RETAIN_HOURS}h..."
docker builder prune -af --filter "until=${RETAIN_HOURS}h"

echo "[docker-prune] after:"
docker system df
echo "[docker-prune] root filesystem usage:"
df -h / 2>/dev/null || true

echo "[docker-prune] $(date -u +%FT%TZ) done"
