import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { brokerOrbToken, isOrbBrokerEnabled, issueOrbEnrollment } from "../../src/orb/broker";
import { MAX_ORB_RELAY_REGISTER_BODY_BYTES } from "../../src/orb/relay";
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
// `exactOptionalPropertyTypes` forbids `KEY: undefined` overrides, so a truly-ABSENT App credential means simply
// never setting the key (not spreading `undefined` over it) — hence a dedicated builder rather than `brokerEnv({...})`.
const brokerEnvMissingAppCreds = async (missing: "id" | "key" | "both", over: Partial<Env> = {}): Promise<Env> => {
  const base: Partial<Env> = { ORB_BROKER_ENABLED: "true", INTERNAL_JOB_TOKEN: "dev-internal-token", ...over };
  if (missing !== "id") base.ORB_GITHUB_APP_ID = "4139483";
  if (missing !== "key") base.ORB_GITHUB_APP_PRIVATE_KEY = await pkcs8Pem();
  return createTestEnv(base);
};
const tokenFetch = (token = "ghs_broker", expires = "2026-06-25T08:00:00Z", permissions: Record<string, string> = {}) =>
  vi.stubGlobal("fetch", async () => Response.json({ token, expires_at: expires, permissions }));
const countingTokenFetch = (expires = "2026-06-25T08:00:00Z", permissions: Record<string, string> = {}) => {
  let calls = 0;
  vi.stubGlobal("fetch", async () => {
    calls += 1;
    return Response.json({ token: `ghs_minted_${calls}`, expires_at: expires, permissions });
  });
  return () => calls;
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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
    tokenFetch("ghs_minted", "2026-06-25T08:00:00Z", { contents: "write" });
    expect(await brokerOrbToken(e, secret)).toEqual({ token: "ghs_minted", installationId: 300, expiresAt: "2026-06-25T08:00:00Z", permissions: { contents: "write" } });
    expect((await db(e).prepare("SELECT last_token_at FROM orb_enrollments WHERE installation_id=300").first<{ last_token_at: string | null }>())?.last_token_at).not.toBeNull();
  });

  it("caches a freshly minted token and serves repeated exchanges without reminting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-25T07:00:00Z"));
    const e = await brokerEnv({ TOKEN_ENCRYPTION_SECRET: "orb-cache-test-secret" });
    await seedInstall(e, 303, { registered: 1 });
    const { secret } = (await issueOrbEnrollment(e, 303)) as { secret: string };
    const fetchCalls = countingTokenFetch("2026-06-25T08:00:00Z", { contents: "write", pull_requests: "write" });

    expect(await brokerOrbToken(e, secret)).toEqual({ token: "ghs_minted_1", installationId: 303, expiresAt: "2026-06-25T08:00:00Z", permissions: { contents: "write", pull_requests: "write" } });
    expect(await brokerOrbToken(e, secret)).toEqual({ token: "ghs_minted_1", installationId: 303, expiresAt: "2026-06-25T08:00:00Z", permissions: { contents: "write", pull_requests: "write" } });
    expect(fetchCalls()).toBe(1);
    const row = await db(e).prepare("SELECT cached_token_json FROM orb_enrollments WHERE installation_id=303").first<{ cached_token_json: string }>();
    expect(row?.cached_token_json).toContain("ciphertext");
    expect(row?.cached_token_json).not.toContain("ghs_minted_1");
  });

  it("forceRefresh bypasses a still-fresh broker cache and replaces the returned permission snapshot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-25T07:00:00Z"));
    const e = await brokerEnv({ TOKEN_ENCRYPTION_SECRET: "orb-cache-test-secret" });
    await seedInstall(e, 307, { registered: 1 });
    const { secret } = (await issueOrbEnrollment(e, 307)) as { secret: string };
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      return Response.json({
        token: `ghs_minted_${calls}`,
        expires_at: "2026-06-25T08:00:00Z",
        permissions: calls === 1 ? { contents: "read" } : { contents: "write" },
      });
    });

    expect(await brokerOrbToken(e, secret)).toMatchObject({ token: "ghs_minted_1", permissions: { contents: "read" } });
    expect(await brokerOrbToken(e, secret, { forceRefresh: true })).toMatchObject({ token: "ghs_minted_2", permissions: { contents: "write" } });
    expect(await brokerOrbToken(e, secret)).toMatchObject({ token: "ghs_minted_2", permissions: { contents: "write" } });
    expect(calls).toBe(2);
  });

  it("remints when the encrypted cache is absent, expired, or unreadable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-25T07:00:00Z"));
    const e = await brokerEnv({ TOKEN_ENCRYPTION_SECRET: "orb-cache-test-secret" });
    await seedInstall(e, 304, { registered: 1 });
    const { secret } = (await issueOrbEnrollment(e, 304)) as { secret: string };
    const fetchCalls = countingTokenFetch("2026-06-25T08:00:00Z");

    expect(await brokerOrbToken(e, secret)).toMatchObject({ token: "ghs_minted_1" });
    await db(e).prepare("UPDATE orb_enrollments SET cached_token_json = ? WHERE installation_id = 304").bind(JSON.stringify({ ciphertext: "bad", iv: "bad", salt: null, expiresAt: "2026-06-25T08:00:00Z" })).run();
    expect(await brokerOrbToken(e, secret)).toMatchObject({ token: "ghs_minted_2" });
    await db(e).prepare("UPDATE orb_enrollments SET cached_token_json = ? WHERE installation_id = 304").bind(JSON.stringify({ ciphertext: "bad", iv: "bad", salt: null, expiresAt: "2026-06-25T07:05:00Z" })).run();
    expect(await brokerOrbToken(e, secret)).toMatchObject({ token: "ghs_minted_3" });
    expect(fetchCalls()).toBe(3);
  });

  it("still returns a minted token when writing the encrypted cache fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-25T07:00:00Z"));
    const e = await brokerEnv({ TOKEN_ENCRYPTION_SECRET: "orb-cache-test-secret" });
    await seedInstall(e, 305, { registered: 1 });
    const { secret } = (await issueOrbEnrollment(e, 305)) as { secret: string };
    tokenFetch("ghs_cache_write_failed", "2026-06-25T08:00:00Z");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const originalPrepare = db(e).prepare.bind(db(e));
    vi.spyOn(db(e), "prepare").mockImplementation((sql: string) => {
      if (sql.includes("SET cached_token_json = ?")) {
        throw new Error("cache write unavailable");
      }
      return originalPrepare(sql);
    });

    expect(await brokerOrbToken(e, secret)).toEqual({ token: "ghs_cache_write_failed", installationId: 305, expiresAt: "2026-06-25T08:00:00Z", permissions: {} });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("orb_token_cache_write_failed"));
  });

  it("still returns a cached token when touching last_token_at fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-25T07:00:00Z"));
    const e = await brokerEnv({ TOKEN_ENCRYPTION_SECRET: "orb-cache-test-secret" });
    await seedInstall(e, 306, { registered: 1 });
    const { secret } = (await issueOrbEnrollment(e, 306)) as { secret: string };
    const fetchCalls = countingTokenFetch("2026-06-25T08:00:00Z");

    expect(await brokerOrbToken(e, secret)).toMatchObject({ token: "ghs_minted_1" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const originalPrepare = db(e).prepare.bind(db(e));
    vi.spyOn(db(e), "prepare").mockImplementation((sql: string) => {
      if (sql.includes("SET last_token_at = CURRENT_TIMESTAMP")) {
        throw new Error("timestamp write unavailable");
      }
      return originalPrepare(sql);
    });

    expect(await brokerOrbToken(e, secret)).toEqual({ token: "ghs_minted_1", installationId: 306, expiresAt: "2026-06-25T08:00:00Z", permissions: {} });
    expect(fetchCalls()).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("orb_token_last_touch_failed"));
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

  it("#2710 regression: an invalid secret NEVER reveals broker misconfiguration — invalid_enrollment wins even with no App credentials at all", async () => {
    // Before the fix, the ORB_GITHUB_APP_ID/PRIVATE_KEY check ran BEFORE the enrollment lookup, so ANY caller
    // (no valid secret required) could learn the server's deployment-config state via the response code. The
    // credential check must only ever run once the caller is already proven to hold a valid, eligible enrollment.
    const e = await brokerEnvMissingAppCreds("both");
    expect(await brokerOrbToken(e, "orbsec_totally_bogus")).toEqual({ error: "invalid_enrollment" });
  });

  it("returns broker_misconfigured only once the enrollment is valid+eligible and a real mint is required", async () => {
    const missingAppId = await brokerEnvMissingAppCreds("id");
    await seedInstall(missingAppId, 310, { registered: 1 });
    const { secret: secretA } = (await issueOrbEnrollment(missingAppId, 310)) as { secret: string };
    expect(await brokerOrbToken(missingAppId, secretA)).toEqual({ error: "broker_misconfigured" });

    const missingPrivateKey = await brokerEnvMissingAppCreds("key");
    await seedInstall(missingPrivateKey, 311, { registered: 1 });
    const { secret: secretB } = (await issueOrbEnrollment(missingPrivateKey, 311)) as { secret: string };
    expect(await brokerOrbToken(missingPrivateKey, secretB)).toEqual({ error: "broker_misconfigured" });
  });

  it("still eligible-checks BEFORE reporting broker_misconfigured (an ineligible install never leaks config state either)", async () => {
    const e = await brokerEnvMissingAppCreds("both");
    await seedInstall(e, 312, { registered: 1 });
    const { secret } = (await issueOrbEnrollment(e, 312)) as { secret: string };
    await db(e).prepare("UPDATE orb_github_installations SET removed_at=CURRENT_TIMESTAMP WHERE installation_id=312").run();
    expect(await brokerOrbToken(e, secret)).toEqual({ error: "installation_not_eligible" });
  });

  it("serves a still-fresh cached token even with no Orb App credentials at all (mint is never reached)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-25T07:00:00Z"));
    const e = await brokerEnv({ TOKEN_ENCRYPTION_SECRET: "orb-cache-test-secret" });
    await seedInstall(e, 313, { registered: 1 });
    const { secret } = (await issueOrbEnrollment(e, 313)) as { secret: string };
    tokenFetch("ghs_minted", "2026-06-25T08:00:00Z");
    expect(await brokerOrbToken(e, secret)).toEqual({ token: "ghs_minted", installationId: 313, expiresAt: "2026-06-25T08:00:00Z", permissions: {} });

    // Drop the App credentials AFTER the initial mint+cache — a still-fresh cache hit must not need them.
    const eNoCreds = await brokerEnvMissingAppCreds("both", { TOKEN_ENCRYPTION_SECRET: "orb-cache-test-secret", DB: e.DB });
    expect(await brokerOrbToken(eNoCreds, secret)).toEqual({ token: "ghs_minted", installationId: 313, expiresAt: "2026-06-25T08:00:00Z", permissions: {} });
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

  it("/v1/orb/token rejects oversized force-refresh bodies before parsing or validating the bearer", async () => {
    const e = await brokerEnv();
    const parseSpy = vi.spyOn(JSON, "parse");
    const res = await app.request(
      "/v1/orb/token",
      {
        method: "POST",
        headers: { authorization: "Bearer orbsec_bad", "content-length": String(MAX_ORB_RELAY_REGISTER_BODY_BYTES + 1) },
        body: "{}",
      },
      e,
    );

    expect(res.status).toBe(413);
    expect(parseSpy).not.toHaveBeenCalled();
    parseSpy.mockRestore();
    await expect(res.json()).resolves.toEqual({ error: "payload_too_large", maxBytes: MAX_ORB_RELAY_REGISTER_BODY_BYTES });
  });

  it("/v1/orb/token caps streamed bodies when no content-length is declared", async () => {
    const e = await brokerEnv();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_ORB_RELAY_REGISTER_BODY_BYTES + 1));
        controller.close();
      },
    });
    const res = await app.request("/v1/orb/token", { method: "POST", headers: { authorization: "Bearer orbsec_bad" }, body: stream, duplex: "half" } as RequestInit, e);

    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toMatchObject({ error: "payload_too_large" });
  });

  it("/v1/orb/token accepts small force-refresh JSON and ignores malformed JSON", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-25T07:00:00Z"));
    const e = await brokerEnv({ TOKEN_ENCRYPTION_SECRET: "orb-route-cache-secret" });
    await seedInstall(e, 405, { registered: 1 });
    const { secret } = (await issueOrbEnrollment(e, 405)) as { secret: string };
    const calls = countingTokenFetch("2026-06-25T08:00:00Z", { contents: "write" });

    expect((await app.request("/v1/orb/token", { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: "{bad" }, e)).status).toBe(200);
    expect(calls()).toBe(1);
    expect((await app.request("/v1/orb/token", { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ forceRefresh: true }) }, e)).status).toBe(200);
    expect(calls()).toBe(2);
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
