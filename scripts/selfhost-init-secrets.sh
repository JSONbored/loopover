#!/usr/bin/env bash
# Ensure every Docker Compose secret file docker-compose.yml's `loopover` service references
# actually exists on disk, so `docker compose build`/`up` never fails on a missing `secrets:` source
# file -- Compose requires the file to exist even for an operator who has never touched this feature
# and is relying entirely on inline .env values (see secrets/README.md: an inline value always wins
# over the file, so a placeholder here is a pure no-op for that operator).
#
# MODE 644, NOT 600 (#secrets-uid-mismatch, a real incident on edge-nl-01 -- see docker-compose.yml's
# own secrets: comment for the full "why"): standalone Compose secrets are a plain bind mount, which
# cannot remap in-container ownership the way Swarm secrets can -- the container reads this file AS
# ITS OWN uid (the Dockerfile's `USER node`, 1000), essentially never the deploying host user's uid, so
# an owner-only 600 file is unreadable to the app and load-file-secrets.ts's readFileSync throws. 644
# is the minimum that works portably across arbitrary host/container uid pairs without requiring the
# operator's host to have a matching uid or group -- this trades host-local-user readability (a lower
# bar: requires an actual shell on this machine) for what the original hardening was actually about:
# no longer visible via `docker inspect`/`docker compose config`/full env-var dumps.
#
# IDEMPOTENT AND NON-DESTRUCTIVE: creates any MISSING file empty at 644. For a file that already exists,
# self-heals the mode to 644 ONLY while it is still empty (a placeholder, never populated, so nothing to
# protect via 600 in the first place) -- the instant an operator writes a real secret into it, its size is
# no longer zero, so this leaves both its content AND whatever permissions they set entirely alone. Safe
# to run on every deploy, unconditionally.
#
# Usage:
#   ./scripts/selfhost-init-secrets.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

SECRETS_DIR="secrets"

# Keep in sync with the `secrets:` table in docker-compose.yml and secrets/README.md.
SECRET_FILES=(
  "github_app_private_key.pem"
  "github_webhook_secret.txt"
  "loopover_api_token.txt"
  "loopover_mcp_token.txt"
  "internal_job_token.txt"
  "selfhost_setup_token.txt"
  "token_encryption_secret.txt"
  "draft_token_encryption_secret.txt"
  "orb_enrollment_secret.txt"
  "pagerduty_routing_key.txt"
  "claude_code_oauth_token.txt"
)

mkdir -p "$SECRETS_DIR"

created=0
healed=0
for name in "${SECRET_FILES[@]}"; do
  path="$SECRETS_DIR/$name"
  if [ ! -e "$path" ]; then
    : >"$path"
    chmod 644 "$path"
    created=$((created + 1))
  elif [ ! -s "$path" ]; then
    chmod 644 "$path"
    healed=$((healed + 1))
  fi
done

if [ "$created" -gt 0 ] || [ "$healed" -gt 0 ]; then
  echo "selfhost init-secrets: created $created, mode-healed $healed empty placeholder file(s) in $SECRETS_DIR/"
else
  echo "selfhost init-secrets: all secret files already present, nothing to do"
fi
