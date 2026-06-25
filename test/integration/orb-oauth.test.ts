import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { createTestEnv } from "../helpers/d1";

describe("GET /v1/orb/oauth/callback (post-install landing)", () => {
  const app = createApp();

  it("is token-exempt + returns the connected page on install (no 401)", async () => {
    // Exercises requiresApiToken (exempt) + routeClassForPath (strict) for the path, then the handler.
    const res = await app.request("/v1/orb/oauth/callback?installation_id=142475427&setup_action=install", {}, createTestEnv());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Gittensory Orb connected");
    expect(html).toContain("gittensory.aethereal.dev");
  });

  it("returns the updated page on a repo-selection update", async () => {
    const res = await app.request("/v1/orb/oauth/callback?setup_action=update", {}, createTestEnv());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Gittensory Orb updated");
  });

  it("defaults to the connected page when setup_action is absent", async () => {
    const res = await app.request("/v1/orb/oauth/callback", {}, createTestEnv());
    expect(await res.text()).toContain("Gittensory Orb connected");
  });

  it("the new exemption + rate class are path-specific (a later orb path still routes)", async () => {
    // /v1/orb/ingest falls through PAST the new callback checks, exercising their FALSE side in both
    // requiresApiToken + routeClassForPath (the webhook path short-circuits earlier and wouldn't reach them).
    const res = await app.request("/v1/orb/ingest", { method: "POST" }, createTestEnv());
    expect([400, 413]).toContain(res.status); // reached the (exempt) ingest handler, failed only on the empty body
  });
});
