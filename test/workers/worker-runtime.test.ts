import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";

describe("worker runtime", () => {
  it("serves public metadata and keeps private routes locked in the Workers runtime", async () => {
    const ctx = createExecutionContext();
    const health = await worker.fetch(new Request("https://gittensory.test/health"), {} as Env, ctx);
    await waitOnExecutionContext(ctx);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ status: "ok", service: "loopover-api" });

    const openApi = await worker.fetch(new Request("https://gittensory.test/openapi.json"), {} as Env, createExecutionContext());
    expect(openApi.status).toBe(200);
    await expect(openApi.json()).resolves.toMatchObject({ info: { title: "Gittensory API" } });

    const mcp = await worker.fetch(new Request("https://gittensory.test/mcp", { method: "POST" }), {} as Env, createExecutionContext());
    expect(mcp.status).toBe(401);
  });
});
