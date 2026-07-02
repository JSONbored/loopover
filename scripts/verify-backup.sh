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
PG_PASSFILES=""
cleanup() {
  for pg_pf in $PG_PASSFILES; do
    rm -f "$pg_pf"
  done
}
trap cleanup EXIT HUP INT TERM

# Percent-decodes a URI userinfo component (RFC 3986). Deliberately does NOT treat '+' as a space -- that
# convention is specific to application/x-www-form-urlencoded query values, not URI userinfo, where '+' is
# an ordinary sub-delims character allowed unencoded; the only caller of this function decodes a password
# extracted from the userinfo section, and a literal '+' there must stay a '+', not become a space.
url_decode() {
  printf '%s' "$1" | awk '
    BEGIN { for (i = 0; i < 256; i++) hex[sprintf("%02X", i)] = sprintf("%c", i); }
    {
      out = "";
      for (i = 1; i <= length($0); i++) {
        c = substr($0, i, 1);
        if (c == "%" && i + 2 <= length($0)) {
          h = toupper(substr($0, i + 1, 2));
          if (h in hex) { out = out hex[h]; i += 2; } else { out = out c; }
        } else {
          out = out c;
        }
      }
      printf "%s", out;
    }'
}

pgpass_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/:/\\:/g'
}

# Strips the password from a postgres(ql):// URI -- from EITHER the userinfo (user:password@host) or a
# `password=` libpq query-string parameter (postgresql://user@host/db?password=secret is equally valid
# and equally a leak if left in place) -- and hands back everything else untouched (host, port, dbname,
# and every other query parameter), instead of re-parsing those pieces ourselves -- the same approach
# backup.sh uses, see that file for the full rationale. Userinfo detection is restricted to the authority
# component (before the first '/', '?', or '#'), never the whole remaining string, so a literal '@'/':'
# inside a query-string value (e.g. ?application_name=a:b@worker) is never mistaken for credentials.
# Unlike backup.sh, this script may need to connect to TWO different URLs in the same run (the live source
# and a scratch database), so this takes the URL as an argument and is safe to call repeatedly: it always
# unsets PGPASSFILE first, so a previous call's password can never leak into a connection for a URL that
# doesn't have one of its own. Sets $PG_SANITIZED_URL; exports PGPASSFILE (tracked in $PG_PASSFILES for
# cleanup) if the given URL had a password.
pg_connect_arg() {
  pg_rest=${1#postgres://}
  pg_rest=${pg_rest#postgresql://}

  pg_authority=${pg_rest%%/*}
  pg_before_query=${pg_rest%%\?*}
  pg_before_frag=${pg_rest%%#*}
  if [ ${#pg_before_query} -lt ${#pg_authority} ]; then pg_authority=$pg_before_query; fi
  if [ ${#pg_before_frag} -lt ${#pg_authority} ]; then pg_authority=$pg_before_frag; fi
  pg_suffix=${pg_rest#"$pg_authority"}

  pg_password_value=""
  pg_sanitized_authority=$pg_authority
  case "$pg_authority" in
    *@*)
      pg_userinfo=${pg_authority%%@*}
      pg_after_at=${pg_authority#*@}
      case "$pg_userinfo" in
        *:*)
          pg_user_part=${pg_userinfo%%:*}
          pg_password_value=$(url_decode "${pg_userinfo#*:}")
          pg_sanitized_authority="${pg_user_part}@${pg_after_at}"
          ;;
        *)
          pg_sanitized_authority="${pg_userinfo}@${pg_after_at}"
          ;;
      esac
      ;;
  esac

  pg_path=$pg_suffix
  pg_query=""
  pg_frag=""
  case "$pg_suffix" in
    *\?*)
      pg_path=${pg_suffix%%\?*}
      pg_after_q=${pg_suffix#*\?}
      case "$pg_after_q" in
        *#*)
          pg_query=${pg_after_q%%#*}
          pg_frag="#${pg_after_q#*#}"
          ;;
        *)
          pg_query=$pg_after_q
          ;;
      esac
      ;;
    *#*)
      pg_path=${pg_suffix%%#*}
      pg_frag="#${pg_suffix#*#}"
      ;;
  esac

  pg_query_wrapped="&$pg_query&"
  case "$pg_query_wrapped" in
    *"&password="*"&"*)
      pg_before_pw=${pg_query_wrapped%%&password=*}
      pg_from_pw=${pg_query_wrapped#*&password=}
      pg_password_value=$(url_decode "${pg_from_pw%%&*}")
      pg_after_pw=${pg_from_pw#*&}
      pg_query_wrapped="${pg_before_pw}&${pg_after_pw}"
      pg_query=${pg_query_wrapped#&}
      pg_query=${pg_query%&}
      ;;
  esac

  pg_suffix=$pg_path
  if [ -n "$pg_query" ]; then pg_suffix="$pg_suffix?$pg_query"; fi
  pg_suffix="$pg_suffix$pg_frag"
  PG_SANITIZED_URL="postgresql://$pg_sanitized_authority$pg_suffix"

  unset PGPASSFILE
  if [ -n "$pg_password_value" ]; then
    # pgpass is a single-line-per-entry format; pgpass_escape only handles the two characters (':' and
    # '\') that format itself treats specially. A decoded password containing a raw newline or carriage
    # return would still split the entry across lines, corrupting the field layout -- refuse outright
    # rather than silently write a malformed passfile. "$(printf '\n')" would NOT work as a case pattern
    # here -- command substitution strips ALL trailing newlines, so it evaluates to an empty string and
    # the pattern would match everything; build a variable holding exactly one newline/CR by stripping a
    # trailing marker byte instead.
    pg_nl=$(printf '\nx'); pg_nl=${pg_nl%x}
    pg_cr=$(printf '\rx'); pg_cr=${pg_cr%x}
    case "$pg_password_value" in
      *"$pg_nl"*|*"$pg_cr"*)
        echo "[verify] refusing to use a decoded Postgres password containing a newline or carriage return" >&2
        exit 1
        ;;
    esac
    # Host/port/dbname/user are wildcarded: each passfile is single-purpose, deleted at the end of this
    # run via the `cleanup` trap, so there's no value in re-deriving the exact host/port/dbname libpq will
    # resolve -- which the query string can override anyway -- just to match them precisely.
    pg_passfile=$(mktemp "${TMPDIR:-/tmp}/gittensory-pgpass.XXXXXX")
    chmod 600 "$pg_passfile"
    printf '*:*:*:*:%s\n' "$(pgpass_escape "$pg_password_value")" > "$pg_passfile"
    PG_PASSFILES="$PG_PASSFILES $pg_passfile"
    export PGPASSFILE="$pg_passfile"
  fi
}

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
    pg_connect_arg "$1"
    psql "$PG_SANITIZED_URL" -X -q -t -A -v ON_ERROR_STOP=1 \
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
  pg_connect_arg "$scratch"
  if ! pg_restore --clean --if-exists --no-owner --no-privileges --dbname "$PG_SANITIZED_URL" "$dump" >/dev/null 2>&1; then
    echo "[verify] scratch restore failed for $dump" >&2
    return 1
  fi
  pg_connect_arg "$scratch"
  tables="$(psql "$PG_SANITIZED_URL" -X -q -t -A -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")" || {
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
