# AMS shared-store concurrency model

Canonical statement of **what the AMS local-store / `SqliteDriver` seam guarantees under concurrent
access**, and what it deliberately does **not** — for [#4942](https://github.com/JSONbored/loopover/issues/4942),
after the [#7175](https://github.com/JSONbored/loopover/issues/7175) shared-seam migration unblocked this work.

> **Audience:** maintainers and contributors wiring hosted AMS / control-plane tenancy, not day-to-day
> laptop operators. For the operator-facing single-file SQLite rules (`busy_timeout`, one loop per
> state dir), see [`operations-runbook.md`](operations-runbook.md).

## Scope

| Layer | File(s) | Role in this model |
|-------|---------|--------------------|
| Miner `SqliteDriver` seam | `packages/loopover-miner/lib/store-db-adapter.ts`, `local-store.ts` | Sync `query`/`exec` + D1-shaped `createD1Adapter` (`batch` = `BEGIN` → stmts → `COMMIT`) |
| Miner default backend | `node:sqlite` via `nodeSqliteDriver` / `openLocalStoreDb` | Still the self-host / laptop default after #7175 — the seam is real; a miner `createPgAdapter` cutover is a later slice |
| ORB Postgres adapter | `src/selfhost/pg-adapter.ts` | The shared-service Postgres implementation the seam was designed to swap in (`batch` pins one `PoolClient`, `BEGIN` → `runOn` → `COMMIT`) |
| Contrast (not store atomicity) | `src/selfhost/installation-concurrency-admission.ts`, `src/queue/map-with-concurrency.ts` | Per-installation **GitHub-fetch job** admission, and generic fan-out worker pools — fairness / throughput, **not** row-level store guarantees |

**Tenancy boundary (control-plane):** hosted AMS is provisioned as **one container + one database per
tenant+product**, not a shared multi-tenant table with `tenant_id` row filters. “Multiple tenant
sessions” in this doc means concurrent clients/workers against **one tenant’s** store (or one shared
test DB), not cross-tenant isolation inside a single SQLite file. Cross-tenant isolation is
infrastructure (provisioning), not `PRAGMA` / file locks. Default in-process store singletons remain
unsafe if many tenants share one Node process — see [`global-singleton-tenant-audit.md`](global-singleton-tenant-audit.md).

## What is guaranteed

### SQLite (`node:sqlite` / `openLocalStoreDb`)

| Guarantee | Mechanism |
|-----------|-----------|
| Short writers eventually proceed or fail loudly | `PRAGMA busy_timeout = 5000` (default) on every store open |
| Read-then-conditional-write cannot interleave with another writer on the same file | Interactive sites use **`BEGIN IMMEDIATE`** (takes the write lock before the first read) — e.g. `claimIssueWithinCap`, portfolio `batchClaim`, governor `withTransaction`, append-only ledgers |
| Single-row claim / dequeue is atomic | `INSERT … ON CONFLICT` / `UPDATE … RETURNING` (no app-level RMW) |
| Two processes racing the same claim or dequeue produce one winner | Empirically gated by `test/unit/miner-concurrent-store-races.test.ts` (#4867) and the #4942 load suite |

**Invariant (unchanged from the runbook):** two long-running `loopover-miner loop` daemons on the
**same** `LOOPOVER_MINER_CONFIG_DIR` remain **unsupported**. `busy_timeout` is not a multi-writer
cluster protocol.

### `SqliteDriver` + `createD1Adapter.batch` (miner seam)

- `batch(statements)` runs on the sync driver as `BEGIN` → execute each statement → `COMMIT` /
  `ROLLBACK` (`store-db-adapter.ts`).
- That is a **predetermined** statement list (D1-shaped): the result of statement *N* cannot decide
  statement *N+1* inside the same `batch` call. Interactive AMS sites that still need
  read-then-write stay on `BEGIN IMMEDIATE` against `DatabaseSync` until an async `runOn`-style API
  lands for miner Postgres.
- Concurrent callers that use **single-statement conditional SQL** (`UPDATE … SET n = n + 1`,
  `INSERT … ON CONFLICT`, `UPDATE … WHERE … RETURNING`) see no lost updates under SQLite’s writer
  serialization — verified by the #4942 load test.

### Postgres (`createPgAdapter` — ORB / future hosted AMS)

| Guarantee | Mechanism |
|-----------|-----------|
| Multi-statement atomicity for a predetermined batch | `batch()` acquires one `PoolClient`, `BEGIN`, runs each stmt via `runOn(client)`, `COMMIT` / `ROLLBACK` |
| Multi-instance self-host | Shared Postgres replaces single-file SQLite (ORB’s original motivation in `pg-adapter.ts`) |
| Queue claim under many workers | Sibling pattern `FOR UPDATE SKIP LOCKED` in `src/selfhost/pg-queue.ts` (queue, not AMS ledgers) |
| Atomic counter / upsert style writes | Same SQL shapes as SQLite when expressed as one statement (or one `batch` of predetermined stmts) |

Default isolation for `BEGIN` with no `SET TRANSACTION ISOLATION LEVEL` is **READ COMMITTED** (Postgres
default) — **not** SERIALIZABLE.

## What is not guaranteed

| Non-guarantee | Why |
|---------------|-----|
| **SERIALIZABLE** / predicate locking | Neither miner `BEGIN IMMEDIATE` nor ORB `batch()` sets SERIALIZABLE. App-level RMW across separate statements/transactions can still lose updates under READ COMMITTED / SQLite if you omit conditional SQL or `BEGIN IMMEDIATE`. |
| Cross-process **queue admission** fairness | `installation-concurrency-admission.ts` is an in-process `Map` — single process per deployment by design. |
| Fan-out helpers as store locks | `mapWithConcurrency` only bounds Promise concurrency; it does not serialize DB writers. |
| Two loops on one SQLite directory | Explicitly unsupported (runbook). |
| Default store singletons across tenants in one process | Module-scoped `default*` handles — see tenant audit doc. |
| Miner already running on Postgres today | #7175 shipped the **seam** + non-interactive store rollout; interactive stores still use `DatabaseSync` + `BEGIN IMMEDIATE`. ORB’s `createPgAdapter` is the shared-service reference implementation to document against. |
| Plain `createD1Adapter.batch` `BEGIN` ≡ `BEGIN IMMEDIATE` | Miner D1 adapter uses plain `BEGIN`. Do not assume it takes the write lock before the first read the way interactive AMS sites do. |

## Mapping: AMS interactive sites → shared backend

| AMS pattern today | SQLite guarantee | Shared Postgres analogue |
|-------------------|------------------|---------------------------|
| `claimIssueWithinCap` / ledger append | `BEGIN IMMEDIATE` + count + insert | Pinned client + interactive txn (`runOn`) — **later miner slice**; until then keep SQLite IMMEDIATE |
| Portfolio dequeue / claim upsert | Single-statement `UPDATE…RETURNING` / `ON CONFLICT` | Same SQL via `prepare().run()` / `batch` of fixed stmts |
| CRUD caches on `openLocalStoreAdapter` | Sync `driver.query` | Swap driver; no interactive txn required |
| ORB job queue claim | n/a (ORB) | `FOR UPDATE SKIP LOCKED` |

## Load / race verification (#4942)

Correctness (not wall-clock) coverage lives in:

- `test/unit/miner-concurrent-store-races.test.ts` — cross-process claim + dequeue (#4867)
- `test/unit/miner-shared-store-concurrency.test.ts` — #4942: cross-process `claimIssueWithinCap`,
  concurrent `SqliteDriver` / `createD1Adapter` atomic increments, and (when `PG_TEST_URL` is set)
  concurrent Postgres `createPgAdapter` increments with no lost updates

These suites assert **final counts / uniqueness**, not latency. Informational HTTP/engine load scripts
(`docs/load-test-worker.md`, engine iterate-loop load test) are out of scope here.

## See also

- [`operations-runbook.md`](operations-runbook.md) — operator SQLite concurrency
- [`ams-storage-abstraction-research.md`](ams-storage-abstraction-research.md) — why Postgres + the ORB seam
- [`global-singleton-tenant-audit.md`](global-singleton-tenant-audit.md) — in-process default-store hazards
- [`sizing.md`](sizing.md) — replicas need separate volumes for SQLite
