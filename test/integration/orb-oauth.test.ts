import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { exchangeOrbOAuthCode, fetchOrbOAuthUser, verifyInstallationAdmin } from "../../src/orb/oauth";
import { createTestEnv, type TestD1Database } from "../helpers/d1";

const asFetch = (fn: (url: string) => Promise<Response>): typeof fetch => ((url: RequestInfo | URL) => fn(String(url))) as typeof fetch;

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

describe("verifyInstallationAdmin (the privilege-escalation gate)", () => {
  it("a USER-account install: only the account owner is an admin (case-insensitive)", async () => {
    const f = asFetch(async () => Response.json({}));
    expect(await verifyInstallationAdmin("t", "Alice", "alice", "User", f)).toBe(true);
    expect(await verifyInstallationAdmin("t", "mallory", "alice", "User", f)).toBe(false);
  });
  it("an ORG install: an ACTIVE org admin passes; a member, a pending admin, and an API error all fail", async () => {
    expect(await verifyInstallationAdmin("t", "alice", "acme", "Organization", asFetch(async () => Response.json({ role: "admin", state: "active" })))).toBe(true);
    expect(await verifyInstallationAdmin("t", "bob", "acme", "Organization", asFetch(async () => Response.json({ role: "member", state: "active" })))).toBe(false);
    expect(await verifyInstallationAdmin("t", "carol", "acme", "Organization", asFetch(async () => Response.json({ role: "admin", state: "pending" })))).toBe(false);
    expect(await verifyInstallationAdmin("t", "mallory", "acme", "Organization", asFetch(async () => new Response("no", { status: 403 })))).toBe(false);
    expect(await verifyInstallationAdmin("t", "alice", "acme", "Organization", asFetch(async () => new Response("not-json", { status: 200 })))).toBe(false); // json() rejects → {} → not admin
  });
  it("a missing account login is never admin", async () => {
    expect(await verifyInstallationAdmin("t", "alice", null, "Organization", asFetch(async () => Response.json({})))).toBe(false);
  });
});

describe("exchangeOrbOAuthCode + fetchOrbOAuthUser", () => {
  it("exchange returns null without client credentials, the token otherwise, null on a tokenless body", async () => {
    expect(await exchangeOrbOAuthCode({} as Env, "c")).toBeNull();
    const env = { ORB_GITHUB_CLIENT_ID: "id", ORB_GITHUB_CLIENT_SECRET: "sec" } as Env;
    expect(await exchangeOrbOAuthCode(env, "c", asFetch(async () => Response.json({ access_token: "ghu_x" })))).toBe("ghu_x");
    expect(await exchangeOrbOAuthCode(env, "c", asFetch(async () => Response.json({})))).toBeNull();
    expect(await exchangeOrbOAuthCode(env, "c", asFetch(async () => new Response("not-json")))).toBeNull(); // json() rejects → {} → null
  });
  it("user fetch returns the user on ok, null on a non-ok / loginless response", async () => {
    expect(await fetchOrbOAuthUser("t", asFetch(async () => Response.json({ login: "alice", id: 1 })))).toEqual({ login: "alice", id: 1 });
    expect(await fetchOrbOAuthUser("t", asFetch(async () => new Response("no", { status: 401 })))).toBeNull();
  });
});

describe("maintainer self-enrollment via the OAuth callback", () => {
  const app = createApp();
  const db = (e: Env) => e.DB as unknown as TestD1Database;
  const brokeredEnv = () => createTestEnv({ ORB_BROKER_ENABLED: "true", ORB_GITHUB_CLIENT_ID: "id", ORB_GITHUB_CLIENT_SECRET: "sec" });
  const seedInstall = (e: Env, cols: Record<string, string | number>) => {
    const keys = Object.keys(cols);
    return db(e).prepare(`INSERT INTO orb_github_installations (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).bind(...keys.map((k) => cols[k] as string | number)).run();
  };
  const stubGitHub = (over: { token?: string; user?: unknown; membership?: unknown } = {}) =>
    vi.stubGlobal("fetch", asFetch(async (url) => {
      if (url.includes("/login/oauth/access_token")) return Response.json({ access_token: over.token ?? "ghu_x" });
      if (url.includes("api.github.com/user/memberships/orgs/")) return Response.json(over.membership ?? { role: "admin", state: "active" });
      if (url.endsWith("api.github.com/user")) return Response.json(over.user ?? { login: "alice", id: 7 });
      return new Response("nf", { status: 404 });
    }));
  afterEach(() => vi.unstubAllGlobals());

  it("an org ADMIN self-enrolls a registered install → a one-time secret + recorded maintainer identity", async () => {
    const e = brokeredEnv();
    await seedInstall(e, { installation_id: 500, account_login: "acme", account_type: "Organization", registered: 1 });
    stubGitHub();
    const res = await app.request("/v1/orb/oauth/callback?code=abc&installation_id=500", {}, e);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Your enrollment secret");
    expect(html).toMatch(/orbsec_/);
    const row = await db(e).prepare("SELECT maintainer_login, maintainer_github_id FROM orb_enrollments WHERE installation_id=500").first<{ maintainer_login: string; maintainer_github_id: number }>();
    expect(row).toMatchObject({ maintainer_login: "alice", maintainer_github_id: 7 });
  });

  it("a NON-admin is refused (403), NO enrollment created, and the install is NOT auto-registered — the escalation gate", async () => {
    const e = brokeredEnv();
    await seedInstall(e, { installation_id: 501, account_login: "acme", account_type: "Organization", registered: 0 });
    stubGitHub({ membership: { role: "member", state: "active" } });
    const res = await app.request("/v1/orb/oauth/callback?code=abc&installation_id=501", {}, e);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Admin access required");
    expect(await db(e).prepare("SELECT 1 AS x FROM orb_enrollments WHERE installation_id=501").first()).toBeUndefined();
    const row = await db(e).prepare("SELECT registered FROM orb_github_installations WHERE installation_id=501").first<{ registered: number }>();
    expect(row?.registered).toBe(0); // a non-admin never auto-registers
  });

  it("a verified admin AUTO-REGISTERS an unregistered install (zero-touch) and gets a secret", async () => {
    const e = brokeredEnv();
    await seedInstall(e, { installation_id: 502, account_login: "acme", account_type: "Organization", registered: 0 });
    stubGitHub();
    const res = await app.request("/v1/orb/oauth/callback?code=abc&installation_id=502", {}, e);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Your enrollment secret");
    const row = await db(e).prepare("SELECT registered FROM orb_github_installations WHERE installation_id=502").first<{ registered: number }>();
    expect(row?.registered).toBe(1); // self-registered, no operator step
  });

  it("an operator-disabled install cannot be self-reenabled through OAuth", async () => {
    const e = brokeredEnv();
    await seedInstall(e, { installation_id: 503, account_login: "acme", account_type: "Organization", registered: 0, self_enrollment_disabled: 1 });
    stubGitHub();
    const res = await app.request("/v1/orb/oauth/callback?code=abc&installation_id=503", {}, e);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Installation disabled");
    expect(await db(e).prepare("SELECT 1 AS x FROM orb_enrollments WHERE installation_id=503").first()).toBeUndefined();
    const row = await db(e).prepare("SELECT registered FROM orb_github_installations WHERE installation_id=503").first<{ registered: number }>();
    expect(row?.registered).toBe(0);
  });

  it("a SUSPENDED or UNINSTALLED install is refused (403 not active), even for an admin", async () => {
    const e = brokeredEnv();
    await seedInstall(e, { installation_id: 507, account_login: "acme", account_type: "Organization", registered: 1, suspended_at: "2026-01-01T00:00:00Z" });
    await seedInstall(e, { installation_id: 508, account_login: "acme", account_type: "Organization", registered: 0, removed_at: "2026-01-01T00:00:00Z" });
    stubGitHub();
    expect((await app.request("/v1/orb/oauth/callback?code=abc&installation_id=507", {}, e)).status).toBe(403); // suspended (removed_at null → right arm)
    const removed = await app.request("/v1/orb/oauth/callback?code=abc&installation_id=508", {}, e);
    expect(removed.status).toBe(403); // removed (left arm)
    expect(await removed.text()).toContain("not active");
  });

  it("an UNKNOWN install is 404", async () => {
    const e = brokeredEnv();
    stubGitHub();
    expect((await app.request("/v1/orb/oauth/callback?code=abc&installation_id=999", {}, e)).status).toBe(404);
  });

  it("a USER-account owner self-enrolls (a login-only identity stores a null github id)", async () => {
    const e = brokeredEnv();
    await seedInstall(e, { installation_id: 504, account_login: "alice", account_type: "User", registered: 1 });
    stubGitHub({ user: { login: "alice" } }); // no id → user.id ?? null
    expect(await (await app.request("/v1/orb/oauth/callback?code=abc&installation_id=504", {}, e)).text()).toContain("Your enrollment secret");
    const row = await db(e).prepare("SELECT maintainer_login, maintainer_github_id FROM orb_enrollments WHERE installation_id=504").first<{ maintainer_login: string; maintainer_github_id: number | null }>();
    expect(row).toMatchObject({ maintainer_login: "alice", maintainer_github_id: null });
  });

  it("a failed code exchange → 400; the broker being OFF falls through to the landing page", async () => {
    const e = brokeredEnv();
    await seedInstall(e, { installation_id: 505, account_login: "acme", account_type: "Organization", registered: 1 });
    vi.stubGlobal("fetch", asFetch(async () => Response.json({}))); // no access_token
    expect((await app.request("/v1/orb/oauth/callback?code=abc&installation_id=505", {}, e)).status).toBe(400);
    const off = createTestEnv({ ORB_GITHUB_CLIENT_ID: "id", ORB_GITHUB_CLIENT_SECRET: "sec" }); // broker OFF
    expect(await (await app.request("/v1/orb/oauth/callback?code=abc&installation_id=505", {}, off)).text()).toContain("Gittensory Orb connected");
  });

  it("a failed /user read → 400", async () => {
    const e = brokeredEnv();
    await seedInstall(e, { installation_id: 506, account_login: "acme", account_type: "Organization", registered: 1 });
    vi.stubGlobal("fetch", asFetch(async (url) => (url.endsWith("api.github.com/user") ? new Response("no", { status: 401 }) : Response.json({ access_token: "x" }))));
    expect((await app.request("/v1/orb/oauth/callback?code=abc&installation_id=506", {}, e)).status).toBe(400);
  });

  it("a code with a non-numeric or non-positive installation_id is NOT an enrollment → landing page", async () => {
    stubGitHub();
    expect(await (await app.request("/v1/orb/oauth/callback?code=abc&installation_id=nope", {}, brokeredEnv())).text()).toContain("Gittensory Orb connected"); // Number.isInteger false
    expect(await (await app.request("/v1/orb/oauth/callback?code=abc&installation_id=0", {}, brokeredEnv())).text()).toContain("Gittensory Orb connected"); // installationId > 0 false
  });
});
