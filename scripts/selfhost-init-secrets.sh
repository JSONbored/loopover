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
# IDEMPOTENT AND NON-DESTRUCTIVE: for a RANDOM_SECRET_FILE (below), generates a real `openssl rand -hex
# 32` value the first time the file is missing or still empty (#4928 -- this is what lets an operator
# boot without ever running that command by hand). For an EXTERNAL_SECRET_FILE (issued by GitHub /
# PagerDuty / Claude / the broker operator -- nothing this host can generate a USABLE value for), it
# still only creates an empty placeholder, unchanged from before. Either way, a file that already has
# real content is left completely alone: the instant a value is written into it (by an operator or by
# this script), its size is no longer zero, so nothing here regenerates or re-heals it again. Safe to
# run on every deploy, unconditionally.
#
# Usage:
#   ./scripts/selfhost-init-secrets.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

SECRETS_DIR="secrets"

# Keep in sync with the `secrets:` table in docker-compose.yml and secrets/README.md.
#
# Self-generatable: no external party has to have already agreed on the value, so a random one is exactly
# as valid as an operator-typed one. github_webhook_secret is included here too -- an operator creating
# the GitHub App by hand (rather than through the /setup wizard's manifest flow, which gets this value
# for free from GitHub) picks this value themselves and pastes the SAME string into the App's webhook
# settings; generating it here just gives them something to copy instead of typing the command themselves.
RANDOM_SECRET_FILES=(
  "github_webhook_secret.txt"
  "loopover_api_token.txt"
  "loopover_mcp_token.txt"
  "loopover_mcp_admin_token.txt"
  "redeploy_companion_token.txt"
  "internal_job_token.txt"
  "selfhost_setup_token.txt"
  "token_encryption_secret.txt"
  "draft_token_encryption_secret.txt"
)

# Externally issued: a randomly generated value here would never match a real GitHub App keypair, broker
# enrollment, PagerDuty routing key, or Claude Code OAuth token -- stays an empty placeholder for the
# operator to fill in from that external source, exactly as before this change.
EXTERNAL_SECRET_FILES=(
  "github_app_private_key.pem"
  "orb_enrollment_secret.txt"
  "pagerduty_routing_key.txt"
  "claude_code_oauth_token.txt"
)

mkdir -p "$SECRETS_DIR"

generated=0
created=0
healed=0

for name in "${RANDOM_SECRET_FILES[@]}"; do
  path="$SECRETS_DIR/$name"
  if [ ! -e "$path" ] || [ ! -s "$path" ]; then
    openssl rand -hex 32 >"$path"
    chmod 644 "$path"
    generated=$((generated + 1))
  fi
done

for name in "${EXTERNAL_SECRET_FILES[@]}"; do
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

if [ "$generated" -gt 0 ] || [ "$created" -gt 0 ] || [ "$healed" -gt 0 ]; then
  echo "selfhost init-secrets: generated $generated random secret(s), created $created and mode-healed $healed empty placeholder file(s) in $SECRETS_DIR/"
else
  echo "selfhost init-secrets: all secret files already present, nothing to do"
fi
