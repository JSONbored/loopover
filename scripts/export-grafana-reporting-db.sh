#!/bin/sh
set -eu

APP_DB="${GITTENSORY_REPORTING_SOURCE_DB:-/appdb/gittensory.sqlite}"
PG_DB="${GITTENSORY_REPORTING_SOURCE_DATABASE_URL:-${DATABASE_URL:-}}"
OUT_DIR="${GITTENSORY_REPORTING_DIR:-/reporting}"
OUT_DB="${GITTENSORY_REPORTING_DB:-$OUT_DIR/gittensory-reporting.sqlite}"
TMP_DB="${OUT_DB}.tmp"
FINGERPRINT_FILE="${OUT_DB}.fingerprint"
CSV_TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$CSV_TMP_DIR"
}
trap cleanup EXIT HUP INT TERM

sql_string() {
  printf "%s" "$1" | sed "s/'/''/g"
}

sqlite_dot_string() {
  printf "%s" "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/'
}

csv_temp_file() {
  mktemp "$CSV_TMP_DIR/$1.XXXXXX"
}

source_column_exists() {
  sqlite3 "$APP_DB" "SELECT 1 FROM pragma_table_info('$1') WHERE name = '$2' LIMIT 1" | grep -q 1
}

source_table_exists() {
  sqlite3 "$APP_DB" "SELECT 1 FROM sqlite_master WHERE type='table' AND name='$1' LIMIT 1" | grep -q 1
}

pg_enabled() {
  case "$PG_DB" in
    postgres://*|postgresql://*) return 0 ;;
    *) return 1 ;;
  esac
}

# Split $PG_DB (a postgres://[user[:pass]@]host[:port]/dbname[?query] URL) into separate PGHOST/PGPORT/PGUSER/
# PGPASSWORD/PGDATABASE/PGSSLMODE env vars and export them, so every psql call below authenticates purely
# through the environment: never a URL on argv (the credential-leak-via-`ps`-listings concern #2461 addressed)
# and never through PGDATABASE holding the WHOLE url (the #2461 regression -- unlike passing the url as psql's
# positional dbname argument, PGDATABASE is not URI-expanded by libpq; it is taken as a literal, nonexistent
# database name, so psql falls back to a local Unix-socket connection attempt instead of the intended TCP host).
# Known limitation: no percent-decoding of the user/password segment (matches this script's pre-existing scope --
# neither the original positional-arg form nor this one has ever decoded a percent-encoded credential).
pg_export_connection_env() {
  rest="${PG_DB#*://}"
  no_query="${rest%%\?*}"
  case "$rest" in
    "$no_query"'?'*) query="${rest#"$no_query"?}" ;;
    *) query="" ;;
  esac
  case "$no_query" in
    *@*) userinfo="${no_query%%@*}"; hostpart="${no_query#*@}" ;;
    *) userinfo=""; hostpart="$no_query" ;;
  esac
  case "$hostpart" in
    */*) hostport="${hostpart%%/*}"; PGDATABASE="${hostpart#*/}" ;;
    *) hostport="$hostpart"; PGDATABASE="" ;;
  esac
  # An IPv6 literal is bracketed in URI syntax (RFC 3986) specifically because it contains colons itself --
  # e.g. postgres://u:p@[::1]:5432/db -- so a naive split on the FIRST colon wrongly cuts the address apart
  # (PGHOST='[', PGPORT=':1]:5432'). Handle the bracketed forms (with and without a trailing port) before
  # falling back to plain first-colon splitting for an ordinary hostname/IPv4 host. psql/libpq accept the
  # IPv6 literal via PGHOST WITHOUT its brackets (brackets are only a URI-syntax disambiguator).
  case "$hostport" in
    \[*\]:*)
      PGHOST="${hostport#\[}"
      PGHOST="${PGHOST%%\]:*}"
      PGPORT="${hostport##*\]:}"
      ;;
    \[*\])
      PGHOST="${hostport#\[}"
      PGHOST="${PGHOST%\]}"
      PGPORT=""
      ;;
    *:*) PGHOST="${hostport%%:*}"; PGPORT="${hostport#*:}" ;;
    *) PGHOST="$hostport"; PGPORT="" ;;
  esac
  case "$userinfo" in
    *:*) PGUSER="${userinfo%%:*}"; PGPASSWORD="${userinfo#*:}" ;;
    *) PGUSER="$userinfo"; PGPASSWORD="" ;;
  esac
  export PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
  case "$query" in
    *sslmode=*)
      sslpart="${query#*sslmode=}"
      PGSSLMODE="${sslpart%%&*}"
      export PGSSLMODE
      ;;
  esac
}

pg_scalar() {
  psql -X -q -t -A -v ON_ERROR_STOP=1 -c "$1"
}

pg_table_exists() {
  value="$(pg_scalar "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '$1' LIMIT 1")" || {
    echo "reporting export failed: could not inspect Postgres table $1" >&2
    exit 1
  }
  [ "$value" = "1" ]
}

pg_column_exists() {
  value="$(pg_scalar "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '$1' AND column_name = '$2' LIMIT 1")" || {
    echo "reporting export failed: could not inspect Postgres column $1.$2" >&2
    exit 1
  }
  [ "$value" = "1" ]
}

pg_copy_csv() {
  query="$1"
  out="$2"
  psql -X -q -v ON_ERROR_STOP=1 -c "COPY ($query) TO STDOUT WITH CSV" >"$out"
}

sqlite_import_csv() {
  csv="$1"
  table="$2"
  [ -s "$csv" ] || return 0
  csv_arg="$(sqlite_dot_string "$csv")"
  table_arg="$(sqlite_dot_string "$table")"
  sqlite3 "$TMP_DB" <<SQL
.mode csv
.import $csv_arg $table_arg
SQL
}

# Incremental fast-path (#3895): a live review pipeline is bursty -- most 30s cycles change nothing since the
# last export, yet the full rebuild below re-exports and re-imports every row of every table every time. That
# cost grows without bound as ai_usage_events (an append-only log of every AI call) accumulates -- measured on
# a real self-host instance at 91GB of cumulative block I/O in 37 hours. A cheap COUNT+MAX fingerprint per
# table is orders of magnitude cheaper than the full COPY/SELECT+INSERT rebuild, so skip the whole rebuild
# when the fingerprint matches the last run's AND a last-good $OUT_DB already exists. Fails OPEN: any error or
# missing piece while computing the fingerprint falls through to the existing full-rebuild path unchanged --
# this is purely an optimization, never a new failure mode or a new way to serve stale data.
sqlite_source_fingerprint() {
  [ -s "$APP_DB" ] || return 1
  fp=""
  for spec in "pull_requests:updated_at" "review_audit:created_at" "review_targets:updated_at" "ai_usage_events:created_at"; do
    tbl="${spec%%:*}"
    col="${spec#*:}"
    if source_table_exists "$tbl"; then
      val="$(sqlite3 "$APP_DB" "SELECT COUNT(*) || ':' || COALESCE(MAX($col), '') FROM $tbl")" || return 1
    else
      val="absent"
    fi
    fp="$fp;$tbl=$val"
  done
  printf '%s' "$fp"
}

pg_source_fingerprint() {
  fp=""
  for spec in "pull_requests:updated_at" "review_audit:created_at" "review_targets:updated_at" "ai_usage_events:created_at"; do
    tbl="${spec%%:*}"
    col="${spec#*:}"
    if pg_table_exists "$tbl"; then
      val="$(pg_scalar "SELECT COUNT(*) || ':' || COALESCE(MAX($col)::text, '') FROM $tbl")" || return 1
    else
      val="absent"
    fi
    fp="$fp;$tbl=$val"
  done
  printf '%s' "$fp"
}

# Persist the fingerprint that was actually just exported, so the NEXT run's fast-path check above compares
# against real state. Written atomically (temp file + mv) and only when a fingerprint was actually computed --
# never persists an empty/unknown value, which would otherwise let two unrelated "couldn't compute" runs
# falsely compare equal.
persist_fingerprint() {
  [ -n "$CURRENT_FINGERPRINT" ] || return 0
  printf '%s' "$CURRENT_FINGERPRINT" >"${FINGERPRINT_FILE}.tmp"
  mv "${FINGERPRINT_FILE}.tmp" "$FINGERPRINT_FILE"
}

mkdir -p "$OUT_DIR"

CURRENT_FINGERPRINT=""
if pg_enabled; then
  if command -v psql >/dev/null 2>&1; then
    pg_export_connection_env
    CURRENT_FINGERPRINT="$(pg_source_fingerprint)" || CURRENT_FINGERPRINT=""
  fi
else
  CURRENT_FINGERPRINT="$(sqlite_source_fingerprint)" || CURRENT_FINGERPRINT=""
fi

if [ -n "$CURRENT_FINGERPRINT" ] && [ -s "$OUT_DB" ] && [ -s "$FINGERPRINT_FILE" ] && [ "$(cat "$FINGERPRINT_FILE")" = "$CURRENT_FINGERPRINT" ]; then
  echo "reporting export skipped: source unchanged since last export"
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
  provider TEXT,
  effort TEXT,
  status TEXT NOT NULL,
  estimated_neurons INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  detail TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX ai_usage_events_feature_created_idx ON ai_usage_events(feature, created_at);
CREATE INDEX ai_usage_events_model_created_idx ON ai_usage_events(model, created_at);
CREATE INDEX ai_usage_events_provider_created_idx ON ai_usage_events(provider, created_at);
SQL

if pg_enabled; then
  if ! command -v psql >/dev/null 2>&1; then
    rm -f "$TMP_DB" "$TMP_DB-wal" "$TMP_DB-shm"
    echo "reporting export failed: DATABASE_URL is Postgres but psql is not installed" >&2
    exit 1
  fi
  pg_export_connection_env

  if ! pg_table_exists "pull_requests" &&
     ! pg_table_exists "advisories" &&
     ! pg_table_exists "review_targets" &&
     ! pg_table_exists "ai_usage_events" &&
     ! pg_table_exists "review_audit"; then
    if [ -s "$OUT_DB" ]; then
      rm -f "$TMP_DB" "$TMP_DB-wal" "$TMP_DB-shm"
      echo "reporting export skipped: no reporting source tables in Postgres; preserving last good $OUT_DB" >&2
      exit 1
    fi
  fi

  if pg_table_exists "pull_requests" && pg_table_exists "review_audit"; then
    PR_CSV="$(csv_temp_file "pull-requests")"
    pg_copy_csv "
WITH latest_gate_decisions AS (
  SELECT
    target_id,
    decision,
    created_at,
    ROW_NUMBER() OVER (
      PARTITION BY target_id
      ORDER BY created_at DESC, id DESC
    ) AS rn
  FROM review_audit
  WHERE event_type = 'gate_decision' AND source = 'gittensory-native'
),
current_pull_requests AS (
  SELECT
    p.repo_full_name AS repo,
    p.number AS number,
    p.author_login AS submitter,
    CASE
      WHEN lower(p.state) = 'closed' AND p.merged_at IS NOT NULL THEN 'merged'
      WHEN lower(p.state) = 'closed' THEN 'closed'
      WHEN g.decision = 'hold' THEN 'manual'
      WHEN g.decision = 'close' THEN 'manual'
      WHEN g.decision = 'merge' THEN 'commented'
      ELSE 'manual'
    END AS status,
    -- The terminal PR outcome (state/merged_at) is the source of truth and takes precedence, exactly like
    -- status above. For a still-open PR, the live gate's own last recorded decision is the real signal:
    -- review_audit (source='gittensory-native', written by recordNativeGateDecision) is the ONLY writer of
    -- gate_decision rows and is ALWAYS ON for a self-host instance. The older advisories table never carried
    -- this signal at all -- it only ever holds a PRE-gate rules-severity summary (buildPullRequestAdvisory),
    -- which is unrelated to the gate's own merge/close/hold decision and reads neutral/action_required for
    -- essentially every PR, which is why a still-open PR's verdict was an eternal 'manual' placeholder
    -- regardless of the gate's actual decision (#3511 follow-up).
    CASE
      WHEN lower(p.state) = 'closed' AND p.merged_at IS NOT NULL THEN 'merge'
      WHEN lower(p.state) = 'closed' THEN 'close'
      WHEN g.decision = 'merge' THEN 'merge'
      WHEN g.decision = 'close' THEN 'close'
      WHEN g.decision = 'hold' THEN 'manual'
      ELSE NULL
    END AS verdict,
    p.title AS title,
    p.created_at AS created_at,
    CASE
      WHEN g.created_at IS NOT NULL AND g.created_at > p.updated_at THEN g.created_at
      ELSE p.updated_at
    END AS updated_at
  FROM pull_requests p
  LEFT JOIN latest_gate_decisions g
    ON g.target_id = p.repo_full_name || '#' || p.number
   AND g.rn = 1
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
FROM current_pull_requests
" "$PR_CSV"
    sqlite_import_csv "$PR_CSV" "review_targets"
  fi

  if pg_table_exists "review_targets"; then
    LEGACY_CSV="$(csv_temp_file "legacy-review-targets")"
    if pg_table_exists "pull_requests"; then
      LEGACY_FILTER="AND NOT EXISTS (SELECT 1 FROM pull_requests p WHERE p.repo_full_name = t.repo AND p.number = t.number)"
    else
      LEGACY_FILTER=""
    fi
    pg_copy_csv "
SELECT
  t.repo,
  t.number,
  t.submitter,
  t.status,
  t.verdict,
  t.title,
  t.created_at,
  t.updated_at
FROM review_targets t
WHERE t.kind = 'pull_request'
  $LEGACY_FILTER
" "$LEGACY_CSV"
    sqlite_import_csv "$LEGACY_CSV" "review_targets"
  fi

  if pg_table_exists "ai_usage_events"; then
    AI_CSV="$(csv_temp_file "ai-usage-events")"
    if pg_column_exists "ai_usage_events" "estimated_neurons"; then
      ESTIMATED_NEURONS_EXPR="COALESCE(estimated_neurons, 0)"
    else
      ESTIMATED_NEURONS_EXPR="0"
    fi
    if pg_column_exists "ai_usage_events" "provider"; then PROVIDER_EXPR="provider"; else PROVIDER_EXPR="NULL"; fi
    if pg_column_exists "ai_usage_events" "effort"; then EFFORT_EXPR="effort"; else EFFORT_EXPR="NULL"; fi
    if pg_column_exists "ai_usage_events" "input_tokens"; then INPUT_TOKENS_EXPR="COALESCE(input_tokens, 0)"; else INPUT_TOKENS_EXPR="0"; fi
    if pg_column_exists "ai_usage_events" "output_tokens"; then OUTPUT_TOKENS_EXPR="COALESCE(output_tokens, 0)"; else OUTPUT_TOKENS_EXPR="0"; fi
    if pg_column_exists "ai_usage_events" "total_tokens"; then TOTAL_TOKENS_EXPR="COALESCE(total_tokens, 0)"; else TOTAL_TOKENS_EXPR="0"; fi
    if pg_column_exists "ai_usage_events" "cost_usd"; then COST_USD_EXPR="COALESCE(cost_usd, 0)"; else COST_USD_EXPR="0"; fi
    pg_copy_csv "
SELECT
  feature,
  model,
  $PROVIDER_EXPR AS provider,
  $EFFORT_EXPR AS effort,
  status,
  $ESTIMATED_NEURONS_EXPR AS estimated_neurons,
  $INPUT_TOKENS_EXPR AS input_tokens,
  $OUTPUT_TOKENS_EXPR AS output_tokens,
  $TOTAL_TOKENS_EXPR AS total_tokens,
  $COST_USD_EXPR AS cost_usd,
  detail,
  json_build_object(
    'repoFullName', metadata_json::jsonb ->> 'repoFullName',
    'pullNumber', metadata_json::jsonb ->> 'pullNumber'
  )::text AS metadata_json,
  created_at
FROM ai_usage_events
" "$AI_CSV"
    sqlite_import_csv "$AI_CSV" "ai_usage_events"
  fi

  sqlite3 "$TMP_DB" "PRAGMA quick_check;" | grep -qx "ok"
  mv "$TMP_DB" "$OUT_DB"
  rm -f "$TMP_DB-wal" "$TMP_DB-shm"
  persist_fingerprint

  echo "reporting export complete: $OUT_DB"
  exit 0
fi

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
   ! source_table_exists "ai_usage_events" &&
   ! source_table_exists "review_audit"; then
  if [ -s "$OUT_DB" ]; then
    rm -f "$TMP_DB" "$TMP_DB-wal" "$TMP_DB-shm"
    echo "reporting export skipped: no reporting source tables in $APP_DB; preserving last good $OUT_DB" >&2
    exit 1
  fi
fi

if source_table_exists "pull_requests" && source_table_exists "review_audit"; then
  sqlite3 -cmd ".timeout 5000" "$APP_DB" "
ATTACH '$TMP_DB_SQL' AS report;
WITH latest_gate_decisions AS (
  SELECT
    target_id,
    decision,
    created_at,
    ROW_NUMBER() OVER (
      PARTITION BY target_id
      ORDER BY created_at DESC, rowid DESC
    ) AS rn
  FROM main.review_audit
  WHERE event_type = 'gate_decision' AND source = 'gittensory-native'
),
current_pull_requests AS (
  SELECT
    p.repo_full_name AS repo,
    p.number AS number,
    p.author_login AS submitter,
    CASE
      WHEN lower(p.state) = 'closed' AND p.merged_at IS NOT NULL THEN 'merged'
      WHEN lower(p.state) = 'closed' THEN 'closed'
      WHEN g.decision = 'hold' THEN 'manual'
      WHEN g.decision = 'close' THEN 'manual'
      WHEN g.decision = 'merge' THEN 'commented'
      ELSE 'manual'
    END AS status,
    -- Mirrors status's precedence above (see the matching comment in the Postgres-source block): the terminal
    -- PR outcome wins, and a still-open PR's verdict comes from review_audit's live gate_decision rows, not the
    -- (pre-gate, always neutral/action_required) advisories table (#3511 follow-up).
    CASE
      WHEN lower(p.state) = 'closed' AND p.merged_at IS NOT NULL THEN 'merge'
      WHEN lower(p.state) = 'closed' THEN 'close'
      WHEN g.decision = 'merge' THEN 'merge'
      WHEN g.decision = 'close' THEN 'close'
      WHEN g.decision = 'hold' THEN 'manual'
      ELSE NULL
    END AS verdict,
    p.title AS title,
    p.created_at AS created_at,
    CASE
      WHEN g.created_at IS NOT NULL AND g.created_at > p.updated_at THEN g.created_at
      ELSE p.updated_at
    END AS updated_at
  FROM main.pull_requests p
  LEFT JOIN latest_gate_decisions g
    ON g.target_id = p.repo_full_name || '#' || p.number
   AND g.rn = 1
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
  PROVIDER_EXPR=NULL
  if source_column_exists "ai_usage_events" "provider"; then PROVIDER_EXPR="provider"; fi
  EFFORT_EXPR=NULL
  if source_column_exists "ai_usage_events" "effort"; then EFFORT_EXPR="effort"; fi
  INPUT_TOKENS_EXPR=0
  if source_column_exists "ai_usage_events" "input_tokens"; then INPUT_TOKENS_EXPR="input_tokens"; fi
  OUTPUT_TOKENS_EXPR=0
  if source_column_exists "ai_usage_events" "output_tokens"; then OUTPUT_TOKENS_EXPR="output_tokens"; fi
  TOTAL_TOKENS_EXPR=0
  if source_column_exists "ai_usage_events" "total_tokens"; then TOTAL_TOKENS_EXPR="total_tokens"; fi
  COST_USD_EXPR=0
  if source_column_exists "ai_usage_events" "cost_usd"; then COST_USD_EXPR="cost_usd"; fi

  sqlite3 -cmd ".timeout 5000" "$APP_DB" "
ATTACH '$TMP_DB_SQL' AS report;
INSERT INTO report.ai_usage_events (
  feature,
  model,
  provider,
  effort,
  status,
  estimated_neurons,
  input_tokens,
  output_tokens,
  total_tokens,
  cost_usd,
  detail,
  metadata_json,
  created_at
)
SELECT
  feature,
  model,
  $PROVIDER_EXPR,
  $EFFORT_EXPR,
  status,
  COALESCE($ESTIMATED_NEURONS_EXPR, 0),
  COALESCE($INPUT_TOKENS_EXPR, 0),
  COALESCE($OUTPUT_TOKENS_EXPR, 0),
  COALESCE($TOTAL_TOKENS_EXPR, 0),
  COALESCE($COST_USD_EXPR, 0),
  detail,
  json_object(
    'repoFullName', json_extract(metadata_json, '$.repoFullName'),
    'pullNumber', json_extract(metadata_json, '$.pullNumber')
  ) AS metadata_json,
  created_at
FROM main.ai_usage_events;
DETACH report;
"
fi

sqlite3 "$TMP_DB" "PRAGMA quick_check;" | grep -qx "ok"
mv "$TMP_DB" "$OUT_DB"
rm -f "$TMP_DB-wal" "$TMP_DB-shm"
persist_fingerprint

echo "reporting export complete: $OUT_DB"
