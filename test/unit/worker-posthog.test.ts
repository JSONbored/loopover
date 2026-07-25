import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// Mock posthog-node so the dynamic import inside buildClient() resolves to a spy-backed client, mirroring
// selfhost-posthog.test.ts's identical mocking pattern.
const mocks = vi.hoisted(() => {
  const captureException = vi.fn();
  const flush = vi.fn().mockResolvedValue(undefined);
  let lastApiKey: string | undefined;
  let lastOptions: any;
  const PostHog = vi.fn(function (this: any, apiKey: string, options: any) {
    lastApiKey = apiKey;
    lastOptions = options;
    this.captureException = captureException;
    this.flush = flush;
  });
  return { captureException, flush, PostHog, getLastApiKey: () => lastApiKey, getLastOptions: () => lastOptions };
});
vi.mock("posthog-node", () => ({ PostHog: mocks.PostHog }));

import {
  capturePostHogWorkerError,
  createWorkerPostHogErrorMiddleware,
  isWorkerPostHogConfigured,
  scrubWorkerPostHogEvent,
  type WorkerPostHogEnv,
} from "../../src/api/worker-posthog";
import { resetRedactionScrubForTest } from "../../src/selfhost/redaction-scrub";

beforeEach(() => {
  vi.clearAllMocks();
  resetRedactionScrubForTest();
});

describe("scrubWorkerPostHogEvent", () => {
  it("passes through null unchanged", () => {
    expect(scrubWorkerPostHogEvent(null)).toBeNull();
  });

  it("redacts secret-shaped values in properties", () => {
    const event = { event: "$exception", properties: { token: "gh" + "o_" + "a".repeat(20) } } as any;
    const scrubbed = scrubWorkerPostHogEvent(event);
    expect(scrubbed?.properties?.token).toBe("[redacted]");
  });

  it("scrubs a secret-shaped event name", () => {
    const secret = `Bearer ${"a".repeat(20)}`;
    const event = { event: secret, properties: {} } as any;
    const scrubbed = scrubWorkerPostHogEvent(event);
    expect(scrubbed?.event).not.toBe(secret);
    expect(scrubbed?.event).toContain("[redacted]");
  });

  it("leaves an event with no properties untouched aside from its event name", () => {
    const event = { event: "$exception" } as any;
    expect(scrubWorkerPostHogEvent(event)).toEqual(event);
  });

  it("leaves a non-string event name untouched", () => {
    const event = { event: undefined, properties: {} } as any;
    expect(scrubWorkerPostHogEvent(event)).toEqual(event);
  });

  it("returns null when scrubbing itself throws", () => {
    const event = {
      event: "$exception",
      get properties(): unknown {
        throw new Error("boom");
      },
    } as any;
    expect(scrubWorkerPostHogEvent(event)).toBeNull();
  });
});

describe("isWorkerPostHogConfigured", () => {
  it("is false when WORKER_POSTHOG_API_KEY is unset", () => {
    expect(isWorkerPostHogConfigured({} as WorkerPostHogEnv)).toBe(false);
  });
  it("is false when WORKER_POSTHOG_API_KEY is blank/whitespace", () => {
    expect(isWorkerPostHogConfigured({ WORKER_POSTHOG_API_KEY: "   " } as WorkerPostHogEnv)).toBe(false);
  });
  it("is true when WORKER_POSTHOG_API_KEY is a non-blank string", () => {
    expect(isWorkerPostHogConfigured({ WORKER_POSTHOG_API_KEY: "phc_test" } as WorkerPostHogEnv)).toBe(true);
  });
});

describe("capturePostHogWorkerError", () => {
  it("is a no-op when unconfigured", async () => {
    await capturePostHogWorkerError({} as WorkerPostHogEnv, new Error("boom"), { path: "/x", method: "GET" });
    expect(mocks.PostHog).not.toHaveBeenCalled();
  });

  it("captures with the configured key and default host when WORKER_POSTHOG_HOST is unset", async () => {
    await capturePostHogWorkerError({ WORKER_POSTHOG_API_KEY: "phc_test" } as WorkerPostHogEnv, new Error("boom"), { path: "/x", method: "GET" });
    expect(mocks.getLastApiKey()).toBe("phc_test");
    expect(mocks.getLastOptions()).toMatchObject({ host: "https://us.i.posthog.com", flushAt: 1, flushInterval: 0 });
  });

  it("uses WORKER_POSTHOG_HOST when set", async () => {
    await capturePostHogWorkerError(
      { WORKER_POSTHOG_API_KEY: "phc_test", WORKER_POSTHOG_HOST: "https://eu.i.posthog.com" } as WorkerPostHogEnv,
      new Error("boom"),
      { path: "/x", method: "GET" },
    );
    expect(mocks.getLastOptions()).toMatchObject({ host: "https://eu.i.posthog.com" });
  });

  it("wraps a non-Error thrown value into a real Error before capturing", async () => {
    await capturePostHogWorkerError({ WORKER_POSTHOG_API_KEY: "phc_test" } as WorkerPostHogEnv, "not an error", { path: "/x", method: "GET" });
    const captured = mocks.captureException.mock.calls.at(-1)?.[0] as Error;
    expect(captured).toBeInstanceOf(Error);
    expect(captured.message).toBe("not an error");
  });

  it("captures the request path/method and defaults environment to production", async () => {
    await capturePostHogWorkerError({ WORKER_POSTHOG_API_KEY: "phc_test" } as WorkerPostHogEnv, new Error("boom"), { path: "/v1/orb/webhook", method: "POST" });
    const [error, distinctId, properties] = mocks.captureException.mock.calls.at(-1)!;
    expect((error as Error).message).toBe("boom");
    expect(distinctId).toBe("loopover-worker");
    expect(properties).toMatchObject({ environment: "production", request_path: "/v1/orb/webhook", request_method: "POST" });
  });

  it("uses WORKER_POSTHOG_ENVIRONMENT when set", async () => {
    await capturePostHogWorkerError({ WORKER_POSTHOG_API_KEY: "phc_test", WORKER_POSTHOG_ENVIRONMENT: "staging" } as WorkerPostHogEnv, new Error("boom"), {
      path: "/x",
      method: "GET",
    });
    const properties = mocks.captureException.mock.calls.at(-1)?.[2] as Record<string, unknown>;
    expect(properties.environment).toBe("staging");
  });

  it("redacts a secret-shaped request path", async () => {
    await capturePostHogWorkerError({ WORKER_POSTHOG_API_KEY: "phc_test" } as WorkerPostHogEnv, new Error("boom"), {
      path: `/v1/orb/token/${"github" + "_pat_"}${"a".repeat(24)}`,
      method: "GET",
    });
    const properties = mocks.captureException.mock.calls.at(-1)?.[2] as Record<string, unknown>;
    expect(properties.request_path).not.toContain("github_pat_");
    expect(properties.request_path).toContain("[redacted]");
  });

  it("awaits flush before resolving", async () => {
    let flushed = false;
    mocks.flush.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      flushed = true;
    });
    await capturePostHogWorkerError({ WORKER_POSTHOG_API_KEY: "phc_test" } as WorkerPostHogEnv, new Error("boom"), { path: "/x", method: "GET" });
    expect(flushed).toBe(true);
  });

  it("never throws when the PostHog client construction fails", async () => {
    mocks.PostHog.mockImplementationOnce(() => {
      throw new Error("client construction failed");
    });
    await expect(capturePostHogWorkerError({ WORKER_POSTHOG_API_KEY: "phc_test" } as WorkerPostHogEnv, new Error("boom"), { path: "/x", method: "GET" })).resolves.toBeUndefined();
  });

  it("never throws when captureException itself throws", async () => {
    mocks.captureException.mockImplementationOnce(() => {
      throw new Error("capture failed");
    });
    await expect(capturePostHogWorkerError({ WORKER_POSTHOG_API_KEY: "phc_test" } as WorkerPostHogEnv, new Error("boom"), { path: "/x", method: "GET" })).resolves.toBeUndefined();
  });

  it("never throws when flush rejects", async () => {
    mocks.flush.mockRejectedValueOnce(new Error("flush failed"));
    await expect(capturePostHogWorkerError({ WORKER_POSTHOG_API_KEY: "phc_test" } as WorkerPostHogEnv, new Error("boom"), { path: "/x", method: "GET" })).resolves.toBeUndefined();
  });
});

/** Builds a minimal Hono app with the middleware mounted plus a route that always throws, and a fake
 *  executionCtx that captures whatever promise gets handed to waitUntil so the test can await it
 *  deterministically instead of racing the fire-and-forget capture. */
function buildTestApp() {
  const app = new Hono<{ Bindings: WorkerPostHogEnv }>();
  app.use(createWorkerPostHogErrorMiddleware());
  app.get("/ok", (c) => c.text("fine"));
  app.get("/boom", () => {
    throw new Error("handler exploded");
  });
  let waited: Promise<unknown> = Promise.resolve();
  const executionCtx = {
    waitUntil: (p: Promise<unknown>) => {
      waited = p;
    },
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext<unknown>;
  return { app, executionCtx, getWaited: () => waited };
}

describe("createWorkerPostHogErrorMiddleware", () => {
  it("is a transparent passthrough for a successful request when unconfigured", async () => {
    const { app, executionCtx } = buildTestApp();
    const res = await app.fetch(new Request("https://loopover.test/ok"), {} as WorkerPostHogEnv, executionCtx);
    expect(res.status).toBe(200);
    expect(mocks.PostHog).not.toHaveBeenCalled();
  });

  it("still surfaces a 500 (via Hono's own default error handler) without capturing when unconfigured", async () => {
    const { app, executionCtx } = buildTestApp();
    const res = await app.fetch(new Request("https://loopover.test/boom"), {} as WorkerPostHogEnv, executionCtx);
    expect(res.status).toBe(500);
    expect(mocks.PostHog).not.toHaveBeenCalled();
  });

  it("does not capture a successful request when configured", async () => {
    const { app, executionCtx } = buildTestApp();
    const res = await app.fetch(new Request("https://loopover.test/ok"), { WORKER_POSTHOG_API_KEY: "phc_test" } as WorkerPostHogEnv, executionCtx);
    expect(res.status).toBe(200);
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("schedules a capture via waitUntil and still surfaces the 500 when configured and a handler throws", async () => {
    const { app, executionCtx, getWaited } = buildTestApp();
    const res = await app.fetch(new Request("https://loopover.test/boom"), { WORKER_POSTHOG_API_KEY: "phc_test" } as WorkerPostHogEnv, executionCtx);
    expect(res.status).toBe(500);
    await getWaited();
    const [error, , properties] = mocks.captureException.mock.calls.at(-1)!;
    expect((error as Error).message).toBe("handler exploded");
    expect((properties as Record<string, unknown>).request_path).toBe("/boom");
    expect((properties as Record<string, unknown>).request_method).toBe("GET");
  });

  it("falls back to a no-op executionCtx when c.executionCtx throws (self-host calling the same Worker fetch handler outside a real isolate)", async () => {
    const app = new Hono<{ Bindings: WorkerPostHogEnv }>();
    app.use(createWorkerPostHogErrorMiddleware());
    app.get("/boom", () => {
      throw new Error("handler exploded");
    });
    // No third argument -- Hono's own executionCtx getter throws when none was supplied, exactly like a
    // self-host Node process calling this exported fetch handler without a real Workers ExecutionContext.
    const res = await app.fetch(new Request("https://loopover.test/boom"), { WORKER_POSTHOG_API_KEY: "phc_test" } as WorkerPostHogEnv);
    expect(res.status).toBe(500);
  });
});
