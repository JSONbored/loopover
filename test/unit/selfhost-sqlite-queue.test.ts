import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nodeSqliteDriver } from "../../src/selfhost/d1-adapter";
import { createSqliteQueue } from "../../src/selfhost/sqlite-queue";
import { queueSnapshotFromBinding } from "../../src/selfhost/queue-common";
import { renderMetrics, resetMetrics } from "../../src/selfhost/metrics";
import { RetryableJobError } from "../../src/queue/retryable";
import type { JobMessage } from "../../src/types";

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
  });

  it("persists + drains FIFO through the consumer", async () => {
    const driver = makeDriver();
    const seen: string[] = [];
    const q = createSqliteQueue(driver, async (m) => void seen.push(typeOf(m)));
    await q.binding.send(msg("a"));
    await q.binding.send(msg("b"));
    await q.drain();
    expect(seen).toEqual(["a", "b"]);
    expect(q.size()).toBe(0);
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
         VALUES (?, ?, NULL, 'rest', ?, 200, 5000, 120, ?, ?)`,
        ["rl-bg-legacy", "owner/repo", "/x", "2026-06-24T12:10:00.000Z", "2026-06-24T12:00:00.000Z"],
      );
      const seen: string[] = [];
      const q = createSqliteQueue(driver, async (m) => void seen.push(typeOf(m)));

      await q.binding.send({ type: "agent-regate-pr", deliveryId: "sweep:owner/repo#7", repoFullName: "owner/repo", prNumber: 7, installationId: 123 });
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
      expect(q.stats()).toMatchObject({ gittensory_jobs_rate_limit_deferred_total: 2 });
      const metrics = await renderMetrics();
      expect(metrics).toContain('gittensory_jobs_rate_limit_admission_deferred_total{job_type="agent-regate-pr",key_scope="installation",kind="background"} 1');
      expect(metrics).toContain('gittensory_jobs_rate_limit_admission_deferred_total{job_type="rag-index-repo",key_scope="unknown",kind="background"} 1');
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
      expect(q.stats()).toMatchObject({ gittensory_jobs_rate_limit_deferred_total: 1 });
      expect(await renderMetrics()).toContain('gittensory_jobs_rate_limit_admission_deferred_total{job_type="github-webhook",key_scope="installation",kind="webhook"} 1');
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

      expect(q.stats()).not.toHaveProperty("gittensory_jobs_rate_limit_deferred_total");
      expect(await renderMetrics()).not.toContain("gittensory_jobs_rate_limit_admission_deferred_total");
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

  it("pre-yields from legacy repo exhaustion before older healthy exact observations", async () => {
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

  it("does not keep webhook admission closed from stale exact rows after a newer healthy legacy observation", async () => {
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

      expect(seen).toEqual(["github-webhook"]);
      expect(q.stats()).not.toHaveProperty("gittensory_jobs_rate_limit_deferred_total");
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
    expect(q.stats()).not.toHaveProperty("gittensory_jobs_rate_limit_deferred_total");
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
    expect(q.stats()).not.toHaveProperty("gittensory_jobs_rate_limit_deferred_total");
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
    expect(q.stats()).not.toHaveProperty("gittensory_jobs_rate_limit_deferred_total");
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
      expect(q.stats()).not.toHaveProperty("gittensory_jobs_rate_limit_deferred_total");
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
    expect(q.stats()).toMatchObject({
      gittensory_jobs_enqueued_total: 3,
      gittensory_jobs_coalesced_total: 3,
    });
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

    const snapshot = q.snapshot();
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

    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.job_key)).toEqual([
      "backfill-registered-repos:jsonbored/gittensory:resume:1",
      "backfill-registered-repos:jsonbored/gittensory:light:1",
      "generate-weekly-value-report:operator:7",
      "generate-weekly-value-report:public:7",
      "rag-index-repo:jsonbored/gittensory:sha256:170cb2cfb288ab59ba4d35b2633120223c9acc6893fd5baec3465c434ad5bedf",
      "rag-index-repo:jsonbored/gittensory:sha256:f4f9970f7a842b1b7b619cbd49f05da577a7d725ff1616ba2de8beed1ae5616f",
    ]);
    expect(rows.map((row) => JSON.parse(row.payload).requestedBy)).toEqual([
      "api",
      "api",
      "api",
      "api",
      "schedule",
      "schedule",
    ]);
    expect(q.stats()).toMatchObject({
      gittensory_jobs_enqueued_total: 6,
      gittensory_jobs_coalesced_total: 3,
    });
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
    ).toEqual(["status", "run_after", "priority"]);
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
    ).toEqual(["status", "run_after", "priority"]);
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
    expect(q.deadCount()).toBe(1);
    expect(q.size()).toBe(0);
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
    expect(q.deadCount()).toBe(0);
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
    expect(q.stats()).toMatchObject({
      gittensory_jobs_failed_total: 2,
      gittensory_jobs_dead_total: 1,
    });
    expect(q.stats()).not.toHaveProperty("gittensory_jobs_rate_limited_total");
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
    expect(q.stats()).toMatchObject({ gittensory_jobs_rate_limited_total: 1 });
    expect(q.stats()).not.toHaveProperty("gittensory_jobs_rate_limit_deferred_total");
    expect(await renderMetrics()).toContain('gittensory_jobs_rate_limited_by_type_total{job_type="refresh-registry",key_scope="unknown",kind="unknown"} 1');
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
    expect(seen).toEqual(["blocked-installation", "other-installation", "local-cleanup"]);
    expect(rows).toHaveLength(3);
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
    expect(byType.get("agent-regate-pr:10")?.last_error).toBe("github rate-limit budget deferred");
    expect(q.stats()).toMatchObject({
      gittensory_jobs_processed_total: 2,
      gittensory_jobs_rate_limited_total: 1,
      gittensory_jobs_rate_limit_deferred_total: 2,
    });
    const metrics = await renderMetrics();
    expect(metrics).toContain('gittensory_jobs_rate_limit_budget_deferred_total{job_type="github-webhook",key_scope="installation",kind="webhook"} 2');
    expect(metrics).toContain('gittensory_jobs_rate_limited_by_type_total{job_type="github-webhook",key_scope="installation",kind="webhook"} 1');
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
    expect(q.stats()).toMatchObject({ gittensory_jobs_coalesced_total: 1 });
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
    expect(q.stats()).toMatchObject({ gittensory_jobs_rate_limited_total: 1 });
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
    expect(q.deadCount()).toBe(0);
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
    expect(q.deadCount()).toBe(1);
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
    expect(q.stats().gittensory_jobs_coalesced_total ?? 0).toBe(0);
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
      expect(q.stats().gittensory_jobs_recovered_total ?? 0).toBe(0);
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
      expect(q.stats()).toMatchObject({
        gittensory_jobs_recovered_total: 1,
        gittensory_jobs_processed_total: 1,
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
      expect(queue.stats().gittensory_jobs_recovered_total ?? 0).toBe(0);
    } finally {
      for (const release of releases) release();
      if (q) await q.stop();
      if (oldTimeout === undefined) delete process.env.QUEUE_PROCESSING_TIMEOUT_MS;
      else process.env.QUEUE_PROCESSING_TIMEOUT_MS = oldTimeout;
      if (oldRecoveryJitter === undefined) delete process.env.QUEUE_RECOVERY_JITTER_MS;
      else process.env.QUEUE_RECOVERY_JITTER_MS = oldRecoveryJitter;
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
    expect(q.deadCount()).toBe(1);
  });

  it("dead-letters an unparseable payload", async () => {
    const driver = makeDriver();
    const q = createSqliteQueue(driver, async () => undefined);
    driver.query("INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at) VALUES ('not-json','pending',0,0,0)", []);
    await q.drain();
    expect(q.deadCount()).toBe(1);
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
    expect(q2.size()).toBe(1);
  });

  it("stop() is a no-op when start() was never called (timer is null)", async () => {
    const q = createSqliteQueue(makeDriver(), async () => undefined);
    await q.stop(); // timer=null → the false branch of `if (timer) clearTimeout(timer)` is taken
    expect(q.size()).toBe(0); // still usable after a spurious stop()
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
    expect(q.size()).toBe(0);
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
    expect(q.size()).toBe(0);
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
});
