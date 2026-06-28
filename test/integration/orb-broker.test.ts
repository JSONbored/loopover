import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { brokerOrbToken, isOrbBrokerEnabled, issueOrbEnrollment } from "../../src/orb/broker";
import { createTestEnv, type TestD1Database } from "../helpers/d1";

async function pkcs8Pem(): Promise<string> {
  const key = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const b64 = Buffer.from((await crypto.subtle.exportKey("pkcs8", key.privateKey)) as ArrayBuffer).toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`;
}
const db = (e: Env) => e.DB as unknown as TestD1Database;
const seedInstall = (e: Env, id: number, cols: Record<string, string | number | null> = {}) => {
  const all: Record<string, string | number | null> = { installation_id: id, registered: 1, ...cols };
  const keys = Object.keys(all);
  return db(e).prepare(`INSERT INTO orb_github_installations (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).bind(...keys.map((k) => all[k] as string | number | null)).run();
};
const brokerEnv = async (over: Partial<Env> = {}): Promise<Env> =>
  createTestEnv({ ORB_BROKER_ENABLED: "true", ORB_GITHUB_APP_ID: "4139483", ORB_GITHUB_APP_PRIVATE_KEY: await pkcs8Pem(), INTERNAL_JOB_TOKEN: "dev-internal-token", ...over });
const tokenFetch = (token = "ghs_broker", expires = "2026-06-25T08:00:00Z") => vi.stubGlobal("fetch", async () => Response.json({ token, expires_at: expires }));

afterEach(() => vi.unstubAllGlobals());

describe("isOrbBrokerEnabled", () => {
  it("is off by default, on for a truthy flag", () => {
    expect(isOrbBrokerEnabled(createTestEnv())).toBe(false);
    expect(isOrbBrokerEnabled(createTestEnv({ ORB_BROKER_ENABLED: "true" }))).toBe(true);
  });
});

describe("issueOrbEnrollment", () => {
  it("404s an unknown install, rejects an unregistered one, issues a hashed secret for a registered one", async () => {
    const e = await brokerEnv();
    expect(await issueOrbEnrollment(e, 999)).toEqual({ error: "installation_not_found" });
    await seedInstall(e, 200, { registered: 0 });
    expect(await issueOrbEnrollment(e, 200)).toEqual({ error: "installation_not_registered" });
    await seedInstall(e, 201, { registered: 1 });
    const issued = await issueOrbEnrollment(e, 201);
    expect(issued).toMatchObject({ enrollId: expect.stringMatching(/^orbenr_/), secret: expect.stringMatching(/^orbsec_/) });
    const row = await db(e).prepare("SELECT state, installation_id, secret_hash FROM orb_enrollments WHERE installation_id=201").first<{ state: string; installation_id: number; secret_hash: string }>();
    expect(row).toMatchObject({ state: "enrolled", installation_id: 201 });
    expect(row?.secret_hash).not.toContain("orbsec"); // stored hashed, never plaintext
  });
});

describe("brokerOrbToken", () => {
  it("mints a token for a valid enrollment on a registered install (id bound server-side)", async () => {
    const e = await brokerEnv();
    await seedInstall(e, 300, { registered: 1 });
    const { secret } = (await issueOrbEnrollment(e, 300)) as { secret: string };
    tokenFetch("ghs_minted", "2026-06-25T08:00:00Z");
    expect(await brokerOrbToken(e, secret)).toEqual({ token: "ghs_minted", installationId: 300, expiresAt: "2026-06-25T08:00:00Z" });
    expect((await db(e).prepare("SELECT last_token_at FROM orb_enrollments WHERE installation_id=300").first<{ last_token_at: string | null }>())?.last_token_at).not.toBeNull();
  });

  it("rejects an unknown or revoked enrollment", async () => {
    const e = await brokerEnv();
    expect(await brokerOrbToken(e, "orbsec_bogus")).toEqual({ error: "invalid_enrollment" });
    await seedInstall(e, 301, { registered: 1 });
    const { secret } = (await issueOrbEnrollment(e, 301)) as { secret: string };
    await db(e).prepare("UPDATE orb_enrollments SET revoked_at=CURRENT_TIMESTAMP WHERE installation_id=301").run();
    expect(await brokerOrbToken(e, secret)).toEqual({ error: "invalid_enrollment" });
  });

  it("re-checks the install gate at mint time (unregistered / suspended / removed → not eligible)", async () => {
    const e = await brokerEnv();
    await seedInstall(e, 302, { registered: 1 });
    const { secret } = (await issueOrbEnrollment(e, 302)) as { secret: string };
    await db(e).prepare("UPDATE orb_github_installations SET suspended_at=CURRENT_TIMESTAMP WHERE installation_id=302").run();
    expect(await brokerOrbToken(e, secret)).toEqual({ error: "installation_not_eligible" });
  });

  it("caches the minted token (encrypted) and serves it WITHOUT re-minting on the next exchange (#12)", async () => {
    const e = await brokerEnv({ TOKEN_ENCRYPTION_SECRET: "test-encryption-key-material-0001" });
    await seedInstall(e, 310, { registered: 1 });
    const { secret } = (await issueOrbEnrollment(e, 310)) as { secret: string };
    let mints = 0;
    vi.stubGlobal("fetch", async () => {
      mints += 1;
      return Response.json({ token: `ghs_${mints}`, expires_at: new Date(Date.now() + 60 * 60_000).toISOString() });
    });
    const first = await brokerOrbToken(e, secret);
    const second = await brokerOrbToken(e, secret);
    expect(first).toMatchObject({ token: "ghs_1", installationId: 310 });
    expect(second).toMatchObject({ token: "ghs_1" }); // served from the cache, NOT re-minted
    expect(mints).toBe(1); // GitHub's token endpoint was hit ONCE across two exchanges (no throttling)
    const cached = (await db(e).prepare("SELECT cached_token_json FROM orb_enrollments WHERE installation_id=310").first<{ cached_token_json: string }>())?.cached_token_json ?? "";
    expect(cached).not.toContain("ghs_1"); // stored encrypted, never plaintext
    expect(cached).toContain("ciphertext");
  });

  it("re-mints when the cached token is within the expiry margin (never serves a near-expired token)", async () => {
    const e = await brokerEnv({ TOKEN_ENCRYPTION_SECRET: "test-encryption-key-material-0001" });
    await seedInstall(e, 311, { registered: 1 });
    const { secret } = (await issueOrbEnrollment(e, 311)) as { secret: string };
    let mints = 0;
    vi.stubGlobal("fetch", async () => {
      mints += 1;
      return Response.json({ token: `ghs_${mints}`, expires_at: new Date(Date.now() + 60 * 60_000).toISOString() });
    });
    // Seed a cache entry only ~5m from expiry (inside the 10m re-mint margin) — read returns before decrypting.
    await db(e).prepare("UPDATE orb_enrollments SET cached_token_json = ? WHERE installation_id=311").bind(JSON.stringify({ ciphertext: "x", iv: "y", salt: null, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() })).run();
    expect(await brokerOrbToken(e, secret)).toMatchObject({ token: "ghs_1" }); // a fresh mint, not the near-expired entry
    expect(mints).toBe(1);
  });

  it("re-mints when the cached entry is unparseable (JSON/decrypt failure falls through)", async () => {
    const e = await brokerEnv({ TOKEN_ENCRYPTION_SECRET: "test-encryption-key-material-0001" });
    await seedInstall(e, 312, { registered: 1 });
    const { secret } = (await issueOrbEnrollment(e, 312)) as { secret: string };
    await db(e).prepare("UPDATE orb_enrollments SET cached_token_json = 'not-json' WHERE installation_id=312").run();
    vi.stubGlobal("fetch", async () => Response.json({ token: "ghs_fresh", expires_at: new Date(Date.now() + 60 * 60_000).toISOString() }));
    expect(await brokerOrbToken(e, secret)).toMatchObject({ token: "ghs_fresh" }); // malformed cache ignored, re-minted
  });

  it("swallows a cache-write failure — a valid token exchange never fails on a cache hiccup", async () => {
    const e = await brokerEnv({ TOKEN_ENCRYPTION_SECRET: "test-encryption-key-material-0001" });
    await seedInstall(e, 313, { registered: 1 });
    const { secret } = (await issueOrbEnrollment(e, 313)) as { secret: string };
    vi.stubGlobal("fetch", async () => Response.json({ token: "ghs_ok", expires_at: new Date(Date.now() + 60 * 60_000).toISOString() }));
    const real = e.DB;
    (e as { DB: unknown }).DB = {
      prepare: (sql: string) =>
        sql.includes("SET cached_token_json") ? { bind: () => ({ run: () => Promise.reject(new Error("cache write boom")) }) } : real.prepare(sql),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await brokerOrbToken(e, secret)).toMatchObject({ token: "ghs_ok" }); // mint succeeded despite the cache write failing
    expect(warn.mock.calls.some(([l]) => String(l).includes("orb_token_cache_write_failed"))).toBe(true);
    warn.mockRestore();
  });
});

describe("broker endpoints", () => {
  const app = createApp();
  const auth = { authorization: "Bearer dev-internal-token" };

  it("both routes 404 when the broker flag is off (byte-identical deploy)", async () => {
    const off = createTestEnv({ INTERNAL_JOB_TOKEN: "dev-internal-token" });
    expect((await app.request("/v1/orb/token", { method: "POST" }, off)).status).toBe(404);
    expect((await app.request("/v1/internal/orb/enrollments", { method: "POST", headers: auth, body: "{}" }, off)).status).toBe(404);
  });

  it("the full operator-issue → container-exchange flow over HTTP", async () => {
    const e = await brokerEnv();
    await seedInstall(e, 400, { registered: 1 });
    const issueRes = await app.request("/v1/internal/orb/enrollments", { method: "POST", headers: auth, body: JSON.stringify({ installationId: 400 }) }, e);
    expect(issueRes.status).toBe(200);
    const { secret } = (await issueRes.json()) as { secret: string };
    tokenFetch("ghs_flow");
    const tokRes = await app.request("/v1/orb/token", { method: "POST", headers: { authorization: `Bearer ${secret}` } }, e);
    expect(tokRes.status).toBe(200);
    expect(await tokRes.json()).toMatchObject({ token: "ghs_flow", installationId: 400 });
  });

  it("/v1/orb/token: 401 without a Bearer secret, 401 on a bad secret, 403 when the install became ineligible", async () => {
    const e = await brokerEnv();
    expect((await app.request("/v1/orb/token", { method: "POST" }, e)).status).toBe(401);
    expect((await app.request("/v1/orb/token", { method: "POST", headers: { authorization: "Bearer orbsec_bad" } }, e)).status).toBe(401);
    await seedInstall(e, 401, { registered: 1 });
    const { secret } = (await issueOrbEnrollment(e, 401)) as { secret: string };
    await db(e).prepare("UPDATE orb_github_installations SET registered=0 WHERE installation_id=401").run();
    expect((await app.request("/v1/orb/token", { method: "POST", headers: { authorization: `Bearer ${secret}` } }, e)).status).toBe(403);
  });

  it("/v1/internal/orb/enrollments: 400 missing id, 409 unregistered, 404 unknown", async () => {
    const e = await brokerEnv();
    await seedInstall(e, 402, { registered: 0 });
    expect((await db(e).prepare("SELECT self_enrollment_disabled FROM orb_github_installations WHERE installation_id=402").first<{ self_enrollment_disabled: number }>())?.self_enrollment_disabled).toBe(0);
    expect((await app.request("/v1/internal/orb/installations/register", { method: "POST", headers: auth, body: JSON.stringify({ installationId: 402, registered: false }) }, e)).status).toBe(200);
    expect((await db(e).prepare("SELECT registered, self_enrollment_disabled FROM orb_github_installations WHERE installation_id=402").first<{ registered: number; self_enrollment_disabled: number }>())).toMatchObject({ registered: 0, self_enrollment_disabled: 1 });
    expect((await app.request("/v1/internal/orb/installations/register", { method: "POST", headers: auth, body: JSON.stringify({ installationId: 402 }) }, e)).status).toBe(200);
    expect((await db(e).prepare("SELECT registered, self_enrollment_disabled FROM orb_github_installations WHERE installation_id=402").first<{ registered: number; self_enrollment_disabled: number }>())).toMatchObject({ registered: 1, self_enrollment_disabled: 0 });
    await db(e).prepare("UPDATE orb_github_installations SET registered=0 WHERE installation_id=402").run();
    expect((await app.request("/v1/internal/orb/enrollments", { method: "POST", headers: auth, body: "{}" }, e)).status).toBe(400);
    expect((await app.request("/v1/internal/orb/enrollments", { method: "POST", headers: auth, body: "{bad" }, e)).status).toBe(400); // unparseable JSON → catch → null
    expect((await app.request("/v1/internal/orb/enrollments", { method: "POST", headers: auth, body: JSON.stringify({ installationId: 402 }) }, e)).status).toBe(409);
    expect((await app.request("/v1/internal/orb/enrollments", { method: "POST", headers: auth, body: JSON.stringify({ installationId: 999 }) }, e)).status).toBe(404);
  });
});
