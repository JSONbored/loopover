import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
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

  it("enqueues light scheduled work outside hourly and full-sync windows", async () => {
    const sent: Array<import("../../src/types").JobMessage> = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    const waitUntil: Promise<unknown>[] = [];

    await worker.scheduled(controllerFor("2026-05-25T05:15:00.000Z"), env, executionContext(waitUntil));
    await Promise.all(waitUntil);

    expect(sent).toEqual([
      { type: "backfill-registered-repos", requestedBy: "schedule", mode: "light" },
      { type: "repair-data-fidelity", requestedBy: "schedule" },
      { type: "refresh-installation-health", requestedBy: "schedule" },
    ]);
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
      { type: "backfill-registered-repos", requestedBy: "schedule", mode: "light" },
      { type: "repair-data-fidelity", requestedBy: "schedule" },
      { type: "refresh-installation-health", requestedBy: "schedule" },
      { type: "refresh-registry", requestedBy: "schedule" },
      { type: "refresh-scoring-model", requestedBy: "schedule" },
      { type: "refresh-upstream-drift", requestedBy: "schedule" },
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
      { type: "backfill-registered-repos", requestedBy: "schedule", mode: "full" },
      { type: "repair-data-fidelity", requestedBy: "schedule" },
      { type: "refresh-installation-health", requestedBy: "schedule" },
      { type: "refresh-registry", requestedBy: "schedule" },
      { type: "refresh-scoring-model", requestedBy: "schedule" },
      { type: "refresh-upstream-drift", requestedBy: "schedule" },
      { type: "generate-signal-snapshots", requestedBy: "schedule" },
      { type: "build-burden-forecasts", requestedBy: "schedule" },
      { type: "build-contributor-evidence", requestedBy: "schedule" },
      { type: "build-contributor-decision-packs", requestedBy: "schedule" },
      { type: "file-upstream-drift-issues", requestedBy: "schedule" },
    ]);
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
