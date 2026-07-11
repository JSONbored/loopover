#!/usr/bin/env bash
# Ensure every Docker Compose secret file docker-compose.yml's `gittensory` service references
# actually exists on disk, so `docker compose build`/`up` never fails on a missing `secrets:` source
# file -- Compose requires the file to exist even for an operator who has never touched this feature
# and is relying entirely on inline .env values (see secrets/README.md: an inline value always wins
# over the file, so a placeholder here is a pure no-op for that operator).
#
# IDEMPOTENT AND NON-DESTRUCTIVE: only ever creates a MISSING file, empty, chmod 600. Never touches a
# file that already exists (whether it's still an empty placeholder or a real secret an operator has
# since populated) -- safe to run on every deploy, unconditionally.
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
)

mkdir -p "$SECRETS_DIR"

created=0
for name in "${SECRET_FILES[@]}"; do
  path="$SECRETS_DIR/$name"
  if [ ! -e "$path" ]; then
    : >"$path"
    chmod 600 "$path"
    created=$((created + 1))
  fi
done

if [ "$created" -gt 0 ]; then
  echo "selfhost init-secrets: created $created empty placeholder file(s) in $SECRETS_DIR/"
else
  echo "selfhost init-secrets: all secret files already present, nothing to do"
fi
