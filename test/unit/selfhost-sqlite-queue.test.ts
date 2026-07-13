import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nodeSqliteDriver } from "../../src/selfhost/d1-adapter";
import { createSqliteQueue } from "../../src/selfhost/sqlite-queue";
import { jobCoalesceKey, queueSnapshotFromBinding } from "../../src/selfhost/queue-common";
import { renderMetrics, resetMetrics } from "../../src/selfhost/metrics";
import { RetryableJobError } from "../../src/queue/retryable";
import { hostLoadAvg1PerCore } from "../../src/selfhost/host-pressure";
import * as sentryModule from "../../src/selfhost/sentry";
import type { JobMessage } from "../../src/types";

// Real host CPU load is nondeterministic (and can legitimately spike on a busy CI runner), so every
// maintenance-admission test in this file would be flaky against the real node:os signal. Default to
// "unavailable" (null, never gates) here; individual host-load tests override the mock explicitly.
vi.mock("../../src/selfhost/host-pressure", () => ({ hostLoadAvg1PerCore: vi.fn(() => null) }));

function makeDriver(): ReturnType<typeof nodeSqliteDriver> {
  return nodeSqliteDriver(new DatabaseSync(":memory:") as never);
}
const msg = (t: string): JobMessage => ({ type: t }) as unknown as JobMessage;
const webhook = (sender: { login: string; type: string }, eventName = "issue_comment", action = "edited"): JobMessage =>
  ({
    type: "github-webhook",
    deliveryId: "webhook-delivery",
    eventName,
    payload: { action, sender },
  }) as unknown as JobMessage;
const prWebhook = (deliveryId: string, action = "synchronize", sha = "a".repeat(40)): JobMessage =>
  ({
    type: "github-webhook",
    deliveryId,
    eventName: "pull_request",
    payload: {
      action,
      repository: { full_name: "JSONbored/gittensory" },
      pull_request: { number: 1629, head: { sha } },
    },
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

describe("createSqliteQueue (durable #980)", () => {
  // Suppress audit log stdout noise.
  beforeEach(() => { vi.spyOn(process.stdout, "write").mockImplementation(() => true); });
  afterEach(() => {
    vi.useRealTimers();
    resetMetrics();
    vi.restoreAllMocks();
    vi.mocked(hostLoadAvg1PerCore).mockReturnValue(null);
  });

  it("persists + drains FIFO through the consumer", async () => {
    const driver = makeDriver();
    const seen: string[] = [];
    const q = createSqliteQueue(driver, async (m) => void seen.push(typeOf(m)));
    await q.binding.send(msg("a"));
    await q.binding.send(msg("b"));
    await q.drain();
    expect(seen).toEqual(["a", "b"]);
    expect(await q.size()).toBe(0);
  });

  it("REGRESSION: releases the reserved background slot when a background claim query throws (#selfhost-bg-slot-leak)", async () => {
    // A raw driver failure during the BACKGROUND claim (a transient SQLite "database is locked" / I/O error) throws
    // out of claimNext(), which runs OUTSIDE processOne's try/finally, so its reserved slot must be rolled back.
    // Without the rollback the slot leaks; since backgroundConcurrency defaults to 1, a single such error would
    // starve the entire background/maintenance lane until a restart. Assert the lane still drains a background job
    // after one throwing claim.
    let failNextBackgroundClaim = true;
    const base = makeDriver();
    const driver = {
      exec: base.exec.bind(base),
      query: vi.fn((sql: string, params: unknown[]) => {
        if (failNextBackgroundClaim && sql.includes("status='pending'") && sql.includes("priority<?")) {
          failNextBackgroundClaim = false;
          throw new Error("database is locked");
        }
        return base.query(sql, params);
      }),
    } as ReturnType<typeof nodeSqliteDriver>;
    const seen: string[] = [];
    const q = createSqliteQueue(driver, async (m) => void seen.push(typeOf(m)));
    // Seed a background job (priority 0 < 8) directly, avoiding send()'s fire-and-forget pump so the drain timing
    // is deterministic.
    driver.query(
      "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority) VALUES (?, 'pending', 0, 0, 0, 0)",
      [JSON.stringify(msg("bg-probe"))],
    );

    await q.drain(); // background claim throws once; pump() catches it, the job stays pending
    expect(seen).toEqual([]);

    await q.drain(); // the reserved slot was released, so the recovered lane now drains the background job
    expect(seen).toEqual(["bg-probe"]);
  });

  it("copies carried webhook trace ids into job audit logs", async () => {
    const driver = makeDriver();
    const writes: string[] = [];
    vi.mocked(process.stdout.write).mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const q = createSqliteQueue(driver, async () => undefined);
    const traced = prWebhook("trace-a");
    if (traced.type === "github-webhook") traced.traceParent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
    await q.binding.send(traced);

    await q.drain();

    const audit = writes.find((line) => line.includes('"event":"job_complete"'));
    expect(JSON.parse(audit!) as Record<string, unknown>).toMatchObject({
      repo: "JSONbored/gittensory",
      pr_number: 1629,
      trace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
  });

  it("tags webhook and PR review refresh jobs with elevated priorities (#review-latency)", async () => {
    const driver = makeDriver();
    const q = createSqliteQueue(driver, async () => undefined);
    // delaySeconds keeps them pending (not claimed) so we can read the stored priority.
    await q.binding.send(msg("github-webhook"), { delaySeconds: 60 });
    await q.binding.send(msg("agent-regate-pr"), { delaySeconds: 60 });
    await q.binding.send(msg("recapture-preview"), { delaySeconds: 60 });
    await q.binding.send(msg("agent-regate-sweep"), { delaySeconds: 60 });
    await q.binding.send(webhook({ login: "gittensory-orb[bot]", type: "Bot" }), { delaySeconds: 60 });
    await q.binding.send(webhook({ login: "maintainer", type: "User" }), { delaySeconds: 60 });
    await q.binding.send(msg("rag-index-repo"), { delaySeconds: 60 });
    await q.binding.send({} as unknown as JobMessage, { delaySeconds: 60 }); // no type → priority 0 fallback
    const { rows } = driver.query(
      "SELECT payload, priority FROM _selfhost_jobs",
      [],
    );
    const prio = (p: string): number | undefined =>
      (rows as Array<{ payload: string; priority: number }>).find(
        (r) => r.payload === p,
      )?.priority;
    expect(prio(JSON.stringify(msg("github-webhook")))).toBe(10);
    expect(prio(JSON.stringify(msg("agent-regate-pr")))).toBe(9);
    expect(prio(JSON.stringify(msg("recapture-preview")))).toBe(9);
    expect(prio(JSON.stringify(msg("agent-regate-sweep")))).toBe(8);
    expect(prio(JSON.stringify(webhook({ login: "maintainer", type: "User" })))).toBe(10);
    expect(prio(JSON.stringify(webhook({ login: "gittensory-orb[bot]", type: "Bot" })))).toBe(0);
    expect(prio(JSON.stringify(msg("rag-index-repo")))).toBe(0);
    expect(prio("{}")).toBe(0);
  });

  it("pre-yields GitHub-budget background jobs when the persisted REST budget is reserved", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const oldJitter = process.env.QUEUE_RATE_LIMIT_JITTER_MS;
    process.env.QUEUE_RATE_LIMIT_JITTER_MS = "0";
    try {
      const driver = makeDriver();
      driver.query(
        `CREATE TABLE github_rate_limit_observations (
          id TEXT PRIMARY KEY,
          repo_full_name TEXT NOT NULL,
          admission_key TEXT,
          resource TEXT NOT NULL,
          path TEXT NOT NULL,
          status_code INTEGER NOT NULL,
          limit_value INTEGER,
          remaining INTEGER,
          reset_at TEXT,
          observed_at TEXT NOT NULL
        )`,
        [],
      );
      driver.query(
        `INSERT INTO github_rate_limit_observations (id, repo_full_name, admission_key, resource, path, status_code, limit_value, remaining, reset_at, observed_at)
         VALUES (?, ?, ?, 'rest', ?, 200, 5000, 120, ?, ?)`,
        ["rl-bg-installation", "owner/other-repo", "installation:123", "/x", "2026-06-24T12:10:00.000Z", "2026-06-24T12:00:00.000Z"],
      );
      driver.query(
        `INSERT INTO github_rate_limit_observations (id, repo_full_name, admission_key, resource, path, status_code, limit_value, remaining, reset_at, observed_at)
         VALUES (?, ?, 'public-token', 'rest', ?, 200, 5000, 120, ?, ?)`,
        ["rl-bg-public", "owner/repo", "/x", "2026-06-24T12:10:00.000Z", "2026-06-24T12:00:00.000Z"],
      );
      const seen: string[] = [];
      const q = createSqliteQueue(driver, async (m) => void seen.push(typeOf(m)));

      await q.binding.send({ type: "agent-regate-pr", deliveryId: "regate-sweep:owner/repo#7", repoFullName: "owner/repo", prNumber: 7, installationId: 123 });
      await q.binding.send({ type: "rag-index-repo", requestedBy: "schedule", repoFullName: "owner/repo" });
      await q.binding.send({ type: "github-webhook", deliveryId: "fresh", eventName: "pull_request", payload: {} });
      await q.drain();

      expect(seen).toEqual(["github-webhook"]);
      const row = driver.query(
        "SELECT status, attempts, run_after, last_error FROM _selfhost_jobs WHERE payload LIKE ?",
        ['%"agent-regate-pr"%'],
      ).rows[0] as { status: string; attempts: number; run_after: number; last_error: string };
      expect(row).toMatchObject({
        status: "pending",
        attempts: 0,
        run_after: Date.parse("2026-06-24T12:10:15.000Z"),
        last_error: "github rate-limit background admission",
      });
      const pendingBackground = driver.query(
        "SELECT COUNT(*) AS c FROM _selfhost_jobs WHERE status='pending' AND last_error=?",
        ["github rate-limit background admission"],
      ).rows[0] as { c: number };
      expect(pendingBackground.c).toBe(2);
      expect(await q.stats()).toMatchObject({ loopover_jobs_rate_limit_deferred_total: 2 });
      const metrics = await renderMetrics();
      expect(metrics).toContain('loopover_jobs_rate_limit_admission_deferred_total{job_type="agent-regate-pr",key_scope="installation",kind="background"} 1');
      expect(metrics).toContain('loopover_jobs_rate_limit_admission_deferred_total{job_type="rag-index-repo",key_scope="public",kind="background"} 1');
    } finally {
      if (oldJitter === undefined) delete process.env.QUEUE_RATE_LIMIT_JITTER_MS;
      else process.env.QUEUE_RATE_LIMIT_JITTER_MS = oldJitter;
      vi.useRealTimers();
    }
  });

  it("pre-yields GitHub-budget background jobs without repo fields from global REST observations", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const oldJitter = process.env.QUEUE_RATE_LIMIT_JITTER_MS;
    process.env.QUEUE_RATE_LIMIT_JITTER_MS = "0";
    try {
      const driver = makeDriver();
      driver.query(
        `CREATE TABLE github_rate_limit_observations (
          id TEXT PRIMARY KEY,
          repo_full_name TEXT NOT NULL,
          admission_key TEXT,
          resource TEXT NOT NULL,
          path TEXT NOT NULL,
          status_code INTEGER NOT NULL,
          limit_value INTEGER,
          remaining INTEGER,
          reset_at TEXT,
          observed_at TEXT NOT NULL
        )`,
        [],
      );
      driver.query(
        `INSERT INTO github_rate_limit_observations (id, repo_full_name, admission_key, resource, path, status_code, limit_value, remaining, reset_at, observed_at)
         VALUES (?, ?, NULL, 'rest', ?, 200, 5000, 120, ?, ?)`,
        ["rl-bg-global", "owner/repo", "/x", "2026-06-24T12:10:00.000Z", "2026-06-24T12:00:00.000Z"],
      );
      const seen: string[] = [];
      const q = createSqliteQueue(driver, async (m) => void seen.push(typeOf(m)));

      await q.binding.send({ type: "agent-regate-sweep", requestedBy: "schedule" });
      await q.drain();

      expect(seen).toEqual([]);
      const row = driver.query(
        "SELECT status, attempts, run_after, last_error FROM _selfhost_jobs",
        [],
      ).rows[0] as { status: string; attempts: number; run_after: number; last_error: string };
      expect(row).toMatchObject({
        status: "pending",
        attempts: 0,
        run_after: Date.parse("2026-06-24T12:10:15.000Z"),
        last_error: "github rate-limit background admission",
      });
    } finally {
      if (oldJitter === undefined) delete process.env.QUEUE_RATE_LIMIT_JITTER_MS;
      else process.env.QUEUE_RATE_LIMIT_JITTER_MS = oldJitter;
      vi.useRealTimers();
    }
  });

  it("pre-yields repo-scoped background jobs from global unkeyed REST observations", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const oldJitter = process.env.QUEUE_RATE_LIMIT_JITTER_MS;
    process.env.QUEUE_RATE_LIMIT_JITTER_MS = "0";
    try {
      const driver = makeDriver();
      driver.query(
        `CREATE TABLE github_rate_limit_observations (
          id TEXT PRIMARY KEY,
          repo_full_name TEXT NOT NULL,
          admission_key TEXT,
          resource TEXT NOT NULL,
          path TEXT NOT NULL,
          status_code INTEGER NOT NULL,
          limit_value INTEGER,
          remaining INTEGER,
          reset_at TEXT,
          observed_at TEXT NOT NULL
        )`,
        [],
      );
      driver.query(
        `INSERT INTO github_rate_limit_observations (id, repo_full_name, admission_key, resource, path, status_code, limit_value, remaining, reset_at, observed_at)
         VALUES (?, ?, NULL, 'rest', ?, 200, 5000, 120, ?, ?)`,
        ["rl-bg-global-repo", "owner/other-repo", "/x", "2026-06-24T12:10:00.000Z", "2026-06-24T12:00:00.000Z"],
      );
      const seen: string[] = [];
      const q = createSqliteQueue(driver, async (m) => void seen.push(typeOf(m)));

      await q.binding.send({ type: "rag-index-repo", requestedBy: "schedule", repoFullName: "owner/repo" });
      await q.drain();

      expect(seen).toEqual([]);
      const row = driver.query(
        "SELECT status, attempts, run_after, last_error FROM _selfhost_jobs",
        [],
      ).rows[0] as { status: string; attempts: number; run_after: number; last_error: string };
      expect(row).toMatchObject({
        status: "pending",
        attempts: 0,
        run_after: Date.parse("2026-06-24T12:10:15.000Z"),
        last_error: "github rate-limit background admission",
      });
    } finally {
      if (oldJitter === undefined) delete process.env.QUEUE_RATE_LIMIT_JITTER_MS;
      else process.env.QUEUE_RATE_LIMIT_JITTER_MS = oldJitter;
      vi.useRealTimers();
    }
  });

  it("pre-yields webhook jobs when the persisted REST bucket is exhausted", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const oldJitter = process.env.QUEUE_RATE_LIMIT_JITTER_MS;
    process.env.QUEUE_RATE_LIMIT_JITTER_MS = "0";
    try {
      const driver = makeDriver();
      driver.query(
        `CREATE TABLE github_rate_limit_observations (
          id TEXT PRIMARY KEY,
          repo_full_name TEXT NOT NULL,
          admission_key TEXT,
          resource TEXT NOT NULL,
          path TEXT NOT NULL,
          status_code INTEGER NOT NULL,
          limit_value INTEGER,
          remaining INTEGER,
          reset_at TEXT,
          observed_at TEXT NOT NULL
        )`,
        [],
      );
      driver.query(
        `INSERT INTO github_rate_limit_observations (id, repo_full_name, admission_key, resource, path, status_code, limit_value, remaining, reset_at, observed_at)
         VALUES (?, ?, ?, 'rest', ?, 403, 5000, 50, ?, ?)`,
        ["rl-webhook", "owner/other-repo", "installation:123", "/x", "2026-06-24T12:10:00.000Z", "2026-06-24T12:00:00.000Z"],
      );
      const seen: string[] = [];
      const q = createSqliteQueue(driver, async (m) => void seen.push(typeOf(m)));

      await q.binding.send({ type: "github-webhook", deliveryId: "fresh", eventName: "pull_request", payload: { installation: { id: 123 }, repository: { full_name: "owner/repo" } } });
      await q.drain();

      expect(seen).toEqual([]);
      const row = driver.query(
        "SELECT status, attempts, run_after, last_error FROM _selfhost_jobs",
        [],
      ).rows[0] as { status: string; attempts: number; run_after: number; last_error: string };
      expect(row).toMatchObject({
        status: "pending",
        attempts: 0,
        run_after: Date.parse("2026-06-24T12:10:15.000Z"),
        last_error: "github rate-limit webhook admission",
      });
      expect(await q.stats()).toMatchObject({ loopover_jobs_rate_limit_deferred_total: 1 });
      expect(await renderMetrics()).toContain('loopover_jobs_rate_limit_admission_deferred_total{job_type="github-webhook",key_scope="installation",kind="webhook"} 1');
    } finally {
      if (oldJitter === undefined) delete process.env.QUEUE_RATE_LIMIT_JITTER_MS;
      else process.env.QUEUE_RATE_LIMIT_JITTER_MS = oldJitter;
      vi.useRealTimers();
    }
  });

  it("skips admission-deferral metrics when a claimed SQLite job is no longer updated", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const oldJitter = process.env.QUEUE_RATE_LIMIT_JITTER_MS;
    process.env.QUEUE_RATE_LIMIT_JITTER_MS = "0";
    try {
      const base = makeDriver();
      const driver = {
        exec: base.exec.bind(base),
        query: vi.fn((sql: string, params: unknown[]) => {
          if (sql.includes("SET status='pending', run_after=max(run_after, ?)")) {
            return { rows: [], changes: 0 };
          }
          return base.query(sql, params);
        }),
      } as ReturnType<typeof nodeSqliteDriver>;
      driver.query(
        `CREATE TABLE github_rate_limit_observations (
          id TEXT PRIMARY KEY,
          repo_full_name TEXT NOT NULL,
          admission_key TEXT,
          resource TEXT NOT NULL,
          path TEXT NOT NULL,
          status_code INTEGER NOT NULL,
          limit_value INTEGER,
          remaining INTEGER,
          reset_at TEXT,
          observed_at TEXT NOT NULL
        )`,
        [],
      );
      driver.query(
        `INSERT INTO github_rate_limit_observations (id, repo_full_name, admission_key, resource, path, status_code, limit_value, remaining, reset_at, observed_at)
         VALUES (?, ?, ?, 'rest', ?, 403, 5000, 50, ?, ?)`,
        ["rl-webhook", "owner/repo", "installation:123", "/x", "2026-06-24T12:10:00.000Z", "2026-06-24T12:00:00.000Z"],
      );
      const q = createSqliteQueue(driver, async () => {
        throw new Error("should not consume admitted work");
      });

      await q.binding.send(installedWebhook("fresh", 123));
      await q.drain();

      expect(await q.stats()).not.toHaveProperty("loopover_jobs_rate_limit_deferred_total");
      expect(await renderMetrics()).not.toContain("loopover_jobs_rate_limit_admission_deferred_total");
    } finally {
      if (oldJitter === undefined) delete process.env.QUEUE_RATE_LIMIT_JITTER_MS;
      else process.env.QUEUE_RATE_LIMIT_JITTER_MS = oldJitter;
      vi.useRealTimers();
    }
  });

  it("pre-yields webhook jobs from global legacy observations when an installation id is present", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const oldJitter = process.env.QUEUE_RATE_LIMIT_JITTER_MS;
    process.env.QUEUE_RATE_LIMIT_JITTER_MS = "0";
    try {
      const driver = makeDriver();
      driver.query(
        `CREATE TABLE github_rate_limit_observations (
          id TEXT PRIMARY KEY,
          repo_full_name TEXT NOT NULL,
          admission_key TEXT,
          resource TEXT NOT NULL,
          path TEXT NOT NULL,
          status_code INTEGER NOT NULL,
          limit_value INTEGER,
          remaining INTEGER,
          reset_at TEXT,
          observed_at TEXT NOT NULL
        )`,
        [],
      );
      driver.query(
        `INSERT INTO github_rate_limit_observations (id, repo_full_name, admission_key, resource, path, status_code, limit_value, remaining, reset_at, observed_at)
         VALUES (?, ?, NULL, 'rest', ?, 403, 5000, 50, ?, ?)`,
        ["rl-webhook-legacy", "owner/other-repo", "/x", "2026-06-24T12:10:00.000Z", "2026-06-24T12:00:00.000Z"],
      );
      const seen: string[] = [];
      const q = createSqliteQueue(driver, async (m) => void seen.push(typeOf(m)));

      await q.binding.send({ type: "github-webhook", deliveryId: "fresh", eventName: "pull_request", payload: { installation: { id: 123 }, repository: { full_name: "owner/repo" } } });
      await q.drain();

      expect(seen).toEqual([]);
      const row = driver.query(
        "SELECT status, attempts, run_after, last_error FROM _selfhost_jobs",
        [],
      ).rows[0] as { status: string; attempts: number; run_after: number; last_error: string };
      expect(row).toMatchObject({
        status: "pending",
        attempts: 0,
        run_after: Date.parse("2026-06-24T12:10:15.000Z"),
        last_error: "github rate-limit webhook admission",
      });
    } finally {
      if (oldJitter === undefined) delete process.env.QUEUE_RATE_LIMIT_JITTER_MS;
      else process.env.QUEUE_RATE_LIMIT_JITTER_MS = oldJitter;
      vi.useRealTimers();
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
      const driver = makeDriver();
      driver.query(
        `CREATE TABLE github_rate_limit_observations (
          id TEXT PRIMARY KEY,
          repo_full_name TEXT NOT NULL,
          admission_key TEXT,
          resource TEXT NOT NULL,
          path TEXT NOT NULL,
          status_code INTEGER NOT NULL,
          limit_value INTEGER,
          remaining INTEGER,
          reset_at TEXT,
          observed_at TEXT NOT NULL
        )`,
        [],
      );
      driver.query(
        `INSERT INTO github_rate_limit_observations (id, repo_full_name, admission_key, resource, path, status_code, limit_value, remaining, reset_at, observed_at)
         VALUES (?, ?, ?, 'rest', ?, 200, 5000, 4000, ?, ?)`,
        ["rl-webhook-installation-old", "owner/other-repo", "installation:123", "/x", "2026-06-24T12:20:00.000Z", "2026-06-24T11:59:00.000Z"],
      );
      driver.query(
        `INSERT INTO github_rate_limit_observations (id, repo_full_name, admission_key, resource, path, status_code, limit_value, remaining, reset_at, observed_at)
         VALUES (?, ?, NULL, 'rest', ?, 403, 5000, 0, ?, ?)`,
        ["rl-webhook-legacy-new", "owner/repo", "/x", "2026-06-24T12:10:00.000Z", "2026-06-24T12:00:00.000Z"],
      );
      const seen: string[] = [];
      const q = createSqliteQueue(driver, async (m) => void seen.push(typeOf(m)));

      await q.binding.send({ type: "github-webhook", deliveryId: "fresh", eventName: "pull_request", payload: { installation: { id: 123 }, repository: { full_name: "owner/repo" } } });
      await q.drain();

      expect(seen).toEqual(["github-webhook"]);
      expect(await q.stats()).not.toHaveProperty("loopover_jobs_rate_limit_deferred_total");
    } finally {
      if (oldJitter === undefined) delete process.env.QUEUE_RATE_LIMIT_JITTER_MS;
      else process.env.QUEUE_RATE_LIMIT_JITTER_MS = oldJitter;
      vi.useRealTimers();
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
      const driver = makeDriver();
      driver.query(
        `CREATE TABLE github_rate_limit_observations (
          id TEXT PRIMARY KEY,
          repo_full_name TEXT NOT NULL,
          admission_key TEXT,
          resource TEXT NOT NULL,
          path TEXT NOT NULL,
          status_code INTEGER NOT NULL,
          limit_value INTEGER,
          remaining INTEGER,
          reset_at TEXT,
          observed_at TEXT NOT NULL
        )`,
        [],
      );
      driver.query(
        `INSERT INTO github_rate_limit_observations (id, repo_full_name, admission_key, resource, path, status_code, limit_value, remaining, reset_at, observed_at)
         VALUES (?, ?, ?, 'rest', ?, 403, 5000, 0, ?, ?)`,
        ["rl-webhook-installation-old", "owner/other-repo", "installation:123", "/x", "2026-06-24T12:10:00.000Z", "2026-06-24T11:59:00.000Z"],
      );
      driver.query(
        `INSERT INTO github_rate_limit_observations (id, repo_full_name, admission_key, resource, path, status_code, limit_value, remaining, reset_at, observed_at)
         VALUES (?, ?, NULL, 'rest', ?, 200, 5000, 4000, ?, ?)`,
        ["rl-webhook-legacy-new", "owner/repo", "/x", "2026-06-24T12:20:00.000Z", "2026-06-24T12:00:00.000Z"],
      );
      const seen: string[] = [];
      const q = createSqliteQueue(driver, async (m) => void seen.push(typeOf(m)));

      await q.binding.send({ type: "github-webhook", deliveryId: "fresh", eventName: "pull_request", payload: { installation: { id: 123 }, repository: { full_name: "owner/repo" } } });
      await q.drain();

      expect(seen).toEqual([]);
      const row = driver.query(
        "SELECT status, attempts, run_after, last_error FROM _selfhost_jobs",
        [],
      ).rows[0] as { status: string; attempts: number; run_after: number; last_error: string };
      expect(row).toMatchObject({
        status: "pending",
        attempts: 0,
        run_after: Date.parse("2026-06-24T12:10:15.000Z"),
        last_error: "github rate-limit webhook admission",
      });
    } finally {
      if (oldJitter === undefined) delete process.env.QUEUE_RATE_LIMIT_JITTER_MS;
      else process.env.QUEUE_RATE_LIMIT_JITTER_MS = oldJitter;
      vi.useRealTimers();
    }
  });

  it("does not keep webhook admission closed from stale legacy low rows after a newer healthy legacy observation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const driver = makeDriver();
    driver.query(
      `CREATE TABLE github_rate_limit_observations (
        id TEXT PRIMARY KEY,
        repo_full_name TEXT NOT NULL,
        admission_key TEXT,
        resource TEXT NOT NULL,
        path TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        limit_value INTEGER,
        remaining INTEGER,
        reset_at TEXT,
        observed_at TEXT NOT NULL
      )`,
      [],
    );
    driver.query(
      `INSERT INTO github_rate_limit_observations (id, repo_full_name, admission_key, resource, path, status_code, limit_value, remaining, reset_at, observed_at)
       VALUES (?, ?, NULL, 'rest', ?, 403, 5000, 0, ?, ?)`,
      ["rl-webhook-legacy-old-low", "owner/repo", "/x", "2026-06-24T12:10:00.000Z", "2026-06-24T11:59:00.000Z"],
    );
    driver.query(
      `INSERT INTO github_rate_limit_observations (id, repo_full_name, admission_key, resource, path, status_code, limit_value, remaining, reset_at, observed_at)
       VALUES (?, ?, NULL, 'rest', ?, 200, 5000, 4000, ?, ?)`,
      ["rl-webhook-legacy-new-healthy", "owner/repo", "/x", "2026-06-24T12:20:00.000Z", "2026-06-24T12:00:00.000Z"],
    );
    const seen: string[] = [];
    const q = createSqliteQueue(driver, async (m) => void seen.push(typeOf(m)));

    await q.binding.send({ type: "github-webhook", deliveryId: "fresh", eventName: "pull_request", payload: { installation: { id: 123 }, repository: { full_name: "owner/repo" } } });
    await q.drain();

    expect(seen).toEqual(["github-webhook"]);
    expect(await q.stats()).not.toHaveProperty("loopover_jobs_rate_limit_deferred_total");
  });

  it("does not keep webhook admission closed from stale legacy rows after a newer healthy exact observation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const driver = makeDriver();
    driver.query(
      `CREATE TABLE github_rate_limit_observations (
        id TEXT PRIMARY KEY,
        repo_full_name TEXT NOT NULL,
        admission_key TEXT,
        resource TEXT NOT NULL,
        path TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        limit_value INTEGER,
        remaining INTEGER,
        reset_at TEXT,
        observed_at TEXT NOT NULL
      )`,
      [],
    );
    driver.query(
      `INSERT INTO github_rate_limit_observations (id, repo_full_name, admission_key, resource, path, status_code, limit_value, remaining, reset_at, observed_at)
       VALUES (?, ?, NULL, 'rest', ?, 403, 5000, 0, ?, ?)`,
      ["rl-webhook-legacy-old-low", "owner/repo", "/x", "2026-06-24T12:10:00.000Z", "2026-06-24T11:59:00.000Z"],
    );
    driver.query(
      `INSERT INTO github_rate_limit_observations (id, repo_full_name, admission_key, resource, path, status_code, limit_value, remaining, reset_at, observed_at)
       VALUES (?, ?, ?, 'rest', ?, 200, 5000, 4000, ?, ?)`,
      ["rl-webhook-exact-new-healthy", "owner/repo", "installation:123", "/x", "2026-06-24T12:20:00.000Z", "2026-06-24T12:00:00.000Z"],
    );
    const seen: string[] = [];
    const q = createSqliteQueue(driver, async (m) => void seen.push(typeOf(m)));

    await q.binding.send({ type: "github-webhook", deliveryId: "fresh", eventName: "pull_request", payload: { installation: { id: 123 }, repository: { full_name: "owner/repo" } } });
    await q.drain();

    expect(seen).toEqual(["github-webhook"]);
    expect(await q.stats()).not.toHaveProperty("loopover_jobs_rate_limit_deferred_total");
  });

  it("does not pre-yield webhook jobs for another installation's persisted REST exhaustion", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const driver = makeDriver();
    driver.query(
      `CREATE TABLE github_rate_limit_observations (
        id TEXT PRIMARY KEY,
        repo_full_name TEXT NOT NULL,
        admission_key TEXT,
        resource TEXT NOT NULL,
        path TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        limit_value INTEGER,
        remaining INTEGER,
        reset_at TEXT,
        observed_at TEXT NOT NULL
      )`,
      [],
    );
    driver.query(
      `INSERT INTO github_rate_limit_observations (id, repo_full_name, admission_key, resource, path, status_code, limit_value, remaining, reset_at, observed_at)
       VALUES (?, ?, ?, 'rest', ?, 403, 5000, 0, ?, ?)`,
      ["rl-webhook", "owner/repo-a", "installation:456", "/x", "2026-06-24T12:10:00.000Z", "2026-06-24T12:00:00.000Z"],
    );
    const seen: string[] = [];
    const q = createSqliteQueue(driver, async (m) => void seen.push(typeOf(m)));

    await q.binding.send({ type: "github-webhook", deliveryId: "fresh", eventName: "pull_request", payload: { installation: { id: 123 }, repository: { full_name: "owner/repo-b" } } });
    await q.drain();

    expect(seen).toEqual(["github-webhook"]);
    expect(await q.stats()).not.toHaveProperty("loopover_jobs_rate_limit_deferred_total");
  });

  it("skips the background-admission metric when the defer update changes no rows", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const oldJitter = process.env.QUEUE_RATE_LIMIT_JITTER_MS;
    process.env.QUEUE_RATE_LIMIT_JITTER_MS = "0";
    try {
      const base = makeDriver();
      const driver = {
        query(sql: string, params: unknown[]) {
          if (sql.includes("SET status='pending', run_after=max")) {
            return { rows: [], changes: 0, lastInsertRowid: 0 };
          }
          return base.query(sql, params);
        },
        exec(sql: string) {
          base.exec(sql);
        },
      };
      driver.query(
        `CREATE TABLE github_rate_limit_observations (
          id TEXT PRIMARY KEY,
          repo_full_name TEXT NOT NULL,
          admission_key TEXT,
          resource TEXT NOT NULL,
          path TEXT NOT NULL,
          status_code INTEGER NOT NULL,
          limit_value INTEGER,
          remaining INTEGER,
          reset_at TEXT,
          observed_at TEXT NOT NULL
        )`,
        [],
      );
      driver.query(
        `INSERT INTO github_rate_limit_observations (id, repo_full_name, admission_key, resource, path, status_code, limit_value, remaining, reset_at, observed_at)
         VALUES (?, ?, NULL, 'rest', ?, 200, 5000, 120, ?, ?)`,
        ["rl-bg", "owner/repo", "/x", "2026-06-24T12:10:00.000Z", "2026-06-24T12:00:00.000Z"],
      );
      const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const seen: string[] = [];
      const q = createSqliteQueue(driver, async (m) => void seen.push(typeOf(m)));

      await q.binding.send({ type: "rag-index-repo", requestedBy: "schedule", repoFullName: "owner/repo" });
      await q.drain();

      expect(seen).toEqual([]);
      expect(warned).not.toHaveBeenCalled();
      expect(await q.stats()).not.toHaveProperty("loopover_jobs_rate_limit_deferred_total");
    } finally {
      if (oldJitter === undefined) delete process.env.QUEUE_RATE_LIMIT_JITTER_MS;
      else process.env.QUEUE_RATE_LIMIT_JITTER_MS = oldJitter;
      vi.useRealTimers();
    }
  });

  it("backfills stale priorities on startup so existing regate jobs are not buried", async () => {
    const driver = makeDriver();
    driver.exec(`
      CREATE TABLE _selfhost_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        run_after INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_error TEXT,
        priority INTEGER NOT NULL DEFAULT 0
      );
    `);
    driver.query(
      "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority) VALUES (?, 'pending', 0, 0, 0, 0)",
      [JSON.stringify(msg("agent-regate-pr"))],
    );
    driver.query(
      "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority) VALUES (?, 'pending', 0, 0, 0, 0)",
      [JSON.stringify(msg("github-webhook"))],
    );
    driver.query(
      "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority) VALUES (?, 'pending', 0, 0, 0, 10)",
      [JSON.stringify(webhook({ login: "gittensory-orb[bot]", type: "Bot" }))],
    );

    createSqliteQueue(driver, async () => undefined);

    const { rows } = driver.query(
      "SELECT payload, priority FROM _selfhost_jobs ORDER BY id",
      [],
    );
    expect(rows.map((row) => row as { payload: string; priority: number })).toEqual([
      { payload: JSON.stringify(msg("agent-regate-pr")), priority: 9 },
      { payload: JSON.stringify(msg("github-webhook")), priority: 10 },
      { payload: JSON.stringify(webhook({ login: "gittensory-orb[bot]", type: "Bot" })), priority: 0 },
    ]);
  });

  it("backfills semantic job keys for already-pending duplicate-prone work", async () => {
    const driver = makeDriver();
    driver.exec(`
      CREATE TABLE _selfhost_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        run_after INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_error TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        job_key TEXT
      );
    `);
    driver.query(
      "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority) VALUES (?, 'pending', 0, ?, 0, 10)",
      [JSON.stringify(ciWebhook("ci-1")), Date.now() + 60_000],
    );

    createSqliteQueue(driver, async () => undefined);

    const row = driver.query("SELECT job_key FROM _selfhost_jobs", []).rows[0] as { job_key: string };
    expect(row.job_key).toBe(`github-webhook:ci-completed:jsonbored/gittensory@${"b".repeat(40)}#1629`);
  });

  it("coalesces duplicate CI, PR-refresh, and sweep jobs before they inflate queue pressure", async () => {
    const driver = makeDriver();
    const q = createSqliteQueue(driver, async () => undefined);
    await q.binding.send(ciWebhook("ci-1", "check_suite"), { delaySeconds: 60 });
    await q.binding.send(ciWebhook("ci-2", "check_run"), { delaySeconds: 1 });
    await q.binding.send(prWebhook("pr-1"), { delaySeconds: 60 });
    await q.binding.send(prWebhook("pr-2"), { delaySeconds: 1 });
    await q.binding.send({ type: "agent-regate-sweep", requestedBy: "schedule" } as JobMessage, { delaySeconds: 60 });
    await q.binding.send({ type: "agent-regate-sweep", requestedBy: "schedule" } as JobMessage, { delaySeconds: 1 });

    const rows = driver.query(
      "SELECT payload, job_key FROM _selfhost_jobs ORDER BY id",
      [],
    ).rows as Array<{ payload: string; job_key: string }>;
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.job_key).sort()).toEqual([
      "agent-regate-sweep:all",
      `github-webhook:ci-completed:jsonbored/gittensory@${"b".repeat(40)}#1629`,
      `github-webhook:pr-refresh:jsonbored/gittensory#1629@${"a".repeat(40)}`,
    ]);
    expect(rows.map((row) => JSON.parse(row.payload).deliveryId).filter(Boolean).sort()).toEqual(["ci-2", "pr-2"]);
    expect(await q.stats()).toMatchObject({
      loopover_jobs_enqueued_total: 3,
      loopover_jobs_coalesced_total: 3,
    });
  });

  it("REGRESSION (#audit-webhook-supersede-trace): marks a superseded pr-refresh delivery's webhook_events row instead of leaving it stuck at 'queued' forever", async () => {
    const driver = makeDriver();
    driver.exec(`
      CREATE TABLE webhook_events (
        delivery_id TEXT PRIMARY KEY,
        event_name TEXT NOT NULL,
        action TEXT,
        installation_id INTEGER,
        repository_full_name TEXT,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        error_summary TEXT,
        received_at TEXT NOT NULL,
        processed_at TEXT
      );
    `);
    driver.query(
      "INSERT INTO webhook_events (delivery_id, event_name, payload_hash, status, received_at) VALUES (?, 'pull_request', 'hash-1', 'queued', '2026-07-06T00:00:00.000Z')",
      ["pr-1"],
    );
    const q = createSqliteQueue(driver, async () => undefined);

    await q.binding.send(prWebhook("pr-1"), { delaySeconds: 60 });
    await q.binding.send(prWebhook("pr-2"), { delaySeconds: 1 }); // coalesces into pr-1's row, overwriting its payload

    const rows = driver.query("SELECT payload FROM _selfhost_jobs ORDER BY id", []).rows as Array<{ payload: string }>;
    expect(rows).toHaveLength(1); // coalesced into one row
    expect(JSON.parse(rows[0]!.payload).deliveryId).toBe("pr-2"); // pr-2's payload survives -- pr-1's is gone from the queue
    const event = driver.query("SELECT status FROM webhook_events WHERE delivery_id = ?", ["pr-1"]).rows[0] as { status: string } | undefined;
    expect(event?.status).toBe("superseded"); // pr-1's trace row is marked, not left stuck at 'queued' forever
  });

  it("fails safe when the webhook_events table itself errors: the coalesce still completes and only logs a warning", async () => {
    const driver = makeDriver();
    // No webhook_events table -- the UPDATE inside markSupersededWebhookEvent will throw "no such table", which
    // must be caught and logged, never allowed to abort the coalesce/enqueue itself.
    const q = createSqliteQueue(driver, async () => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await q.binding.send(prWebhook("pr-1"), { delaySeconds: 60 });
    await q.binding.send(prWebhook("pr-2"), { delaySeconds: 1 });

    const rows = driver.query("SELECT payload FROM _selfhost_jobs ORDER BY id", []).rows as Array<{ payload: string }>;
    expect(rows).toHaveLength(1); // the coalesce itself still completed despite the missing table
    expect(JSON.parse(rows[0]!.payload).deliveryId).toBe("pr-2");
    expect(errors.mock.calls.some((call) => String(call[0]).includes("webhook_supersede_mark_failed"))).toBe(true);
    errors.mockRestore();
  });

  it("does not mark superseded (no-op) when the coalesce is against the SAME deliveryId (defense-in-depth)", async () => {
    const driver = makeDriver();
    driver.exec(`
      CREATE TABLE webhook_events (
        delivery_id TEXT PRIMARY KEY,
        event_name TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
    `);
    driver.query(
      "INSERT INTO webhook_events (delivery_id, event_name, payload_hash, status, received_at) VALUES (?, 'pull_request', 'hash-1', 'queued', '2026-07-06T00:00:00.000Z')",
      ["same-id"],
    );
    const q = createSqliteQueue(driver, async () => undefined);

    await q.binding.send(prWebhook("same-id"), { delaySeconds: 60 });
    await q.binding.send(prWebhook("same-id"), { delaySeconds: 1 }); // re-coalesces against its own delivery id

    const event = driver.query("SELECT status FROM webhook_events WHERE delivery_id = ?", ["same-id"]).rows[0] as { status: string } | undefined;
    expect(event?.status).toBe("queued"); // untouched -- there is nothing genuinely superseded here
  });

  it("tolerates an unparseable existing payload (a corrupted row) without throwing", async () => {
    const driver = makeDriver();
    const q = createSqliteQueue(driver, async () => undefined);
    driver.query(
      `INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key) VALUES (?, 'pending', 0, ?, ?, 5, ?)`,
      ["not valid json{", Date.now() + 60_000, Date.now(), `github-webhook:pr-refresh:jsonbored/gittensory#1629@${"a".repeat(40)}`],
    );

    await expect(q.binding.send(prWebhook("pr-2"), { delaySeconds: 1 })).resolves.toBeUndefined();

    const rows = driver.query("SELECT payload FROM _selfhost_jobs ORDER BY id", []).rows as Array<{ payload: string }>;
    expect(rows).toHaveLength(1); // still coalesced into one row despite the corrupted existing payload
    expect(JSON.parse(rows[0]!.payload).deliveryId).toBe("pr-2");
  });

  it("lets a pending full RAG index absorb later repo incrementals", async () => {
    const driver = makeDriver();
    const q = createSqliteQueue(driver, async () => undefined);
    await q.binding.send({
      type: "rag-index-repo",
      requestedBy: "schedule",
      repoFullName: "JSONbored/gittensory",
    }, { delaySeconds: 60 });
    await q.binding.send({
      type: "rag-index-repo",
      requestedBy: "webhook",
      repoFullName: "JSONbored/gittensory",
      paths: ["src/a.ts"],
    }, { delaySeconds: 1 });

    const rows = driver.query(
      "SELECT payload, job_key FROM _selfhost_jobs ORDER BY id",
      [],
    ).rows as Array<{ payload: string; job_key: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.job_key).toBe("rag-index-repo:jsonbored/gittensory:full");
    expect(JSON.parse(rows[0]!.payload)).toEqual({
      type: "rag-index-repo",
      requestedBy: "schedule",
      repoFullName: "JSONbored/gittensory",
    });
    expect(await q.stats()).toMatchObject({
      loopover_jobs_enqueued_total: 1,
      loopover_jobs_coalesced_total: 1,
    });
  });

  it("lets a full RAG index supersede pending repo incrementals without dropping to one path set", async () => {
    const driver = makeDriver();
    const q = createSqliteQueue(driver, async () => undefined);
    await q.binding.send({
      type: "rag-index-repo",
      requestedBy: "webhook",
      repoFullName: "JSONbored/gittensory",
      paths: ["src/a.ts"],
    }, { delaySeconds: 60 });
    await q.binding.send({
      type: "rag-index-repo",
      requestedBy: "webhook",
      repoFullName: "JSONbored/gittensory",
      paths: ["src/b.ts"],
    }, { delaySeconds: 60 });
    await q.binding.send({
      type: "rag-index-repo",
      requestedBy: "schedule",
      repoFullName: "JSONbored/gittensory",
    }, { delaySeconds: 1 });

    const rows = driver.query(
      "SELECT payload, job_key FROM _selfhost_jobs ORDER BY id",
      [],
    ).rows as Array<{ payload: string; job_key: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.job_key).toBe("rag-index-repo:jsonbored/gittensory:full");
    expect(JSON.parse(rows[0]!.payload)).toEqual({
      type: "rag-index-repo",
      requestedBy: "schedule",
      repoFullName: "JSONbored/gittensory",
    });
    // The two incrementals now MERGE into one row before the full job supersedes it (#selfhost-maintenance-self-pin):
    // 1 insert (the first incremental) + 2 coalesces (the merge, then the supersede), not 2 inserts + 1 coalesce.
    expect(await q.stats()).toMatchObject({
      loopover_jobs_enqueued_total: 1,
      loopover_jobs_coalesced_total: 2,
    });
  });

  // #selfhost-maintenance-self-pin: several merge-triggered incremental RAG jobs for the SAME repo, arriving
  // while one is still pending, union their paths into ONE row instead of piling up as separate maintenance-lane
  // entries -- distinct from the absorb/supersede pair above, which only ever involve a FULL job on one side.
  it("merges two pending incremental RAG jobs for the same repo into one row's union path set", async () => {
    const driver = makeDriver();
    const q = createSqliteQueue(driver, async () => undefined);
    await q.binding.send({
      type: "rag-index-repo",
      requestedBy: "webhook",
      repoFullName: "JSONbored/gittensory",
      paths: ["src/a.ts"],
    }, { delaySeconds: 60 });
    await q.binding.send({
      type: "rag-index-repo",
      requestedBy: "webhook",
      repoFullName: "JSONbored/gittensory",
      paths: ["src/b.ts"],
    }, { delaySeconds: 60 });

    const rows = driver.query(
      "SELECT payload, job_key FROM _selfhost_jobs ORDER BY id",
      [],
    ).rows as Array<{ payload: string; job_key: string }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload)).toEqual({
      type: "rag-index-repo",
      requestedBy: "webhook",
      repoFullName: "JSONbored/gittensory",
      paths: ["src/a.ts", "src/b.ts"],
    });
    expect(rows[0]?.job_key).toBe(jobCoalesceKey(rows[0]!.payload));
    expect(await q.stats()).toMatchObject({
      loopover_jobs_enqueued_total: 1,
      loopover_jobs_coalesced_total: 1,
    });
  });

  it("does not merge a repo's incremental into an already-pending FULL job for that repo", async () => {
    const driver = makeDriver();
    const q = createSqliteQueue(driver, async () => undefined);
    await q.binding.send({
      type: "rag-index-repo",
      requestedBy: "schedule",
      repoFullName: "JSONbored/gittensory",
    }, { delaySeconds: 60 });
    await q.binding.send({
      type: "rag-index-repo",
      requestedBy: "webhook",
      repoFullName: "JSONbored/gittensory",
      paths: ["src/a.ts"],
    }, { delaySeconds: 1 });

    // Absorbed by the existing FULL job (unchanged behavior), never merged into a narrower shape.
    const rows = driver.query("SELECT payload FROM _selfhost_jobs ORDER BY id", []).rows as Array<{ payload: string }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload)).toEqual({
      type: "rag-index-repo",
      requestedBy: "schedule",
      repoFullName: "JSONbored/gittensory",
    });
  });

  it("does not merge incrementals across DIFFERENT repos", async () => {
    const driver = makeDriver();
    const q = createSqliteQueue(driver, async () => undefined);
    await q.binding.send({
      type: "rag-index-repo",
      requestedBy: "webhook",
      repoFullName: "JSONbored/gittensory",
      paths: ["src/a.ts"],
    }, { delaySeconds: 60 });
    await q.binding.send({
      type: "rag-index-repo",
      requestedBy: "webhook",
      repoFullName: "JSONbored/metagraphed",
      paths: ["src/b.ts"],
    }, { delaySeconds: 60 });

    const rows = driver.query("SELECT payload FROM _selfhost_jobs ORDER BY id", []).rows as Array<{ payload: string }>;
    expect(rows).toHaveLength(2);
  });

  it("falls through to a separate row when merging would exceed the bounded path cap", async () => {
    const driver = makeDriver();
    const q = createSqliteQueue(driver, async () => undefined);
    await q.binding.send({
      type: "rag-index-repo",
      requestedBy: "webhook",
      repoFullName: "JSONbored/gittensory",
      paths: Array.from({ length: 100 }, (_, i) => `src/${i}.ts`), // already at the cap
    }, { delaySeconds: 60 });
    await q.binding.send({
      type: "rag-index-repo",
      requestedBy: "webhook",
      repoFullName: "JSONbored/gittensory",
      paths: ["src/extra.ts"],
    }, { delaySeconds: 60 });

    // No merge (would be 101 paths, over the cap) -- the second send lands as its OWN row instead.
    const rows = driver.query("SELECT payload FROM _selfhost_jobs ORDER BY id", []).rows as Array<{ payload: string }>;
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0]!.payload).paths).toHaveLength(100);
    expect(JSON.parse(rows[1]!.payload).paths).toEqual(["src/extra.ts"]);
  });

  it("snapshot() reports pending/processing/dead queue depth by job type", async () => {
    const driver = makeDriver();
    const q = createSqliteQueue(driver, async () => undefined);
    await q.binding.send(msg("agent-regate-pr"), { delaySeconds: 60 });
    driver.query(
      "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority) VALUES (?, 'pending', 0, ?, 0, 10)",
      [JSON.stringify(msg("github-webhook")), Date.now() - 1],
    );
    driver.query(
      "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority) VALUES (?, 'processing', 0, ?, 0, 9)",
      [JSON.stringify(msg("agent-regate-pr")), Date.now()],
    );
    driver.query(
      "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority) VALUES (?, 'dead', 0, ?, 0, 0)",
      [JSON.stringify(msg("rag-index-repo")), Date.now()],
    );

    const snapshot = await q.snapshot();
    const bindingSnapshot = await queueSnapshotFromBinding(q.binding);

    expect(snapshot.totals).toMatchObject({ pending: 2, processing: 1, dead: 1 });
    expect(snapshot.byType).toEqual(
      expect.arrayContaining([
        { type: "agent-regate-pr", status: "pending", count: 1, due: 0 },
        { type: "agent-regate-pr", status: "processing", count: 1, due: 0 },
        { type: "github-webhook", status: "pending", count: 1, due: 1 },
        { type: "rag-index-repo", status: "dead", count: 1, due: 0 },
      ]),
    );
    expect(bindingSnapshot).toEqual(snapshot);
  });

  it("coalesces recurring maintenance jobs by semantic scope and keeps distinct scopes separate", async () => {
    const driver = makeDriver();
    const q = createSqliteQueue(driver, async () => undefined);

    await q.binding.send({
      type: "backfill-registered-repos",
      requestedBy: "schedule",
      repoFullName: "JSONbored/gittensory",
      mode: "resume",
      force: true,
    }, { delaySeconds: 60 });
    await q.binding.send({
      type: "backfill-registered-repos",
      requestedBy: "api",
      repoFullName: "JSONbored/gittensory",
      mode: "resume",
      force: true,
    }, { delaySeconds: 60 });
    await q.binding.send({
      type: "backfill-registered-repos",
      requestedBy: "api",
      repoFullName: "JSONbored/gittensory",
      mode: "light",
      force: true,
    }, { delaySeconds: 60 });
    await q.binding.send({
      type: "generate-weekly-value-report",
      requestedBy: "schedule",
      variant: "operator",
      days: 7,
    }, { delaySeconds: 60 });
    await q.binding.send({
      type: "generate-weekly-value-report",
      requestedBy: "api",
      variant: "operator",
      days: 7,
    }, { delaySeconds: 60 });
    await q.binding.send({
      type: "generate-weekly-value-report",
      requestedBy: "api",
      variant: "public",
      days: 7,
    }, { delaySeconds: 60 });
    await q.binding.send({
      type: "rag-index-repo",
      requestedBy: "webhook",
      repoFullName: "JSONbored/gittensory",
      paths: ["src/b.ts", "src/a.ts"],
    }, { delaySeconds: 60 });
    await q.binding.send({
      type: "rag-index-repo",
      requestedBy: "schedule",
      repoFullName: "JSONbored/gittensory",
      paths: ["src/a.ts", "src/b.ts"],
    }, { delaySeconds: 60 });
    await q.binding.send({
      type: "rag-index-repo",
      requestedBy: "schedule",
      repoFullName: "JSONbored/gittensory",
      paths: ["src/c.ts"],
    }, { delaySeconds: 60 });

    const rows = driver.query(
      "SELECT payload, job_key FROM _selfhost_jobs ORDER BY id",
      [],
    ).rows as Array<{ payload: string; job_key: string }>;

    // The third rag-index-repo send (paths: ["src/c.ts"]) now MERGES into the same-repo incremental row the
    // first two sends already coalesced onto (#selfhost-maintenance-self-pin), instead of becoming its own row --
    // 5 rows, not 6, and one fewer coalesce boundary than before that merge existed.
    const mergedRagKey = jobCoalesceKey(
      JSON.stringify({
        type: "rag-index-repo",
        requestedBy: "schedule",
        repoFullName: "JSONbored/gittensory",
        paths: ["src/a.ts", "src/b.ts", "src/c.ts"],
      }),
    );
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.job_key)).toEqual([
      "backfill-registered-repos:jsonbored/gittensory:resume:1",
      "backfill-registered-repos:jsonbored/gittensory:light:1",
      "generate-weekly-value-report:operator:7",
      "generate-weekly-value-report:public:7",
      mergedRagKey,
    ]);
    expect(JSON.parse(rows[4]!.payload).paths).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(rows.map((row) => JSON.parse(row.payload).requestedBy)).toEqual([
      "api",
      "api",
      "api",
      "api",
      "schedule",
    ]);
    expect(await q.stats()).toMatchObject({
      loopover_jobs_enqueued_total: 5,
      loopover_jobs_coalesced_total: 4,
    });
  });

  it("preserves the original created_at across a coalesced re-enqueue of a recurring maintenance job (regression for #selfhost-runtime-drift)", async () => {
    // A periodic scheduler (e.g. the hourly refresh-registry trigger) re-enqueues the SAME still-pending
    // maintenance job while it is deferred under sustained pressure. created_at anchors the maintenance
    // trickle's age clock (maintenance-admission.ts) -- if the coalesced re-enqueue reset it to "now" every
    // time, a re-enqueue cadence shorter than maxDeferAgeMs would re-arm the clock forever and the job would
    // never force-admit, no matter how long the underlying need had genuinely been outstanding.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    try {
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined);

      await q.binding.send(msg("refresh-registry"), { delaySeconds: 60 });
      const first = driver.query(
        "SELECT id, created_at, run_after FROM _selfhost_jobs WHERE payload LIKE '%refresh-registry%'",
        [],
      ).rows[0] as { id: number; created_at: number; run_after: number };

      vi.setSystemTime(new Date("2026-06-24T12:30:00.000Z")); // 30m later: next periodic tick, still pending
      await q.binding.send(msg("refresh-registry"), { delaySeconds: 60 });

      const rows = driver.query("SELECT id, created_at, run_after FROM _selfhost_jobs", []).rows as Array<{
        id: number;
        created_at: number;
        run_after: number;
      }>;
      expect(rows).toHaveLength(1); // coalesced into the same row, not a second insert
      expect(rows[0]?.id).toBe(first.id);
      expect(rows[0]?.created_at).toBe(first.created_at); // NOT reset to the re-enqueue time
      expect(rows[0]?.run_after).toBeGreaterThan(first.run_after); // still advances with the new request
      expect(await q.stats()).toMatchObject({ loopover_jobs_coalesced_total: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not coalesce terminal pull_request events that carry distinct lifecycle side effects", async () => {
    const driver = makeDriver();
    const q = createSqliteQueue(driver, async () => undefined);
    await q.binding.send(prWebhook("closed-1", "closed"), { delaySeconds: 60 });
    await q.binding.send(prWebhook("closed-2", "closed"), { delaySeconds: 60 });
    expect(driver.query("SELECT COUNT(*) AS c FROM _selfhost_jobs", []).rows[0]).toMatchObject({ c: 2 });
  });

  it("spreads a due backlog on startup so restarts do not stampede GitHub", async () => {
    const oldMin = process.env.QUEUE_STARTUP_JITTER_MIN_JOBS;
    const oldJitter = process.env.QUEUE_STARTUP_JITTER_MS;
    process.env.QUEUE_STARTUP_JITTER_MIN_JOBS = "2";
    process.env.QUEUE_STARTUP_JITTER_MS = "60000";
    try {
      const driver = makeDriver();
      createSqliteQueue(driver, async () => undefined);
      driver.query(
        "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority) VALUES (?, 'pending', 0, 0, 0, 10)",
        [JSON.stringify(msg("unkeyed"))],
      );
      driver.query(
        "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key) VALUES (?, 'pending', 0, 0, 0, 10, ?)",
        [JSON.stringify(ciWebhook("ci-2", "check_run")), "k2"],
      );

      const before = Date.now();
      createSqliteQueue(driver, async () => undefined);

      const rows = driver.query(
        "SELECT run_after FROM _selfhost_jobs ORDER BY id",
        [],
      ).rows as Array<{ run_after: number }>;
      expect(rows.every((row) => row.run_after >= before)).toBe(true);
      expect(rows.some((row) => row.run_after > before)).toBe(true);
    } finally {
      if (oldMin === undefined) delete process.env.QUEUE_STARTUP_JITTER_MIN_JOBS;
      else process.env.QUEUE_STARTUP_JITTER_MIN_JOBS = oldMin;
      if (oldJitter === undefined) delete process.env.QUEUE_STARTUP_JITTER_MS;
      else process.env.QUEUE_STARTUP_JITTER_MS = oldJitter;
    }
  });

  it("does not spread a due backlog when startup jitter is disabled", async () => {
    const oldMin = process.env.QUEUE_STARTUP_JITTER_MIN_JOBS;
    const oldJitter = process.env.QUEUE_STARTUP_JITTER_MS;
    process.env.QUEUE_STARTUP_JITTER_MIN_JOBS = "2";
    process.env.QUEUE_STARTUP_JITTER_MS = "0";
    try {
      const driver = makeDriver();
      createSqliteQueue(driver, async () => undefined);
      for (const deliveryId of ["ci-1", "ci-2"]) {
        driver.query(
          "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key) VALUES (?, 'pending', 0, 0, 0, 10, ?)",
          [JSON.stringify(ciWebhook(deliveryId)), deliveryId],
        );
      }

      createSqliteQueue(driver, async () => undefined);

      const rows = driver.query("SELECT run_after FROM _selfhost_jobs ORDER BY id", []).rows as Array<{ run_after: number }>;
      expect(rows).toEqual([{ run_after: 0 }, { run_after: 0 }]);
    } finally {
      if (oldMin === undefined) delete process.env.QUEUE_STARTUP_JITTER_MIN_JOBS;
      else process.env.QUEUE_STARTUP_JITTER_MIN_JOBS = oldMin;
      if (oldJitter === undefined) delete process.env.QUEUE_STARTUP_JITTER_MS;
      else process.env.QUEUE_STARTUP_JITTER_MS = oldJitter;
    }
  });

  it("migrates an old queue table without a priority column before creating the claim index", async () => {
    const driver = makeDriver();
    driver.exec(`
      CREATE TABLE _selfhost_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        run_after INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_error TEXT
      );
    `);

    expect(() => createSqliteQueue(driver, async () => undefined)).not.toThrow();

    const { rows } = driver.query("PRAGMA table_info(_selfhost_jobs)", []);
    expect(rows.map((row) => (row as { name: string }).name)).toContain(
      "priority",
    );
    expect(
      driver.query("PRAGMA index_info(_selfhost_jobs_claim)", []).rows.map(
        (row) => (row as { name: string }).name,
      ),
    ).toEqual(["status", "priority", "claim_sort_key", "run_after"]);
  });

  it("rebuilds an old claim index so priority participates in future claims", async () => {
    const driver = makeDriver();
    driver.exec(`
      CREATE TABLE _selfhost_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        run_after INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_error TEXT
      );
      CREATE INDEX _selfhost_jobs_claim ON _selfhost_jobs(status, run_after);
    `);

    createSqliteQueue(driver, async () => undefined);

    expect(
      driver.query("PRAGMA index_info(_selfhost_jobs_claim)", []).rows.map(
        (row) => (row as { name: string }).name,
      ),
    ).toEqual(["status", "priority", "claim_sort_key", "run_after"]);
  });

  it("claims webhook work before regate work, and regate work before earlier background jobs", async () => {
    const driver = makeDriver();
    const seen: string[] = [];
    const q = createSqliteQueue(driver, async (m) => void seen.push(typeOf(m)), {
      concurrency: 1, // serial so the claim order is deterministic
    });
    // Inserted directly so BOTH are pending before any claim; the low one has the smaller id (enqueued earlier).
    driver.query(
      "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority) VALUES (?, 'pending', 0, 0, 0, 0)",
      [JSON.stringify(msg("rag-index-repo"))],
    );
    driver.query(
      "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority) VALUES (?, 'pending', 0, 0, 0, 9)",
      [JSON.stringify(msg("agent-regate-pr"))],
    );
    driver.query(
      "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority) VALUES (?, 'pending', 0, 0, 0, 8)",
      [JSON.stringify(msg("agent-regate-sweep"))],
    );
    driver.query(
      "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority) VALUES (?, 'pending', 0, 0, 0, 0)",
      [JSON.stringify(webhook({ login: "gittensory-orb[bot]", type: "Bot" }))],
    );
    driver.query(
      "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority) VALUES (?, 'pending', 0, 0, 0, 10)",
      [JSON.stringify(msg("github-webhook"))],
    );
    await q.drain();
    expect(seen).toEqual(["github-webhook", "agent-regate-pr", "agent-regate-sweep", "rag-index-repo", "github-webhook"]);
  });

  describe("claim-time backlog-vs-fresh-intake fairness (#selfhost-backlog-convergence)", () => {
    const backlogJob = (repo: string, prNumber: number, prCreatedAt?: string): JobMessage =>
      ({
        type: "agent-regate-pr",
        deliveryId: `backlog-convergence:${repo}#${prNumber}`,
        repoFullName: repo,
        prNumber,
        installationId: 1,
        ...(prCreatedAt ? { prCreatedAt } : {}),
      }) as unknown as JobMessage;

    it("prefers 3 backlog-lane claims for every 1 fresh-intake claim (default ratio), deterministically", async () => {
      const driver = makeDriver();
      const seen: string[] = [];
      const q = createSqliteQueue(driver, async (m) => void seen.push((m as unknown as { deliveryId: string }).deliveryId), { concurrency: 1 });
      await q.binding.send(backlogJob("owner/repo", 1));
      await q.binding.send(backlogJob("owner/repo", 2));
      await q.binding.send(backlogJob("owner/repo", 3));
      await q.binding.send(prWebhook("fresh-1"));
      await q.drain();
      expect(seen).toEqual([
        "backlog-convergence:owner/repo#1",
        "backlog-convergence:owner/repo#2",
        "backlog-convergence:owner/repo#3",
        "fresh-1",
      ]);
    });

    it("repeats the ratio cycle with one plain-priority slot per fairness window", async () => {
      const driver = makeDriver();
      const seen: string[] = [];
      const q = createSqliteQueue(driver, async (m) => void seen.push((m as unknown as { deliveryId: string }).deliveryId), { concurrency: 1 });
      for (let i = 1; i <= 6; i++) await q.binding.send(backlogJob("owner/repo", i));
      // Distinct head SHAs -- prWebhook's coalesce key is repo#pr@headSha, so two same-PR events with the
      // SAME default sha would coalesce into one row instead of two.
      await q.binding.send(prWebhook("fresh-1", "synchronize", "a".repeat(40)));
      await q.binding.send(prWebhook("fresh-2", "synchronize", "b".repeat(40)));
      await q.drain();
      expect(seen).toEqual([
        "backlog-convergence:owner/repo#1",
        "backlog-convergence:owner/repo#2",
        "backlog-convergence:owner/repo#3",
        "fresh-1",
        "fresh-2",
        "backlog-convergence:owner/repo#4",
        "backlog-convergence:owner/repo#5",
        "backlog-convergence:owner/repo#6",
      ]);
    });

    it("does not let a lower-priority classified lane starve a higher-priority manual regate", async () => {
      const driver = makeDriver();
      const seen: string[] = [];
      const q = createSqliteQueue(driver, async (m) => void seen.push((m as unknown as { deliveryId: string }).deliveryId), { concurrency: 1 });
      await q.binding.send({
        ...backlogJob("owner/repo", 1),
        deliveryId: "manual-regate:owner/repo#1:operator",
      } as JobMessage);
      await q.binding.send(backlogJob("owner/repo", 2));
      await q.drain();
      expect(seen).toEqual(["manual-regate:owner/repo#1:operator", "backlog-convergence:owner/repo#2"]);
    });

    it("falls through to the plain unscoped foreground claim when the preferred lane has nothing pending", async () => {
      const driver = makeDriver();
      const seen: string[] = [];
      const q = createSqliteQueue(driver, async (m) => void seen.push((m as unknown as { deliveryId?: string; type: string }).deliveryId ?? typeOf(m)), { concurrency: 1 });
      // Sequence 0 prefers "backlog", but only a "fresh" row is pending — must not stall behind an empty lane.
      await q.binding.send(prWebhook("fresh-only"));
      await q.drain();
      expect(seen).toEqual(["fresh-only"]);
    });

    it("rotates the backlog lane across repos so one repo's deep backlog cannot starve another's (per-repo fairness)", async () => {
      const driver = makeDriver();
      const seen: string[] = [];
      const q = createSqliteQueue(driver, async (m) => void seen.push((m as unknown as { deliveryId?: string; type: string }).deliveryId ?? typeOf(m)), { concurrency: 1 });
      // owner/a has 3 pending backlog rows, all older than owner/b's 1 row -- owner/a would win on pure
      // staleness EVERY time if rotation didn't exclude the just-served repo.
      const rows: Array<{ repo: string; prNumber: number; createdAt: number }> = [
        { repo: "owner/a", prNumber: 1, createdAt: 1000 },
        { repo: "owner/a", prNumber: 2, createdAt: 1500 },
        { repo: "owner/a", prNumber: 3, createdAt: 2000 },
        { repo: "owner/b", prNumber: 1, createdAt: 5000 },
      ];
      for (const { repo, prNumber, createdAt } of rows) {
        driver.query(
          "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key, foreground_lane) VALUES (?, 'pending', 0, 0, ?, 9, ?, 'backlog')",
          [JSON.stringify(backlogJob(repo, prNumber)), createdAt, `agent-regate-pr:${repo}#${prNumber}`],
        );
      }
      await q.drain();
      // owner/a (stalest) claimed first; rotation then forces owner/b even though owner/a is STILL stalest;
      // owner/b then has nothing left, so the round-robin falls back to owner/a (the only remaining candidate).
      expect(seen).toEqual([
        "backlog-convergence:owner/a#1",
        "backlog-convergence:owner/b#1",
        "backlog-convergence:owner/a#2",
        "backlog-convergence:owner/a#3",
      ]);
    });

    it("REGRESSION: drains one repo's backlog-convergence PR jobs by original PR age, not enqueue timing", async () => {
      const driver = makeDriver();
      const seen: string[] = [];
      const q = createSqliteQueue(driver, async (m) => void seen.push((m as unknown as { deliveryId: string }).deliveryId), { concurrency: 1 });
      await q.binding.send(backlogJob("owner/repo", 12, "2026-07-03T12:00:00.000Z"), { delaySeconds: 60 });
      await q.binding.send(backlogJob("owner/repo", 10, "2026-07-03T10:00:00.000Z"), { delaySeconds: 60 });
      await q.binding.send(backlogJob("owner/repo", 11, "2026-07-03T11:00:00.000Z"), { delaySeconds: 60 });
      driver.query("UPDATE _selfhost_jobs SET run_after=0", []);

      await q.drain();

      expect(seen).toEqual([
        "backlog-convergence:owner/repo#10",
        "backlog-convergence:owner/repo#11",
        "backlog-convergence:owner/repo#12",
      ]);
    });

    it("backfills stale claim-sort keys and skips rows that already match the derived key", async () => {
      const driver = makeDriver();
      createSqliteQueue(driver, async () => undefined, { concurrency: 1 }); // create the durable schema first
      const stale = backlogJob("owner/repo", 12, "2026-07-03T12:00:00.000Z");
      const normalized = backlogJob("owner/repo", 13, "2026-07-03T13:00:00.000Z");
      driver.query(
        "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key, foreground_lane, claim_sort_key) VALUES (?, 'pending', 0, 0, ?, 9, ?, 'backlog', 0)",
        [
          JSON.stringify(stale),
          1,
          "agent-regate-pr:owner/repo#12",
        ],
      );
      driver.query(
        "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key, foreground_lane, claim_sort_key) VALUES (?, 'pending', 0, 0, ?, 9, ?, 'backlog', ?)",
        [
          JSON.stringify(normalized),
          1,
          "agent-regate-pr:owner/repo#13",
          Date.parse("2026-07-03T13:00:00.000Z"),
        ],
      );

      createSqliteQueue(driver, async () => undefined, { concurrency: 1 }); // startup backfill pass

      const rows = driver.query("SELECT job_key, claim_sort_key FROM _selfhost_jobs ORDER BY job_key", []).rows as Array<{ job_key: string; claim_sort_key: number }>;
      expect(rows).toEqual([
        { job_key: "agent-regate-pr:owner/repo#12", claim_sort_key: Date.parse("2026-07-03T12:00:00.000Z") },
        { job_key: "agent-regate-pr:owner/repo#13", claim_sort_key: Date.parse("2026-07-03T13:00:00.000Z") },
      ]);
    });

    it("REGRESSION: does not claim a duplicate PR re-gate while the same job_key is already processing", async () => {
      const driver = makeDriver();
      const seen: string[] = [];
      const q = createSqliteQueue(driver, async (m) => void seen.push((m as unknown as { deliveryId: string }).deliveryId), { concurrency: 1 });
      const now = Date.now();
      driver.query(
        "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key, foreground_lane, claim_sort_key) VALUES (?, 'processing', 0, ?, ?, 9, ?, 'backlog', ?)",
        [
          JSON.stringify(backlogJob("owner/repo", 10, "2026-07-03T10:00:00.000Z")),
          now,
          now,
          "agent-regate-pr:owner/repo#10",
          Date.parse("2026-07-03T10:00:00.000Z"),
        ],
      );
      driver.query(
        "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key, foreground_lane, claim_sort_key) VALUES (?, 'pending', 0, 0, ?, 9, ?, 'backlog', ?)",
        [
          JSON.stringify(backlogJob("owner/repo", 10, "2026-07-03T10:00:00.000Z")),
          now,
          "agent-regate-pr:owner/repo#10",
          Date.parse("2026-07-03T10:00:00.000Z"),
        ],
      );
      driver.query(
        "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key, foreground_lane, claim_sort_key) VALUES (?, 'pending', 0, 0, ?, 9, ?, 'backlog', ?)",
        [
          JSON.stringify(backlogJob("owner/repo", 11, "2026-07-03T11:00:00.000Z")),
          now,
          "agent-regate-pr:owner/repo#11",
          Date.parse("2026-07-03T11:00:00.000Z"),
        ],
      );

      await q.drain();

      expect(seen).toEqual(["backlog-convergence:owner/repo#11"]);
      const duplicate = driver.query(
        "SELECT status FROM _selfhost_jobs WHERE job_key=? ORDER BY id DESC LIMIT 1",
        ["agent-regate-pr:owner/repo#10"],
      ).rows[0] as { status: string };
      expect(duplicate.status).toBe("pending");
    });

    it("defaults the claim sequence to 0 when the fairness singleton row is missing (defensive, never crashes)", async () => {
      const driver = makeDriver();
      const seen: string[] = [];
      const q = createSqliteQueue(driver, async (m) => void seen.push((m as unknown as { deliveryId: string }).deliveryId), { concurrency: 1 });
      driver.query("DELETE FROM _selfhost_queue_fairness WHERE id='singleton'", []);
      await q.binding.send(backlogJob("owner/repo", 1));
      await q.drain();
      expect(seen).toEqual(["backlog-convergence:owner/repo#1"]);
    });

    it("falls through gracefully when the picked repo's candidate row can't actually be claimed (defensive)", async () => {
      const driver = makeDriver();
      const seen: string[] = [];
      const q = createSqliteQueue(driver, async (m) => void seen.push((m as unknown as { deliveryId: string }).deliveryId), { concurrency: 1 });
      // A malformed/legacy row: tagged foreground_lane='backlog' (so it shows up as a fairness candidate) but
      // its priority sits BELOW the foreground floor -- the fairness-scoped claim's priority filter excludes
      // it, so pickBacklogRepo's chosen repo yields no row. Falls through to the background lane instead of
      // stalling foreground claims.
      driver.query(
        "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key, foreground_lane) VALUES (?, 'pending', 0, 0, 1000, 0, ?, 'backlog')",
        [JSON.stringify(backlogJob("owner/repo", 1)), "agent-regate-pr:owner/repo#1"],
      );
      await q.drain();
      expect(seen).toEqual(["backlog-convergence:owner/repo#1"]);
    });

    it("backfills the foreground_lane column on startup for jobs enqueued by an older version", async () => {
      const driver = nodeSqliteDriver(new DatabaseSync(":memory:") as never);
      driver.exec(`
        CREATE TABLE _selfhost_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          run_after INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          last_error TEXT,
          priority INTEGER NOT NULL DEFAULT 0,
          job_key TEXT
        );
      `);
      driver.query(
        "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority) VALUES (?, 'pending', 0, 0, 0, 10)",
        [JSON.stringify(prWebhook("legacy-fresh"))],
      );
      createSqliteQueue(driver, async () => undefined);
      const row = driver.query("SELECT foreground_lane FROM _selfhost_jobs", []).rows[0] as { foreground_lane: string | null };
      expect(row.foreground_lane).toBe("fresh");
    });

    it("increments the lane-claim counter on a successful backlog-lane claim (#selfhost-lane-observability)", async () => {
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined, { concurrency: 1 });
      await q.binding.send(backlogJob("owner/repo", 1));
      await q.drain();
      expect(await renderMetrics()).toContain('loopover_jobs_claimed_by_lane_total{lane="backlog"} 1');
      expect(await renderMetrics()).not.toContain('lane="fresh"');
    });

    it("increments the lane-claim counter on a successful fresh-intake claim (#selfhost-lane-observability)", async () => {
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined, { concurrency: 1 });
      // Sequence 0/1/2 prefer "backlog" (default 3:1 ratio) -- pre-populate 3 backlog rows so those claims
      // actually hit the backlog-scoped branch, THEN sequence 3 prefers "fresh" and the fresh row is pending,
      // so the scoped fresh claim itself (not the unscoped fallback) is what claims it.
      await q.binding.send(backlogJob("owner/repo", 1));
      await q.binding.send(backlogJob("owner/repo", 2));
      await q.binding.send(backlogJob("owner/repo", 3));
      await q.binding.send(prWebhook("fresh-1"));
      await q.drain();
      expect(await renderMetrics()).toContain('loopover_jobs_claimed_by_lane_total{lane="fresh"} 1');
      expect(await renderMetrics()).toContain('loopover_jobs_claimed_by_lane_total{lane="backlog"} 3');
    });

    it("does NOT increment the lane-claim counter when the preferred lane has nothing pending (falls through unscoped)", async () => {
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined, { concurrency: 1 });
      // Sequence 0 prefers "backlog", but only a "fresh" row is pending -- the backlog-scoped claim misses (no
      // increment) and the row is claimed via the PLAIN UNSCOPED fallback (claimNext()'s own `??`), not via
      // claimNextForegroundLane's "fresh" branch -- so NEITHER lane value is recorded for this claim.
      await q.binding.send(prWebhook("fresh-only"));
      await q.drain();
      expect(await renderMetrics()).not.toContain("loopover_jobs_claimed_by_lane_total");
    });

    it("does NOT increment the lane-claim counter when the picked repo's candidate row can't actually be claimed (defensive)", async () => {
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined, { concurrency: 1 });
      driver.query(
        "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key, foreground_lane) VALUES (?, 'pending', 0, 0, 1000, 0, ?, 'backlog')",
        [JSON.stringify(backlogJob("owner/repo", 1)), "agent-regate-pr:owner/repo#1"],
      );
      await q.drain();
      expect(await renderMetrics()).not.toContain("loopover_jobs_claimed_by_lane_total");
    });
  });

  describe("topBacklogRepos (#selfhost-lane-observability)", () => {
    const backlogJob = (repo: string, prNumber: number): JobMessage =>
      ({
        type: "agent-regate-pr",
        deliveryId: `backlog-convergence:${repo}#${prNumber}`,
        repoFullName: repo,
        prNumber,
        installationId: 1,
      }) as unknown as JobMessage;

    it("returns an empty array when no backlog-lane row is pending", async () => {
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined);
      expect(await q.topBacklogRepos(10)).toEqual([]);
    });

    it("counts pending AND processing backlog-lane rows, grouped by repo, sorted by depth", async () => {
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined);
      const rows: Array<{ repo: string; prNumber: number; status: string }> = [
        { repo: "owner/a", prNumber: 1, status: "pending" },
        { repo: "owner/b", prNumber: 1, status: "pending" },
        { repo: "owner/b", prNumber: 2, status: "processing" },
        { repo: "owner/b", prNumber: 3, status: "pending" },
      ];
      for (const { repo, prNumber, status } of rows) {
        driver.query(
          `INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key, foreground_lane) VALUES (?, ?, 0, 0, 1000, 9, ?, 'backlog')`,
          [JSON.stringify(backlogJob(repo, prNumber)), status, `agent-regate-pr:${repo}#${prNumber}`],
        );
      }
      expect(await q.topBacklogRepos(10)).toEqual([
        { repo: "owner/b", count: 3 },
        { repo: "owner/a", count: 1 },
      ]);
    });

    it("excludes fresh-lane and unclassified rows, and honors the limit", async () => {
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined);
      driver.query(
        "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, foreground_lane) VALUES (?, 'pending', 0, 0, 1000, 10, 'fresh')",
        [JSON.stringify(prWebhook("fresh-1"))],
      );
      for (const repo of ["owner/a", "owner/b", "owner/c"]) {
        driver.query(
          "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key, foreground_lane) VALUES (?, 'pending', 0, 0, 1000, 9, ?, 'backlog')",
          [JSON.stringify(backlogJob(repo, 1)), `agent-regate-pr:${repo}#1`],
        );
      }
      expect(await q.topBacklogRepos(2)).toHaveLength(2);
    });

    it("excludes a terminal (dead/cancelled) backlog-lane row", async () => {
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined);
      driver.query(
        "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key, foreground_lane) VALUES (?, 'dead', 0, 0, 1000, 9, ?, 'backlog')",
        [JSON.stringify(backlogJob("owner/repo", 1)), "agent-regate-pr:owner/repo#1"],
      );
      expect(await q.topBacklogRepos(10)).toEqual([]);
    });
  });

  describe("listDeadLetterJobs (#2214)", () => {
    it("returns an empty array when there are no dead-letter rows", async () => {
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined);
      expect(await q.listDeadLetterJobs(10, 0)).toEqual([]);
    });

    it("maps dead rows newest-death-first, extracting job type/attempts/error, and excludes non-dead rows", async () => {
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined);
      driver.query(
        "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, last_error, dead_at) VALUES (?, 'dead', 3, 0, 1000, 'boom', 5000)",
        [JSON.stringify(msg("agent-regate-pr"))],
      );
      driver.query(
        "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, last_error, dead_at) VALUES (?, 'dead', 1, 0, 2000, 'kaboom', 9000)",
        [JSON.stringify(msg("github-webhook"))],
      );
      driver.query(
        "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at) VALUES (?, 'pending', 0, 0, 500)",
        [JSON.stringify(msg("agent-regate-sweep"))],
      );
      expect(await q.listDeadLetterJobs(10, 0)).toEqual([
        { id: 2, jobType: "github-webhook", attempts: 1, lastError: "kaboom", createdAtMs: 2000, deadAtMs: 9000 },
        { id: 1, jobType: "agent-regate-pr", attempts: 3, lastError: "boom", createdAtMs: 1000, deadAtMs: 5000 },
      ]);
    });

    it("falls back to created_at ordering and reports deadAtMs null for a legacy row with no dead_at", async () => {
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined);
      // Legacy row: no dead_at, but its created_at (7000) is newer than the other row's real dead_at (3000) --
      // COALESCE(dead_at, created_at) must use 7000 here, so this row sorts FIRST despite having a null deadAtMs.
      driver.query(
        "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, last_error) VALUES (?, 'dead', 2, 0, 7000, 'legacy failure')",
        [JSON.stringify(msg("agent-regate-pr"))],
      );
      driver.query(
        "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, last_error, dead_at) VALUES (?, 'dead', 1, 0, 1000, 'recent failure', 3000)",
        [JSON.stringify(msg("agent-regate-pr"))],
      );
      expect(await q.listDeadLetterJobs(10, 0)).toEqual([
        { id: 1, jobType: "agent-regate-pr", attempts: 2, lastError: "legacy failure", createdAtMs: 7000, deadAtMs: null },
        { id: 2, jobType: "agent-regate-pr", attempts: 1, lastError: "recent failure", createdAtMs: 1000, deadAtMs: 3000 },
      ]);
    });

    it("reports jobType 'unknown' for an unparseable payload", async () => {
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined);
      driver.query(
        "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, last_error, dead_at) VALUES ('not-json', 'dead', 0, 0, 1000, 'unparseable payload', 1000)",
        [],
      );
      expect(await q.listDeadLetterJobs(10, 0)).toEqual([
        { id: 1, jobType: "unknown", attempts: 0, lastError: "unparseable payload", createdAtMs: 1000, deadAtMs: 1000 },
      ]);
    });

    it("paginates via limit/offset", async () => {
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined);
      for (let i = 0; i < 3; i++) {
        driver.query(
          "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, dead_at) VALUES (?, 'dead', 0, 0, ?, ?)",
          [JSON.stringify(msg("agent-regate-pr")), 1000 + i, 1000 + i],
        );
      }
      expect((await q.listDeadLetterJobs(1, 1)).map((job) => job.createdAtMs)).toEqual([1001]);
    });
  });

  describe("replay/delete/purge dead-letter jobs (#2215)", () => {
    it("replayDeadLetterJob requeues an existing dead row with a fresh retry budget", async () => {
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined);
      driver.query(
        "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, last_error, dead_at) VALUES (?, 'dead', 3, 0, 1000, 'boom', 5000)",
        [JSON.stringify(msg("agent-regate-pr"))],
      );
      expect(await q.replayDeadLetterJob(1)).toBe(true);
      const row = driver.query("SELECT status, attempts, last_error, dead_at, run_after FROM _selfhost_jobs WHERE id=1", [])
        .rows[0] as { status: string; attempts: number; last_error: string | null; dead_at: number | null; run_after: number };
      expect(row.status).toBe("pending");
      expect(row.attempts).toBe(0);
      expect(row.last_error).toBeNull();
      expect(row.dead_at).toBeNull();
      expect(row.run_after).toBeGreaterThan(0);
    });

    it("replayDeadLetterJob returns false for a non-existent id", async () => {
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined);
      expect(await q.replayDeadLetterJob(999)).toBe(false);
    });

    it("replayDeadLetterJob returns false and leaves a non-dead row untouched", async () => {
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined);
      driver.query(
        "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at) VALUES (?, 'pending', 0, 42, 1000)",
        [JSON.stringify(msg("agent-regate-pr"))],
      );
      expect(await q.replayDeadLetterJob(1)).toBe(false);
      const row = driver.query("SELECT status, run_after FROM _selfhost_jobs WHERE id=1", []).rows[0] as {
        status: string;
        run_after: number;
      };
      expect(row.status).toBe("pending");
      expect(row.run_after).toBe(42);
    });

    it("deleteDeadLetterJob removes an existing dead row", async () => {
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined);
      driver.query(
        "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, dead_at) VALUES (?, 'dead', 1, 0, 1000, 1000)",
        [JSON.stringify(msg("agent-regate-pr"))],
      );
      expect(await q.deleteDeadLetterJob(1)).toBe(true);
      expect(driver.query("SELECT id FROM _selfhost_jobs WHERE id=1", []).rows).toEqual([]);
    });

    it("deleteDeadLetterJob returns false for a non-existent id", async () => {
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined);
      expect(await q.deleteDeadLetterJob(999)).toBe(false);
    });

    it("deleteDeadLetterJob returns false and does not delete a non-dead row", async () => {
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined);
      driver.query(
        "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at) VALUES (?, 'processing', 0, 0, 1000)",
        [JSON.stringify(msg("agent-regate-pr"))],
      );
      expect(await q.deleteDeadLetterJob(1)).toBe(false);
      expect(driver.query("SELECT id FROM _selfhost_jobs WHERE id=1", []).rows).toHaveLength(1);
    });

    it("purgeDeadLetterJobs deletes every dead row and leaves non-dead rows untouched", async () => {
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined);
      for (let i = 0; i < 3; i++) {
        driver.query(
          "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, dead_at) VALUES (?, 'dead', 0, 0, ?, ?)",
          [JSON.stringify(msg("agent-regate-pr")), 1000 + i, 1000 + i],
        );
      }
      driver.query(
        "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at) VALUES (?, 'pending', 0, 0, 2000)",
        [JSON.stringify(msg("agent-regate-pr"))],
      );
      driver.query(
        "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at) VALUES (?, 'processing', 0, 0, 3000)",
        [JSON.stringify(msg("agent-regate-pr"))],
      );
      expect(await q.purgeDeadLetterJobs()).toBe(3);
      expect((driver.query("SELECT COUNT(*) AS c FROM _selfhost_jobs WHERE status='dead'", []).rows[0] as { c: number }).c).toBe(0);
      expect((driver.query("SELECT COUNT(*) AS c FROM _selfhost_jobs WHERE status!='dead'", []).rows[0] as { c: number }).c).toBe(2);
    });

    it("purgeDeadLetterJobs returns 0 and touches nothing when there are no dead rows", async () => {
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined);
      driver.query(
        "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at) VALUES (?, 'pending', 0, 0, 1000)",
        [JSON.stringify(msg("agent-regate-pr"))],
      );
      expect(await q.purgeDeadLetterJobs()).toBe(0);
      expect((driver.query("SELECT COUNT(*) AS c FROM _selfhost_jobs", []).rows[0] as { c: number }).c).toBe(1);
    });
  });

  it("retries then dead-letters after maxRetries", async () => {
    const driver = makeDriver();
    let calls = 0;
    const q = createSqliteQueue(
      driver,
      async () => {
        calls += 1;
        throw new Error("boom");
      },
      { maxRetries: 3, backoffMs: () => 0 },
    );
    await q.binding.send(msg("x"));
    await q.drain(); // backoff 0 → all 3 attempts run within one drain, then dead-lettered
    expect(calls).toBe(3);
    expect(await q.deadCount()).toBe(1);
    expect(await q.size()).toBe(0);
    // #2214: a max-retries death also stamps dead_at, so the DLQ table can sort/report a real death time.
    const [row] = await q.listDeadLetterJobs(10, 0);
    expect(row).toMatchObject({ jobType: "x", attempts: 3, lastError: "boom" });
    expect(row!.deadAtMs).not.toBeNull();
  });

  describe("reviveDeadLetterJobs (#audit-rate-headroom)", () => {
    beforeEach(() => {
      // Deterministic zero jitter so a revived job's run_after is exactly "now" -- otherwise
      // deterministicJitterMs's (up to 60s default) spread makes it not-yet-due for drain()/the poll
      // tick in these tests. Mirrors the existing recoverProcessingJobs test convention in this file.
      process.env.QUEUE_RECOVERY_JITTER_MS = "0";
    });
    afterEach(() => {
      delete process.env.QUEUE_RECOVERY_JITTER_MS;
      delete process.env.QUEUE_DEAD_LETTER_AUTO_RETRY_MAX_EXTRA_ATTEMPTS;
      delete process.env.QUEUE_DEAD_LETTER_REVIVE_INTERVAL_MS;
    });

    it("requeues a dead job under the auto-retry ceiling and clears its last_error", async () => {
      process.env.QUEUE_DEAD_LETTER_AUTO_RETRY_MAX_EXTRA_ATTEMPTS = "2";
      const driver = makeDriver();
      let calls = 0;
      const q = createSqliteQueue(
        driver,
        async () => {
          calls += 1;
          throw new Error("boom");
        },
        { maxRetries: 1, backoffMs: () => 0 },
      );
      await q.binding.send(msg("x"));
      await q.drain(); // dies at attempts=1 (maxRetries=1)
      expect(await q.deadCount()).toBe(1);
      calls = 0;

      const revived = await q.reviveDeadLetterJobs();

      expect(revived).toBe(1);
      const { rows } = driver.query("SELECT status, attempts, last_error FROM _selfhost_jobs", []);
      const row = rows[0] as { status: string; attempts: number; last_error: string | null };
      // With zero jitter the revived job is immediately due, so kickAll()'s synchronous claim step may have
      // already advanced it past 'pending' to 'processing' by the time this assertion runs -- either is
      // correct proof of revival; only 'dead' would indicate the revival didn't happen.
      expect(row.status).not.toBe("dead");
      expect(row.attempts).toBe(1); // untouched -- one more failure re-dead-letters it, not a fresh budget
      expect(row.last_error).toBeNull();
      // #2214: dead_at is cleared on revival too, so a re-dead-lettered job gets a fresh death timestamp
      // instead of reporting when it FIRST died.
      const { rows: deadAtRows } = driver.query("SELECT dead_at FROM _selfhost_jobs", []);
      expect((deadAtRows[0] as { dead_at: number | null }).dead_at).toBeNull();

      await q.drain(); // the one extra attempt the revival granted
      expect(calls).toBe(1);
      expect(await q.deadCount()).toBe(1); // failed again -- back to dead, attempts now 2
    });

    it("stops reviving a job once it reaches the auto-retry ceiling (maxRetries + extra attempts)", async () => {
      process.env.QUEUE_DEAD_LETTER_AUTO_RETRY_MAX_EXTRA_ATTEMPTS = "1";
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => { throw new Error("boom"); }, { maxRetries: 1, backoffMs: () => 0 });
      await q.binding.send(msg("x"));
      await q.drain(); // attempts=1, dead (ceiling = maxRetries(1) + extra(1) = 2)

      expect(await q.reviveDeadLetterJobs()).toBe(1); // attempts(1) < ceiling(2) -- eligible
      await q.drain(); // fails again -- attempts=2, dead again

      expect(await q.reviveDeadLetterJobs()).toBe(0); // attempts(2) is NOT < ceiling(2) -- exhausted, stays dead
      expect(await q.deadCount()).toBe(1);
    });

    it("is a no-op when there are no dead jobs", async () => {
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined);
      expect(await q.reviveDeadLetterJobs()).toBe(0);
    });

    // REGRESSION (#2581 review defect, parity with the same fix in pg-queue.ts): the SELECT that finds eligible
    // dead jobs is a stale snapshot. Without an "AND status='dead'" re-check on the UPDATE, a row that stops
    // being 'dead' between the SELECT and this row's own UPDATE (e.g. claimed by an overlapping revive/process)
    // would get silently flipped back to 'pending' regardless of its CURRENT status, letting it run a second
    // time concurrently. Engineered here via a driver.query spy that injects the status change at the exact
    // point the real revive UPDATE would otherwise race against it.
    it("does not flip a row back to pending if it stops being 'dead' between the SELECT and its own UPDATE", async () => {
      const driver = makeDriver();
      const realQuery = driver.query.bind(driver);
      const q = createSqliteQueue(driver, async () => { throw new Error("boom"); }, { maxRetries: 1, backoffMs: () => 0 });
      await q.binding.send(msg("x"));
      await q.drain(); // dies at attempts=1 (maxRetries=1)
      expect(await q.deadCount()).toBe(1);

      vi.spyOn(driver, "query").mockImplementation((sql: string, params: unknown[]) => {
        if (sql.includes("SET status='pending', run_after=?, last_error=NULL")) {
          realQuery(`UPDATE _selfhost_jobs SET status='processing' WHERE id=?`, [params[1] as number]);
        }
        return realQuery(sql, params);
      });

      const revived = await q.reviveDeadLetterJobs();

      expect(revived).toBe(0); // the UPDATE's "AND status='dead'" matched zero rows -- not counted as revived
      const { rows } = driver.query("SELECT status FROM _selfhost_jobs", []);
      expect((rows[0] as { status: string }).status).toBe("processing"); // untouched, NOT reverted to pending
    });

    it("runs automatically on the configured revive interval while the queue is running", async () => {
      process.env.QUEUE_DEAD_LETTER_REVIVE_INTERVAL_MS = "1000";
      vi.useFakeTimers();
      const driver = makeDriver();
      let calls = 0;
      const q = createSqliteQueue(
        driver,
        async () => {
          calls += 1;
          throw new Error("boom");
        },
        { maxRetries: 1, backoffMs: () => 0, pollIntervalMs: 50 },
      );
      await q.binding.send(msg("x"));
      await vi.advanceTimersByTimeAsync(200); // dies at attempts=1
      expect(await q.deadCount()).toBe(1);
      calls = 0;

      q.start();
      await vi.advanceTimersByTimeAsync(1000); // the revive interval fires once
      await vi.advanceTimersByTimeAsync(200); // the poll tick picks up the revived job

      expect(calls).toBe(1); // the auto-revived job was actually re-attempted
      await q.stop();
    });

    // REGRESSION (#2581 review defect): the revive interval had no error handler of its own, so a thrown
    // driver/metric failure on that tick would surface as an uncaught exception and could terminate the
    // process -- exactly the failure mode pump()'s own try/catch already guards against for the main poll loop.
    it("survives a reviveDeadLetterJobs() driver failure on the interval tick instead of crashing the process", async () => {
      process.env.QUEUE_DEAD_LETTER_REVIVE_INTERVAL_MS = "1000";
      vi.useFakeTimers();
      const driver = makeDriver();
      const realQuery = driver.query.bind(driver);
      vi.spyOn(driver, "query").mockImplementation((sql: string, params: unknown[]) => {
        if (sql.includes("WHERE status='dead' AND attempts<?")) throw new Error("disk I/O error");
        return realQuery(sql, params);
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const q = createSqliteQueue(driver, async () => undefined, { maxRetries: 1 });

      q.start();
      await vi.advanceTimersByTimeAsync(1000); // the revive interval fires once -- would throw here if uncaught

      const logged = errorSpy.mock.calls.map(([line]) => String(line));
      expect(logged.some((line) => line.includes("selfhost_queue_dead_letter_revive_crashed") && line.includes("disk I/O error"))).toBe(true);
      await q.stop();
    });

    // (#1824): dead-letter revival stopping SILENTLY is worse than one throwing tick -- a Sentry cron monitor
    // now wraps every tick so a stopped timer shows up as a missed check-in, not silence.
    it("wraps each revive tick in the queue-dead-letter-revive Sentry monitor", async () => {
      process.env.QUEUE_DEAD_LETTER_REVIVE_INTERVAL_MS = "1000";
      vi.useFakeTimers();
      const monitorSpy = vi.spyOn(sentryModule, "withSentryMonitor");
      try {
        const driver = makeDriver();
        const q = createSqliteQueue(driver, async () => undefined, { maxRetries: 1 });

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
      }
    });

    // The monitor rethrows on failure (withSentryMonitor's own contract) -- confirms that rethrow is still caught
    // by reviveDeadLetterJobsSafely's own try/catch, so a crashing tick behaves exactly as it did before the
    // monitor was added: logged + captured, never an uncaught exception.
    it("still catches a revive crash after adding the Sentry monitor wrapper (no regression on #2581)", async () => {
      process.env.QUEUE_DEAD_LETTER_REVIVE_INTERVAL_MS = "1000";
      vi.useFakeTimers();
      const monitorSpy = vi.spyOn(sentryModule, "withSentryMonitor");
      try {
        const driver = makeDriver();
        const realQuery = driver.query.bind(driver);
        vi.spyOn(driver, "query").mockImplementation((sql: string, params: unknown[]) => {
          if (sql.includes("WHERE status='dead' AND attempts<?")) throw new Error("disk I/O error");
          return realQuery(sql, params);
        });
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const q = createSqliteQueue(driver, async () => undefined, { maxRetries: 1 });

        q.start();
        await vi.advanceTimersByTimeAsync(1000);

        expect(monitorSpy).toHaveBeenCalledWith(
          "queue-dead-letter-revive",
          { jobType: "queue-dead-letter-revive" },
          expect.any(Function),
        );
        const logged = errorSpy.mock.calls.map(([line]) => String(line));
        expect(logged.some((line) => line.includes("selfhost_queue_dead_letter_revive_crashed") && line.includes("disk I/O error"))).toBe(true);
        await q.stop();
      } finally {
        monitorSpy.mockRestore();
      }
    });
  });

  describe("releaseStaleForegroundDeferrals (#selfhost-queue-liveness)", () => {
    afterEach(() => {
      delete process.env.FOREGROUND_LIVENESS_ENABLED;
      delete process.env.FOREGROUND_LIVENESS_MAX_DEFER_MS;
      delete process.env.FOREGROUND_LIVENESS_MAX_RELEASE_PER_SWEEP;
    });

    /** Directly inserts a foreground-priority (>=8 by default) pending row with an explicit created_at/run_after,
     *  bypassing enqueue()'s own jitter/coalescing so the row's age and deferral are fully deterministic. Uses
     *  "recapture-preview" by default -- a foreground type NOT in GITHUB_BUDGET_BACKGROUND_TYPES and not
     *  "github-webhook"/"agent-regate-pr", so githubRateLimitAdmissionTargetForJob returns null for it and the
     *  rate-limit-clear condition (isRateLimitAdmissionNowClear) is trivially/always true for these rows --
     *  isolating the AGE-based condition cleanly for tests that aren't specifically about rate-limit clearing. */
    function seedForegroundPendingRow(
      driver: ReturnType<typeof makeDriver>,
      opts: { createdAt: number; runAfter: number; priority?: number; type?: string },
    ): void {
      driver.query(
        `INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key, is_maintenance)
         VALUES (?, 'pending', 0, ?, ?, ?, NULL, 0)`,
        [
          JSON.stringify({ type: opts.type ?? "recapture-preview", deliveryId: `seed:${opts.createdAt}`, repoFullName: "o/r", prNumber: 1, attempt: 1 }),
          opts.runAfter,
          opts.createdAt,
          opts.priority ?? 9,
        ],
      );
    }

    /** Creates github_rate_limit_observations (mirrors the existing "pre-yields ..." tests' inline DDL) and seeds
     *  ONE exhausted observation for the given admission key, so isRateLimitAdmissionNowClear() genuinely returns
     *  false for a job routed to that key -- letting a test isolate the AGE-only release condition even for a
     *  rate-limit-tracked job type (github-webhook / agent-regate-pr). */
    function seedExhaustedRateLimitObservation(
      driver: ReturnType<typeof makeDriver>,
      admissionKey: string,
      resetAtIso: string,
    ): void {
      driver.query(
        `CREATE TABLE IF NOT EXISTS github_rate_limit_observations (
          id TEXT PRIMARY KEY,
          repo_full_name TEXT NOT NULL,
          admission_key TEXT,
          resource TEXT NOT NULL,
          path TEXT NOT NULL,
          status_code INTEGER NOT NULL,
          limit_value INTEGER,
          remaining INTEGER,
          reset_at TEXT,
          observed_at TEXT NOT NULL
        )`,
        [],
      );
      driver.query(
        `INSERT INTO github_rate_limit_observations (id, repo_full_name, admission_key, resource, path, status_code, limit_value, remaining, reset_at, observed_at)
         VALUES (?, 'o/r', ?, 'rest', '/x', 200, 5000, 1, ?, ?)`,
        [`rl-${admissionKey}`, admissionKey, resetAtIso, new Date().toISOString()],
      );
    }

    it("releases a foreground-priority pending row deferred far into the future once its created_at is stale", async () => {
      process.env.FOREGROUND_LIVENESS_MAX_DEFER_MS = "60000"; // 1m (parsePositiveIntEnv floor)
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined);
      const now = Date.now();
      seedForegroundPendingRow(driver, { createdAt: now - 5 * 60_000, runAfter: now + 60 * 60_000 });

      const released = await q.releaseStaleForegroundDeferrals();

      expect(released).toBe(1);
      const row = driver.query("SELECT run_after FROM _selfhost_jobs", []).rows[0] as { run_after: number };
      expect(row.run_after).toBeLessThanOrEqual(Date.now());
      expect(await renderMetrics()).toContain("loopover_jobs_foreground_liveness_released_total 1");
    });

    // Isolates the AGE condition from the OR'd rate-limit-clear condition: uses a github-webhook row (which IS
    // rate-limit-tracked) with a genuinely exhausted, still-future-reset observation for its admission key, so
    // isRateLimitAdmissionNowClear() returns false and only the age check governs release.
    it("does NOT release a foreground row whose created_at is still recent (not yet stale) AND is still genuinely rate-limited", async () => {
      process.env.FOREGROUND_LIVENESS_MAX_DEFER_MS = "600000"; // default 10m
      const driver = makeDriver();
      const now = Date.now();
      // Keyed to installation:123, matching the job's own payload.installation.id below -- githubRateLimitAdmissionKeyForJob
      // only resolves an admission key for a github-webhook job from payload.installation.id (an unkeyed webhook
      // payload resolves to a null admissionKey, which this exact/fallback-keyed observation would NOT match).
      seedExhaustedRateLimitObservation(driver, "installation:123", new Date(now + 30 * 60_000).toISOString());
      const q = createSqliteQueue(driver, async () => undefined);
      const futureRunAfter = now + 60 * 60_000;
      driver.query(
        `INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key, is_maintenance)
         VALUES (?, 'pending', 0, ?, ?, 10, NULL, 0)`,
        [
          JSON.stringify({ type: "github-webhook", deliveryId: "still-blocked", eventName: "x", payload: { installation: { id: 123 } } }),
          futureRunAfter,
          now - 1_000,
        ],
      );

      const released = await q.releaseStaleForegroundDeferrals();

      expect(released).toBe(0);
      const row = driver.query("SELECT run_after FROM _selfhost_jobs", []).rows[0] as { run_after: number };
      expect(row.run_after).toBe(futureRunAfter);
      expect(await renderMetrics()).not.toContain("loopover_jobs_foreground_liveness_released_total");
    });

    it("caches foreground-liveness admission reads for candidates sharing the same rate-limit target", async () => {
      process.env.FOREGROUND_LIVENESS_MAX_DEFER_MS = "600000";
      const driver = makeDriver();
      const now = Date.now();
      seedExhaustedRateLimitObservation(driver, "installation:123", new Date(now + 30 * 60_000).toISOString());
      const realQuery = driver.query.bind(driver);
      const querySpy = vi.spyOn(driver, "query").mockImplementation((sql: string, params: unknown[]) => realQuery(sql, params));
      const q = createSqliteQueue(driver, async () => undefined);
      const futureRunAfter = now + 60 * 60_000;
      for (const deliveryId of ["fg-fresh-1", "fg-fresh-2"]) {
        driver.query(
          `INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key, is_maintenance)
           VALUES (?, 'pending', 0, ?, ?, 10, NULL, 0)`,
          [
            JSON.stringify({
              type: "github-webhook",
              deliveryId,
              eventName: "x",
              payload: { installation: { id: 123 } },
            }),
            futureRunAfter,
            now - 1_000,
          ],
        );
      }

      const released = await q.releaseStaleForegroundDeferrals();

      expect(released).toBe(0);
      const admissionReads = querySpy.mock.calls.filter(([sql]) => String(sql).includes("FROM github_rate_limit_observations"));
      expect(admissionReads).toHaveLength(1);
    });

    // CONDITION-BASED recovery (the second OR arm): a foreground job whose created_at is nowhere near stale but
    // whose rate-limit observation has since cleared (no blocking observation at all here) is released anyway --
    // this is the whole point of pairing the age floor with a rate-limit-aware re-check (see the source's own
    // doc comment on releaseStaleForegroundDeferrals).
    it("releases a foreground row that is NOT yet age-stale once rate-limit admission for it reads clear", async () => {
      process.env.FOREGROUND_LIVENESS_MAX_DEFER_MS = "600000"; // default 10m -- nowhere near stale by age
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined);
      const now = Date.now();
      const futureRunAfter = now + 60 * 60_000;
      // No github_rate_limit_observations table/row at all -- rateLimitAdmissionDelayMs degrades to "clear".
      driver.query(
        `INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key, is_maintenance)
         VALUES (?, 'pending', 0, ?, ?, 10, NULL, 0)`,
        [JSON.stringify({ type: "github-webhook", deliveryId: "now-clear", eventName: "x", payload: {} }), futureRunAfter, now - 1_000],
      );

      const released = await q.releaseStaleForegroundDeferrals();

      expect(released).toBe(1);
      expect(await renderMetrics()).toContain("loopover_jobs_foreground_liveness_released_total 1");
    });

    // The payload is unparseable -- isRateLimitAdmissionNowClear's own catch(){ return false } branch -- so ONLY
    // the age condition can release it; while young, it must stay parked exactly like any other not-yet-stale,
    // still-blocked row.
    it("does NOT release a foreground row with an unparseable payload before it is age-stale", async () => {
      process.env.FOREGROUND_LIVENESS_MAX_DEFER_MS = "600000";
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined);
      const now = Date.now();
      const futureRunAfter = now + 60 * 60_000;
      driver.query(
        `INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key, is_maintenance)
         VALUES (?, 'pending', 0, ?, ?, 10, NULL, 0)`,
        ["not valid json", futureRunAfter, now - 1_000],
      );

      const released = await q.releaseStaleForegroundDeferrals();

      expect(released).toBe(0);
    });

    // The priority>=? filter is enforced by the candidate SELECT's own WHERE clause (bound to
    // FOREGROUND_QUEUE_PRIORITY_FLOOR=8), not by any application-side check on the returned rows -- mirrors how
    // the maintenance-admission pressure tests in this file seed real rows and rely on the actual SQL predicate
    // rather than re-deriving it. A background-priority (<8) row, however old and however far-future its
    // run_after, must never be touched by this sweep.
    it("does NOT release a BACKGROUND-priority row even with an old created_at and future run_after", async () => {
      process.env.FOREGROUND_LIVENESS_MAX_DEFER_MS = "60000";
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined);
      const now = Date.now();
      const futureRunAfter = now + 60 * 60_000;
      seedForegroundPendingRow(driver, {
        createdAt: now - 5 * 60_000,
        runAfter: futureRunAfter,
        priority: 0, // background -- below FOREGROUND_QUEUE_PRIORITY_FLOOR (8)
        type: "build-contributor-evidence",
      });

      const released = await q.releaseStaleForegroundDeferrals();

      expect(released).toBe(0);
      const row = driver.query("SELECT run_after FROM _selfhost_jobs", []).rows[0] as { run_after: number };
      expect(row.run_after).toBe(futureRunAfter); // untouched
    });

    it("returns 0 immediately without releasing anything when FOREGROUND_LIVENESS_ENABLED=false", async () => {
      process.env.FOREGROUND_LIVENESS_ENABLED = "false";
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined); // creates the table
      const now = Date.now();
      seedForegroundPendingRow(driver, { createdAt: now - 60 * 60_000, runAfter: now + 60 * 60_000 });

      const released = await q.releaseStaleForegroundDeferrals();

      expect(released).toBe(0);
      const row = driver.query("SELECT run_after FROM _selfhost_jobs", []).rows[0] as { run_after: number };
      expect(row.run_after).toBeGreaterThan(Date.now()); // still deferred -- the escape hatch never touched it
      expect(await renderMetrics()).not.toContain("loopover_jobs_foreground_liveness_released_total");
    });

    // REGRESSION (#selfhost-queue-liveness): the production incident this module exists to make structurally
    // impossible -- a GitHub rate-limit sweep pushes MANY foreground-priority jobs' run_after far into the
    // future at once (a shared REST budget drained by a post-deploy catch-up burst), and without this release
    // path they'd sit deferred for up to the ~65-minute worst-case rate-limit window with zero runnable work,
    // requiring manual intervention. Assert releaseStaleForegroundDeferrals() releases ALL stale rows in ONE
    // sweep (not just the first) and records the metric as a SINGLE aggregate increment, not one per row --
    // matching the source's own "logs + records a metric ONCE per sweep (aggregate count), not per row" doc
    // comment, which exists specifically so a large release batch cannot spam the log/metric. Also asserts that
    // kickAll()-driven pump activity actually finds the released rows runnable afterward.
    it("releases every stale foreground deferral in one sweep and records one aggregate metric increment (regression for #selfhost-queue-liveness)", async () => {
      process.env.FOREGROUND_LIVENESS_MAX_DEFER_MS = "60000"; // 1m floor
      const driver = makeDriver();
      const started: string[] = [];
      const q = createSqliteQueue(driver, async (m) => void started.push(typeOf(m)));
      const now = Date.now();
      const staleAge = now - 5 * 60_000; // 5m old -- well past the 1m ceiling
      const farFuture = now + 60 * 60_000;
      for (let i = 0; i < 3; i += 1) {
        seedForegroundPendingRow(driver, { createdAt: staleAge, runAfter: farFuture });
      }

      const released = await q.releaseStaleForegroundDeferrals();

      expect(released).toBe(3);
      expect(await renderMetrics()).toContain("loopover_jobs_foreground_liveness_released_total 3");
      // kickAll() (called internally once released > 0) means pump activity picks these up without waiting for
      // the next poll tick -- drain() confirms all three are now genuinely runnable.
      await q.drain();
      expect(started.length).toBe(3);
    });

    // Ramp-up cap (#selfhost-queue-liveness): a large inherited backlog (the production incident had ~190
    // over-deferred rows) must not release ALL of it in one sweep -- that many jobs re-attempting GitHub reads
    // at once can immediately re-trip the same rate-limit bucket they were deferred for. With the cap set below
    // the eligible count, assert exactly `cap` rows release (not all of them), and that the OLDEST rows
    // (smallest created_at) are the ones chosen -- the newest-of-the-batch row must still be pending afterward.
    it("caps releases at FOREGROUND_LIVENESS_MAX_RELEASE_PER_SWEEP, releasing the oldest rows first", async () => {
      process.env.FOREGROUND_LIVENESS_MAX_DEFER_MS = "60000"; // 1m floor
      process.env.FOREGROUND_LIVENESS_MAX_RELEASE_PER_SWEEP = "2";
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined);
      const now = Date.now();
      const farFuture = now + 60 * 60_000;
      // 4 stale-eligible rows at distinct ages; only the 2 OLDEST should be released.
      const ages = [10 * 60_000, 8 * 60_000, 6 * 60_000, 5 * 60_000]; // minutes-old, oldest first
      for (const ageMs of ages) {
        seedForegroundPendingRow(driver, { createdAt: now - ageMs, runAfter: farFuture });
      }

      const released = await q.releaseStaleForegroundDeferrals();

      expect(released).toBe(2);
      expect(await renderMetrics()).toContain("loopover_jobs_foreground_liveness_released_total 2");
      const remainingFuture = driver.query(
        `SELECT COUNT(*) AS c FROM _selfhost_jobs WHERE status='pending' AND run_after>?`,
        [now],
      ).rows[0] as { c: number };
      // 2 of the 4 seeded rows remain deferred into the future -- the 2 NEWEST (least stale) ones.
      expect(remainingFuture.c).toBe(2);
    });

    it("does not let older still-blocked stale rows consume the cap before a newer clear row", async () => {
      process.env.FOREGROUND_LIVENESS_MAX_DEFER_MS = "60000";
      process.env.FOREGROUND_LIVENESS_MAX_RELEASE_PER_SWEEP = "2";
      const driver = makeDriver();
      const now = Date.now();
      seedExhaustedRateLimitObservation(driver, "installation:111", new Date(now + 30 * 60_000).toISOString());
      const q = createSqliteQueue(driver, async () => undefined);
      const farFuture = now + 60 * 60_000;
      const rows = [
        { deliveryId: "blocked-oldest", installationId: 111, createdAt: now - 10 * 60_000 },
        { deliveryId: "blocked-second", installationId: 111, createdAt: now - 9 * 60_000 },
        { deliveryId: "clear-newer", installationId: 222, createdAt: now - 5 * 60_000 },
      ];
      for (const row of rows) {
        driver.query(
          `INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key, is_maintenance)
           VALUES (?, 'pending', 0, ?, ?, 10, NULL, 0)`,
          [
            JSON.stringify({
              type: "github-webhook",
              deliveryId: row.deliveryId,
              eventName: "x",
              payload: { installation: { id: row.installationId } },
            }),
            farFuture,
            row.createdAt,
          ],
        );
      }

      const released = await q.releaseStaleForegroundDeferrals();

      expect(released).toBe(2);
      const releasedIds = driver.query(`SELECT payload FROM _selfhost_jobs WHERE run_after<?`, [farFuture]).rows.map((row) =>
        JSON.parse((row as { payload: string }).payload).deliveryId,
      );
      expect(releasedIds).toEqual(["blocked-oldest", "clear-newer"]);
    });

    // REGRESSION (#selfhost-queue-liveness clear-bucket starvation): the test above only seeds 3 rows, well
    // under the OLD single-window candidateLimit (maxReleasePerSweep * 2 = 4), so it can't actually distinguish
    // "the fix" from "the bug" -- a single `ORDER BY created_at ASC LIMIT 4` query would have returned all 3
    // rows there too. This test seeds MORE older still-blocked rows than that old limit, against a REAL SQLite
    // engine (not a mock), so the candidate query genuinely truncates. Under the pre-fix single-window query,
    // "clear-newer" (the single newest pending row) would never even be SELECTed into `eligible` -- proving the
    // starvation this fix closes, not just describing it.
    it("REGRESSION: a large glut of older still-blocked rows does not hide a newer clear-bucket row from the candidate window", async () => {
      process.env.FOREGROUND_LIVENESS_MAX_DEFER_MS = "60000";
      process.env.FOREGROUND_LIVENESS_MAX_RELEASE_PER_SWEEP = "2"; // old candidateLimit would have been 4
      const driver = makeDriver();
      const now = Date.now();
      seedExhaustedRateLimitObservation(driver, "installation:111", new Date(now + 30 * 60_000).toISOString());
      const q = createSqliteQueue(driver, async () => undefined);
      const farFuture = now + 60 * 60_000;
      // 6 older still-blocked rows -- more than the old single-window candidateLimit of 4, so a naive
      // "oldest N" window is entirely consumed by these and never reaches the newer row below.
      for (let i = 0; i < 6; i += 1) {
        driver.query(
          `INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key, is_maintenance)
           VALUES (?, 'pending', 0, ?, ?, 10, NULL, 0)`,
          [
            JSON.stringify({ type: "github-webhook", deliveryId: `blocked-${i}`, eventName: "x", payload: { installation: { id: 111 } } }),
            farFuture,
            now - (20 - i) * 60_000, // ages 20m down to 15m, oldest first
          ],
        );
      }
      // The single newest pending row, on a different (clear) admission target.
      driver.query(
        `INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key, is_maintenance)
         VALUES (?, 'pending', 0, ?, ?, 10, NULL, 0)`,
        [JSON.stringify({ type: "github-webhook", deliveryId: "clear-newer", eventName: "x", payload: { installation: { id: 222 } } }), farFuture, now - 1_000],
      );

      const released = await q.releaseStaleForegroundDeferrals();

      const releasedIds = driver.query(`SELECT payload FROM _selfhost_jobs WHERE run_after<?`, [farFuture]).rows.map((row) =>
        JSON.parse((row as { payload: string }).payload).deliveryId,
      );
      expect(released).toBe(2);
      // clear-newer wins a release slot despite the 6-row older-blocked glut; the remaining slot goes to the
      // single oldest age-stale row, exactly matching selectForegroundDeferralsToRelease's own ordering.
      expect(releasedIds.sort()).toEqual(["blocked-0", "clear-newer"]);
    });

    // Mirrors reviveDeadLetterJobsSafely's own regression test: the foreground-liveness interval had no error
    // handler of its own, so a thrown driver/metric failure on that tick would surface as an uncaught exception
    // and could terminate the process -- exactly the failure mode pump()'s own try/catch already guards against
    // for the main poll loop.
    it("survives a releaseStaleForegroundDeferrals() driver failure on the interval tick instead of crashing the process", async () => {
      process.env.FOREGROUND_LIVENESS_CHECK_INTERVAL_MS = "5000"; // parsePositiveIntEnv floor
      vi.useFakeTimers();
      try {
        const driver = makeDriver();
        // Let the boot-time self-heal call (inside createSqliteQueue's own constructor, unguarded) run against
        // the real driver first -- only start throwing on the candidate SELECT once the queue is fully
        // constructed, so this test isolates the INTERVAL tick's own error handling rather than a constructor-time
        // crash (a distinct concern, already covered by the TDZ-crash tests elsewhere in this describe block).
        let armed = false;
        const realQuery = driver.query.bind(driver);
        vi.spyOn(driver, "query").mockImplementation((sql: string, params: unknown[]) => {
          if (armed && sql.includes("SELECT id, payload, created_at FROM") && sql.includes("priority>=? AND run_after>?")) {
            throw new Error("disk I/O error");
          }
          return realQuery(sql, params);
        });
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const q = createSqliteQueue(driver, async () => undefined);
        armed = true;

        q.start();
        await vi.advanceTimersByTimeAsync(5000); // the foreground-liveness interval fires once -- would throw here if uncaught

        const logged = errorSpy.mock.calls.map(([line]) => String(line));
        expect(
          logged.some(
            (line) => line.includes("selfhost_queue_foreground_liveness_release_crashed") && line.includes("disk I/O error"),
          ),
        ).toBe(true);
        await q.stop();
      } finally {
        delete process.env.FOREGROUND_LIVENESS_CHECK_INTERVAL_MS;
      }
    });
  });

  describe("processingCount (#selfhost-queue-liveness)", () => {
    it("returns the count of status='processing' jobs", async () => {
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined);
      driver.query(
        "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority) VALUES (?, 'processing', 0, 0, 0, 0)",
        [JSON.stringify(msg("x"))],
      );
      driver.query(
        "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority) VALUES (?, 'pending', 0, 0, 0, 0)",
        [JSON.stringify(msg("y"))],
      );
      expect(await q.processingCount()).toBe(1);
    });

    it("returns 0 when no job is processing", async () => {
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined);
      expect(await q.processingCount()).toBe(0);
    });
  });

  it("reschedules GitHub rate-limit failures without consuming the dead-letter budget", async () => {
    const driver = makeDriver();
    let calls = 0;
    const rateLimit = new Error("API rate limit exceeded for installation ID 123");
    Object.assign(rateLimit, { status: 403 });
    const q = createSqliteQueue(
      driver,
      async () => {
        calls += 1;
        throw rateLimit;
      },
      { maxRetries: 1, backoffMs: () => 0 },
    );
    await q.binding.send(msg("github-webhook"));
    await q.drain();
    const { rows } = driver.query(
      "SELECT status, attempts, run_after, last_error FROM _selfhost_jobs",
      [],
    );
    const row = rows[0] as {
      status: string;
      attempts: number;
      run_after: number;
      last_error: string;
    };
    expect(calls).toBe(1);
    expect(await q.deadCount()).toBe(0);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.run_after).toBeGreaterThan(Date.now());
    expect(row.last_error).toContain("API rate limit exceeded");
  });

  it("does not put status-less provider rate limits on the global GitHub cooldown path", async () => {
    const driver = makeDriver();
    let calls = 0;
    const q = createSqliteQueue(
      driver,
      async () => {
        calls += 1;
        throw new Error("openai api rate limit exceeded");
      },
      { maxRetries: 2, backoffMs: () => 0 },
    );

    await q.binding.send(msg("github-webhook"));
    await q.drain();

    const row = driver.query(
      "SELECT status, attempts, last_error FROM _selfhost_jobs",
      [],
    ).rows[0] as { status: string; attempts: number; last_error: string };
    expect(calls).toBe(2);
    expect(row).toMatchObject({
      status: "dead",
      attempts: 2,
      last_error: "openai api rate limit exceeded",
    });
    expect(await q.stats()).toMatchObject({
      loopover_jobs_failed_total: 2,
      loopover_jobs_dead_total: 1,
    });
    expect(await q.stats()).not.toHaveProperty("loopover_jobs_rate_limited_total");
  });

  it("does not defer GitHub work when a non-GitHub job throws a GitHub-looking rate limit", async () => {
    const driver = makeDriver();
    const seen: string[] = [];
    const rateLimit = new Error("API rate limit exceeded for installation ID 123");
    Object.assign(rateLimit, {
      status: 403,
      response: { headers: { "retry-after": "120" } },
    });
    const q = createSqliteQueue(
      driver,
      async (message) => {
        seen.push(message.type === "github-webhook" ? message.deliveryId ?? "" : message.type);
        if (message.type === "refresh-registry") throw rateLimit;
      },
      { maxRetries: 1, backoffMs: () => 0 },
    );
    driver.query(
      "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority) VALUES (?, 'pending', 0, 0, 0, 10)",
      [JSON.stringify(msg("refresh-registry"))],
    );
    driver.query(
      "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority) VALUES (?, 'pending', 0, 0, 0, 9)",
      [JSON.stringify(installedWebhook("github-still-runs", 123))],
    );

    await q.drain();

    const pending = driver.query(
      "SELECT payload, last_error FROM _selfhost_jobs WHERE status='pending'",
      [],
    ).rows as Array<{ payload: string; last_error: string }>;
    expect(seen).toEqual(["refresh-registry", "github-still-runs"]);
    expect(pending).toHaveLength(1);
    expect(JSON.parse(pending[0]!.payload)).toMatchObject({ type: "refresh-registry" });
    expect(pending[0]!.last_error).toBe("API rate limit exceeded for installation ID 123");
    expect(await q.stats()).toMatchObject({ loopover_jobs_rate_limited_total: 1 });
    expect(await q.stats()).not.toHaveProperty("loopover_jobs_rate_limit_deferred_total");
    expect(await renderMetrics()).toContain('loopover_jobs_rate_limited_by_type_total{job_type="refresh-registry",key_scope="unknown",kind="unknown"} 1');
  });

  it("defers only the depleted keyed GitHub budget while unrelated work keeps draining", async () => {
    const driver = makeDriver();
    const seen: string[] = [];
    const rateLimit = new Error("API rate limit exceeded for installation ID 123");
    Object.assign(rateLimit, {
      status: 403,
      response: { headers: { "retry-after": "120" } },
    });
    const q = createSqliteQueue(
      driver,
      async (message) => {
        seen.push(
          message.type === "github-webhook" ? message.deliveryId ?? "" : message.type,
        );
        if (message.type === "github-webhook" && message.deliveryId === "blocked-installation") {
          throw rateLimit;
        }
      },
      { maxRetries: 1, backoffMs: () => 0 },
    );
    const before = Date.now();
    driver.query(
      "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority) VALUES (?, 'pending', 0, 0, 0, 10)",
      [JSON.stringify(installedWebhook("blocked-installation", 123))],
    );
    driver.query(
      "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority) VALUES (?, 'pending', 0, 0, 0, 9)",
      [JSON.stringify(regateJob(123, 9))],
    );
    driver.query(
      "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority) VALUES (?, 'pending', 0, 0, 0, 9)",
      [JSON.stringify(regateJob(null, 10))],
    );
    driver.query(
      "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority) VALUES (?, 'pending', 0, 0, 0, 10)",
      [JSON.stringify(installedWebhook("other-installation", 456))],
    );
    driver.query(
      "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority) VALUES (?, 'pending', 0, 0, 0, 0)",
      [JSON.stringify(msg("local-cleanup"))],
    );
    driver.query(
      "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority) VALUES (?, 'pending', 0, 0, 0, 8)",
      ["{not json"],
    );

    await q.drain();

    const rows = driver.query(
      "SELECT payload, status, attempts, run_after, last_error FROM _selfhost_jobs WHERE status='pending' ORDER BY id",
      [],
    ).rows as Array<{ payload: string; status: string; attempts: number; run_after: number; last_error: string | null }>;
    const deadMalformed = driver.query(
      "SELECT status, last_error FROM _selfhost_jobs WHERE payload=?",
      ["{not json"],
    ).rows[0] as { status: string; last_error: string };
    expect(seen).toEqual(["blocked-installation", "other-installation", "agent-regate-pr", "local-cleanup"]);
    expect(rows).toHaveLength(2);
    expect(deadMalformed).toEqual({ status: "dead", last_error: "unparseable payload" });
    expect(rows.every((row) => row.status === "pending")).toBe(true);
    expect(rows.every((row) => row.attempts === 0)).toBe(true);
    expect(rows.every((row) => row.run_after > before)).toBe(true);
    const byType = new Map(rows.map((row) => {
      const payload = JSON.parse(row.payload) as { type: string; deliveryId?: string; prNumber?: number };
      const key =
        payload.type === "agent-regate-pr"
          ? `${payload.type}:${payload.prNumber}`
          : payload.deliveryId ?? payload.type;
      return [key, row];
    }));
    expect(byType.get("blocked-installation")?.last_error).toBe("API rate limit exceeded for installation ID 123");
    expect(byType.get("agent-regate-pr:9")?.last_error).toBe("github rate-limit budget deferred");
    expect(byType.has("agent-regate-pr:10")).toBe(false);
    expect(await q.stats()).toMatchObject({
      loopover_jobs_processed_total: 3,
      loopover_jobs_rate_limited_total: 1,
      loopover_jobs_rate_limit_deferred_total: 1,
    });
    const metrics = await renderMetrics();
    expect(metrics).toContain('loopover_jobs_rate_limit_budget_deferred_total{job_type="github-webhook",key_scope="installation",kind="webhook"} 1');
    expect(metrics).toContain('loopover_jobs_rate_limited_by_type_total{job_type="github-webhook",key_scope="installation",kind="webhook"} 1');
  });

  it("coalesces a rate-limited active job into an existing pending duplicate without consuming attempts", async () => {
    const driver = makeDriver();
    let calls = 0;
    const rateLimit = new Error("secondary rate limit");
    Object.assign(rateLimit, { status: 403 });
    const key = `github-webhook:ci-completed:jsonbored/gittensory@${"b".repeat(40)}#1629`;
    const q = createSqliteQueue(
      driver,
      async () => {
        calls += 1;
        throw rateLimit;
      },
      { maxRetries: 1, backoffMs: () => 0 },
    );
    driver.query(
      "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key) VALUES (?, 'pending', 0, 0, 0, 10, ?)",
      [JSON.stringify(ciWebhook("ci-active")), key],
    );
    driver.query(
      "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key) VALUES (?, 'pending', 0, ?, 0, 10, ?)",
      [JSON.stringify(ciWebhook("ci-existing")), Date.now() + 60_000, key],
    );

    await q.drain();

    const rows = driver.query("SELECT payload, attempts, last_error FROM _selfhost_jobs ORDER BY id", []).rows as Array<{
      payload: string;
      attempts: number;
      last_error: string | null;
    }>;
    expect(calls).toBe(1);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload).deliveryId).toBe("ci-existing");
    expect(rows[0]!.attempts).toBe(0);
    expect(rows[0]!.last_error).toContain("secondary rate limit");
    expect(await q.stats()).toMatchObject({ loopover_jobs_coalesced_total: 1 });
  });

  it("reschedules a keyed rate-limited job when no pending duplicate exists", async () => {
    const driver = makeDriver();
    let calls = 0;
    const rateLimit = new Error("secondary rate limit");
    Object.assign(rateLimit, { status: 403 });
    const key = `github-webhook:ci-completed:jsonbored/gittensory@${"b".repeat(40)}#1629`;
    const q = createSqliteQueue(
      driver,
      async () => {
        calls += 1;
        throw rateLimit;
      },
      { maxRetries: 1, backoffMs: () => 0 },
    );
    driver.query(
      "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key) VALUES (?, 'pending', 0, 0, 0, 10, ?)",
      [JSON.stringify(ciWebhook("ci-active")), key],
    );

    await q.drain();

    const row = driver.query(
      "SELECT payload, status, attempts, run_after, last_error FROM _selfhost_jobs",
      [],
    ).rows[0] as {
      payload: string;
      status: string;
      attempts: number;
      run_after: number;
      last_error: string | null;
    };
    expect(calls).toBe(1);
    expect(JSON.parse(row.payload).deliveryId).toBe("ci-active");
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.run_after).toBeGreaterThan(Date.now());
    expect(row.last_error).toContain("secondary rate limit");
    expect(await q.stats()).toMatchObject({ loopover_jobs_rate_limited_total: 1 });
  });

  it("consumes retryable incomplete review attempts and dead-letters after maxRetries", async () => {
    const driver = makeDriver();
    let calls = 0;
    const retryable = new RetryableJobError("AI review did not produce a public summary yet", {
      retryAfterMs: 5_000,
      retryKind: "ai_review_public_summary_missing",
    });
    const q = createSqliteQueue(
      driver,
      async () => {
        calls += 1;
        throw retryable;
      },
      { maxRetries: 2, backoffMs: () => 0 },
    );
    await q.binding.send(msg("agent-regate-pr"));
    const before = Date.now();
    await q.drain();
    const { rows } = driver.query(
      "SELECT status, attempts, run_after, last_error FROM _selfhost_jobs",
      [],
    );
    const row = rows[0] as {
      status: string;
      attempts: number;
      run_after: number;
      last_error: string;
    };
    expect(calls).toBe(1);
    expect(await q.deadCount()).toBe(0);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.run_after).toBeGreaterThanOrEqual(before + 5_000);
    expect(row.last_error).toContain("AI review did not produce");

    driver.query("UPDATE _selfhost_jobs SET run_after=0", []);
    await q.drain();
    const dead = driver.query(
      "SELECT status, attempts, last_error FROM _selfhost_jobs",
      [],
    ).rows[0] as { status: string; attempts: number; last_error: string };
    expect(calls).toBe(2);
    expect(await q.deadCount()).toBe(1);
    expect(dead.status).toBe("dead");
    expect(dead.attempts).toBe(2);
    expect(dead.last_error).toContain("AI review did not produce");
  });

  it("does not coalesce bounded retryable review failures into an existing pending duplicate", async () => {
    const driver = makeDriver();
    const retryable = new RetryableJobError("AI review did not produce a public summary yet", {
      retryAfterMs: 5_000,
      retryKind: "ai_review_public_summary_missing",
    });
    const key = `github-webhook:ci-completed:jsonbored/gittensory@${"b".repeat(40)}#1629`;
    const q = createSqliteQueue(
      driver,
      async () => {
        throw retryable;
      },
      { maxRetries: 2, backoffMs: () => 0 },
    );
    driver.query(
      "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key) VALUES (?, 'pending', 0, 0, 0, 10, ?)",
      [JSON.stringify(ciWebhook("ci-active")), key],
    );
    driver.query(
      "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key) VALUES (?, 'pending', 0, ?, 0, 10, ?)",
      [JSON.stringify(ciWebhook("ci-existing")), Date.now() + 60_000, key],
    );

    await q.drain();

    const rows = driver.query(
      "SELECT payload, attempts, last_error FROM _selfhost_jobs ORDER BY id",
      [],
    ).rows as Array<{ payload: string; attempts: number; last_error: string | null }>;
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0]!.payload).deliveryId).toBe("ci-active");
    expect(rows[0]!.attempts).toBe(1);
    expect(rows[0]!.last_error).toContain("AI review did not produce");
    expect(JSON.parse(rows[1]!.payload).deliveryId).toBe("ci-existing");
    expect(rows[1]!.attempts).toBe(0);
    expect(rows[1]!.last_error).toBeNull();
    expect((await q.stats()).loopover_jobs_coalesced_total ?? 0).toBe(0);
  });

  it("SURVIVES A RESTART: a fresh queue over the same DB processes a persisted pending job", async () => {
    const driver = makeDriver();
    const seen: string[] = [];
    const fresh = createSqliteQueue(driver, async (m) => void seen.push(typeOf(m))); // creates the table
    // a job left pending on disk by a prior run (insert directly so this instance doesn't auto-process it first)
    driver.query("INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at) VALUES (?, 'pending', 0, 0, 0)", [JSON.stringify(msg("persisted"))]);
    await fresh.drain(); // the "new process" picks it up
    expect(seen).toEqual(["persisted"]);
  });

  it("does not reclaim processing jobs when the processing timeout is disabled", async () => {
    const old = process.env.QUEUE_PROCESSING_TIMEOUT_MS;
    process.env.QUEUE_PROCESSING_TIMEOUT_MS = "0";
    try {
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined);
      driver.query(
        "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key) VALUES (?, 'processing', 0, 0, 0, 10, ?)",
        [JSON.stringify(msg("stuck")), "stuck-key"],
      );

      await q.drain();

      expect(driver.query("SELECT status FROM _selfhost_jobs", []).rows[0]).toMatchObject({ status: "processing" });
      expect((await q.stats()).loopover_jobs_recovered_total ?? 0).toBe(0);
    } finally {
      if (old === undefined) delete process.env.QUEUE_PROCESSING_TIMEOUT_MS;
      else process.env.QUEUE_PROCESSING_TIMEOUT_MS = old;
    }
  });

  it("start() runs the poll loop and processes a job, stop() halts it", async () => {
    const driver = makeDriver();
    const seen: string[] = [];
    const q = createSqliteQueue(driver, async (m) => void seen.push(typeOf(m)), { pollIntervalMs: 10 });
    q.start();
    await q.binding.send(msg("ticked"));
    for (let i = 0; i < 50 && seen.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    await q.stop();
    expect(seen).toEqual(["ticked"]);
  });

  it("start() fills available workers for an existing due backlog", async () => {
    const driver = makeDriver();
    createSqliteQueue(driver, async () => undefined); // creates the table
    for (const name of ["a", "b", "c"]) {
      driver.query(
        "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at) VALUES (?, 'pending', 0, 0, 0)",
        [JSON.stringify(msg(name))],
      );
    }
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let concurrent = 0;
    let maxConcurrent = 0;
    const q = createSqliteQueue(
      driver,
      async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await gate;
        concurrent--;
      },
      { concurrency: 3, backgroundConcurrency: 3, pollIntervalMs: 100_000 },
    );
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

  it("caps background jobs so foreground review work keeps a worker slot", async () => {
    const driver = makeDriver();
    const started: string[] = [];
    const releases: Array<() => void> = [];
    let blockedBackground = false;
    const q = createSqliteQueue(
      driver,
      async (m) => {
        const type = typeOf(m);
        started.push(type);
        if (type === "rag-index-repo" && !blockedBackground) {
          blockedBackground = true;
          await new Promise<void>((resolve) => {
            releases.push(resolve);
          });
        }
      },
      { concurrency: 2, backgroundConcurrency: 1, pollIntervalMs: 100_000 },
    );
    try {
      await q.binding.sendBatch([
        { body: msg("rag-index-repo") },
        { body: msg("rag-index-repo") },
      ]);
      for (let i = 0; i < 20 && releases.length === 0; i += 1)
        await new Promise((r) => setTimeout(r, 10));

      expect(started).toEqual(["rag-index-repo"]);

      await q.binding.send(msg("agent-regate-pr"));
      for (let i = 0; i < 20 && !started.includes("agent-regate-pr"); i += 1)
        await new Promise((r) => setTimeout(r, 10));

      expect(started).toContain("agent-regate-pr");
      expect(started.filter((type) => type === "rag-index-repo")).toHaveLength(1);
    } finally {
      for (const release of releases) release();
      await q.stop();
    }
  });

  it("recovers a job left 'processing' by a crash", async () => {
    const oldRecoveryJitter = process.env.QUEUE_RECOVERY_JITTER_MS;
    process.env.QUEUE_RECOVERY_JITTER_MS = "0";
    const driver = makeDriver();
    try {
      createSqliteQueue(driver, async () => undefined); // creates the table
      driver.query("INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at) VALUES (?, 'processing', 0, 0, 0)", [JSON.stringify(msg("stuck"))]);
      const seen: string[] = [];
      const fresh = createSqliteQueue(driver, async (m) => void seen.push(typeOf(m)));
      await fresh.drain();
      expect(seen).toEqual(["stuck"]);
    } finally {
      if (oldRecoveryJitter === undefined) delete process.env.QUEUE_RECOVERY_JITTER_MS;
      else process.env.QUEUE_RECOVERY_JITTER_MS = oldRecoveryJitter;
    }
  });

  it("reclaims an expired processing lease without requiring a restart", async () => {
    const oldTimeout = process.env.QUEUE_PROCESSING_TIMEOUT_MS;
    const oldRecoveryJitter = process.env.QUEUE_RECOVERY_JITTER_MS;
    process.env.QUEUE_PROCESSING_TIMEOUT_MS = "1";
    process.env.QUEUE_RECOVERY_JITTER_MS = "0";
    const driver = makeDriver();
    const seen: string[] = [];
    try {
      const q = createSqliteQueue(
        driver,
        async (m) => void seen.push(typeOf(m)),
        { concurrency: 1 },
      );
      driver.query(
        "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at) VALUES (?, 'processing', 0, ?, 0)",
        [JSON.stringify(msg("lease-expired")), Date.now() - 10_000],
      );

      await q.drain();

      expect(seen).toEqual(["lease-expired"]);
      expect(await q.stats()).toMatchObject({
        loopover_jobs_recovered_total: 1,
        loopover_jobs_processed_total: 1,
      });
    } finally {
      if (oldTimeout === undefined) delete process.env.QUEUE_PROCESSING_TIMEOUT_MS;
      else process.env.QUEUE_PROCESSING_TIMEOUT_MS = oldTimeout;
      if (oldRecoveryJitter === undefined) delete process.env.QUEUE_RECOVERY_JITTER_MS;
      else process.env.QUEUE_RECOVERY_JITTER_MS = oldRecoveryJitter;
    }
  });

  it("does not reclaim an expired processing lease while that job is still active", async () => {
    const oldTimeout = process.env.QUEUE_PROCESSING_TIMEOUT_MS;
    const oldRecoveryJitter = process.env.QUEUE_RECOVERY_JITTER_MS;
    process.env.QUEUE_PROCESSING_TIMEOUT_MS = "1";
    process.env.QUEUE_RECOVERY_JITTER_MS = "0";
    const driver = makeDriver();
    const seen: string[] = [];
    const releases: Array<() => void> = [];
    let q: ReturnType<typeof createSqliteQueue> | undefined;
    try {
      const queue = createSqliteQueue(
        driver,
        async (m) => {
          const type = typeOf(m);
          seen.push(type);
          if (type === "slow") {
            await new Promise<void>((resolve) => {
              releases.push(resolve);
            });
          }
        },
        { concurrency: 2, backgroundConcurrency: 2, pollIntervalMs: 100_000 },
      );
      q = queue;
      await queue.binding.send(msg("slow"));
      for (let i = 0; i < 20 && releases.length === 0; i += 1)
        await new Promise((r) => setTimeout(r, 10));
      await new Promise((r) => setTimeout(r, 5));

      await queue.binding.send(msg("wake-reclaimer"));
      for (let i = 0; i < 20 && !seen.includes("wake-reclaimer"); i += 1)
        await new Promise((r) => setTimeout(r, 10));

      expect(seen.filter((type) => type === "slow")).toHaveLength(1);
      expect((await queue.stats()).loopover_jobs_recovered_total ?? 0).toBe(0);
    } finally {
      for (const release of releases) release();
      if (q) await q.stop();
      if (oldTimeout === undefined) delete process.env.QUEUE_PROCESSING_TIMEOUT_MS;
      else process.env.QUEUE_PROCESSING_TIMEOUT_MS = oldTimeout;
      if (oldRecoveryJitter === undefined) delete process.env.QUEUE_RECOVERY_JITTER_MS;
      else process.env.QUEUE_RECOVERY_JITTER_MS = oldRecoveryJitter;
    }
  });

  it("pump absorbs a claimNext() driver failure instead of crashing the process (regression for #2498)", async () => {
    const driver = makeDriver();
    const realQuery = driver.query.bind(driver);
    const q = createSqliteQueue(driver, async () => undefined);
    // Only claimNextWhere's SELECT starts with this exact column list — spreadDueJobsOnStartup (which already
    // ran during construction above) selects a different column set, so this doesn't clobber setup.
    vi.spyOn(driver, "query").mockImplementation((sql: string, params: unknown[]) => {
      if (sql.includes("SELECT candidate.id, candidate.payload, candidate.attempts")) throw new Error("database is locked");
      return realQuery(sql, params);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(q.drain()).resolves.toBeUndefined();

    const logged = errorSpy.mock.calls.map(([line]) => String(line));
    expect(logged.some((line) => line.includes("selfhost_queue_pump_crashed") && line.includes("database is locked"))).toBe(true);
  });

  it("pump absorbs a reclaimExpiredProcessingJobs() driver failure instead of crashing the process (regression for #2498)", async () => {
    const oldTimeout = process.env.QUEUE_PROCESSING_TIMEOUT_MS;
    process.env.QUEUE_PROCESSING_TIMEOUT_MS = "1";
    try {
      const driver = makeDriver();
      const realQuery = driver.query.bind(driver);
      vi.spyOn(driver, "query").mockImplementation((sql: string, params: unknown[]) => {
        if (sql.includes("WHERE status='processing' AND run_after<=?")) throw new Error("disk I/O error");
        return realQuery(sql, params);
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const q = createSqliteQueue(driver, async () => undefined);

      await expect(q.drain()).resolves.toBeUndefined();

      const logged = errorSpy.mock.calls.map(([line]) => String(line));
      expect(logged.some((line) => line.includes("selfhost_queue_pump_crashed") && line.includes("disk I/O error"))).toBe(true);
    } finally {
      if (oldTimeout === undefined) delete process.env.QUEUE_PROCESSING_TIMEOUT_MS;
      else process.env.QUEUE_PROCESSING_TIMEOUT_MS = oldTimeout;
    }
  });

  it("records 'unknown error' when a consumer throws a non-Error", async () => {
    const q = createSqliteQueue(
      makeDriver(),
      async () => {
        throw "boom-string"; // not an Error instance
      },
      { maxRetries: 1, backoffMs: () => 0 },
    );
    await q.binding.send(msg("x"));
    await q.drain();
    expect(await q.deadCount()).toBe(1);
  });

  it("dead-letters an unparseable payload", async () => {
    const driver = makeDriver();
    const q = createSqliteQueue(driver, async () => undefined);
    driver.query("INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at) VALUES ('not-json','pending',0,0,0)", []);
    await q.drain();
    expect(await q.deadCount()).toBe(1);
    // #2214: an unparseable payload has no `type` field to extract -- the DLQ table falls back to "unknown".
    const [row] = await q.listDeadLetterJobs(10, 0);
    expect(row).toMatchObject({ jobType: "unknown", lastError: "unparseable payload" });
    expect(row!.deadAtMs).not.toBeNull();
    // A malformed payload consumes the same bounded retry budget as a normal failure (previously left `attempts`
    // at its pre-death value, so the dead-letter reviver would requeue the same unparseable row forever).
    expect(row!.attempts).toBe(1);
  });

  it("sendBatch enqueues all; default backoff reschedules a failure into the future", async () => {
    const seen: string[] = [];
    const q = createSqliteQueue(makeDriver(), async (m) => void seen.push(typeOf(m)));
    await q.binding.sendBatch([{ body: msg("a") }, { body: msg("b") }]);
    await q.drain();
    expect(seen.sort()).toEqual(["a", "b"]);

    let calls = 0;
    const q2 = createSqliteQueue(makeDriver(), async () => {
      calls += 1;
      throw new Error("x");
    }, { maxRetries: 5 }); // default backoff (~2s) → not re-claimed this drain
    await q2.binding.send(msg("f"));
    await q2.drain();
    expect(calls).toBe(1);
    expect(await q2.size()).toBe(1);
  });

  it("stop() is a no-op when start() was never called (timer is null)", async () => {
    const q = createSqliteQueue(makeDriver(), async () => undefined);
    await q.stop(); // timer=null → the false branch of `if (timer) clearTimeout(timer)` is taken
    expect(await q.size()).toBe(0); // still usable after a spurious stop()
  });

  it("concurrency=1 saturates after one active pump (active >= concurrency → early return)", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const q = createSqliteQueue(makeDriver(), async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 15));
      concurrent--;
    }, { concurrency: 1, pollIntervalMs: 100_000 });
    // sendBatch fires two void pump() calls synchronously; the second sees active=1 >= 1 and returns.
    await q.binding.sendBatch([{ body: msg("a") }, { body: msg("b") }]);
    await new Promise((r) => setTimeout(r, 60));
    await q.stop();
    expect(maxConcurrent).toBe(1);
    expect(await q.size()).toBe(0);
  });

  it("concurrency=2 allows two jobs to run simultaneously", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const q = createSqliteQueue(makeDriver(), async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 15));
      concurrent--;
    }, { concurrency: 2, backgroundConcurrency: 2, pollIntervalMs: 100_000 });
    await q.binding.sendBatch([{ body: msg("a") }, { body: msg("b") }]);
    await new Promise((r) => setTimeout(r, 60));
    await q.stop();
    expect(maxConcurrent).toBe(2);
    expect(await q.size()).toBe(0);
  });

  it("start() is idempotent and stop() waits for an in-flight pump", async () => {
    let done = false;
    const q = createSqliteQueue(makeDriver(), async () => {
      await new Promise((r) => setTimeout(r, 40));
      done = true;
    }, { pollIntervalMs: 5 });
    q.start();
    q.start(); // idempotent
    await q.binding.send(msg("slow"));
    await new Promise((r) => setTimeout(r, 12)); // let the tick claim it + enter the slow consume
    await q.stop(); // waits for the in-flight consume to finish
    expect(done).toBe(true);
  });

  describe("maintenance-admission pressure gating (#selfhost-runtime-pressure)", () => {
    const envKeys = [
      "MAINTENANCE_ADMISSION_ENABLED",
      "MAINTENANCE_ADMISSION_MAX_LIVE_PENDING",
      "MAINTENANCE_ADMISSION_MAX_LIVE_AGE_MS",
      "MAINTENANCE_ADMISSION_MAX_PENDING",
      "MAINTENANCE_ADMISSION_MAX_HOST_LOAD",
      "MAINTENANCE_ADMISSION_DEFER_MS",
      "MAINTENANCE_ADMISSION_MAX_DEFER_AGE_MS",
      "MAINTENANCE_ADMISSION_DRAIN_AGE_MS",
    ] as const;
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const key of envKeys) {
        saved[key] = process.env[key];
        delete process.env[key];
      }
    });
    afterEach(() => {
      for (const key of envKeys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });

    // Directly occupies rows the way currently-pending/processing live work would, without needing worker-slot
    // choreography -- the admission check reads real table state, not the consumer callback. Defaults to
    // 'processing' (stably occupied for the whole test, unlike a genuinely due 'pending' row which this
    // queue's own pump would claim and complete during drain()) -- liveRunnableNowCount counts 'processing'
    // rows as genuine current pressure alongside due-and-unclaimed 'pending' ones (see maintenance-admission.ts).
    function seedLiveRows(driver: ReturnType<typeof makeDriver>, count: number, status: "pending" | "processing" = "processing"): void {
      const now = Date.now();
      for (let i = 0; i < count; i += 1) {
        driver.query(
          `INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key, is_maintenance)
           VALUES (?, ?, 0, ?, ?, 10, NULL, 0)`,
          [JSON.stringify({ type: "github-webhook", deliveryId: `seed-${i}`, eventName: "x", payload: {} }), status, now, now],
        );
      }
    }

    it("defers a maintenance job when live queue pressure is high", async () => {
      const driver = makeDriver();
      const started: string[] = [];
      const q = createSqliteQueue(driver, async (m) => void started.push(typeOf(m)));
      seedLiveRows(driver, 6); // default threshold is 5
      const before = Date.now();
      await q.binding.send(msg("build-contributor-evidence"));
      await q.drain();

      expect(started).not.toContain("build-contributor-evidence");
      const row = driver.query(
        "SELECT status, run_after, last_error FROM _selfhost_jobs WHERE payload LIKE '%build-contributor-evidence%'",
        [],
      ).rows[0] as { status: string; run_after: number; last_error: string };
      expect(row.status).toBe("pending");
      expect(row.run_after).toBeGreaterThan(before);
      expect(row.last_error).toContain("live_pending_high");
      expect(await q.stats()).toMatchObject({ loopover_jobs_maintenance_admission_deferred_total: 1 });
      expect(await renderMetrics()).toContain(
        'loopover_jobs_maintenance_admission_deferred_by_reason_total{job_type="build-contributor-evidence",reason="live_pending_high"} 1',
      );
    });

    it("logs a deferred maintenance admission at info level, not warn (#selfhost-backpressure-noise)", async () => {
      const driver = makeDriver();
      const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const q = createSqliteQueue(driver, async () => undefined);
      seedLiveRows(driver, 6); // default threshold is 5
      await q.binding.send(msg("build-contributor-evidence"));
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
      const driver = makeDriver();
      const started: string[] = [];
      const q = createSqliteQueue(driver, async (m) => void started.push(typeOf(m)));
      await q.binding.send(msg("build-contributor-evidence"));
      await q.drain();
      expect(started).toEqual(["build-contributor-evidence"]);
      expect(await q.size()).toBe(0);
    });

    it("never defers live/foreground work, even under the same pressure that defers maintenance work", async () => {
      const driver = makeDriver();
      const started: string[] = [];
      const q = createSqliteQueue(driver, async (m) => void started.push(typeOf(m)));
      seedLiveRows(driver, 6);
      await q.binding.send(msg("build-contributor-evidence"));
      await q.binding.send(msg("github-webhook"));
      await q.drain();
      expect(started).toEqual(["github-webhook"]);
      expect(started).not.toContain("build-contributor-evidence");
    });

    it("does not defer a targeted background job that is not classified as maintenance", async () => {
      const driver = makeDriver();
      const started: string[] = [];
      const q = createSqliteQueue(driver, async (m) => void started.push(typeOf(m)));
      seedLiveRows(driver, 6);
      await q.binding.send({
        type: "backfill-repo-segment",
        requestedBy: "api",
        repoFullName: "jsonbored/gittensory",
        segment: "labels",
      } as unknown as JobMessage);
      await q.drain();
      expect(started).toEqual(["backfill-repo-segment"]);
    });

    it("defers a maintenance job when the maintenance lane itself is already backed up", async () => {
      const driver = makeDriver();
      const started: string[] = [];
      const q = createSqliteQueue(driver, async (m) => void started.push(typeOf(m)));
      const now = Date.now();
      for (let i = 0; i < 16; i += 1) { // default threshold is 15
        driver.query(
          `INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key, is_maintenance)
           VALUES (?, 'pending', 0, ?, ?, 0, NULL, 1)`,
          [JSON.stringify({ type: "rollup-product-usage", requestedBy: "test" }), now + 3_600_000, now],
        );
      }
      await q.binding.send(msg("build-contributor-evidence"));
      await q.drain();
      expect(started).not.toContain("build-contributor-evidence");
      const row = driver.query(
        "SELECT last_error FROM _selfhost_jobs WHERE payload LIKE '%build-contributor-evidence%'",
        [],
      ).rows[0] as { last_error: string };
      expect(row.last_error).toContain("maintenance_pending_high");
    });

    // Regression (#selfhost-maintenance-self-pin): the reported incident had a maintenance lane backed up well
    // past the threshold with EVERY claim denied `maintenance_pending_high`, and no way for the backlog to shrink
    // short of each job individually reaching the 4h trickle. The drain escape lets the OLDEST jobs in that same
    // backlog through in a bounded trickle well before that.
    it("drain-admits the oldest job in a large backlog once it has waited past the drain age, while a fresh job in the SAME backlog still defers", async () => {
      process.env.MAINTENANCE_ADMISSION_DRAIN_AGE_MS = "60000"; // 1m (parsePositiveIntEnv floor)
      const driver = makeDriver();
      const started: string[] = [];
      const q = createSqliteQueue(driver, async (m) => void started.push(typeOf(m)));
      const now = Date.now();
      for (let i = 0; i < 68; i += 1) { // mirrors the reported incident's backlog size, well over the threshold
        driver.query(
          `INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key, is_maintenance)
           VALUES (?, 'pending', 0, ?, ?, 0, NULL, 1)`,
          [JSON.stringify({ type: "rollup-product-usage", requestedBy: "test" }), now + 3_600_000, now],
        );
      }
      const staleCreatedAt = now - 61_000;
      driver.query(
        `INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key, is_maintenance)
         VALUES (?, 'pending', 0, 0, ?, 0, NULL, 1)`,
        [JSON.stringify({ type: "build-contributor-evidence", requestedBy: "schedule" }), staleCreatedAt],
      );
      await q.binding.send(msg("notify-evaluate"));
      await q.drain();
      expect(started).toContain("build-contributor-evidence"); // old job in the backlog: drained
      expect(started).not.toContain("notify-evaluate"); // fresh job in the SAME backlog: still deferred
      const freshRow = driver.query(
        "SELECT last_error FROM _selfhost_jobs WHERE payload LIKE '%notify-evaluate%'",
        [],
      ).rows[0] as { last_error: string };
      expect(freshRow.last_error).toContain("maintenance_pending_high");
      expect(await renderMetrics()).toContain(
        'loopover_jobs_maintenance_admission_granted_under_pressure_total{job_type="build-contributor-evidence",reason="maintenance_pending_high_drain"} 1',
      );
    });

    it("does not drain-admit when host load is ALSO high", async () => {
      process.env.MAINTENANCE_ADMISSION_DRAIN_AGE_MS = "60000";
      vi.mocked(hostLoadAvg1PerCore).mockReturnValue(5);
      const driver = makeDriver();
      const started: string[] = [];
      const q = createSqliteQueue(driver, async (m) => void started.push(typeOf(m)));
      const now = Date.now();
      for (let i = 0; i < 16; i += 1) {
        driver.query(
          `INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key, is_maintenance)
           VALUES (?, 'pending', 0, ?, ?, 0, NULL, 1)`,
          [JSON.stringify({ type: "rollup-product-usage", requestedBy: "test" }), now + 3_600_000, now],
        );
      }
      driver.query(
        `INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key, is_maintenance)
         VALUES (?, 'pending', 0, 0, ?, 0, NULL, 1)`,
        [JSON.stringify({ type: "build-contributor-evidence", requestedBy: "schedule" }), now - 61_000],
      );
      await q.drain();
      expect(started).not.toContain("build-contributor-evidence");
      const row = driver.query(
        "SELECT last_error FROM _selfhost_jobs WHERE payload LIKE '%build-contributor-evidence%'",
        [],
      ).rows[0] as { last_error: string };
      expect(row.last_error).toContain("host_load_high");
    });

    it("defers a maintenance job when host load per core exceeds the threshold", async () => {
      vi.mocked(hostLoadAvg1PerCore).mockReturnValue(5);
      const driver = makeDriver();
      const started: string[] = [];
      const q = createSqliteQueue(driver, async (m) => void started.push(typeOf(m)));
      await q.binding.send(msg("build-contributor-evidence"));
      await q.drain();
      expect(started).not.toContain("build-contributor-evidence");
      const row = driver.query(
        "SELECT last_error FROM _selfhost_jobs WHERE payload LIKE '%build-contributor-evidence%'",
        [],
      ).rows[0] as { last_error: string };
      expect(row.last_error).toContain("host_load_high");
    });

    it("admits unconditionally when MAINTENANCE_ADMISSION_ENABLED is disabled, even under high pressure", async () => {
      process.env.MAINTENANCE_ADMISSION_ENABLED = "false";
      const driver = makeDriver();
      const started: string[] = [];
      const q = createSqliteQueue(driver, async (m) => void started.push(typeOf(m)));
      seedLiveRows(driver, 6);
      await q.binding.send(msg("build-contributor-evidence"));
      await q.drain();
      expect(started).toEqual(["build-contributor-evidence"]);
    });

    it("force-admits via trickle once a maintenance job has waited past the max defer age, even under pressure", async () => {
      process.env.MAINTENANCE_ADMISSION_MAX_DEFER_AGE_MS = "60000"; // 1m (parsePositiveIntEnv floor)
      const driver = makeDriver();
      const started: string[] = [];
      const q = createSqliteQueue(driver, async (m) => void started.push(typeOf(m)));
      seedLiveRows(driver, 6);
      const staleCreatedAt = Date.now() - 61_000;
      driver.query(
        `INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key, is_maintenance)
         VALUES (?, 'pending', 0, 0, ?, 0, NULL, 1)`,
        [JSON.stringify({ type: "build-contributor-evidence", requestedBy: "schedule" }), staleCreatedAt],
      );
      await q.drain();
      expect(started).toEqual(["build-contributor-evidence"]);
      expect(await q.stats()).toMatchObject({ loopover_jobs_maintenance_trickle_admitted_total: 1 });
      const metrics = await renderMetrics();
      expect(metrics).toContain('loopover_jobs_maintenance_trickle_admitted_by_type_total{job_type="build-contributor-evidence"} 1');
      expect(metrics).toContain('loopover_jobs_maintenance_admission_granted_under_pressure_total{job_type="build-contributor-evidence",reason="trickle_max_defer_age"} 1');
    });

    it("does not record a trickle-admitted metric on a normal clear-pressure admission", async () => {
      const driver = makeDriver();
      const started: string[] = [];
      const q = createSqliteQueue(driver, async (m) => void started.push(typeOf(m)));
      await q.binding.send(msg("build-contributor-evidence"));
      await q.drain();
      expect(started).toEqual(["build-contributor-evidence"]);
      expect(await q.stats()).not.toHaveProperty("loopover_jobs_maintenance_trickle_admitted_total");
      expect(await renderMetrics()).not.toContain("loopover_jobs_maintenance_trickle_admitted");
    });

    it("does not record the granted-under-pressure metric for an ordinary pressure_clear admission", async () => {
      const driver = makeDriver();
      const started: string[] = [];
      const q = createSqliteQueue(driver, async (m) => void started.push(typeOf(m)));
      await q.binding.send(msg("build-contributor-evidence"));
      await q.drain();
      expect(started).toEqual(["build-contributor-evidence"]);
      expect(await renderMetrics()).not.toContain("loopover_jobs_maintenance_admission_granted_under_pressure_total");
    });

    it("pressureSignals() reports live/maintenance pending counts and oldest ages", async () => {
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined);
      seedLiveRows(driver, 2, "pending");
      const now = Date.now();
      driver.query(
        `INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key, is_maintenance)
         VALUES (?, 'pending', 0, ?, ?, 0, NULL, 1)`,
        [JSON.stringify({ type: "rollup-product-usage", requestedBy: "test" }), now + 3_600_000, now - 5_000],
      );
      const signals = await q.pressureSignals();
      expect(signals.livePendingCount).toBe(2);
      expect(signals.oldestLivePendingAgeMs).toBeGreaterThanOrEqual(0);
      expect(signals.maintenancePendingCount).toBe(1);
      expect(signals.oldestMaintenancePendingAgeMs).toBeGreaterThanOrEqual(5_000);
      expect(signals.hostLoadAvg1PerCore).toBeNull();
    });

    it("pressureSignals() reports null oldest ages when a lane has no pending work", async () => {
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined);
      const signals = await q.pressureSignals();
      expect(signals.livePendingCount).toBe(0);
      expect(signals.oldestLivePendingAgeMs).toBeNull();
      expect(signals.maintenancePendingCount).toBe(0);
      expect(signals.oldestMaintenancePendingAgeMs).toBeNull();
      expect(signals.backlogConvergencePendingCount).toBe(0);
      expect(signals.freshIntakePendingCount).toBe(0);
      // Zero foreground rows at all -- SQLite's SUM(CASE...)/MIN(CASE...) return NULL (not 0) over a zero-row
      // aggregate group, exercising the `?? 0` nullish arm on runnable_cnt (see maintenancePressureSignals).
      expect(signals.liveRunnableNowCount).toBe(0);
      expect(signals.oldestLiveRunnableAgeMs).toBeNull();
    });

    it("pressureSignals() reports the backlog-convergence lane pending count (#selfhost-backlog-convergence)", async () => {
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined);
      await q.binding.send({
        type: "agent-regate-pr",
        deliveryId: "backlog-convergence:owner/repo#1",
        repoFullName: "owner/repo",
        prNumber: 1,
        installationId: 1,
      } as unknown as JobMessage);
      // A fresh-intake row (foreground_lane='fresh') must NOT count toward the backlog-convergence signal.
      await q.binding.send(prWebhook("fresh-unrelated"));
      const signals = await q.pressureSignals();
      expect(signals.backlogConvergencePendingCount).toBe(1);
    });

    it("pressureSignals() reports the fresh-intake lane pending count (#selfhost-lane-observability)", async () => {
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined);
      await q.binding.send(prWebhook("fresh-1"));
      // A backlog-convergence row (foreground_lane='backlog') must NOT count toward the fresh-intake signal.
      await q.binding.send({
        type: "agent-regate-pr",
        deliveryId: "backlog-convergence:owner/repo#1",
        repoFullName: "owner/repo",
        prNumber: 1,
        installationId: 1,
      } as unknown as JobMessage);
      const signals = await q.pressureSignals();
      expect(signals.freshIntakePendingCount).toBe(1);
    });

    // #selfhost-queue-liveness: liveRunnableNowCount/oldestLiveRunnableAgeMs must reflect only the SUBSET of
    // live pending jobs that are currently DUE (run_after<=now) -- distinct from livePendingCount/
    // oldestLivePendingAgeMs, which are dominated by whatever row is OLDEST by created_at regardless of
    // whether it is runnable right now. Constructed so the OLDEST-by-created_at foreground row is NOT yet due
    // (a large future run_after) while a NEWER foreground row IS due -- the oldest-runnable age must come from
    // the newer, due row, not the older, not-due one.
    it("pressureSignals() reports the runnable-now subset distinctly from the overall oldest-pending age", async () => {
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined);
      const now = Date.now();
      // Oldest by created_at, but deferred far into the future -- NOT runnable now.
      driver.query(
        `INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key, is_maintenance)
         VALUES (?, 'pending', 0, ?, ?, 9, NULL, 0)`,
        [JSON.stringify(msg("agent-regate-pr")), now + 3_600_000, now - 500_000],
      );
      // Newer by created_at, but already due -- runnable right now.
      driver.query(
        `INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key, is_maintenance)
         VALUES (?, 'pending', 0, ?, ?, 9, NULL, 0)`,
        [JSON.stringify(msg("agent-regate-pr")), now - 1_000, now - 10_000],
      );
      const signals = await q.pressureSignals();
      expect(signals.livePendingCount).toBe(2);
      expect(signals.oldestLivePendingAgeMs).toBeGreaterThanOrEqual(500_000);
      expect(signals.liveRunnableNowCount).toBe(1);
      expect(signals.oldestLiveRunnableAgeMs).toBeGreaterThanOrEqual(10_000);
      expect(signals.oldestLiveRunnableAgeMs).toBeLessThan(signals.oldestLivePendingAgeMs as number);
    });

    it("pressureSignals() reports zero runnable-now with a null oldest-runnable age when foreground jobs exist but none are due yet", async () => {
      const driver = makeDriver();
      const q = createSqliteQueue(driver, async () => undefined);
      const now = Date.now();
      // Foreground rows exist (outer WHERE matches), but every one is deferred to the future -- the inner CASE
      // never matches, so SUM(CASE...) is a real 0 here (a set exists, just none due), a DIFFERENT code path
      // from the "zero foreground rows at all" NULL-aggregate case covered above.
      for (let i = 0; i < 3; i += 1) {
        driver.query(
          `INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key, is_maintenance)
           VALUES (?, 'pending', 0, ?, ?, 9, NULL, 0)`,
          [JSON.stringify(msg("agent-regate-pr")), now + 3_600_000, now - 60_000],
        );
      }
      const signals = await q.pressureSignals();
      expect(signals.livePendingCount).toBe(3);
      expect(signals.liveRunnableNowCount).toBe(0);
      expect(signals.oldestLiveRunnableAgeMs).toBeNull();
    });

    it("backfills the is_maintenance flag on startup for jobs enqueued by an older version", async () => {
      const driver = nodeSqliteDriver(new DatabaseSync(":memory:") as never);
      driver.exec(`
        CREATE TABLE _selfhost_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          run_after INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          last_error TEXT,
          priority INTEGER NOT NULL DEFAULT 0,
          job_key TEXT
        );
      `);
      driver.query(
        "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority) VALUES (?, 'pending', 0, 0, 0, 0)",
        [JSON.stringify(msg("build-contributor-evidence"))],
      );
      createSqliteQueue(driver, async () => undefined);
      const row = driver.query("SELECT is_maintenance FROM _selfhost_jobs", []).rows[0] as { is_maintenance: number };
      expect(Number(row.is_maintenance)).toBe(1);
    });

    it("does not crash the startup backfill on an unparseable pending payload", async () => {
      const driver = makeDriver();
      const q1 = createSqliteQueue(driver, async () => undefined); // creates the table
      await q1.stop();
      driver.query(
        "INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority) VALUES (?, 'pending', 0, 0, 0, 0)",
        ["not valid json"],
      );
      expect(() => createSqliteQueue(driver, async () => undefined)).not.toThrow();
      const row = driver.query(
        "SELECT is_maintenance FROM _selfhost_jobs WHERE payload = ?",
        ["not valid json"],
      ).rows[0] as { is_maintenance: number };
      expect(Number(row.is_maintenance)).toBe(0);
    });

    it("leaves an already-correct is_maintenance flag alone (backfill no-op branch)", async () => {
      const driver = makeDriver();
      const q1 = createSqliteQueue(driver, async () => undefined);
      await q1.binding.send(msg("build-contributor-evidence"));
      await q1.stop();
      // Re-open a queue over the same driver: the row's is_maintenance is already correct (set 1 at enqueue),
      // so the startup backfill should count it as unchanged.
      const writes: string[] = [];
      vi.mocked(process.stdout.write).mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });
      createSqliteQueue(driver, async () => undefined);
      expect(writes.some((w) => w.includes("selfhost_queue_maintenance_flags_backfilled"))).toBe(false);
    });

    it("defers a maintenance job with no job_key (a raw/legacy row) using an empty jitter seed segment", async () => {
      const driver = makeDriver();
      const started: string[] = [];
      const q = createSqliteQueue(driver, async (m) => void started.push(typeOf(m)));
      seedLiveRows(driver, 6);
      const before = Date.now();
      driver.query(
        `INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key, is_maintenance)
         VALUES (?, 'pending', 0, 0, ?, 0, NULL, 1)`,
        [JSON.stringify({ type: "build-contributor-evidence", requestedBy: "test" }), before],
      );
      await q.drain();
      expect(started).not.toContain("build-contributor-evidence");
      const row = driver.query(
        "SELECT run_after FROM _selfhost_jobs WHERE payload LIKE '%build-contributor-evidence%'",
        [],
      ).rows[0] as { run_after: number };
      expect(row.run_after).toBeGreaterThan(before);
    });

    it("skips the maintenance-admission-deferred metric when the defer update changes no rows", async () => {
      const base = makeDriver();
      const driver = {
        exec: base.exec.bind(base),
        query: vi.fn((sql: string, params: unknown[]) => {
          if (sql.includes("SET status='pending', run_after=max(run_after, ?), last_error=coalesce(last_error, ?)")) {
            return { rows: [], changes: 0 };
          }
          return base.query(sql, params);
        }),
      } as ReturnType<typeof nodeSqliteDriver>;
      const started: string[] = [];
      const q = createSqliteQueue(driver, async (m) => void started.push(typeOf(m)));
      seedLiveRows(driver, 6);
      await q.binding.send(msg("build-contributor-evidence"));
      await q.drain();
      expect(started).not.toContain("build-contributor-evidence");
      expect(await q.stats()).not.toHaveProperty("loopover_jobs_maintenance_admission_deferred_total");
      expect(await renderMetrics()).not.toContain("loopover_jobs_maintenance_admission_deferred_by_reason_total");
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
    // q.binding.send(...) computes real priority via jobPriority(), so (unlike a hand-built mock row) every job
    // here carries an authentic priority value.

    it("a second concurrent background job for the SAME installation is deferred at the limit", async () => {
      process.env.GITHUB_INSTALLATION_CONCURRENCY_LIMIT = "1";
      const driver = makeDriver();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started = 0;
      const q = createSqliteQueue(
        driver,
        async () => {
          started++;
          await gate;
        },
        { concurrency: 2, backgroundConcurrency: 2, pollIntervalMs: 100_000 },
      );
      await q.binding.send({ type: "backfill-repo-segment", installationId: 42, repoFullName: "owner/a" } as unknown as JobMessage);
      // The second (to-be-deferred) row is inserted directly with job_key=NULL (a raw/legacy shape) --
      // q.binding.send() would compute a real jobCoalesceKey for this type, which would never exercise the
      // `job.job_key ?? ""` jitter-seed fallback's nullish arm.
      driver.query(
        `INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key, is_maintenance)
         VALUES (?, 'pending', 0, 0, ?, 0, NULL, 0)`,
        [JSON.stringify({ type: "backfill-repo-segment", installationId: 42, repoFullName: "owner/b" }), Date.now()],
      );
      try {
        q.start();
        for (let i = 0; i < 20 && started < 1; i += 1) await new Promise((r) => setTimeout(r, 10));
        await new Promise((r) => setTimeout(r, 30));
        expect(started).toBe(1);
        const row = driver.query(
          "SELECT last_error FROM _selfhost_jobs WHERE status='pending' AND payload LIKE '%backfill-repo-segment%'",
          [],
        ).rows[0] as { last_error: string } | undefined;
        expect(row?.last_error).toContain("installation concurrency admission deferred: concurrency_high");
        expect(await renderMetrics()).toContain(
          'loopover_jobs_installation_concurrency_deferred_by_reason_total{job_type="backfill-repo-segment",reason="concurrency_high"} 1',
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
      const driver = makeDriver();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started = 0;
      const q = createSqliteQueue(
        driver,
        async () => {
          started++;
          await gate;
        },
        { concurrency: 2, backgroundConcurrency: 2, pollIntervalMs: 100_000 },
      );
      await q.binding.send({ type: "agent-regate-sweep", installationId: 42, repoFullName: "owner/a" } as unknown as JobMessage);
      await q.binding.send({ type: "agent-regate-sweep", installationId: 42, repoFullName: "owner/b" } as unknown as JobMessage);
      try {
        q.start();
        for (let i = 0; i < 20 && started < 1; i += 1) await new Promise((r) => setTimeout(r, 10));
        await new Promise((r) => setTimeout(r, 30));
        expect(started).toBe(1);
        const row = driver.query(
          "SELECT last_error FROM _selfhost_jobs WHERE status='pending' AND payload LIKE '%agent-regate-sweep%'",
          [],
        ).rows[0] as { last_error: string } | undefined;
        expect(row?.last_error).toContain("installation concurrency admission deferred: concurrency_high");
        expect(await renderMetrics()).toContain(
          'loopover_jobs_installation_concurrency_deferred_by_reason_total{job_type="agent-regate-sweep",reason="concurrency_high"} 1',
        );
      } finally {
        release();
        await q.stop();
      }
    });

    it("a background job for a DIFFERENT installation is admitted concurrently with one already at its own limit", async () => {
      process.env.GITHUB_INSTALLATION_CONCURRENCY_LIMIT = "1";
      const driver = makeDriver();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let concurrent = 0;
      let maxConcurrent = 0;
      const q = createSqliteQueue(
        driver,
        async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await gate;
          concurrent--;
        },
        { concurrency: 2, backgroundConcurrency: 2, pollIntervalMs: 100_000 },
      );
      await q.binding.send({ type: "backfill-repo-segment", installationId: 42, repoFullName: "owner/a" } as unknown as JobMessage);
      await q.binding.send({ type: "backfill-repo-segment", installationId: 99, repoFullName: "owner/b" } as unknown as JobMessage);
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
      const driver = makeDriver();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const seen: string[] = [];
      const q = createSqliteQueue(
        driver,
        async (j) => {
          seen.push(typeOf(j));
          if (typeOf(j) === "backfill-repo-segment") await gate;
        },
        { concurrency: 2, backgroundConcurrency: 2, pollIntervalMs: 100_000 },
      );
      await q.binding.send({ type: "backfill-repo-segment", installationId: 42, repoFullName: "owner/a" } as unknown as JobMessage);
      await q.binding.send(regateJob(42, 1630));
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
      const driver = makeDriver();
      const seen: string[] = [];
      const q = createSqliteQueue(driver, async (m) => void seen.push(typeOf(m)), { backgroundConcurrency: 1 });
      await q.binding.send({ type: "backfill-repo-segment", installationId: 42, repoFullName: "owner/a" } as unknown as JobMessage);
      await q.drain();
      expect(seen).toEqual(["backfill-repo-segment"]);

      await q.binding.send({ type: "backfill-repo-segment", installationId: 42, repoFullName: "owner/b" } as unknown as JobMessage);
      await q.drain();
      expect(seen).toEqual(["backfill-repo-segment", "backfill-repo-segment"]);
    });

    it("skips the installation-concurrency-deferred metric when the defer update changes no rows", async () => {
      process.env.GITHUB_INSTALLATION_CONCURRENCY_LIMIT = "1";
      const base = makeDriver();
      // The row raced out from under this UPDATE (already claimed/mutated by another path) -- mirrors the
      // maintenance-admission "changes no rows" test above, which intercepts the identical UPDATE shape.
      const driver = {
        exec: base.exec.bind(base),
        query: vi.fn((sql: string, params: unknown[]) => {
          if (sql.includes("SET status='pending', run_after=max(run_after, ?), last_error=coalesce(last_error, ?)")) {
            return { rows: [], changes: 0 };
          }
          return base.query(sql, params);
        }),
      } as ReturnType<typeof nodeSqliteDriver>;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started = 0;
      const q = createSqliteQueue(
        driver,
        async () => {
          started++;
          await gate;
        },
        { concurrency: 2, backgroundConcurrency: 2, pollIntervalMs: 100_000 },
      );
      await q.binding.send({ type: "backfill-repo-segment", installationId: 42, repoFullName: "owner/a" } as unknown as JobMessage);
      driver.query(
        `INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at, priority, job_key, is_maintenance)
         VALUES (?, 'pending', 0, 0, ?, 0, NULL, 0)`,
        [JSON.stringify({ type: "backfill-repo-segment", installationId: 42, repoFullName: "owner/b" }), Date.now()],
      );
      try {
        q.start();
        for (let i = 0; i < 20 && started < 1; i += 1) await new Promise((r) => setTimeout(r, 10));
        await new Promise((r) => setTimeout(r, 30));
        expect(started).toBe(1);
        expect(await renderMetrics()).not.toContain("loopover_jobs_installation_concurrency_deferred_total");
        expect(await renderMetrics()).not.toContain("loopover_jobs_installation_concurrency_deferred_by_reason_total");
      } finally {
        release();
        await q.stop();
      }
    });
  });
});
