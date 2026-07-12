#!/bin/sh
# Expose retained backup freshness from the loopover-backups volume in Prometheus text format.
# Intended for the backup-exporter compose sidecar; it never touches the live database.
set -eu

ROOT=${BACKUP_ROOT:-/backups}
OUT=${BACKUP_METRICS_DIR:-/metrics}
FILE=${BACKUP_METRICS_FILE:-$OUT/metrics}
INTERVAL=${BACKUP_METRICS_INTERVAL_SECONDS:-30}
PORT=${BACKUP_METRICS_PORT:-9101}

case "$INTERVAL" in
  ''|*[!0-9]*) INTERVAL=30 ;;
esac

latest_timestamp() {
  dir=$1
  if [ ! -d "$dir" ]; then
    echo 0
    return
  fi
  newest=$(
    find "$dir" -type f ! -name '*.tmp' -exec sh -c '
      for path do
        stat -c "%Y" "$path" 2>/dev/null || stat -f "%m" "$path" 2>/dev/null || true
      done
    ' sh {} + 2>/dev/null | sort -nr | head -1 || true
  )
  case "$newest" in
    ''|*[!0-9]*) echo 0 ;;
    *) echo "$newest" ;;
  esac
}

file_count() {
  dir=$1
  if [ ! -d "$dir" ]; then
    echo 0
    return
  fi
  find "$dir" -type f ! -name '*.tmp' 2>/dev/null | wc -l | tr -d ' '
}

write_metrics() {
  mkdir -p "$OUT"
  tmp="$FILE.tmp"
  {
    echo "# HELP gittensory_backup_latest_timestamp_seconds Unix timestamp of the newest retained self-host backup file by target."
    echo "# TYPE gittensory_backup_latest_timestamp_seconds gauge"
    for target in postgres sqlite qdrant; do
      echo "gittensory_backup_latest_timestamp_seconds{target=\"$target\"} $(latest_timestamp "$ROOT/$target")"
    done
    echo "# HELP gittensory_backup_files Retained self-host backup files by target."
    echo "# TYPE gittensory_backup_files gauge"
    for target in postgres sqlite qdrant; do
      echo "gittensory_backup_files{target=\"$target\"} $(file_count "$ROOT/$target")"
    done
  } > "$tmp"
  mv "$tmp" "$FILE"
}

if [ "${BACKUP_METRICS_ONCE:-}" = "1" ]; then
  write_metrics
  exit 0
fi

write_metrics
httpd -f -p "$PORT" -h "$OUT" &
server=$!
trap 'kill "$server" 2>/dev/null || true' INT TERM EXIT

while true; do
  write_metrics
  sleep "$INTERVAL"
done
