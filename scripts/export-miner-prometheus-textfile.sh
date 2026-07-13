#!/bin/sh
set -eu

# Miner Prometheus textfile export (#4839): the miner CLI already emits four Prometheus text-exposition
# documents -- `gittensory-miner metrics` (prediction calibration), `queue metrics` (portfolio-queue),
# `ledger metrics` (event ledger), and `governor metrics` (rate-limit/cap-usage pressure) -- but none of them
# is a long-running HTTP server Prometheus can scrape directly; each is a one-shot CLI command. This script
# bridges the two with the standard node_exporter "textfile collector" pattern: run all four, concatenate their
# output, and atomically write the result to a .prom file node_exporter's own textfile collector picks up on
# its next scrape.
#
# Entirely OPT-IN, per this issue's own boundary: nothing in the miner package invokes this script itself -- a
# self-hoster wires it into their own cron/systemd timer alongside node_exporter (see docs/observability.md).
# AMS's zero-infra "laptop mode" is completely unaffected if this script is never run.
#
# Fail-open per metric family, mirroring export-ams-reporting-db.sh's philosophy: a broken/corrupt local store
# for ONE subsystem (e.g. the portfolio queue) must not take down the other three families' metrics. A failing
# family is skipped (its own stderr flows through unredirected, e.g. into the cron/systemd journal) rather than
# aborting the whole export -- Prometheus treats an absent series as "no data", not an error, so a partial
# export is strictly better than a stale-forever or entirely-missing one.

MINER_BIN="${GITTENSORY_MINER_BIN:-gittensory-miner}"
OUT_FILE="${GITTENSORY_MINER_PROMETHEUS_TEXTFILE:-/var/lib/node_exporter/textfile_collector/gittensory_miner.prom}"
TMP_FILE="${OUT_FILE}.tmp"

mkdir -p "$(dirname "$OUT_FILE")"
: >"$TMP_FILE"

export_family() {
  label="$1"
  shift
  if ! "$MINER_BIN" "$@" >>"$TMP_FILE"; then
    echo "[miner-prometheus-textfile:$label] export failed, this family's metrics are omitted from $OUT_FILE" >&2
  fi
}

export_family "prediction-calibration" metrics
export_family "portfolio-queue" queue metrics
export_family "event-ledger" ledger metrics
export_family "governor" governor metrics

mv "$TMP_FILE" "$OUT_FILE"
echo "[miner-prometheus-textfile] wrote $OUT_FILE"
