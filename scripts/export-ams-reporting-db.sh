#!/bin/sh
set -eu

# AMS (gittensory-miner) redacted reporting export (#5184 follow-up; closes the gap PR #5471 flagged: Grafana must
# never mount the miner's live GITTENSORY_MINER_CONFIG_DIR ledgers directly -- attempt_log_events.reason and
# .payload_json are free-form and can carry arbitrary internal detail). Mirrors export-grafana-reporting-db.sh's
# shape (incremental fingerprint fast-path, atomic tmp-then-move, fail-open on a missing/unreadable source) but is
# deliberately a SEPARATE script: the two AMS ledgers are SQLite-only (the miner has no Postgres mode) and each
# source table is INSERT-only (attempt_log_events' own header states this invariant; prediction-ledger.js's is the
# same), so neither needs the mutable-table full-content-hash path the main script carries for pull_requests/
# review_targets.
#
# Exports TWO independent ledgers in one run -- a missing/corrupt attempt log must never block the prediction
# ledger's export or vice versa, so each runs its own fail-open pass.
#
# Bump whenever this script's own mapping/redaction logic changes (not just when a source table gains a column):
# the incremental fast-path below only fingerprints SOURCE ROW COUNT + latest timestamp, so a logic-only edit
# would otherwise serve the previous run's output forever.
SCRIPT_VERSION="${GITTENSORY_AMS_REPORTING_SCRIPT_VERSION:-1}"

OUT_DIR="${GITTENSORY_REPORTING_DIR:-/reporting}"
ATTEMPT_LOG_SOURCE_DB="${GITTENSORY_AMS_ATTEMPT_LOG_SOURCE_DB:-/ams-ledgers/attempt-log.sqlite3}"
ATTEMPT_LOG_OUT_DB="${GITTENSORY_AMS_ATTEMPT_LOG_REPORTING_DB:-$OUT_DIR/ams-attempt-log.sqlite}"
PREDICTION_LEDGER_SOURCE_DB="${GITTENSORY_AMS_PREDICTION_LEDGER_SOURCE_DB:-/ams-ledgers/prediction-ledger.sqlite3}"
PREDICTION_LEDGER_OUT_DB="${GITTENSORY_AMS_PREDICTION_LEDGER_REPORTING_DB:-$OUT_DIR/ams-prediction-ledger.sqlite}"

mkdir -p "$OUT_DIR"

hash_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  else
    cat >/dev/null
    return 1
  fi
}

source_table_exists() {
  db="$1"
  tbl="$2"
  sqlite3 "$db" "SELECT 1 FROM sqlite_master WHERE type='table' AND name='$tbl' LIMIT 1" | grep -q 1
}

# Insert-only source: a row COUNT + MAX(created_at) aggregate can never miss a real change (nothing UPDATEs a row
# in place, matching attempt_log_events'/predictions' own append-only invariants), and stays O(1)-ish instead of
# an O(row-count) full-table hash as each ledger grows without bound.
append_only_fingerprint() {
  db="$1"
  tbl="$2"
  time_col="$3"
  sqlite3 "$db" "SELECT COUNT(*) || ':' || COALESCE(MAX($time_col), '') FROM $tbl"
}

reporting_db_ok() {
  db="$1"
  [ -s "$db" ] || return 1
  sqlite3 "$db" "PRAGMA quick_check;" 2>/dev/null | grep -qx "ok"
}

persist_fingerprint() {
  fingerprint="$1"
  file="$2"
  [ -n "$fingerprint" ] || return 0
  printf '%s' "$fingerprint" >"${file}.tmp"
  mv "${file}.tmp" "$file"
}

# One ledger's full fail-open/fingerprint/atomic-export pass. Never propagates a failure to the caller (this
# script exports two independent ledgers per run and a bad one must not block the other) -- always returns 0,
# logging to stderr on any skip/failure path.
#
# $1 label (for log lines)   $2 source db   $3 out db   $4 source table   $5 time column
# $6 redacted CREATE TABLE DDL   $7 redacted SELECT column list (source-table column names, in DDL column order)
export_ledger() {
  label="$1"
  src="$2"
  out="$3"
  tbl="$4"
  time_col="$5"
  ddl="$6"
  select_cols="$7"

  tmp="${out}.tmp"
  fp_file="${out}.fingerprint"
  rm -f "$tmp" "$tmp-wal" "$tmp-shm"

  if [ ! -s "$src" ]; then
    if [ -s "$out" ]; then
      echo "[ams-reporting:$label] export skipped: source missing at $src; preserving last-good $out" >&2
    else
      sqlite3 "$tmp" "$ddl"
      sqlite3 "$tmp" "PRAGMA quick_check;" | grep -qx "ok"
      mv "$tmp" "$out"
      rm -f "$tmp-wal" "$tmp-shm"
      echo "[ams-reporting:$label] export empty: source missing at $src" >&2
    fi
    return 0
  fi

  if ! source_table_exists "$src" "$tbl"; then
    if [ -s "$out" ]; then
      echo "[ams-reporting:$label] export skipped: table $tbl absent in $src; preserving last-good $out" >&2
    else
      sqlite3 "$tmp" "$ddl"
      sqlite3 "$tmp" "PRAGMA quick_check;" | grep -qx "ok"
      mv "$tmp" "$out"
      rm -f "$tmp-wal" "$tmp-shm"
      echo "[ams-reporting:$label] export empty: table $tbl absent in $src" >&2
    fi
    return 0
  fi

  fingerprint="script=$SCRIPT_VERSION;$(append_only_fingerprint "$src" "$tbl" "$time_col")"
  if reporting_db_ok "$out" && [ -s "$fp_file" ] && [ "$(cat "$fp_file")" = "$fingerprint" ]; then
    echo "[ams-reporting:$label] export skipped: source unchanged since last export"
    return 0
  fi

  sqlite3 "$tmp" "$ddl"
  out_sql="$(printf "%s" "$tmp" | sed "s/'/''/g")"
  sqlite3 -cmd ".timeout 5000" "$src" "
ATTACH '$out_sql' AS report;
INSERT INTO report.$tbl SELECT $select_cols FROM main.$tbl;
DETACH report;
"
  if ! sqlite3 "$tmp" "PRAGMA quick_check;" | grep -qx "ok"; then
    rm -f "$tmp" "$tmp-wal" "$tmp-shm"
    echo "[ams-reporting:$label] export failed: rebuilt database failed quick_check, preserving last-good $out" >&2
    return 0
  fi
  mv "$tmp" "$out"
  rm -f "$tmp-wal" "$tmp-shm"
  persist_fingerprint "$fingerprint" "$fp_file"
  echo "[ams-reporting:$label] export complete: $out"
}

# attempt_log_events: DROP `reason` and `payload_json` -- both free-form (payload_json in particular can nest
# arbitrary per-event-type detail, up to and including file paths/diffs/prompt fragments). Every other column is
# a bounded-vocabulary identifier/enum/timestamp, safe for a shared reporting export.
export_ledger \
  "attempt-log" \
  "$ATTEMPT_LOG_SOURCE_DB" \
  "$ATTEMPT_LOG_OUT_DB" \
  "attempt_log_events" \
  "created_at" \
  "CREATE TABLE attempt_log_events (
    id INTEGER PRIMARY KEY,
    seq INTEGER NOT NULL,
    attempt_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    action_class TEXT NOT NULL,
    mode TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX attempt_log_events_attempt_idx ON attempt_log_events(attempt_id, seq);
  CREATE INDEX attempt_log_events_created_idx ON attempt_log_events(created_at);" \
  "id, seq, attempt_id, event_type, action_class, mode, created_at"

# predictions: kept as-is. Unlike attempt_log_events, every column here is already a bounded identifier, enum,
# score, or a fixed-vocabulary code array (blocker_codes_json/warning_codes_json -- engine-defined codes, never
# free text) -- exactly the kind of structured signal a "prediction ledger" dashboard needs to be useful at all.
export_ledger \
  "prediction-ledger" \
  "$PREDICTION_LEDGER_SOURCE_DB" \
  "$PREDICTION_LEDGER_OUT_DB" \
  "predictions" \
  "ts" \
  "CREATE TABLE predictions (
    id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    repo_full_name TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    head_sha TEXT,
    conclusion TEXT NOT NULL,
    pack TEXT NOT NULL,
    readiness_score REAL,
    blocker_codes_json TEXT NOT NULL,
    warning_codes_json TEXT NOT NULL,
    engine_version TEXT NOT NULL
  );
  CREATE INDEX predictions_repo_idx ON predictions(repo_full_name, id);
  CREATE INDEX predictions_ts_idx ON predictions(ts);" \
  "id, ts, repo_full_name, target_id, head_sha, conclusion, pack, readiness_score, blocker_codes_json, warning_codes_json, engine_version"
