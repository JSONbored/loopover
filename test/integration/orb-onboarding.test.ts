import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { createTestEnv, type TestD1Database } from "../helpers/d1";

async function pkcs8Pem(): Promise<string> {
  const key = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const b64 = Buffer.from((await crypto.subtle.exportKey("pkcs8", key.privateKey)) as ArrayBuffer).toString("base64").replace(/(.{64})/g, "$1\n");
  return ["-----BEGIN", "PRIVATE KEY-----"].join(" ") + `\n${b64}\n` + ["-----END", "PRIVATE KEY-----"].join(" ");
}

describe("Central Orb installation registry routes (/v1/internal/orb/installations)", () => {
  const app = createApp();
  const auth = { authorization: "Bearer dev-internal-token" };
  const seed = (env: Env, id: number, registered = 0) =>
    (env.DB as unknown as TestD1Database)
      .prepare("INSERT INTO orb_github_installations (installation_id, account_login, account_type, registered) VALUES (?, 'acme', 'Organization', ?)")
      .bind(id, registered)
      .run();
  const register = (env: Env, body: unknown) =>
    app.request("/v1/internal/orb/installations/register", { method: "POST", headers: auth, body: typeof body === "string" ? body : JSON.stringify(body) }, env);

  afterEach(() => vi.unstubAllGlobals());

  it("lists recorded installations (registered surfaced as a boolean)", async () => {
    const env = createTestEnv();
    await seed(env, 100);
    const res = await app.request("/v1/internal/orb/installations", { headers: auth }, env);
    expect(res.status).toBe(200);
    const { installations } = (await res.json()) as { installations: Array<{ installationId: number; accountLogin: string; registered: boolean }> };
    expect(installations).toEqual([expect.objectContaining({ installationId: 100, accountLogin: "acme", registered: false })]);
  });

  it("401 without the internal token", async () => {
    expect((await app.request("/v1/internal/orb/installations", {}, createTestEnv())).status).toBe(401);
  });

  it("registers an installation, then unregisters it", async () => {
    const env = createTestEnv();
    await seed(env, 101);
    expect(((await (await register(env, { installationId: 101 })).json()) as { registered: boolean }).registered).toBe(true);
    expect(((await (await register(env, { installationId: 101, registered: false })).json()) as { registered: boolean }).registered).toBe(false);
  });

  it("404 when the installation has not been recorded by a webhook yet", async () => {
    expect((await register(createTestEnv(), { installationId: 999 })).status).toBe(404);
  });

  it("400 when installationId is missing, non-numeric, or not positive", async () => {
    expect((await register(createTestEnv(), {})).status).toBe(400); // missing → NaN
    expect((await register(createTestEnv(), "{bad")).status).toBe(400); // unparseable JSON → null
    expect((await register(createTestEnv(), { installationId: 0 })).status).toBe(400); // not positive
  });

  it("tolerates a list query that omits results (rows.results ?? [])", async () => {
    const env = { ...createTestEnv(), DB: { prepare: () => ({ all: () => Promise.resolve({}) }) } } as unknown as Env;
    const res = await app.request("/v1/internal/orb/installations", { headers: auth }, env);
    expect(((await res.json()) as { installations: unknown[] }).installations).toEqual([]);
  });

  it("backfills the registry from GitHub, recovering a webhook-missed installation", async () => {
    const env = createTestEnv({ ORB_GITHUB_APP_ID: "4139483", ORB_GITHUB_APP_PRIVATE_KEY: await pkcs8Pem() });
    await seed(env, 200, 1); // already recorded + opted in
    vi.stubGlobal("fetch", async () =>
      Response.json([
        { id: 200, account: { login: "acme", type: "Organization", id: 20 }, repository_selection: "all" },
        { id: 201, account: { login: "bob", type: "User", id: 21 }, repository_selection: "selected" }, // webhook fired pre-secret → never recorded
      ]),
    );
    const res = await app.request("/v1/internal/orb/installations/backfill", { method: "POST", headers: auth }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ backfilled: 2 });
    const rows = await (env.DB as unknown as TestD1Database)
      .prepare("SELECT installation_id, account_login, registered FROM orb_github_installations ORDER BY installation_id")
      .all<{ installation_id: number; account_login: string; registered: number }>();
    expect(rows.results).toEqual([
      { installation_id: 200, account_login: "acme", registered: 1 }, // stayed trusted (backfill never re-trusts/untrusts)
      { installation_id: 201, account_login: "bob", registered: 0 }, // recovered at the onboarding gate
    ]);
  });

  it("401 without the internal token on the backfill route", async () => {
    expect((await app.request("/v1/internal/orb/installations/backfill", { method: "POST" }, createTestEnv())).status).toBe(401);
  });
});
