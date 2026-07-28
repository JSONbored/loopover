#!/usr/bin/env bash
# Rotate one self-host credential safely (#9543).
#
# Replaces the hand-rolled "edit the file, restart the stack, hope" dance, which has two failure modes that
# are both SILENT -- the container stays healthy and the status stays green while every review quietly
# degrades to the fallback provider:
#
#   1. SHAPE. src/selfhost/load-file-secrets.ts only .trim()s the file. It does not strip comments and does
#      not select a line. A human-added label line above the value ("# some-account") becomes part of the
#      credential, and with AI_PROVIDER=claude-code,ollama the failed auth just falls through to Ollama.
#      Use a sidecar <name>.label file if you want to annotate which account a credential belongs to.
#
#   2. INODE. A Compose `secrets:` entry is a plain bind mount pinned to the INODE. Writing the file IN
#      PLACE propagates to the running container instantly; write-new-then-rename (`mv`, and the default
#      save behaviour of several editors) leaves the container serving the OLD bytes. `docker compose up -d`
#      does NOT repair this -- it prints "Container Running" and changes nothing, because the Compose config
#      is unchanged. Only --force-recreate re-establishes the mount. This script therefore always truncates
#      in place and never renames.
#
# Usage (the value is read from STDIN, never argv -- argv is visible in `ps` and lands in shell history):
#   ./scripts/rotate-secret.sh claude_code_oauth_token < /path/to/new-token
#   printf '%s' 'sk-ant-oat01...' | ./scripts/rotate-secret.sh claude_code_oauth_token
#   ./scripts/rotate-secret.sh --list
#
# For claude_code_oauth_token no restart is needed: the token is re-read from the file on every AI call
# (src/selfhost/ai.ts's resolveClaudeOauthToken). Codex is likewise already hot -- its auth.json is
# re-resolved per call. Every other secret is materialised into the environment once at boot, so this
# script recreates the container for those, and only those.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Secrets that are re-read at AI-call time and therefore need no restart at all.
HOT_SECRETS=" claude_code_oauth_token codex_auth "

usage() {
  cat >&2 <<'EOF'
usage: rotate-secret.sh <secret-name>   (new value on stdin)
       rotate-secret.sh --list

Reads the new value from stdin, validates its shape, backs up the previous value,
writes it in place, and verifies the running container sees it.
EOF
}

secret_path() {
  case "$1" in
    claude_code_oauth_token)  echo "secrets/claude_code_oauth_token.txt" ;;
    github_webhook_secret)    echo "secrets/github_webhook_secret.txt" ;;
    loopover_api_token)       echo "secrets/loopover_api_token.txt" ;;
    loopover_mcp_token)       echo "secrets/loopover_mcp_token.txt" ;;
    loopover_mcp_admin_token) echo "secrets/loopover_mcp_admin_token.txt" ;;
    pagerduty_routing_key)    echo "secrets/pagerduty_routing_key.txt" ;;
    internal_job_token)       echo "secrets/internal_job_token.txt" ;;
    redeploy_companion_token) echo "secrets/redeploy_companion_token.txt" ;;
    *) return 1 ;;
  esac
}

if [ "${1:-}" = "--list" ]; then
  echo "rotatable secrets:"
  for name in claude_code_oauth_token codex_auth github_webhook_secret loopover_api_token loopover_mcp_token loopover_mcp_admin_token pagerduty_routing_key internal_job_token redeploy_companion_token; do
    case "$HOT_SECRETS" in *" $name "*) echo "  $name (hot -- no restart)" ;; *) echo "  $name (needs restart)" ;; esac
  done
  exit 0
fi

NAME="${1:-}"
if [ -z "$NAME" ]; then usage; exit 2; fi

# codex's credential is not a Compose secret at all -- it is auth.json inside the loopover-data volume,
# written by `codex auth`. It is a JSON document, so the single-line validation below cannot apply to it.
if [ "$NAME" = "codex_auth" ]; then
  echo "codex_auth is not a Compose secret: it is auth.json inside the loopover-data volume." >&2
  echo "Rotate it by running 'codex auth' in the container, or by replacing /data/codex/auth.json." >&2
  echo "No restart is needed either way -- the path is re-resolved on every AI call." >&2
  exit 2
fi

if ! TARGET="$(secret_path "$NAME")"; then
  echo "unknown secret: $NAME (see --list)" >&2
  exit 2
fi

if [ -t 0 ]; then
  echo "refusing to read the value from a terminal -- pipe it in or redirect a file." >&2
  usage
  exit 2
fi

# `$(...)` strips trailing newlines, which is exactly what we want: a file written by an editor almost
# always ends in one, and the stored credential must not.
VALUE="$(cat)"

# ── Shape validation (footgun 1) ────────────────────────────────────────────────────────────────
if [ -z "$VALUE" ]; then
  echo "refusing to write an empty value to $TARGET" >&2
  exit 1
fi
if [ "$(printf '%s' "$VALUE" | wc -l | tr -d ' ')" != "0" ]; then
  echo "refusing to write a multi-line value to $TARGET" >&2
  echo "the loader only trims -- a comment or label line would become part of the credential." >&2
  echo "put annotations in ${TARGET%.txt}.label instead." >&2
  exit 1
fi
case "$VALUE" in
  '#'*) echo "refusing to write a value starting with '#' -- that is a comment, not a credential." >&2; exit 1 ;;
  *[[:space:]]*) echo "refusing to write a value containing whitespace to $TARGET" >&2; exit 1 ;;
esac
if [ "$NAME" = "claude_code_oauth_token" ]; then
  case "$VALUE" in
    sk-ant-*) ;;
    *) echo "refusing to write a claude token that does not start with 'sk-ant-'." >&2; exit 1 ;;
  esac
fi

# ── Backup ──────────────────────────────────────────────────────────────────────────────────────
# Backups go to .deploy-backups/, never inside secrets/ -- that directory is the Compose `secrets:` source,
# and a stray file there is one careless glob away from being mounted somewhere it should not be.
mkdir -p .deploy-backups
if [ -s "$TARGET" ]; then
  BACKUP=".deploy-backups/${NAME}.txt.bak-$(date -u +%Y%m%dT%H%M%SZ)"
  cp -p "$TARGET" "$BACKUP"
  chmod 600 "$BACKUP"
  echo "backed up previous value -> $BACKUP"
fi

# ── Write IN PLACE (footgun 2) ──────────────────────────────────────────────────────────────────
# `>` truncates the existing inode rather than creating a new one, so the running container's bind mount
# keeps pointing at the same file and sees the new bytes immediately. Never `mv` here.
printf '%s' "$VALUE" > "$TARGET"
chmod 644 "$TARGET" # 644, not 600: the app reads this as its own uid -- see secrets/README.md.
echo "wrote $(wc -c < "$TARGET" | tr -d ' ') bytes to $TARGET"

# ── Verify the container agrees ─────────────────────────────────────────────────────────────────
# The whole point of writing in place is that a RUNNING container sees the change. Prove it rather than
# assuming it -- this is the check that would have caught the stale-inode failure this script exists for.
if command -v docker >/dev/null 2>&1 && docker compose ps --status running loopover >/dev/null 2>&1; then
  HOST_BYTES="$(wc -c < "$TARGET" | tr -d ' ')"
  CONTAINER_BYTES="$(docker compose exec -T loopover sh -c "wc -c < /run/secrets/${NAME}" 2>/dev/null | tr -d ' \r' || echo "")"
  if [ -n "$CONTAINER_BYTES" ] && [ "$CONTAINER_BYTES" != "$HOST_BYTES" ]; then
    echo "WARNING: container sees ${CONTAINER_BYTES} bytes but the host file is ${HOST_BYTES}." >&2
    echo "the bind mount is pinned to a stale inode. recreate the container:" >&2
    echo "  docker compose up -d --no-deps --force-recreate loopover" >&2
    exit 1
  fi
  echo "verified: the running container sees the new value (${HOST_BYTES} bytes)"

  case "$HOT_SECRETS" in
    *" $NAME "*)
      echo "done -- no restart needed, ${NAME} is re-read on every AI call."
      ;;
    *)
      echo "recreating the container so the new value is picked up at boot..."
      docker compose up -d --no-deps --force-recreate loopover
      ;;
  esac
else
  echo "note: docker compose not available here, so the container's view was not verified."
  case "$HOT_SECRETS" in
    *" $NAME "*) echo "no restart needed -- ${NAME} is re-read on every AI call." ;;
    *) echo "restart required: docker compose up -d --no-deps --force-recreate loopover" ;;
  esac
fi
