import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { recordGitHubRateLimitObservation } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

describe("worker entrypoint", () => {
  afterEach(() => {
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
