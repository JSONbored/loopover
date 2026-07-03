#!/bin/sh
# Safe Docker disk hygiene for a self-host VPS (#selfhost-runtime-pressure). Build cache and unused images
# accumulate quickly on a box that rebuilds `gittensory` from source or runs GitHub Actions runners --
# multi-GB `docker builder prune` growth per week is normal, and a root disk over ~80-85% full slows down
# EVERYTHING on the box (Postgres/SQLite fsync latency, container scheduling, log writes), not just Docker
# itself, well before it fills up completely.
#
# SAFE BY DESIGN: only prunes build cache, dangling/unused IMAGES, and stopped containers -- NEVER volumes
# (gittensory-data, gittensory-backups, postgres-data, qdrant-storage, etc.), so it cannot delete application
# data, backups, or vector-store state. Read-only by default (`--dry-run` -- or run without `--yes`, see
# below) so you can review what would be reclaimed before anything is deleted.
#
# Usage:
#   ./scripts/docker-prune.sh                # report current disk usage only, delete nothing
#   ./scripts/docker-prune.sh --dry-run       # same as above (explicit)
#   ./scripts/docker-prune.sh --yes           # actually prune (build cache + dangling images + stopped containers)
#   ./scripts/docker-prune.sh --yes --images  # also prune UNUSED (not just dangling) images -- more aggressive,
#                                              # will re-pull/rebuild on next deploy if an image isn't running
#
# Cron example (weekly, Sunday 04:00, low-traffic window):
#   0 4 * * 0 cd /path/to/gittensory && ./scripts/docker-prune.sh --yes >> /var/log/gittensory-docker-prune.log 2>&1
set -eu

DRY_RUN=1
PRUNE_UNUSED_IMAGES=0
for arg in "$@"; do
  case "$arg" in
    --yes) DRY_RUN=0 ;;
    --dry-run) DRY_RUN=1 ;;
    --images) PRUNE_UNUSED_IMAGES=1 ;;
    *)
      echo "[docker-prune] unknown argument: $arg (expected --yes, --dry-run, and/or --images)" >&2
      exit 1
      ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "[docker-prune] docker not found on PATH" >&2
  exit 1
fi

echo "[docker-prune] disk usage before:"
docker system df

echo "[docker-prune] root filesystem usage:"
df -h / 2>/dev/null || true

if [ "$DRY_RUN" = 1 ]; then
  echo "[docker-prune] DRY RUN (default) -- nothing will be deleted. Re-run with --yes to actually prune."
  echo "[docker-prune] would run: docker builder prune -f"
  echo "[docker-prune] would run: docker container prune -f"
  if [ "$PRUNE_UNUSED_IMAGES" = 1 ]; then
    echo "[docker-prune] would run: docker image prune -a -f"
  else
    echo "[docker-prune] would run: docker image prune -f (dangling only; pass --images for unused-but-tagged images too)"
  fi
  echo "[docker-prune] volumes are NEVER pruned by this script -- application data, backups, and vector-store state are always safe."
  exit 0
fi

echo "[docker-prune] pruning build cache..."
docker builder prune -f

echo "[docker-prune] pruning stopped containers..."
docker container prune -f

if [ "$PRUNE_UNUSED_IMAGES" = 1 ]; then
  echo "[docker-prune] pruning ALL unused images (not just dangling)..."
  docker image prune -a -f
else
  echo "[docker-prune] pruning dangling images..."
  docker image prune -f
fi

echo "[docker-prune] disk usage after:"
docker system df

echo "[docker-prune] root filesystem usage:"
df -h / 2>/dev/null || true

echo "[docker-prune] complete -- volumes were never touched."
