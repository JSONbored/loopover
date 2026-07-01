#!/bin/sh
# Self-host backup verification: check the newest backup produced by backup.sh WITHOUT touching the live
# database. Postgres `.dump` archives are validated with `pg_restore --list` (a readable custom-format dump
# whose table of contents is non-empty); SQLite `.sqlite.gz` backups are gzip- and integrity-checked in a
# temp copy. An OPT-IN scratch restore (VERIFY_RESTORE_SCRATCH=1 + a dedicated scratch DB URL) additionally
# restores the Postgres dump into a throwaway database and runs a sanity query — it refuses to touch the live
# database. Run on demand (newest backup, or a specific file):
#   docker compose --profile backup run --rm backup sh /verify-backup.sh
#   docker compose --profile backup run --rm backup sh /verify-backup.sh /backups/postgres/gittensory-<ts>.dump
set -eu

OUT=${BACKUP_OUT_DIR:-/backups}
PG_DB="${GITTENSORY_BACKUP_SOURCE_DATABASE_URL:-${DATABASE_URL:-}}"
TARGET="${1:-}"

verify_postgres() {
  dump="$1"
  if [ ! -s "$dump" ]; then
    echo "[verify] missing or empty Postgres dump: $dump" >&2
    return 1
  fi
  if ! command -v pg_restore >/dev/null 2>&1; then
    echo "[verify] pg_restore not found; cannot verify Postgres backup" >&2
    return 1
  fi
  # 1) Structural validation (non-destructive): the archive must be a readable custom-format dump whose table
  #    of contents holds at least one entry. A truncated or corrupt dump fails here.
  toc="$(pg_restore --list "$dump" 2>&1)" || {
    echo "[verify] pg_restore --list failed for $dump:" >&2
    printf '%s\n' "$toc" | head -3 >&2
    return 1
  }
  entries="$(printf '%s\n' "$toc" | grep -cvE '^;|^[[:space:]]*$' || true)"
  if [ "${entries:-0}" -lt 1 ]; then
    echo "[verify] $dump has an empty table of contents" >&2
    return 1
  fi
  echo "[verify] postgres archive OK: $dump ($entries TOC entries)"

  # 2) Optional scratch restore smoke (opt-in, guarded): restore into a THROWAWAY database and sanity-check.
  #    Never runs against the live database — the scratch URL must be set explicitly and differ from the source.
  [ "${VERIFY_RESTORE_SCRATCH:-}" = "1" ] || return 0
  scratch="${GITTENSORY_VERIFY_SCRATCH_DATABASE_URL:-}"
  case "$scratch" in
    postgres://* | postgresql://*) : ;;
    *)
      echo "[verify] VERIFY_RESTORE_SCRATCH=1 needs GITTENSORY_VERIFY_SCRATCH_DATABASE_URL=postgres://… (a dedicated scratch database, never the live one)" >&2
      return 1
      ;;
  esac
  if ! command -v psql >/dev/null 2>&1; then
    echo "[verify] psql not found; cannot run the scratch restore smoke" >&2
    return 1
  fi
  # Identity check, NOT a string comparison: a differently-spelled URL (postgres:// vs postgresql://, a host
  # alias, an explicit vs default port) can still point at the SAME database, and a naive `[ "$scratch" =
  # "$PG_DB" ]` misses that — letting `pg_restore --clean` drop live objects. Ask Postgres itself for the
  # connection's actual identity instead of comparing the raw strings: `pg_control_system()`'s system_identifier
  # is a random 64-bit value fixed for the life of that specific cluster's data directory (independent of how
  # the connection was dialed — unlike a network-address fingerprint, e.g. inet_server_addr(), which can
  # legitimately differ for the SAME server across connections over different address families, such as an IPv4
  # vs IPv6 loopback — a false "these differ" that would defeat the guard). Combined with current_database(),
  # this correctly matches "same server AND same database" while still treating a different database name on
  # the same cluster as distinct (a legitimate, common scratch-DB setup). No special privilege is required:
  # PUBLIC has EXECUTE on pg_control_system() by default. Any failure to fingerprint EITHER side aborts (fail
  # closed) rather than assuming the databases differ.
  db_identity() {
    psql "$1" -X -q -t -A -v ON_ERROR_STOP=1 \
      -c "SELECT current_database() || '@' || (SELECT system_identifier FROM pg_control_system())::text" \
      2>/dev/null
  }
  scratch_identity="$(db_identity "$scratch")" || scratch_identity=""
  if [ -z "$scratch_identity" ]; then
    echo "[verify] could not connect to the scratch database to verify its identity; refusing to proceed" >&2
    return 1
  fi
  case "$PG_DB" in
    postgres://* | postgresql://*)
      live_identity="$(db_identity "$PG_DB")" || live_identity=""
      if [ -z "$live_identity" ]; then
        echo "[verify] could not connect to the live backup source to verify its identity; refusing to proceed" >&2
        return 1
      fi
      if [ "$scratch_identity" = "$live_identity" ]; then
        echo "[verify] refusing scratch restore: the scratch URL resolves to the SAME database as the live backup source ($scratch_identity)" >&2
        return 1
      fi
      ;;
  esac
  echo "[verify] restoring $dump into the scratch database…"
  if ! pg_restore --clean --if-exists --no-owner --no-privileges --dbname "$scratch" "$dump" >/dev/null 2>&1; then
    echo "[verify] scratch restore failed for $dump" >&2
    return 1
  fi
  tables="$(psql "$scratch" -X -q -t -A -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")" || {
    echo "[verify] scratch sanity query failed" >&2
    return 1
  }
  if [ "${tables:-0}" -lt 1 ]; then
    echo "[verify] scratch restore produced no tables" >&2
    return 1
  fi
  echo "[verify] scratch restore OK: $tables tables restored"
}

verify_sqlite() {
  gz="$1"
  if [ ! -s "$gz" ]; then
    echo "[verify] missing or empty SQLite backup: $gz" >&2
    return 1
  fi
  if ! gzip -t "$gz" 2>/dev/null; then
    echo "[verify] gzip integrity check failed for $gz" >&2
    return 1
  fi
  if ! command -v sqlite3 >/dev/null 2>&1; then
    echo "[verify] sqlite3 not found; verified gzip integrity only for $gz"
    return 0
  fi
  tmp="$(mktemp)"
  if ! gzip -dc "$gz" >"$tmp" 2>/dev/null; then
    rm -f "$tmp"
    echo "[verify] failed to decompress $gz" >&2
    return 1
  fi
  result="$(sqlite3 "$tmp" 'PRAGMA integrity_check;' 2>/dev/null | head -1 || true)"
  rm -f "$tmp"
  if [ "$result" != "ok" ]; then
    echo "[verify] sqlite integrity_check failed for $gz (${result:-no output})" >&2
    return 1
  fi
  echo "[verify] sqlite backup OK: $gz"
}

# An explicit file argument wins; otherwise verify the newest backup for the active database type.
if [ -n "$TARGET" ]; then
  case "$TARGET" in
    *.dump) verify_postgres "$TARGET" ;;
    *.sqlite.gz) verify_sqlite "$TARGET" ;;
    *)
      echo "[verify] unrecognized backup file: $TARGET (expected *.dump or *.sqlite.gz)" >&2
      exit 1
      ;;
  esac
  echo "[verify] complete"
  exit 0
fi

case "$PG_DB" in
  postgres://* | postgresql://*)
    dump="$(ls -1t "$OUT"/postgres/*.dump 2>/dev/null | head -1 || true)"
    if [ -z "$dump" ]; then
      echo "[verify] no Postgres .dump found in $OUT/postgres" >&2
      exit 1
    fi
    verify_postgres "$dump"
    ;;
  *)
    gz="$(ls -1t "$OUT"/sqlite/*.sqlite.gz 2>/dev/null | head -1 || true)"
    if [ -z "$gz" ]; then
      echo "[verify] no SQLite backup found in $OUT/sqlite" >&2
      exit 1
    fi
    verify_sqlite "$gz"
    ;;
esac

echo "[verify] complete"
