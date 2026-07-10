import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { recordGitHubRateLimitObservation } from "../../src/db/repositories";
import { scheduledEnqueueDelaySeconds } from "../../src/selfhost/queue-common";
import { createTestEnv } from "../helpers/d1";

describe("worker entrypoint", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("delegates fetch requests to the Hono app", async () => {
    const env = createTestEnv();
    const response = await worker.fetch(new Request("https://gittensory.test/health"), env);
    expect(response.status).toBe(200);
  });

  it("routes gittensory-jobs-dlq batches to the DLQ consumer (acks without retrying)", async () => {
    const env = createTestEnv();
    const acked: string[] = [];
    const retried: string[] = [];
    const batch = {
      queue: "gittensory-jobs-dlq",
      messages: [
        {
          id: "dlq-msg-1",
          body: { type: "github-webhook", deliveryId: "d-dlq", eventName: "pull_request", payload: {} },
          ack: () => acked.push("dlq-msg-1"),
          retry: () => retried.push("dlq-msg-1"),
        },
      ],
    } as unknown as MessageBatch<import("../../src/types").JobMessage>;

    await worker.queue(batch, env);

    expect(acked).toEqual(["dlq-msg-1"]);
    expect(retried).toEqual([]);
  });

  it("routes the webhook lane's gittensory-webhooks-dlq batches to the DLQ consumer too (#1276)", async () => {
    const env = createTestEnv();
    const acked: string[] = [];
    const retried: string[] = [];
    const batch = {
      queue: "gittensory-webhooks-dlq",
      messages: [
        {
          id: "wh-dlq-1",
          body: { type: "github-webhook", deliveryId: "d-wh-dlq", eventName: "pull_request", payload: {}, redriven: true },
          ack: () => acked.push("wh-dlq-1"),
          retry: () => retried.push("wh-dlq-1"),
        },
      ],
    } as unknown as MessageBatch<import("../../src/types").JobMessage>;

    await worker.queue(batch, env);

    expect(acked).toEqual(["wh-dlq-1"]); // handled by processDlqBatch (endsWith "-dlq"), not the processJob loop
    expect(retried).toEqual([]);
  });

  it("does not re-drive webhook DLQ messages from a broker-only Cloudflare runtime", async () => {
    const env = createTestEnv();
    delete env.SELFHOST_TRANSIENT_CACHE;
    const sent: import("../../src/types").JobMessage[] = [];
    env.WEBHOOKS = { send: async (message: import("../../src/types").JobMessage) => void sent.push(message) } as unknown as Queue;
    const acked: string[] = [];
    const batch = {
      queue: "gittensory-webhooks-dlq",
      messages: [
        {
          id: "wh-dlq-broker-only",
          body: { type: "github-webhook", deliveryId: "d-broker-only", eventName: "pull_request", payload: {} },
          ack: () => acked.push("wh-dlq-broker-only"),
          retry: () => undefined,
        },
      ],
    } as unknown as MessageBatch<import("../../src/types").JobMessage>;

    await worker.queue(batch, env);

    expect(acked).toEqual(["wh-dlq-broker-only"]);
    expect(sent).toEqual([]);
  });

  it("acks and ignores stale review-execution jobs from a broker-only Cloudflare runtime", async () => {
    const env = createTestEnv();
    delete env.SELFHOST_TRANSIENT_CACHE;
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const acked: string[] = [];
    const retried: string[] = [];
    const batch = {
      messages: [
        {
          id: "hosted-review-job",
          body: { type: "github-webhook", deliveryId: "d-hosted-review", eventName: "pull_request", payload: {} },
          ack: () => acked.push("hosted-review-job"),
          retry: () => retried.push("hosted-review-job"),
        },
      ],
    } as unknown as MessageBatch<import("../../src/types").JobMessage>;

    await worker.queue(batch, env);

    expect(acked).toEqual(["hosted-review-job"]);
    expect(retried).toEqual([]);
    expect(JSON.parse(String(warned.mock.calls[0]?.[0]))).toMatchObject({
      event: "retired_review_job_ignored",
      jobType: "github-webhook",
    });
  });

  it("acks successful queue messages and retries failed messages", async () => {
    const env = createTestEnv();
    vi.stubGlobal("fetch", async () => new Response("missing", { status: 404 }));
    const acked: string[] = [];
    const retried: string[] = [];
    const batch = {
      messages: [
        {
          id: "ok",
          body: { type: "refresh-installation-health", requestedBy: "test" },
          ack: () => acked.push("ok"),
          retry: () => retried.push("ok"),
        },
        {
          id: "bad",
          body: { type: "refresh-registry", requestedBy: "test" },
          ack: () => acked.push("bad"),
          retry: () => retried.push("bad"),
        },
      ],
    } as unknown as MessageBatch<import("../../src/types").JobMessage>;

    await worker.queue(batch, env);
    expect(acked).toEqual(["ok"]);
    expect(retried).toEqual(["bad"]);
  });

  it("retries a failed job AFTER the rate-limit reset when the shared REST budget is exhausted (#audit-rate-headroom)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const env = createTestEnv();
    await recordGitHubRateLimitObservation(env, { repoFullName: "owner/repo", resource: "rest", path: "/x", statusCode: 200, limitValue: 5000, remaining: 5, resetAt: "2026-06-24T12:30:00.000Z", observedAt: "2026-06-24T12:00:00.000Z" });
    vi.stubGlobal("fetch", async () => new Response("missing", { status: 404 }));
    const retries: Array<{ delaySeconds?: number } | undefined> = [];
    const batch = {
      messages: [
        {
          id: "bad",
          body: { type: "refresh-registry", requestedBy: "test" },
          ack: () => undefined,
          retry: (options?: { delaySeconds?: number }) => retries.push(options),
        },
      ],
    } as unknown as MessageBatch<import("../../src/types").JobMessage>;

    await worker.queue(batch, env);

    expect(retries).toHaveLength(1);
    expect(retries[0]?.delaySeconds).toBe(900); // re-queued after the reset, not retried immediately
    vi.useRealTimers();
  });

  it("pre-yields GitHub-budget background queue jobs while preserving retry budget", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const env = createTestEnv();
    // Scoped to this job's own installation bucket (#audit-rate-scoping) — installationId 123 below.
    await recordGitHubRateLimitObservation(env, { repoFullName: "owner/repo", admissionKey: "installation:123", resource: "rest", path: "/x", statusCode: 200, limitValue: 5000, remaining: 120, resetAt: "2026-06-24T12:10:00.000Z", observedAt: "2026-06-24T12:00:00.000Z" });
    const acked: string[] = [];
    const retries: Array<{ delaySeconds?: number } | undefined> = [];
    const requeued: Array<{ message: import("../../src/types").JobMessage; delaySeconds?: number }> = [];
    env.JOBS = {
      async send(message: import("../../src/types").JobMessage, options?: { delaySeconds?: number }) {
        requeued.push({ message, ...(options?.delaySeconds === undefined ? {} : { delaySeconds: options.delaySeconds }) });
      },
    } as unknown as Queue;
    const batch = {
      messages: [
        {
          id: "background-regate",
          body: { type: "agent-regate-pr", deliveryId: "sweep:owner/repo#7", repoFullName: "owner/repo", prNumber: 7, installationId: 123 },
          ack: () => acked.push("background-regate"),
          retry: (options?: { delaySeconds?: number }) => retries.push(options),
        },
      ],
    } as unknown as MessageBatch<import("../../src/types").JobMessage>;

    await worker.queue(batch, env);

    expect(acked).toEqual(["background-regate"]);
    expect(retries).toEqual([]);
    expect(requeued).toEqual([
      {
        message: {
          type: "agent-regate-pr",
          deliveryId: "sweep:owner/repo#7",
          repoFullName: "owner/repo",
          prNumber: 7,
          installationId: 123,
        },
        delaySeconds: 615,
      },
    ]);
    vi.useRealTimers();
  });

  it("continues GitHub-budget background queue jobs when the observation read fails", async () => {
    const env = createTestEnv();
    env.DB = {
      ...env.DB,
      prepare() {
        throw new Error("rate-limit observation read failed");
      },
    } as unknown as D1Database;
    const acked: string[] = [];
    const retries: Array<{ delaySeconds?: number } | undefined> = [];
    const batch = {
      messages: [
        {
          id: "background-rag",
          body: { type: "rag-index-repo", requestedBy: "schedule" },
          ack: () => acked.push("background-rag"),
          retry: (options?: { delaySeconds?: number }) => retries.push(options),
        },
      ],
    } as unknown as MessageBatch<import("../../src/types").JobMessage>;

    await worker.queue(batch, env);

    expect(acked).toEqual(["background-rag"]);
    expect(retries).toEqual([]);
  });

  it("INVARIANT (#4505): pre-yields a reconcile-open-prs job while the shared GitHub REST budget is exhausted", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const env = createTestEnv();
    // reconcile-open-prs has no per-installation field, so it draws from the SAME shared (no-admissionKey)
    // observation refresh-registry's own equivalent test above uses.
    await recordGitHubRateLimitObservation(env, { repoFullName: "owner/repo", resource: "rest", path: "/x", statusCode: 200, limitValue: 5000, remaining: 5, resetAt: "2026-06-24T12:30:00.000Z", observedAt: "2026-06-24T12:00:00.000Z" });
    const acked: string[] = [];
    const retries: Array<{ delaySeconds?: number } | undefined> = [];
    const requeued: Array<{ message: import("../../src/types").JobMessage; delaySeconds?: number }> = [];
    env.JOBS = {
      async send(message: import("../../src/types").JobMessage, options?: { delaySeconds?: number }) {
        requeued.push({ message, ...(options?.delaySeconds === undefined ? {} : { delaySeconds: options.delaySeconds }) });
      },
    } as unknown as Queue;
    const batch = {
      messages: [
        {
          id: "reconcile-tick",
          body: { type: "reconcile-open-prs", requestedBy: "schedule" },
          ack: () => acked.push("reconcile-tick"),
          retry: (options?: { delaySeconds?: number }) => retries.push(options),
        },
      ],
    } as unknown as MessageBatch<import("../../src/types").JobMessage>;

    await worker.queue(batch, env);

    // Pre-yielded, not run: acked (not retried, preserving retry budget) and re-queued after the reset --
    // BEFORE this fix, reconcile-open-prs was missing from GITHUB_BUDGET_BACKGROUND_TYPES, so this exhausted
    // budget would have been silently ignored and runOpenPrReconciliation would have run immediately.
    expect(acked).toEqual(["reconcile-tick"]);
    expect(retries).toEqual([]);
    expect(requeued).toEqual([{ message: { type: "reconcile-open-prs", requestedBy: "schedule" }, delaySeconds: 900 }]); // delayUntil clamps to [30, 900]
    vi.useRealTimers();
  });

  it("REGRESSION (#4506): pre-yields the whole refresh-installation-health job -- zero per-installation fetches -- while the shared GitHub REST budget is exhausted", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const env = createTestEnv();
    // refresh-installation-health carries no installationId (it loops over every installation internally), so
    // githubRateLimitAdmissionKeyForJob resolves it to `null` -- its dequeue-time check reads the unscoped
    // (admissionKey: undefined) latest-observations window, which any recent exhausted REST observation trips.
    await recordGitHubRateLimitObservation(env, { repoFullName: null, admissionKey: "installation:1", resource: "rest", path: "/app/installations/1", statusCode: 200, limitValue: 5000, remaining: 5, resetAt: "2026-06-24T12:30:00.000Z", observedAt: "2026-06-24T12:00:00.000Z" });
    const fetchCalls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      fetchCalls.push(input.toString());
      return new Response("unexpected fetch", { status: 500 });
    });
    const acked: string[] = [];
    const retries: Array<{ delaySeconds?: number } | undefined> = [];
    const requeued: Array<{ message: import("../../src/types").JobMessage; delaySeconds?: number }> = [];
    env.JOBS = {
      async send(message: import("../../src/types").JobMessage, options?: { delaySeconds?: number }) {
        requeued.push({ message, ...(options?.delaySeconds === undefined ? {} : { delaySeconds: options.delaySeconds }) });
      },
    } as unknown as Queue;
    const batch = {
      messages: [
        {
          id: "installation-health-tick",
          body: { type: "refresh-installation-health", requestedBy: "schedule" },
          ack: () => acked.push("installation-health-tick"),
          retry: (options?: { delaySeconds?: number }) => retries.push(options),
        },
      ],
    } as unknown as MessageBatch<import("../../src/types").JobMessage>;

    await worker.queue(batch, env);

    // Pre-yielded before refreshInstallationHealthRecords' per-installation loop ever starts -- proving the
    // dequeue-time gate defers the ENTIRE job (not just individual calls within it) when the budget is exhausted,
    // regardless of how many installations it would otherwise have fetched.
    expect(fetchCalls).toEqual([]);
    expect(acked).toEqual(["installation-health-tick"]);
    expect(retries).toEqual([]);
    expect(requeued).toEqual([{ message: { type: "refresh-installation-health", requestedBy: "schedule" }, delaySeconds: 900 }]); // delayUntil clamps to [30, 900]
    vi.useRealTimers();
  });

  it("runs scheduled jobs through waitUntil", async () => {
    const env = createTestEnv();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("master_repositories.json")) return Response.json({});
      if (url.includes("api.gittensor.io") || url.includes("mirror.gittensor.io")) return new Response("missing", { status: 404 });
      return Response.json([]);
    });
    const waitUntil: Promise<unknown>[] = [];
    await worker.scheduled(
      {} as ScheduledController,
      env,
      {
        waitUntil: (promise: Promise<unknown>) => {
          waitUntil.push(promise);
        },
        passThroughOnException: () => {},
        exports: {},
        props: {},
      } as unknown as ExecutionContext,
    );
    await Promise.allSettled(waitUntil);
    expect(waitUntil).toHaveLength(1);
  });

  it("enqueues only the light auto-maintain sweep on a regular tick (not :00 or :30)", async () => {
    const sent: Array<import("../../src/types").JobMessage> = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    const waitUntil: Promise<unknown>[] = [];

    await worker.scheduled(controllerFor("2026-05-25T05:14:00.000Z"), env, executionContext(waitUntil));
    await Promise.all(waitUntil);

    // A regular */2 tick (not :00, not :30) enqueues ONLY the light auto-maintain sweep — the heavier sync/health
    // jobs are gated to :00/:30, so the tight cadence stays cheap while merges/closes fire promptly.
    expect(sent).toEqual([{ type: "agent-regate-sweep", requestedBy: "schedule" }]);
  });

  it("keeps enqueueing scheduled sweeps while prior per-PR regate jobs are queued (#2119)", async () => {
    // Per-PR "agent-regate-pr" backlog is normal, expected, ongoing work (staggered/rate-deferred re-reviews) —
    // it must NOT block the next scheduled fan-out trigger, or the sweep starves under any sustained load.
    const sent: Array<import("../../src/types").JobMessage> = [];
    let snapshotCalled = false;
    const env = createTestEnv({
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
        snapshot: async () => {
          snapshotCalled = true;
          return {
            totals: { pending: 2, processing: 0, dead: 0, due: 2 },
            byType: [{ type: "agent-regate-pr", status: "pending", count: 2, due: 2 }],
          };
        },
      } as unknown as Queue,
    });
    const waitUntil: Promise<unknown>[] = [];

    await worker.scheduled(controllerFor("2026-05-25T05:30:00.000Z"), env, executionContext(waitUntil));
    await Promise.all(waitUntil);

    expect(sent).toEqual([
      { type: "agent-regate-sweep", requestedBy: "schedule" },
      { type: "backfill-registered-repos", requestedBy: "schedule", mode: "light" },
      { type: "repair-data-fidelity", requestedBy: "schedule" },
      { type: "refresh-installation-health", requestedBy: "schedule" },
      { type: "backlog-convergence-sweep", requestedBy: "schedule" },
    ]);
    expect(snapshotCalled).toBe(true);
  });

  it("defers a new sweep trigger while a prior one is still pending or processing (#2119, #audit-sweep-fanout)", async () => {
    const sent: Array<import("../../src/types").JobMessage> = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
        snapshot: async () => ({
          totals: { pending: 0, processing: 1, dead: 0, due: 0 },
          byType: [{ type: "agent-regate-sweep", status: "processing", count: 1, due: 0 }],
        }),
      } as unknown as Queue,
    });
    const waitUntil: Promise<unknown>[] = [];

    await worker.scheduled(controllerFor("2026-05-25T05:30:00.000Z"), env, executionContext(waitUntil));
    await Promise.all(waitUntil);

    // No SECOND "agent-regate-sweep" trigger is enqueued behind the one already in flight; the other :30 jobs
    // are unaffected since they never depended on the (removed, broad) backlog check.
    expect(sent).toEqual([
      { type: "backfill-registered-repos", requestedBy: "schedule", mode: "light" },
      { type: "repair-data-fidelity", requestedBy: "schedule" },
      { type: "refresh-installation-health", requestedBy: "schedule" },
      { type: "backlog-convergence-sweep", requestedBy: "schedule" },
    ]);
  });

  it("INVARIANT (#4502): defers a new backlog-convergence-sweep trigger while a prior one is still pending or processing", async () => {
    const sent: Array<import("../../src/types").JobMessage> = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
        snapshot: async () => ({
          totals: { pending: 0, processing: 1, dead: 0, due: 0 },
          byType: [{ type: "backlog-convergence-sweep", status: "processing", count: 1, due: 0 }],
        }),
      } as unknown as Queue,
    });
    const waitUntil: Promise<unknown>[] = [];

    await worker.scheduled(controllerFor("2026-05-25T05:30:00.000Z"), env, executionContext(waitUntil));
    await Promise.all(waitUntil);

    // No SECOND "backlog-convergence-sweep" trigger is enqueued behind the one already in flight; the other :30
    // jobs (including agent-regate-sweep, whose OWN backlog is unaffected) still fire normally.
    expect(sent).toEqual([
      { type: "agent-regate-sweep", requestedBy: "schedule" },
      { type: "backfill-registered-repos", requestedBy: "schedule", mode: "light" },
      { type: "repair-data-fidelity", requestedBy: "schedule" },
      { type: "refresh-installation-health", requestedBy: "schedule" },
    ]);
  });

  it("does not require queue introspection for regular review sweep scheduling", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sent: Array<import("../../src/types").JobMessage> = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
        snapshot: async () => {
          throw new Error("snapshot unavailable");
        },
      } as unknown as Queue,
    });
    const waitUntil: Promise<unknown>[] = [];

    await worker.scheduled(controllerFor("2026-05-25T05:14:00.000Z"), env, executionContext(waitUntil));
    await Promise.all(waitUntil);

    // Fails OPEN on a broken snapshot binding: the sweep still enqueues, and the failure is surfaced (not
    // silently swallowed) so an operator can see the introspection is unavailable.
    expect(sent).toEqual([{ type: "agent-regate-sweep", requestedBy: "schedule" }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("selfhost_queue_snapshot_failed"));
  });

  it("does not enqueue review sweeps from a broker-only Cloudflare runtime", async () => {
    const sent: Array<import("../../src/types").JobMessage> = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    delete env.SELFHOST_TRANSIENT_CACHE;
    const waitUntil: Promise<unknown>[] = [];

    await worker.scheduled(controllerFor("2026-05-25T05:14:00.000Z"), env, executionContext(waitUntil));
    await Promise.all(waitUntil);

    expect(sent).toEqual([]);
  });

  it("keeps broker-only Cloudflare maintenance cheap on :30 ticks", async () => {
    const sent: Array<import("../../src/types").JobMessage> = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    delete env.SELFHOST_TRANSIENT_CACHE;
    const waitUntil: Promise<unknown>[] = [];

    await worker.scheduled(controllerFor("2026-05-25T05:30:00.000Z"), env, executionContext(waitUntil));
    await Promise.all(waitUntil);

    expect(sent).toEqual([
      { type: "repair-data-fidelity", requestedBy: "schedule" },
      { type: "refresh-installation-health", requestedBy: "schedule" },
    ]);
  });

  it("THROTTLES the sweep when the GitHub REST budget is at/below the maintenance headroom (#6 backpressure)", async () => {
    const sent: Array<import("../../src/types").JobMessage> = [];
    const env = createTestEnv({
      JOBS: { async send(message: import("../../src/types").JobMessage) { sent.push(message); } } as unknown as Queue,
    });
    // Seed a low REST observation (remaining 50 <= MAINTENANCE_RESERVED_HEADROOM=150) with a future reset.
    await recordGitHubRateLimitObservation(env, { repoFullName: "owner/repo", resource: "rest", path: "/x", statusCode: 200, limitValue: 5000, remaining: 50, resetAt: new Date(Date.now() + 600_000).toISOString(), observedAt: new Date().toISOString() });
    const waitUntil: Promise<unknown>[] = [];
    await worker.scheduled(controllerFor("2026-05-25T05:14:00.000Z"), env, executionContext(waitUntil));
    await Promise.all(waitUntil);
    // The sweep is NOT enqueued this tick — the shared budget is reserved for webhooks; the next tick retries.
    expect(sent.find((m) => m.type === "agent-regate-sweep")).toBeUndefined();
  });

  it("THROTTLES the open-data backfill too when the REST budget is at/below the maintenance headroom, keeping the cheap health jobs (#audit-rate-headroom)", async () => {
    const sent: Array<import("../../src/types").JobMessage> = [];
    const env = createTestEnv({
      JOBS: { async send(message: import("../../src/types").JobMessage) { sent.push(message); } } as unknown as Queue,
    });
    // Low REST budget (remaining 50 <= MAINTENANCE_RESERVED_HEADROOM=150) with a future reset.
    await recordGitHubRateLimitObservation(env, { repoFullName: "owner/repo", resource: "rest", path: "/x", statusCode: 200, limitValue: 5000, remaining: 50, resetAt: new Date(Date.now() + 600_000).toISOString(), observedAt: new Date().toISOString() });
    const waitUntil: Promise<unknown>[] = [];
    // A :30 tick is when the backfill would normally enqueue — assert it does NOT while the budget is reserved.
    await worker.scheduled(controllerFor("2026-05-25T05:30:00.000Z"), env, executionContext(waitUntil));
    await Promise.all(waitUntil);
    // Backfill (+ sweep) yield the budget to webhooks; the cheap single-call health jobs still run.
    expect(sent.some((m) => m.type === "backfill-registered-repos")).toBe(false);
    expect(sent.some((m) => m.type === "agent-regate-sweep")).toBe(false);
    expect(sent.some((m) => m.type === "repair-data-fidelity")).toBe(true);
    expect(sent.some((m) => m.type === "refresh-installation-health")).toBe(true);
  });

  it("enqueues the open-data backfill on a :30 tick when there is REST headroom (#audit-rate-headroom)", async () => {
    const sent: Array<import("../../src/types").JobMessage> = [];
    const env = createTestEnv({
      JOBS: { async send(message: import("../../src/types").JobMessage) { sent.push(message); } } as unknown as Queue,
    });
    // Ample REST budget (remaining 4000 > MAINTENANCE_RESERVED_HEADROOM=150) → the throttle does NOT engage.
    await recordGitHubRateLimitObservation(env, { repoFullName: "owner/repo", resource: "rest", path: "/x", statusCode: 200, limitValue: 5000, remaining: 4000, resetAt: new Date(Date.now() + 600_000).toISOString(), observedAt: new Date().toISOString() });
    const waitUntil: Promise<unknown>[] = [];
    await worker.scheduled(controllerFor("2026-05-25T05:30:00.000Z"), env, executionContext(waitUntil));
    await Promise.all(waitUntil);
    expect(sent.some((m) => m.type === "backfill-registered-repos")).toBe(true);
    expect(sent.some((m) => m.type === "agent-regate-sweep")).toBe(true);
  });

  it("enqueues hourly refreshes without full detail work outside the six-hour window", async () => {
    const sent: Array<import("../../src/types").JobMessage> = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    const waitUntil: Promise<unknown>[] = [];

    await worker.scheduled(controllerFor("2026-05-25T05:00:00.000Z"), env, executionContext(waitUntil));
    await Promise.all(waitUntil);

    expect(sent).toEqual([
      { type: "agent-regate-sweep", requestedBy: "schedule" },
      { type: "backfill-registered-repos", requestedBy: "schedule", mode: "light" },
      { type: "repair-data-fidelity", requestedBy: "schedule" },
      { type: "refresh-installation-health", requestedBy: "schedule" },
      { type: "backlog-convergence-sweep", requestedBy: "schedule" },
      { type: "refresh-registry", requestedBy: "schedule" },
      { type: "refresh-scoring-model", requestedBy: "schedule" },
      { type: "refresh-upstream-drift", requestedBy: "schedule" },
      { type: "rollup-product-usage", requestedBy: "schedule", days: 7 },
    ]);
  });

  it("enqueues full-sync scheduled work every six hours", async () => {
    const sent: Array<import("../../src/types").JobMessage> = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    const waitUntil: Promise<unknown>[] = [];

    await worker.scheduled(controllerFor("2026-05-25T06:00:00.000Z"), env, executionContext(waitUntil));
    await Promise.all(waitUntil);

    expect(sent).toEqual([
      { type: "agent-regate-sweep", requestedBy: "schedule" },
      { type: "backfill-registered-repos", requestedBy: "schedule", mode: "full" },
      { type: "repair-data-fidelity", requestedBy: "schedule" },
      { type: "refresh-installation-health", requestedBy: "schedule" },
      { type: "backlog-convergence-sweep", requestedBy: "schedule" },
      { type: "refresh-registry", requestedBy: "schedule" },
      { type: "refresh-scoring-model", requestedBy: "schedule" },
      { type: "refresh-upstream-drift", requestedBy: "schedule" },
      { type: "rollup-product-usage", requestedBy: "schedule", days: 7 },
      { type: "generate-signal-snapshots", requestedBy: "schedule" },
      { type: "build-burden-forecasts", requestedBy: "schedule" },
      { type: "build-contributor-evidence", requestedBy: "schedule" },
      { type: "build-contributor-decision-packs", requestedBy: "schedule" },
      { type: "file-upstream-drift-issues", requestedBy: "schedule" },
    ]);
  });

  it("phase-spreads the scheduled enqueue: sweep immediate, periodic maintenance jittered (#1948)", async () => {
    const sent: Array<{
      message: import("../../src/types").JobMessage;
      delaySeconds?: number;
    }> = [];
    const env = createTestEnv({
      JOBS: {
        async send(
          message: import("../../src/types").JobMessage,
          options?: { delaySeconds?: number },
        ) {
          sent.push({
            message,
            ...(options?.delaySeconds === undefined
              ? {}
              : { delaySeconds: options.delaySeconds }),
          });
        },
      } as unknown as Queue,
    });
    const waitUntil: Promise<unknown>[] = [];

    await worker.scheduled(controllerFor("2026-05-25T06:00:00.000Z"), env, executionContext(waitUntil));
    await Promise.all(waitUntil);

    // The enqueued SET is unchanged — jitter only spreads run_after timing, never which jobs are sent.
    expect(sent.map((s) => s.message.type)).toEqual([
      "agent-regate-sweep",
      "backfill-registered-repos",
      "repair-data-fidelity",
      "refresh-installation-health",
      "backlog-convergence-sweep",
      "refresh-registry",
      "refresh-scoring-model",
      "refresh-upstream-drift",
      "rollup-product-usage",
      "generate-signal-snapshots",
      "build-burden-forecasts",
      "build-contributor-evidence",
      "build-contributor-decision-packs",
      "file-upstream-drift-issues",
    ]);
    // Each captured job's delay matches the deterministic policy: the every-tick sweep is immediate (sent with no
    // options), the periodic maintenance jobs carry their stable per-type jitter slot.
    for (const s of sent) {
      const expected = scheduledEnqueueDelaySeconds(s.message.type);
      if (expected > 0) expect(s.delaySeconds).toBe(expected);
      else expect(s.delaySeconds).toBeUndefined();
    }
    // The priority sweep specifically stays immediate; at least one periodic job is actually deferred, so a
    // top-of-6h tick no longer fires every heavy fan-out parent in the same instant.
    expect(sent.find((s) => s.message.type === "agent-regate-sweep")?.delaySeconds).toBeUndefined();
    expect(sent.some((s) => (s.delaySeconds ?? 0) > 0)).toBe(true);
  });

  it("enqueues the ops-alerts job hourly ONLY when GITTENSORY_REVIEW_OPS is ON (flag-OFF is byte-identical)", async () => {
    const sentFor = async (opsFlag?: string): Promise<Array<import("../../src/types").JobMessage>> => {
      const sent: Array<import("../../src/types").JobMessage> = [];
      const env = createTestEnv({
        ...(opsFlag === undefined ? {} : { GITTENSORY_REVIEW_OPS: opsFlag }),
        JOBS: {
          async send(message: import("../../src/types").JobMessage) {
            sent.push(message);
          },
        } as unknown as Queue,
      });
      const waitUntil: Promise<unknown>[] = [];
      await worker.scheduled(controllerFor("2026-05-25T05:00:00.000Z"), env, executionContext(waitUntil));
      await Promise.all(waitUntil);
      return sent;
    };

    // Flag OFF (default) → no ops-alerts job; the enqueued set is unchanged from today.
    expect((await sentFor()).some((m) => m.type === "ops-alerts")).toBe(false);
    expect((await sentFor("false")).some((m) => m.type === "ops-alerts")).toBe(false);
    // Flag ON → exactly one ops-alerts job, enqueued in the hourly window.
    const on = await sentFor("true");
    expect(on.filter((m) => m.type === "ops-alerts")).toEqual([{ type: "ops-alerts", requestedBy: "schedule" }]);
  });

  it("does NOT enqueue ops-alerts outside the hourly window even when GITTENSORY_REVIEW_OPS is ON", async () => {
    const sent: Array<import("../../src/types").JobMessage> = [];
    const env = createTestEnv({
      GITTENSORY_REVIEW_OPS: "true",
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    const waitUntil: Promise<unknown>[] = [];
    await worker.scheduled(controllerFor("2026-05-25T05:15:00.000Z"), env, executionContext(waitUntil)); // non-hourly
    await Promise.all(waitUntil);
    expect(sent.some((m) => m.type === "ops-alerts")).toBe(false);
  });

  it("enqueues the sweep-liveness-watchdog job hourly ONLY when GITTENSORY_SWEEP_WATCHDOG is ON (flag-OFF is byte-identical)", async () => {
    const sentFor = async (watchdogFlag?: string): Promise<Array<import("../../src/types").JobMessage>> => {
      const sent: Array<import("../../src/types").JobMessage> = [];
      const env = createTestEnv({
        ...(watchdogFlag === undefined ? {} : { GITTENSORY_SWEEP_WATCHDOG: watchdogFlag }),
        JOBS: {
          async send(message: import("../../src/types").JobMessage) {
            sent.push(message);
          },
        } as unknown as Queue,
      });
      const waitUntil: Promise<unknown>[] = [];
      await worker.scheduled(controllerFor("2026-05-25T05:00:00.000Z"), env, executionContext(waitUntil));
      await Promise.all(waitUntil);
      return sent;
    };

    // Flag OFF (default) → no sweep-liveness-watchdog job; the enqueued set is unchanged from today.
    expect((await sentFor()).some((m) => m.type === "sweep-liveness-watchdog")).toBe(false);
    expect((await sentFor("false")).some((m) => m.type === "sweep-liveness-watchdog")).toBe(false);
    // Flag ON → exactly one sweep-liveness-watchdog job, enqueued in the hourly window.
    const on = await sentFor("true");
    expect(on.filter((m) => m.type === "sweep-liveness-watchdog")).toEqual([{ type: "sweep-liveness-watchdog", requestedBy: "schedule" }]);
  });

  it("does NOT enqueue sweep-liveness-watchdog outside the hourly window even when GITTENSORY_SWEEP_WATCHDOG is ON", async () => {
    const sent: Array<import("../../src/types").JobMessage> = [];
    const env = createTestEnv({
      GITTENSORY_SWEEP_WATCHDOG: "true",
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    const waitUntil: Promise<unknown>[] = [];
    await worker.scheduled(controllerFor("2026-05-25T05:15:00.000Z"), env, executionContext(waitUntil)); // non-hourly
    await Promise.all(waitUntil);
    expect(sent.some((m) => m.type === "sweep-liveness-watchdog")).toBe(false);
  });

  it("enqueues the reconcile-open-prs job every 10 minutes ONLY when GITTENSORY_PR_RECONCILIATION is ON (flag-OFF is byte-identical)", async () => {
    const sentFor = async (flag?: string, isoTime = "2026-05-25T05:10:00.000Z"): Promise<Array<import("../../src/types").JobMessage>> => {
      const sent: Array<import("../../src/types").JobMessage> = [];
      const env = createTestEnv({
        ...(flag === undefined ? {} : { GITTENSORY_PR_RECONCILIATION: flag }),
        JOBS: {
          async send(message: import("../../src/types").JobMessage) {
            sent.push(message);
          },
        } as unknown as Queue,
      });
      const waitUntil: Promise<unknown>[] = [];
      await worker.scheduled(controllerFor(isoTime), env, executionContext(waitUntil));
      await Promise.all(waitUntil);
      return sent;
    };

    // Flag OFF (default) → no reconcile-open-prs job; the enqueued set is unchanged from today.
    expect((await sentFor()).some((m) => m.type === "reconcile-open-prs")).toBe(false);
    expect((await sentFor("false")).some((m) => m.type === "reconcile-open-prs")).toBe(false);
    // Flag ON, on a 10-minute boundary → exactly one reconcile-open-prs job.
    const on = await sentFor("true");
    expect(on.filter((m) => m.type === "reconcile-open-prs")).toEqual([{ type: "reconcile-open-prs", requestedBy: "schedule" }]);
  });

  it("does NOT enqueue reconcile-open-prs outside the 10-minute window even when GITTENSORY_PR_RECONCILIATION is ON", async () => {
    const sent: Array<import("../../src/types").JobMessage> = [];
    const env = createTestEnv({
      GITTENSORY_PR_RECONCILIATION: "true",
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    const waitUntil: Promise<unknown>[] = [];
    await worker.scheduled(controllerFor("2026-05-25T05:14:00.000Z"), env, executionContext(waitUntil)); // not a 10-minute boundary
    await Promise.all(waitUntil);
    expect(sent.some((m) => m.type === "reconcile-open-prs")).toBe(false);
  });

  it("enqueues selftune hourly only when GITTENSORY_REVIEW_SELFTUNE is ON", async () => {
    const sentFor = async (
      selfTuneFlag?: string,
    ): Promise<Array<import("../../src/types").JobMessage>> => {
      const sent: Array<import("../../src/types").JobMessage> = [];
      const env = createTestEnv({
        ...(selfTuneFlag === undefined
          ? {}
          : { GITTENSORY_REVIEW_SELFTUNE: selfTuneFlag }),
        JOBS: {
          async send(message: import("../../src/types").JobMessage) {
            sent.push(message);
          },
        } as unknown as Queue,
      });
      const waitUntil: Promise<unknown>[] = [];
      await worker.scheduled(
        controllerFor("2026-05-25T05:00:00.000Z"),
        env,
        executionContext(waitUntil),
      );
      await Promise.all(waitUntil);
      return sent;
    };

    expect((await sentFor()).some((m) => m.type === "selftune")).toBe(false);
    expect((await sentFor("false")).some((m) => m.type === "selftune")).toBe(
      false,
    );
    expect((await sentFor("true")).filter((m) => m.type === "selftune")).toEqual([
      { type: "selftune", requestedBy: "schedule" },
    ]);
  });

  it("enqueues the rag-index-repo fan-out in the full-sync window ONLY when GITTENSORY_REVIEW_RAG is ON (flag-OFF is byte-identical)", async () => {
    const sentFor = async (ragFlag?: string): Promise<Array<import("../../src/types").JobMessage>> => {
      const sent: Array<import("../../src/types").JobMessage> = [];
      const env = createTestEnv({
        ...(ragFlag === undefined ? {} : { GITTENSORY_REVIEW_RAG: ragFlag }),
        JOBS: {
          async send(message: import("../../src/types").JobMessage) {
            sent.push(message);
          },
        } as unknown as Queue,
      });
      const waitUntil: Promise<unknown>[] = [];
      await worker.scheduled(controllerFor("2026-05-25T06:00:00.000Z"), env, executionContext(waitUntil)); // full-sync window
      await Promise.all(waitUntil);
      return sent;
    };

    // Flag OFF (default) → no rag-index-repo job; the enqueued set is unchanged from today.
    expect((await sentFor()).some((m) => m.type === "rag-index-repo")).toBe(false);
    expect((await sentFor("false")).some((m) => m.type === "rag-index-repo")).toBe(false);
    // Flag ON → exactly one rag-index-repo fan-out job, enqueued in the full-sync window.
    const on = await sentFor("true");
    expect(on.filter((m) => m.type === "rag-index-repo")).toEqual([{ type: "rag-index-repo", requestedBy: "schedule" }]);
  });

  it("does NOT enqueue rag-index-repo outside the full-sync window even when GITTENSORY_REVIEW_RAG is ON", async () => {
    const sent: Array<import("../../src/types").JobMessage> = [];
    const env = createTestEnv({
      GITTENSORY_REVIEW_RAG: "true",
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    const waitUntil: Promise<unknown>[] = [];
    await worker.scheduled(controllerFor("2026-05-25T05:00:00.000Z"), env, executionContext(waitUntil)); // hourly but NOT full-sync
    await Promise.all(waitUntil);
    expect(sent.some((m) => m.type === "rag-index-repo")).toBe(false);
  });

  it("enqueues the repo-doc refresh sweep once a day at 09:00 UTC on a self-hosted runtime (#3003)", async () => {
    const sent: Array<import("../../src/types").JobMessage> = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    const waitUntil: Promise<unknown>[] = [];

    await worker.scheduled(controllerFor("2026-06-01T09:00:00.000Z"), env, executionContext(waitUntil));
    await Promise.all(waitUntil);

    expect(sent).toEqual(expect.arrayContaining([{ type: "repo-doc-refresh-sweep", requestedBy: "schedule" }]));
  });

  it("does NOT enqueue the repo-doc refresh sweep outside the 09:00 UTC window", async () => {
    const sent: Array<import("../../src/types").JobMessage> = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    const waitUntil: Promise<unknown>[] = [];

    await worker.scheduled(controllerFor("2026-06-01T10:00:00.000Z"), env, executionContext(waitUntil)); // hourly but not 09:00
    await Promise.all(waitUntil);

    expect(sent.some((m) => m.type === "repo-doc-refresh-sweep")).toBe(false);
  });

  it("enqueues weekly value report generation during the Monday report window", async () => {
    const sent: Array<import("../../src/types").JobMessage> = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    const waitUntil: Promise<unknown>[] = [];

    await worker.scheduled(controllerFor("2026-06-01T12:00:00.000Z"), env, executionContext(waitUntil));
    await Promise.all(waitUntil);

    expect(sent).toEqual(
      expect.arrayContaining([
        { type: "rollup-product-usage", requestedBy: "schedule", days: 7 },
        { type: "generate-weekly-value-report", requestedBy: "schedule", variant: "operator", days: 7 },
      ]),
    );
  });

  it("enqueues the maintainer recap digest on the default weekly cadence (Monday 14:00 UTC) ONLY when GITTENSORY_MAINTAINER_RECAP is ON (#2248, flag-OFF is byte-identical)", async () => {
    const sentFor = async (recapFlag?: string): Promise<Array<import("../../src/types").JobMessage>> => {
      const sent: Array<import("../../src/types").JobMessage> = [];
      const env = createTestEnv({
        ...(recapFlag === undefined ? {} : { GITTENSORY_MAINTAINER_RECAP: recapFlag }),
        JOBS: {
          async send(message: import("../../src/types").JobMessage) {
            sent.push(message);
          },
        } as unknown as Queue,
      });
      const waitUntil: Promise<unknown>[] = [];
      await worker.scheduled(controllerFor("2026-06-01T14:00:00.000Z"), env, executionContext(waitUntil)); // Monday, 14:00 UTC
      await Promise.all(waitUntil);
      return sent;
    };

    // Flag OFF (default) → no recap job; the enqueued set is unchanged from today.
    expect((await sentFor()).some((m) => m.type === "generate-maintainer-recap")).toBe(false);
    expect((await sentFor("false")).some((m) => m.type === "generate-maintainer-recap")).toBe(false);
    // Flag ON, on the default weekly cadence tick → exactly one recap job.
    const on = await sentFor("true");
    expect(on.filter((m) => m.type === "generate-maintainer-recap")).toEqual([{ type: "generate-maintainer-recap", requestedBy: "schedule" }]);
  });

  it("does NOT enqueue the maintainer recap digest outside its configured cadence even when GITTENSORY_MAINTAINER_RECAP is ON", async () => {
    const sent: Array<import("../../src/types").JobMessage> = [];
    const env = createTestEnv({
      GITTENSORY_MAINTAINER_RECAP: "true",
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    const waitUntil: Promise<unknown>[] = [];
    await worker.scheduled(controllerFor("2026-06-02T14:00:00.000Z"), env, executionContext(waitUntil)); // Tuesday, not the weekly default day
    await Promise.all(waitUntil);
    expect(sent.some((m) => m.type === "generate-maintainer-recap")).toBe(false);
  });

  it("honors a custom GITTENSORY_RECAP_CADENCE=daily, firing every day at the configured hour", async () => {
    const sent: Array<import("../../src/types").JobMessage> = [];
    const env = createTestEnv({
      GITTENSORY_MAINTAINER_RECAP: "true",
      GITTENSORY_RECAP_CADENCE: "daily",
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    const waitUntil: Promise<unknown>[] = [];
    await worker.scheduled(controllerFor("2026-06-02T14:00:00.000Z"), env, executionContext(waitUntil)); // Tuesday — not the weekly default day
    await Promise.all(waitUntil);
    expect(sent.filter((m) => m.type === "generate-maintainer-recap")).toEqual([{ type: "generate-maintainer-recap", requestedBy: "schedule" }]);
  });
});

function controllerFor(iso: string): ScheduledController {
  return { scheduledTime: Date.parse(iso) } as ScheduledController;
}

function executionContext(waitUntil: Promise<unknown>[]): ExecutionContext {
  return {
    waitUntil: (promise: Promise<unknown>) => {
      waitUntil.push(promise);
    },
    passThroughOnException: () => {},
    exports: {},
    props: {},
  } as unknown as ExecutionContext;
}
