#!/bin/sh
# loopover-miner local-state backup (#4872): every store is an independent SQLite file directly under
# LOOPOVER_MINER_CONFIG_DIR (packages/loopover-miner/docs/operations-runbook.md's "Local state at a
# glance") -- there is no Postgres/Qdrant involved, so this is deliberately a simpler sibling to
# scripts/backup.sh, not a reuse of it (that script's manifest/multi-target logic has nothing to compose with
# here). Backs up EVERY *.sqlite3 file currently present, discovered by glob rather than a hardcoded filename
# list -- the miner package grows new stores over time (17 as of this writing), and a hardcoded list would
# silently go stale the next time one is added, exactly the kind of drift this repo's generated-reference
# checks exist to prevent elsewhere.
#
# Uses SQLite's own online-backup command (".backup"), the same safe-even-while-live mechanism
# operations-runbook.md's "ledger corrupted" scenario already documents -- NOT a plain `cp`, which can capture
# a torn snapshot mid-write. Each backed-up file is then integrity-checked before being kept.
#
# Usage:
#   sh scripts/backup-miner.sh
#   LOOPOVER_MINER_CONFIG_DIR=/data/miner LOOPOVER_MINER_BACKUP_RETAIN=14 sh scripts/backup-miner.sh
set -eu

STATE_DIR="${LOOPOVER_MINER_CONFIG_DIR:-$HOME/.config/loopover-miner}"
OUT_DIR="${LOOPOVER_MINER_BACKUP_DIR:-$STATE_DIR/backups}"
RETAIN="${LOOPOVER_MINER_BACKUP_RETAIN:-7}"

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "[backup-miner] sqlite3 not found; cannot take a safe online backup" >&2
  exit 1
fi

if [ ! -d "$STATE_DIR" ]; then
  echo "[backup-miner] state dir not found: $STATE_DIR (nothing to back up)" >&2
  exit 1
fi

TS=$(date -u +%Y%m%dT%H%M%SZ)
DEST="$OUT_DIR/$TS"
mkdir -p "$DEST"

TOTAL=0
FAILED=0
BACKED_UP=0
for db in "$STATE_DIR"/*.sqlite3; do
  [ -e "$db" ] || continue # glob matched nothing
  TOTAL=$((TOTAL + 1))
  name=$(basename "$db")
  dest_db="$DEST/$name"
  if ! sqlite3 "$db" ".backup '$dest_db'" 2>/dev/null; then
    echo "[backup-miner] ERROR: online backup failed for $name" >&2
    FAILED=1
    continue
  fi
  result=$(sqlite3 "$dest_db" 'PRAGMA integrity_check;' 2>/dev/null | head -1 || true)
  if [ "$result" != "ok" ]; then
    echo "[backup-miner] ERROR: integrity check failed for $name (${result:-no output})" >&2
    rm -f "$dest_db"
    FAILED=1
    continue
  fi
  chmod 600 "$dest_db"
  BACKED_UP=$((BACKED_UP + 1))
  echo "[backup-miner] backed up $name"
done

# Two distinct empty-outcome cases, deliberately handled differently: the glob matching NOTHING means there
# was never anything to back up (remove the now-useless empty timestamped dir); every MATCHED file failing is
# a real backup failure (fall through to the FAILED branch below, which -- like backup.sh's own equivalent --
# keeps the directory and its error output for debugging, and skips retention pruning).
if [ "$TOTAL" -eq 0 ]; then
  echo "[backup-miner] no *.sqlite3 files found under $STATE_DIR" >&2
  rmdir "$DEST" 2>/dev/null || true
  exit 1
fi
chmod 700 "$DEST"

if [ "$FAILED" = 1 ]; then
  echo "[backup-miner] FAILED ($TS): one or more stores did not back up cleanly; see errors above" >&2
  echo "[backup-miner] skipping retention prune so no older, fully-good backup is lost" >&2
  exit 1
fi

# Retention: keep the newest $RETAIN timestamped backup directories, prune the rest. Mirrors
# scripts/backup.sh's own `ls -1t | tail -n +N+1 | while read` idiom.
# shellcheck disable=SC2012
ls -1t "$OUT_DIR" 2>/dev/null | tail -n +"$((RETAIN + 1))" | while IFS= read -r old; do
  echo "[backup-miner] pruning old backup: $old"
  rm -rf "${OUT_DIR:?}/$old"
done

echo "[backup-miner] complete ($TS); backed up $BACKED_UP store(s) to $DEST; retaining newest $RETAIN"
