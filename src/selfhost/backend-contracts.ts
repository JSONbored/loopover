// Shared structural contracts for the self-host runtime's three swappable-backend pairs (#4010): the durable
// job queue (sqlite-queue.ts / pg-queue.ts), the D1-shaped storage adapter (d1-adapter.ts / pg-adapter.ts),
// and the Vectorize-shaped RAG vector store (vectorize.ts / qdrant-vectorize.ts / pg-vectorize.ts). Before
// this file, each pair either declared its own independent interface reconciled only by a loose
// `T | Promise<T>` union at the call site (the queue pair -- see DurableQueue below), or force-cast a bare
// object literal straight to one of Cloudflare's ambient bindings (D1Database, Vectorize -- both
// `declare abstract class` in worker-configuration.d.ts, so a plain object literal can only ever satisfy them
// via `as unknown as X`; there is no way to avoid that final cast) with nothing checking the literal's OWN
// shape first, so either side could silently drift from its sibling with nothing to catch it.
//
// Every interface here is the actual subset each pair's concrete implementations already satisfy. Each
// backend module assigns its returned object to one of these types BEFORE the unavoidable ambient-binding
// cast, so a future change that breaks parity between two (or three) implementations is a compile error here
// instead of a runtime surprise discovered on whichever backend the change didn't touch.
import type { DeadLetterJob, SelfHostQueueSnapshot } from "./queue-common";
import type { MaintenancePressureSignals } from "./maintenance-admission";
import type { BacklogRepoCount } from "./queue-fairness";

// ── Queue pair (sqlite-queue.ts createSqliteQueue / pg-queue.ts createPgQueue) ──────────────────────────────
// Previously two independently-declared interfaces (DurableQueue, PgDurableQueue): every method that was
// synchronous on the sqlite side was Promise-wrapped on the postgres side, and PgDurableQueue alone had an
// extra `init()`. Unified here as a strict superset of the (former) sqlite shape -- every method returns a
// Promise, since node:sqlite's synchronous calls await trivially, whereas making the postgres side
// synchronous is not possible for a real network client.
export interface DurableQueue {
  binding: Queue;
  /** One-time async setup (schema DDL, column backfills, crash recovery, startup jitter, the foreground-
   *  liveness self-heal) that MUST complete before `start()`/`binding.send()` are used. The postgres backend
   *  genuinely awaits `pool.query(...)` for its schema DDL here. The sqlite backend performs the equivalent
   *  setup SYNCHRONOUSLY inside `createSqliteQueue()` itself (node:sqlite has no connection to await), so by
   *  the time that factory returns, setup is already done -- its `init()` is a no-op that resolves
   *  immediately. Callers that treat both backends uniformly (`await createXQueue(...).init()`) get correct
   *  behavior either way. */
  init(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
  drain(): Promise<void>;
  size(): Promise<number>;
  deadCount(): Promise<number>;
  /** Jobs currently claimed and mid-flight (status='processing') -- distinct from size(), which also
   *  includes still-pending work. See #selfhost-queue-liveness's own observability additions. */
  processingCount(): Promise<number>;
  stats(): Promise<Record<string, number>>;
  snapshot(): Promise<SelfHostQueueSnapshot>;
  /** Live-vs-maintenance queue pressure, for the /metrics gauges (see server.ts) -- the SAME signals the
   *  maintenance-admission policy itself consults at claim time. */
  pressureSignals(): Promise<MaintenancePressureSignals>;
  /** Requeues dead-lettered jobs still under the auto-retry attempts ceiling. Called on a timer while
   *  running (see start()), and exposed directly so tests and an operator-triggered repair path don't have
   *  to wait for the real interval. Returns the number of jobs revived. */
  reviveDeadLetterJobs(): Promise<number>;
  /** Foreground-liveness invariant (#selfhost-queue-liveness): pulls back any FOREGROUND-priority pending job
   *  whose deferral has gone stale (see foreground-liveness.ts) regardless of what deferred it. Called once at
   *  boot and on a timer while running, and exposed directly so tests and an operator-triggered repair path
   *  don't have to wait for the real interval. Returns the number released. */
  releaseStaleForegroundDeferrals(): Promise<number>;
  /** Top-N repos by backlog-convergence pending depth, for the observability dashboard's per-repo backlog panel
   *  (#selfhost-lane-observability). */
  topBacklogRepos(limit: number): Promise<BacklogRepoCount[]>;
  /** Paginated dead-letter rows, newest-death-first, for the DLQ dashboard table (#2214). Also mirrored onto
   *  `binding` (see queue-common.ts's SelfHostQueueDeadLetterAdmin) so Hono routes can reach it via env.JOBS. */
  listDeadLetterJobs(limit: number, offset: number): Promise<DeadLetterJob[]>;
  /** Manual, operator-initiated replay of ONE dead job with a FRESH retry budget (#2215) -- unlike the automatic
   *  reviveDeadLetterJobs() sweep above, which deliberately preserves `attempts` under a ceiling. */
  replayDeadLetterJob(id: number): Promise<boolean>;
  /** Manual, operator-initiated permanent delete of ONE dead job (#2215). */
  deleteDeadLetterJob(id: number): Promise<boolean>;
  /** Manual, operator-initiated permanent delete of EVERY dead job (#2215). */
  purgeDeadLetterJobs(): Promise<number>;
}

// ── Storage adapter pair (d1-adapter.ts createD1Adapter / pg-adapter.ts createPgAdapter) ────────────────────
// The actual subset of Cloudflare's ambient D1Database both adapters really satisfy -- notably NOT
// `withSession()`, which neither implements (self-host is single-primary; there is no replica to anchor a
// session against). `run()` is typed WITHOUT a `results` field (matching pg-adapter.ts's own D1Response-
// faithful shape and the real D1 contract, where a non-SELECT statement carries no meaningful results);
// d1-adapter.ts's own `run()` happens to return a wider object that also carries `results`, which remains
// assignable here since an implementation may always return MORE than an interface requires.
export interface SelfHostD1PreparedStatement {
  bind(...values: unknown[]): SelfHostD1PreparedStatement;
  all<T = unknown>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }>;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run(): Promise<{ success: true; meta: Record<string, unknown> }>;
  raw<T = unknown>(): Promise<T[]>;
}

export interface SelfHostD1Database {
  prepare(query: string): SelfHostD1PreparedStatement;
  batch(statements: SelfHostD1PreparedStatement[]): Promise<Array<{ results: unknown[]; success: true; meta: Record<string, unknown> }>>;
  exec(query: string): Promise<{ count: number; duration: number }>;
  /** @deprecated present only because both self-host adapters still implement it for D1 surface completeness;
   *  real D1 no longer uses it either (see d1-adapter.ts / pg-adapter.ts). */
  dump(): Promise<ArrayBuffer>;
}

// ── Vectorize pair (vectorize.ts createSqliteVectorize / qdrant-vectorize.ts createQdrantVectorize /
//    pg-vectorize.ts createPgVectorize) ──────────────────────────────────────────────────────────────────────
// Each backend previously redeclared its own private copy of these three shapes, and only vectorize.ts's
// QueryOptions carried `returnMetadata` -- a real divergence, not a stylistic one: every backend is invoked
// through the SAME reviewVectorAdapter → vectorize.query(vector, opts) call path (src/review/adapters.ts),
// and src/review/rag.ts's own opts ALWAYS includes `returnMetadata: "all"` regardless of which backend is
// bound to env.VECTORIZE. So every backend genuinely receives this option today; the field belongs on all
// three, not none. None of the three currently branches on it -- each already returns whatever metadata it
// has stored for a match regardless of the requested retrieval level, which is a conservative behavior
// already compatible with "all" -- so adding it to the other two is a type-honesty fix (the type now matches
// what the function is actually called with), not a behavior change. The type is tightened from
// vectorize.ts's previous loose `string` to the real three-value union Cloudflare's own
// VectorizeQueryOptions.returnMetadata uses (worker-configuration.d.ts).
export interface SelfHostVectorRecord {
  id: string;
  values: number[];
  namespace?: string;
  metadata?: Record<string, unknown>;
}

export interface SelfHostVectorizeQueryOptions {
  topK?: number;
  namespace?: string;
  returnMetadata?: "all" | "none" | "indexed";
}

export interface SelfHostVectorizeMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface SelfHostVectorize {
  upsert(vectors: SelfHostVectorRecord[]): Promise<{ count: number; ids: string[] }>;
  query(vector: number[], opts: SelfHostVectorizeQueryOptions): Promise<{ matches: SelfHostVectorizeMatch[] }>;
  deleteByIds(ids: string[]): Promise<{ count: number }>;
}
