# shellcheck shell=sh
# Shared Postgres-URL credential helpers for backup.sh and verify-backup.sh (#2910). Sourced, not executed:
# no shebang side effects, functions only. Lives as a SIBLING file (not a lib/ subdirectory) because both
# callers are bind-mounted individually at container root (/backup.sh, /verify-backup.sh) with no shared
# /lib directory — `. "$(dirname "$0")/selfhost-pg-url.sh"` resolves correctly either way: to this file's
# path in the repo checkout when run directly (tests), or to /selfhost-pg-url.sh in the backup container
# (see docker-compose.yml's matching bind-mount for this file).
#
# Deliberately does NOT include prepare_pg_env()/pg_connect_arg() — despite sharing this same URI-parsing
# algorithm, backup.sh's and verify-backup.sh's versions differ in their PGPASSFILE lifecycle in ways that
# are not safe to collapse into one function: backup.sh's prepare_pg_env() reads the URL from a single
# global ($PG_DB) and runs once per script invocation, while verify-backup.sh's pg_connect_arg() takes the
# URL as an argument, `unset PGPASSFILE` at the top of every call (a reentrancy guard against a stale
# PGPASSFILE from a PREVIOUS call for a different URL leaking into this one), and tracks every passfile it
# creates in a list ($PG_PASSFILES) for its cleanup trap to sweep, since it may run several times per
# invocation (scratch/live/scratch/scratch in the scratch-restore flow) — backup.sh only ever creates one.
# Forcing these into a single shared function risks losing that reentrancy guard, which would leak a
# password across connections in verify-backup.sh's multi-URL flow.

# Percent-decodes a URI userinfo component (RFC 3986). Deliberately does NOT treat '+' as a space -- that
# convention is specific to application/x-www-form-urlencoded query values, not URI userinfo, where '+' is
# an ordinary sub-delims character allowed unencoded; the only callers decode a password extracted from the
# userinfo section or a query-string value, and a literal '+' there must stay a '+', not become a space.
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
