#!/bin/sh
# Automated Docker resource hygiene for a 24/7 self-hosted gittensory stack (#audit-rate-headroom). Runs on
# the HOST (via the systemd timer in systemd/gittensory-docker-prune.{service,timer}.example), not as a
# compose service: reclaiming unused images and build cache needs real Docker daemon access, which this
# repo deliberately does not grant to any container (see docker-compose.yml's docker-proxy and runner
# service comments on why raw docker.sock exposure into a container is avoided).
#
# Age-filtered so nothing built/pulled recently is touched -- a rollback within the retention window still
# has its image available. `docker container prune`, `docker image prune -a`, and `docker builder prune`
# only ever remove resources Docker itself already reports as unused (a running container, its own image,
# or an active build-cache entry a build is currently using, are never candidates) -- this script does not
# change that safety property, it only adds the age floor on top of it.
#
# SAFE BY DESIGN: only prunes stopped containers, unused images, and build cache -- NEVER volumes
# (gittensory-data, gittensory-backups, postgres-data, qdrant-storage, runner-work, etc.), so it cannot
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

echo "[docker-prune] $(date -u +%FT%TZ) starting (retain: ${RETAIN_HOURS}h, dry-run: ${DRY_RUN})"
echo "[docker-prune] before:"
docker system df
echo "[docker-prune] root filesystem usage:"
df -h / 2>/dev/null || true

if [ "$DRY_RUN" = 1 ]; then
  echo "[docker-prune] DRY RUN -- would run: docker container prune -f --filter until=${RETAIN_HOURS}h"
  echo "[docker-prune] DRY RUN -- would run: docker image prune -af --filter until=${RETAIN_HOURS}h"
  echo "[docker-prune] DRY RUN -- would run: docker builder prune -af --filter until=${RETAIN_HOURS}h"
  echo "[docker-prune] volumes are NEVER pruned by this script -- application data, backups, and runner state are always safe."
  exit 0
fi

echo "[docker-prune] pruning stopped containers older than ${RETAIN_HOURS}h..."
docker container prune -f --filter "until=${RETAIN_HOURS}h"

echo "[docker-prune] pruning unused images older than ${RETAIN_HOURS}h..."
docker image prune -af --filter "until=${RETAIN_HOURS}h"

echo "[docker-prune] pruning build cache older than ${RETAIN_HOURS}h..."
docker builder prune -af --filter "until=${RETAIN_HOURS}h"

echo "[docker-prune] after:"
docker system df
echo "[docker-prune] root filesystem usage:"
df -h / 2>/dev/null || true

echo "[docker-prune] $(date -u +%FT%TZ) done"
