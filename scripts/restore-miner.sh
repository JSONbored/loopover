#!/bin/sh
# loopover-miner local-state restore (#4872): the read side of scripts/backup-miner.sh. STOP the miner (and
# any loop/systemd/docker service) before running this -- it overwrites the live state directory and does not
# detect a running process itself, the same "stop first" precondition operations-runbook.md's "ledger
# corrupted" scenario already documents for manual recovery.
#
# Validates EVERY store file in the chosen backup (via PRAGMA integrity_check) BEFORE copying anything into
# place: a half-good backup must never produce a half-restored, mismatched-vintage state directory. Removes
# any leftover -wal/-shm sidecar files from the LIVE directory after restoring each store -- those hold
# in-flight, not-yet-checkpointed writes from BEFORE the restore, and leaving them in place would let SQLite
# silently replay stale pre-restore writes back on top of the freshly restored file on next open.
#
# Usage:
#   sh scripts/restore-miner.sh --yes                        # restores the newest backup
#   sh scripts/restore-miner.sh --yes /path/to/backups/<ts>   # restores a specific backup
set -eu

STATE_DIR="${LOOPOVER_MINER_CONFIG_DIR:-$HOME/.config/loopover-miner}"
BACKUP_DIR="${LOOPOVER_MINER_BACKUP_DIR:-$STATE_DIR/backups}"

usage() {
  cat <<USAGE >&2
Usage: $0 --yes [BACKUP_DIR]

Restores loopover-miner local state from a backup produced by backup-miner.sh.

  BACKUP_DIR   A specific timestamped backup directory. Defaults to the newest one
               under \$LOOPOVER_MINER_BACKUP_DIR ($BACKUP_DIR).
  --yes        Required. This OVERWRITES the live state directory ($STATE_DIR).

STOP the miner (and any loop/systemd/docker service using this state dir) first --
this script does not check whether one is still running.
USAGE
}

CONFIRMED=0
SOURCE=""
for arg in "$@"; do
  case "$arg" in
    --yes) CONFIRMED=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) SOURCE=$arg ;;
  esac
done

if [ "$CONFIRMED" != 1 ]; then
  usage
  echo "[restore-miner] refusing to restore without --yes (this overwrites live state)" >&2
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "[restore-miner] sqlite3 not found; cannot verify backup integrity before restoring" >&2
  exit 1
fi

if [ -z "$SOURCE" ]; then
  SOURCE=$(ls -1dt "$BACKUP_DIR"/*/ 2>/dev/null | head -1 || true)
  if [ -z "$SOURCE" ]; then
    echo "[restore-miner] no backups found under $BACKUP_DIR" >&2
    exit 1
  fi
fi
SOURCE=${SOURCE%/}

if [ ! -d "$SOURCE" ]; then
  echo "[restore-miner] backup directory not found: $SOURCE" >&2
  exit 1
fi

FOUND=0
for db in "$SOURCE"/*.sqlite3; do
  [ -e "$db" ] || continue
  FOUND=1
  result=$(sqlite3 "$db" 'PRAGMA integrity_check;' 2>/dev/null | head -1 || true)
  if [ "$result" != "ok" ]; then
    echo "[restore-miner] ERROR: $(basename "$db") failed integrity check (${result:-no output}); aborting, nothing was restored" >&2
    exit 1
  fi
done
if [ "$FOUND" -eq 0 ]; then
  echo "[restore-miner] no *.sqlite3 files found in $SOURCE" >&2
  exit 1
fi

echo "[restore-miner] restoring from $SOURCE into $STATE_DIR"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
for db in "$SOURCE"/*.sqlite3; do
  [ -e "$db" ] || continue
  name=$(basename "$db")
  cp "$db" "$STATE_DIR/$name"
  chmod 600 "$STATE_DIR/$name"
  rm -f "$STATE_DIR/$name-wal" "$STATE_DIR/$name-shm"
  echo "[restore-miner] restored $name"
done

echo "[restore-miner] complete. Run 'loopover-miner doctor --json' to verify."
