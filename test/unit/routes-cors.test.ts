import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { createTestEnv } from "../helpers/d1";

// A fresh Cloudflare Workers preview build (ui-preview-deploy.yml) lands on a random
// <alias>-loopover-ui.<sub>.workers.dev hostname every deploy -- a static exact-match CORS allowlist can
// never enumerate these. Confirmed live: browserless's visual-review capture of a PR preview was hitting
// real CORS errors calling /health and /v1/public/stats from exactly this class of origin.
const PREVIEW_ORIGIN = "https://a1b2c3d4-loopover-ui.some-account.workers.dev";

describe("CORS: public no-credential routes open to any origin (#ops-anomaly-preview-cors)", () => {
  it("GET /health reflects an arbitrary *.workers.dev origin with NO credentials header", async () => {
    const app = createApp();
    const env = createTestEnv();
    const res = await app.request("/health", { headers: { origin: PREVIEW_ORIGIN } }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("GET /v1/public/stats reflects an arbitrary *.pages.dev origin with NO credentials header", async () => {
    const app = createApp();
    const env = createTestEnv();
    env.LOOPOVER_PUBLIC_STATS = "true";
    const res = await app.request("/v1/public/stats", { headers: { origin: "https://random-preview.pages.dev" } }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("GET /v1/public/github/repos/:owner/:repo/stats reflects an arbitrary origin with NO credentials header (dynamic path segments)", async () => {
    const app = createApp();
    const env = createTestEnv();
    const res = await app.request("/v1/public/github/repos/acme/widgets/stats", { headers: { origin: PREVIEW_ORIGIN } }, env);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("OPTIONS preflight on a public no-credential route also gets the open, no-credentials headers", async () => {
    const app = createApp();
    const env = createTestEnv();
    const res = await app.request("/health", { method: "OPTIONS", headers: { origin: PREVIEW_ORIGIN } }, env);
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });
});

describe("CORS: everything else stays on the strict, credentialed allowlist (#ops-anomaly-preview-cors)", () => {
  it("REGRESSION: an authenticated route from an unlisted *.workers.dev origin gets NO CORS headers at all (not opened up)", async () => {
    const app = createApp();
    const env = createTestEnv();
    const res = await app.request("/v1/app/kill-switch", { headers: { origin: PREVIEW_ORIGIN, authorization: `Bearer ${env.LOOPOVER_API_TOKEN}` } }, env);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("REGRESSION: a genuinely allowlisted origin on a non-public route still gets the credentialed treatment unchanged", async () => {
    const app = createApp();
    const env = createTestEnv();
    const res = await app.request("/v1/app/kill-switch", { headers: { origin: "https://loopover.ai", authorization: `Bearer ${env.LOOPOVER_API_TOKEN}` } }, env);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://loopover.ai");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("a *.workers.dev origin does NOT get the open treatment on /v1/public/subnet-interface (public, but not in the no-credential allowlist by design -- only the 3 routes that were actually failing)", async () => {
    const app = createApp();
    const env = createTestEnv();
    const res = await app.request("/v1/public/subnet-interface", { headers: { origin: PREVIEW_ORIGIN } }, env);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("CORS: the public no-credential branch varies by Origin (#9712)", () => {
  it("GET /health with an Origin returns Access-Control-Allow-Origin: * AND Vary: Origin", async () => {
    const app = createApp();
    const env = createTestEnv();
    const res = await app.request("/health", { headers: { origin: PREVIEW_ORIGIN } }, env);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("vary")).toContain("Origin");
  });

  it("GET /v1/public/stats and the per-repo badge route also carry Vary: Origin on the open branch", async () => {
    const app = createApp();
    const env = createTestEnv();
    env.LOOPOVER_PUBLIC_STATS = "true";
    const stats = await app.request("/v1/public/stats", { headers: { origin: "https://random-preview.pages.dev" } }, env);
    expect(stats.headers.get("access-control-allow-origin")).toBe("*");
    expect(stats.headers.get("vary")).toContain("Origin");

    const badge = await app.request("/v1/public/github/repos/acme/widgets/stats", { headers: { origin: PREVIEW_ORIGIN } }, env);
    expect(badge.headers.get("access-control-allow-origin")).toBe("*");
    expect(badge.headers.get("vary")).toContain("Origin");
  });

  it("GET /health with NO Origin sets no Access-Control-Allow-Origin — proving the response genuinely varies", async () => {
    const app = createApp();
    const env = createTestEnv();
    const res = await app.request("/health", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("REGRESSION: the credentialed branch still returns exactly one Vary: Origin plus credentials", async () => {
    const app = createApp();
    const env = createTestEnv();
    const res = await app.request("/v1/app/kill-switch", { headers: { origin: "https://loopover.ai", authorization: `Bearer ${env.LOOPOVER_API_TOKEN}` } }, env);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    // Exactly one Origin token — appended, not duplicated or overwritten.
    expect((res.headers.get("vary") ?? "").split(",").map((v) => v.trim()).filter((v) => v === "Origin")).toEqual(["Origin"]);
  });
});
