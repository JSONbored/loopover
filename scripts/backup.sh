#!/bin/sh
# Self-host backup: active DB backup (Postgres dump or online SQLite backup) + a Qdrant snapshot, with retention.
# Run by the `backup` compose service (--profile backup) on a loop, or on demand:
#   docker compose --profile backup run --rm backup sh /backup.sh
# Backups land in the `gittensory-backups` volume at /backups/{postgres,sqlite,qdrant}.
set -eu

TS=$(date -u +%Y%m%dT%H%M%SZ)
RETAIN=${BACKUP_RETAIN:-7}
DB=${DATABASE_PATH:-/data/gittensory.sqlite}
PG_DB="${GITTENSORY_BACKUP_SOURCE_DATABASE_URL:-${DATABASE_URL:-}}"
OUT=${BACKUP_OUT_DIR:-/backups}
PGPASSFILE_CREATED=""
cleanup() {
  if [ -n "$PGPASSFILE_CREATED" ]; then
    rm -f "$PGPASSFILE_CREATED"
  fi
}
trap cleanup EXIT HUP INT TERM
mkdir -p "$OUT/postgres" "$OUT/sqlite" "$OUT/qdrant"

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
# and equally a leak if left in place) -- and hands pg_dump everything else untouched (host, port, dbname,
# and every other query parameter) as its connection argument, instead of re-parsing those pieces
# ourselves. libpq's own URI parser already handles every form it needs to (query-string-only host, as in
# `postgresql:///db?host=/var/run/postgresql`, IPv6 literals, multi-host strings, sslmode, etc.) -- an
# earlier version of this function extracted host/port/dbname manually and discarded the query string
# entirely, silently breaking any URL that relied on it. Sets $PG_SANITIZED_URL (the password-free URI to
# pass to pg_dump) and, if a password was present, a $PGPASSFILE_CREATED wildcard passfile (host/port/
# dbname/user are wildcarded: this file exists only to supply the ONE password for the single connection
# this script makes, and is deleted immediately after via the `cleanup` trap, so there's no scoped value
# in re-deriving the exact host/port/dbname libpq will resolve -- which the query string can override
# anyway -- just to match them precisely).
prepare_pg_env() {
  pg_rest=${PG_DB#postgres://}
  pg_rest=${pg_rest#postgresql://}

  # Userinfo (user:password@) can ONLY appear in the authority component -- everything before the first
  # '/', '?', or '#' -- never later in the URI. Find that boundary FIRST and never look for '@'/':' past
  # it, or a literal '@'/':' inside a query-string value (e.g. ?application_name=a:b@worker) gets
  # misread as credentials, corrupting an otherwise-untouched query string. POSIX parameter expansion has
  # no single "find the first of several delimiters" primitive: compute the substring before each
  # candidate delimiter and keep whichever is shortest, since the delimiter that occurs earliest produces
  # the shortest "before" substring.
  pg_authority=${pg_rest%%/*}
  pg_before_query=${pg_rest%%\?*}
  pg_before_frag=${pg_rest%%#*}
  if [ ${#pg_before_query} -lt ${#pg_authority} ]; then pg_authority=$pg_before_query; fi
  if [ ${#pg_before_frag} -lt ${#pg_authority} ]; then pg_authority=$pg_before_frag; fi
  pg_suffix=${pg_rest#"$pg_authority"}

  PGPASSWORD_VALUE=""
  pg_sanitized_authority=$pg_authority
  case "$pg_authority" in
    *@*)
      pg_userinfo=${pg_authority%%@*}
      pg_after_at=${pg_authority#*@}
      case "$pg_userinfo" in
        *:*)
          pg_user_part=${pg_userinfo%%:*}
          PGPASSWORD_VALUE=$(url_decode "${pg_userinfo#*:}")
          pg_sanitized_authority="${pg_user_part}@${pg_after_at}"
          ;;
        *)
          pg_sanitized_authority="${pg_userinfo}@${pg_after_at}"
          ;;
      esac
      ;;
  esac

  # A libpq query string can carry `password=...` as an alternative to userinfo -- split $pg_suffix into
  # its path / query / fragment components (in that order; each optional) and, if the query component has
  # a `password` key, extract and remove it, leaving every other parameter (and their order) untouched.
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
      PGPASSWORD_VALUE=$(url_decode "${pg_from_pw%%&*}")
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

  if [ -n "$PGPASSWORD_VALUE" ]; then
    # pgpass is a single-line-per-entry format; pgpass_escape only handles the two characters (':' and
    # '\') that format itself treats specially. A decoded password containing a raw newline or carriage
    # return would still split the entry across lines, corrupting the field layout -- refuse outright
    # rather than silently write a malformed passfile.
    #
    # NOTE: "$(printf '\n')" as a case pattern would NOT work here -- command substitution strips ALL
    # trailing newlines, so it evaluates to an empty string and the pattern would match everything. Build
    # a variable holding exactly one newline/CR by stripping a trailing marker byte instead.
    pg_nl=$(printf '\nx'); pg_nl=${pg_nl%x}
    pg_cr=$(printf '\rx'); pg_cr=${pg_cr%x}
    case "$PGPASSWORD_VALUE" in
      *"$pg_nl"*|*"$pg_cr"*)
        echo "[backup] refusing to write PGPASSFILE: decoded Postgres password contains a newline or carriage return" >&2
        exit 1
        ;;
    esac
    PGPASSFILE_CREATED=$(mktemp "${TMPDIR:-/tmp}/gittensory-pgpass.XXXXXX")
    chmod 600 "$PGPASSFILE_CREATED"
    printf '*:*:*:*:%s\n' "$(pgpass_escape "$PGPASSWORD_VALUE")" > "$PGPASSFILE_CREATED"
    export PGPASSFILE="$PGPASSFILE_CREATED"
  fi
}

# 1) Active app database. Prefer Postgres when DATABASE_URL is set; otherwise keep the SQLite online backup path.
case "$PG_DB" in
  postgres://*|postgresql://*)
    if ! command -v pg_dump >/dev/null 2>&1; then
      echo "[backup] pg_dump not found; cannot back up Postgres database" >&2
      exit 1
    fi
    prepare_pg_env
    pg_dump -Fc -f "$OUT/postgres/gittensory-$TS.dump" "$PG_SANITIZED_URL"
    echo "[backup] postgres -> $OUT/postgres/gittensory-$TS.dump"
    ;;
  *)
    if [ -f "$DB" ]; then
      sqlite3 "$DB" ".backup '$OUT/sqlite/gittensory-$TS.sqlite'"
      gzip -f "$OUT/sqlite/gittensory-$TS.sqlite"
      echo "[backup] sqlite -> $OUT/sqlite/gittensory-$TS.sqlite.gz"
    else
      echo "[backup] sqlite db not found at $DB (skipping)"
    fi
    ;;
esac

# 2) Qdrant — trigger a full storage snapshot, download it, then delete it from Qdrant's own storage so snapshots
#    don't accumulate inside the vector store. Best-effort: a Qdrant outage must not fail the DB backup.
if [ -n "${QDRANT_URL:-}" ]; then
  NAME=$(curl -sf -X POST "$QDRANT_URL/snapshots" 2>/dev/null | grep -o '"name":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
  if [ -n "$NAME" ]; then
    if curl -sf "$QDRANT_URL/snapshots/$NAME" -o "$OUT/qdrant/$NAME" 2>/dev/null; then
      echo "[backup] qdrant -> $OUT/qdrant/$NAME"
    fi
    curl -sf -X DELETE "$QDRANT_URL/snapshots/$NAME" >/dev/null 2>&1 || true
  else
    echo "[backup] qdrant snapshot could not be created (skipping)"
  fi
fi

# 3) Retention — keep only the newest $RETAIN in each directory.
for d in postgres sqlite qdrant; do
  ls -1t "$OUT/$d" 2>/dev/null | tail -n +"$((RETAIN + 1))" | while IFS= read -r f; do
    rm -f "$OUT/$d/$f"
    echo "[backup] pruned old backup $d/$f"
  done
done

echo "[backup] complete ($TS); retaining newest $RETAIN per target"
