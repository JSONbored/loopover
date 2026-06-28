#!/bin/sh
set -eu

APP_DB="${GITTENSORY_REPORTING_SOURCE_DB:-/appdb/gittensory.sqlite}"
OUT_DIR="${GITTENSORY_REPORTING_DIR:-/reporting}"
OUT_DB="${GITTENSORY_REPORTING_DB:-$OUT_DIR/gittensory-reporting.sqlite}"
TMP_DB="${OUT_DB}.tmp"

sql_string() {
  printf "%s" "$1" | sed "s/'/''/g"
}

mkdir -p "$OUT_DIR"

if [ ! -s "$APP_DB" ]; then
  echo "reporting export skipped: source database missing at $APP_DB" >&2
  exit 0
fi

rm -f "$TMP_DB" "$TMP_DB-wal" "$TMP_DB-shm"
TMP_DB_SQL="$(sql_string "$TMP_DB")"

sqlite3 "$TMP_DB" <<'SQL'
PRAGMA synchronous=NORMAL;

CREATE TABLE review_targets (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  submitter TEXT,
  status TEXT NOT NULL,
  verdict TEXT,
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX review_targets_updated_idx ON review_targets(updated_at);
CREATE INDEX review_targets_status_idx ON review_targets(status);
CREATE INDEX review_targets_verdict_idx ON review_targets(verdict);

CREATE TABLE ai_usage_events (
  feature TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  estimated_neurons INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX ai_usage_events_feature_created_idx ON ai_usage_events(feature, created_at);
CREATE INDEX ai_usage_events_model_created_idx ON ai_usage_events(model, created_at);
SQL

if sqlite3 "$APP_DB" "SELECT 1 FROM sqlite_master WHERE type='table' AND name='review_targets' LIMIT 1" | grep -q 1; then
  sqlite3 "$APP_DB" <<SQL
.timeout 5000
ATTACH '$TMP_DB_SQL' AS report;
INSERT INTO report.review_targets (
  repo,
  number,
  submitter,
  status,
  verdict,
  title,
  created_at,
  updated_at
)
SELECT
  repo,
  number,
  submitter,
  status,
  verdict,
  title,
  created_at,
  updated_at
FROM main.review_targets
WHERE kind = 'pull_request';
DETACH report;
SQL
fi

if sqlite3 "$APP_DB" "SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_usage_events' LIMIT 1" | grep -q 1; then
  sqlite3 "$APP_DB" <<SQL
.timeout 5000
ATTACH '$TMP_DB_SQL' AS report;
INSERT INTO report.ai_usage_events (
  feature,
  model,
  status,
  estimated_neurons,
  detail,
  metadata_json,
  created_at
)
SELECT
  feature,
  model,
  status,
  estimated_neurons,
  detail,
  json_object(
    'repoFullName', json_extract(metadata_json, '$.repoFullName'),
    'pullNumber', json_extract(metadata_json, '$.pullNumber')
  ) AS metadata_json,
  created_at
FROM main.ai_usage_events
WHERE feature = 'ai_review_pr';
DETACH report;
SQL
fi

sqlite3 "$TMP_DB" "PRAGMA quick_check;" | grep -qx "ok"
mv "$TMP_DB" "$OUT_DB"
rm -f "$TMP_DB-wal" "$TMP_DB-shm"

echo "reporting export complete: $OUT_DB"
