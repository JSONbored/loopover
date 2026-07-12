#!/usr/bin/env bash
# Add (or update) the GitHub data source in Grafana via the API — the live upstream PR/issue census for the
# maintainer dashboards. Done over the API rather than file-provisioning on purpose: a backend datasource
# whose plugin/token isn't ready at boot would crash Grafana's provisioning, so we add it after Grafana is up.
#
# KNOWN, ACCEPTED trade-off: unlike the other 4 file-provisioned datasources (each `editable: false` in their
# YAML), this one is API-managed and therefore NOT locked read-only — Grafana's `readOnly` field is computed
# from whether a datasource came from file provisioning and cannot be set via the datasource API itself
# (verified empirically: a PUT with `"readOnly": true` in the payload is silently ignored, the response still
# reports `false`). Moving this to YAML provisioning to close that gap would reintroduce the exact boot-crash
# risk documented above, so this datasource's connection settings remain editable via the Grafana UI, unlike
# every other one in this stack.
#
# Prereqs: --profile observability running, the grafana-github-datasource plugin installed (GF_INSTALL_PLUGINS),
# and a read-only fine-grained PAT (Pull requests: read, Issues: read, Contents: read) on the repos.
#
# Usage:
#   GITHUB_TOKEN=<read-only-github-token> GRAFANA_ADMIN_PASSWORD=... ./scripts/setup-github-datasource.sh
#   # or rely on values already in ./.env (GITHUB_TOKEN, GRAFANA_ADMIN_PASSWORD)
set -euo pipefail

GRAFANA_URL="${GRAFANA_URL:-http://localhost:3000}"
[ -f .env ] && . ./.env
: "${GITHUB_TOKEN:?Set GITHUB_TOKEN (a read-only fine-grained PAT) in the environment or .env}"
: "${GRAFANA_ADMIN_PASSWORD:?Set GRAFANA_ADMIN_PASSWORD in the environment or .env}"

TMP_DIR="$(mktemp -d)"
NETRC_FILE="$TMP_DIR/netrc"
trap 'rm -rf "$TMP_DIR"' EXIT
GRAFANA_HOSTPORT="${GRAFANA_URL#*://}"
GRAFANA_HOSTPORT="${GRAFANA_HOSTPORT%%/*}"
GRAFANA_HOST="${GRAFANA_HOSTPORT%%:*}"
printf 'machine %s login %s password %s\n' "$GRAFANA_HOST" admin "$GRAFANA_ADMIN_PASSWORD" >"$NETRC_FILE"
chmod 600 "$NETRC_FILE"

grafana_curl() {
  env -u GRAFANA_ADMIN_PASSWORD -u GITHUB_TOKEN curl -sf --netrc-file "$NETRC_FILE" "$@"
}

payload() {
  cat <<JSON
{ "name": "GitHub", "type": "grafana-github-datasource", "uid": "github", "access": "proxy",
  "isDefault": false, "jsonData": { "selectedAuthType": "personal-access-token" },
  "secureJsonData": { "accessToken": "${GITHUB_TOKEN}" } }
JSON
}

# Idempotent: update in place if a datasource with uid "github" already exists, else create it.
if grafana_curl "$GRAFANA_URL/api/datasources/uid/github" >/dev/null 2>&1; then
  echo "Updating existing GitHub data source…"
  payload | grafana_curl -H 'content-type: application/json' -X PUT \
    "$GRAFANA_URL/api/datasources/uid/github" --data-binary @- >/dev/null
else
  echo "Creating GitHub data source…"
  payload | grafana_curl -H 'content-type: application/json' -X POST \
    "$GRAFANA_URL/api/datasources" --data-binary @- >/dev/null
fi

echo "Done. Verifying health…"
grafana_curl -X POST "$GRAFANA_URL/api/datasources/uid/github/health" 2>/dev/null \
  | grep -q '"status":"OK"' && echo "✓ GitHub data source healthy" || echo "⚠ Added, but health check did not return OK — verify the token scopes."
