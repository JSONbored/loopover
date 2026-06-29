#!/usr/bin/env bash
# Add (or update) the GitHub data source in Grafana via the API — the live upstream PR/issue census for the
# maintainer dashboards. Done over the API rather than file-provisioning on purpose: a backend datasource
# whose plugin/token isn't ready at boot would crash Grafana's provisioning, so we add it after Grafana is up.
#
# Prereqs: --profile observability running, the grafana-github-datasource plugin installed (GF_INSTALL_PLUGINS),
# and a read-only fine-grained PAT (Pull requests: read, Issues: read, Contents: read) on the repos.
#
# Usage:
#   GITHUB_TOKEN=<read-only-github-token> GRAFANA_ADMIN_PASSWORD=... ./scripts/setup-github-datasource.sh
#   # or rely on values already in ./.env (GITHUB_TOKEN, GRAFANA_ADMIN_PASSWORD)
set -euo pipefail

GRAFANA_URL="${GRAFANA_URL:-http://localhost:3000}"
[ -f .env ] && { set -a; . ./.env; set +a; }
: "${GITHUB_TOKEN:?Set GITHUB_TOKEN (a read-only fine-grained PAT) in the environment or .env}"
: "${GRAFANA_ADMIN_PASSWORD:?Set GRAFANA_ADMIN_PASSWORD in the environment or .env}"
AUTH="admin:${GRAFANA_ADMIN_PASSWORD}"

payload() {
  cat <<JSON
{ "name": "GitHub", "type": "grafana-github-datasource", "uid": "github", "access": "proxy",
  "isDefault": false, "jsonData": { "selectedAuthType": "personal-access-token" },
  "secureJsonData": { "accessToken": "${GITHUB_TOKEN}" } }
JSON
}

# Idempotent: update in place if a datasource with uid "github" already exists, else create it.
if curl -sf -u "$AUTH" "$GRAFANA_URL/api/datasources/uid/github" >/dev/null 2>&1; then
  echo "Updating existing GitHub data source…"
  curl -sf -u "$AUTH" -H 'content-type: application/json' -X PUT \
    "$GRAFANA_URL/api/datasources/uid/github" -d "$(payload)" >/dev/null
else
  echo "Creating GitHub data source…"
  curl -sf -u "$AUTH" -H 'content-type: application/json' -X POST \
    "$GRAFANA_URL/api/datasources" -d "$(payload)" >/dev/null
fi

echo "Done. Verifying health…"
curl -sf -u "$AUTH" -X POST "$GRAFANA_URL/api/datasources/uid/github/health" 2>/dev/null \
  | grep -q '"status":"OK"' && echo "✓ GitHub data source healthy" || echo "⚠ Added, but health check did not return OK — verify the token scopes."
