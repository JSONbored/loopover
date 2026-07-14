# AMS storage-abstraction research — replacing the `node:sqlite` local-store for a hosted, tenant-scoped datastore

Research spike for **#5216**. AMS's local stores (`lib/local-store.js` and its siblings) use `node:sqlite`'s
`DatabaseSync` with one file per machine and no tenant concept; a hosted AMS needs a shared, tenant-scoped
datastore. This document compares realistic replacement backends **against AMS's existing read/write patterns**
— not a green-field storage design — so the follow-up (maintainer-owned) storage-abstraction design issue can
reuse an established adapter pattern rather than invent one. **Research and writeup only — no schema, storage
code, or `local-store.js` shape changes here; the recommendation is non-binding.** It intentionally does not
contradict the AMS Cloud Readiness architecture / reuse-boundary spec; where that spec later lands, it governs.

## Summary

**Recommendation (non-binding): adopt ORB's existing `SqliteDriver` adapter seam (`src/selfhost/d1-adapter.ts`
+ `src/selfhost/pg-adapter.ts`) rather than inventing a new one, and lead with managed Postgres for the hosted
tenant datastore, keeping Cloudflare D1 as the edge-native alternative.** ORB already abstracts *D1 or Postgres*
behind one async, D1-shaped interface (`prepare().bind().all()/.first()/.run()/.batch()`), with a
SQLite→Postgres SQL translator (`pg-dialect`), so AMS does not need a bespoke abstraction.

Two properties of AMS's current access patterns dominate the decision:

1. **AMS uses interactive, read-then-conditional-write transactions** — `portfolio-queue.js`'s `batchClaim`
   (`BEGIN IMMEDIATE` → read active rows → per-row conditional claim → `COMMIT`, `lib/portfolio-queue.js:334-351`)
   and `attempt-log.js:145-165`. **Postgres supports this natively** (a pinned `PoolClient`, real transactions —
   `pg-adapter.ts:56` `runOn(client)`); **D1 does not** — it offers only an atomic `batch()` of *predetermined*
   statements, so the read result cannot drive the writes inside one transaction. This is the single
   backend-specific rework cost, and it is **larger for D1 than for Postgres**.
2. **The `DatabaseSync` API is synchronous; every hosted backend is async.** Converting the stores and their
   callers from sync `.prepare().run()/.get()/.all()` to `await` is the dominant, backend-independent migration
   cost. ORB's `SqliteDriver` keeps a synchronous `query()` core with async `all()/run()/first()` wrappers
   (`d1-adapter.ts:20-26`), which bounds the change to the store layer's own call sites.

A KV / document store is a poor fit and is **not recommended**: AMS's correctness relies on relational,
single-statement atomicity (conditional `UPDATE … RETURNING`, composite-key `ON CONFLICT`) that KV cannot
express without app-level optimistic-concurrency scaffolding.

## What the datastore must support — AMS's actual access patterns

Enumerated from the stores (`lib/local-store.js`, `run-state.js`, `claim-ledger.js`, `portfolio-queue.js`,
`event-ledger.js`, `governor-state.js`), each with the property a replacement must preserve:

1. **Synchronous open + access (`DatabaseSync`).** `openLocalStoreDb` (`local-store.js:45-51`) does
   `new DatabaseSync(path)`, `mkdirSync(…, 0o700)` + `chmodSync(…, 0o600)`, `PRAGMA busy_timeout`. Every store
   call is synchronous. **A hosted backend is async → the store layer and its callers must become async.**
2. **Race-free single-statement claims.** Claims use `INSERT … ON CONFLICT … DO UPDATE … WHERE status <>
   'in_progress'` and atomic `UPDATE … WHERE rowid = (SELECT … ORDER BY priority DESC … LIMIT 1) RETURNING *`
   (portfolio-queue dequeue; `claim-ledger.js` `INSERT OR IGNORE` / `ON CONFLICT`). No read-then-write. **Needs
   single-statement conditional writes with `RETURNING`.**
3. **Interactive multi-statement transactions.** `batchClaim` and `attempt-log` use `BEGIN IMMEDIATE` → read →
   conditional per-row writes → `COMMIT`/`ROLLBACK`. **Needs interactive transactions** (see Summary #1).
4. **Append-only ledgers with a stable total order.** `event-ledger`/`claim-ledger` use
   `id INTEGER PRIMARY KEY AUTOINCREMENT` and sequential `seq`-based reads. **Needs a monotonic sequence and
   ordered range reads.**
5. **In-place schema migrations.** `schema-version.js` gates migrations on `PRAGMA user_version`; PK reshapes
   are done by *table rebuild* ("SQLite cannot ALTER a PRIMARY KEY in place", governor-state / claim-ledger
   `_v2`/`_v3` rebuilds). **A shared RDBMS replaces `user_version` with a real migration model and alters keys
   in place; the rebuild dance disappears.**
6. **A proto-tenant scope key already exists.** Every store was widened to composite keys prefixed by
   `api_base_url` (forge scoping, #5563): `PRIMARY KEY (api_base_url, repo_full_name, identifier)`,
   `UNIQUE (api_base_url, repo_full_name, issue_number)`. **This is the natural insertion point for a
   `tenant_id` column** — tenant scoping extends an existing composite-key pattern rather than adding a new axis.
7. **Machine-local lease liveness.** Stuck in-flight rows are reclaimed by age via `leased_at` (plus PID-liveness
   elsewhere). **A hosted, multi-worker service must reclaim by lease *expiry time*, not by a local PID** —
   independent of backend, but it interacts with #3's transaction model.
8. **Single-writer, file-per-machine concurrency.** `PRAGMA busy_timeout` + one file per process is the current
   concurrency model. **A shared datastore introduces genuine cross-worker concurrency**, which is exactly why
   the atomic-claim (#2) and interactive-transaction (#3) guarantees must be preserved, not weakened.

## Backend options

Each evaluated against the patterns above (not generic pros/cons).

### Option A — Managed Postgres (via ORB's `pg-adapter.ts`) — *recommended lead*

- **Interactive transactions (#3):** native — `pg-adapter.ts` runs a `batch` on a pinned `PoolClient`
  (`runOn(client)`, `:56-65`); real `BEGIN … COMMIT` with read-then-write inside. Best fit for `batchClaim`.
- **Single-statement claims (#2):** native `INSERT … ON CONFLICT … RETURNING` and conditional `UPDATE …
  RETURNING`. SQLite→Postgres differences (e.g. `RETURNING *`, autoincrement→`GENERATED`/`SERIAL`,
  boolean/text affinity) are handled by the existing `translateSql`/`translateDdl` (`pg-dialect`).
- **Append-only order (#4):** `BIGSERIAL`/identity + `ORDER BY` — direct.
- **Migrations (#5):** real DDL migrations; PK reshapes in place — the `_v2/_v3` rebuild dance is retired.
- **Tenant scope (#6):** add `tenant_id` to the existing composite keys; optional row-level security.
- **Cost:** the async refactor (universal) + SQL-dialect coverage (mostly already in `pg-dialect`). Highest
  operational weight (a managed PG instance), but the strongest correctness match to AMS's claim/lease semantics.

### Option B — Cloudflare D1 (via ORB's `d1-adapter.ts`) — *edge-native alternative*

- **SQL compatibility:** D1 *is* SQLite, so AMS's SQL and `PRAGMA`-adjacent shapes port with the least
  rewriting; ORB's `SqliteDriver`/`Statement` is D1-shaped already.
- **Interactive transactions (#3):** **not supported** — D1 offers atomic `batch()` of predetermined
  statements only. `batchClaim`'s read-then-conditional-write must be **reworked** to either a single
  conditional `UPDATE … RETURNING` per claim or an optimistic-concurrency loop. This is the main D1-specific cost.
- **Single-statement claims (#2):** supported (`INSERT … ON CONFLICT`, `UPDATE … RETURNING`).
- **Tenant scope (#6):** either a `tenant_id` column or per-tenant database; per-DB size/write limits and the
  lack of interactive transactions make it better for smaller/edge tenants than for the busiest.
- **Cost:** async refactor (universal) + rework of the interactive-transaction claim paths (#3). Lowest SQL
  translation cost, highest transaction-model cost.

### Option C — KV / document store (Workers KV, DynamoDB-style) — *not recommended*

- **Atomicity (#2, #3):** no relational single-statement conditional writes and no general multi-key
  transactions; the ordered-priority dequeue and `ON CONFLICT` claim would need app-level optimistic
  concurrency / conditional-put scaffolding, re-implementing what the RDBMS gives for free — and risking the
  exact double-claim races the current `INSERT … ON CONFLICT` design was built to prevent.
- **Append-only order (#4):** no server-assigned monotonic sequence; requires an external counter.
- **Verdict:** a semantic mismatch with AMS's relational, atomic-claim core. Not pursued further.

### Fit matrix

| AMS pattern | Postgres | D1 | KV/document |
|---|---|---|---|
| Interactive txn `batchClaim` (#3) | native | **rework (batch-only)** | not viable |
| Single-statement claim + `RETURNING` (#2) | native (via translate) | native | app-level only |
| Append-only monotonic order (#4) | native | native | external counter |
| In-place migrations / PK reshape (#5) | native | SQLite-style | n/a |
| Tenant scope via composite key (#6) | column + optional RLS | column or per-tenant DB | key-prefix only |
| SQL rewrite cost | medium (`pg-dialect`) | **lowest** | n/a |
| Async refactor cost (#1) | required | required | required |

## Migration cost (backend-independent + per-option)

- **Universal:** `DatabaseSync` (sync) → async adapter converts every store method and caller to `await`
  (#1). Bounding this to the store layer via the `SqliteDriver` seam is the main lever to keep it tractable.
- **Postgres-specific:** SQL-dialect coverage — largely already implemented in `pg-dialect` (`translateSql`,
  `translateDdl`); verify AMS-only constructs (e.g. `PRAGMA busy_timeout`, `RETURNING *`, `AUTOINCREMENT`).
- **D1-specific:** rework the interactive-transaction claim paths (`batchClaim`, `attempt-log`) into D1's
  atomic `batch()` or a single conditional statement — the largest single behavioral change.

## Tenant-scoping fit

All three inherit AMS's existing `api_base_url` composite-key scoping (#5563) as the seam: add `tenant_id`
alongside it. Postgres additionally offers row-level security for defense-in-depth; D1 can alternatively give
each tenant its own database (strong isolation, at the cost of cross-tenant queries and per-DB limits). The
lease-liveness reclaim (#7) must move from machine/PID-local to lease-expiry-by-time for any shared backend.

## Consistency with ORB's adapter precedent

ORB already ships the exact seam AMS should reuse: `SqliteDriver` (`d1-adapter.ts:20`) with a `Statement` that
exposes `prepare/bind/all/first/run/raw/batch` and a `pg-adapter.ts` implementing the same surface over a PG
pool with `translateSql`/`translateDdl`. Reusing this means AMS gets **D1-or-Postgres behind one interface**
for free, and the follow-up design issue chooses the deployment target without a second abstraction. The
recommendation here — Postgres-lead, D1-alternative, KV-excluded — is a non-binding input to that
maintainer-owned design issue.
