# Global-singleton state audit — AMS miner (tenant-leak risk)

Enumeration of every module in `packages/loopover-miner/lib` and `packages/loopover-engine/src/miner`
that holds process-wide or file-scoped **singleton** state (default stores, kill switches, caches,
process-lifecycle registries), with the risk each would pose if the same code ran as a shared hosted
service across multiple tenants. This is the findings deliverable for **#5218**; it is the AMS
counterpart to ORB's own #4885–#4893 sweep. **Audit and documentation only** — this doc fixes nothing;
every confirmed leak gets its own follow-up issue.

> The paths below are the post-rebrand names: `packages/loopover-miner` and
> `packages/loopover-engine` are what #5218 refers to as `packages/gittensory-miner` and
> `packages/gittensory-engine`.

## Risk-rating key

- **leaks across tenants** — process-wide/file-scoped state that would mix or expose one tenant's data
  to another in a shared process; must be tenant-scoped before hosting.
- **needs redesign** — a control whose very shape (a single global boolean/flag) has no per-tenant
  concept and cannot be tenant-scoped by a config key alone.
- **safe as-is** — process-scoped state that holds no tenant data (immutable constants, infra caches,
  signal handlers, operator-global knobs).

## Summary

The miner's local persistence layer is **built around per-process singletons over one machine-local
SQLite file per store**, resolved from a single config dir with **no tenant concept anywhere in the
path** (`resolveLocalStoreDbPath`, `local-store.js:16` — env var → `LOOPOVER_MINER_CONFIG_DIR` →
`XDG_CONFIG_HOME`/`~/.config/loopover-miner/`, no tenant parameter). This is correct for the
single-operator/single-machine design it was built for, but it means **every `default*` store singleton
and the global kill-switch would collapse all tenants onto shared state** in a hosted multi-tenant
process. Findings fall into three groups:

1. **Default-store singletons (leaks across tenants)** — ~13 modules each keep a module-scoped
   `let default* = null` lazily initialized to one SQLite handle on one shared file, reused via a
   `getDefault*()` / `closeDefault*()` accessor. Two tenants in one process share the handle and the
   file → cross-tenant read/write of queues, claims, ledgers, run-state, plans, predictions.
2. **Global kill-switch (needs redesign)** — `LOOPOVER_MINER_KILL_SWITCH` is a single process-env
   boolean (the #5218 seed example), with no per-tenant key: one tenant's flag halts (or fails to halt)
   all tenants.
3. **Process-scoped state with no tenant data (safe as-is)** — the logger, the process-lifecycle cleanup
   registry, and the tree-sitter / module-resolution caches are per-process but hold no tenant data.

The governor rate-limit / chokepoint / throttle modules hold **no** in-memory counters of their own —
they are pure functions over the persisted stores above, so their tenant-safety is entirely inherited
from group (1)'s store scoping and they add no separate leak surface.

## Findings by module

### Group 1 — default-store singletons (risk: **leaks across tenants**)

Each holds a module-scoped `let default* = null` reused process-wide via a `getDefault*()`/`closeDefault*()`
accessor (pattern confirmed at `claim-ledger.js:268/299`, `portfolio-queue.js:383/412`), backed by one
SQLite file whose path comes from `resolveLocalStoreDbPath` with no tenant key.

| Module | Singleton (line) | Backing DB env var (default `~/.config/loopover-miner/…`) |
| --- | --- | --- |
| `lib/portfolio-queue.js` | `defaultPortfolioQueueStore` (14) | `LOOPOVER_MINER_PORTFOLIO_QUEUE_DB` |
| `lib/claim-ledger.js` | `defaultClaimLedger` (16) | `LOOPOVER_MINER_CLAIM_LEDGER_DB` |
| `lib/event-ledger.js` | `defaultEventLedger` (24) | `LOOPOVER_MINER_EVENT_LEDGER_DB` |
| `lib/governor-state.js` | `defaultGovernorState` (26) | `LOOPOVER_MINER_GOVERNOR_STATE_DB` |
| `lib/governor-ledger.js` | `defaultGovernorLedger` (23) | (via shared `local-store` resolver) |
| `lib/run-state.js` | `defaultRunStateStore` (9) | `LOOPOVER_MINER_RUN_STATE_DB` |
| `lib/ranked-candidates.js` | `defaultRankedCandidatesStore` (21) | `LOOPOVER_MINER_RANKED_CANDIDATES_DB` |
| `lib/attempt-log.js` | `defaultAttemptLog` (15) | `LOOPOVER_MINER_ATTEMPT_LOG_DB` |
| `lib/plan-store.js` | `defaultPlanStore` (21) | (via shared `local-store` resolver) |
| `lib/prediction-ledger.js` | `defaultPredictionLedger` (24) | (via shared `local-store` resolver) |
| `lib/replay-snapshot.js` | `defaultDb` (35) | `LOOPOVER_MINER_REPLAY_SNAPSHOT_DB` |
| `lib/policy-doc-cache.js` | default cache singleton | `LOOPOVER_MINER_POLICY_DOC_CACHE_DB` |
| `lib/policy-verdict-cache.js` | default cache singleton | `LOOPOVER_MINER_POLICY_VERDICT_CACHE_DB` |
| `lib/worktree-allocator.js` | `defaultWorktreeAllocator` (13) | filesystem worktree root (not a DB, but same singleton shape) |

**Risk if hosted:** in a shared process, all tenants resolve to the same singleton + same file. Tenant B
would read/mutate tenant A's portfolio queue, claim ledger, event/governor ledgers, run-state, plans,
and prediction history. `worktree-allocator`'s shared root would additionally let tenants collide on (or
observe) each other's on-disk worktrees.

**Remediation category:** tenant-scope the path resolver (a tenant key in `resolveLocalStoreDbPath`) and
key the singleton cache by tenant instead of a single module-global — a redesign of the store lifecycle,
not a per-module fix. *Any such follow-up that changes how tenant data is partitioned must be
maintainer-reviewed before it is labeled contributor-eligible (per #5218's own boundary and the bar ORB
applied to #4885).*

### Group 2 — global kill-switch (risk: **needs redesign**)

| Location | State | Note |
| --- | --- | --- |
| `lib/governor-kill-switch.js:8,10,25,26` | imports/uses `isGlobalMinerKillSwitch` + `resolveMinerKillSwitch` | The miner-side entry point; holds no state itself, resolves from the engine. |
| `packages/loopover-engine/src/governor/kill-switch.ts:19,31` | `MINER_KILL_SWITCH_ENV_VAR = "LOOPOVER_MINER_KILL_SWITCH"`, resolved as a single process-env boolean | The confirmed #5218 seed example: a **global** switch with no per-tenant key. |

**Risk if hosted:** the kill-switch is process-global. One tenant setting it halts every tenant sharing
the process; conversely no single tenant can be independently halted. This is not a scoping bug fixable
by a config key — the control has no per-tenant dimension and needs a redesigned per-tenant switch.
**This item is trust/safety-relevant and must remain maintainer-owned**, exactly as ORB's #4885
kill-switch redesign was, rather than opened as a generic contributor task.

## Safe as-is — process-scoped, no tenant data

Checked and confirmed to hold no tenant data; called out so follow-ups don't chase them:

- **`lib/logger.js:156` `processLogger`** — a process-wide logger whose only global input is
  `LOOPOVER_MINER_LOG_LEVEL` (an operator knob, not tenant data). The *content* written through it could
  carry tenant data, but that is a telemetry/redaction concern owned by **#5219**, not a singleton-state
  leak. Cross-referenced, not double-counted here.
- **`lib/process-lifecycle.js:16,17` `cleanupResources` (Set) + `handlersInstalled` (bool)** — a
  process-wide cleanup registry and an install-once guard for SIGTERM/SIGINT handlers. Process-scoped by
  design; holds resource references for shutdown, no tenant data.
- **`packages/loopover-engine/src/miner/repo-map.ts:29,102` `cachedRequire` / `parserInitialized`** —
  tree-sitter parser/WASM initialization singletons. Stateless shared infrastructure (a parser is
  identical for every tenant); no tenant data.
- **`lib/status.js:32,36` `cachedRequire` / `cachedModuleDir`** — module-resolution caches; no tenant
  data.
- **Immutable validation vocabularies** — the frozen `new Set(...)` status/enum sets in `plan-store.js`
  (18/19/65), `pr-outcome.js` (20/21), `run-state.js` (7), `laptop-init.js` (10),
  `policy-verdict-cache.js` (18), etc. are read-only constants, not mutable shared state.

## Prioritized follow-up seeds (each its own issue; trust/safety ones maintainer-owned)

- [ ] **High — tenant-scope the local-store lifecycle (Group 1):** add a tenant key to
  `resolveLocalStoreDbPath` (`local-store.js:16`) and key each `default*` singleton by tenant rather than
  a single module-global, so no two tenants share a store handle or file. One design issue covering all
  ~13 stores (they share the resolver), then per-store wiring. **Maintainer-reviewed** (tenancy boundary).
- [ ] **High — per-tenant kill-switch (Group 2):** redesign `LOOPOVER_MINER_KILL_SWITCH` into a
  per-tenant control so one tenant can be halted without halting others. **Maintainer-owned** trust/safety
  work (mirrors ORB #4885).
- [ ] **Cross-ref — telemetry/log content (out of scope here):** the tenancy of data *written through*
  `processLogger` and the export surfaces is #5219's privacy pass, not a singleton-state leak.
- [ ] **Confirm — `worktree-allocator` root partitioning:** its shared worktree root belongs to the
  Group 1 redesign (per-tenant root) even though it is filesystem- rather than SQLite-backed.
