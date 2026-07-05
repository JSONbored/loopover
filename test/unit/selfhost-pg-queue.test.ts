// Unit tests for the Postgres-backed job queue (#977). Mocks pg.Pool so no real DB is needed.
// Real-Postgres integration paths (migrations, pg-adapter translation) live in test/integration/selfhost-pg.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, QueryResult } from "pg";
import { createPgQueue } from "../../src/selfhost/pg-queue";
import { queueSnapshotFromBinding } from "../../src/selfhost/queue-common";
import { renderMetrics, resetMetrics } from "../../src/selfhost/metrics";
import { RetryableJobError } from "../../src/queue/retryable";
import { hostLoadAvg1PerCore } from "../../src/selfhost/host-pressure";
import * as sentryModule from "../../src/selfhost/sentry";
import type { JobMessage } from "../../src/types";

// Real host CPU load is nondeterministic (and can legitimately spike on a busy CI runner), so every
// maintenance-admission test in this file would be flaky against the real node:os signal. Default to
// "unavailable" (null, never gates) here; individual host-load tests override the mock explicitly.
vi.mock("../../src/selfhost/host-pressure", () => ({ hostLoadAvg1PerCore: vi.fn(() => null) }));

const msg = (t: string): JobMessage => ({ type: t }) as unknown as JobMessage;
const webhook = (sender: { login: string; type: string }, eventName = "issue_comment", action = "edited"): JobMessage =>
  ({
    type: "github-webhook",
    deliveryId: "webhook-delivery",
    eventName,
    payload: { action, sender },
  }) as unknown as JobMessage;
const ciWebhook = (deliveryId: string, eventName: "check_suite" | "check_run" = "check_suite", sha = "b".repeat(40)): JobMessage =>
  ({
    type: "github-webhook",
    deliveryId,
    eventName,
    payload: {
      action: "completed",
      repository: { full_name: "JSONbored/gittensory" },
      [eventName]: { head_sha: sha, pull_requests: [{ number: 1629 }] },
    },
  }) as unknown as JobMessage;
const installedWebhook = (deliveryId: string, installationId: number): JobMessage =>
  ({
    type: "github-webhook",
    deliveryId,
    eventName: "pull_request",
    payload: {
      action: "synchronize",
      installation: { id: installationId },
      repository: { full_name: "JSONbored/gittensory" },
      pull_request: { number: 1629, head: { sha: "c".repeat(40) } },
    },
  }) as unknown as JobMessage;
const regateJob = (installationId: number | null, prNumber = 1629): JobMessage =>
  ({
    type: "agent-regate-pr",
    deliveryId: `sweep:jsonbored/gittensory#${prNumber}`,
    repoFullName: "jsonbored/gittensory",
    prNumber,
    ...(installationId === null ? {} : { installationId }),
  }) as unknown as JobMessage;
const typeOf = (m: JobMessage): string => (m as unknown as { type: string }).type;

type MockFn = { mockResolvedValueOnce(v: unknown): void };

interface MockPool {
  pool: Pool;
  fn: MockFn;
  enqueueResult(r: Partial<QueryResult>): void;
  /** Pre-load a job to be returned by the next RETURNING claim query. */
  enqueueJob(id: string, payload: object, attempts?: number, jobKey?: string | null): void;
  setDeferUpdateRowCount(rowCount: number): void;
  /** Queues per-call rowCounts for the "AND status='dead'" revive UPDATE, one entry consumed per call in order
   *  (default 1 when the queue is empty) — lets a test simulate an overlapping reviver already winning the race
   *  on a specific row (rowCount 0) while another succeeds (rowCount 1). */
  setReviveUpdateRowCounts(rowCounts: number[]): void;
  setRateLimitRows(rows: Array<{ admission_key?: string | null; repo_full_name?: string | null; remaining: number | string | null; reset_at: string | null; observed_at?: string | null }>): void;
  /** Configures the four maintenance-admission pressure aggregate queries (live + maintenance + backlog-
   *  convergence + fresh-intake lane). Defaults to zero pending / null oldest in all lanes (pressure clear)
   *  until set. `runnableCnt`/`oldestRunnable` back the #selfhost-queue-liveness runnable-now split (see
   *  maintenancePressureSignals's FILTER columns); they default to 0/null (nothing runnable) so existing tests
   *  that never set them keep working. */
  setPressureSignals(signals: {
    live?: { cnt: number; oldest: number | null; runnableCnt?: number; oldestRunnable?: number | null };
    maintenance?: { cnt: number; oldest: number | null };
    backlogConvergence?: { cnt: number };
    freshIntake?: { cnt: number };
  }): void;
  /** Programs the exact rows returned by releaseStaleForegroundDeferrals' candidate SELECT (both the oldest-
   *  and newest-ordered windows, see setForegroundLivenessCandidatesByWindow's doc comment for why there are
   *  two), and the per-row rowCount its conditional UPDATE reports (defaults to 1 -- the row still matched at
   *  UPDATE time -- when not otherwise queued). `payload` defaults to a "recapture-preview" message -- a
   *  foreground type NOT in GITHUB_BUDGET_BACKGROUND_TYPES / not "github-webhook"/"agent-regate-pr" -- so
   *  githubRateLimitAdmissionTargetForJob returns null for it and the rate-limit-clear OR-condition is
   *  trivially/always true, isolating the AGE condition cleanly for tests that aren't specifically about
   *  rate-limit clearing. Pass an explicit `payload` (e.g. a github-webhook message) plus `setRateLimitRows`
   *  to test the rate-limit-clear condition itself, or "not valid json" to test the unparseable-payload path. */
  setForegroundLivenessCandidates(
    rows: Array<{ id: string; created_at: number; payload?: string }>,
    updateRowCounts?: number[],
  ): void;
  /** Like setForegroundLivenessCandidates, but programs the OLDEST-ordered and NEWEST-ordered candidate windows
   *  independently (#selfhost-queue-liveness clear-bucket starvation fix) -- releaseStaleForegroundDeferrals now
   *  issues two real, differently-bounded queries (`ORDER BY created_at ASC LIMIT` and `... DESC LIMIT`) so a
   *  large glut of older still-blocked rows can never fill the ONLY candidate window and hide a newer
   *  clear-bucket row from it. This mock doesn't apply real SQL LIMIT/ORDER BY semantics (setForegroundLivenessCandidates
   *  above just returns the same configured array for both windows), so a test that needs to prove the two
   *  windows are genuinely independent -- i.e. a candidate present in one window but not the other -- must use
   *  this instead. */
  setForegroundLivenessCandidatesByWindow(
    oldestRows: Array<{ id: string; created_at: number; payload?: string }>,
    newestRows: Array<{ id: string; created_at: number; payload?: string }>,
    updateRowCounts?: number[],
  ): void;
}

function makePool(): MockPool {
  const results: Partial<QueryResult>[] = [];
  let deferUpdateRowCount = 1;
  const reviveUpdateRowCounts: number[] = [];
  let rateLimitRows: Array<{ admission_key?: string | null; repo_full_name?: string | null; remaining: number | string | null; reset_at: string | null; observed_at?: string | null }> = [];
  let pressureLive: { cnt: number; oldest: number | null; runnableCnt?: number; oldestRunnable?: number | null } = {
    cnt: 0,
    oldest: null,
  };
  let pressureMaintenance: { cnt: number; oldest: number | null } = { cnt: 0, oldest: null };
  let pressureBacklogConvergence: { cnt: number } = { cnt: 0 };
  let pressureFreshIntake: { cnt: number } = { cnt: 0 };
  let foregroundLivenessOldestCandidates: Array<{ id: string; created_at: number; payload?: string }> = [];
  let foregroundLivenessNewestCandidates: Array<{ id: string; created_at: number; payload?: string }> = [];
  const foregroundLivenessUpdateRowCounts: number[] = [];
  const DEFAULT_FOREGROUND_LIVENESS_PAYLOAD = JSON.stringify({
    type: "recapture-preview",
    deliveryId: "seed",
    repoFullName: "o/r",
    prNumber: 1,
    attempt: 1,
  });
  const fn = vi.fn().mockImplementation(async (sql: unknown, params?: unknown[]) => {
    const q = String(sql);
    if (q.includes("SELECT id, payload, created_at FROM") && q.includes("priority>=$1 AND run_after>$2")) {
      // #selfhost-queue-liveness clear-bucket starvation fix: releaseStaleForegroundDeferrals issues an OLDEST-
      // ordered window and a NEWEST-ordered window as two independent queries -- match on ORDER BY direction so
      // setForegroundLivenessCandidatesByWindow can program them differently (setForegroundLivenessCandidates
      // programs both windows identically, matching this repo's other tests that don't care about the split).
      const rows = q.includes("ORDER BY created_at DESC") ? foregroundLivenessNewestCandidates : foregroundLivenessOldestCandidates;
      return {
        rows: rows.map((row) => ({
          id: row.id,
          payload: row.payload ?? DEFAULT_FOREGROUND_LIVENESS_PAYLOAD,
          created_at: row.created_at,
        })),
        rowCount: rows.length,
      };
    }
    if (q.includes("SET run_after=$1 WHERE id=$2 AND status='pending' AND run_after>$1")) {
      const rowCount =
        foregroundLivenessUpdateRowCounts.length > 0 ? (foregroundLivenessUpdateRowCounts.shift() ?? 1) : 1;
      return { rows: [], rowCount };
    }
    if (q.includes("AS cnt, MIN(created_at) AS oldest")) {
      const signal = q.includes("is_maintenance=1") ? pressureMaintenance : pressureLive;
      return {
        rows: [
          {
            cnt: String(signal.cnt),
            oldest: signal.oldest,
            ...(signal === pressureLive
              ? {
                  runnable_cnt: String(pressureLive.runnableCnt ?? 0),
                  oldest_runnable: pressureLive.oldestRunnable ?? null,
                }
              : {}),
          },
        ],
        rowCount: 1,
      };
    }
    if (q.includes("AS cnt") && q.includes("foreground_lane='backlog'")) {
      return { rows: [{ cnt: String(pressureBacklogConvergence.cnt) }], rowCount: 1 };
    }
    if (q.includes("AS cnt") && q.includes("foreground_lane='fresh'")) {
      return { rows: [{ cnt: String(pressureFreshIntake.cnt) }], rowCount: 1 };
    }
    if (q.includes("FROM github_rate_limit_observations")) {
      const admissionKey = typeof params?.[0] === "string" ? params[0] : null;
      const newest = (rows: typeof rateLimitRows) =>
        [...rows].sort((a, b) => {
          const observed = Date.parse(b.observed_at ?? "") - Date.parse(a.observed_at ?? "");
          if (Number.isFinite(observed) && observed !== 0) return observed;
          return 0;
        })[0];
      const rows = [
        ...(admissionKey !== null ? [newest(rateLimitRows.filter((row) => row.admission_key === admissionKey))].filter(Boolean) : []),
        newest(rateLimitRows.filter((row) => row.admission_key === undefined || row.admission_key === null)),
      ].filter(Boolean);
      return { rows, rowCount: rows.length };
    }
    if (q.includes("SET status='pending', run_after=GREATEST")) {
      return { rows: [], rowCount: deferUpdateRowCount };
    }
    if (q.includes("SET status='pending', run_after=$1, last_error=NULL")) {
      const rowCount = reviveUpdateRowCounts.length > 0 ? (reviveUpdateRowCounts.shift() ?? 1) : 1;
      return { rows: [], rowCount };
    }
    // The claim-time fairness sequence allocator (#selfhost-backlog-convergence) ALSO uses RETURNING (atomic
    // UPDATE ... RETURNING, not a separate SELECT-then-UPDATE — see claimNextForegroundLane). It must be
    // matched BEFORE the generic job-claim RETURNING check below, or it would wrongly pop a job row queued via
    // enqueueJob/enqueueResult meant for the real claim query. A harmless fixed default (sequence 0 -> lane
    // "backlog", no repo) lets every pre-existing test that doesn't care about fairness behave exactly as
    // before: the backlog-scoped claim then finds nothing (no candidates SELECT is mocked here), so
    // claimNextForegroundLane returns null and claimNext() falls through to the plain unscoped claim query,
    // which IS the generic RETURNING branch below.
    if (q.includes("_selfhost_queue_fairness") && q.includes("RETURNING")) {
      return { rows: [{ claim_sequence: 0, last_backlog_repo: null }], rowCount: 1 };
    }
    // Claim queries use RETURNING — pop from queue; fall through to empty default otherwise.
    if (q.includes("RETURNING")) {
      const next = results.shift();
      return next ?? { rows: [], rowCount: 0 };
    }
    // COUNT queries need a c column.
    if (q.includes("COUNT(*)")) {
      return { rows: [{ c: "3" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return {
    pool: { query: fn } as unknown as Pool,
    fn: fn as unknown as MockFn,
    enqueueResult(r) { results.push(r); },
    enqueueJob(id, payload, attempts = 0, jobKey = null) {
      results.push({ rows: [{ id, payload: JSON.stringify(payload), attempts, job_key: jobKey }], rowCount: 1 });
    },
    setDeferUpdateRowCount(rowCount) {
      deferUpdateRowCount = rowCount;
    },
    setReviveUpdateRowCounts(rowCounts) {
      reviveUpdateRowCounts.length = 0;
      reviveUpdateRowCounts.push(...rowCounts);
    },
    setPressureSignals(signals) {
      if (signals.live) pressureLive = signals.live;
      if (signals.maintenance) pressureMaintenance = signals.maintenance;
      if (signals.backlogConvergence) pressureBacklogConvergence = signals.backlogConvergence;
      if (signals.freshIntake) pressureFreshIntake = signals.freshIntake;
    },
    setRateLimitRows(rows) {
      rateLimitRows = rows;
    },
    setForegroundLivenessCandidates(rows, updateRowCounts) {
      foregroundLivenessOldestCandidates = rows;
      foregroundLivenessNewestCandidates = rows;
      foregroundLivenessUpdateRowCounts.length = 0;
      if (updateRowCounts) foregroundLivenessUpdateRowCounts.push(...updateRowCounts);
    },
    setForegroundLivenessCandidatesByWindow(oldestRows, newestRows, updateRowCounts) {
      foregroundLivenessOldestCandidates = oldestRows;
      foregroundLivenessNewestCandidates = newestRows;
      foregroundLivenessUpdateRowCounts.length = 0;
      if (updateRowCounts) foregroundLivenessUpdateRowCounts.push(...updateRowCounts);
    },
  };
}

describe("createPgQueue (durable #977)", () => {
  // Suppress audit log stdout noise in tests.
  beforeEach(() => { vi.spyOn(process.stdout, "write").mockImplementation(() => true); });
  afterEach(() => {
    vi.useRealTimers();
    resetMetrics();
    vi.restoreAllMocks();
    vi.mocked(hostLoadAvg1PerCore).mockReturnValue(null);
  });

  it("init() creates the table and recovers stuck-processing jobs", async () => {
    const m = makePool();
    m.fn.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // DDL
    m.fn.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // priority backfill SELECT
    m.fn.mockResolvedValueOnce({ rows: [], rowCount: 2 }); // recovery UPDATE
    const q = createPgQueue(m.pool, async () => undefined);
    await q.init();
    expect(m.pool.query).toHaveBeenCalledWith(expect.stringContaining("CREATE TABLE IF NOT EXISTS _selfhost_jobs"));
    expect(m.pool.query).toHaveBeenCalledWith(expect.stringContaining("status='processing'"));
  });

  it("init() handles null rowCount from the recovery query (rowCount ?? 0 nullish arm)", async () => {
    const m = makePool();
    m.fn.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // DDL
    m.fn.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // priority backfill SELECT
    m.fn.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // job-key backfill SELECT
    // pg driver can return null for some SELECT-ish maintenance results; init must tolerate it.
    m.fn.mockResolvedValueOnce({ rows: [], rowCount: null });
    const q = createPgQueue(m.pool, async () => undefined);
    await q.init(); // rowCount=null → ?? 0 → 0 → no recovery log emitted
    expect(m.pool.query).toHaveBeenCalled();
  });

  it("init() backfills event-aware priorities with the shared classifier", async () => {
    const m = makePool();
    m.fn.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // DDL
    m.fn.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // fairness singleton INSERT
    m.fn.mockResolvedValueOnce({
      rows: [
        { id: "a", payload: JSON.stringify(msg("agent-regate-pr")), priority: 0 },
        { id: "b", payload: JSON.stringify(webhook({ login: "gittensory-orb[bot]", type: "Bot" })), priority: 10 },
        { id: "c", payload: JSON.stringify(msg("agent-regate-sweep")), priority: 0 },
      ],
      rowCount: 3,
    }); // priority backfill SELECT
    m.fn.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // update a
    m.fn.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // update b
    m.fn.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // update c
    m.fn.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // recovery UPDATE
    const q = createPgQueue(m.pool, async () => undefined);
    await q.init();
    expect(m.pool.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE _selfhost_jobs SET priority=$1"), [9, "a"]);
    expect(m.pool.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE _selfhost_jobs SET priority=$1"), [0, "b"]);
    expect(m.pool.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE _selfhost_jobs SET priority=$1"), [8, "c"]);
  });

  it("init() skips already-normalized priority and job-key rows", async () => {
    const priorityUpdateSql = "UPDATE _selfhost_jobs SET priority=$1";
    const jobKeyUpdateSql = "UPDATE _selfhost_jobs SET job_key=$1";
    const claimSortUpdateSql = "UPDATE _selfhost_jobs SET claim_sort_key=$1";
    const fn = vi.fn().mockImplementation(async (sql: unknown, params?: unknown[]) => {
      const q = String(sql);
      if (q.includes("SELECT id, payload, priority")) {
        return {
          rows: [
            { id: "null-priority", payload: JSON.stringify(msg("unknown")), priority: null },
            {
              id: "manual",
              payload: JSON.stringify({
                type: "agent-regate-pr",
                deliveryId: "manual-regate:1",
              }),
              priority: 99,
            },
          ],
          rowCount: 2,
        };
      }
      if (q.includes("SELECT id, payload, job_key") && q.includes("status IN")) {
        return {
          rows: [
            {
              id: "keyed",
              payload: JSON.stringify({
                type: "agent-regate-sweep",
                repoFullName: "JSONbored/gittensory",
              }),
              job_key: "agent-regate-sweep:jsonbored/gittensory",
            },
            { id: "unkeyed", payload: JSON.stringify(msg("unknown")), job_key: null },
          ],
          rowCount: 2,
        };
      }
      if (q.includes("SELECT id, payload, run_after, claim_sort_key")) {
        return {
          rows: [
            {
              id: "sorted",
              payload: JSON.stringify({
                type: "agent-regate-pr",
                deliveryId: "backlog-convergence:owner/repo#7",
                repoFullName: "owner/repo",
                prNumber: 7,
              }),
              run_after: 999,
              claim_sort_key: Date.parse("2000-01-01T00:00:00.000Z") + 7,
            },
          ],
          rowCount: 1,
        };
      }
      if (q.includes("WHERE status='processing'")) return { rows: [], rowCount: 0 };
      if (q.includes("WHERE status='pending' AND run_after<=$1")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    const q = createPgQueue({ query: fn } as unknown as Pool, async () => undefined);

    await q.init();

    expect(fn).not.toHaveBeenCalledWith(
      expect.stringContaining(priorityUpdateSql),
      expect.anything(),
    );
    expect(fn).not.toHaveBeenCalledWith(
      expect.stringContaining(jobKeyUpdateSql),
      expect.anything(),
    );
    expect(fn).not.toHaveBeenCalledWith(
      expect.stringContaining(claimSortUpdateSql),
      expect.anything(),
    );
  });

  it("init() backfills stale PR claim-sort keys while leaving already-normalized rows untouched", async () => {
    const updates: unknown[][] = [];
    const fn = vi.fn().mockImplementation(async (sql: unknown, params?: unknown[]) => {
      const q = String(sql);
      if (q.includes("SELECT id, payload, priority")) return { rows: [], rowCount: 0 };
      if (q.includes("SELECT id, payload, job_key") && q.includes("status IN")) return { rows: [], rowCount: 0 };
      if (q.includes("SELECT id, payload, run_after, claim_sort_key")) {
        return {
          rows: [
            {
              id: "stale",
              payload: JSON.stringify({
                type: "agent-regate-pr",
                deliveryId: "backlog-convergence:owner/repo#12",
                repoFullName: "owner/repo",
                prNumber: 12,
                prCreatedAt: "2026-07-03T12:00:00.000Z",
              }),
              run_after: "999",
              claim_sort_key: 0,
            },
            {
              id: "fresh",
              payload: JSON.stringify({
                type: "agent-regate-pr",
                deliveryId: "backlog-convergence:owner/repo#13",
                repoFullName: "owner/repo",
                prNumber: 13,
              }),
              run_after: "999",
              claim_sort_key: Date.parse("2000-01-01T00:00:00.000Z") + 13,
            },
          ],
          rowCount: 2,
        };
      }
      if (q.includes("UPDATE _selfhost_jobs SET claim_sort_key=$1")) {
        updates.push(params ?? []);
        return { rows: [], rowCount: 1 };
      }
      if (q.includes("WHERE status='processing'")) return { rows: [], rowCount: 0 };
      if (q.includes("WHERE status='pending' AND run_after<=$1")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    const q = createPgQueue({ query: fn } as unknown as Pool, async () => undefined);

    await q.init();

    expect(updates).toEqual([[Date.parse("2026-07-03T12:00:00.000Z"), "stale"]]);
  });

  it("init() backfills job keys, recovers crashed jobs, and spreads due startup backlog", async () => {
    const oldMin = process.env.QUEUE_STARTUP_JITTER_MIN_JOBS;
    const oldJitter = process.env.QUEUE_STARTUP_JITTER_MS;
    const oldRecoveryJitter = process.env.QUEUE_RECOVERY_JITTER_MS;
    process.env.QUEUE_STARTUP_JITTER_MIN_JOBS = "2";
    process.env.QUEUE_STARTUP_JITTER_MS = "60000";
    process.env.QUEUE_RECOVERY_JITTER_MS = "0";
    try {
      const fn = vi.fn().mockImplementation(async (sql: unknown) => {
        const q = String(sql);
        if (q.includes("SELECT id, payload, priority")) return { rows: [], rowCount: 0 };
        if (q.includes("SELECT id, payload, job_key") && q.includes("status IN")) {
          return { rows: [{ id: "keyed", payload: JSON.stringify(ciWebhook("ci-1")), job_key: null }], rowCount: 1 };
        }
        if (q.includes("UPDATE _selfhost_jobs SET job_key=$1")) return { rows: [], rowCount: 1 };
        if (q.includes("WHERE status='processing'")) {
          return { rows: [{ id: "recover", payload: JSON.stringify(msg("stuck")), job_key: "recover-key" }], rowCount: 1 };
        }
        if (q.includes("SET status='pending', run_after=$1 WHERE id=$2")) return { rows: [], rowCount: 1 };
        if (q.includes("WHERE status='pending' AND run_after<=$1")) {
          return {
            rows: [
              { id: "spread-a", payload: JSON.stringify(msg("a")), job_key: "spread-a" },
              { id: "spread-b", payload: JSON.stringify(msg("b")), job_key: "spread-b" },
            ],
            rowCount: 2,
          };
        }
        if (q.includes("UPDATE _selfhost_jobs SET run_after=$1 WHERE id=$2")) return { rows: [], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      });
      const q = createPgQueue({ query: fn } as unknown as Pool, async () => undefined);

      await q.init();

      expect(fn).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE _selfhost_jobs SET job_key=$1"),
        [`github-webhook:ci-completed:jsonbored/gittensory@${"b".repeat(40)}#1629`, "keyed"],
      );
      expect(fn).toHaveBeenCalledWith(
        expect.stringContaining("SET status='pending', run_after=$1 WHERE id=$2"),
        expect.arrayContaining([expect.any(Number), "recover"]),
      );
      expect(fn).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE _selfhost_jobs SET run_after=$1 WHERE id=$2"),
        expect.arrayContaining([expect.any(Number), "spread-a"]),
      );
      expect(fn).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE _selfhost_jobs SET run_after=$1 WHERE id=$2"),
        expect.arrayContaining([expect.any(Number), "spread-b"]),
      );
    } finally {
      if (oldMin === undefined) delete process.env.QUEUE_STARTUP_JITTER_MIN_JOBS;
      else process.env.QUEUE_STARTUP_JITTER_MIN_JOBS = oldMin;
      if (oldJitter === undefined) delete process.env.QUEUE_STARTUP_JITTER_MS;
      else process.env.QUEUE_STARTUP_JITTER_MS = oldJitter;
      if (oldRecoveryJitter === undefined) delete process.env.QUEUE_RECOVERY_JITTER_MS;
      else process.env.QUEUE_RECOVERY_JITTER_MS = oldRecoveryJitter;
    }
  });

  it("init() skips startup spread when jitter is disabled", async () => {
    const oldMin = process.env.QUEUE_STARTUP_JITTER_MIN_JOBS;
    const oldJitter = process.env.QUEUE_STARTUP_JITTER_MS;
    process.env.QUEUE_STARTUP_JITTER_MIN_JOBS = "1";
    process.env.QUEUE_STARTUP_JITTER_MS = "0";
    try {
      const fn = vi.fn().mockImplementation(async (sql: unknown) => {
        const q = String(sql);
        if (q.includes("SELECT id, payload, priority")) return { rows: [], rowCount: 0 };
        if (q.includes("SELECT id, payload, job_key") && q.includes("status IN")) return { rows: [], rowCount: 0 };
        if (q.includes("WHERE status='processing'")) return { rows: [], rowCount: 0 };
        if (q.includes("WHERE status='pending' AND run_after<=$1")) {
          return { rows: [{ id: "due", payload: JSON.stringify(msg("due")), job_key: "due" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });
      const q = createPgQueue({ query: fn } as unknown as Pool, async () => undefined);

      await q.init();

      expect(fn).not.toHaveBeenCalledWith(
        expect.stringContaining("UPDATE _selfhost_jobs SET run_after=$1 WHERE id=$2"),
        expect.anything(),
      );
    } finally {
      if (oldMin === undefined) delete process.env.QUEUE_STARTUP_JITTER_MIN_JOBS;
      else process.env.QUEUE_STARTUP_JITTER_MIN_JOBS = oldMin;
      if (oldJitter === undefined) delete process.env.QUEUE_STARTUP_JITTER_MS;
      else process.env.QUEUE_STARTUP_JITTER_MS = oldJitter;
    }
  });

  it("coalesces duplicate keyed jobs instead of inserting queue pressure", async () => {
    const m = makePool();
    const q = createPgQueue(m.pool, async () => undefined);
    await q.init();
    m.fn.mockResolvedValueOnce({ rows: [{ id: "existing" }], rowCount: 1 });

    await q.binding.send(ciWebhook("ci-2", "check_run"), { delaySeconds: 1 });

    expect(m.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE status='pending' AND job_key=$1"),
      [`github-webhook:ci-completed:jsonbored/gittensory@${"b".repeat(40)}#1629`],
    );
    expect(m.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("SET payload=$1, run_after=GREATEST"),
      expect.arrayContaining([expect.stringContaining('"deliveryId":"ci-2"'), expect.any(Number), 10, "existing"]),
    );
    expect(m.pool.query).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO _selfhost_jobs (payload"),
      expect.arrayContaining([expect.stringContaining('"deliveryId":"ci-2"')]),
    );
  });

  it("does not reset created_at when coalescing a re-enqueue into an existing pending row (regression for #selfhost-runtime-drift)", async () => {
    // created_at anchors the maintenance trickle's age clock (maintenance-admission.ts). If a coalesced
    // re-enqueue reset it, a periodic scheduler re-requesting the same still-pending maintenance job faster
    // than the trickle's maxDeferAgeMs would re-arm the clock forever and defeat the anti-starvation escape.
    const m = makePool();
    const q = createPgQueue(m.pool, async () => undefined);
    await q.init();
    m.fn.mockResolvedValueOnce({ rows: [{ id: "existing" }], rowCount: 1 });

    await q.binding.send(msg("refresh-registry"));

    const calls = (m.fn as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const coalesceCall = calls.find((c: unknown[]) => String(c[0]).includes("SET payload=$1, run_after=GREATEST"));
    expect(coalesceCall?.[0]).toBeDefined();
    expect(String(coalesceCall?.[0])).not.toContain("created_at");
  });

  it("lets a pending full RAG index absorb a later repo incremental", async () => {
    const m = makePool();
    const q = createPgQueue(m.pool, async () => undefined);
    await q.init();
    m.fn.mockResolvedValueOnce({ rows: [{ id: "existing-full" }], rowCount: 1 });

    await q.binding.send({
      type: "rag-index-repo",
      requestedBy: "webhook",
      repoFullName: "JSONbored/gittensory",
      paths: ["src/a.ts"],
    });

    expect(m.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE status='pending' AND job_key=$1"),
      ["rag-index-repo:jsonbored/gittensory:full"],
    );
    expect(m.pool.query).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO _selfhost_jobs (payload"),
      expect.arrayContaining([expect.stringContaining('"paths":["src/a.ts"]')]),
    );
  });

  it("lets a full RAG index supersede pending repo incrementals", async () => {
    const m = makePool();
    const q = createPgQueue(m.pool, async () => undefined);
    await q.init();
    m.fn.mockResolvedValueOnce({ rows: [{ id: "existing-incremental" }], rowCount: 1 });

    await q.binding.send({
      type: "rag-index-repo",
      requestedBy: "schedule",
      repoFullName: "JSONbored/gittensory",
    });

    expect(m.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("left(job_key, $1)=$2"),
      ["rag-index-repo:jsonbored/gittensory:".length, "rag-index-repo:jsonbored/gittensory:"],
    );
    expect(m.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("SET payload=$1, run_after=GREATEST"),
      expect.arrayContaining([
        expect.stringContaining('"requestedBy":"schedule"'),
        expect.any(Number),
        0,
        "rag-index-repo:jsonbored/gittensory:full",
        "existing-incremental",
      ]),
    );
    expect(m.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM _selfhost_jobs"),
      ["existing-incremental", "rag-index-repo:jsonbored/gittensory:".length, "rag-index-repo:jsonbored/gittensory:"],
    );
  });

  // #selfhost-maintenance-self-pin: mirrors selfhost-sqlite-queue.test.ts -- two pending incrementals for the
  // same repo merge into one row's union path set instead of piling up as separate maintenance-lane rows.
  it("merges a new incremental RAG job into an already-pending incremental for the same repo", async () => {
    const m = makePool();
    const q = createPgQueue(m.pool, async () => undefined);
    await q.init();
    m.fn.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // absorbedByKey check: no pending FULL job for this repo
    m.fn.mockResolvedValueOnce({
      rows: [{ id: "existing-incremental", payload: JSON.stringify({ type: "rag-index-repo", requestedBy: "webhook", repoFullName: "JSONbored/gittensory", paths: ["src/a.ts"] }), job_key: "rag-index-repo:jsonbored/gittensory:sha256:existing" }],
      rowCount: 1,
    }); // merge-lookup query: an existing pending incremental for this repo
    m.fn.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // the guarded UPDATE wins the race — 1 row affected

    await q.binding.send({
      type: "rag-index-repo",
      requestedBy: "webhook",
      repoFullName: "JSONbored/gittensory",
      paths: ["src/b.ts"],
    });

    expect(m.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("left(job_key, $1)=$2"),
      ["rag-index-repo:jsonbored/gittensory:".length, "rag-index-repo:jsonbored/gittensory:", "rag-index-repo:jsonbored/gittensory:full"],
    );
    expect(m.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("SET payload=$1, run_after=GREATEST"),
      expect.arrayContaining([
        expect.stringContaining('"paths":["src/a.ts","src/b.ts"]'),
        expect.any(Number),
        expect.any(Number),
        0,
        expect.stringContaining("rag-index-repo:jsonbored/gittensory:sha256:"),
        "existing-incremental",
        "rag-index-repo:jsonbored/gittensory:sha256:existing",
      ]),
    );
    expect(m.pool.query).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO _selfhost_jobs (payload"),
      expect.arrayContaining([expect.stringContaining('"paths":["src/b.ts"]')]),
    );
  });

  it("REGRESSION (gate finding): a lost merge race (rowCount 0 — another instance claimed/mutated the row first) falls through to a normal insert instead of silently overwriting", async () => {
    const m = makePool();
    const q = createPgQueue(m.pool, async () => undefined);
    await q.init();
    m.fn.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // absorbedByKey check: no pending FULL job for this repo
    m.fn.mockResolvedValueOnce({
      rows: [{ id: "existing-incremental", payload: JSON.stringify({ type: "rag-index-repo", requestedBy: "webhook", repoFullName: "JSONbored/gittensory", paths: ["src/a.ts"] }), job_key: "rag-index-repo:jsonbored/gittensory:sha256:existing" }],
      rowCount: 1,
    }); // merge-lookup query: an existing pending incremental for this repo
    m.fn.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // the guarded UPDATE LOSES the race — another instance already claimed/mutated this row

    await q.binding.send({
      type: "rag-index-repo",
      requestedBy: "webhook",
      repoFullName: "JSONbored/gittensory",
      paths: ["src/b.ts"],
    });

    // Falls through to the normal enqueue path — a fresh INSERT for this job, never a second blind UPDATE
    // against the same (already-claimed) row.
    expect(m.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO"),
      expect.arrayContaining([expect.stringContaining('"paths":["src/b.ts"]')]),
    );
  });

  it("does not merge an incremental into an already-pending FULL job for that repo", async () => {
    const m = makePool();
    const q = createPgQueue(m.pool, async () => undefined);
    await q.init();
    // absorbedByKey's own exact-match query finds the pending full job first, so the merge query never runs.
    m.fn.mockResolvedValueOnce({ rows: [{ id: "existing-full" }], rowCount: 1 });

    await q.binding.send({
      type: "rag-index-repo",
      requestedBy: "webhook",
      repoFullName: "JSONbored/gittensory",
      paths: ["src/a.ts"],
    });

    expect(m.pool.query).not.toHaveBeenCalledWith(
      expect.stringContaining("left(job_key, $1)=$2"),
      expect.anything(),
    );
  });

  it("does not merge when the merge-lookup query finds no candidate (e.g. a different repo)", async () => {
    const m = makePool();
    const q = createPgQueue(m.pool, async () => undefined);
    await q.init();
    m.fn.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // absorbedByKey check: no pending FULL job
    m.fn.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // merge-lookup query: no pending incremental either

    await q.binding.send({
      type: "rag-index-repo",
      requestedBy: "webhook",
      repoFullName: "JSONbored/gittensory",
      paths: ["src/a.ts"],
    });

    expect(m.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("left(job_key, $1)=$2"),
      [36, "rag-index-repo:jsonbored/gittensory:", "rag-index-repo:jsonbored/gittensory:full"],
    );
    expect(m.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO _selfhost_jobs (payload"),
      expect.arrayContaining([expect.stringContaining('"paths":["src/a.ts"]')]),
    );
  });

  it("falls through to a separate row when merging would exceed the bounded path cap", async () => {
    const m = makePool();
    const q = createPgQueue(m.pool, async () => undefined);
    await q.init();
    m.fn.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // absorbedByKey check: no pending FULL job
    m.fn.mockResolvedValueOnce({
      rows: [{
        id: "existing-at-cap",
        payload: JSON.stringify({
          type: "rag-index-repo",
          requestedBy: "webhook",
          repoFullName: "JSONbored/gittensory",
          paths: Array.from({ length: 100 }, (_, i) => `src/${i}.ts`),
        }),
      }],
      rowCount: 1,
    }); // merge-lookup query: an existing pending incremental already at the cap

    await q.binding.send({
      type: "rag-index-repo",
      requestedBy: "webhook",
      repoFullName: "JSONbored/gittensory",
      paths: ["src/extra.ts"],
    });

    // No merge (would be 101 paths, over the cap) -- falls through to a plain INSERT of its own row.
    expect(m.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO _selfhost_jobs (payload"),
      expect.arrayContaining([expect.stringContaining('"paths":["src/extra.ts"]')]),
    );
  });

  it("coalesces recurring maintenance jobs by semantic scope and preserves distinct scopes", async () => {
    const m = makePool();
    const q = createPgQueue(m.pool, async () => undefined);
    await q.init();

    m.fn.mockResolvedValueOnce({ rows: [{ id: "existing-backfill" }], rowCount: 1 });
    await q.binding.send({
      type: "backfill-registered-repos",
      requestedBy: "schedule",
      repoFullName: "JSONbored/gittensory",
      mode: "resume",
      force: true,
    });

    m.fn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await q.binding.send({
      type: "backfill-registered-repos",
      requestedBy: "api",
      repoFullName: "JSONbored/gittensory",
      mode: "light",
      force: true,
    });

    m.fn.mockResolvedValueOnce({ rows: [{ id: "existing-report" }], rowCount: 1 });
    await q.binding.send({
      type: "generate-weekly-value-report",
      requestedBy: "schedule",
      variant: "operator",
      days: 7,
    });

    m.fn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await q.binding.send({
      type: "generate-weekly-value-report",
      requestedBy: "api",
      variant: "public",
      days: 7,
    });

    expect(m.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE status='pending' AND job_key=$1"),
      ["backfill-registered-repos:jsonbored/gittensory:resume:1"],
    );
    expect(m.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE status='pending' AND job_key=$1"),
      ["backfill-registered-repos:jsonbored/gittensory:light:1"],
    );
    expect(m.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE status='pending' AND job_key=$1"),
      ["generate-weekly-value-report:operator:7"],
    );
    expect(m.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE status='pending' AND job_key=$1"),
      ["generate-weekly-value-report:public:7"],
    );
    expect(m.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("SET payload=$1, run_after=GREATEST"),
      expect.arrayContaining([
        expect.stringContaining('"type":"backfill-registered-repos"'),
        expect.any(Number),
        0,
        "existing-backfill",
      ]),
    );
    expect(m.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("SET payload=$1, run_after=GREATEST"),
      expect.arrayContaining([
        expect.stringContaining('"type":"generate-weekly-value-report"'),
        expect.any(Number),
        0,
        "existing-report",
      ]),
    );
    expect(m.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO _selfhost_jobs (payload"),
      expect.arrayContaining([
        expect.stringContaining('"mode":"light"'),
        expect.any(Number),
        expect.any(Number),
        0,
        "backfill-registered-repos:jsonbored/gittensory:light:1",
      ]),
    );
    expect(m.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO _selfhost_jobs (payload"),
      expect.arrayContaining([
        expect.stringContaining('"variant":"public"'),
        expect.any(Number),
        expect.any(Number),
        0,
        "generate-weekly-value-report:public:7",
      ]),
    );
  });

  it("processes a job successfully (job_complete audit emitted)", async () => {
    const m = makePool();
    m.enqueueJob("1", { type: "review" });
    const seen: string[] = [];
    const q = createPgQueue(m.pool, async (j) => void seen.push(typeOf(j)));
    await q.init();
    await q.drain();
    expect(seen).toEqual(["review"]);
  });

  it("PG connection resilience (#selfhost-pg-resilience): retries a transient connection error on the post-success DELETE, then succeeds", async () => {
    const m = makePool();
    m.enqueueJob("1", { type: "review" });
    let deleteAttempts = 0;
    let claimed = false;
    (m.fn as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (sql: unknown) => {
      const q = String(sql);
      if (q.includes("DELETE FROM")) {
        deleteAttempts += 1;
        if (deleteAttempts < 2) {
          const err = new Error("connection terminated") as Error & { code: string };
          err.code = "ECONNRESET";
          throw err;
        }
        return { rows: [], rowCount: 1 };
      }
      if (q.includes("_selfhost_queue_fairness") && q.includes("RETURNING")) {
        return { rows: [{ claim_sequence: 0, last_backlog_repo: null }], rowCount: 1 };
      }
      if (q.includes("RETURNING")) {
        if (claimed) return { rows: [], rowCount: 0 };
        claimed = true;
        return { rows: [{ id: "1", payload: JSON.stringify({ type: "review" }), attempts: 0, job_key: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const seen: string[] = [];
    const q = createPgQueue(m.pool, async (j) => void seen.push(typeOf(j)));
    await q.init();
    await q.drain();
    expect(seen).toEqual(["review"]);
    expect(deleteAttempts).toBe(2);
  });

  it("PG connection resilience: leaves the job in 'processing' (for reclaim) when the DELETE exhausts retries on a dead connection", async () => {
    const m = makePool();
    m.enqueueJob("1", { type: "review" });
    let claimed = false;
    (m.fn as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (sql: unknown) => {
      const q = String(sql);
      if (q.includes("DELETE FROM")) {
        const err = new Error("connection terminated") as Error & { code: string };
        err.code = "ECONNRESET";
        throw err;
      }
      if (q.includes("_selfhost_queue_fairness") && q.includes("RETURNING")) {
        return { rows: [{ claim_sequence: 0, last_backlog_repo: null }], rowCount: 1 };
      }
      if (q.includes("RETURNING")) {
        if (claimed) return { rows: [], rowCount: 0 };
        claimed = true;
        return { rows: [{ id: "1", payload: JSON.stringify({ type: "review" }), attempts: 0, job_key: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const writes: string[] = [];
    vi.mocked(process.stdout.write).mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const q = createPgQueue(m.pool, async () => undefined);
    await q.init();
    await q.drain();
    expect(writes.some((line) => line.includes('"event":"job_complete"'))).toBe(false);
  });

  it("PG connection resilience: a connection error thrown by the consumer itself is left for reclaim, not dead-lettered", async () => {
    const m = makePool();
    m.enqueueJob("1", { type: "review" });
    const consume = vi.fn().mockImplementation(async () => {
      const err = new Error("connection terminated") as Error & { code: string };
      err.code = "57P01";
      throw err;
    });
    const q = createPgQueue(m.pool, consume);
    await q.init();
    await q.drain();
    // No dead-letter UPDATE (status='dead') or pending-retry UPDATE (attempts=$1) should have run for this job.
    const calls = (m.fn as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calls.some((sql) => sql.includes("status='dead'"))).toBe(false);
    expect(calls.some((sql) => sql.includes("attempts=$1, run_after=$2"))).toBe(false);
  });

  it("regression: a GENERIC network error from consume() (e.g. GitHub API, not Postgres) still goes through normal retry, not silent reclaim", async () => {
    // ECONNRESET/ECONNREFUSED/EPIPE are NOT unique to Postgres -- consume() can throw them from its own
    // unrelated network calls. Only unambiguous Postgres SQLSTATE codes should trigger the reclaim path here.
    const m = makePool();
    m.enqueueJob("1", { type: "review" });
    const consume = vi.fn().mockImplementation(async () => {
      const err = new Error("socket hang up") as Error & { code: string };
      err.code = "ECONNRESET";
      throw err;
    });
    const q = createPgQueue(m.pool, consume);
    await q.init();
    await q.drain();
    const calls = (m.fn as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => String(c[0]));
    // attempts=1 (first failure, under maxRetries) -> the normal pending-retry UPDATE must have run.
    expect(calls.some((sql) => sql.includes("attempts=$1, run_after=$2"))).toBe(true);
  });

  it("copies carried webhook trace ids into job audit logs", async () => {
    const m = makePool();
    const writes: string[] = [];
    vi.mocked(process.stdout.write).mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    m.enqueueJob("1", {
      type: "github-webhook",
      traceParent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      payload: {
        repository: { full_name: "JSONbored/gittensory" },
        pull_request: { number: 1629 },
      },
    });
    const q = createPgQueue(m.pool, async () => undefined);

    await q.init();
    await q.drain();

    const audit = writes.find((line) => line.includes('"event":"job_complete"'));
    expect(JSON.parse(audit!) as Record<string, unknown>).toMatchObject({
      repo: "JSONbored/gittensory",
      pr_number: 1629,
      trace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
  });

  it("claims foreground work before falling back to the capped background lane", async () => {
    const claimSql: string[] = [];
    const fn = vi.fn().mockImplementation(async (sql: unknown) => {
      const q = String(sql);
      if (q.includes("SELECT id, payload, priority")) return { rows: [], rowCount: 0 };
      if (q.includes("SELECT id, payload, job_key") && q.includes("status IN")) return { rows: [], rowCount: 0 };
      if (q.includes("WHERE status='processing'")) return { rows: [], rowCount: 0 };
      if (q.includes("UPDATE _selfhost_jobs SET status='processing'")) {
        claimSql.push(q);
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });
    const q = createPgQueue(
      { query: fn } as unknown as Pool,
      async () => undefined,
      { backgroundConcurrency: 1 },
    );

    await q.init();
    await q.drain();

    expect(claimSql).toHaveLength(2);
    expect(claimSql[0]).toContain("priority >= $2");
    expect(claimSql[1]).toContain("priority < $2");
  });

  it("stores a PR-created claim sort key for per-PR re-gate jobs", async () => {
    const m = makePool();
    const q = createPgQueue(m.pool, async () => undefined);
    await q.init();

    await q.binding.send({
      type: "agent-regate-pr",
      deliveryId: "backlog-convergence:jsonbored/gittensory#10",
      repoFullName: "jsonbored/gittensory",
      prNumber: 10,
      installationId: 123,
      prCreatedAt: "2026-07-03T10:00:00.000Z",
    });

    expect(m.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("claim_sort_key) VALUES"),
      expect.arrayContaining([Date.parse("2026-07-03T10:00:00.000Z")]),
    );
  });

  it("REGRESSION: claim SQL sorts by PR claim_sort_key and locks job_key siblings before claiming", async () => {
    const m = makePool();
    const seen: string[] = [];
    m.enqueueJob("1", regateJob(123, 10), 0, "agent-regate-pr:jsonbored/gittensory#10");
    const q = createPgQueue(m.pool, async (message) => void seen.push(typeOf(message)), {
      concurrency: 1,
      maxRetries: 1,
      backoffMs: () => 0,
    });
    await q.init();

    await q.drain();

    const claimSql = vi.mocked(m.pool.query).mock.calls
      .map((call) => String(call[0]))
      .find((sql) => sql.includes("FOR UPDATE SKIP LOCKED") && sql.includes("candidate.claim_sort_key"));
    expect(claimSql).toContain("ORDER BY candidate.priority DESC, candidate.claim_sort_key, candidate.run_after, candidate.id");
    expect(claimSql).toContain("pg_try_advisory_xact_lock(hashtextextended(candidate.job_key, 0))");
    expect(claimSql).toContain("processing.status='processing' AND processing.job_key=candidate.job_key");
    expect(seen).toEqual(["agent-regate-pr"]);
  });

  it("processes a background-lane job when foreground work is empty", async () => {
    const m = makePool();
    m.enqueueResult({ rows: [], rowCount: 0 });
    m.enqueueResult({
      rows: [
        {
          id: "background",
          payload: JSON.stringify(msg("agent-regate-sweep")),
          attempts: 0,
          job_key: "agent-regate-sweep",
          priority: 0,
        },
      ],
      rowCount: 1,
    });
    const seen: string[] = [];
    const q = createPgQueue(
      m.pool,
      async (j) => void seen.push(typeOf(j)),
      { backgroundConcurrency: 1 },
    );

    await q.init();
    await q.drain();

    expect(seen).toEqual(["agent-regate-sweep"]);
    expect(m.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM _selfhost_jobs WHERE id=$1"),
      ["background"],
    );
  });

  describe("claim-time backlog-vs-fresh-intake fairness (#selfhost-backlog-convergence)", () => {
    const backlogJob = (repo: string, prNumber: number): JobMessage =>
      ({
        type: "agent-regate-pr",
        deliveryId: `backlog-convergence:${repo}#${prNumber}`,
        repoFullName: repo,
        prNumber,
        installationId: 1,
      }) as unknown as JobMessage;

    it("prefers a pending backlog-lane candidate at sequence 0 (default ratio) and records it as the last-served repo", async () => {
      const claimSql: string[] = [];
      let sequenceAllocations = 0;
      let repoRecorded: string | null = null;
      let claimed = false; // one-shot: the row is only claimable until the first successful claim
      const fn = vi.fn().mockImplementation(async (sql: unknown, params?: unknown[]) => {
        const q = String(sql);
        // Atomic allocation (#selfhost-backlog-convergence review): a single UPDATE ... RETURNING, not a
        // separate SELECT-then-UPDATE -- concurrent self-host instances sharing one Postgres must never be
        // able to read the same pre-increment claim_sequence.
        if (q.includes("UPDATE _selfhost_queue_fairness SET claim_sequence=claim_sequence+1") && q.includes("RETURNING claim_sequence, last_backlog_repo")) {
          sequenceAllocations += 1;
          return { rows: [{ claim_sequence: 0, last_backlog_repo: null }], rowCount: 1 };
        }
        if (q.includes("UPDATE _selfhost_queue_fairness SET last_backlog_repo")) {
          repoRecorded = (params as [string])[0];
          return { rows: [], rowCount: 1 };
        }
        if (q.includes("SELECT job_key, created_at") && q.includes("foreground_lane='backlog'")) {
          return claimed ? { rows: [], rowCount: 0 } : { rows: [{ job_key: "agent-regate-pr:owner/repo#1", created_at: 1000 }], rowCount: 1 };
        }
        if (q.includes("UPDATE _selfhost_jobs SET status='processing'")) {
          claimSql.push(q);
          if (!claimed && q.includes("foreground_lane='backlog'")) {
            expect((params as unknown[])[2]).toBe("agent-regate-pr:owner/repo#%");
            claimed = true;
            return {
              rows: [{ id: "backlog-1", payload: JSON.stringify(backlogJob("owner/repo", 1)), attempts: 0, job_key: "agent-regate-pr:owner/repo#1", priority: 9, created_at: 1000 }],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      });
      const seen: string[] = [];
      const q = createPgQueue({ query: fn } as unknown as Pool, async (m) => void seen.push(typeOf(m)));

      await q.init();
      await q.drain();

      expect(seen).toEqual(["agent-regate-pr"]);
      expect(claimSql[0]).toContain("foreground_lane='backlog'");
      expect(sequenceAllocations).toBeGreaterThan(0);
      expect(repoRecorded).toBe("owner/repo");
      expect(await renderMetrics()).toContain('gittensory_jobs_claimed_by_lane_total{lane="backlog"} 1');
    });

    it("falls through to the plain unscoped foreground claim when the backlog lane has no pending candidates", async () => {
      const claimSql: string[] = [];
      let claimed = false; // one-shot: the row is only claimable until the first successful claim
      const fn = vi.fn().mockImplementation(async (sql: unknown) => {
        const q = String(sql);
        if (q.includes("UPDATE _selfhost_queue_fairness SET claim_sequence=claim_sequence+1") && q.includes("RETURNING claim_sequence, last_backlog_repo")) {
          return { rows: [{ claim_sequence: 0, last_backlog_repo: null }], rowCount: 1 };
        }
        if (q.includes("UPDATE _selfhost_queue_fairness")) return { rows: [], rowCount: 1 };
        if (q.includes("SELECT job_key, created_at") && q.includes("foreground_lane='backlog'")) {
          return { rows: [], rowCount: 0 }; // no backlog work pending
        }
        if (q.includes("UPDATE _selfhost_jobs SET status='processing'")) {
          claimSql.push(q);
          if (!claimed && !q.includes("foreground_lane")) {
            claimed = true;
            return {
              rows: [{ id: "fresh-1", payload: JSON.stringify(msg("recapture-preview")), attempts: 0, job_key: "recapture-preview:owner/repo#1:0", priority: 9, created_at: 1000 }],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      });
      const seen: string[] = [];
      const q = createPgQueue({ query: fn } as unknown as Pool, async (m) => void seen.push(typeOf(m)));

      await q.init();
      await q.drain();

      // The backlog-scoped claim yields nothing (no candidates) -- falls through to the unscoped foreground
      // query, which still finds the untagged foreground row rather than stalling.
      expect(seen).toEqual(["recapture-preview"]);
      expect(claimSql[0]).not.toContain("foreground_lane");
      // The unscoped fallback claim is not lane-scoped, so it must never record a lane-claim increment
      // (#selfhost-lane-observability).
      expect(await renderMetrics()).not.toContain("gittensory_jobs_claimed_by_lane_total");
    });

    it("does not let a lower-priority classified lane starve a higher-priority manual regate", async () => {
      const claimSql: string[] = [];
      let claimed = false;
      const manual = {
        type: "agent-regate-pr",
        deliveryId: "manual-regate:owner/repo#1:operator",
        repoFullName: "owner/repo",
        prNumber: 1,
        installationId: 1,
      };
      const fn = vi.fn().mockImplementation(async (sql: unknown, params?: unknown[]) => {
        const q = String(sql);
        if (q.includes("UPDATE _selfhost_queue_fairness SET claim_sequence=claim_sequence+1") && q.includes("RETURNING claim_sequence, last_backlog_repo")) {
          return { rows: [{ claim_sequence: 0, last_backlog_repo: null }], rowCount: 1 };
        }
        if (q.includes("SELECT MAX(priority) AS priority") && q.includes("foreground_lane IS NULL")) {
          return { rows: [{ priority: 99 }], rowCount: 1 };
        }
        if (q.includes("SELECT job_key, created_at") && q.includes("foreground_lane='backlog'")) {
          return { rows: [{ job_key: "agent-regate-pr:owner/repo#2", created_at: 1000 }], rowCount: 1 };
        }
        if (q.includes("UPDATE _selfhost_jobs SET status='processing'")) {
          claimSql.push(q);
          if (!claimed && q.includes("foreground_lane='backlog'")) {
            expect((params as unknown[])[1]).toBe(99);
            return { rows: [], rowCount: 0 };
          }
          if (!claimed && !q.includes("foreground_lane")) {
            claimed = true;
            return {
              rows: [{ id: "manual-1", payload: JSON.stringify(manual), attempts: 0, job_key: "agent-regate-pr:owner/repo#1", priority: 99, created_at: 1000 }],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      });
      const seen: string[] = [];
      const q = createPgQueue({ query: fn } as unknown as Pool, async (m) => void seen.push((m as unknown as { deliveryId: string }).deliveryId));

      await q.init();
      await q.drain();

      expect(seen).toEqual(["manual-regate:owner/repo#1:operator"]);
      expect(claimSql[0]).toContain("foreground_lane='backlog'");
      expect(claimSql[0]).toContain("candidate.priority > $2");
      expect(claimSql[1]).not.toContain("foreground_lane");
      expect(await renderMetrics()).not.toContain("gittensory_jobs_claimed_by_lane_total");
    });

    it("records the fresh-intake lane-claim counter on a successful fresh-lane claim (#selfhost-lane-observability)", async () => {
      let claimed = false; // one-shot: the row is only claimable until the first successful claim
      const fn = vi.fn().mockImplementation(async (sql: unknown) => {
        const q = String(sql);
        // Sequence 3 (the default 3-backlog:1-fresh ratio's 4th slot) prefers "fresh".
        if (q.includes("UPDATE _selfhost_queue_fairness SET claim_sequence=claim_sequence+1") && q.includes("RETURNING claim_sequence, last_backlog_repo")) {
          return { rows: [{ claim_sequence: 3, last_backlog_repo: null }], rowCount: 1 };
        }
        if (!claimed && q.includes("UPDATE _selfhost_jobs SET status='processing'") && q.includes("foreground_lane='fresh'")) {
          claimed = true;
          return {
            rows: [{ id: "fresh-1", payload: JSON.stringify(msg("github-webhook")), attempts: 0, job_key: "github-webhook:owner/repo#1@sha", priority: 10, created_at: 1000 }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      });
      const seen: string[] = [];
      const q = createPgQueue({ query: fn } as unknown as Pool, async (m) => void seen.push(typeOf(m)));

      await q.init();
      await q.drain();

      expect(seen).toEqual(["github-webhook"]);
      expect(await renderMetrics()).toContain('gittensory_jobs_claimed_by_lane_total{lane="fresh"} 1');
    });

    it("allocates the claim sequence atomically via UPDATE ... RETURNING, not a separate SELECT-then-UPDATE (#selfhost-backlog-convergence review)", async () => {
      // A stateful counter mimics what Postgres's own row lock guarantees: each call to the fairness UPDATE
      // sees the PRIOR call's committed increment, never a stale pre-increment value two callers could both
      // observe. If the code ever regressed to a separate SELECT-then-UPDATE, this mock would not by itself
      // catch a real race (it's still single-threaded JS) -- what it DOES prove is that the code reads its
      // lane decision from the SAME query that performs the increment (the RETURNING clause), which is the
      // actual fix: no separate read exists to go stale between two real concurrent Postgres connections.
      let claimSequence = 0;
      const claimedRepoJobs = new Set(["1", "2"]);
      const fn = vi.fn().mockImplementation(async (sql: unknown) => {
        const q = String(sql);
        if (q.includes("UPDATE _selfhost_queue_fairness SET claim_sequence=claim_sequence+1") && q.includes("RETURNING claim_sequence, last_backlog_repo")) {
          claimSequence += 1;
          return { rows: [{ claim_sequence: claimSequence, last_backlog_repo: null }], rowCount: 1 };
        }
        if (q.includes("UPDATE _selfhost_queue_fairness")) return { rows: [], rowCount: 1 };
        if (q.includes("SELECT job_key, created_at") && q.includes("foreground_lane='backlog'")) {
          return {
            rows: [...claimedRepoJobs].map((n) => ({ job_key: `agent-regate-pr:owner/repo#${n}`, created_at: 1000 })),
            rowCount: claimedRepoJobs.size,
          };
        }
        if (q.includes("UPDATE _selfhost_jobs SET status='processing'") && q.includes("foreground_lane='backlog'")) {
          const next = [...claimedRepoJobs][0];
          if (next === undefined) return { rows: [], rowCount: 0 };
          claimedRepoJobs.delete(next);
          return {
            rows: [{ id: `backlog-${next}`, payload: JSON.stringify(backlogJob("owner/repo", Number(next))), attempts: 0, job_key: `agent-regate-pr:owner/repo#${next}`, priority: 9, created_at: 1000 }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      });
      const seen: string[] = [];
      const q = createPgQueue({ query: fn } as unknown as Pool, async (m) => void seen.push(typeOf(m)), { concurrency: 1 });

      await q.init();
      await q.drain();

      // 2 backlog-tagged rows are pending; the fairness allocator's RETURNING values (1, then 2 -- both
      // < the default ratio's backlogPer=3 window) both resolve to "backlog", so both rows are claimed via
      // the backlog-scoped path in order, proving the lane decision tracks the atomically-allocated sequence
      // rather than a stale value from a separate read. (drain() keeps polling after both are claimed until a
      // claim genuinely comes up empty, so the allocator may advance past 2 -- that trailing empty cycle is
      // not what this test is verifying.)
      expect(seen).toEqual(["agent-regate-pr", "agent-regate-pr"]);
      expect(claimSequence).toBeGreaterThanOrEqual(2);
    });

    it("backfills the foreground_lane column on startup for jobs enqueued by an older version", async () => {
      const m = makePool();
      m.fn.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // DDL
      m.fn.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // fairness singleton INSERT
      m.fn.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // priority backfill SELECT
      m.fn.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // job-key backfill SELECT
      m.fn.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // claim-sort-key backfill SELECT
      m.fn.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // maintenance-flags backfill SELECT
      m.fn.mockResolvedValueOnce({
        rows: [{ id: "legacy", payload: JSON.stringify({ type: "agent-regate-pr", deliveryId: "backlog-convergence:owner/repo#1" }), foreground_lane: null }],
        rowCount: 1,
      }); // foreground-lane backfill SELECT
      m.fn.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // the backfill UPDATE for the legacy row
      m.fn.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // recovery UPDATE
      const q = createPgQueue(m.pool, async () => undefined);
      await q.init();
      expect(m.pool.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE _selfhost_jobs SET foreground_lane=$1"),
        ["backlog", "legacy"],
      );
    });
  });

  describe("topBacklogRepos (#selfhost-lane-observability)", () => {
    // The COUNT/GROUP BY/ORDER BY/LIMIT run IN SQL now (gate review) -- this mock can't execute real SQL, so it
    // returns a pre-aggregated {repo, cnt} result set (as the real query would) and these tests verify (a) the
    // query is scoped to the backlog lane + the agent-regate-pr job_key prefix with the limit bound as a
    // parameter, and (b) the {repo, cnt} rows map to {repo, count} correctly. The aggregation SQL itself
    // (substring/position extraction, GROUP BY, ORDER BY, exclusion of dead/fresh-lane/no-hash-edge rows) is
    // verified directly against a real Postgres instance and, identically, against the real SQLite engine in
    // selfhost-sqlite-queue.test.ts (both backends share the same query shape).
    function stubAggregatedBacklogRepos(rows: Array<{ repo: string; cnt: string | number }>): {
      pool: { query: Pool["query"] };
      calls: Array<{ sql: string; params: unknown[] }>;
    } {
      const calls: Array<{ sql: string; params: unknown[] }> = [];
      return {
        pool: {
          query: (async (sql: unknown, params?: unknown[]) => {
            const q = String(sql);
            if (q.includes("foreground_lane='backlog'") && q.includes("GROUP BY repo")) {
              calls.push({ sql: q, params: params ?? [] });
              return { rows, rowCount: rows.length };
            }
            return { rows: [], rowCount: 0 };
          }) as Pool["query"],
        },
        calls,
      };
    }

    it("returns an empty array when no backlog-lane row is pending", async () => {
      const m = stubAggregatedBacklogRepos([]);
      const q = createPgQueue(m.pool as unknown as Pool, async () => undefined);
      expect(await q.topBacklogRepos(10)).toEqual([]);
    });

    it("maps aggregated {repo, cnt} rows to {repo, count}, binding the prefix, LIKE pattern, and limit as params", async () => {
      const m = stubAggregatedBacklogRepos([
        { repo: "owner/b", cnt: "3" },
        { repo: "owner/a", cnt: 1 },
      ]);
      const q = createPgQueue(m.pool as unknown as Pool, async () => undefined);

      expect(await q.topBacklogRepos(2)).toEqual([
        { repo: "owner/b", count: 3 },
        { repo: "owner/a", count: 1 },
      ]);
      expect(m.calls).toHaveLength(1);
      expect(m.calls[0]?.params).toEqual(["agent-regate-pr:", "agent-regate-pr:%", 2]);
      expect(m.calls[0]?.sql).toContain("status IN ('pending','processing')");
    });

    it("clamps a negative limit to 0 rather than passing it through to SQL (LIMIT -1 means unlimited in some dialects)", async () => {
      const m = stubAggregatedBacklogRepos([]);
      const q = createPgQueue(m.pool as unknown as Pool, async () => undefined);

      await q.topBacklogRepos(-5);
      expect(m.calls[0]?.params).toEqual(["agent-regate-pr:", "agent-regate-pr:%", 0]);
    });
  });

  describe("listDeadLetterJobs (#2214)", () => {
    // Same rationale as topBacklogRepos above: the ORDER BY/LIMIT/OFFSET run in SQL, which this mock can't
    // execute, so these tests stub a pre-ordered row set and verify (a) param binding (limit/offset, clamped)
    // and (b) row -> DeadLetterJob mapping (bigint-as-string coercion, jobType extraction, deadAtMs null
    // passthrough). The query shape itself is verified directly against the real SQLite engine (identical SQL
    // shape, ported 1:1) in selfhost-sqlite-queue.test.ts.
    function stubDeadLetterRows(
      rows: Array<{
        id: string | number;
        payload: string;
        attempts: number | string;
        last_error: string | null;
        created_at: number | string;
        dead_at: number | string | null;
      }>,
    ): {
      pool: { query: Pool["query"] };
      calls: Array<{ sql: string; params: unknown[] }>;
    } {
      const calls: Array<{ sql: string; params: unknown[] }> = [];
      return {
        pool: {
          query: (async (sql: unknown, params?: unknown[]) => {
            const q = String(sql);
            if (q.includes("status='dead'") && q.includes("COALESCE(dead_at, created_at)")) {
              calls.push({ sql: q, params: params ?? [] });
              return { rows, rowCount: rows.length };
            }
            return { rows: [], rowCount: 0 };
          }) as Pool["query"],
        },
        calls,
      };
    }

    it("returns an empty array when there are no dead-letter rows", async () => {
      const m = stubDeadLetterRows([]);
      const q = createPgQueue(m.pool as unknown as Pool, async () => undefined);
      expect(await q.listDeadLetterJobs(25, 0)).toEqual([]);
    });

    it("maps bigint-as-string rows to DeadLetterJob, binding limit/offset as params", async () => {
      const m = stubDeadLetterRows([
        {
          id: "2",
          payload: JSON.stringify(msg("github-webhook")),
          attempts: "1",
          last_error: "kaboom",
          created_at: "2000",
          dead_at: "9000",
        },
      ]);
      const q = createPgQueue(m.pool as unknown as Pool, async () => undefined);

      expect(await q.listDeadLetterJobs(25, 10)).toEqual([
        { id: 2, jobType: "github-webhook", attempts: 1, lastError: "kaboom", createdAtMs: 2000, deadAtMs: 9000 },
      ]);
      expect(m.calls).toHaveLength(1);
      expect(m.calls[0]?.params).toEqual([25, 10]);
    });

    it("reports deadAtMs null for a legacy row with no dead_at, and jobType 'unknown' for an unparseable payload", async () => {
      const m = stubDeadLetterRows([
        { id: 1, payload: "not-json", attempts: 0, last_error: "unparseable payload", created_at: 1000, dead_at: null },
      ]);
      const q = createPgQueue(m.pool as unknown as Pool, async () => undefined);

      expect(await q.listDeadLetterJobs(25, 0)).toEqual([
        { id: 1, jobType: "unknown", attempts: 0, lastError: "unparseable payload", createdAtMs: 1000, deadAtMs: null },
      ]);
    });

    it("clamps a negative limit/offset to 0 rather than passing it through to SQL", async () => {
      const m = stubDeadLetterRows([]);
      const q = createPgQueue(m.pool as unknown as Pool, async () => undefined);

      await q.listDeadLetterJobs(-5, -2);
      expect(m.calls[0]?.params).toEqual([0, 0]);
    });
  });

  describe("replay/delete/purge dead-letter jobs (#2215)", () => {
    // Manual, operator-initiated dead-letter actions (distinct from the automatic reviveEligibleDeadJobs sweep
    // tested below under "reviveDeadLetterJobs (#audit-rate-headroom)"). Each stub matches on a distinguishing
    // SQL fragment so a test can't accidentally satisfy the wrong query -- delete-by-id is distinguished from
    // purge-all by the presence/absence of "id=$1", mirroring how stubDeadLetterRows above matches on SQL text.
    function stubReplay(rowCount: number | null): {
      pool: { query: Pool["query"] };
      calls: Array<{ sql: string; params: unknown[] }>;
    } {
      const calls: Array<{ sql: string; params: unknown[] }> = [];
      return {
        pool: {
          query: (async (sql: unknown, params?: unknown[]) => {
            const q = String(sql);
            if (q.includes("SET status='pending'") && q.includes("attempts=0")) {
              calls.push({ sql: q, params: params ?? [] });
              return { rows: [], rowCount };
            }
            return { rows: [], rowCount: 0 };
          }) as Pool["query"],
        },
        calls,
      };
    }

    function stubDeleteById(rowCount: number | null): {
      pool: { query: Pool["query"] };
      calls: Array<{ sql: string; params: unknown[] }>;
    } {
      const calls: Array<{ sql: string; params: unknown[] }> = [];
      return {
        pool: {
          query: (async (sql: unknown, params?: unknown[]) => {
            const q = String(sql);
            if (q.includes("DELETE FROM") && q.includes("status='dead'") && q.includes("id=$1")) {
              calls.push({ sql: q, params: params ?? [] });
              return { rows: [], rowCount };
            }
            return { rows: [], rowCount: 0 };
          }) as Pool["query"],
        },
        calls,
      };
    }

    function stubPurge(rowCount: number | null): {
      pool: { query: Pool["query"] };
      calls: Array<{ sql: string; params: unknown[] }>;
    } {
      const calls: Array<{ sql: string; params: unknown[] }> = [];
      return {
        pool: {
          query: (async (sql: unknown, params?: unknown[]) => {
            const q = String(sql);
            if (q.includes("DELETE FROM") && q.includes("status='dead'") && !q.includes("id=$1")) {
              calls.push({ sql: q, params: params ?? [] });
              return { rows: [], rowCount };
            }
            return { rows: [], rowCount: 0 };
          }) as Pool["query"],
        },
        calls,
      };
    }

    it("replayDeadLetterJob requeues a dead row with a fresh attempts budget and returns true", async () => {
      const m = stubReplay(1);
      const q = createPgQueue(m.pool as unknown as Pool, async () => undefined);

      expect(await q.replayDeadLetterJob(7)).toBe(true);
      expect(m.calls).toHaveLength(1);
      expect(m.calls[0]?.params).toEqual([expect.any(Number), 7]);
    });

    it("replayDeadLetterJob returns false when the id is not currently dead (already handled/deleted/never existed)", async () => {
      const m = stubReplay(0);
      const q = createPgQueue(m.pool as unknown as Pool, async () => undefined);

      expect(await q.replayDeadLetterJob(7)).toBe(false);
      expect(m.calls[0]?.params).toEqual([expect.any(Number), 7]);
    });

    it("REGRESSION: replayDeadLetterJob falls back to false (not null/undefined) when the driver omits rowCount", async () => {
      // Same rationale as purgeDeadLetterJobs's own regression test below: rowCount:0 and rowCount:null both
      // take the ">0 === false" branch, so only an explicit null proves the `?? 0` fallback itself fires.
      const m = stubReplay(null);
      const q = createPgQueue(m.pool as unknown as Pool, async () => undefined);

      expect(await q.replayDeadLetterJob(7)).toBe(false);
    });

    it("deleteDeadLetterJob deletes one dead row by id and returns true", async () => {
      const m = stubDeleteById(1);
      const q = createPgQueue(m.pool as unknown as Pool, async () => undefined);

      expect(await q.deleteDeadLetterJob(9)).toBe(true);
      expect(m.calls).toHaveLength(1);
      expect(m.calls[0]?.params).toEqual([9]);
    });

    it("deleteDeadLetterJob returns false when the id is not currently dead", async () => {
      const m = stubDeleteById(0);
      const q = createPgQueue(m.pool as unknown as Pool, async () => undefined);

      expect(await q.deleteDeadLetterJob(9)).toBe(false);
      expect(m.calls[0]?.params).toEqual([9]);
    });

    it("REGRESSION: deleteDeadLetterJob falls back to false (not null/undefined) when the driver omits rowCount", async () => {
      const m = stubDeleteById(null);
      const q = createPgQueue(m.pool as unknown as Pool, async () => undefined);

      expect(await q.deleteDeadLetterJob(9)).toBe(false);
    });

    it("purgeDeadLetterJobs deletes every dead row with no id param and returns the count", async () => {
      const m = stubPurge(3);
      const q = createPgQueue(m.pool as unknown as Pool, async () => undefined);

      expect(await q.purgeDeadLetterJobs()).toBe(3);
      expect(m.calls).toHaveLength(1);
      expect(m.calls[0]?.params).toEqual([]);
    });

    it("purgeDeadLetterJobs returns 0 when nothing was dead", async () => {
      const m = stubPurge(0);
      const q = createPgQueue(m.pool as unknown as Pool, async () => undefined);

      expect(await q.purgeDeadLetterJobs()).toBe(0);
    });

    it("REGRESSION: purgeDeadLetterJobs falls back to 0 (not null/undefined/NaN) when the driver omits rowCount", async () => {
      // Exercises the `?? 0` branch specifically: a plain rowCount:0 response takes the SAME branch as a null
      // rowCount here (0 ?? 0 === 0), so it doesn't prove the nullish fallback actually fires. Returning
      // rowCount: null (a real pg driver possibility for some statement shapes) does.
      const m = stubPurge(null);
      const q = createPgQueue(m.pool as unknown as Pool, async () => undefined);

      expect(await q.purgeDeadLetterJobs()).toBe(0);
    });
  });

  it("REGRESSION: releases the reserved background slot when a background claim query rejects (#selfhost-bg-slot-leak)", async () => {
    // A raw pool failure during the BACKGROUND claim (a dropped connection / lock timeout — the exact failures
    // pump() is documented to catch) rejects out of claimNext(), which runs OUTSIDE processOne's try/finally, so
    // its reserved slot must be rolled back. Without the rollback the slot leaks; since backgroundConcurrency
    // defaults to 1, a single such error would starve the entire background/maintenance lane until a restart.
    // Assert the lane still drains a background job after one rejected claim.
    const m = makePool();
    let failNextBackgroundClaim = true;
    const pool = {
      query: async (sql: unknown, params?: unknown[]) => {
        const q = String(sql);
        if (failNextBackgroundClaim && q.includes("UPDATE _selfhost_jobs SET status='processing'") && q.includes("priority < $2")) {
          failNextBackgroundClaim = false;
          throw new Error("connection terminated unexpectedly");
        }
        return (m.pool as unknown as { query(sql: unknown, params?: unknown[]): Promise<unknown> }).query(q, params);
      },
    } as unknown as Pool;
    const seen: string[] = [];
    const q = createPgQueue(pool, async (j) => void seen.push(typeOf(j)), { backgroundConcurrency: 1 });
    await q.init();

    // First drain: foreground claim empty, background claim rejects (transient). pump() catches it; the reserved
    // slot must be released so the lane is not permanently starved.
    m.enqueueResult({ rows: [], rowCount: 0 }); // foreground claim → empty
    await q.drain();
    expect(seen).toEqual([]);

    // Second drain: the lane must have recovered — foreground empty, background claim returns the job.
    m.enqueueResult({ rows: [], rowCount: 0 }); // foreground claim → empty
    m.enqueueResult({
      rows: [{ id: "background", payload: JSON.stringify(msg("agent-regate-sweep")), attempts: 0, job_key: "agent-regate-sweep", priority: 0 }],
      rowCount: 1,
    }); // background claim → job
    await q.drain();
    expect(seen).toEqual(["agent-regate-sweep"]);
  });

  it("pre-yields GitHub-budget background jobs when the persisted REST budget is reserved", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const oldJitter = process.env.QUEUE_RATE_LIMIT_JITTER_MS;
    process.env.QUEUE_RATE_LIMIT_JITTER_MS = "0";
    try {
      const m = makePool();
      m.setRateLimitRows([{ admission_key: "installation:123", repo_full_name: "owner/other-repo", remaining: "120", reset_at: "2026-06-24T12:10:00.000Z", observed_at: "2026-06-24T11:59:30.000Z" }]);
      m.enqueueJob("background", {
        type: "agent-regate-pr",
        deliveryId: "regate-sweep:owner/repo#7",
        repoFullName: "owner/repo",
        prNumber: 7,
        installationId: 123,
      });
      const seen: string[] = [];
      const q = createPgQueue(m.pool, async (j) => void seen.push(typeOf(j)));

      await q.drain();

      expect(seen).toEqual([]);
      expect(m.pool.query).toHaveBeenCalledWith(
        expect.stringContaining("SET status='pending', run_after=GREATEST"),
        [Date.parse("2026-06-24T12:10:15.000Z"), "github rate-limit background admission", "background"],
      );
      expect(m.pool.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO _selfhost_job_stats"),
        ["gittensory_jobs_rate_limit_deferred_total", 1],
      );
      expect(await renderMetrics()).toContain('gittensory_jobs_rate_limit_admission_deferred_total{job_type="agent-regate-pr",key_scope="installation",kind="background"} 1');
    } finally {
      if (oldJitter === undefined) delete process.env.QUEUE_RATE_LIMIT_JITTER_MS;
      else process.env.QUEUE_RATE_LIMIT_JITTER_MS = oldJitter;
    }
  });

  it("PG connection resilience: a still-dead connection on the rate-limit-defer UPDATE doesn't crash the pump loop (other claimable jobs still run)", async () => {
    // Regression: an uncaught throw here used to escape processOne() entirely and land in pump()'s own
    // catch (see pump()'s "selfhost_queue_pump_crashed"), which ALSO breaks pump()'s `while (await
    // processOne())` loop -- so a SECOND already-claimable job enqueued in the same batch would be left
    // unprocessed until the next kick, not just this one job's own retry being deferred.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const oldJitter = process.env.QUEUE_RATE_LIMIT_JITTER_MS;
    process.env.QUEUE_RATE_LIMIT_JITTER_MS = "0";
    try {
      const m = makePool();
      m.setRateLimitRows([{ admission_key: "installation:123", repo_full_name: "owner/other-repo", remaining: "120", reset_at: "2026-06-24T12:10:00.000Z", observed_at: "2026-06-24T11:59:30.000Z" }]);
      m.enqueueJob("background", {
        type: "agent-regate-pr",
        deliveryId: "regate-sweep:owner/repo#7",
        repoFullName: "owner/repo",
        prNumber: 7,
        installationId: 123,
      });
      m.enqueueJob("second", { type: "review" });
      const original = (m.fn as unknown as ReturnType<typeof vi.fn>).getMockImplementation() as (sql: unknown, params?: unknown[]) => Promise<unknown>;
      (m.fn as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (sql: unknown, params?: unknown[]) => {
        if (String(sql).includes("SET status='pending', run_after=GREATEST")) {
          const err = new Error("connection terminated") as Error & { code: string };
          err.code = "ECONNRESET";
          throw err;
        }
        return original(sql, params);
      });
      const seen: string[] = [];
      const q = createPgQueue(m.pool, async (j) => void seen.push(typeOf(j)));
      await q.drain();
      // The second job must still be processed in the same drain() call, proving the pump() while-loop
      // continued past the first job's connection-loss instead of throwing out of it entirely.
      expect(seen).toEqual(["review"]);
    } finally {
      if (oldJitter === undefined) delete process.env.QUEUE_RATE_LIMIT_JITTER_MS;
      else process.env.QUEUE_RATE_LIMIT_JITTER_MS = oldJitter;
    }
  });

  it("pre-yields public-token GitHub-budget background jobs without installation ids", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const oldJitter = process.env.QUEUE_RATE_LIMIT_JITTER_MS;
    process.env.QUEUE_RATE_LIMIT_JITTER_MS = "0";
    try {
      const m = makePool();
      m.setRateLimitRows([{ admission_key: "public-token", repo_full_name: "owner/repo", remaining: "120", reset_at: "2026-06-24T12:10:00.000Z", observed_at: "2026-06-24T12:00:00.000Z" }]);
      m.enqueueJob("background", {
        type: "agent-regate-sweep",
        requestedBy: "schedule",
      });
      const seen: string[] = [];
      const q = createPgQueue(m.pool, async (j) => void seen.push(typeOf(j)));

      await q.drain();

      expect(seen).toEqual([]);
      expect(m.pool.query).toHaveBeenCalledWith(
        expect.stringContaining("SET status='pending', run_after=GREATEST"),
        [Date.parse("2026-06-24T12:10:15.000Z"), "github rate-limit background admission", "background"],
      );
      expect(await renderMetrics()).toContain('gittensory_jobs_rate_limit_admission_deferred_total{job_type="agent-regate-sweep",key_scope="public",kind="background"} 1');
    } finally {
      if (oldJitter === undefined) delete process.env.QUEUE_RATE_LIMIT_JITTER_MS;
      else process.env.QUEUE_RATE_LIMIT_JITTER_MS = oldJitter;
    }
  });

  it("pre-yields repo-scoped background jobs from global unkeyed REST observations", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const oldJitter = process.env.QUEUE_RATE_LIMIT_JITTER_MS;
    process.env.QUEUE_RATE_LIMIT_JITTER_MS = "0";
    try {
      const m = makePool();
      m.setRateLimitRows([{ admission_key: null, repo_full_name: "owner/other-repo", remaining: "120", reset_at: "2026-06-24T12:10:00.000Z", observed_at: "2026-06-24T12:00:00.000Z" }]);
      m.enqueueJob("background", {
        type: "rag-index-repo",
        requestedBy: "schedule",
        repoFullName: "owner/repo",
      });
      const seen: string[] = [];
      const q = createPgQueue(m.pool, async (j) => void seen.push(typeOf(j)));

      await q.drain();

      expect(seen).toEqual([]);
      expect(m.pool.query).toHaveBeenCalledWith(
        expect.stringContaining("SET status='pending', run_after=GREATEST"),
        [Date.parse("2026-06-24T12:10:15.000Z"), "github rate-limit background admission", "background"],
      );
    } finally {
      if (oldJitter === undefined) delete process.env.QUEUE_RATE_LIMIT_JITTER_MS;
      else process.env.QUEUE_RATE_LIMIT_JITTER_MS = oldJitter;
    }
  });

  it("pre-yields webhook jobs when the persisted REST bucket is exhausted", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const oldJitter = process.env.QUEUE_RATE_LIMIT_JITTER_MS;
    process.env.QUEUE_RATE_LIMIT_JITTER_MS = "0";
    try {
      const m = makePool();
      m.setRateLimitRows([{ admission_key: "installation:123", repo_full_name: "owner/other-repo", remaining: "50", reset_at: "2026-06-24T12:10:00.000Z", observed_at: "2026-06-24T11:59:30.000Z" }]);
      m.enqueueJob("webhook", { type: "github-webhook", deliveryId: "fresh", eventName: "pull_request", payload: { installation: { id: 123 }, repository: { full_name: "owner/repo" } } });
      const seen: string[] = [];
      const q = createPgQueue(m.pool, async (j) => void seen.push(typeOf(j)));

      await q.drain();

      expect(seen).toEqual([]);
      expect(m.pool.query).toHaveBeenCalledWith(
        expect.stringContaining("SET status='pending', run_after=GREATEST"),
        [Date.parse("2026-06-24T12:10:15.000Z"), "github rate-limit webhook admission", "webhook"],
      );
      expect(m.pool.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO _selfhost_job_stats"),
        ["gittensory_jobs_rate_limit_deferred_total", 1],
      );
      expect(await renderMetrics()).toContain('gittensory_jobs_rate_limit_admission_deferred_total{job_type="github-webhook",key_scope="installation",kind="webhook"} 1');
    } finally {
      if (oldJitter === undefined) delete process.env.QUEUE_RATE_LIMIT_JITTER_MS;
      else process.env.QUEUE_RATE_LIMIT_JITTER_MS = oldJitter;
    }
  });

  it("pre-yields webhook jobs from global legacy observations when an installation id is present", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const oldJitter = process.env.QUEUE_RATE_LIMIT_JITTER_MS;
    process.env.QUEUE_RATE_LIMIT_JITTER_MS = "0";
    try {
      const m = makePool();
      m.setRateLimitRows([{ admission_key: null, repo_full_name: "owner/other-repo", remaining: "50", reset_at: "2026-06-24T12:10:00.000Z", observed_at: "2026-06-24T12:00:00.000Z" }]);
      m.enqueueJob("webhook", { type: "github-webhook", deliveryId: "fresh", eventName: "pull_request", payload: { installation: { id: 123 }, repository: { full_name: "owner/repo" } } });
      const seen: string[] = [];
      const q = createPgQueue(m.pool, async (j) => void seen.push(typeOf(j)));

      await q.drain();

      expect(seen).toEqual([]);
      expect(m.pool.query).toHaveBeenCalledWith(
        expect.stringContaining("SET status='pending', run_after=GREATEST"),
        [Date.parse("2026-06-24T12:10:15.000Z"), "github rate-limit webhook admission", "webhook"],
      );
    } finally {
      if (oldJitter === undefined) delete process.env.QUEUE_RATE_LIMIT_JITTER_MS;
      else process.env.QUEUE_RATE_LIMIT_JITTER_MS = oldJitter;
    }
  });

  it("REGRESSION: a newer legacy unkeyed exhaustion does not pin a healthy exact installation observation (self-host webhook backlog)", async () => {
    // Before the fix: a stale/legacy null-admission_key row that happened to be observed MORE RECENTLY
    // than the installation's own (healthy) exact reading would win purely on recency, deferring every
    // webhook for a perfectly healthy installation. The exact reading must govern here.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const oldJitter = process.env.QUEUE_RATE_LIMIT_JITTER_MS;
    process.env.QUEUE_RATE_LIMIT_JITTER_MS = "0";
    try {
      const m = makePool();
      m.setRateLimitRows([
        { admission_key: "installation:123", repo_full_name: "owner/other-repo", remaining: "4000", reset_at: "2026-06-24T12:20:00.000Z", observed_at: "2026-06-24T11:59:00.000Z" },
        { admission_key: null, repo_full_name: "owner/repo", remaining: "0", reset_at: "2026-06-24T12:10:00.000Z", observed_at: "2026-06-24T12:00:00.000Z" },
      ]);
      m.enqueueJob("webhook", { type: "github-webhook", deliveryId: "fresh", eventName: "pull_request", payload: { installation: { id: 123 }, repository: { full_name: "owner/repo" } } });
      const seen: string[] = [];
      const q = createPgQueue(m.pool, async (j) => void seen.push(typeOf(j)));

      await q.drain();

      expect(seen).toEqual(["github-webhook"]);
      expect(m.pool.query).not.toHaveBeenCalledWith(
        expect.stringContaining("SET status='pending', run_after=GREATEST"),
        expect.anything(),
      );
    } finally {
      if (oldJitter === undefined) delete process.env.QUEUE_RATE_LIMIT_JITTER_MS;
      else process.env.QUEUE_RATE_LIMIT_JITTER_MS = oldJitter;
    }
  });

  it("REGRESSION: a newer healthy legacy observation does not clear a genuine exact installation exhaustion", async () => {
    // An unkeyed/legacy fallback is not proven to report on the SAME budget as the exact installation
    // key, so it must not "clear" a real exhaustion any more than it should be able to suppress a
    // healthy exact reading -- both directions trust an unrelated bucket's signal over this
    // installation's own. The exact observation's own reset_at already bounds the wait.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const oldJitter = process.env.QUEUE_RATE_LIMIT_JITTER_MS;
    process.env.QUEUE_RATE_LIMIT_JITTER_MS = "0";
    try {
      const m = makePool();
      m.setRateLimitRows([
        { admission_key: "installation:123", repo_full_name: "owner/other-repo", remaining: "0", reset_at: "2026-06-24T12:10:00.000Z", observed_at: "2026-06-24T11:59:00.000Z" },
        { admission_key: null, repo_full_name: "owner/repo", remaining: "4000", reset_at: "2026-06-24T12:20:00.000Z", observed_at: "2026-06-24T12:00:00.000Z" },
      ]);
      m.enqueueJob("webhook", { type: "github-webhook", deliveryId: "fresh", eventName: "pull_request", payload: { installation: { id: 123 }, repository: { full_name: "owner/repo" } } });
      const seen: string[] = [];
      const q = createPgQueue(m.pool, async (j) => void seen.push(typeOf(j)));

      await q.drain();

      expect(seen).toEqual([]);
      expect(m.pool.query).toHaveBeenCalledWith(
        expect.stringContaining("SET status='pending', run_after=GREATEST"),
        [Date.parse("2026-06-24T12:10:15.000Z"), "github rate-limit webhook admission", "webhook"],
      );
    } finally {
      if (oldJitter === undefined) delete process.env.QUEUE_RATE_LIMIT_JITTER_MS;
      else process.env.QUEUE_RATE_LIMIT_JITTER_MS = oldJitter;
    }
  });

  it("does not keep webhook admission closed from stale legacy low rows after a newer healthy legacy observation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const m = makePool();
    m.setRateLimitRows([
      { admission_key: null, repo_full_name: "owner/repo", remaining: "0", reset_at: "2026-06-24T12:10:00.000Z", observed_at: "2026-06-24T11:59:00.000Z" },
      { admission_key: null, repo_full_name: "owner/repo", remaining: "4000", reset_at: "2026-06-24T12:20:00.000Z", observed_at: "2026-06-24T12:00:00.000Z" },
    ]);
    m.enqueueJob("webhook", { type: "github-webhook", deliveryId: "fresh", eventName: "pull_request", payload: { installation: { id: 123 }, repository: { full_name: "owner/repo" } } });
    const seen: string[] = [];
    const q = createPgQueue(m.pool, async (j) => void seen.push(typeOf(j)));

    await q.drain();

    expect(seen).toEqual(["github-webhook"]);
    expect(m.pool.query).not.toHaveBeenCalledWith(
      expect.stringContaining("SET status='pending', run_after=GREATEST"),
      expect.anything(),
    );
  });

  it("does not keep webhook admission closed from stale legacy rows after a newer healthy exact observation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const m = makePool();
    m.setRateLimitRows([
      { admission_key: null, repo_full_name: "owner/repo", remaining: "0", reset_at: "2026-06-24T12:10:00.000Z", observed_at: "2026-06-24T11:59:00.000Z" },
      { admission_key: "installation:123", repo_full_name: "owner/repo", remaining: "4000", reset_at: "2026-06-24T12:20:00.000Z", observed_at: "2026-06-24T12:00:00.000Z" },
    ]);
    m.enqueueJob("webhook", { type: "github-webhook", deliveryId: "fresh", eventName: "pull_request", payload: { installation: { id: 123 }, repository: { full_name: "owner/repo" } } });
    const seen: string[] = [];
    const q = createPgQueue(m.pool, async (j) => void seen.push(typeOf(j)));

    await q.drain();

    expect(seen).toEqual(["github-webhook"]);
    expect(m.pool.query).not.toHaveBeenCalledWith(
      expect.stringContaining("SET status='pending', run_after=GREATEST"),
      expect.anything(),
    );
  });

  it("does not pre-yield webhook jobs for another installation's persisted REST exhaustion", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const m = makePool();
    m.setRateLimitRows([{ admission_key: "installation:456", repo_full_name: "owner/repo-a", remaining: "0", reset_at: "2026-06-24T12:10:00.000Z", observed_at: "2026-06-24T11:59:30.000Z" }]);
    m.enqueueJob("webhook", { type: "github-webhook", deliveryId: "fresh", eventName: "pull_request", payload: { installation: { id: 123 }, repository: { full_name: "owner/repo-b" } } });
    const seen: string[] = [];
    const q = createPgQueue(m.pool, async (j) => void seen.push(typeOf(j)));

    await q.drain();

    expect(seen).toEqual(["github-webhook"]);
    expect(m.pool.query).not.toHaveBeenCalledWith(
      expect.stringContaining("SET status='pending', run_after=GREATEST"),
      expect.anything(),
    );
  });

  it("skips the background-admission metric when the defer update changes no rows", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const oldJitter = process.env.QUEUE_RATE_LIMIT_JITTER_MS;
    process.env.QUEUE_RATE_LIMIT_JITTER_MS = "0";
    try {
      const m = makePool();
      m.setDeferUpdateRowCount(0);
      m.setRateLimitRows([{ repo_full_name: "owner/repo", remaining: 120, reset_at: "2026-06-24T12:10:00.000Z" }]);
      m.enqueueJob("background", {
        type: "rag-index-repo",
        requestedBy: "schedule",
        repoFullName: "owner/repo",
      });
      const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const seen: string[] = [];
      const q = createPgQueue(m.pool, async (j) => void seen.push(typeOf(j)));

      await q.drain();

      expect(seen).toEqual([]);
      expect(warned).not.toHaveBeenCalled();
      expect(m.pool.query).not.toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO _selfhost_job_stats"),
        ["gittensory_jobs_rate_limit_deferred_total", 1],
      );
    } finally {
      if (oldJitter === undefined) delete process.env.QUEUE_RATE_LIMIT_JITTER_MS;
      else process.env.QUEUE_RATE_LIMIT_JITTER_MS = oldJitter;
      vi.useRealTimers();
    }
  });

  it("dead-letters an unparseable payload (job_dead audit emitted)", async () => {
    const m = makePool();
    // Claim returns a row with bad payload.
    m.enqueueResult({ rows: [{ id: "1", payload: "not-json", attempts: 0 }], rowCount: 1 });
    const q = createPgQueue(m.pool, async () => undefined, { maxRetries: 3 });
    await q.init();
    await q.drain();
    // UPDATE dead + then no more rows → pump exits cleanly. Asserts the full clause set (not just "status='dead'")
    // so a malformed payload provably consumes the same bounded retry budget as a normal failure -- attempts must
    // be bumped, or the dead-letter reviver's own "attempts<ceiling" SELECT would requeue this row forever.
    expect(m.pool.query).toHaveBeenCalledWith(expect.stringContaining("status='dead', attempts=attempts+1, last_error='unparseable payload'"), expect.arrayContaining(["1"]));
  });

  it("retries a failing job (job_error audit emitted) then dead-letters at maxRetries (job_dead)", async () => {
    const m = makePool();
    // Two attempts: first → retry, second → dead-letter.
    m.enqueueJob("1", { type: "t" }, 0);
    m.enqueueJob("1", { type: "t" }, 1); // second claim after retry
    let calls = 0;
    const q = createPgQueue(m.pool, async () => { calls++; throw new Error("fail"); }, { maxRetries: 2, backoffMs: () => 0 });
    await q.init();
    await q.drain();
    await q.drain(); // second drain processes the retried job
    expect(calls).toBe(2);
  });

  describe("reviveDeadLetterJobs (#audit-rate-headroom)", () => {
    afterEach(() => {
      delete process.env.QUEUE_DEAD_LETTER_AUTO_RETRY_MAX_EXTRA_ATTEMPTS;
    });

    it("requeues dead jobs still under the auto-retry ceiling, clearing last_error, and records the metric", async () => {
      process.env.QUEUE_DEAD_LETTER_AUTO_RETRY_MAX_EXTRA_ATTEMPTS = "2";
      const m = makePool();
      m.fn.mockResolvedValueOnce({
        rows: [
          { id: "1", payload: JSON.stringify({ type: "t" }), job_key: null },
          { id: "2", payload: JSON.stringify({ type: "t" }), job_key: "k" },
        ],
        rowCount: 2,
      }); // SELECT status='dead' AND attempts<ceiling
      const q = createPgQueue(m.pool, async () => undefined, { maxRetries: 1 });

      const revived = await q.reviveDeadLetterJobs();

      expect(revived).toBe(2);
      // The SELECT was bound to the ceiling (maxRetries=1 + extra=2 = 3), not a raw maxRetries.
      expect(m.fn).toHaveBeenCalledWith(expect.stringContaining("status='dead' AND attempts<$1"), [3]);
      // Each eligible row is revived to pending with last_error cleared -- not a fresh retry budget (attempts
      // is never touched here).
      expect(m.fn).toHaveBeenCalledWith(
        expect.stringContaining("SET status='pending', run_after=$1, last_error=NULL"),
        expect.arrayContaining(["1"]),
      );
      expect(m.fn).toHaveBeenCalledWith(
        expect.stringContaining("SET status='pending', run_after=$1, last_error=NULL"),
        expect.arrayContaining(["2"]),
      );
      expect(await renderMetrics()).toContain("gittensory_jobs_dead_letter_revived_total 2");
    });

    it("is a no-op (and records nothing) when no dead job is under the ceiling", async () => {
      const m = makePool();
      m.fn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const q = createPgQueue(m.pool, async () => undefined, { maxRetries: 1 });

      const revived = await q.reviveDeadLetterJobs();

      expect(revived).toBe(0);
      expect(await renderMetrics()).not.toContain("gittensory_jobs_dead_letter_revived_total");
    });

    // REGRESSION (#2581 review defect): the SELECT is a stale snapshot. Without an "AND status='dead'" re-check on
    // the UPDATE, an overlapping reviver (another self-host instance, or a slow prior tick still running when the
    // next one fires) that already moved a row out of 'dead' -- e.g. into 'processing' via a normal claim -- would
    // get silently flipped back to 'pending' by this stale UPDATE, letting the job run a second time concurrently.
    it("does NOT count a row as revived when another reviver already moved it out of 'dead' (rowCount 0) -- only the row that actually changed status counts", async () => {
      const m = makePool();
      m.fn.mockResolvedValueOnce({
        rows: [
          { id: "1", payload: JSON.stringify({ type: "t" }), job_key: null },
          { id: "2", payload: JSON.stringify({ type: "t" }), job_key: "k" },
        ],
        rowCount: 2,
      }); // SELECT status='dead' AND attempts<ceiling -- a stale snapshot of both rows
      // Row "1" lost the race (another reviver/claim already moved it out of 'dead' -- UPDATE affects 0 rows);
      // row "2" is still genuinely dead and gets revived.
      m.setReviveUpdateRowCounts([0, 1]);
      const q = createPgQueue(m.pool, async () => undefined, { maxRetries: 1 });

      const revived = await q.reviveDeadLetterJobs();

      // Only the ONE row whose UPDATE actually matched (still 'dead' at UPDATE time) counts -- not the raw SELECT
      // count of 2, which would have double-counted the row another reviver already claimed.
      expect(revived).toBe(1);
      expect(m.fn).toHaveBeenCalledWith(
        expect.stringContaining(
          "SET status='pending', run_after=$1, last_error=NULL, dead_at=NULL WHERE id=$2 AND status='dead'",
        ),
        expect.arrayContaining(["1"]),
      );
      expect(m.fn).toHaveBeenCalledWith(
        expect.stringContaining(
          "SET status='pending', run_after=$1, last_error=NULL, dead_at=NULL WHERE id=$2 AND status='dead'",
        ),
        expect.arrayContaining(["2"]),
      );
      expect(await renderMetrics()).toContain("gittensory_jobs_dead_letter_revived_total 1");
    });

    // REGRESSION (#2581 review defect): the revive interval had no error handler of its own, so a thrown
    // pool/metric failure on that tick would surface as an unhandled promise rejection and could terminate the
    // process -- exactly the failure mode pump()'s own try/catch already guards against for the main poll loop.
    it("survives a reviveDeadLetterJobs() pool failure on the interval tick instead of crashing the process", async () => {
      process.env.QUEUE_DEAD_LETTER_REVIVE_INTERVAL_MS = "1000";
      vi.useFakeTimers();
      try {
        const fn = vi.fn().mockImplementation(async (sql: unknown) => {
          if (String(sql).includes("WHERE status='dead' AND attempts<$1")) throw new Error("connection terminated unexpectedly");
          return { rows: [], rowCount: 0 };
        });
        const pool = { query: fn } as unknown as Pool;
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const q = createPgQueue(pool, async () => undefined, { maxRetries: 1 });

        q.start();
        await vi.advanceTimersByTimeAsync(1000); // the revive interval fires once

        const logged = errorSpy.mock.calls.map(([line]) => String(line));
        expect(logged.some((line) => line.includes("selfhost_queue_dead_letter_revive_crashed") && line.includes("connection terminated unexpectedly"))).toBe(true);
        await q.stop();
      } finally {
        delete process.env.QUEUE_DEAD_LETTER_REVIVE_INTERVAL_MS;
      }
    });

    // (#1824): dead-letter revival stopping SILENTLY is worse than one throwing tick -- a Sentry cron monitor
    // now wraps every tick so a stopped timer shows up as a missed check-in, not silence.
    it("wraps each revive tick in the queue-dead-letter-revive Sentry monitor", async () => {
      process.env.QUEUE_DEAD_LETTER_REVIVE_INTERVAL_MS = "1000";
      vi.useFakeTimers();
      const monitorSpy = vi.spyOn(sentryModule, "withSentryMonitor");
      try {
        const m = makePool(); // default mock returns { rows: [], rowCount: 0 } for the dead-letter SELECT -- a no-op tick
        const q = createPgQueue(m.pool, async () => undefined, { maxRetries: 1 });

        q.start();
        await vi.advanceTimersByTimeAsync(1000); // the revive interval fires once

        expect(monitorSpy).toHaveBeenCalledWith(
          "queue-dead-letter-revive",
          { jobType: "queue-dead-letter-revive" },
          expect.any(Function),
        );
        await q.stop();
      } finally {
        monitorSpy.mockRestore();
        delete process.env.QUEUE_DEAD_LETTER_REVIVE_INTERVAL_MS;
      }
    });

    // The monitor rethrows on failure (withSentryMonitor's own contract) -- confirms that rethrow is still caught
    // by reviveDeadLetterJobsSafely's own try/catch, so a crashing tick behaves exactly as it did before the
    // monitor was added: logged + captured, never an unhandled rejection.
    it("still catches a revive crash after adding the Sentry monitor wrapper (no regression on #2581)", async () => {
      process.env.QUEUE_DEAD_LETTER_REVIVE_INTERVAL_MS = "1000";
      vi.useFakeTimers();
      const monitorSpy = vi.spyOn(sentryModule, "withSentryMonitor");
      try {
        const fn = vi.fn().mockImplementation(async (sql: unknown) => {
          if (String(sql).includes("WHERE status='dead' AND attempts<$1")) throw new Error("connection terminated unexpectedly");
          return { rows: [], rowCount: 0 };
        });
        const pool = { query: fn } as unknown as Pool;
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const q = createPgQueue(pool, async () => undefined, { maxRetries: 1 });

        q.start();
        await vi.advanceTimersByTimeAsync(1000);

        expect(monitorSpy).toHaveBeenCalledWith(
          "queue-dead-letter-revive",
          { jobType: "queue-dead-letter-revive" },
          expect.any(Function),
        );
        const logged = errorSpy.mock.calls.map(([line]) => String(line));
        expect(logged.some((line) => line.includes("selfhost_queue_dead_letter_revive_crashed") && line.includes("connection terminated unexpectedly"))).toBe(true);
        await q.stop();
      } finally {
        monitorSpy.mockRestore();
        delete process.env.QUEUE_DEAD_LETTER_REVIVE_INTERVAL_MS;
      }
    });
  });

  describe("releaseStaleForegroundDeferrals (#selfhost-queue-liveness)", () => {
    afterEach(() => {
      delete process.env.FOREGROUND_LIVENESS_ENABLED;
      delete process.env.FOREGROUND_LIVENESS_MAX_DEFER_MS;
    });

    it("releases a foreground-priority pending row deferred far into the future once its created_at is stale", async () => {
      process.env.FOREGROUND_LIVENESS_MAX_DEFER_MS = "60000"; // 1m (parsePositiveIntEnv floor)
      const m = makePool();
      const now = Date.now();
      // priority>=8 (foreground), run_after far in the future, created_at old enough to cross the 1m ceiling.
      m.setForegroundLivenessCandidates([{ id: "fg-1", created_at: now - 61_000 }]);
      const q = createPgQueue(m.pool, async () => undefined);

      const released = await q.releaseStaleForegroundDeferrals();

      expect(released).toBe(1);
      expect(m.fn).toHaveBeenCalledWith(
        expect.stringContaining("SELECT id, payload, created_at FROM _selfhost_jobs WHERE status='pending' AND priority>=$1 AND run_after>$2"),
        expect.arrayContaining([8]),
      );
      expect(m.fn).toHaveBeenCalledWith(
        expect.stringContaining("SET run_after=$1 WHERE id=$2 AND status='pending' AND run_after>$1"),
        expect.arrayContaining(["fg-1"]),
      );
      expect(await renderMetrics()).toContain("gittensory_jobs_foreground_liveness_released_total 1");
    });

    // Isolates the AGE condition from the OR'd rate-limit-clear condition: the default candidate payload
    // (recapture-preview) is always rate-limit-"clear" (see setForegroundLivenessCandidates' own doc comment),
    // so this test uses a github-webhook payload WITH a genuinely exhausted, still-future-reset observation for
    // its admission key, ensuring isRateLimitAdmissionNowClear() returns false and only the age check governs.
    it("does NOT release a foreground row whose created_at is still recent (not yet stale) AND is still genuinely rate-limited", async () => {
      process.env.FOREGROUND_LIVENESS_MAX_DEFER_MS = "600000"; // default 10m
      const m = makePool();
      const now = Date.now();
      m.setRateLimitRows([
        {
          admission_key: "installation:123",
          remaining: 1,
          reset_at: new Date(now + 30 * 60_000).toISOString(),
          observed_at: new Date(now).toISOString(),
        },
      ]);
      const payload = JSON.stringify({
        type: "github-webhook",
        deliveryId: "still-blocked",
        eventName: "x",
        payload: { installation: { id: 123 } },
      });
      // Same shape as the stale case (foreground priority, future run_after) but created_at is only 1s old.
      m.setForegroundLivenessCandidates([{ id: "fg-fresh", created_at: now - 1_000, payload }]);
      const q = createPgQueue(m.pool, async () => undefined);

      const released = await q.releaseStaleForegroundDeferrals();

      expect(released).toBe(0);
      expect(m.fn).not.toHaveBeenCalledWith(
        expect.stringContaining("SET run_after=$1 WHERE id=$2 AND status='pending' AND run_after>$1"),
        expect.arrayContaining(["fg-fresh"]),
      );
      expect(await renderMetrics()).not.toContain("gittensory_jobs_foreground_liveness_released_total");
    });

    it("caches foreground-liveness admission reads for candidates sharing the same rate-limit target", async () => {
      process.env.FOREGROUND_LIVENESS_MAX_DEFER_MS = "600000";
      const m = makePool();
      const now = Date.now();
      m.setRateLimitRows([
        {
          admission_key: "installation:123",
          remaining: 1,
          reset_at: new Date(now + 30 * 60_000).toISOString(),
          observed_at: new Date(now).toISOString(),
        },
      ]);
      const payload = (deliveryId: string) =>
        JSON.stringify({
          type: "github-webhook",
          deliveryId,
          eventName: "x",
          payload: { installation: { id: 123 } },
        });
      m.setForegroundLivenessCandidates([
        { id: "fg-fresh-1", created_at: now - 1_000, payload: payload("fg-fresh-1") },
        { id: "fg-fresh-2", created_at: now - 1_000, payload: payload("fg-fresh-2") },
      ]);
      const q = createPgQueue(m.pool, async () => undefined);

      const released = await q.releaseStaleForegroundDeferrals();

      expect(released).toBe(0);
      const admissionReads = (m.fn as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([sql]: unknown[]) => String(sql).includes("FROM github_rate_limit_observations"));
      expect(admissionReads).toHaveLength(1);
    });

    // CONDITION-BASED recovery (the second OR arm): a foreground job whose created_at is nowhere near stale but
    // whose rate-limit observation has since cleared (no blocking observation seeded here) is released anyway --
    // the whole point of pairing the age floor with a rate-limit-aware re-check (see the source's own doc
    // comment on releaseStaleForegroundDeferrals).
    it("releases a foreground row that is NOT yet age-stale once rate-limit admission for it reads clear", async () => {
      process.env.FOREGROUND_LIVENESS_MAX_DEFER_MS = "600000"; // default 10m -- nowhere near stale by age
      const m = makePool();
      const now = Date.now();
      const payload = JSON.stringify({
        type: "github-webhook",
        deliveryId: "now-clear",
        eventName: "x",
        payload: { installation: { id: 123 } },
      });
      // No rate-limit rows seeded at all -- rateLimitAdmissionDelayMs degrades to "clear".
      m.setForegroundLivenessCandidates([{ id: "fg-clear", created_at: now - 1_000, payload }]);
      const q = createPgQueue(m.pool, async () => undefined);

      const released = await q.releaseStaleForegroundDeferrals();

      expect(released).toBe(1);
      expect(await renderMetrics()).toContain("gittensory_jobs_foreground_liveness_released_total 1");
    });

    // The payload is unparseable -- isRateLimitAdmissionNowClear's own catch(){ return false } branch -- so ONLY
    // the age condition can release it; while young, it must stay parked exactly like any other not-yet-stale,
    // still-blocked row.
    it("does NOT release a foreground row with an unparseable payload before it is age-stale", async () => {
      process.env.FOREGROUND_LIVENESS_MAX_DEFER_MS = "600000";
      const m = makePool();
      const now = Date.now();
      m.setForegroundLivenessCandidates([{ id: "fg-bad-json", created_at: now - 1_000, payload: "not valid json" }]);
      const q = createPgQueue(m.pool, async () => undefined);

      const released = await q.releaseStaleForegroundDeferrals();

      expect(released).toBe(0);
    });

    // The priority>=$1 filter is enforced by the candidate SELECT's own WHERE clause (bound to
    // FOREGROUND_QUEUE_PRIORITY_FLOOR=8), not by any application-side check on the returned rows -- mirrors how
    // the maintenance-admission pressure tests in this file assert the is_maintenance=1 predicate is present in
    // the issued SQL rather than re-deriving it from mock row shapes. Asserting the bind param here is the
    // faithful way to prove a background-priority (<8) row is structurally excluded from ever being considered.
    it("scopes the candidate SELECT to foreground priority via the FOREGROUND_QUEUE_PRIORITY_FLOOR bind param", async () => {
      const m = makePool();
      m.setForegroundLivenessCandidates([]); // the real WHERE priority>=8 excludes a background row; assert the bind param enforces it
      const q = createPgQueue(m.pool, async () => undefined);

      const released = await q.releaseStaleForegroundDeferrals();

      expect(released).toBe(0);
      expect(m.fn).toHaveBeenCalledWith(
        expect.stringContaining("priority>=$1"),
        expect.arrayContaining([8]),
      );
    });

    it("returns 0 immediately without issuing the candidate SELECT when FOREGROUND_LIVENESS_ENABLED=false", async () => {
      process.env.FOREGROUND_LIVENESS_ENABLED = "false";
      const m = makePool();
      const now = Date.now();
      m.setForegroundLivenessCandidates([{ id: "fg-1", created_at: now - 10 * 60_000 }]);
      const q = createPgQueue(m.pool, async () => undefined);

      const released = await q.releaseStaleForegroundDeferrals();

      expect(released).toBe(0);
      expect(m.fn).not.toHaveBeenCalledWith(
        expect.stringContaining("SELECT id, payload, created_at FROM _selfhost_jobs WHERE status='pending' AND priority>=$1 AND run_after>$2"),
        expect.anything(),
      );
      expect(await renderMetrics()).not.toContain("gittensory_jobs_foreground_liveness_released_total");
    });

    // REGRESSION (#selfhost-queue-liveness): the production incident this module exists to make structurally
    // impossible -- a GitHub rate-limit sweep pushes MANY foreground-priority jobs' run_after far into the
    // future at once (a shared REST budget drained by a post-deploy catch-up burst), and without this release
    // path they'd sit deferred for up to the ~65-minute worst-case rate-limit window with zero runnable work,
    // requiring manual intervention. Assert releaseStaleForegroundDeferrals() releases ALL stale rows in ONE
    // sweep (not just the first) and records the metric as a SINGLE aggregate increment, not one per row --
    // matching the source's own "logs + records a metric ONCE per sweep (aggregate count), not per row" doc
    // comment, which exists specifically so a large release batch cannot spam the log/metric.
    it("releases every stale foreground deferral in one sweep and records one aggregate metric increment (regression for #selfhost-queue-liveness)", async () => {
      process.env.FOREGROUND_LIVENESS_MAX_DEFER_MS = "60000"; // 1m floor
      const m = makePool();
      const now = Date.now();
      const staleAge = now - 5 * 60_000; // 5m old -- well past the 1m ceiling
      m.setForegroundLivenessCandidates([
        { id: "stuck-1", created_at: staleAge },
        { id: "stuck-2", created_at: staleAge },
        { id: "stuck-3", created_at: staleAge },
      ]);
      const q = createPgQueue(m.pool, async () => undefined);

      const released = await q.releaseStaleForegroundDeferrals();

      expect(released).toBe(3);
      for (const id of ["stuck-1", "stuck-2", "stuck-3"]) {
        expect(m.fn).toHaveBeenCalledWith(
          expect.stringContaining("SET run_after=$1 WHERE id=$2 AND status='pending' AND run_after>$1"),
          expect.arrayContaining([id]),
        );
      }
      // Exactly one aggregate increment of 3, not three separate increments of 1.
      expect(await renderMetrics()).toContain("gittensory_jobs_foreground_liveness_released_total 3");
    });

    // Ramp-up cap (#selfhost-queue-liveness): a large inherited backlog (the production incident had ~190
    // over-deferred rows) must not release ALL of it in one sweep -- that many jobs re-attempting GitHub reads
    // at once can immediately re-trip the same rate-limit bucket they were deferred for. With the cap set
    // below the eligible count, assert only `cap` rows get their UPDATE issued, and that the OLDEST rows
    // (smallest created_at) are the ones chosen.
    it("caps releases at FOREGROUND_LIVENESS_MAX_RELEASE_PER_SWEEP, releasing the oldest rows first", async () => {
      process.env.FOREGROUND_LIVENESS_MAX_DEFER_MS = "60000"; // 1m floor
      process.env.FOREGROUND_LIVENESS_MAX_RELEASE_PER_SWEEP = "2";
      const m = makePool();
      const now = Date.now();
      // 4 stale-eligible rows at distinct ages; only the 2 OLDEST should be released.
      m.setForegroundLivenessCandidates([
        { id: "oldest", created_at: now - 10 * 60_000 },
        { id: "second-oldest", created_at: now - 8 * 60_000 },
        { id: "newer", created_at: now - 6 * 60_000 },
        { id: "newest", created_at: now - 5 * 60_000 },
      ]);
      const q = createPgQueue(m.pool, async () => undefined);

      const released = await q.releaseStaleForegroundDeferrals();

      expect(released).toBe(2);
      // candidateLimit is now maxReleasePerSweep itself (2), not maxReleasePerSweep * 2 -- the query is issued
      // TWICE (an oldest-ordered window and a newest-ordered window, #selfhost-queue-liveness clear-bucket
      // starvation fix), each individually bounded to maxReleasePerSweep so the combined worst-case candidate
      // budget is unchanged.
      expect(m.fn).toHaveBeenCalledWith(
        expect.stringContaining("ORDER BY created_at ASC, id ASC LIMIT $3"),
        expect.arrayContaining([8, 2]),
      );
      expect(m.fn).toHaveBeenCalledWith(
        expect.stringContaining("ORDER BY created_at DESC, id DESC LIMIT $3"),
        expect.arrayContaining([8, 2]),
      );
      for (const id of ["oldest", "second-oldest"]) {
        expect(m.fn).toHaveBeenCalledWith(
          expect.stringContaining("SET run_after=$1 WHERE id=$2 AND status='pending' AND run_after>$1"),
          expect.arrayContaining([id]),
        );
      }
      for (const id of ["newer", "newest"]) {
        expect(m.fn).not.toHaveBeenCalledWith(
          expect.stringContaining("SET run_after=$1 WHERE id=$2 AND status='pending' AND run_after>$1"),
          expect.arrayContaining([id]),
        );
      }
      expect(await renderMetrics()).toContain("gittensory_jobs_foreground_liveness_released_total 2");
      delete process.env.FOREGROUND_LIVENESS_MAX_RELEASE_PER_SWEEP;
    });

    it("does not let older still-blocked stale rows consume the cap before a newer clear row", async () => {
      process.env.FOREGROUND_LIVENESS_MAX_DEFER_MS = "60000";
      process.env.FOREGROUND_LIVENESS_MAX_RELEASE_PER_SWEEP = "2";
      const m = makePool();
      const now = Date.now();
      m.setRateLimitRows([
        {
          admission_key: "installation:111",
          remaining: 1,
          reset_at: new Date(now + 30 * 60_000).toISOString(),
          observed_at: new Date(now).toISOString(),
        },
      ]);
      const payload = (deliveryId: string, installationId: number) =>
        JSON.stringify({
          type: "github-webhook",
          deliveryId,
          eventName: "x",
          payload: { installation: { id: installationId } },
        });
      m.setForegroundLivenessCandidates([
        { id: "blocked-oldest", created_at: now - 10 * 60_000, payload: payload("blocked-oldest", 111) },
        { id: "blocked-second", created_at: now - 9 * 60_000, payload: payload("blocked-second", 111) },
        { id: "clear-newer", created_at: now - 5 * 60_000, payload: payload("clear-newer", 222) },
      ]);
      const q = createPgQueue(m.pool, async () => undefined);

      const released = await q.releaseStaleForegroundDeferrals();

      expect(released).toBe(2);
      for (const id of ["clear-newer", "blocked-oldest"]) {
        expect(m.fn).toHaveBeenCalledWith(
          expect.stringContaining("SET run_after=$1 WHERE id=$2 AND status='pending' AND run_after>$1"),
          expect.arrayContaining([id]),
        );
      }
      expect(m.fn).not.toHaveBeenCalledWith(
        expect.stringContaining("SET run_after=$1 WHERE id=$2 AND status='pending' AND run_after>$1"),
        expect.arrayContaining(["blocked-second"]),
      );
    });

    // REGRESSION (#selfhost-queue-liveness clear-bucket starvation): the test above never exceeds the OLD
    // single-window candidateLimit (maxReleasePerSweep * 2 = 4 for 3 seeded rows), so it can't actually catch a
    // regression to the old single-`ORDER BY created_at ASC LIMIT` query -- that window would still have
    // included "clear-newer" by coincidence. This test uses setForegroundLivenessCandidatesByWindow to program
    // the OLDEST window as entirely older still-blocked rows (as a real oldest-first LIMIT query against a
    // large glut would return) and the NEWEST window as containing the newer clear-bucket row (as a real
    // newest-first LIMIT query would), proving the two windows are queried and merged independently -- a single
    // bounded oldest-first query would have hidden "clear-newer" from `eligible` entirely.
    it("REGRESSION: releases a newer clear-bucket row even when the oldest-ordered window is entirely older still-blocked rows", async () => {
      process.env.FOREGROUND_LIVENESS_MAX_DEFER_MS = "60000";
      process.env.FOREGROUND_LIVENESS_MAX_RELEASE_PER_SWEEP = "2";
      const m = makePool();
      const now = Date.now();
      m.setRateLimitRows([
        {
          admission_key: "installation:111",
          remaining: 1,
          reset_at: new Date(now + 30 * 60_000).toISOString(),
          observed_at: new Date(now).toISOString(),
        },
      ]);
      const payload = (deliveryId: string, installationId: number) =>
        JSON.stringify({
          type: "github-webhook",
          deliveryId,
          eventName: "x",
          payload: { installation: { id: installationId } },
        });
      m.setForegroundLivenessCandidatesByWindow(
        // The oldest-ordered window: a large glut of older still-blocked rows (installation 111 is exhausted
        // above) is ALL a real "ORDER BY created_at ASC LIMIT" query would ever return once the backlog exceeds
        // the limit -- "clear-newer" never appears here.
        [
          { id: "blocked-oldest", created_at: now - 20 * 60_000, payload: payload("blocked-oldest", 111) },
          { id: "blocked-second", created_at: now - 19 * 60_000, payload: payload("blocked-second", 111) },
        ],
        // The newest-ordered window: the fix's whole point -- a real "ORDER BY created_at DESC LIMIT" query
        // always surfaces the most-recently-enqueued pending rows regardless of how large the older-blocked
        // backlog is, so "clear-newer" (a different, non-exhausted admission target) is always represented.
        [{ id: "clear-newer", created_at: now - 5_000, payload: payload("clear-newer", 222) }],
      );
      const q = createPgQueue(m.pool, async () => undefined);

      const released = await q.releaseStaleForegroundDeferrals();

      expect(released).toBe(2);
      for (const id of ["clear-newer", "blocked-oldest"]) {
        expect(m.fn).toHaveBeenCalledWith(
          expect.stringContaining("SET run_after=$1 WHERE id=$2 AND status='pending' AND run_after>$1"),
          expect.arrayContaining([id]),
        );
      }
      expect(m.fn).not.toHaveBeenCalledWith(
        expect.stringContaining("SET run_after=$1 WHERE id=$2 AND status='pending' AND run_after>$1"),
        expect.arrayContaining(["blocked-second"]),
      );
    });

    // A stale candidate can lose the UPDATE race (another instance/tick already moved it) -- mirrors
    // reviveDeadLetterJobs' own "AND status='dead'" re-check pattern: only rows whose UPDATE actually matched
    // (rowCount 1) count toward the release total, never the raw SELECT candidate count.
    it("counts only rows whose conditional UPDATE actually matched, not the raw candidate count", async () => {
      process.env.FOREGROUND_LIVENESS_MAX_DEFER_MS = "60000";
      const m = makePool();
      const now = Date.now();
      const staleAge = now - 5 * 60_000;
      m.setForegroundLivenessCandidates(
        [
          { id: "won-race", created_at: staleAge },
          { id: "lost-race", created_at: staleAge },
        ],
        [1, 0], // second row's UPDATE matches zero rows -- already released/claimed by someone else
      );
      const q = createPgQueue(m.pool, async () => undefined);

      const released = await q.releaseStaleForegroundDeferrals();

      expect(released).toBe(1);
    });

    it("handles a null rowCount from the release UPDATE (rowCount ?? 0 nullish arm)", async () => {
      process.env.FOREGROUND_LIVENESS_MAX_DEFER_MS = "60000";
      const now = Date.now();
      // pg's driver can report a null rowCount for some UPDATEs; the release count must tolerate it rather
      // than propagate NaN (mirrors init()'s own "handles null rowCount from the recovery query" test).
      const fn = vi.fn().mockImplementation(async (sql: unknown) => {
        const q = String(sql);
        if (q.includes("SELECT id, payload, created_at FROM") && q.includes("priority>=$1 AND run_after>$2")) {
          return { rows: [{ id: "fg-null", created_at: now - 5 * 60_000 }], rowCount: 1 };
        }
        if (q.includes("SET run_after=$1 WHERE id=$2 AND status='pending' AND run_after>$1")) {
          return { rows: [], rowCount: null };
        }
        return { rows: [], rowCount: 0 };
      });
      const q = createPgQueue({ query: fn } as unknown as Pool, async () => undefined);

      const released = await q.releaseStaleForegroundDeferrals();

      expect(released).toBe(0); // null ?? 0 -- no metric recorded, no crash
      expect(await renderMetrics()).not.toContain("gittensory_jobs_foreground_liveness_released_total");
    });
  });

  describe("processingCount (#selfhost-queue-liveness)", () => {
    it("returns the count of status='processing' jobs", async () => {
      const { pool } = makePool();
      // makePool returns { c: "3" } for any COUNT(*) query, including WHERE status='processing'.
      const q = createPgQueue(pool, async () => undefined);
      expect(await q.processingCount()).toBe(3);
    });
  });

  it("reschedules GitHub rate-limit failures without consuming the dead-letter budget", async () => {
    const m = makePool();
    m.enqueueJob("1", { type: "github-webhook" }, 4);
    const rateLimit = new Error("API rate limit exceeded for installation ID 123");
    Object.assign(rateLimit, {
      status: 403,
      response: { headers: { "retry-after": "120" } },
    });
    const q = createPgQueue(
      m.pool,
      async () => {
        throw rateLimit;
      },
      { maxRetries: 1, backoffMs: () => 0 },
    );
    await q.init();
    await q.drain();
    expect(m.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("SET status='pending', run_after=$1"),
      expect.arrayContaining([expect.any(Number), "API rate limit exceeded for installation ID 123", "1"]),
    );
    expect(m.pool.query).not.toHaveBeenCalledWith(
      expect.stringContaining("status='dead'"),
      expect.anything(),
    );
  });

  it("does not put status-less provider rate limits on the global GitHub cooldown path", async () => {
    const m = makePool();
    m.enqueueJob("1", { type: "github-webhook" }, 0);
    m.enqueueJob("1", { type: "github-webhook" }, 1);
    let calls = 0;
    const q = createPgQueue(
      m.pool,
      async () => {
        calls += 1;
        throw new Error("openai api rate limit exceeded");
      },
      { maxRetries: 2, backoffMs: () => 0 },
    );

    await q.init();
    await q.drain();
    await q.drain();

    expect(calls).toBe(2);
    expect(m.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("SET status='pending', attempts=$1"),
      expect.arrayContaining([1, expect.any(Number), "openai api rate limit exceeded", "1"]),
    );
    expect(m.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("SET status='dead', attempts=$1"),
      [2, "openai api rate limit exceeded", expect.any(Number), "1"],
    );
    expect(m.pool.query).not.toHaveBeenCalledWith(
      expect.stringContaining("gittensory_jobs_rate_limited_total"),
      expect.anything(),
    );
  });

  it("does not defer GitHub work when a non-GitHub job throws a GitHub-looking rate limit", async () => {
    const m = makePool();
    m.enqueueJob("1", msg("refresh-registry"), 0);
    m.enqueueJob("2", installedWebhook("github-still-runs", 123), 0);
    const seen: string[] = [];
    const rateLimit = new Error("API rate limit exceeded for installation ID 123");
    Object.assign(rateLimit, {
      status: 403,
      response: { headers: { "retry-after": "120" } },
    });
    const q = createPgQueue(
      m.pool,
      async (message) => {
        seen.push(message.type === "github-webhook" ? message.deliveryId ?? "" : message.type);
        if (message.type === "refresh-registry") throw rateLimit;
      },
      { maxRetries: 1, backoffMs: () => 0 },
    );
    await q.init();
    await q.drain();

    expect(seen).toEqual(["refresh-registry", "github-still-runs"]);
    expect(m.pool.query).not.toHaveBeenCalledWith(
      expect.stringContaining("SET run_after=GREATEST(run_after, $1), last_error=COALESCE"),
      expect.arrayContaining([expect.any(Number), "github rate-limit budget deferred", expect.any(String)]),
    );
    expect(m.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM _selfhost_jobs WHERE id=$1"),
      ["2"],
    );
    expect(await renderMetrics()).toContain('gittensory_jobs_rate_limited_by_type_total{job_type="refresh-registry",key_scope="unknown",kind="unknown"} 1');
  });

  it("defers matching GitHub-budget jobs and coalesces a keyed rate-limit retry into the pending duplicate", async () => {
    const oldJitter = process.env.QUEUE_STARTUP_JITTER_MS;
    process.env.QUEUE_STARTUP_JITTER_MS = "0";
    const rateLimit = new Error("API rate limit exceeded for installation ID 123");
    Object.assign(rateLimit, {
      status: 403,
      response: { headers: { "retry-after": "120" } },
    });
    let claimed = false;
    const fn = vi.fn().mockImplementation(async (sql: unknown, params?: unknown[]) => {
      const q = String(sql);
      if (q.includes("SELECT id, payload, priority")) return { rows: [], rowCount: 0 };
      if (q.includes("SELECT id, payload, job_key") && q.includes("status IN")) return { rows: [], rowCount: 0 };
      if (q.includes("WHERE status='processing'")) return { rows: [], rowCount: 0 };
      if (q.includes("UPDATE _selfhost_jobs SET status='processing'")) {
        if (claimed) return { rows: [], rowCount: 0 };
        claimed = true;
        return {
          rows: [{
            id: "active",
            payload: JSON.stringify(installedWebhook("ci-active", 123)),
            attempts: 0,
            job_key: "github-webhook:ci-completed:jsonbored/gittensory@abc1234#7",
          }],
          rowCount: 1,
        };
      }
      if (q.includes("SELECT id, payload, job_key FROM _selfhost_jobs WHERE status='pending' AND run_after<=$1")) {
        return {
          rows: [
            { id: "pending-same", payload: JSON.stringify(regateJob(123, 9)), job_key: "agent-regate-pr:jsonbored/gittensory#9" },
            { id: "pending-legacy", payload: JSON.stringify(regateJob(null, 10)), job_key: "agent-regate-pr:jsonbored/gittensory#10" },
            { id: "pending-other", payload: JSON.stringify(regateJob(456, 11)), job_key: "agent-regate-pr:jsonbored/gittensory#11" },
            { id: "pending-local", payload: JSON.stringify(msg("local-cleanup")), job_key: null },
            { id: "pending-malformed", payload: "{not json", job_key: null },
          ],
          rowCount: 1,
        };
      }
      if (q.includes("SELECT id FROM _selfhost_jobs WHERE status='pending' AND job_key=$1 AND id<>$2")) {
        return { rows: [{ id: "existing" }], rowCount: 1 };
      }
      if (q.includes("SELECT id FROM _selfhost_jobs WHERE status='pending' AND job_key=$1 ORDER BY")) {
        return { rows: [], rowCount: 0 };
      }
      if (
        q.includes("SET run_after=GREATEST(run_after, $1), last_error=COALESCE") &&
        params?.[2] === "pending-legacy"
      ) {
        return { rows: [], rowCount: null };
      }
      return { rows: [], rowCount: 1 };
    });
    try {
      const q = createPgQueue(
        { query: fn } as unknown as Pool,
        async () => {
          throw rateLimit;
        },
        { maxRetries: 1, backoffMs: () => 0 },
      );
      await q.init();
      await q.drain();
      await q.binding.send(ciWebhook("after-rate-limit"), { delaySeconds: 0 });

      expect(fn).toHaveBeenCalledWith(
        expect.stringContaining("SET run_after=GREATEST(run_after, $1), last_error=COALESCE"),
        expect.arrayContaining([expect.any(Number), "github rate-limit budget deferred", "pending-same"]),
      );
      expect(fn).not.toHaveBeenCalledWith(
        expect.stringContaining("SET run_after=GREATEST(run_after, $1), last_error=COALESCE"),
        expect.arrayContaining([expect.any(Number), "github rate-limit budget deferred", "pending-legacy"]),
      );
      expect(fn).not.toHaveBeenCalledWith(
        expect.stringContaining("SET run_after=GREATEST(run_after, $1), last_error=COALESCE"),
        expect.arrayContaining([expect.any(Number), "github rate-limit budget deferred", "pending-other"]),
      );
      expect(fn).not.toHaveBeenCalledWith(
        expect.stringContaining("SET run_after=GREATEST(run_after, $1), last_error=COALESCE"),
        expect.arrayContaining([expect.any(Number), "github rate-limit budget deferred", "pending-local"]),
      );
      expect(fn).not.toHaveBeenCalledWith(
        expect.stringContaining("SET run_after=GREATEST(run_after, $1), last_error=COALESCE"),
        expect.arrayContaining([expect.any(Number), "github rate-limit budget deferred", "pending-malformed"]),
      );
      expect(fn).toHaveBeenCalledWith(
        expect.stringContaining("SET run_after=GREATEST(run_after, $1), last_error=$2"),
        expect.arrayContaining([expect.any(Number), "API rate limit exceeded for installation ID 123", "existing"]),
      );
      expect(fn).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM _selfhost_jobs WHERE id=$1"),
        ["active"],
      );
      expect(fn).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO _selfhost_jobs (payload"),
        expect.arrayContaining([expect.stringContaining('"deliveryId":"after-rate-limit"'), expect.any(Number)]),
      );
      const metrics = await renderMetrics();
      expect(metrics).toContain('gittensory_jobs_rate_limit_budget_deferred_total{job_type="github-webhook",key_scope="installation",kind="webhook"} 1');
      expect(metrics).toContain('gittensory_jobs_rate_limited_by_type_total{job_type="github-webhook",key_scope="installation",kind="webhook"} 1');
    } finally {
      if (oldJitter === undefined) delete process.env.QUEUE_STARTUP_JITTER_MS;
      else process.env.QUEUE_STARTUP_JITTER_MS = oldJitter;
    }
  });

  it("keeps claiming unrelated work after a keyed GitHub rate limit", async () => {
    const m = makePool();
    m.enqueueJob("1", installedWebhook("blocked-installation", 123), 0);
    m.enqueueJob("2", installedWebhook("other-installation", 456), 0);
    m.enqueueJob("3", msg("local-cleanup"), 0);
    const seen: string[] = [];
    const rateLimit = new Error("API rate limit exceeded for installation ID 123");
    Object.assign(rateLimit, {
      status: 403,
      response: { headers: { "retry-after": "120" } },
    });
    const q = createPgQueue(
      m.pool,
      async (message) => {
        seen.push(message.type === "github-webhook" ? message.deliveryId ?? "" : message.type);
        if (message.type === "github-webhook" && message.deliveryId === "blocked-installation") {
          throw rateLimit;
        }
      },
      { maxRetries: 1, backoffMs: () => 0 },
    );
    await q.init();
    await q.drain();
    expect(seen).toEqual(["blocked-installation", "other-installation", "local-cleanup"]);
    expect(m.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("SELECT id, payload, job_key FROM _selfhost_jobs WHERE status='pending' AND run_after<=$1"),
      expect.arrayContaining([expect.any(Number)]),
    );
    expect(m.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM _selfhost_jobs WHERE id=$1"),
      ["2"],
    );
    expect(m.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM _selfhost_jobs WHERE id=$1"),
      ["3"],
    );
  });

  it("reclaims expired processing leases before claiming more work", async () => {
    const oldTimeout = process.env.QUEUE_PROCESSING_TIMEOUT_MS;
    const oldRecoveryJitter = process.env.QUEUE_RECOVERY_JITTER_MS;
    process.env.QUEUE_PROCESSING_TIMEOUT_MS = "1";
    process.env.QUEUE_RECOVERY_JITTER_MS = "0";
    try {
      const m = makePool();
      const q = createPgQueue(m.pool, async () => undefined);
      await q.init();
      m.fn.mockResolvedValueOnce({
        rows: [{ id: "old", payload: JSON.stringify(msg("stuck")), job_key: "stuck-key" }],
        rowCount: 1,
      });
      m.fn.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await q.drain();

      expect(m.pool.query).toHaveBeenCalledWith(
        expect.stringContaining("WHERE status='processing' AND run_after<=$1"),
        expect.arrayContaining([expect.any(Number)]),
      );
      expect(m.pool.query).toHaveBeenCalledWith(
        expect.stringContaining("SET status='pending', run_after=$1"),
        expect.arrayContaining([expect.any(Number), "processing lease expired; requeued", "old"]),
      );
    } finally {
      if (oldTimeout === undefined) delete process.env.QUEUE_PROCESSING_TIMEOUT_MS;
      else process.env.QUEUE_PROCESSING_TIMEOUT_MS = oldTimeout;
      if (oldRecoveryJitter === undefined) delete process.env.QUEUE_RECOVERY_JITTER_MS;
      else process.env.QUEUE_RECOVERY_JITTER_MS = oldRecoveryJitter;
    }
  });

  it("pump absorbs a claimNext() pool failure instead of crashing the process (regression for #2498)", async () => {
    const fn = vi.fn().mockImplementation(async (sql: unknown) => {
      if (String(sql).includes("RETURNING id, payload, attempts, job_key, priority")) throw new Error("connection terminated unexpectedly");
      return { rows: [], rowCount: 0 };
    });
    const pool = { query: fn } as unknown as Pool;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const q = createPgQueue(pool, async () => undefined);
    await q.init();

    await expect(q.drain()).resolves.toBeUndefined();

    const logged = errorSpy.mock.calls.map(([line]) => String(line));
    expect(logged.some((line) => line.includes("selfhost_queue_pump_crashed") && line.includes("connection terminated unexpectedly"))).toBe(true);
  });

  it("pump absorbs a reclaimExpiredProcessingJobs() pool failure instead of crashing the process (regression for #2498)", async () => {
    const oldTimeout = process.env.QUEUE_PROCESSING_TIMEOUT_MS;
    process.env.QUEUE_PROCESSING_TIMEOUT_MS = "1";
    try {
      const fn = vi.fn().mockImplementation(async (sql: unknown) => {
        if (String(sql).includes("WHERE status='processing' AND run_after<=$1")) throw new Error("connection terminated unexpectedly");
        return { rows: [], rowCount: 0 };
      });
      const pool = { query: fn } as unknown as Pool;
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const q = createPgQueue(pool, async () => undefined);
      await q.init();

      await expect(q.drain()).resolves.toBeUndefined();

      const logged = errorSpy.mock.calls.map(([line]) => String(line));
      expect(logged.some((line) => line.includes("selfhost_queue_pump_crashed") && line.includes("connection terminated unexpectedly"))).toBe(true);
    } finally {
      if (oldTimeout === undefined) delete process.env.QUEUE_PROCESSING_TIMEOUT_MS;
      else process.env.QUEUE_PROCESSING_TIMEOUT_MS = oldTimeout;
    }
  });

  it("reschedules retryable incomplete review jobs while consuming attempts", async () => {
    const m = makePool();
    m.enqueueJob("1", { type: "agent-regate-pr" }, 0);
    const retryable = new RetryableJobError("AI review did not produce a public summary yet", {
      retryAfterMs: 5_000,
      retryKind: "ai_review_public_summary_missing",
    });
    const q = createPgQueue(
      m.pool,
      async () => {
        throw retryable;
      },
      { maxRetries: 2, backoffMs: () => 0 },
    );
    await q.init();
    await q.drain();
    expect(m.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("SET status='pending', attempts=$1, run_after=$2"),
      expect.arrayContaining([1, expect.any(Number), "AI review did not produce a public summary yet", "1"]),
    );
    expect(m.pool.query).not.toHaveBeenCalledWith(
      expect.stringContaining("status='dead'"),
      expect.anything(),
    );
  });

  it("dead-letters retryable incomplete review jobs when bounded attempts are exhausted", async () => {
    const m = makePool();
    m.enqueueJob("1", { type: "agent-regate-pr" }, 0);
    const retryable = new RetryableJobError("AI review did not produce a public summary yet", {
      retryAfterMs: 5_000,
      retryKind: "ai_review_public_summary_missing",
    });
    const q = createPgQueue(
      m.pool,
      async () => {
        throw retryable;
      },
      { maxRetries: 1, backoffMs: () => 0 },
    );
    await q.init();
    await q.drain();
    expect(m.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("status='dead'"),
      expect.arrayContaining([1, "AI review did not produce a public summary yet", "1"]),
    );
  });

  it("records 'unknown error' when consumer throws a non-Error", async () => {
    const m = makePool();
    m.enqueueJob("1", { type: "t" }, 0);
    const q = createPgQueue(m.pool, async () => { throw "plain-string"; }, { maxRetries: 1, backoffMs: () => 0 });
    await q.init();
    await q.drain();
    expect(m.pool.query).toHaveBeenCalledWith(expect.stringContaining("status='dead'"), expect.arrayContaining(["unknown error"]));
  });

  it("pump() returns early when active >= concurrency (saturation guard)", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const m = makePool();
    m.enqueueJob("1", { type: "a" });
    m.enqueueJob("2", { type: "b" });
    const q = createPgQueue(m.pool, async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 15));
      concurrent--;
    }, { concurrency: 1, pollIntervalMs: 100_000 });
    await q.init();
    await q.binding.send(msg("a"));
    await q.binding.send(msg("b")); // second void pump() hits active >= 1 → returns early
    await new Promise((r) => setTimeout(r, 60));
    await q.stop();
    expect(maxConcurrent).toBe(1);
  });

  it("concurrency=2 allows two jobs to run simultaneously", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const m = makePool();
    m.enqueueJob("1", { type: "a" });
    m.enqueueJob("2", { type: "b" });
    const q = createPgQueue(m.pool, async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 15));
      concurrent--;
    }, { concurrency: 2, pollIntervalMs: 100_000 });
    await q.init();
    await q.binding.send(msg("a"));
    await q.binding.send(msg("b"));
    await new Promise((r) => setTimeout(r, 60));
    await q.stop();
    expect(maxConcurrent).toBe(2);
  });

  it("start() and stop() run the poll loop", async () => {
    const m = makePool();
    m.enqueueJob("1", { type: "ticked" });
    const seen: string[] = [];
    const q = createPgQueue(m.pool, async (j) => void seen.push(typeOf(j)), { pollIntervalMs: 10 });
    await q.init();
    q.start();
    for (let i = 0; i < 50 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await q.stop();
    expect(seen).toEqual(["ticked"]);
  });

  it("start() fills available workers for an existing due backlog", async () => {
    const m = makePool();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let concurrent = 0;
    let maxConcurrent = 0;
    const q = createPgQueue(
      m.pool,
      async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await gate;
        concurrent--;
      },
      { concurrency: 3, pollIntervalMs: 100_000 },
    );
    await q.init();
    m.enqueueJob("1", { type: "a" });
    m.enqueueJob("2", { type: "b" });
    m.enqueueJob("3", { type: "c" });
    try {
      q.start();
      for (let i = 0; i < 20 && maxConcurrent < 3; i += 1)
        await new Promise((r) => setTimeout(r, 10));
      expect(maxConcurrent).toBe(3);
    } finally {
      release();
      await q.stop();
    }
  });

  it("start() is idempotent", async () => {
    const { pool } = makePool();
    const q = createPgQueue(pool, async () => undefined, { pollIntervalMs: 100_000 });
    await q.init();
    q.start();
    q.start(); // second call is a no-op
    await q.stop();
  });

  it("stop() is a no-op when timer is null", async () => {
    const { pool } = makePool();
    const q = createPgQueue(pool, async () => undefined);
    await q.init();
    await q.stop(); // timer=null → false branch of `if (timer) clearTimeout(timer)`
  });

  it("binding.sendBatch enqueues multiple messages", async () => {
    const m = makePool();
    m.enqueueJob("1", { type: "x" });
    m.enqueueJob("2", { type: "y" });
    const seen: string[] = [];
    const q = createPgQueue(m.pool, async (j) => void seen.push(typeOf(j)));
    await q.init();
    await q.binding.sendBatch([{ body: msg("x") }, { body: msg("y") }]);
    await q.drain();
    expect(seen.sort()).toEqual(["x", "y"]);
  });

  it("uses default backoff lambda when backoffMs is not provided", async () => {
    // Trigger a retry without providing backoffMs so the default (attempt) => Math.min(60_000, 1000 * 2**attempt)
    // is actually called — covering the function body that would otherwise be created but never invoked.
    const m = makePool();
    m.enqueueJob("1", { type: "t" }, 0);
    const q = createPgQueue(m.pool, async () => { throw new Error("transient"); }, { maxRetries: 5 });
    // No backoffMs → default lambda is used + called when scheduling the retry
    await q.init();
    await q.drain();
    expect(m.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("status='pending'"),
      expect.arrayContaining([1]),
    );
  });

  it("size() and deadCount() return numeric counts", async () => {
    const { pool } = makePool();
    // makePool returns { c: "3" } for COUNT queries
    const q = createPgQueue(pool, async () => undefined);
    await q.init();
    expect(await q.size()).toBe(3);
    expect(await q.deadCount()).toBe(3);
  });

  it("stats() returns persisted queue metric counts", async () => {
    const m = makePool();
    const q = createPgQueue(m.pool, async () => undefined);
    await q.init();
    m.fn.mockResolvedValueOnce({
      rows: [
        { name: "gittensory_jobs_processed_total", value: "42" },
        { name: "gittensory_jobs_dead_total", value: null },
      ],
      rowCount: 2,
    });
    await expect(q.stats()).resolves.toEqual({
      gittensory_jobs_processed_total: 42,
      gittensory_jobs_dead_total: 0,
    });
  });

  it("snapshot() reports pending/processing/dead queue depth by job type", async () => {
    const m = makePool();
    const q = createPgQueue(m.pool, async () => undefined);
    await q.init();
    const now = Date.now();
    m.fn.mockResolvedValueOnce({
      rows: [
        { payload: JSON.stringify(msg("agent-regate-pr")), status: "pending", run_after: String(now - 1) },
        { payload: JSON.stringify(msg("agent-regate-pr")), status: "processing", run_after: String(now - 1) },
        { payload: JSON.stringify(msg("github-webhook")), status: "pending", run_after: String(now + 60_000) },
        { payload: JSON.stringify(msg("rag-index-repo")), status: "dead", run_after: String(now - 1) },
      ],
      rowCount: 4,
    });
    m.fn.mockResolvedValueOnce({
      rows: [
        { payload: JSON.stringify(msg("agent-regate-pr")), status: "pending", run_after: String(now - 1) },
        { payload: JSON.stringify(msg("agent-regate-pr")), status: "processing", run_after: String(now - 1) },
        { payload: JSON.stringify(msg("github-webhook")), status: "pending", run_after: String(now + 60_000) },
        { payload: JSON.stringify(msg("rag-index-repo")), status: "dead", run_after: String(now - 1) },
      ],
      rowCount: 4,
    });

    const snapshot = await q.snapshot();
    const bindingSnapshot = await queueSnapshotFromBinding(q.binding);

    expect(snapshot.totals).toMatchObject({ pending: 2, processing: 1, dead: 1 });
    expect(snapshot.byType).toEqual(
      expect.arrayContaining([
        { type: "agent-regate-pr", status: "pending", count: 1, due: 1 },
        { type: "agent-regate-pr", status: "processing", count: 1, due: 0 },
        { type: "github-webhook", status: "pending", count: 1, due: 0 },
        { type: "rag-index-repo", status: "dead", count: 1, due: 0 },
      ]),
    );
    expect(bindingSnapshot).toEqual(snapshot);
  });

  describe("maintenance-admission pressure gating (#selfhost-runtime-pressure)", () => {
    const now = Date.now();
    const maintenanceRow = { id: "m1", payload: JSON.stringify(msg("build-contributor-evidence")), attempts: 0, job_key: "build-contributor-evidence:all", priority: 0, created_at: now };

    it("defers a maintenance job when live queue pressure is high", async () => {
      const m = makePool();
      m.setPressureSignals({ live: { cnt: 6, oldest: now } }); // default threshold is 5
      m.enqueueResult({ rows: [], rowCount: 0 }); // empty foreground claim
      m.enqueueResult({ rows: [maintenanceRow], rowCount: 1 }); // background claim
      const started: string[] = [];
      const q = createPgQueue(m.pool, async (j) => void started.push(typeOf(j)));
      await q.drain();

      expect(started).not.toContain("build-contributor-evidence");
      expect(m.pool.query).toHaveBeenCalledWith(
        expect.stringContaining("SET status='pending', run_after=GREATEST"),
        expect.arrayContaining([expect.stringContaining("live_pending_high")]),
      );
      expect(await renderMetrics()).toContain(
        'gittensory_jobs_maintenance_admission_deferred_by_reason_total{job_type="build-contributor-evidence",reason="live_pending_high"} 1',
      );
    });

    it("logs a deferred maintenance admission at info level, not warn (#selfhost-backpressure-noise)", async () => {
      const m = makePool();
      m.setPressureSignals({ live: { cnt: 6, oldest: now } }); // default threshold is 5
      m.enqueueResult({ rows: [], rowCount: 0 }); // empty foreground claim
      m.enqueueResult({ rows: [maintenanceRow], rowCount: 1 }); // background claim
      const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const q = createPgQueue(m.pool, async () => undefined);
      await q.drain();

      expect(warned).not.toHaveBeenCalled();
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining('"event":"selfhost_queue_maintenance_admission_deferred"'),
      );
      expect(JSON.parse(logged.mock.calls.at(-1)?.[0] as string)).toMatchObject({
        level: "info",
        event: "selfhost_queue_maintenance_admission_deferred",
        reason: "live_pending_high",
      });
    });

    it("admits a maintenance job immediately when pressure is clear", async () => {
      const m = makePool();
      m.enqueueResult({ rows: [], rowCount: 0 }); // empty foreground claim
      m.enqueueResult({ rows: [maintenanceRow], rowCount: 1 }); // background claim
      const started: string[] = [];
      const q = createPgQueue(m.pool, async (j) => void started.push(typeOf(j)));
      await q.drain();
      expect(started).toEqual(["build-contributor-evidence"]);
    });

    it("never defers a foreground job even under maintenance-triggering pressure", async () => {
      const m = makePool();
      m.setPressureSignals({ live: { cnt: 6, oldest: now } });
      m.enqueueResult({
        rows: [{ id: "w1", payload: JSON.stringify(msg("github-webhook")), attempts: 0, job_key: null, priority: 10, created_at: now }],
        rowCount: 1,
      });
      const started: string[] = [];
      const q = createPgQueue(m.pool, async (j) => void started.push(typeOf(j)));
      await q.drain();
      expect(started).toEqual(["github-webhook"]);
    });

    it("defers a maintenance job when the maintenance lane itself is backed up", async () => {
      const m = makePool();
      m.setPressureSignals({ maintenance: { cnt: 16, oldest: now } }); // default threshold is 15
      m.enqueueResult({ rows: [], rowCount: 0 });
      m.enqueueResult({ rows: [maintenanceRow], rowCount: 1 });
      const started: string[] = [];
      const q = createPgQueue(m.pool, async (j) => void started.push(typeOf(j)));
      await q.drain();
      expect(started).not.toContain("build-contributor-evidence");
    });

    it("defers a maintenance job when the backlog-convergence lane is high (#selfhost-backlog-convergence)", async () => {
      const m = makePool();
      m.setPressureSignals({ backlogConvergence: { cnt: 11 } }); // default threshold is 10
      m.enqueueResult({ rows: [], rowCount: 0 });
      m.enqueueResult({ rows: [maintenanceRow], rowCount: 1 });
      const started: string[] = [];
      const q = createPgQueue(m.pool, async (j) => void started.push(typeOf(j)));
      await q.drain();
      expect(started).not.toContain("build-contributor-evidence");
      expect(await renderMetrics()).toContain(
        'gittensory_jobs_maintenance_admission_deferred_by_reason_total{job_type="build-contributor-evidence",reason="backlog_convergence_high"} 1',
      );
    });

    it("never defers a foreground job even under backlog-convergence-triggering pressure", async () => {
      const m = makePool();
      m.setPressureSignals({ backlogConvergence: { cnt: 11 } });
      m.enqueueResult({
        rows: [{ id: "w1", payload: JSON.stringify(msg("github-webhook")), attempts: 0, job_key: null, priority: 10, created_at: now }],
        rowCount: 1,
      });
      const started: string[] = [];
      const q = createPgQueue(m.pool, async (j) => void started.push(typeOf(j)));
      await q.drain();
      expect(started).toEqual(["github-webhook"]);
    });

    // Regression (#selfhost-maintenance-self-pin): mirrors selfhost-sqlite-queue.test.ts exactly -- a large
    // backlog (well over threshold) no longer denies EVERY job forever; a job old enough for the drain age gets
    // admitted while a fresh job in the SAME backlog still defers.
    it("drain-admits an old job in a large backlog once it has waited past the drain age, while a fresh job in the SAME backlog still defers", async () => {
      const oldEnv = process.env.MAINTENANCE_ADMISSION_DRAIN_AGE_MS;
      process.env.MAINTENANCE_ADMISSION_DRAIN_AGE_MS = "60000"; // 1m (parsePositiveIntEnv floor)
      try {
        const m = makePool();
        m.setPressureSignals({ maintenance: { cnt: 68, oldest: now } }); // mirrors the reported incident's backlog size
        m.enqueueResult({ rows: [], rowCount: 0 }); // empty foreground claim
        m.enqueueResult({ rows: [{ ...maintenanceRow, created_at: now - 61_000 }], rowCount: 1 }); // old job: drained
        const started: string[] = [];
        const q = createPgQueue(m.pool, async (j) => void started.push(typeOf(j)));
        await q.drain();
        expect(started).toEqual(["build-contributor-evidence"]);
        expect(await renderMetrics()).toContain(
          'gittensory_jobs_maintenance_admission_granted_under_pressure_total{job_type="build-contributor-evidence",reason="maintenance_pending_high_drain"} 1',
        );
      } finally {
        if (oldEnv === undefined) delete process.env.MAINTENANCE_ADMISSION_DRAIN_AGE_MS;
        else process.env.MAINTENANCE_ADMISSION_DRAIN_AGE_MS = oldEnv;
      }
    });

    it("does not drain-admit when host load is ALSO high", async () => {
      const oldEnv = process.env.MAINTENANCE_ADMISSION_DRAIN_AGE_MS;
      process.env.MAINTENANCE_ADMISSION_DRAIN_AGE_MS = "60000";
      vi.mocked(hostLoadAvg1PerCore).mockReturnValue(5);
      try {
        const m = makePool();
        m.setPressureSignals({ maintenance: { cnt: 68, oldest: now } });
        m.enqueueResult({ rows: [], rowCount: 0 });
        m.enqueueResult({ rows: [{ ...maintenanceRow, created_at: now - 61_000 }], rowCount: 1 });
        const started: string[] = [];
        const q = createPgQueue(m.pool, async (j) => void started.push(typeOf(j)));
        await q.drain();
        expect(started).not.toContain("build-contributor-evidence");
        expect(m.pool.query).toHaveBeenCalledWith(
          expect.stringContaining("SET status='pending', run_after=GREATEST"),
          expect.arrayContaining([expect.stringContaining("host_load_high")]),
        );
      } finally {
        if (oldEnv === undefined) delete process.env.MAINTENANCE_ADMISSION_DRAIN_AGE_MS;
        else process.env.MAINTENANCE_ADMISSION_DRAIN_AGE_MS = oldEnv;
      }
    });

    it("defers a maintenance job when host load per core is high", async () => {
      vi.mocked(hostLoadAvg1PerCore).mockReturnValue(5);
      const m = makePool();
      m.enqueueResult({ rows: [], rowCount: 0 });
      m.enqueueResult({ rows: [maintenanceRow], rowCount: 1 });
      const started: string[] = [];
      const q = createPgQueue(m.pool, async (j) => void started.push(typeOf(j)));
      await q.drain();
      expect(started).not.toContain("build-contributor-evidence");
    });

    it("force-admits via trickle once a maintenance job has waited past the max defer age", async () => {
      const oldEnv = process.env.MAINTENANCE_ADMISSION_MAX_DEFER_AGE_MS;
      process.env.MAINTENANCE_ADMISSION_MAX_DEFER_AGE_MS = "60000"; // 1m (parsePositiveIntEnv floor)
      try {
        const m = makePool();
        m.setPressureSignals({ live: { cnt: 6, oldest: now } });
        m.enqueueResult({ rows: [], rowCount: 0 });
        m.enqueueResult({
          rows: [{ ...maintenanceRow, created_at: now - 61_000 }],
          rowCount: 1,
        });
        const started: string[] = [];
        const q = createPgQueue(m.pool, async (j) => void started.push(typeOf(j)));
        await q.drain();
        expect(started).toEqual(["build-contributor-evidence"]);
        const metrics = await renderMetrics();
        expect(metrics).toContain('gittensory_jobs_maintenance_trickle_admitted_by_type_total{job_type="build-contributor-evidence"} 1');
        expect(metrics).toContain('gittensory_jobs_maintenance_admission_granted_under_pressure_total{job_type="build-contributor-evidence",reason="trickle_max_defer_age"} 1');
      } finally {
        if (oldEnv === undefined) delete process.env.MAINTENANCE_ADMISSION_MAX_DEFER_AGE_MS;
        else process.env.MAINTENANCE_ADMISSION_MAX_DEFER_AGE_MS = oldEnv;
      }
    });

    it("does not record the granted-under-pressure metric for an ordinary pressure_clear admission", async () => {
      const m = makePool();
      m.enqueueResult({ rows: [], rowCount: 0 });
      m.enqueueResult({ rows: [maintenanceRow], rowCount: 1 });
      const started: string[] = [];
      const q = createPgQueue(m.pool, async (j) => void started.push(typeOf(j)));
      await q.drain();
      expect(started).toEqual(["build-contributor-evidence"]);
      expect(await renderMetrics()).not.toContain("gittensory_jobs_maintenance_admission_granted_under_pressure_total");
    });

    it("pressureSignals() surfaces the live, maintenance, backlog-convergence, and fresh-intake aggregate reads", async () => {
      const m = makePool();
      m.setPressureSignals({
        live: { cnt: 2, oldest: now - 1_000 },
        maintenance: { cnt: 4, oldest: now - 2_000 },
        backlogConvergence: { cnt: 3 },
        freshIntake: { cnt: 5 },
      });
      const q = createPgQueue(m.pool, async () => undefined);
      const signals = await q.pressureSignals();
      expect(signals).toEqual({
        livePendingCount: 2,
        oldestLivePendingAgeMs: expect.any(Number),
        liveRunnableNowCount: 0,
        oldestLiveRunnableAgeMs: null,
        maintenancePendingCount: 4,
        oldestMaintenancePendingAgeMs: expect.any(Number),
        backlogConvergencePendingCount: 3,
        freshIntakePendingCount: 5,
        hostLoadAvg1PerCore: null,
      });
    });

    // #selfhost-queue-liveness: liveRunnableNowCount/oldestLiveRunnableAgeMs must reflect only the SUBSET of
    // live pending jobs that are currently DUE (run_after<=now) -- distinct from livePendingCount/
    // oldestLivePendingAgeMs, which are dominated by whatever row is OLDEST by created_at regardless of
    // whether it is runnable right now. A stale/deferred oldest row must not mask a younger due row.
    it("pressureSignals() reports the runnable-now subset distinctly from the overall oldest-pending age", async () => {
      const m = makePool();
      m.setPressureSignals({
        live: { cnt: 3, oldest: now - 500_000, runnableCnt: 1, oldestRunnable: now - 10_000 },
      });
      const q = createPgQueue(m.pool, async () => undefined);
      const signals = await q.pressureSignals();
      expect(signals.livePendingCount).toBe(3);
      expect(signals.oldestLivePendingAgeMs).toBeGreaterThanOrEqual(500_000);
      expect(signals.liveRunnableNowCount).toBe(1);
      expect(signals.oldestLiveRunnableAgeMs).toBeGreaterThanOrEqual(10_000);
      expect(signals.oldestLiveRunnableAgeMs).toBeLessThan(signals.oldestLivePendingAgeMs as number);
    });

    it("pressureSignals() reports zero runnable-now and a null oldest-runnable age when every live row is deferred to the future", async () => {
      const m = makePool();
      m.setPressureSignals({ live: { cnt: 5, oldest: now - 100_000, runnableCnt: 0, oldestRunnable: null } });
      const q = createPgQueue(m.pool, async () => undefined);
      const signals = await q.pressureSignals();
      expect(signals.liveRunnableNowCount).toBe(0);
      expect(signals.oldestLiveRunnableAgeMs).toBeNull();
    });
  });

  describe("installation-concurrency admission (#selfhost-installation-concurrency)", () => {
    const oldLimit = process.env.GITHUB_INSTALLATION_CONCURRENCY_LIMIT;

    afterEach(() => {
      if (oldLimit === undefined) delete process.env.GITHUB_INSTALLATION_CONCURRENCY_LIMIT;
      else process.env.GITHUB_INSTALLATION_CONCURRENCY_LIMIT = oldLimit;
    });

    // backfill-repo-segment is used as the background fixture throughout these general-behavior cases;
    // agent-regate-sweep gets its own dedicated regression test below (#selfhost-installation-concurrency-sweep-gap)
    // because its row priority (8, PRIORITY_BY_TYPE) equals FOREGROUND_QUEUE_PRIORITY_FLOOR (also 8) -- a priority-
    // based exclusion guard would have silently exempted it, which is exactly the gap that test guards against.

    it("a second concurrent background job for the SAME installation is deferred at the limit", async () => {
      process.env.GITHUB_INSTALLATION_CONCURRENCY_LIMIT = "1";
      const m = makePool();
      m.enqueueJob("1", { type: "backfill-repo-segment", installationId: 42 }, 0, "backfill:42:a");
      // No job_key on the deferred row (a raw/legacy shape) -- exercises the `job.job_key ?? ""` jitter-seed
      // fallback's nullish arm.
      m.enqueueJob("2", { type: "backfill-repo-segment", installationId: 42 }, 0, null);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started = 0;
      const q = createPgQueue(
        m.pool,
        async () => {
          started++;
          await gate;
        },
        { concurrency: 2, backgroundConcurrency: 2, pollIntervalMs: 100_000 },
      );
      await q.init();
      try {
        q.start();
        for (let i = 0; i < 20 && started < 1; i += 1) await new Promise((r) => setTimeout(r, 10));
        // Give the second job's own pump loop a chance to claim and be evaluated too, while the first is still
        // gated open -- only ONE of the two should ever have reached consume() at this point.
        await new Promise((r) => setTimeout(r, 30));
        expect(started).toBe(1);
        expect(m.pool.query).toHaveBeenCalledWith(
          expect.stringContaining("SET status='pending', run_after=GREATEST"),
          expect.arrayContaining([expect.stringContaining("installation concurrency admission deferred: concurrency_high")]),
        );
        expect(await renderMetrics()).toContain(
          'gittensory_jobs_installation_concurrency_deferred_by_reason_total{job_type="backfill-repo-segment",reason="concurrency_high"} 1',
        );
      } finally {
        release();
        await q.stop();
      }
    });

    // Regression (#selfhost-installation-concurrency-sweep-gap): agent-regate-sweep's own row priority (8,
    // PRIORITY_BY_TYPE) equals FOREGROUND_QUEUE_PRIORITY_FLOOR (also 8), so a priority-based exclusion guard
    // (`isForegroundJobPriority(job.priority) ? null : ...`) would classify it as foreground and silently exempt
    // it from this policy entirely -- exactly the background sweep/backfill fan-out this limiter exists to bound.
    // installationConcurrencyKeyForJob must exclude ONLY agent-regate-pr by type, not by priority, so sweep jobs
    // are still admission-checked like every other GITHUB_BUDGET_BACKGROUND_TYPES member.
    it("a second concurrent agent-regate-sweep job for the SAME installation is deferred at the limit", async () => {
      process.env.GITHUB_INSTALLATION_CONCURRENCY_LIMIT = "1";
      const m = makePool();
      // enqueueJob's fabricated row carries no priority column, which defaults to falsy/NaN under
      // isForegroundJobPriority -- indistinguishable from a real background job either way, so it can't prove
      // this regression. Use the REAL sweep priority (8, PRIORITY_BY_TYPE) via enqueueResult directly: under the
      // old priority-based exclusion this collides with FOREGROUND_QUEUE_PRIORITY_FLOOR (also 8) and would wrongly
      // exempt the job, so only the type-based fix in installationConcurrencyKeyForJob makes this test pass.
      m.enqueueResult({
        rows: [{ id: "1", payload: JSON.stringify({ type: "agent-regate-sweep", installationId: 42 }), attempts: 0, job_key: "sweep:42:a", priority: 8 }],
        rowCount: 1,
      });
      m.enqueueResult({
        rows: [{ id: "2", payload: JSON.stringify({ type: "agent-regate-sweep", installationId: 42 }), attempts: 0, job_key: null, priority: 8 }],
        rowCount: 1,
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started = 0;
      const q = createPgQueue(
        m.pool,
        async () => {
          started++;
          await gate;
        },
        { concurrency: 2, backgroundConcurrency: 2, pollIntervalMs: 100_000 },
      );
      await q.init();
      try {
        q.start();
        for (let i = 0; i < 20 && started < 1; i += 1) await new Promise((r) => setTimeout(r, 10));
        await new Promise((r) => setTimeout(r, 30));
        expect(started).toBe(1);
        expect(m.pool.query).toHaveBeenCalledWith(
          expect.stringContaining("SET status='pending', run_after=GREATEST"),
          expect.arrayContaining([expect.stringContaining("installation concurrency admission deferred: concurrency_high")]),
        );
        expect(await renderMetrics()).toContain(
          'gittensory_jobs_installation_concurrency_deferred_by_reason_total{job_type="agent-regate-sweep",reason="concurrency_high"} 1',
        );
      } finally {
        release();
        await q.stop();
      }
    });

    it("a background job for a DIFFERENT installation is admitted concurrently with one already at its own limit", async () => {
      process.env.GITHUB_INSTALLATION_CONCURRENCY_LIMIT = "1";
      const m = makePool();
      m.enqueueJob("1", { type: "backfill-repo-segment", installationId: 42 }, 0, "backfill:42:a");
      m.enqueueJob("2", { type: "backfill-repo-segment", installationId: 99 }, 0, "backfill:99:a");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let concurrent = 0;
      let maxConcurrent = 0;
      const q = createPgQueue(
        m.pool,
        async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await gate;
          concurrent--;
        },
        { concurrency: 2, backgroundConcurrency: 2, pollIntervalMs: 100_000 },
      );
      await q.init();
      try {
        q.start();
        for (let i = 0; i < 20 && maxConcurrent < 2; i += 1) await new Promise((r) => setTimeout(r, 10));
        expect(maxConcurrent).toBe(2);
      } finally {
        release();
        await q.stop();
      }
    });

    it("never defers a foreground agent-regate-pr job regardless of installation in-flight count", async () => {
      process.env.GITHUB_INSTALLATION_CONCURRENCY_LIMIT = "1";
      const m = makePool();
      m.enqueueJob("1", { type: "backfill-repo-segment", installationId: 42 }, 0, "backfill:42:a");
      // A real agent-regate-pr claim row carries priority 9 (AGENT_REGATE_PRIORITY) -- enqueueJob's fixed shape
      // omits `priority` entirely, which would misrepresent this as background-priority (undefined/NaN reads as
      // NOT foreground), defeating the exact thing this test verifies. enqueueResult lets the row be explicit.
      m.enqueueResult({
        rows: [{ id: "2", payload: JSON.stringify(regateJob(42, 1630)), attempts: 0, job_key: "agent-regate-pr:jsonbored/gittensory#1630", priority: 9 }],
        rowCount: 1,
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const seen: string[] = [];
      const q = createPgQueue(
        m.pool,
        async (j) => {
          seen.push(typeOf(j));
          if (typeOf(j) === "backfill-repo-segment") await gate;
        },
        { concurrency: 2, backgroundConcurrency: 2, pollIntervalMs: 100_000 },
      );
      await q.init();
      try {
        q.start();
        for (let i = 0; i < 20 && seen.length < 2; i += 1) await new Promise((r) => setTimeout(r, 10));
        expect(seen).toContain("agent-regate-pr");
      } finally {
        release();
        await q.stop();
      }
    });

    it("the tracker decrements on completion, so a subsequent job for the same installation is admitted again", async () => {
      process.env.GITHUB_INSTALLATION_CONCURRENCY_LIMIT = "1";
      const m = makePool();
      m.enqueueJob("1", { type: "backfill-repo-segment", installationId: 42 }, 0, "backfill:42:a");
      const seen: string[] = [];
      const q = createPgQueue(m.pool, async (j) => void seen.push(typeOf(j)), { backgroundConcurrency: 1 });
      await q.init();
      await q.drain();
      expect(seen).toEqual(["backfill-repo-segment"]);

      m.enqueueJob("2", { type: "backfill-repo-segment", installationId: 42 }, 0, "backfill:42:b");
      await q.drain();
      expect(seen).toEqual(["backfill-repo-segment", "backfill-repo-segment"]);
    });
  });
});
