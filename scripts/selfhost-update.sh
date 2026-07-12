#!/usr/bin/env bash
# Git-backed self-host update flow: fetch, fast-forward-only, rebuild, verify (#1660).
#
# This is the single entry point for pulling upstream changes into a Git-backed self-host
# checkout. Before this script, an operator had to remember to run `git pull`, then
# deploy-selfhost-prebuilt.sh, then selfhost-post-update-check.sh, in that order, with no guard
# against a diverged local history silently creating a merge commit. This wraps all three into one
# command and refuses to proceed if the fast-forward is not clean:
#
#   ./scripts/selfhost-update.sh
#
# What this preserves untouched (all already gitignored -- see .gitignore):
#   - .env and any *_FILE secret mounts
#   - gittensory-config/ (private per-repo .gittensory.yml policy)
#   - .deploy-backups/ (operator deploy-backup snapshots)
#   - any *.local or docker-compose.local-*.yml compose override, or alertmanager config files
#   - named data volumes (loopover-data, loopover-pg, qdrant-data, loopover-backups,
#     grafana-data) -- untouched because this script only fetches source and rebuilds the
#     loopover app image; it never runs `docker volume` commands or touches compose profiles.
#
# Optional knobs:
#   SELFHOST_UPDATE_REMOTE=upstream SELFHOST_UPDATE_BRANCH=main ./scripts/selfhost-update.sh
#   SELFHOST_SKIP_POST_UPDATE_CHECK=1 ./scripts/selfhost-update.sh   # skip the health probe step
set -euo pipefail

REMOTE="${SELFHOST_UPDATE_REMOTE:-origin}"
BRANCH="${SELFHOST_UPDATE_BRANCH:-main}"
SKIP_POST_UPDATE_CHECK="${SELFHOST_SKIP_POST_UPDATE_CHECK:-0}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: required command not found: $1" >&2
    exit 1
  fi
}

require_cmd git

if ! git -C "$SCRIPT_DIR/.." rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: run this script from the loopover git checkout" >&2
  exit 1
fi

cd "$SCRIPT_DIR/.."

current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$current_branch" = "HEAD" ]; then
  echo "error: checkout is in a detached HEAD state, expected to be on '$BRANCH' -- checkout" \
    "$BRANCH first (this script only updates a branch-tracking checkout)" >&2
  exit 1
fi
if [ "$current_branch" != "$BRANCH" ]; then
  echo "error: currently on '$current_branch', expected '$BRANCH' -- checkout $BRANCH first, or" \
    "set SELFHOST_UPDATE_BRANCH=$current_branch if that is deliberate" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree is not clean -- commit, stash, or discard local changes before updating" >&2
  git status --short >&2
  exit 1
fi

echo "selfhost update: fetching $REMOTE"
git fetch "$REMOTE"

if ! git rev-parse --verify --quiet "$REMOTE/$BRANCH" >/dev/null; then
  echo "error: $REMOTE/$BRANCH does not exist after fetching $REMOTE -- check" \
    "SELFHOST_UPDATE_REMOTE/SELFHOST_UPDATE_BRANCH for a typo, or confirm $REMOTE actually has a" \
    "'$BRANCH' branch" >&2
  exit 1
fi

echo "selfhost update: fast-forwarding $BRANCH to $REMOTE/$BRANCH"
if ! git merge --ff-only "$REMOTE/$BRANCH"; then
  echo "error: $BRANCH could not be fast-forwarded to $REMOTE/$BRANCH -- local history has" \
    "diverged (unpushed commits or a manual edit). Resolve manually; this script never rebases" \
    "or force-merges for you." >&2
  exit 1
fi

echo "selfhost update: rebuilding from the updated checkout"
"$SCRIPT_DIR/deploy-selfhost-prebuilt.sh"

if [ "$SKIP_POST_UPDATE_CHECK" = "1" ]; then
  echo "selfhost update: skipping post-update health check (SELFHOST_SKIP_POST_UPDATE_CHECK=1)"
else
  echo "selfhost update: verifying health"
  "$SCRIPT_DIR/selfhost-post-update-check.sh"
fi

echo "selfhost update: complete ($(git rev-parse --short=8 HEAD))"
