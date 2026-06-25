import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { createTestEnv, type TestD1Database } from "../helpers/d1";

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
});
