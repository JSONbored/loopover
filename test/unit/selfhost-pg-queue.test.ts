// Unit tests for the Postgres-backed job queue (#977). Mocks pg.Pool so no real DB is needed.
// Real-Postgres integration paths (migrations, pg-adapter translation) live in test/integration/selfhost-pg.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, QueryResult } from "pg";
import { createPgQueue } from "../../src/selfhost/pg-queue";
import { queueSnapshotFromBinding } from "../../src/selfhost/queue-common";
import { renderMetrics, resetMetrics } from "../../src/selfhost/metrics";
import { RetryableJobError } from "../../src/queue/retryable";
import type { JobMessage } from "../../src/types";

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
  setRateLimitRows(rows: Array<{ admission_key?: string | null; repo_full_name?: string | null; remaining: number | string | null; reset_at: string | null; observed_at?: string | null }>): void;
}

function makePool(): MockPool {
  const results: Partial<QueryResult>[] = [];
  let deferUpdateRowCount = 1;
  let rateLimitRows: Array<{ admission_key?: string | null; repo_full_name?: string | null; remaining: number | string | null; reset_at: string | null; observed_at?: string | null }> = [];
  const fn = vi.fn().mockImplementation(async (sql: unknown, params?: unknown[]) => {
    const q = String(sql);
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
    setRateLimitRows(rows) {
      rateLimitRows = rows;
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
      expect.arrayContaining([expect.stringContaining('"deliveryId":"ci-2"'), expect.any(Number), expect.any(Number), 10, "existing"]),
    );
    expect(m.pool.query).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO _selfhost_jobs (payload"),
      expect.arrayContaining([expect.stringContaining('"deliveryId":"ci-2"')]),
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
    });
    const q = createPgQueue(m.pool, async () => undefined);

    await q.init();
    await q.drain();

    const audit = writes.find((line) => line.includes('"event":"job_complete"'));
    expect(JSON.parse(audit!) as Record<string, unknown>).toMatchObject({
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
        deliveryId: "sweep:owner/repo#7",
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

  it("pre-yields GitHub-budget background jobs without repo fields from global REST observations", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const oldJitter = process.env.QUEUE_RATE_LIMIT_JITTER_MS;
    process.env.QUEUE_RATE_LIMIT_JITTER_MS = "0";
    try {
      const m = makePool();
      m.setRateLimitRows([{ admission_key: null, repo_full_name: "owner/repo", remaining: "120", reset_at: "2026-06-24T12:10:00.000Z", observed_at: "2026-06-24T12:00:00.000Z" }]);
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

  it("pre-yields from legacy repo exhaustion before older healthy exact observations", async () => {
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

  it("does not keep webhook admission closed from stale exact rows after a newer healthy legacy observation", async () => {
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
    // UPDATE dead + then no more rows → pump exits cleanly.
    expect(m.pool.query).toHaveBeenCalledWith(expect.stringContaining("status='dead'"), expect.arrayContaining(["1"]));
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
      [2, "openai api rate limit exceeded", "1"],
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
      expect(fn).toHaveBeenCalledWith(
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
});
