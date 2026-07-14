# Observing your miner

How to point Grafana at redacted miner reporting exports to see attempt and prediction history without exposing the
miner's live local ledgers. This covers the **miner-specific** observability wiring only; for general self-host
operations, see your ops runbook.

## What's observable

The miner writes append-only SQLite ledgers under `GITTENSORY_MINER_CONFIG_DIR` (default
`~/.config/gittensory-miner` on a laptop, or `/data/miner` in the fleet Docker image — see
[`DEPLOYMENT.md`](../DEPLOYMENT.md)):

- **`attempt-log.sqlite3`** — the driver-level attempt event trace (event type, action class, mode, reason,
  timestamps), table `attempt_log_events`. One `attempt_outcome_summary` row per completed attempt also carries
  the real configured `provider` and the real accumulated `cost_usd` (#5185) — `tokens_used` is always `NULL`
  today, an honest gap rather than a fabricated `0`: no coding-agent driver reports real token usage yet (#5395).
- **`prediction-ledger.sqlite3`** — recorded predicted-gate verdicts for later scoring.

Those live files can contain free-form payloads, repo/target identifiers, readiness scores, and blocker/warning
codes. Keep `GITTENSORY_MINER_CONFIG_DIR` private to the miner. Grafana should read only sanitized reporting
exports that operators create from those ledgers.

## Point Grafana at reporting exports

The repo ships datasource provisioning at
[`grafana/provisioning/datasources/ams-ledgers.yml`](../../../grafana/provisioning/datasources/ams-ledgers.yml)
— two **read-only** `frser-sqlite-datasource` entries: `AMS Attempt Log` (uid `ams-attempt-log`) and
`AMS Prediction Ledger` (uid `ams-prediction-ledger`). Their default paths live under Grafana's reporting mount,
not under the miner config directory.

1. **Install the SQLite plugin** in Grafana — the same one the maintainer `LoopoverDB` datasource uses:

   ```sh
   GF_INSTALL_PLUGINS=frser-sqlite-datasource
   ```

2. **Run the AMS reporting exporter**, a dedicated compose profile (only useful when a miner also runs on this
   same host — an engine-only deployment has nothing for it to read):

   ```sh
   docker compose --profile ams-observability up -d
   ```

   Set `GITTENSORY_MINER_CONFIG_DIR` in your `.env` (see [`.env.example`](../../../.env.example)) to the same
   directory your miner uses. The `ams-reporting-exporter` container mounts it **read-only**, runs
   [`scripts/export-ams-reporting-db.sh`](../../../scripts/export-ams-reporting-db.sh) on an interval
   (`GITTENSORY_AMS_REPORTING_EXPORT_INTERVAL_SECONDS`, default 30s), and writes the redacted snapshots into the
   same `reporting` volume Grafana already reads — Grafana itself never mounts the live ledgers. The exported
   schema drops `attempt_log_events.reason`/`.payload_json` (the free-form fields) entirely; every other column,
   including the `predictions` table's `blocker_codes_json`/`warning_codes_json` (fixed, engine-defined codes —
   never free text), passes through unchanged.

3. **Restart Grafana.** The two datasources appear under **Connections → Data sources**, already provisioned
   (non-editable) so they survive restarts.

## Load a dashboard

Dashboards live in [`grafana/dashboards/`](../../../grafana/dashboards/) and are auto-provisioned from that
directory. To visualize AMS activity, add a dashboard JSON there — or import one at runtime via the Grafana UI
(**Dashboards → Import**) — and point its panels at the `AMS Attempt Log` / `AMS Prediction Ledger` datasources
above. Panels should query only the redacted reporting schema (e.g. `SELECT * FROM attempt_log_events`), never a
`payload_json`/`reason` column — the exporter drops both, so a panel referencing them returns no such column.

## Prometheus metrics (opt-in)

The two sections above cover Grafana-via-SQLite (historical attempt/prediction rows). Separately, the miner CLI
exposes four Prometheus text-exposition documents for live counters/gauges — a completely independent,
**off-by-default** mechanism: nothing in the miner package runs these on a schedule or opens a port itself.

| Command                             | Metric family                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| `gittensory-miner metrics`           | Prediction-calibration counters (`gittensory_miner_prediction*_total`)               |
| `gittensory-miner queue metrics`     | Portfolio-queue backlog + lease-age gauges (`gittensory_miner_portfolio_queue*`)      |
| `gittensory-miner ledger metrics`    | Event-ledger counters (`gittensory_miner_events_total`)                              |
| `gittensory-miner governor metrics`  | Write-rate-limit + cap-usage pressure gauges (`gittensory_miner_governor*`)           |

None of these is a long-running HTTP server — Prometheus can't scrape a one-shot CLI command directly. To opt in,
wire [`scripts/export-miner-prometheus-textfile.sh`](../../../scripts/export-miner-prometheus-textfile.sh) into
your own cron/systemd timer alongside [node_exporter's textfile
collector](https://github.com/prometheus/node_exporter#textfile-collector): the script runs all four commands and
atomically writes their concatenated output to `$GITTENSORY_MINER_PROMETHEUS_TEXTFILE` (default
`/var/lib/node_exporter/textfile_collector/gittensory_miner.prom`), the standard directory node_exporter's
textfile collector watches. Point `GITTENSORY_MINER_BIN` at the miner binary if it isn't on `PATH`.

A broken/corrupt local store for one family (e.g. the portfolio queue) never blocks the other three — that
family's metrics are simply omitted from the file for that run (logged to stderr), not the whole export.

```sh
# crontab -e
*/5 * * * * GITTENSORY_MINER_CONFIG_DIR=/data/miner sh /path/to/gittensory/scripts/export-miner-prometheus-textfile.sh
```

Then point your own `prometheus.yml` at node_exporter as usual — no changes to this repo's `prometheus/` config
are needed. See [`prometheus/rules/alerts.yml`](../../../prometheus/rules/alerts.yml)'s
`gittensory-miner-prediction` / `gittensory-miner-portfolio-queue` / `gittensory-miner-governor` rule groups for
alert rules that already target these exact metric names.

## Anonymized central telemetry (opt-in, off by default)

Everything above stays entirely on your own machine. Separately, the miner can send a small, anonymized batch
of its own PR-outcome history to gittensory's hosted AMS collector — the same fleet-growth/usage telemetry Orb's
self-host collector already sends for maintainers, mirrored for contributors:

```sh
gittensory-miner orb export --enable --send
```

- **`--enable`** alone only builds and prints the anonymized batch locally — no network call, so you can inspect
  exactly what would be sent before ever transmitting anything.
- **`--enable --send`** additionally POSTs that batch to the collector and advances a local cursor, so the next
  run only sends events since the last successful send.

**What's sent:** for each of your own resolved PRs — an HMAC-anonymized repo hash and PR hash (a per-instance
secret generated once and kept only on your machine; the collector never holds it and can't reverse the hash), the
`merged`/`closed` decision, a fixed low-cardinality rejection-reason bucket, and the close timestamp. No repo
names, PR numbers, diffs, code, or free text ever leave your machine.

**Nothing is sent unless you explicitly opt in.** There is no default-on behavior here (unlike Orb's own
maintainer-side collector) — every invocation requires `--enable --send` explicitly.

| Variable | Purpose |
| --- | --- |
| `GITTENSORY_MINER_AMS_COLLECTOR_URL` | Override the collector endpoint (default: gittensory's hosted collector). |
| `GITTENSORY_MINER_AMS_COLLECTOR_TOKEN` | Optional bearer credential, only needed if your collector requires one. |
| `GITTENSORY_MINER_ORB_EXPORT_DB` | Override the local secret+cursor store path (default: `orb-export.sqlite3` under `GITTENSORY_MINER_CONFIG_DIR`). |
