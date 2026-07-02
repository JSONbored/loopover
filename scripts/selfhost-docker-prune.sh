#!/bin/sh
# Automated Docker resource hygiene for a 24/7 self-hosted gittensory stack (#audit-rate-headroom). Runs on
# the HOST (via the systemd timer in systemd/gittensory-docker-prune.{service,timer}.example), not as a
# compose service: reclaiming unused images and build cache needs real Docker daemon access, which this
# repo deliberately does not grant to any container (see docker-compose.yml's docker-proxy and runner
# service comments on why raw docker.sock exposure into a container is avoided).
#
# Age-filtered so nothing built/pulled recently is touched -- a rollback within the retention window still
# has its image available. `docker image prune -a` and `docker builder prune` only ever remove resources
# Docker itself already reports as unused (a running container's own image, or an active build-cache entry
# a build is currently using, are never candidates) -- this script does not change that safety property, it
# only adds the age floor on top of it.
set -eu

RETAIN_HOURS=${GITTENSORY_DOCKER_PRUNE_RETAIN_HOURS:-168} # 7 days

echo "[docker-prune] $(date -u +%FT%TZ) starting (retain: ${RETAIN_HOURS}h)"
echo "[docker-prune] before:"
docker system df

echo "[docker-prune] pruning unused images older than ${RETAIN_HOURS}h..."
docker image prune -af --filter "until=${RETAIN_HOURS}h"

echo "[docker-prune] pruning build cache older than ${RETAIN_HOURS}h..."
docker builder prune -af --filter "until=${RETAIN_HOURS}h"

echo "[docker-prune] after:"
docker system df

echo "[docker-prune] $(date -u +%FT%TZ) done"
