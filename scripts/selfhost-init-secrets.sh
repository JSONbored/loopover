#!/usr/bin/env bash
# Ensure every Docker Compose secret file docker-compose.yml's `gittensory` service references
# actually exists on disk, so `docker compose build`/`up` never fails on a missing `secrets:` source
# file -- Compose requires the file to exist even for an operator who has never touched this feature
# and is relying entirely on inline .env values (see secrets/README.md: an inline value always wins
# over the file, so a placeholder here is a pure no-op for that operator).
#
# Placeholders are owner-only on the host. Standalone Compose secrets are bind mounts, so
# a populated secret must be made readable by the container user explicitly (uid/gid 1000 for
# this image) rather than by making the host file world-readable. See secrets/README.md for
# the copy/install commands operators should use for real secret material.
#
# IDEMPOTENT AND NON-DESTRUCTIVE: creates any MISSING file empty at 600. For a file that
# already exists, self-heals the mode to 600 ONLY while it is still empty (a placeholder, never
# populated, so nothing needs to be readable by the container yet). The instant an operator
# writes a real secret into it, its size is no longer zero, so this leaves both its content and
# whatever permissions/ownership they set entirely alone. Safe to run on every deploy.
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
  "gittensory_api_token.txt"
  "gittensory_mcp_token.txt"
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
    chmod 600 "$path"
    created=$((created + 1))
  elif [ ! -s "$path" ]; then
    chmod 600 "$path"
    healed=$((healed + 1))
  fi
done

if [ "$created" -gt 0 ] || [ "$healed" -gt 0 ]; then
  echo "selfhost init-secrets: created $created, mode-healed $healed empty placeholder file(s) in $SECRETS_DIR/"
else
  echo "selfhost init-secrets: all secret files already present, nothing to do"
fi
