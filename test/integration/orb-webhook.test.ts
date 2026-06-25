import type { Context } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { handleOrbWebhook } from "../../src/orb/webhook";
import { createTestEnv, type TestD1Database } from "../helpers/d1";

const SECRET = "orb-test-secret";
const env = (over: Record<string, string> = {}): Env => createTestEnv({ ORB_GITHUB_WEBHOOK_SECRET: SECRET, ...over });

async function sign(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${[...new Uint8Array(signed)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function ctx(e: Env, headers: Record<string, string | null>, request: Request): Context<{ Bindings: Env }> {
  return {
    req: { raw: request, header: (n: string) => headers[n.toLowerCase()] ?? null },
    env: e,
    json: (payload: unknown, status?: number) => Response.json(payload, status === undefined ? undefined : { status }),
  } as unknown as Context<{ Bindings: Env }>;
}

async function post(
  e: Env,
  body: string,
  opts: { delivery?: string | null; event?: string | null; sig?: string; headers?: Record<string, string | null>; request?: Request } = {},
): Promise<Response> {
  const headers: Record<string, string | null> = {
    "x-github-delivery": opts.delivery === undefined ? "d1" : opts.delivery,
    "x-github-event": opts.event === undefined ? "installation" : opts.event,
    "x-hub-signature-256": opts.sig ?? (await sign(body, SECRET)),
    ...opts.headers,
  };
  const request = opts.request ?? new Request("https://collector/v1/orb/webhook", { method: "POST", body });
  return handleOrbWebhook(ctx(e, headers, request));
}

const INSTALL = JSON.stringify({ action: "created", installation: { id: 42 }, repository: { full_name: "JSONbored/gittensory" } });
const row = (e: Env, delivery: string) =>
  (e.DB as unknown as TestD1Database).prepare("SELECT event_name, action, installation_id, repository_full_name, status FROM orb_webhook_events WHERE delivery_id=?").bind(delivery).first<{ event_name: string; action: string; installation_id: number; repository_full_name: string; status: string }>();

describe("handleOrbWebhook (POST /v1/orb/webhook)", () => {
  it("500 + records 'error' when the install-registry upsert fails (so GitHub redelivers)", async () => {
    const e = env();
    const real = e.DB;
    // Throw on the installations upsert only; the webhook_events read/write still go to the real DB.
    (e as { DB: unknown }).DB = {
      prepare: (sql: string) =>
        sql.includes("orb_github_installations") ? { bind: () => ({ run: () => Promise.reject(new Error("boom")) }) } : real.prepare(sql),
    };
    const res = await post(e, INSTALL, { delivery: "up-err" });
    expect(res.status).toBe(500);
    const stored = await (real as unknown as TestD1Database).prepare("SELECT status FROM orb_webhook_events WHERE delivery_id=?").bind("up-err").first<{ status: string }>();
    expect(stored?.status).toBe("error"); // not suppressed → GitHub can retry
  });

  it("400 when the GitHub delivery or event header is missing", async () => {
    expect((await post(env(), INSTALL, { delivery: null as unknown as string })).status).toBe(400);
    expect((await post(env(), INSTALL, { event: null as unknown as string })).status).toBe(400);
  });

  it("401 on an invalid signature (and 401 when the Orb secret is absent — fail-closed)", async () => {
    expect((await post(env(), INSTALL, { sig: "sha256=deadbeef" })).status).toBe(401);
    const noSecret = createTestEnv(); // ORB_GITHUB_WEBHOOK_SECRET unset
    expect((await post(noSecret, INSTALL)).status).toBe(401);
  });

  it("401 when the signature header is absent entirely", async () => {
    expect((await post(env(), INSTALL, { headers: { "x-hub-signature-256": null } })).status).toBe(401);
  });

  it("ignores a non-numeric content-length and processes normally", async () => {
    const res = await post(env(), INSTALL, { delivery: "cl-abc", headers: { "content-length": "abc" } });
    expect(res.status).toBe(202);
  });

  it("413 when content-length exceeds the cap", async () => {
    const res = await post(env(), INSTALL, { headers: { "content-length": "99999999" } });
    expect(res.status).toBe(413);
  });

  it("413 when the streamed body exceeds the cap (no content-length declared)", async () => {
    const res = await post(env({ GITHUB_WEBHOOK_MAX_BODY_BYTES: "16" }), "x".repeat(40));
    expect(res.status).toBe(413);
  });

  it("400 on a signed-but-non-JSON body", async () => {
    expect((await post(env(), "not json")).status).toBe(400);
  });

  it("202 + records the install event (action/installation/repo extracted)", async () => {
    const e = env();
    const res = await post(e, INSTALL, { delivery: "ok-1" });
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({ status: "received", eventName: "installation" });
    expect(await row(e, "ok-1")).toMatchObject({ action: "created", installation_id: 42, repository_full_name: "JSONbored/gittensory", status: "received" });
  });

  it("stores null fields for a payload with no action/installation/repository (e.g. ping)", async () => {
    const e = env();
    await post(e, JSON.stringify({ zen: "keep it logically awesome" }), { delivery: "ping-1", event: "ping" });
    expect(await row(e, "ping-1")).toMatchObject({ action: null, installation_id: null, repository_full_name: null });
  });

  it("dedups a redelivery of the same (delivery, payload) as a duplicate", async () => {
    const e = env();
    expect((await post(e, INSTALL, { delivery: "dup-1" })).status).toBe(202);
    const second = await post(e, INSTALL, { delivery: "dup-1" });
    expect(second.status).toBe(202);
    await expect(second.json()).resolves.toMatchObject({ status: "duplicate" });
  });

  it("re-records a redelivery whose payload CHANGED (same delivery id, different hash)", async () => {
    const e = env();
    await post(e, INSTALL, { delivery: "chg-1" });
    const changed = JSON.stringify({ action: "deleted", installation: { id: 42 } });
    const res = await post(e, changed, { delivery: "chg-1" });
    await expect(res.json()).resolves.toMatchObject({ status: "received" }); // not a duplicate
    expect((await row(e, "chg-1"))?.action).toBe("deleted");
  });

  it("treats an already-processed delivery as a duplicate regardless of payload", async () => {
    const e = env();
    await (e.DB as unknown as TestD1Database)
      .prepare("INSERT INTO orb_webhook_events (delivery_id, event_name, payload_hash, status) VALUES ('proc-1','installation','oldhash','processed')")
      .run();
    const res = await post(e, INSTALL, { delivery: "proc-1" });
    await expect(res.json()).resolves.toMatchObject({ status: "duplicate" });
  });

  it("does NOT suppress an 'error' row — the delivery is retried", async () => {
    const e = env();
    await (e.DB as unknown as TestD1Database)
      .prepare("INSERT INTO orb_webhook_events (delivery_id, event_name, payload_hash, status) VALUES ('err-1','installation','oldhash','error')")
      .run();
    const res = await post(e, INSTALL, { delivery: "err-1" });
    await expect(res.json()).resolves.toMatchObject({ status: "received" }); // re-recorded, not suppressed
    expect((await row(e, "err-1"))?.status).toBe("received");
  });

  it("treats a missing request body as empty (→ 400 invalid JSON after a valid empty-body signature)", async () => {
    const e = env();
    const sig = await sign("", SECRET);
    const res = await post(e, "", { request: new Request("https://collector/v1/orb/webhook", { method: "POST" }), sig });
    expect(res.status).toBe(400); // empty body verifies, then fails JSON.parse
  });

  it("skips undefined stream chunks while reading the body", async () => {
    const e = env();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(undefined as unknown as Uint8Array);
        controller.close();
      },
    });
    const request = { body } as unknown as Request;
    const res = await post(e, "", { request, sig: "sha256=bad" });
    expect(res.status).toBe(401); // empty (undefined-skipped) body + bad sig
  });
});

describe("POST /v1/orb/webhook route (through the app middleware)", () => {
  const app = createApp();

  it("is token-exempt + rate-classified, routing to the handler (401 on a bad signature)", async () => {
    // Exercises requiresApiToken (exempt) + routeClassForPath (strict) for the new path, then the handler.
    const res = await app.request(
      "/v1/orb/webhook",
      { method: "POST", headers: { "x-github-delivery": "rt-1", "x-github-event": "ping", "x-hub-signature-256": "sha256=bad" }, body: "{}" },
      createTestEnv({ ORB_GITHUB_WEBHOOK_SECRET: "s" }),
    );
    expect(res.status).toBe(401);
  });
});
