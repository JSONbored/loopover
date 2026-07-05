import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { issueOrbEnrollment } from "../../src/orb/broker";
import { relayForward } from "../../src/orb/webhook";
import { enqueueRelayPending, forwardOrbEvent, MAX_ORB_RELAY_REGISTER_BODY_BYTES, pullRelayPending, readOrbRelayRegisterBody, registerOrbRelay, relaySignature, relayVerify, retryFailedRelays, storeRelayFailure } from "../../src/orb/relay";
import { createTestEnv, type TestD1Database } from "../helpers/d1";

const db = (e: Env) => e.DB as unknown as TestD1Database;
const seedInstall = (e: Env, id: number, cols: Record<string, string | number | null> = {}) => {
  const all: Record<string, string | number | null> = { installation_id: id, registered: 1, ...cols };
  const keys = Object.keys(all);
  return db(e).prepare(`INSERT INTO orb_github_installations (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).bind(...keys.map((k) => all[k] as string | number | null)).run();
};
const brokeredEnv = () => createTestEnv({ ORB_BROKER_ENABLED: "true", TOKEN_ENCRYPTION_SECRET: "test-encryption-key-material-0001" });

afterEach(() => {
  vi.restoreAllMocks();
});
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

  it("maps each failure to its status: 401 bad secret, 403 ineligible, 400 SSRF, 413 too-large body, 500 no-encryption", async () => {
    const e = brokeredEnv();
    const sBad = "Bearer orbsec_bad";
    expect((await app.request("/v1/orb/relay/register", { method: "POST", headers: { authorization: sBad }, body: JSON.stringify({ relayUrl: "https://x.example" }) }, e)).status).toBe(401);
    const s1 = await enroll(e, 711);
    expect((await app.request("/v1/orb/relay/register", { method: "POST", headers: { authorization: `Bearer ${s1}` }, body: JSON.stringify({ relayUrl: "http://127.0.0.1" }) }, e)).status).toBe(400);
    expect((await app.request("/v1/orb/relay/register", { method: "POST", headers: { authorization: `Bearer ${s1}` }, body: JSON.stringify({ relayUrl: `${"https://x.example/"}${"a".repeat(4096)}` }) }, e)).status).toBe(413);
    const s2 = await enroll(e, 712);
    await db(e).prepare("UPDATE orb_github_installations SET registered=0 WHERE installation_id=712").run();
    expect((await app.request("/v1/orb/relay/register", { method: "POST", headers: { authorization: `Bearer ${s2}` }, body: JSON.stringify({ relayUrl: "https://x.example" }) }, e)).status).toBe(403);
    const noEnc = createTestEnv({ ORB_BROKER_ENABLED: "true" });
    const s3 = await enroll(noEnc, 713);
    expect((await app.request("/v1/orb/relay/register", { method: "POST", headers: { authorization: `Bearer ${s3}` }, body: JSON.stringify({ relayUrl: "https://x.example/relay" }) }, noEnc)).status).toBe(500);
  });

  it("rejects an invalid enrollment before reading the registration body", async () => {
    const e = brokeredEnv();
    let bodyAccesses = 0;
    const req = new Request("http://localhost/v1/orb/relay/register", { method: "POST", headers: { authorization: "Bearer orbsec_bad" } });
    Object.defineProperty(req, "body", {
      get() {
        bodyAccesses += 1;
        throw new Error("body should not be read before enrollment validation");
      },
    });
    const res = await app.fetch(req, e);
    expect(res.status).toBe(401);
    expect(bodyAccesses).toBe(0);
  });
});

describe("readOrbRelayRegisterBody", () => {
  it("returns an empty string when the request has no body stream", async () => {
    // A request without a body (e.g. a bodyless POST) has request.body === null — the empty-body path.
    const req = new Request("http://localhost/v1/orb/relay/register", { method: "POST" });
    expect(req.body).toBeNull();
    expect(await readOrbRelayRegisterBody(req, null)).toBe(""); // null content-length → declared null → empty stream
    expect(await readOrbRelayRegisterBody(req, undefined)).toBe(""); // undefined header → typeof !== "string" arm
  });

  it("rejects an oversized DECLARED content-length up front (before touching the stream)", async () => {
    // Past the ceiling: parseContentLength returns a valid integer that exceeds MAX → short-circuit to null.
    const req = new Request("http://localhost/v1/orb/relay/register", { method: "POST", body: "{}" });
    expect(await readOrbRelayRegisterBody(req, String(MAX_ORB_RELAY_REGISTER_BODY_BYTES + 1))).toBeNull();
  });

  it("ignores a malformed or negative content-length and reads the actual body", async () => {
    // Number("abc")=NaN and "-1"<0 → parseContentLength returns null → the declared-too-large guard is skipped.
    expect(await readOrbRelayRegisterBody(new Request("http://localhost/r", { method: "POST", body: "{}" }), "abc")).toBe("{}"); // non-integer
    expect(await readOrbRelayRegisterBody(new Request("http://localhost/r", { method: "POST", body: "{}" }), "-1")).toBe("{}"); // negative
  });

  it("returns null when the STREAMED body exceeds the ceiling regardless of the declared length", async () => {
    // No content-length declared, but the stream itself runs past MAX → reader is cancelled, null returned.
    const req = new Request("http://localhost/r", { method: "POST", body: "x".repeat(MAX_ORB_RELAY_REGISTER_BODY_BYTES + 1) });
    expect(await readOrbRelayRegisterBody(req, null)).toBeNull();
  });

  it("REGRESSION (#orb-broker-500): returns null instead of throwing when the underlying stream errors mid-read", async () => {
    // Simulates a dropped connection / network reset while GitHub Sentry observed as "Orb broker token exchange
    // failed (500)" (GITTENSORY-J) — this function is called BEFORE each of its three route call sites' own
    // try/catch, so an uncaught throw here previously escaped as a bare framework 500 rather than the route's
    // own clean 4xx/503 JSON response. A first successful chunk (some bytes already arrived) followed by a
    // stream error is the realistic shape of a mid-read network drop, not an error on the very first read.
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('{"relayUrl":'));
        controller.error(new Error("simulated network reset"));
      },
    });
    const req = new Request("http://localhost/r", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    await expect(readOrbRelayRegisterBody(req, null)).resolves.toBeNull();
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
    expect(await forwardOrbEvent(e, { eventName: "check_run", installationId: 1, deliveryId: "d", rawBody: "{}" })).toBe("skipped"); // excluded: CI firehose
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

  it("FORWARDS via the newest enrollment when multiple enrolled rows exist for one installation (regression for #1783)", async () => {
    const e = brokeredEnv();
    await seedInstall(e, 804);
    const staleSecret = ((await issueOrbEnrollment(e, 804)) as { secret: string }).secret; // row A — enrolled, no relay
    const freshSecret = ((await issueOrbEnrollment(e, 804)) as { secret: string }).secret; // row B — stays enrolled too
    await registerOrbRelay(e, freshSecret, "https://new-host.example/v1/orb/relay");
    const { fetchImpl, calls } = capture(new Response("ok"));
    const body = '{"action":"opened","number":9}';
    expect(await forwardOrbEvent(e, { eventName: "pull_request", installationId: 804, deliveryId: "del-1783", rawBody: body }, fetchImpl)).toBe("forwarded");
    expect(calls[0]?.url).toBe("https://new-host.example/v1/orb/relay");
    const h = calls[0]?.init?.headers as Record<string, string>;
    expect(h["x-orb-signature-256"]).toBe(`sha256=${await relaySignature(freshSecret, body)}`);
    expect(staleSecret).not.toBe(freshSecret);
  });

  it("prefers the newest registered relay when two enrolled rows tie on relay_registered_at (regression for #1783 tie-break)", async () => {
    const e = brokeredEnv();
    await seedInstall(e, 805);
    const staleSecret = ((await issueOrbEnrollment(e, 805)) as { secret: string }).secret;
    await registerOrbRelay(e, staleSecret, "https://stale-host.example/v1/orb/relay");
    const freshSecret = ((await issueOrbEnrollment(e, 805)) as { secret: string }).secret;
    await registerOrbRelay(e, freshSecret, "https://new-host.example/v1/orb/relay");
    await db(e).prepare("UPDATE orb_enrollments SET relay_registered_at = '2026-06-30T00:00:00Z' WHERE installation_id = 805").run();
    const { fetchImpl, calls } = capture(new Response("ok"));
    const body = '{"action":"opened","number":10}';
    expect(await forwardOrbEvent(e, { eventName: "pull_request", installationId: 805, deliveryId: "del-tie", rawBody: body }, fetchImpl)).toBe("forwarded");
    expect(calls[0]?.url).toBe("https://new-host.example/v1/orb/relay");
    const h = calls[0]?.init?.headers as Record<string, string>;
    expect(h["x-orb-signature-256"]).toBe(`sha256=${await relaySignature(freshSecret, body)}`);
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

describe("relayForward (deferred forward + failure persistence, #orb-ack-fast)", () => {
  it("persists a FAILED push to orb_relay_failures so the retry cron re-attempts it", async () => {
    const e = brokeredEnv();
    const secret = await enroll(e, 820);
    await registerOrbRelay(e, secret, "https://c.example/v1/orb/relay");
    await relayForward(e, { eventName: "pull_request", installationId: 820, deliveryId: "rf-fail", rawBody: "{}" }, (() => Promise.resolve(new Response("no", { status: 503 }))) as typeof fetch);
    const row = await db(e).prepare("SELECT installation_id, event_name FROM orb_relay_failures WHERE delivery_id='rf-fail'").first<{ installation_id: number; event_name: string }>();
    expect(row).toMatchObject({ installation_id: 820, event_name: "pull_request" });
  });

  it("persists a TRANSIENT skip (enrolled push mode, relay not registered yet) for the retry cron", async () => {
    const e = brokeredEnv();
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await enroll(e, 821); // enrolled, but no relay registered → forwardOrbEvent skips before any fetch
    await expect(relayForward(e, { eventName: "pull_request", installationId: 821, deliveryId: "rf-skip", rawBody: "{}" })).resolves.toBeUndefined();
    const row = await db(e).prepare("SELECT installation_id, event_name FROM orb_relay_failures WHERE delivery_id='rf-skip'").first<{ installation_id: number; event_name: string }>();
    expect(row).toMatchObject({ installation_id: 821, event_name: "pull_request" });
    expect(warnLog.mock.calls.some(([line]) => String(line).includes("orb_relay_transient_skip") && String(line).includes('"phase":"initial"'))).toBe(true);
  });

  it("does NOT persist terminal no-enrollment skips for the retry cron", async () => {
    const e = brokeredEnv();
    await relayForward(e, { eventName: "pull_request", installationId: 822, deliveryId: "rf-no-enrollment", rawBody: '{"payload":true}' });
    expect(await db(e).prepare("SELECT delivery_id FROM orb_relay_failures WHERE delivery_id='rf-no-enrollment'").first()).toBeFalsy();
  });

  it("does NOT persist permanently non-forwardable skips (check_run)", async () => {
    const e = brokeredEnv();
    await enroll(e, 8211);
    await relayForward(e, { eventName: "check_run", installationId: 8211, deliveryId: "rf-check-run", rawBody: "{}" });
    expect(await db(e).prepare("SELECT delivery_id FROM orb_relay_failures WHERE delivery_id='rf-check-run'").first()).toBeFalsy();
  });
});

describe("relayVerify", () => {
  it("accepts a valid signature (sha256= or bare hex) and rejects wrong-secret / malformed / missing", async () => {
    const body = '{"x":1}';
    const sig = await relaySignature("s", body);
    expect(await relayVerify("s", body, `sha256=${sig}`)).toBe(true);
    expect(await relayVerify("s", body, sig)).toBe(true); // bare hex tolerated
    expect(await relayVerify("s", body, `sha256=${await relaySignature("other", body)}`)).toBe(false); // wrong secret
    expect(await relayVerify("s", body, "sha256=zz")).toBe(false); // non-hex
    expect(await relayVerify("s", body, "sha256=abc")).toBe(false); // odd-length hex
    expect(await relayVerify("", body, `sha256=${sig}`)).toBe(false); // no secret
    expect(await relayVerify("s", body, null)).toBe(false); // no header
  });
});

describe("POST /v1/orb/relay (brokered self-host receiver)", () => {
  const app = createApp();
  const CSECRET = "orbsec_container_abcdef";
  const containerEnv = (over: Record<string, string> = {}) => createTestEnv({ ORB_ENROLLMENT_SECRET: CSECRET, ...over });
  const sign = async (body: string) => `sha256=${await relaySignature(CSECRET, body)}`;
  const PR_BODY = JSON.stringify({ action: "opened", installation: { id: 5 }, repository: { full_name: "acme/app" } });

  it("404 when this instance is not a brokered self-host (no ORB_ENROLLMENT_SECRET)", async () => {
    expect((await app.request("/v1/orb/relay", { method: "POST", headers: { "x-github-event": "pull_request", "x-github-delivery": "d" }, body: PR_BODY }, createTestEnv())).status).toBe(404);
  });

  it("400 without the GitHub headers", async () => {
    expect((await app.request("/v1/orb/relay", { method: "POST", body: PR_BODY }, containerEnv())).status).toBe(400);
  });

  it("401 on a missing or wrong-secret signature", async () => {
    const h = { "x-github-event": "pull_request", "x-github-delivery": "d1" };
    expect((await app.request("/v1/orb/relay", { method: "POST", headers: h, body: PR_BODY }, containerEnv())).status).toBe(401); // no signature
    expect((await app.request("/v1/orb/relay", { method: "POST", headers: { ...h, "x-orb-signature-256": "sha256=deadbeef" }, body: PR_BODY }, containerEnv())).status).toBe(401);
  });

  it("413 when the body exceeds the configured max", async () => {
    const res = await app.request("/v1/orb/relay", { method: "POST", headers: { "x-github-event": "pull_request", "x-github-delivery": "d1", "x-orb-signature-256": await sign("x".repeat(50)) }, body: "x".repeat(50) }, containerEnv({ GITHUB_WEBHOOK_MAX_BODY_BYTES: "5" }));
    expect(res.status).toBe(413);
  });

  it("202 + ENQUEUES on a valid Orb signature (the relayed event becomes a normal webhook job)", async () => {
    const res = await app.request("/v1/orb/relay", { method: "POST", headers: { "x-github-event": "pull_request", "x-github-delivery": "rel-1", "x-orb-signature-256": await sign(PR_BODY) }, body: PR_BODY }, containerEnv());
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: "queued", deliveryId: "rel-1", eventName: "pull_request" });
  });
});

describe("storeRelayFailure", () => {
  it("inserts a pending row; duplicate delivery_id is silently ignored (ON CONFLICT DO NOTHING)", async () => {
    const e = brokeredEnv();
    await storeRelayFailure(e, { deliveryId: "fail-1", eventName: "pull_request", installationId: 9001, rawBody: "{}" });
    const row = await db(e).prepare("SELECT attempts, event_name FROM orb_relay_failures WHERE delivery_id='fail-1'").first<{ attempts: number; event_name: string }>();
    expect(row?.attempts).toBe(0);
    expect(row?.event_name).toBe("pull_request");
    // Second call with same delivery_id must not throw or increment attempts.
    await storeRelayFailure(e, { deliveryId: "fail-1", eventName: "pull_request", installationId: 9001, rawBody: "{}" });
    const count = await db(e).prepare("SELECT COUNT(*) AS n FROM orb_relay_failures WHERE delivery_id='fail-1'").first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});

describe("retryFailedRelays", () => {
  it("no-op on an empty table", async () => {
    await expect(retryFailedRelays(brokeredEnv())).resolves.toBeUndefined();
  });

  it("DELETES a failure row when forwardOrbEvent forwards it successfully", async () => {
    const e = brokeredEnv();
    const secret = await enroll(e, 9100);
    await registerOrbRelay(e, secret, "https://c.example/v1/orb/relay");
    await storeRelayFailure(e, { deliveryId: "retry-ok", eventName: "pull_request", installationId: 9100, rawBody: "{}" });
    const fetchOk = (() => Promise.resolve(new Response("ok", { status: 200 }))) as typeof fetch;
    await retryFailedRelays(e, { fetchImpl: fetchOk });
    const row = await db(e).prepare("SELECT delivery_id FROM orb_relay_failures WHERE delivery_id='retry-ok'").first();
    expect(row ?? null).toBeNull(); // row removed on success
  });

  it("INCREMENTS attempts when forwardOrbEvent still fails", async () => {
    const e = brokeredEnv();
    const secret = await enroll(e, 9101);
    await registerOrbRelay(e, secret, "https://c.example/v1/orb/relay");
    await storeRelayFailure(e, { deliveryId: "retry-fail", eventName: "pull_request", installationId: 9101, rawBody: "{}" });
    const fetchFail = (() => Promise.resolve(new Response("bad", { status: 503 }))) as typeof fetch;
    await retryFailedRelays(e, { fetchImpl: fetchFail });
    const row = await db(e).prepare("SELECT attempts FROM orb_relay_failures WHERE delivery_id='retry-fail'").first<{ attempts: number }>();
    expect(row?.attempts).toBe(1);
  });

  it("SKIPS a row still inside its per-failure backoff window (#1950)", async () => {
    const e = brokeredEnv();
    const secret = await enroll(e, 9600);
    await registerOrbRelay(e, secret, "https://c.example/v1/orb/relay");
    // A row that last failed 1 minute ago (attempts=1) is inside the 5-minute backoff window.
    await db(e)
      .prepare("INSERT INTO orb_relay_failures (delivery_id, event_name, installation_id, raw_body, attempts, last_attempt_at) VALUES (?, ?, ?, ?, ?, datetime('now', '-1 minutes'))")
      .bind("backoff-recent", "pull_request", 9600, "{}", 1)
      .run();
    let calls = 0;
    const fetchFail = (() => {
      calls += 1;
      return Promise.resolve(new Response("bad", { status: 503 }));
    }) as typeof fetch;
    await retryFailedRelays(e, { fetchImpl: fetchFail });
    expect(calls).toBe(0); // backed off → not re-POSTed this tick, so no fleet-wide storm on a down container
    const row = await db(e).prepare("SELECT attempts FROM orb_relay_failures WHERE delivery_id='backoff-recent'").first<{ attempts: number }>();
    expect(row?.attempts).toBe(1); // untouched
  });

  it("RETRIES a row once its per-failure backoff window has elapsed (#1950)", async () => {
    const e = brokeredEnv();
    const secret = await enroll(e, 9601);
    await registerOrbRelay(e, secret, "https://c.example/v1/orb/relay");
    // A row that last failed 10 minutes ago (attempts=1) is past the 5-minute backoff → eligible again.
    await db(e)
      .prepare("INSERT INTO orb_relay_failures (delivery_id, event_name, installation_id, raw_body, attempts, last_attempt_at) VALUES (?, ?, ?, ?, ?, datetime('now', '-10 minutes'))")
      .bind("backoff-elapsed", "pull_request", 9601, "{}", 1)
      .run();
    const fetchFail = (() => Promise.resolve(new Response("bad", { status: 503 }))) as typeof fetch;
    await retryFailedRelays(e, { fetchImpl: fetchFail });
    const row = await db(e).prepare("SELECT attempts FROM orb_relay_failures WHERE delivery_id='backoff-elapsed'").first<{ attempts: number }>();
    expect(row?.attempts).toBe(2); // eligible → retried, attempts incremented
  });

  it("DELETES a row when forwardOrbEvent skips it (event no longer forwardable)", async () => {
    const e = brokeredEnv();
    // Store a failure for an event that was later removed from RELAY_FORWARD_EVENTS (e.g. check_run).
    await storeRelayFailure(e, { deliveryId: "skip-1", eventName: "check_run", installationId: 9200, rawBody: "{}" });
    // check_run is excluded from RELAY_FORWARD_EVENTS — forwardOrbEvent returns "skipped".
    await retryFailedRelays(e, { fetchImpl: (() => Promise.resolve(new Response("ok"))) as typeof fetch });
    const row = await db(e).prepare("SELECT delivery_id FROM orb_relay_failures WHERE delivery_id='skip-1'").first();
    expect(row ?? null).toBeNull(); // skipped = no longer applicable → cleaned up
  });

  it("DELETES a row when the installation no longer has an active enrollment", async () => {
    const e = brokeredEnv();
    await storeRelayFailure(e, { deliveryId: "no-enrollment-retry", eventName: "pull_request", installationId: 9604, rawBody: "{}" });
    await retryFailedRelays(e);
    const row = await db(e).prepare("SELECT delivery_id FROM orb_relay_failures WHERE delivery_id='no-enrollment-retry'").first();
    expect(row ?? null).toBeNull();
  });

  it("KEEPS retrying a forwardable event when forwardOrbEvent skips due to transient config (no relay URL)", async () => {
    const e = brokeredEnv();
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await enroll(e, 9602); // enrolled push mode, relay not registered yet
    await storeRelayFailure(e, { deliveryId: "transient-skip", eventName: "pull_request", installationId: 9602, rawBody: "{}" });
    await retryFailedRelays(e);
    const row = await db(e).prepare("SELECT attempts, last_attempt_at FROM orb_relay_failures WHERE delivery_id='transient-skip'").first<{ attempts: number; last_attempt_at: string | null }>();
    expect(row?.attempts).toBe(1); // transient skip must not delete the row — backoff and retry
    expect(row?.last_attempt_at).toBeTruthy(); // follows normal retry bookkeeping, not a silent delete
    expect(warnLog.mock.calls.some(([line]) => String(line).includes("orb_relay_transient_skip") && String(line).includes('"phase":"retry"'))).toBe(true);
  });

  it("KEEPS retrying when the encryption secret is temporarily missing", async () => {
    const e = brokeredEnv();
    const secret = await enroll(e, 9603);
    await registerOrbRelay(e, secret, "https://c.example/v1/orb/relay");
    await storeRelayFailure(e, { deliveryId: "no-key-skip", eventName: "pull_request", installationId: 9603, rawBody: "{}" });
    const noKey = { ...e, TOKEN_ENCRYPTION_SECRET: undefined } as unknown as Env;
    await retryFailedRelays(noKey);
    const row = await db(noKey).prepare("SELECT attempts FROM orb_relay_failures WHERE delivery_id='no-key-skip'").first<{ attempts: number }>();
    expect(row?.attempts).toBe(1);
  });

  it("PAGES retry work and bounds concurrent forwards", async () => {
    const e = brokeredEnv();
    const secret = await enroll(e, 9500);
    await registerOrbRelay(e, secret, "https://c.example/v1/orb/relay");
    for (let i = 0; i < 30; i += 1) {
      await storeRelayFailure(e, { deliveryId: `retry-bulk-${String(i).padStart(2, "0")}`, eventName: "pull_request", installationId: 9500, rawBody: JSON.stringify({ n: i }) });
    }

    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const fetchFail = (async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return new Response("bad", { status: 503 });
    }) as typeof fetch;

    await retryFailedRelays(e, { fetchImpl: fetchFail });

    expect(calls).toBe(25);
    expect(maxActive).toBeLessThanOrEqual(5);
    const attempted = await db(e).prepare("SELECT COUNT(*) AS n FROM orb_relay_failures WHERE attempts=1").first<{ n: number }>();
    const untouched = await db(e).prepare("SELECT COUNT(*) AS n FROM orb_relay_failures WHERE attempts=0").first<{ n: number }>();
    expect(attempted?.n).toBe(25);
    expect(untouched?.n).toBe(5);
  });

  it("PRUNES rows that have exhausted their attempt budget (attempts >= 5) and logs the drop at error level (#5)", async () => {
    const e = brokeredEnv();
    const errLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Manually insert a row at the attempt ceiling.
    await db(e).prepare("INSERT INTO orb_relay_failures (delivery_id, event_name, installation_id, raw_body, attempts) VALUES (?, ?, ?, ?, ?)").bind("exhausted-1", "pull_request", 9300, "{}", 5).run();
    await retryFailedRelays(e);
    const row = await db(e).prepare("SELECT delivery_id FROM orb_relay_failures WHERE delivery_id='exhausted-1'").first();
    expect(row ?? null).toBeNull(); // pruned on the DELETE pass before the SELECT
    // The drop is no longer silent OR warn-only — an alertable level:error log reaches the Sentry forwarder.
    expect(errLog.mock.calls.some(([line]) => String(line).includes("orb_relay_events_dropped") && String(line).includes('"level":"error"'))).toBe(true);
  });

  it("PRUNES expired rows (expires_at in the past) without attempting to forward", async () => {
    const e = brokeredEnv();
    await db(e)
      .prepare("INSERT INTO orb_relay_failures (delivery_id, event_name, installation_id, raw_body, expires_at) VALUES (?, ?, ?, ?, datetime('now', '-1 second'))")
      .bind("expired-1", "pull_request", 9400, "{}")
      .run();
    let fetchCalled = false;
    const fetchSpy = (() => { fetchCalled = true; return Promise.resolve(new Response("ok")); }) as typeof fetch;
    await retryFailedRelays(e, { fetchImpl: fetchSpy });
    expect(fetchCalled).toBe(false); // expired row deleted before SELECT — fetch was never called
    const row = await db(e).prepare("SELECT delivery_id FROM orb_relay_failures WHERE delivery_id='expired-1'").first();
    expect(row ?? null).toBeNull();
  });
});

describe("enqueueRelayPending", () => {
  it("prunes expired rows before enqueueing so offline pull-mode installs cannot retain raw bodies indefinitely", async () => {
    const e = brokeredEnv();
    await db(e).prepare("INSERT INTO orb_relay_pending (delivery_id, installation_id, event_name, raw_body, created_at) VALUES (?, ?, ?, ?, datetime('now', '-25 hours'))").bind("stale-before-enqueue", 9599, "pull_request", '{"stale":true}').run();
    await enqueueRelayPending(e, { deliveryId: "fresh-after-prune", installationId: 9600, eventName: "pull_request", rawBody: '{"fresh":true}' });

    const stale = await db(e).prepare("SELECT delivery_id FROM orb_relay_pending WHERE delivery_id='stale-before-enqueue'").first();
    const fresh = await db(e).prepare("SELECT raw_body FROM orb_relay_pending WHERE delivery_id='fresh-after-prune'").first<{ raw_body: string }>();
    expect(stale ?? null).toBeNull();
    expect(fresh?.raw_body).toBe('{"fresh":true}');
  });

  it("caps each installation's pending queue by dropping the oldest overflow rows", async () => {
    const e = brokeredEnv();
    for (let i = 0; i < 501; i += 1) {
      await enqueueRelayPending(e, { deliveryId: `cap-${String(i).padStart(3, "0")}`, installationId: 9601, eventName: "pull_request", rawBody: JSON.stringify({ i }) });
    }
    await enqueueRelayPending(e, { deliveryId: "other-install", installationId: 9602, eventName: "pull_request", rawBody: "{}" });

    const count = await db(e).prepare("SELECT COUNT(*) AS n FROM orb_relay_pending WHERE installation_id=9601").first<{ n: number }>();
    const dropped = await db(e).prepare("SELECT delivery_id FROM orb_relay_pending WHERE delivery_id='cap-000'").first();
    const newest = await db(e).prepare("SELECT delivery_id FROM orb_relay_pending WHERE delivery_id='cap-500'").first();
    const other = await db(e).prepare("SELECT delivery_id FROM orb_relay_pending WHERE delivery_id='other-install'").first();
    expect(count?.n).toBe(500);
    expect(dropped ?? null).toBeNull();
    expect(newest ?? null).not.toBeNull();
    expect(other ?? null).not.toBeNull();
  });

  it("inserts a pending row; duplicate delivery_id is silently ignored (ON CONFLICT DO NOTHING)", async () => {
    const e = brokeredEnv();
    await enqueueRelayPending(e, { deliveryId: "pend-1", installationId: 9600, eventName: "pull_request", rawBody: '{"n":1}' });
    const row = await db(e).prepare("SELECT installation_id, event_name, raw_body FROM orb_relay_pending WHERE delivery_id='pend-1'").first<{ installation_id: number; event_name: string; raw_body: string }>();
    expect(row?.installation_id).toBe(9600);
    expect(row?.event_name).toBe("pull_request");
    expect(row?.raw_body).toBe('{"n":1}');
    // Second call with same delivery_id keeps the original (no throw, no duplicate, no overwrite).
    await enqueueRelayPending(e, { deliveryId: "pend-1", installationId: 9600, eventName: "issues", rawBody: '{"n":2}' });
    const after = await db(e).prepare("SELECT COUNT(*) AS n, MAX(raw_body) AS body FROM orb_relay_pending WHERE delivery_id='pend-1'").first<{ n: number; body: string }>();
    expect(after?.n).toBe(1);
    expect(after?.body).toBe('{"n":1}'); // original retained
  });

  it("coalesces duplicate pending CI completions per installation while retaining the newest delivery", async () => {
    const e = brokeredEnv();
    const body = (marker: string) =>
      JSON.stringify({
        action: "completed",
        repository: { full_name: "JSONbored/Gittensory" },
        check_suite: {
          head_sha: "b".repeat(40),
          pull_requests: [{ number: 1629 }],
        },
        marker,
      });

    await enqueueRelayPending(e, { deliveryId: "ci-old", installationId: 9603, eventName: "check_suite", rawBody: body("old") });
    await enqueueRelayPending(e, { deliveryId: "ci-new", installationId: 9603, eventName: "check_suite", rawBody: body("new") });
    await enqueueRelayPending(e, { deliveryId: "ci-other-install", installationId: 9604, eventName: "check_suite", rawBody: body("other") });

    const rows = await db(e)
      .prepare("SELECT delivery_id, raw_body, coalesce_key FROM orb_relay_pending WHERE installation_id=9603 ORDER BY delivery_id")
      .all<{ delivery_id: string; raw_body: string; coalesce_key: string | null }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({
      delivery_id: "ci-new",
      coalesce_key: `github-webhook:ci-completed:jsonbored/gittensory@${"b".repeat(40)}#1629`,
    });
    expect(JSON.parse(rows.results[0]?.raw_body ?? "{}")).toMatchObject({ marker: "new" });
    const other = await db(e).prepare("SELECT delivery_id FROM orb_relay_pending WHERE delivery_id='ci-other-install'").first();
    expect(other ?? null).not.toBeNull();
  });

  it("keeps the newer coalesced delivery when an older enqueue prunes after a newer insert", async () => {
    const e = brokeredEnv();
    const realDb = db(e);
    type TestStatement = ReturnType<TestD1Database["prepare"]>;
    let releaseOldPrune!: () => void;
    let oldInserted!: () => void;
    const oldMayPrune = new Promise<void>((resolve) => {
      releaseOldPrune = resolve;
    });
    const oldInsertedPromise = new Promise<void>((resolve) => {
      oldInserted = resolve;
    });
    e.DB = {
      prepare(sql: string) {
        const statement = realDb.prepare(sql);
        let bound: unknown[] = [];
        let wrapped: TestStatement;
        wrapped = {
          bind(...values: Parameters<TestStatement["bind"]>) {
            bound = values;
            statement.bind(...values);
            return wrapped;
          },
          first<T = unknown>() {
            return statement.first<T>();
          },
          all<T = unknown>() {
            return statement.all<T>();
          },
          raw<T = unknown[]>() {
            return statement.raw<T>();
          },
          async run() {
            const result = await statement.run();
            if (
              sql.includes("INSERT INTO orb_relay_pending") &&
              bound[0] === "ci-race-old"
            ) {
              oldInserted();
              await oldMayPrune;
            }
            return result;
          },
        };
        return wrapped;
      },
      batch(statements: TestStatement[]) {
        return realDb.batch(statements);
      },
    } as unknown as D1Database;
    const body = (marker: string) =>
      JSON.stringify({
        action: "completed",
        repository: { full_name: "JSONbored/Gittensory" },
        check_suite: {
          head_sha: "d".repeat(40),
          pull_requests: [{ number: 1838 }],
        },
        marker,
      });

    const older = enqueueRelayPending(e, { deliveryId: "ci-race-old", installationId: 9607, eventName: "check_suite", rawBody: body("old") });
    await oldInsertedPromise;
    await enqueueRelayPending(e, { deliveryId: "ci-race-new", installationId: 9607, eventName: "check_suite", rawBody: body("new") });
    releaseOldPrune();
    await older;

    const rows = await db(e)
      .prepare("SELECT delivery_id, raw_body FROM orb_relay_pending WHERE installation_id=9607 ORDER BY delivery_id")
      .all<{ delivery_id: string; raw_body: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.delivery_id).toBe("ci-race-new");
    expect(JSON.parse(rows.results[0]?.raw_body ?? "{}")).toMatchObject({ marker: "new" });
  });

  it("does not let label-only PR events coalesce away pending gate-triggering PR events", async () => {
    const e = brokeredEnv();
    const prBody = (action: string, marker: string) =>
      JSON.stringify({
        action,
        repository: { full_name: "JSONbored/Gittensory" },
        pull_request: { number: 1629, head: { sha: "a".repeat(40) } },
        marker,
      });

    await enqueueRelayPending(e, {
      deliveryId: "pr-opened-actionable",
      installationId: 9608,
      eventName: "pull_request",
      rawBody: prBody("opened", "actionable"),
    });
    await enqueueRelayPending(e, {
      deliveryId: "pr-labeled-not-actionable",
      installationId: 9608,
      eventName: "pull_request",
      rawBody: prBody("labeled", "label-only"),
    });

    const events = await pullRelayPending(e, 9608);
    expect(events.map((event) => event.deliveryId).sort()).toEqual([
      "pr-labeled-not-actionable",
      "pr-opened-actionable",
    ]);
    expect(
      Object.fromEntries(
        events.map((event) => [event.deliveryId, JSON.parse(event.rawBody).action]),
      ),
    ).toEqual({
      "pr-labeled-not-actionable": "labeled",
      "pr-opened-actionable": "opened",
    });
  });

  it("keeps exact duplicate coalescible delivery IDs idempotent", async () => {
    const e = brokeredEnv();
    const body = (marker: string) =>
      JSON.stringify({
        action: "completed",
        repository: { full_name: "JSONbored/Gittensory" },
        check_suite: {
          head_sha: "c".repeat(40),
          pull_requests: [{ number: 1807 }],
        },
        marker,
      });

    await enqueueRelayPending(e, { deliveryId: "ci-same", installationId: 9606, eventName: "check_suite", rawBody: body("first") });
    await enqueueRelayPending(e, { deliveryId: "ci-same", installationId: 9606, eventName: "check_suite", rawBody: body("second") });

    const row = await db(e)
      .prepare("SELECT raw_body, coalesce_key FROM orb_relay_pending WHERE delivery_id='ci-same'")
      .first<{ raw_body: string; coalesce_key: string | null }>();
    expect(row?.coalesce_key).toBe(`github-webhook:ci-completed:jsonbored/gittensory@${"c".repeat(40)}#1807`);
    expect(JSON.parse(row?.raw_body ?? "{}")).toMatchObject({ marker: "first" });
  });

  it("does not coalesce terminal events or malformed payloads", async () => {
    const e = brokeredEnv();
    await enqueueRelayPending(e, {
      deliveryId: "closed-1",
      installationId: 9605,
      eventName: "pull_request",
      rawBody: JSON.stringify({ action: "closed", repository: { full_name: "JSONbored/gittensory" }, pull_request: { number: 1 } }),
    });
    await enqueueRelayPending(e, {
      deliveryId: "closed-2",
      installationId: 9605,
      eventName: "pull_request",
      rawBody: JSON.stringify({ action: "closed", repository: { full_name: "JSONbored/gittensory" }, pull_request: { number: 1 } }),
    });
    await enqueueRelayPending(e, { deliveryId: "bad-json", installationId: 9605, eventName: "pull_request", rawBody: "{bad" });

    const rows = await db(e)
      .prepare("SELECT delivery_id, coalesce_key FROM orb_relay_pending WHERE installation_id=9605 ORDER BY delivery_id")
      .all<{ delivery_id: string; coalesce_key: string | null }>();
    expect(rows.results.map((row) => row.delivery_id)).toEqual(["bad-json", "closed-1", "closed-2"]);
    expect(rows.results.every((row) => row.coalesce_key === null)).toBe(true);
  });
});

describe("pullRelayPending", () => {
  it("returns an empty array when nothing is queued (and no ack)", async () => {
    expect(await pullRelayPending(brokeredEnv(), 9700)).toEqual([]);
  });

  it("returns this installation's queued events, mapped + ordered, and scoped to the install", async () => {
    const e = brokeredEnv();
    await enqueueRelayPending(e, { deliveryId: "a", installationId: 9701, eventName: "pull_request", rawBody: "{}" });
    await enqueueRelayPending(e, { deliveryId: "b", installationId: 9701, eventName: "issues", rawBody: "{}" });
    await enqueueRelayPending(e, { deliveryId: "other", installationId: 9999, eventName: "pull_request", rawBody: "{}" }); // a different install
    const events = await pullRelayPending(e, 9701);
    expect(events.map((ev) => ev.deliveryId)).toEqual(["a", "b"]); // only this install, ordered
    expect(events[0]).toEqual({ deliveryId: "a", eventName: "pull_request", rawBody: "{}" });
  });

  it("ACK-deletes only the named rows, scoped to this installation (can't ack another install's row)", async () => {
    const e = brokeredEnv();
    await enqueueRelayPending(e, { deliveryId: "k1", installationId: 9702, eventName: "pull_request", rawBody: "{}" });
    await enqueueRelayPending(e, { deliveryId: "k2", installationId: 9702, eventName: "issues", rawBody: "{}" });
    await enqueueRelayPending(e, { deliveryId: "victim", installationId: 8888, eventName: "pull_request", rawBody: "{}" }); // another install
    // Ack k1 (own) AND victim (another install's id) — only k1 is removed; victim is protected by the install scope.
    const remaining = await pullRelayPending(e, 9702, { ack: ["k1", "victim"] });
    expect(remaining.map((ev) => ev.deliveryId)).toEqual(["k2"]);
    const victim = await db(e).prepare("SELECT delivery_id FROM orb_relay_pending WHERE delivery_id='victim'").first();
    expect(victim ?? null).not.toBeNull(); // the other install's row survived the cross-install ack
  });

  it("treats an empty ack array as no-op (the ack.length === 0 branch)", async () => {
    const e = brokeredEnv();
    await enqueueRelayPending(e, { deliveryId: "n1", installationId: 9703, eventName: "pull_request", rawBody: "{}" });
    const events = await pullRelayPending(e, 9703, { ack: [] });
    expect(events.map((ev) => ev.deliveryId)).toEqual(["n1"]); // nothing deleted
  });

  it("caps the ack list at the batch size so the IN(...) SQL is bounded", async () => {
    const e = brokeredEnv();
    // Queue 60 rows, ack 60 ids — only the first 50 (batch cap) are actually deleted.
    for (let i = 0; i < 60; i += 1) await enqueueRelayPending(e, { deliveryId: `ack-${String(i).padStart(2, "0")}`, installationId: 9704, eventName: "pull_request", rawBody: "{}" });
    const ackIds = Array.from({ length: 60 }, (_, i) => `ack-${String(i).padStart(2, "0")}`);
    await pullRelayPending(e, 9704, { ack: ackIds, limit: 1 });
    const left = await db(e).prepare("SELECT COUNT(*) AS n FROM orb_relay_pending WHERE installation_id=9704").first<{ n: number }>();
    expect(left?.n).toBe(10); // 60 queued − 50 acked (cap) = 10 remain
  });

  it("returns at most the batch size, and clamps an over-large requested limit down to it", async () => {
    const e = brokeredEnv();
    for (let i = 0; i < 55; i += 1) await enqueueRelayPending(e, { deliveryId: `bulk-${String(i).padStart(2, "0")}`, installationId: 9705, eventName: "pull_request", rawBody: "{}" });
    expect((await pullRelayPending(e, 9705, { limit: 1000 })).length).toBe(50); // clamped to RELAY_PENDING_BATCH_SIZE
    expect((await pullRelayPending(e, 9705)).length).toBe(50); // default limit is the batch too (opts undefined arm)
    expect((await pullRelayPending(e, 9705, { limit: 5 })).length).toBe(5); // a smaller requested limit is honoured
    expect((await pullRelayPending(e, 9705, { limit: 0 })).length).toBe(50); // non-positive limits fall back to batch default
    expect((await pullRelayPending(e, 9705, { limit: -1 })).length).toBe(50); // guards SQLite LIMIT -1 (unbounded)
    expect((await pullRelayPending(e, 9705, { limit: Number.NaN })).length).toBe(50); // non-integer / non-finite fallback
    expect((await pullRelayPending(e, 9705, { limit: 1.5 })).length).toBe(50); // finite fractional limits fall back to batch default
  });

  it("PRUNES rows older than the TTL before returning the batch, and logs the drop at error level", async () => {
    const e = brokeredEnv();
    const errLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await db(e).prepare("INSERT INTO orb_relay_pending (delivery_id, installation_id, event_name, raw_body, created_at) VALUES (?, ?, ?, ?, datetime('now', '-25 hours'))").bind("stale-1", 9706, "pull_request", "{}").run();
    await enqueueRelayPending(e, { deliveryId: "fresh-1", installationId: 9706, eventName: "pull_request", rawBody: "{}" });
    const events = await pullRelayPending(e, 9706);
    expect(events.map((ev) => ev.deliveryId)).toEqual(["fresh-1"]); // the 25h-old row was pruned (TTL 24h)
    const stale = await db(e).prepare("SELECT delivery_id FROM orb_relay_pending WHERE delivery_id='stale-1'").first();
    expect(stale ?? null).toBeNull();
    // Pull-mode loss is now traced for the operator at error level (parity with the push-path drop).
    expect(errLog.mock.calls.some(([line]) => String(line).includes("orb_relay_pending_dropped") && String(line).includes('"level":"error"'))).toBe(true);
  });
});

describe("forwardOrbEvent (pull mode #16)", () => {
  it("ENQUEUES instead of pushing and returns 'queued' for a pull-mode enrollment", async () => {
    const e = brokeredEnv();
    const secret = await enroll(e, 8100);
    expect(await registerOrbRelay(e, secret, "", "pull")).toEqual({ ok: true, installationId: 8100 });
    let fetched = false;
    const fetchSpy = (() => { fetched = true; return Promise.resolve(new Response("ok")); }) as typeof fetch;
    expect(await forwardOrbEvent(e, { eventName: "pull_request", installationId: 8100, deliveryId: "q-1", rawBody: '{"a":1}' }, fetchSpy)).toBe("queued");
    expect(fetched).toBe(false); // pull mode never pushes
    const row = await db(e).prepare("SELECT event_name, raw_body FROM orb_relay_pending WHERE delivery_id='q-1' AND installation_id=8100").first<{ event_name: string; raw_body: string }>();
    expect(row?.event_name).toBe("pull_request");
    expect(row?.raw_body).toBe('{"a":1}');
  });

  it("SKIPS an enrolled install with no relay registered (push default, relay_url still null)", async () => {
    const e = brokeredEnv();
    await enroll(e, 8101); // enrolled, relay_mode defaults to 'push', no relay_url
    expect(await forwardOrbEvent(e, { eventName: "pull_request", installationId: 8101, deliveryId: "d", rawBody: "{}" })).toBe("skipped");
  });

  it("IGNORES a forwardable event for an install with NO enrollment row at all (the !row arm)", async () => {
    const e = brokeredEnv();
    // installationId 8199 is never enrolled → terminal no-enrollment skips are not retryable.
    expect(await forwardOrbEvent(e, { eventName: "pull_request", installationId: 8199, deliveryId: "d", rawBody: "{}" })).toBe("ignored");
  });

  it("re-registering a pull enrollment in push mode flips relay_mode back so it PUSHES again", async () => {
    const e = brokeredEnv();
    const secret = await enroll(e, 8102);
    await registerOrbRelay(e, secret, "", "pull"); // first: pull
    await registerOrbRelay(e, secret, "https://c.example/v1/orb/relay", "push"); // re-register: push
    const { fetchImpl, calls } = (() => {
      const c: { url: string }[] = [];
      return { fetchImpl: ((u: RequestInfo | URL) => { c.push({ url: String(u) }); return Promise.resolve(new Response("ok")); }) as typeof fetch, calls: c };
    })();
    expect(await forwardOrbEvent(e, { eventName: "pull_request", installationId: 8102, deliveryId: "d", rawBody: "{}" }, fetchImpl)).toBe("forwarded");
    expect(calls[0]?.url).toBe("https://c.example/v1/orb/relay");
    const mode = await db(e).prepare("SELECT relay_mode FROM orb_enrollments WHERE installation_id=8102").first<{ relay_mode: string }>();
    expect(mode?.relay_mode).toBe("push");
  });
});

describe("retryFailedRelays treats 'queued' as terminal-success", () => {
  it("DELETES a failure row once the enrollment switches to pull (forwardOrbEvent now queues it)", async () => {
    const e = brokeredEnv();
    const secret = await enroll(e, 8200);
    await registerOrbRelay(e, secret, "", "pull");
    // A failure recorded before the switch (or a stale row) is now resolved by queuing on retry.
    await storeRelayFailure(e, { deliveryId: "requeue-1", eventName: "pull_request", installationId: 8200, rawBody: "{}" });
    await retryFailedRelays(e);
    const fail = await db(e).prepare("SELECT delivery_id FROM orb_relay_failures WHERE delivery_id='requeue-1'").first();
    expect(fail ?? null).toBeNull(); // failure row cleaned up — 'queued' is terminal-success
    const pending = await db(e).prepare("SELECT delivery_id FROM orb_relay_pending WHERE delivery_id='requeue-1'").first();
    expect(pending ?? null).not.toBeNull(); // and the event was moved into the pull queue
  });
});

describe("registerOrbRelay pull vs push", () => {
  it("pull mode sets relay_mode='pull', stamps relay_registered_at, and skips the SSRF + encryption path", async () => {
    const e = createTestEnv({ ORB_BROKER_ENABLED: "true" }); // no TOKEN_ENCRYPTION_SECRET — pull must not need it
    const secret = await enroll(e, 8300);
    expect(await registerOrbRelay(e, secret, "", "pull")).toEqual({ ok: true, installationId: 8300 }); // no encryption_unavailable
    const row = await db(e).prepare("SELECT relay_mode, relay_url, relay_secret_enc, relay_registered_at FROM orb_enrollments WHERE installation_id=8300").first<{ relay_mode: string; relay_url: string | null; relay_secret_enc: string | null; relay_registered_at: string | null }>();
    expect(row?.relay_mode).toBe("pull");
    expect(row?.relay_url ?? null).toBeNull(); // no URL stored for pull
    expect(row?.relay_secret_enc ?? null).toBeNull(); // no secret encrypted for pull
    expect(row?.relay_registered_at).toBeTruthy();
  });

  it("push mode still SSRF-validates and still errors when encryption is unavailable", async () => {
    const e = brokeredEnv();
    const s1 = await enroll(e, 8301);
    expect(await registerOrbRelay(e, s1, "http://127.0.0.1/relay", "push")).toEqual({ error: "invalid_relay_url" }); // SSRF still enforced
    const noEnc = createTestEnv({ ORB_BROKER_ENABLED: "true" });
    const s2 = await enroll(noEnc, 8302);
    expect(await registerOrbRelay(noEnc, s2, "https://x.example/relay", "push")).toEqual({ error: "encryption_unavailable" });
  });

  it("defaults to push (the mode arm omitted) and sets relay_mode='push'", async () => {
    const e = brokeredEnv();
    const secret = await enroll(e, 8303);
    expect(await registerOrbRelay(e, secret, "https://c.example/v1/orb/relay")).toEqual({ ok: true, installationId: 8303 });
    const row = await db(e).prepare("SELECT relay_mode FROM orb_enrollments WHERE installation_id=8303").first<{ relay_mode: string }>();
    expect(row?.relay_mode).toBe("push");
  });
});

describe("POST /v1/orb/relay/register (mode field)", () => {
  const app = createApp();

  it("accepts mode='pull' WITHOUT a relayUrl and flags the enrollment for pull", async () => {
    const e = brokeredEnv();
    const secret = await enroll(e, 8400);
    const res = await app.request("/v1/orb/relay/register", { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ mode: "pull" }) }, e);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, installationId: 8400 });
    const row = await db(e).prepare("SELECT relay_mode FROM orb_enrollments WHERE installation_id=8400").first<{ relay_mode: string }>();
    expect(row?.relay_mode).toBe("pull");
  });

  it("still requires relayUrl for mode='push' (and an omitted mode defaults to push)", async () => {
    const e = brokeredEnv();
    const secret = await enroll(e, 8401);
    expect((await app.request("/v1/orb/relay/register", { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ mode: "push" }) }, e)).status).toBe(400); // missing_relay_url
    expect((await app.request("/v1/orb/relay/register", { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({}) }, e)).status).toBe(400); // default push, missing url
  });

  it("400s on an unrecognized mode value (neither push nor pull)", async () => {
    const e = brokeredEnv();
    const secret = await enroll(e, 8402);
    const res = await app.request("/v1/orb/relay/register", { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ mode: "sideways" }) }, e);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_mode" });
  });
});

describe("POST /v1/orb/relay/pull", () => {
  const app = createApp();

  it("404s when the broker flag is off (byte-identical deploy)", async () => {
    expect((await app.request("/v1/orb/relay/pull", { method: "POST" }, createTestEnv())).status).toBe(404);
  });

  it("401 without a secret", async () => {
    expect((await app.request("/v1/orb/relay/pull", { method: "POST" }, brokeredEnv())).status).toBe(401);
  });

  it("401 on an unknown secret, 403 on an ineligible install", async () => {
    const e = brokeredEnv();
    expect((await app.request("/v1/orb/relay/pull", { method: "POST", headers: { authorization: "Bearer orbsec_bad" } }, e)).status).toBe(401);
    const secret = await enroll(e, 8500);
    await db(e).prepare("UPDATE orb_github_installations SET registered=0 WHERE installation_id=8500").run();
    expect((await app.request("/v1/orb/relay/pull", { method: "POST", headers: { authorization: `Bearer ${secret}` } }, e)).status).toBe(403);
  });

  it("413 when the body exceeds the register-body ceiling", async () => {
    const e = brokeredEnv();
    const secret = await enroll(e, 8501);
    const res = await app.request("/v1/orb/relay/pull", { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: "x".repeat(MAX_ORB_RELAY_REGISTER_BODY_BYTES + 1) }, e);
    expect(res.status).toBe(413);
  });

  it("returns the queued events for the bound install (no ack, empty body)", async () => {
    const e = brokeredEnv();
    const secret = await enroll(e, 8502);
    await enqueueRelayPending(e, { deliveryId: "pe-1", installationId: 8502, eventName: "pull_request", rawBody: '{"x":1}' });
    const res = await app.request("/v1/orb/relay/pull", { method: "POST", headers: { authorization: `Bearer ${secret}` } }, e);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [{ deliveryId: "pe-1", eventName: "pull_request", rawBody: '{"x":1}' }] });
  });

  it("passes a valid ack[] through (acked rows are deleted), and tolerates a non-string ack entry", async () => {
    const e = brokeredEnv();
    const secret = await enroll(e, 8503);
    await enqueueRelayPending(e, { deliveryId: "ack-a", installationId: 8503, eventName: "pull_request", rawBody: "{}" });
    await enqueueRelayPending(e, { deliveryId: "ack-b", installationId: 8503, eventName: "issues", rawBody: "{}" });
    const res = await app.request("/v1/orb/relay/pull", { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ ack: ["ack-a", 123] }) }, e); // 123 filtered out
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [{ deliveryId: "ack-b", eventName: "issues", rawBody: "{}" }] }); // ack-a removed
  });

  it("tolerates a non-array ack field and an unparseable body (no ack, returns events)", async () => {
    const e = brokeredEnv();
    const secret = await enroll(e, 8504);
    await enqueueRelayPending(e, { deliveryId: "keep-1", installationId: 8504, eventName: "pull_request", rawBody: "{}" });
    const nonArray = await app.request("/v1/orb/relay/pull", { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ ack: "nope" }) }, e); // ack not an array
    expect(await nonArray.json()).toEqual({ events: [{ deliveryId: "keep-1", eventName: "pull_request", rawBody: "{}" }] });
    const bad = await app.request("/v1/orb/relay/pull", { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: "{not json" }, e); // unparseable → catch
    expect(bad.status).toBe(200);
    expect(await bad.json()).toEqual({ events: [{ deliveryId: "keep-1", eventName: "pull_request", rawBody: "{}" }] });
  });
});
