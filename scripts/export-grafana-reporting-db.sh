#!/bin/sh
set -eu

APP_DB="${GITTENSORY_REPORTING_SOURCE_DB:-/appdb/gittensory.sqlite}"
OUT_DIR="${GITTENSORY_REPORTING_DIR:-/reporting}"
OUT_DB="${GITTENSORY_REPORTING_DB:-$OUT_DIR/gittensory-reporting.sqlite}"
TMP_DB="${OUT_DB}.tmp"

sql_string() {
  printf "%s" "$1" | sed "s/'/''/g"
}

source_column_exists() {
  sqlite3 "$APP_DB" "SELECT 1 FROM pragma_table_info('$1') WHERE name = '$2' LIMIT 1" | grep -q 1
}

source_table_exists() {
  sqlite3 "$APP_DB" "SELECT 1 FROM sqlite_master WHERE type='table' AND name='$1' LIMIT 1" | grep -q 1
}

mkdir -p "$OUT_DIR"

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

if [ ! -s "$APP_DB" ]; then
  if [ -s "$OUT_DB" ]; then
    rm -f "$TMP_DB" "$TMP_DB-wal" "$TMP_DB-shm"
    echo "reporting export skipped: source database missing at $APP_DB; preserving last good $OUT_DB" >&2
    exit 1
  fi
  sqlite3 "$TMP_DB" "PRAGMA quick_check;" | grep -qx "ok"
  mv "$TMP_DB" "$OUT_DB"
  rm -f "$TMP_DB-wal" "$TMP_DB-shm"
  echo "reporting export empty: source database missing at $APP_DB" >&2
  exit 0
fi

if ! source_table_exists "pull_requests" &&
   ! source_table_exists "advisories" &&
   ! source_table_exists "review_targets" &&
   ! source_table_exists "ai_usage_events"; then
  if [ -s "$OUT_DB" ]; then
    rm -f "$TMP_DB" "$TMP_DB-wal" "$TMP_DB-shm"
    echo "reporting export skipped: no reporting source tables in $APP_DB; preserving last good $OUT_DB" >&2
    exit 1
  fi
fi

if source_table_exists "pull_requests" && source_table_exists "advisories"; then
  sqlite3 -cmd ".timeout 5000" "$APP_DB" "
ATTACH '$TMP_DB_SQL' AS report;
WITH latest_advisories AS (
  SELECT
    repo_full_name,
    pull_number,
    conclusion,
    updated_at,
    ROW_NUMBER() OVER (
      PARTITION BY repo_full_name, pull_number
      ORDER BY updated_at DESC, rowid DESC
    ) AS rn
  FROM main.advisories
  WHERE pull_number IS NOT NULL
),
current_pull_requests AS (
  SELECT
    p.repo_full_name AS repo,
    p.number AS number,
    p.author_login AS submitter,
    CASE
      WHEN lower(p.state) = 'closed' AND p.merged_at IS NOT NULL THEN 'merged'
      WHEN lower(p.state) = 'closed' THEN 'closed'
      WHEN a.conclusion IN ('failure', 'action_required') THEN 'manual'
      WHEN a.conclusion IS NOT NULL THEN 'commented'
      ELSE 'manual'
    END AS status,
    CASE a.conclusion
      WHEN 'success' THEN 'merge'
      WHEN 'failure' THEN 'close'
      WHEN 'action_required' THEN 'manual'
      WHEN 'neutral' THEN 'comment'
      WHEN 'skipped' THEN 'ignore'
      ELSE NULL
    END AS verdict,
    p.title AS title,
    p.created_at AS created_at,
    CASE
      WHEN a.updated_at IS NOT NULL AND a.updated_at > p.updated_at THEN a.updated_at
      ELSE p.updated_at
    END AS updated_at
  FROM main.pull_requests p
  LEFT JOIN latest_advisories a
    ON a.repo_full_name = p.repo_full_name
   AND a.pull_number = p.number
   AND a.rn = 1
)
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
FROM current_pull_requests;
DETACH report;
"
fi

if source_table_exists "review_targets"; then
  sqlite3 -cmd ".timeout 5000" "$APP_DB" "
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
  t.repo,
  t.number,
  t.submitter,
  t.status,
  t.verdict,
  t.title,
  t.created_at,
  t.updated_at
FROM main.review_targets t
WHERE t.kind = 'pull_request'
  AND NOT EXISTS (
    SELECT 1
    FROM report.review_targets r
    WHERE r.repo = t.repo
      AND r.number = t.number
  );
DETACH report;
"
fi

if source_table_exists "ai_usage_events"; then
  ESTIMATED_NEURONS_EXPR=0
  if source_column_exists "ai_usage_events" "estimated_neurons"; then
    ESTIMATED_NEURONS_EXPR="estimated_neurons"
  fi

  sqlite3 -cmd ".timeout 5000" "$APP_DB" "
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
  COALESCE($ESTIMATED_NEURONS_EXPR, 0),
  detail,
  json_object(
    'repoFullName', json_extract(metadata_json, '$.repoFullName'),
    'pullNumber', json_extract(metadata_json, '$.pullNumber')
  ) AS metadata_json,
  created_at
FROM main.ai_usage_events
WHERE feature = 'ai_review_pr';
DETACH report;
"
fi

sqlite3 "$TMP_DB" "PRAGMA quick_check;" | grep -qx "ok"
mv "$TMP_DB" "$OUT_DB"
rm -f "$TMP_DB-wal" "$TMP_DB-shm"

echo "reporting export complete: $OUT_DB"
