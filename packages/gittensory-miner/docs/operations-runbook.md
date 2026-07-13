# gittensory-miner — operational runbook

Operator-facing runbook for **local SQLite state**: what the concurrency guarantees actually mean, how to recover from corruption, what to do when two miner processes collide on the same files, and how schema upgrades migrate your on-disk ledgers after a package update.

> **Scope:** AMS local stores only. For laptop/fleet deployment layout see [`../DEPLOYMENT.md`](../DEPLOYMENT.md). For Grafana setup see [#5190](https://github.com/JSONbored/gittensory/issues/5190). For the optional hosted discovery plane see [`discovery-plane-operator-guide.md`](discovery-plane-operator-guide.md). This runbook does **not** cover the self-hosted **review stack** (Orb/API/LoopoverDB).

## Local state at a glance

Every miner keeps **independent SQLite files** under one state directory (default `~/.config/gittensory-miner/`, override with `GITTENSORY_MINER_CONFIG_DIR`). Each store has its own file, table, and optional per-store env override — see the table in [`../README.md`](../README.md#local-storage) and [`env-reference.md`](env-reference.md).

Common files you will touch in incidents:

| File | Purpose |
|------|---------|
| `laptop-state.sqlite3` | Bootstrap metadata (`gittensory-miner init`) |
| `claim-ledger.sqlite3` | Soft issue claims on this machine |
| `event-ledger.sqlite3` | Append-only manage-loop audit trail |
| `portfolio-queue.sqlite3` | Per-repo portfolio queue |
| `run-state.sqlite3` | Discover/plan/prepare phase markers |
| `attempt-log.sqlite3` | Per-attempt coding-agent driver events |
| `prediction-ledger.sqlite3` | Predicted gate verdicts for self-improve |
| `plan-store.sqlite3` | Persisted MCP plan DAGs |
| `governor-ledger.sqlite3` | Governor allow/deny/throttle decisions |

Files are created with **`0700` directories / `0600` database files** on first open.

## SQLite concurrency — what `busy_timeout` guarantees

Every store opened through `local-store.js` sets:

```sql
PRAGMA busy_timeout = 5000;
```

(default **5000 ms**; overridable via `openLocalStoreDb(path, { busyTimeoutMs })` in tests only — production stores use the default.)

### What this means for operators

| Situation | Expected behavior |
|-----------|-------------------|
| Two **short-lived** writers on the **same file** (e.g. CLI command finishing while `loop` is idle, or Grafana reading while the miner appends) | SQLite waits up to **5 seconds** for the lock, then proceeds or surfaces `database is locked` |
| Append-only ledgers (`event-ledger`, `attempt-log`, …) | Writes use **`BEGIN IMMEDIATE`** (or equivalent single-statement atomicity) so sequence allocation cannot interleave |
| Claim / queue stores | **`INSERT … ON CONFLICT`** and **`UPDATE … RETURNING`** patterns avoid read-then-write races **within one file** |
| Two **long-running `gittensory-miner loop` daemons** on the **same `GITTENSORY_MINER_CONFIG_DIR`** | **Unsupported.** `busy_timeout` reduces transient lock errors; it does **not** make multi-process loop workers safe on one volume |

**Invariant:** one active loop (or one intentional writer set) per state directory. Horizontal scale = **isolated state dirs** (separate compose projects, separate `GITTENSORY_MINER_CONFIG_DIR`, or the k8s StatefulSet pattern in [`../DEPLOYMENT.md`](../DEPLOYMENT.md)).

### Quick health check

```sh
gittensory-miner doctor --json
gittensory-miner status --json
```

`doctor` includes `laptop-state-sqlite` (file exists + readable) and `state-dir-writable`. It performs **no network I/O**.

## Scenario: two miners collided

**Symptoms**

- `database is locked` / `SQLITE_BUSY` in logs or stderr
- Duplicate or out-of-order event sequences after an unclean shutdown
- Two systemd units, two `docker compose --scale miner=N` replicas, or a manual `loop` plus a supervised `loop` sharing one config dir
- Claims or queue rows flipping unexpectedly

**Diagnosis**

1. List processes using the state dir:

   ```sh
   STATE_DIR="$(gittensory-miner status --json | jq -r .stateDir)"
   ls -la "$STATE_DIR"
   # Linux: lsof +D "$STATE_DIR" 2>/dev/null || fuser -v "$STATE_DIR"/*.sqlite3 2>/dev/null
   ```

2. Confirm only **one** long-lived miner should own that directory.

3. Inspect soft claims and queue without mutating:

   ```sh
   gittensory-miner claim list --json
   gittensory-miner queue list --json
   gittensory-miner ledger list --json | tail -20
   ```

**Remediation**

1. **Stop all but one** miner process targeting that state dir (`systemctl stop`, `docker compose down`, kill stray `loop`).
2. If you need **N parallel workers**, give each an isolated state path — do **not** share one volume:

   ```sh
   # Example: two isolated compose projects
   docker compose -p miner-a -f docker-compose.miner.yml up -d
   docker compose -p miner-b -f docker-compose.miner.yml up -d
   ```

   Or set distinct `GITTENSORY_MINER_CONFIG_DIR` per worker.

3. Re-run `gittensory-miner doctor`. If locks persist with a single process, see **Ledger corrupted** below.

4. **Claims are local bookkeeping only.** Two miners on different machines claiming the same GitHub issue is a **fleet coordination** problem (duplicate-cluster adjudication in the engine), not something SQLite resolves — split state dirs and use operational claim hygiene.

## Scenario: ledger corrupted

**Symptoms**

- Command throws `corrupted_*_row` (`corrupted_attempt_log_row`, `corrupted_governor_row`, `corrupted_plan_row`, `corrupted_prediction_row`, …)
- `gittensory-miner doctor` reports `laptop-state-sqlite` not readable
- `sqlite3` reports `database disk image is malformed`
- Partial writes after disk full, forced kill during a migration transaction, or copying a live `.sqlite3` while the miner is writing

**Diagnosis**

1. Identify which file fails (error message or env override path).
2. Read-only probe:

   ```sh
   DB="$STATE_DIR/event-ledger.sqlite3"   # example
   sqlite3 "$DB" "PRAGMA integrity_check;"
   sqlite3 "$DB" "PRAGMA user_version;"
   ```

3. Check filesystem: disk space, permissions (`0600` file, `0700` parent), backup tools copying mid-write.

**Remediation**

1. **Stop the miner** before any file surgery.
2. **Backup the whole state directory** (even damaged files help post-mortems):

   ```sh
   gittensory-miner backup "${STATE_DIR}.bak.$(date +%Y%m%d%H%M%S)"
   ```

   (A raw `cp -a`/`tar` also works once the miner is stopped, but `backup` needs no stop/start at all — it
   uses SQLite's online backup API, safe against a store the miner still has open.)

3. Choose a recovery tier:

   | Tier | When | Action |
   |------|------|--------|
   | **A — single store reset** | One ledger is corrupt; others healthy; you accept losing that store's history | Remove only the bad `*.sqlite3` (and any `-wal`/`-shm` siblings). Next command recreates an empty store. |
   | **B — restore from backup** | You have a recent quiesced backup | Stop miner → `gittensory-miner restore <backupDir> --force` → restart. |
   | **C — full re-init** | Multiple files suspect or state is disposable | Archive dir → `gittensory-miner init` → reconfigure env/goals. Rebuild claims/plans from GitHub metadata as needed. |

4. **Never copy a live SQLite file** from a running miner as backup — stop first, use SQLite's own `.backup`
   command for a single file, or `gittensory-miner backup <destDir>` for every store at once (same mechanism):

   ```sh
   sqlite3 "$DB" ".backup '${DB}.safe-copy'"
   ```

5. After recovery, run `gittensory-miner doctor --json` and spot-check read-only listings (`claim list`, `ledger list`).

Append-only stores **do not repair individual bad rows** in place — corrupted payload JSON is rejected on read by design so bad data cannot silently propagate.

## Scenario: migrate ledgers after a package upgrade

**How upgrades work**

Stores use the lightweight **`schema-version.js`** convention ([#4832](https://github.com/JSONbored/gittensory/issues/4832)):

- Bootstrap `CREATE TABLE IF NOT EXISTS …` is schema **version 1** (`BASELINE_SCHEMA_VERSION`).
- Each store may register post-baseline migrations; `applySchemaMigrations` runs pending steps on **every open**.
- Version is stamped in SQLite **`PRAGMA user_version`**.
- Migrations run **once**, in order, inside a transaction; a failed migration rolls back and retries on next open.
- **Downgrade is not supported** — older miner versions may not read files written by newer migrations.

**Operator checklist**

1. **Before upgrading** the `@jsonbored/gittensory-miner` package (npm, image tag, or git pull):

   ```sh
   gittensory-miner doctor --json > /tmp/miner-pre-upgrade-doctor.json
   gittensory-miner backup "/tmp/gittensory-miner-backup-$(date +%Y%m%d)" --json
   ```

   (`backup` uses SQLite's own online backup API per store — safe even if a loop is still running against
   it, unlike a raw `tar`/`cp` of a live database file. See "Scenario: backup/restore" below.)

2. **Stop** supervised loops (`systemctl stop gittensory-miner.service`, `docker compose stop miner`, etc.).

3. **Install** the new version (`npm install -g @jsonbored/gittensory-miner@latest`, rebuild image, …). The CLI prints a one-line npm upgrade nudge when behind registry latest — informational only.

4. **Migrate**, before starting any miner process, so every existing store is brought up to date in one
   deliberate pass instead of relying on whichever command happens to open a given store first:

   ```sh
   gittensory-miner migrate --json
   ```

   (Pending migrations still apply automatically on first open regardless — e.g. `portfolio-queue` adds
   `leased_at` when upgrading from pre-#4827 files — `migrate` is the proactive, explicit alternative to
   waiting for that implicit path. A store file that hasn't been created yet is reported as skipped, not
   created; `migrate` never bootstraps fresh state.)

5. **Start** one miner process, then **verify**:

   ```sh
   gittensory-miner doctor --json
   gittensory-miner status --json
   gittensory-miner migrate --json   # re-run: every store should now report "up-to-date"
   ```

6. If a migration throws on startup, **do not delete files immediately** — `gittensory-miner restore "/tmp/gittensory-miner-backup-<date>" --force` the pre-upgrade backup, pin the previous package version, and file an issue with the failing `user_version` and store filename.

**Rolling fleet upgrades:** upgrade and restart **one worker/state dir at a time** so isolated workers never share a directory mid-migration.

## Related docs

- [`../DEPLOYMENT.md`](../DEPLOYMENT.md) — laptop vs fleet, volumes, systemd, scaling rules
- [`../README.md`](../README.md#local-storage) — store inventory
- [`env-reference.md`](env-reference.md) — per-store path overrides
- [`coding-agent-driver.md`](coding-agent-driver.md) — attempt log semantics
- [#5190](https://github.com/JSONbored/gittensory/issues/5190) — Grafana + SQLite ledgers (observability doc)
- [`discovery-plane-operator-guide.md`](discovery-plane-operator-guide.md) — optional hosted plane (distinct from local ledger ops)
