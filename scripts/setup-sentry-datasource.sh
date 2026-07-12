#!/usr/bin/env bash
# Add (or update) the Sentry data source in Grafana via the API — in-Grafana error/issue visualization,
# correlated in time with the rest of the stack (#5369). Distinct from #5007 (Alertmanager/Sentry
# notification routing): this is read-only visualization, not paging.
#
# Done over the API rather than file-provisioning, for the exact reason scripts/setup-github-datasource.sh
# already documents: a backend datasource whose plugin/token isn't ready at boot would crash Grafana's
# provisioning, so we add it after Grafana is up.
#
# IMPORTANT: SENTRY_DSN (already used for this stack's own error REPORTING to Sentry, see the self-hosting
# docs) is NOT sufficient here and cannot be reused — a DSN authenticates event *ingestion*, not the
# read/query API this datasource needs. You need a separate Sentry "Internal Integration" token (Sentry →
# Settings → Developer Settings → Custom Integrations → New Internal Integration, requires an Admin/Manager/
# Owner role) with Read access on the Project, Issue & Event, and Organization resource scopes.
#
# KNOWN, ACCEPTED trade-off: same as the GitHub datasource — API-managed, so NOT locked read-only via
# Grafana's `readOnly` field (that flag can only be set by file provisioning, not the datasource API).
#
# Prereqs: --profile observability running, the grafana-sentry-datasource plugin installed
# (GF_INSTALL_PLUGINS, confirmed Grafana-signed and Grafana-13.x-compatible), and a Sentry Internal
# Integration auth token with the scopes above.
#
# Usage:
#   SENTRY_API_TOKEN=<sentry-internal-integration-token> SENTRY_ORG_SLUG=<your-org-slug> \
#     GRAFANA_ADMIN_PASSWORD=... ./scripts/setup-sentry-datasource.sh
#   # or rely on values already in ./.env (SENTRY_API_TOKEN, SENTRY_ORG_SLUG, GRAFANA_ADMIN_PASSWORD)
set -euo pipefail

GRAFANA_URL="${GRAFANA_URL:-http://localhost:3000}"
[ -f .env ] && { set -a; . ./.env; set +a; }
: "${SENTRY_API_TOKEN:?Set SENTRY_API_TOKEN (a Sentry Internal Integration token, NOT your SENTRY_DSN) in the environment or .env}"
: "${SENTRY_ORG_SLUG:?Set SENTRY_ORG_SLUG (your Sentry organization slug) in the environment or .env}"
: "${GRAFANA_ADMIN_PASSWORD:?Set GRAFANA_ADMIN_PASSWORD in the environment or .env}"
AUTH="admin:${GRAFANA_ADMIN_PASSWORD}"
# https://sentry.io for Sentry SaaS; override for a self-hosted Sentry instance.
SENTRY_API_URL="${SENTRY_API_URL:-https://sentry.io}"

payload() {
  cat <<JSON
{ "name": "Sentry", "type": "grafana-sentry-datasource", "uid": "sentry", "access": "proxy",
  "isDefault": false, "jsonData": { "url": "${SENTRY_API_URL}", "orgSlug": "${SENTRY_ORG_SLUG}" },
  "secureJsonData": { "authToken": "${SENTRY_API_TOKEN}" } }
JSON
}

# Idempotent: update in place if a datasource with uid "sentry" already exists, else create it.
if curl -sf -u "$AUTH" "$GRAFANA_URL/api/datasources/uid/sentry" >/dev/null 2>&1; then
  echo "Updating existing Sentry data source…"
  curl -sf -u "$AUTH" -H 'content-type: application/json' -X PUT \
    "$GRAFANA_URL/api/datasources/uid/sentry" -d "$(payload)" >/dev/null
else
  echo "Creating Sentry data source…"
  curl -sf -u "$AUTH" -H 'content-type: application/json' -X POST \
    "$GRAFANA_URL/api/datasources" -d "$(payload)" >/dev/null
fi

echo "Done. Verifying health…"
curl -sf -u "$AUTH" -X POST "$GRAFANA_URL/api/datasources/uid/sentry/health" 2>/dev/null \
  | grep -q '"status":"OK"' && echo "✓ Sentry data source healthy" || echo "⚠ Added, but health check did not return OK — verify SENTRY_API_TOKEN's scopes and SENTRY_ORG_SLUG."
