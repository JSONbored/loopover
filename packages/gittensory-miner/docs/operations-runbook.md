# loopover-miner — operational runbook

Operator-facing runbook for **local SQLite state**: what the concurrency guarantees actually mean, how to recover from corruption, what to do when two miner processes collide on the same files, and how schema upgrades migrate your on-disk ledgers after a package update.

> **Scope:** AMS local stores only. For laptop/fleet deployment layout see [`../DEPLOYMENT.md`](../DEPLOYMENT.md). For Grafana setup see [#5190](https://github.com/JSONbored/gittensory/issues/5190). For the optional hosted discovery plane see [`discovery-plane-operator-guide.md`](discovery-plane-operator-guide.md). This runbook does **not** cover the self-hosted **review stack** (Orb/API/LoopoverDB).

## Local state at a glance

Every miner keeps **independent SQLite files** under one state directory (default `~/.config/loopover-miner/`, override with `LOOPOVER_MINER_CONFIG_DIR`). Each store has its own file, table, and optional per-store env override — see the table in [`../README.md`](../README.md#local-storage) and [`env-reference.md`](env-reference.md).

Common files you will touch in incidents:

| File | Purpose |
|------|---------|
| `laptop-state.sqlite3` | Bootstrap metadata (`loopover-miner init`) |
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
| Two **long-running `loopover-miner loop` daemons** on the **same `LOOPOVER_MINER_CONFIG_DIR`** | **Unsupported.** `busy_timeout` reduces transient lock errors; it does **not** make multi-process loop workers safe on one volume |

**Invariant:** one active loop (or one intentional writer set) per state directory. Horizontal scale = **isolated state dirs** (separate compose projects, separate `LOOPOVER_MINER_CONFIG_DIR`, or the k8s StatefulSet pattern in [`../DEPLOYMENT.md`](../DEPLOYMENT.md)).

### Quick health check

```sh
loopover-miner doctor --json
loopover-miner status --json
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
   STATE_DIR="$(loopover-miner status --json | jq -r .stateDir)"
   ls -la "$STATE_DIR"
   # Linux: lsof +D "$STATE_DIR" 2>/dev/null || fuser -v "$STATE_DIR"/*.sqlite3 2>/dev/null
   ```

2. Confirm only **one** long-lived miner should own that directory.

3. Inspect soft claims and queue without mutating:

   ```sh
   loopover-miner claim list --json
   loopover-miner queue list --json
   loopover-miner ledger list --json | tail -20
   ```

**Remediation**

1. **Stop all but one** miner process targeting that state dir (`systemctl stop`, `docker compose down`, kill stray `loop`).
2. If you need **N parallel workers**, give each an isolated state path — do **not** share one volume:

   ```sh
   # Example: two isolated compose projects
   docker compose -p miner-a -f docker-compose.miner.yml up -d
   docker compose -p miner-b -f docker-compose.miner.yml up -d
   ```

   Or set distinct `LOOPOVER_MINER_CONFIG_DIR` per worker.

3. Re-run `loopover-miner doctor`. If locks persist with a single process, see **Ledger corrupted** below.

4. **Claims are local bookkeeping only.** Two miners on different machines claiming the same GitHub issue is a **fleet coordination** problem (duplicate-cluster adjudication in the engine), not something SQLite resolves — split state dirs and use operational claim hygiene.

## Backup and restore

Proactive tooling (#4872), not just the reactive "ledger corrupted" scenario below — run `backup-miner.sh` on a
schedule (cron, systemd timer, etc.) so a good restore point always exists before anything goes wrong.

- **[`scripts/backup-miner.sh`](../../../scripts/backup-miner.sh)** — backs up every `*.sqlite3` file currently
  present under `LOOPOVER_MINER_CONFIG_DIR` into a new timestamped directory, using SQLite's own online
  `.backup` command (safe even while the miner is running — see the corruption scenario's warning below about
  why a plain `cp` is not) plus a `PRAGMA integrity_check` on each resulting file before it's kept. Stores
  discovered by glob, not a hardcoded list, so a newly added store is backed up automatically without this doc
  or the script needing an update.

  ```sh
  sh scripts/backup-miner.sh
  # Env overrides: LOOPOVER_MINER_CONFIG_DIR (source), LOOPOVER_MINER_BACKUP_DIR (default
  # $LOOPOVER_MINER_CONFIG_DIR/backups), LOOPOVER_MINER_BACKUP_RETAIN (default 7 — oldest backups beyond
  # this count are pruned after a fully successful run; a run with any failed store skips pruning so no older,
  # good backup is ever lost to make room for a bad one).
  ```

- **[`scripts/restore-miner.sh`](../../../scripts/restore-miner.sh)** — the read side. **Stop the miner first**
  (this script does not detect a running process). Validates every store file in the chosen backup with
  `PRAGMA integrity_check` **before** copying anything into place — a half-good backup can never produce a
  half-restored state directory. Requires an explicit `--yes` flag (it overwrites live state) and defaults to
  the newest backup when no directory is given:

  ```sh
  sh scripts/restore-miner.sh --yes                          # newest backup
  sh scripts/restore-miner.sh --yes /path/to/backups/<ts>     # a specific one
  loopover-miner doctor --json                              # verify afterward
  ```

  Also removes any leftover `-wal`/`-shm` sidecar files from the live directory after restoring each store —
  those hold in-flight writes from *before* the restore, and leaving them in place would let SQLite silently
  replay stale pre-restore writes back on top of the freshly restored file on next open.

## Scenario: ledger corrupted

**Symptoms**

- Command throws `corrupted_*_row` (`corrupted_attempt_log_row`, `corrupted_governor_row`, `corrupted_plan_row`, `corrupted_prediction_row`, …)
- `loopover-miner doctor` reports `laptop-state-sqlite` not readable
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
   cp -a "$STATE_DIR" "${STATE_DIR}.bak.$(date +%Y%m%d%H%M%S)"
   ```

3. Choose a recovery tier:

   | Tier | When | Action |
   |------|------|--------|
   | **A — single store reset** | One ledger is corrupt; others healthy; you accept losing that store's history | Remove only the bad `*.sqlite3` (and any `-wal`/`-shm` siblings). Next command recreates an empty store. |
   | **B — restore from backup** | You have a recent backup from `backup-miner.sh` (see **Backup and restore** above) | Stop miner → `sh scripts/restore-miner.sh --yes` → restart. |
   | **C — full re-init** | Multiple files suspect or state is disposable | Archive dir → `loopover-miner init` → reconfigure env/goals. Rebuild claims/plans from GitHub metadata as needed. |

4. **Never copy a live SQLite file** from a running miner as backup — stop first, or use SQLite's `.backup` command:

   ```sh
   sqlite3 "$DB" ".backup '${DB}.safe-copy'"
   ```

5. After recovery, run `loopover-miner doctor --json` and spot-check read-only listings (`claim list`, `ledger list`).

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

1. **Before upgrading** the `@loopover/miner` package (npm, image tag, or git pull):

   ```sh
   loopover-miner doctor --json > /tmp/miner-pre-upgrade-doctor.json
   STATE_DIR="$(loopover-miner status --json | jq -r .stateDir)"
   tar -czf "/tmp/loopover-miner-state-$(date +%Y%m%d).tar.gz" -C "$(dirname "$STATE_DIR")" "$(basename "$STATE_DIR")"
   ```

2. **Stop** supervised loops (`systemctl stop loopover-miner.service`, `docker compose stop miner`, etc.).

3. **Install** the new version (`npm install -g @loopover/miner@latest`, rebuild image, …). The CLI prints a one-line npm upgrade nudge when behind registry latest — informational only.

4. **Migrate**, before starting any miner process, so every existing store is brought up to date in one
   deliberate pass instead of relying on whichever command happens to open a given store first:

   ```sh
   loopover-miner migrate --json
   ```

   (Pending migrations still apply automatically on first open regardless — e.g. `portfolio-queue` adds
   `leased_at` when upgrading from pre-#4827 files — `migrate` is the proactive, explicit alternative to
   waiting for that implicit path. A store file that hasn't been created yet is reported as skipped, not
   created; `migrate` never bootstraps fresh state.)

5. **Start** one miner process, then **verify**:

   ```sh
   loopover-miner doctor --json
   loopover-miner status --json
   loopover-miner migrate --json   # re-run: every store should now report "up-to-date"
   ```

6. If a migration throws on startup, **do not delete files immediately** — restore the pre-upgrade tarball, pin the previous package version, and file an issue with the failing `user_version` and store filename.

**Rolling fleet upgrades:** upgrade and restart **one worker/state dir at a time** so isolated workers never share a directory mid-migration.

## Related docs

- [`../DEPLOYMENT.md`](../DEPLOYMENT.md) — laptop vs fleet, volumes, systemd, scaling rules
- [`../README.md`](../README.md#local-storage) — store inventory
- [`env-reference.md`](env-reference.md) — per-store path overrides
- [`coding-agent-driver.md`](coding-agent-driver.md) — attempt log semantics
- [#5190](https://github.com/JSONbored/gittensory/issues/5190) — Grafana + SQLite ledgers (observability doc)
- [`discovery-plane-operator-guide.md`](discovery-plane-operator-guide.md) — optional hosted plane (distinct from local ledger ops)
