# Observing your miner

How to point Grafana at a running miner's local SQLite ledgers to see its attempt and prediction history. This
covers the **miner-specific** observability wiring only; for general self-host operations, see your ops runbook.

## What's observable

The miner writes append-only SQLite ledgers under `GITTENSORY_MINER_CONFIG_DIR` (default
`~/.config/gittensory-miner` on a laptop, or `/data/miner` in the fleet Docker image — see
[`DEPLOYMENT.md`](../DEPLOYMENT.md)):

- **`attempt-log.sqlite3`** — the driver-level attempt event trace (event type, action class, mode, reason,
  timestamps), table `attempt_log_events`.
- **`prediction-ledger.sqlite3`** — recorded predicted-gate verdicts for later scoring.

## Point Grafana at the ledgers

The repo ships datasource provisioning at
[`grafana/provisioning/datasources/ams-ledgers.yml`](../../../grafana/provisioning/datasources/ams-ledgers.yml)
— two **read-only** `frser-sqlite-datasource` entries: `AMS Attempt Log` (uid `ams-attempt-log`) and
`AMS Prediction Ledger` (uid `ams-prediction-ledger`).

1. **Install the SQLite plugin** in Grafana — the same one the maintainer `GittensoryDB` datasource uses:

   ```sh
   GF_INSTALL_PLUGINS=frser-sqlite-datasource
   ```

2. **Mount your ledger directory** into the Grafana container, read-only, at `/ams-ledgers` so the provisioned
   `path:` values resolve (the `:ro` mount plus the query-only plugin mean Grafana can never write the live
   ledgers):

   ```yaml
   # in your Grafana service (docker-compose)
   volumes:
     - "${GITTENSORY_MINER_CONFIG_DIR:-~/.config/gittensory-miner}:/ams-ledgers:ro"
   ```

   The two datasources point at `/ams-ledgers/attempt-log.sqlite3` and `/ams-ledgers/prediction-ledger.sqlite3`.
   If you mount elsewhere, edit the two `path:` values in `ams-ledgers.yml` to match.

3. **Restart Grafana.** The two datasources appear under **Connections → Data sources**, already provisioned
   (non-editable) so they survive restarts.

## Load a dashboard

Dashboards live in [`grafana/dashboards/`](../../../grafana/dashboards/) and are auto-provisioned from that
directory. To visualize the ledgers, add an AMS dashboard JSON there — or import one at runtime via the Grafana
UI (**Dashboards → Import**) — and point its panels at the `AMS Attempt Log` / `AMS Prediction Ledger`
datasources above. Panels query the ledger tables directly (e.g. `SELECT * FROM attempt_log_events`); the
`frser-sqlite-datasource` plugin also supports `json_extract(payload_json, '$.…')` to read fields nested inside
an event's payload.
