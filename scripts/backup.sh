#!/bin/sh
# Self-host backup: an online SQLite backup (safe while the app is writing) + a Qdrant snapshot, with retention.
# Run by the `backup` compose service (--profile backup) on a loop, or on demand:
#   docker compose run --rm backup sh /backup.sh
# Backups land in the `gittensory-backups` volume at /backups/{sqlite,qdrant}.
set -eu

TS=$(date -u +%Y%m%dT%H%M%SZ)
RETAIN=${BACKUP_RETAIN:-7}
DB=${DATABASE_PATH:-/data/gittensory.sqlite}
OUT=/backups
mkdir -p "$OUT/sqlite" "$OUT/qdrant"

# 1) SQLite — the Online Backup API yields a consistent copy even while the app writes (WAL-safe).
if [ -f "$DB" ]; then
  sqlite3 "$DB" ".backup '$OUT/sqlite/gittensory-$TS.sqlite'"
  gzip -f "$OUT/sqlite/gittensory-$TS.sqlite"
  echo "[backup] sqlite -> $OUT/sqlite/gittensory-$TS.sqlite.gz"
else
  echo "[backup] sqlite db not found at $DB (skipping)"
fi

# 2) Qdrant — trigger a full storage snapshot, download it, then delete it from Qdrant's own storage so snapshots
#    don't accumulate inside the vector store. Best-effort: a Qdrant outage must not fail the SQLite backup.
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
for d in sqlite qdrant; do
  ls -1t "$OUT/$d" 2>/dev/null | tail -n +"$((RETAIN + 1))" | while IFS= read -r f; do
    rm -f "$OUT/$d/$f"
    echo "[backup] pruned old backup $d/$f"
  done
done

echo "[backup] complete ($TS); retaining newest $RETAIN per target"
