# Observing your miner (Grafana + local SQLite ledgers)

Operator guide for pointing Grafana at a running `gittensory-miner` instance's **local SQLite ledgers** — the append-only stores that record coding-agent driver attempts and predicted-gate outcomes. This is **miner-specific** observability; it is distinct from the maintainer-only self-host operations runbook ([#4875](https://github.com/JSONbored/gittensory/issues/4875)), which covers the review stack's broader ops surface.

> **Scope:** Grafana datasource wiring and the miner usage dashboard only. For laptop/fleet deployment, state layout, and CLI diagnostics, see [`../DEPLOYMENT.md`](../DEPLOYMENT.md) and [`coding-agent-driver.md`](coding-agent-driver.md). For env-var overrides on ledger paths, see [`env-reference.md`](env-reference.md).

## What you can see

| Ledger | Default file | Primary tables | Answers |
|--------|--------------|----------------|---------|
| **Attempt log** | `attempt-log.sqlite3` | `attempt_log_events` | Per-attempt driver lifecycle (`attempt_started`, `attempt_succeeded`, `attempt_failed`, …), mode, and structured payloads |
| **Prediction ledger** | `prediction-ledger.sqlite3` | `predictions` | Predicted gate conclusions the miner computed before opening a PR |

Both files are **read-only from Grafana's perspective** — the SQLite datasource plugin opens them for queries; it never writes back.

The planned **`miner-usage.json`** dashboard ([#5185](https://github.com/JSONbored/gittensory/issues/5185)) aggregates attempt success/fail counts, token totals, and cost **per coding-agent provider** (`claude-cli`, `codex-cli`, `agent-sdk`) from these ledgers. Provisioned datasource entries ([#5184](https://github.com/JSONbored/gittensory/issues/5184)) automate the path wiring below; until those land, follow the manual steps.

### Not the ORB review-stack dashboards

If you also run the Gittensory **self-host review stack** with `--profile observability`, Grafana already ships dashboards such as **`Gittensory - AI usage`** (`grafana/dashboards/ai-usage.json`), which query the **review stack's** redacted reporting SQLite export (`uid: gittensory-db`). That answers *review-time AI usage* across configured providers.

The miner dashboard answers a different question: *what did my autonomous miner's coding-agent drivers attempt, and how did predicted gates score those targets?* Keep the two surfaces separate — do not point miner panels at `gittensory-db` or ORB panels at miner ledger files.

## Prerequisites

1. **Grafana** with the [**SQLite**](https://grafana.com/grafana/plugins/frser-sqlite-datasource/) plugin (`frser-sqlite-datasource`). The repo's self-host stack installs it automatically:

   ```sh
   docker compose --profile observability up -d
   ```

   (`GF_INSTALL_PLUGINS` in [`docker-compose.yml`](../../../docker-compose.yml) includes `frser-sqlite-datasource`.)

2. **Miner state on disk.** Run `gittensory-miner init` (or any command that touches a ledger) so the SQLite files exist:

   ```sh
   gittensory-miner status --json   # prints stateDir
   gittensory-miner doctor --json   # confirms SQLite readiness
   ```

3. **Resolve your ledger paths** (defaults shown; override with env vars):

   ```text
   ~/.config/gittensory-miner/attempt-log.sqlite3
   ~/.config/gittensory-miner/prediction-ledger.sqlite3
   ```

   | Override env var | Effect |
   |------------------|--------|
   | `GITTENSORY_MINER_CONFIG_DIR` | Directory containing both `*.sqlite3` files |
   | `GITTENSORY_MINER_ATTEMPT_LOG_DB` | Explicit path to attempt log (wins over config dir) |
   | `GITTENSORY_MINER_PREDICTION_LEDGER_DB` | Explicit path to prediction ledger |

   Quick check:

   ```sh
   gittensory-miner status --json
   # stateDir + "/attempt-log.sqlite3" and stateDir + "/prediction-ledger.sqlite3"
   ```

## Step 1 — Make ledger files visible to Grafana

Grafana must read the **host path** where the miner writes SQLite. Pick the layout that matches your deployment.

### A. Miner on host, Grafana in Docker Compose (typical laptop setup)

Add a read-only bind mount so the Grafana container sees your miner state directory. Create `docker-compose.override.yml` beside the repo's [`docker-compose.yml`](../../../docker-compose.yml):

```yaml
services:
  grafana:
    volumes:
      - ${HOME}/.config/gittensory-miner:/miner-state:ro
```

If you use `GITTENSORY_MINER_CONFIG_DIR`, mount that directory instead:

```yaml
services:
  grafana:
    volumes:
      - /path/to/your/miner-state:/miner-state:ro
```

Recreate Grafana:

```sh
docker compose --profile observability up -d grafana
```

Inside the container, ledger paths become:

```text
/miner-state/attempt-log.sqlite3
/miner-state/prediction-ledger.sqlite3
```

### B. Miner in Docker (fleet mode)

Mount the **same** named volume (or host path) into both the miner container and Grafana. Example override when the miner uses `miner-data` at `/data/miner`:

```yaml
services:
  grafana:
    volumes:
      - miner-data:/miner-state:ro
```

Use `/miner-state/attempt-log.sqlite3` and `/miner-state/prediction-ledger.sqlite3` in datasource config below.

## Step 2 — Add SQLite datasources

### Option A — Grafana UI (works today)

Repeat for **each** ledger file (attempt log and prediction ledger):

1. Open Grafana → **Connections** → **Data sources** → **Add data source**.
2. Search for **SQLite** (`frser-sqlite-datasource`) and select it.
3. Set **Path** to the container-visible absolute path, e.g. `/miner-state/attempt-log.sqlite3`.
4. **Save & test** — you should see *Database ok* when the file exists and is readable.

Suggested names (match the upcoming provisioned UIDs in [#5184](https://github.com/JSONbored/gittensory/issues/5184)):

| Datasource name | UID (optional, for dashboard import) | Path (Compose example) |
|-----------------|----------------------------------------|-------------------------|
| GittensoryMinerAttemptLog | `gittensory-miner-attempt-log` | `/miner-state/attempt-log.sqlite3` |
| GittensoryMinerPredictionLedger | `gittensory-miner-prediction-ledger` | `/miner-state/prediction-ledger.sqlite3` |

Sanity queries (**Explore** → pick datasource → **Query**):

```sql
SELECT event_type, count(*) AS n
FROM attempt_log_events
GROUP BY event_type
ORDER BY n DESC;
```

```sql
SELECT conclusion, count(*) AS n
FROM predictions
GROUP BY conclusion
ORDER BY n DESC;
```

### Option B — Provisioning YAML (automated in [#5184](https://github.com/JSONbored/gittensory/issues/5184))

Until `grafana/provisioning/datasources/miner-*.yml` ships, you can drop files under `grafana/provisioning/datasources/` mirroring the existing [`sqlite.yml`](../../../grafana/provisioning/datasources/sqlite.yml) pattern:

```yaml
# grafana/provisioning/datasources/miner-attempt-log.yml  (example — paths must match your mount)
apiVersion: 1
datasources:
  - name: GittensoryMinerAttemptLog
    type: frser-sqlite-datasource
    uid: gittensory-miner-attempt-log
    access: proxy
    editable: true
    jsonData:
      path: /miner-state/attempt-log.sqlite3
```

```yaml
# grafana/provisioning/datasources/miner-prediction-ledger.yml  (example)
apiVersion: 1
datasources:
  - name: GittensoryMinerPredictionLedger
    type: frser-sqlite-datasource
    uid: gittensory-miner-prediction-ledger
    access: proxy
    editable: true
    jsonData:
      path: /miner-state/prediction-ledger.sqlite3
```

Restart Grafana after adding provisioning files.

## Step 3 — Load the miner usage dashboard

Once [#5185](https://github.com/JSONbored/gittensory/issues/5185) lands, the dashboard JSON lives at:

```text
grafana/dashboards/miner-usage.json
```

### Auto-provisioned (recommended)

The self-host stack already provisions dashboards from `grafana/dashboards/` via [`grafana/provisioning/dashboards/provider.yml`](../../../grafana/provisioning/dashboards/provider.yml). After #5185 merges, starting observability profile picks up **Gittensory Miner — usage** automatically:

```sh
docker compose --profile observability up -d
```

Open Grafana → **Dashboards** → folder **Gittensory** → select the miner usage dashboard.

### Manual import (before or without provisioning)

1. **Dashboards** → **New** → **Import**.
2. **Upload JSON file** → choose `grafana/dashboards/miner-usage.json` from your checkout.
3. When prompted, map panels to the datasources you created in Step 2 (`gittensory-miner-attempt-log`, `gittensory-miner-prediction-ledger`).
4. **Import**.

The dashboard exposes a **Provider** template variable (`claude-cli` / `codex-cli` / `agent-sdk`) to filter attempt outcomes, token totals, and cost in one place — unlike ORB's per-provider AI-usage split.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| *Database ok* fails / file not found | Grafana container cannot see host path | Add the `/miner-state:ro` volume mount; verify path inside container with `docker compose exec grafana ls -l /miner-state` |
| Empty panels | Miner has not run attempts yet | Run a dry attempt or check `attempt-log.sqlite3` size on disk |
| `database is locked` | Miner writing while Grafana queries | Normal under load; retry. Ledgers use `busy_timeout`; heavy concurrent writes may still briefly block readers |
| Plugin missing | Observability profile not used | Ensure `GF_INSTALL_PLUGINS` includes `frser-sqlite-datasource` or install the plugin manually |

## Related docs

- [`coding-agent-driver.md`](coding-agent-driver.md) — what the attempt log records and how drivers plug in.
- [`../DEPLOYMENT.md`](../DEPLOYMENT.md) — laptop vs fleet layout and volume strategy.
- [`env-reference.md`](env-reference.md) — ledger path env vars.
- General self-host operations ([#4875](https://github.com/JSONbored/gittensory/issues/4875)) — review-stack ops; link out rather than duplicating here.
