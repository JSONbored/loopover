#!/usr/bin/env bash
# Pre-deploy diff summary for a self-host instance (#5735).
#
# A read-only preview of what `selfhost-update.sh` would pull in: the commit range between the
# current checkout (the last-deployed state -- this checkout only ever advances via
# selfhost-update.sh's own fast-forward merge) and the remote's tracked branch, plus a flag on any
# incoming commit that touches a path with a history of breaking a deploy on THIS instance
# (docker-compose service/volume definitions, Grafana provisioning, DB migrations, the deploy
# scripts themselves). Never fetches destructively and never mutates the checkout -- safe to run
# anytime, including with a dirty working tree, unlike selfhost-update.sh itself.
#
#   ./scripts/selfhost-pre-deploy-summary.sh
#
# Optional knobs (same names as selfhost-update.sh, so one override works for both):
#   SELFHOST_UPDATE_REMOTE=upstream SELFHOST_UPDATE_BRANCH=main ./scripts/selfhost-pre-deploy-summary.sh
set -euo pipefail

REMOTE="${SELFHOST_UPDATE_REMOTE:-origin}"
BRANCH="${SELFHOST_UPDATE_BRANCH:-main}"

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
    "$BRANCH first (this script compares HEAD against $REMOTE/$BRANCH)" >&2
  exit 1
fi
if [ "$current_branch" != "$BRANCH" ]; then
  echo "error: currently on '$current_branch', expected '$BRANCH' -- checkout $BRANCH first, or" \
    "set SELFHOST_UPDATE_BRANCH=$current_branch if that is deliberate" >&2
  exit 1
fi

echo "pre-deploy summary: fetching $REMOTE"
git fetch "$REMOTE" >/dev/null

if ! git rev-parse --verify --quiet "$REMOTE/$BRANCH" >/dev/null; then
  echo "error: $REMOTE/$BRANCH does not exist after fetching $REMOTE -- check" \
    "SELFHOST_UPDATE_REMOTE/SELFHOST_UPDATE_BRANCH for a typo, or confirm $REMOTE actually has a" \
    "'$BRANCH' branch" >&2
  exit 1
fi

range="HEAD..$REMOTE/$BRANCH"
commit_count="$(git rev-list --count "$range")"

if [ "$commit_count" = "0" ]; then
  echo "pre-deploy summary: up to date with $REMOTE/$BRANCH ($(git rev-parse --short=8 HEAD)) -- nothing to deploy"
  exit 0
fi

if ! git merge-base --is-ancestor HEAD "$REMOTE/$BRANCH"; then
  echo "pre-deploy summary: warning — HEAD is not an ancestor of $REMOTE/$BRANCH; selfhost-update.sh's" \
    "fast-forward-only merge will refuse this until local history is resolved. Showing the diff against" \
    "the merge-base instead of a clean incoming range." >&2
  merge_base="$(git merge-base HEAD "$REMOTE/$BRANCH")"
  range="$merge_base..$REMOTE/$BRANCH"
  commit_count="$(git rev-list --count "$range")"
fi

echo "pre-deploy summary: $commit_count commit(s) from $(git rev-parse --short=8 HEAD) to $(git rev-parse --short=8 "$REMOTE/$BRANCH") on $REMOTE/$BRANCH"
echo ""
echo "commits:"
git log --oneline "$range"
echo ""
echo "changed files ($(git diff --stat "$range" | tail -1 | sed 's/^ *//')):"
git diff --stat "$range"

# Historically-sensitive paths for THIS instance -- not the contributor-PR guardrail list
# (src/review/guardrail-config.ts), which protects against a hostile/careless CONTRIBUTOR change.
# This one is deploy-specific: every entry below has caused a real incident on this instance.
#   - docker-compose*.yml: an accidental `docker compose up -d grafana` without --no-deps
#     recreated postgres onto the wrong volume, causing a full outage (2026-07-13).
#   - grafana/provisioning/**, grafana/dashboards/**: disableDeletion:true orphaned 9 dashboards
#     under stale uids, and a $__all-prefixed SQL sentinel broke every dashboard filter (2026-07-13/14).
#   - migrations/**: a DB schema change that isn't also applied to the running instance's Postgres
#     leaves the app and the schema out of sync until the next deploy runs migrations.
#   - Dockerfile*: changes what's actually installed in the image (e.g. puppeteer-core /
#     INSTALL_VISUAL_REVIEW, codex/claude CLI binaries) -- a missing capability here silently
#     degrades a feature rather than failing loudly.
#   - scripts/selfhost-*.sh, scripts/lib/selfhost-*.sh, scripts/deploy-selfhost*.sh: the deploy
#     tooling itself -- a bug here affects every future deploy, not just this one.
#   - .env.example: a new required env var here with nothing set in the live .env degrades
#     silently rather than failing at boot.
is_sensitive() {
  case "$1" in
    docker-compose*.yml | \
    grafana/provisioning/* | grafana/dashboards/* | \
    migrations/* | \
    Dockerfile* | \
    scripts/selfhost-*.sh | scripts/lib/selfhost-*.sh | scripts/deploy-selfhost*.sh | \
    .env.example)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

sensitive_files=()
# #7775: capture the diff via a CHECKED command substitution rather than `done < <(git diff ...)`. A
# process-substitution failure (bad ref, shallow clone, detached history) is invisible to `set -e`, so the
# loop would just see no lines and the script would report "no historically-sensitive paths touched" -- a
# false all-clear on a deploy-safety advisory. Surface it as a real error instead.
if ! diff_output="$(git diff --name-only "$range")"; then
  echo "error: 'git diff --name-only $range' failed; cannot assess historically-sensitive paths" >&2
  exit 1
fi
while IFS= read -r file; do
  if [ -n "$file" ] && is_sensitive "$file"; then
    sensitive_files+=("$file")
  fi
done <<< "$diff_output"

echo ""
if [ "${#sensitive_files[@]}" -eq 0 ]; then
  echo "pre-deploy summary: no historically-sensitive paths touched"
else
  echo "pre-deploy summary: ⚠ ${#sensitive_files[@]} historically-sensitive path(s) touched -- review before deploying:"
  for file in "${sensitive_files[@]}"; do
    echo "  - $file"
  done
fi
