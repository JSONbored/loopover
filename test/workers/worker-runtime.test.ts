import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import { isCloudflareWorkerRuntime } from "../../src/api/routes";

describe("worker runtime", () => {
  it("serves public metadata and keeps private routes locked in the Workers runtime", async () => {
    const ctx = createExecutionContext();
    const health = await worker.fetch(new Request("https://loopover.test/health"), {} as Env, ctx);
    await waitOnExecutionContext(ctx);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ status: "ok", service: "loopover-api" });

    const openApi = await worker.fetch(new Request("https://loopover.test/openapi.json"), {} as Env, createExecutionContext());
    expect(openApi.status).toBe(200);
    await expect(openApi.json()).resolves.toMatchObject({ info: { title: "LoopOver API" } });

    const mcp = await worker.fetch(new Request("https://loopover.test/mcp", { method: "POST" }), {} as Env, createExecutionContext());
    expect(mcp.status).toBe(401);
  });

  it("REGRESSION: isCloudflareWorkerRuntime() is true in a real Workers isolate (the gate that lets the Sentry middleware register at all)", () => {
    expect(isCloudflareWorkerRuntime()).toBe(true);
    expect(navigator.userAgent).toBe("Cloudflare-Workers");
  });

  it("still serves a normal response when WORKER_SENTRY_DSN is unset -- the Sentry middleware being registered must not itself break requests", async () => {
    const res = await worker.fetch(new Request("https://loopover.test/health"), { WORKER_SENTRY_DSN: undefined } as unknown as Env, createExecutionContext());
    expect(res.status).toBe(200);
  });

  it("still serves a normal response when WORKER_POSTHOG_API_KEY is unset -- the PostHog middleware (#8288) being registered must not itself break requests", async () => {
    const res = await worker.fetch(new Request("https://loopover.test/health"), { WORKER_POSTHOG_API_KEY: undefined } as unknown as Env, createExecutionContext());
    expect(res.status).toBe(200);
  });
});
