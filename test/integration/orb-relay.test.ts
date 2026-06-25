import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { issueOrbEnrollment } from "../../src/orb/broker";
import { forwardOrbEvent, registerOrbRelay, relaySignature } from "../../src/orb/relay";
import { createTestEnv, type TestD1Database } from "../helpers/d1";

const db = (e: Env) => e.DB as unknown as TestD1Database;
const seedInstall = (e: Env, id: number, cols: Record<string, string | number | null> = {}) => {
  const all: Record<string, string | number | null> = { installation_id: id, registered: 1, ...cols };
  const keys = Object.keys(all);
  return db(e).prepare(`INSERT INTO orb_github_installations (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).bind(...keys.map((k) => all[k] as string | number | null)).run();
};
const brokeredEnv = () => createTestEnv({ ORB_BROKER_ENABLED: "true", TOKEN_ENCRYPTION_SECRET: "test-encryption-key-material-0001" });
const enroll = async (e: Env, id: number): Promise<string> => {
  await seedInstall(e, id);
  return ((await issueOrbEnrollment(e, id)) as { secret: string }).secret;
};

describe("registerOrbRelay", () => {
  it("stores the relay URL + the ENCRYPTED secret for a valid enrollment", async () => {
    const e = brokeredEnv();
    const secret = await enroll(e, 700);
    expect(await registerOrbRelay(e, secret, "https://my-host.example/v1/orb/relay")).toEqual({ ok: true, installationId: 700 });
    const row = await db(e).prepare("SELECT relay_url, relay_secret_enc, relay_secret_iv FROM orb_enrollments WHERE installation_id=700").first<{ relay_url: string; relay_secret_enc: string; relay_secret_iv: string }>();
    expect(row?.relay_url).toBe("https://my-host.example/v1/orb/relay");
    expect(row?.relay_secret_enc).toBeTruthy();
    expect(row?.relay_secret_iv).toBeTruthy();
    expect(row?.relay_secret_enc).not.toContain(secret); // stored encrypted, never plaintext
  });

  it("rejects an unknown / revoked enrollment secret", async () => {
    expect(await registerOrbRelay(brokeredEnv(), "orbsec_bogus", "https://x.example")).toEqual({ error: "invalid_enrollment" });
  });

  it("rejects an ineligible install — unregistered, suspended, removed, or deleted", async () => {
    const e = brokeredEnv();
    const s1 = await enroll(e, 701);
    await db(e).prepare("UPDATE orb_github_installations SET registered=0 WHERE installation_id=701").run();
    expect(await registerOrbRelay(e, s1, "https://x.example")).toEqual({ error: "installation_not_eligible" }); // registered!=1
    const s2 = await enroll(e, 702);
    await db(e).prepare("UPDATE orb_github_installations SET suspended_at=CURRENT_TIMESTAMP WHERE installation_id=702").run();
    expect(await registerOrbRelay(e, s2, "https://x.example")).toEqual({ error: "installation_not_eligible" }); // suspended
    const s3 = await enroll(e, 703);
    await db(e).prepare("UPDATE orb_github_installations SET removed_at=CURRENT_TIMESTAMP WHERE installation_id=703").run();
    expect(await registerOrbRelay(e, s3, "https://x.example")).toEqual({ error: "installation_not_eligible" }); // removed
    const s4 = await enroll(e, 704);
    await db(e).prepare("DELETE FROM orb_github_installations WHERE installation_id=704").run();
    expect(await registerOrbRelay(e, s4, "https://x.example")).toEqual({ error: "installation_not_eligible" }); // !install
  });

  it("SSRF-rejects a loopback / private / non-https relay URL", async () => {
    const e = brokeredEnv();
    const secret = await enroll(e, 705);
    expect(await registerOrbRelay(e, secret, "http://127.0.0.1/relay")).toEqual({ error: "invalid_relay_url" });
    expect(await registerOrbRelay(e, secret, "https://localhost/relay")).toEqual({ error: "invalid_relay_url" });
  });

  it("errors when the server's encryption secret is unavailable", async () => {
    const e = createTestEnv({ ORB_BROKER_ENABLED: "true" }); // no TOKEN_ENCRYPTION_SECRET
    const secret = await enroll(e, 706);
    expect(await registerOrbRelay(e, secret, "https://x.example/relay")).toEqual({ error: "encryption_unavailable" });
  });
});

describe("POST /v1/orb/relay/register", () => {
  const app = createApp();

  it("404s when the broker flag is off (byte-identical deploy)", async () => {
    expect((await app.request("/v1/orb/relay/register", { method: "POST" }, createTestEnv())).status).toBe(404);
  });

  it("401 without a secret, 400 without a relayUrl, 200 on success", async () => {
    const e = brokeredEnv();
    const secret = await enroll(e, 710);
    expect((await app.request("/v1/orb/relay/register", { method: "POST" }, e)).status).toBe(401);
    expect((await app.request("/v1/orb/relay/register", { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: "{bad" }, e)).status).toBe(400); // unparseable body → catch → null → 400
    const ok = await app.request("/v1/orb/relay/register", { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ relayUrl: "https://my-host.example/v1/orb/relay" }) }, e);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, installationId: 710 });
  });

  it("maps each failure to its status: 401 bad secret, 403 ineligible, 400 SSRF, 500 no-encryption", async () => {
    const e = brokeredEnv();
    const sBad = "Bearer orbsec_bad";
    expect((await app.request("/v1/orb/relay/register", { method: "POST", headers: { authorization: sBad }, body: JSON.stringify({ relayUrl: "https://x.example" }) }, e)).status).toBe(401);
    const s1 = await enroll(e, 711);
    expect((await app.request("/v1/orb/relay/register", { method: "POST", headers: { authorization: `Bearer ${s1}` }, body: JSON.stringify({ relayUrl: "http://127.0.0.1" }) }, e)).status).toBe(400);
    const s2 = await enroll(e, 712);
    await db(e).prepare("UPDATE orb_github_installations SET registered=0 WHERE installation_id=712").run();
    expect((await app.request("/v1/orb/relay/register", { method: "POST", headers: { authorization: `Bearer ${s2}` }, body: JSON.stringify({ relayUrl: "https://x.example" }) }, e)).status).toBe(403);
    const noEnc = createTestEnv({ ORB_BROKER_ENABLED: "true" });
    const s3 = await enroll(noEnc, 713);
    expect((await app.request("/v1/orb/relay/register", { method: "POST", headers: { authorization: `Bearer ${s3}` }, body: JSON.stringify({ relayUrl: "https://x.example/relay" }) }, noEnc)).status).toBe(500);
  });
});

describe("relaySignature", () => {
  it("is a deterministic 64-hex HMAC both sides can recompute (and key-dependent)", async () => {
    expect(await relaySignature("s", "body")).toBe(await relaySignature("s", "body"));
    expect(await relaySignature("s", "body")).not.toBe(await relaySignature("other", "body"));
    expect(await relaySignature("s", "body")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("forwardOrbEvent", () => {
  const capture = (resp: Response) => {
    const calls: { url: string; init?: RequestInit | undefined }[] = [];
    const fetchImpl = ((u: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(u), init });
      return Promise.resolve(resp);
    }) as typeof fetch;
    return { fetchImpl, calls };
  };

  it("SKIPS a non-forwardable event, a missing installation, and an enrolled install with no relay registered", async () => {
    const e = brokeredEnv();
    expect(await forwardOrbEvent(e, { eventName: "installation", installationId: 1, deliveryId: "d", rawBody: "{}" })).toBe("skipped");
    expect(await forwardOrbEvent(e, { eventName: "pull_request", installationId: null, deliveryId: "d", rawBody: "{}" })).toBe("skipped");
    await enroll(e, 801);
    expect(await forwardOrbEvent(e, { eventName: "pull_request", installationId: 801, deliveryId: "d", rawBody: "{}" })).toBe("skipped"); // enrolled, no relay
  });

  it("FORWARDS a registered install's event, HMAC-signed with the container's secret (the container can verify)", async () => {
    const e = brokeredEnv();
    const secret = await enroll(e, 800);
    await registerOrbRelay(e, secret, "https://c.example/v1/orb/relay");
    const { fetchImpl, calls } = capture(new Response("ok"));
    const body = '{"action":"opened","number":7}';
    expect(await forwardOrbEvent(e, { eventName: "pull_request", installationId: 800, deliveryId: "del-1", rawBody: body }, fetchImpl)).toBe("forwarded");
    expect(calls[0]?.url).toBe("https://c.example/v1/orb/relay");
    const h = calls[0]?.init?.headers as Record<string, string>;
    expect(h["x-github-event"]).toBe("pull_request");
    expect(h["x-github-delivery"]).toBe("del-1");
    expect(h["x-orb-signature-256"]).toBe(`sha256=${await relaySignature(secret, body)}`); // matches what the container recomputes
    expect(calls[0]?.init?.body).toBe(body);
  });

  it("returns FAILED (never throws) on a non-ok response or a thrown fetch — the Orb 202 always stands", async () => {
    const e = brokeredEnv();
    const secret = await enroll(e, 802);
    await registerOrbRelay(e, secret, "https://c.example/v1/orb/relay");
    expect(await forwardOrbEvent(e, { eventName: "pull_request", installationId: 802, deliveryId: "d", rawBody: "{}" }, (() => Promise.resolve(new Response("no", { status: 503 }))) as typeof fetch)).toBe("failed");
    expect(await forwardOrbEvent(e, { eventName: "pull_request", installationId: 802, deliveryId: "d", rawBody: "{}" }, (() => Promise.reject(new Error("down"))) as typeof fetch)).toBe("failed");
  });

  it("SKIPS when the server's encryption secret is gone (can't decrypt the stored secret)", async () => {
    const e = brokeredEnv();
    const secret = await enroll(e, 803);
    await registerOrbRelay(e, secret, "https://c.example/v1/orb/relay");
    const noKey = { ...e, TOKEN_ENCRYPTION_SECRET: undefined } as unknown as Env; // same DB, key removed
    expect(await forwardOrbEvent(noKey, { eventName: "pull_request", installationId: 803, deliveryId: "d", rawBody: "{}" })).toBe("skipped");
  });
});
