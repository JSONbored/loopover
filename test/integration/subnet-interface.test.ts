import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { createTestEnv } from "../helpers/d1";

describe("public subnet-interface descriptor route", () => {
  it("serves the SN74 contribution-interface descriptor without authentication", async () => {
    const app = createApp();
    const env = createTestEnv({ GITHUB_APP_SLUG: "gittensory", PUBLIC_API_ORIGIN: "https://gittensory-api.aethereal.dev" });

    const response = await app.request("/v1/public/subnet-interface", {}, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("max-age=600");
    await expect(response.json()).resolves.toMatchObject({
      schemaVersion: "1.0",
      subnet: { netuid: 74, name: "gittensor" },
      provider: { name: "Gittensory", role: "contribution_interface" },
      interfaces: {
        mcp: { endpoint: "https://gittensory-api.aethereal.dev/mcp", transport: "http" },
        githubApp: { slug: "gittensory", installUrl: "https://github.com/apps/gittensory" },
      },
    });
  });

  it("falls back to the request origin when PUBLIC_API_ORIGIN is unset", async () => {
    const app = createApp();
    const env = createTestEnv({ GITHUB_APP_SLUG: "gittensory" });
    delete (env as Partial<Env>).PUBLIC_API_ORIGIN;

    const response = await app.request("https://fallback.example/v1/public/subnet-interface", {}, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      interfaces: { mcp: { endpoint: "https://fallback.example/mcp" } },
    });
  });
});
