import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { handleOrbIngest, readOrbIngestBody, verifyOrbIngestSignature } from "../../src/orb/ingest";
import { createTestEnv, TestD1Database } from "../helpers/d1";

const ORB_INGEST_SECRET = "orb-ingest-test-secret";

async function signOrbBody(body: string, secret = ORB_INGEST_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

// ── handleOrbIngest unit-style tests ──────────────────────────────────────────

describe("handleOrbIngest()", () => {
  function makeDb(): D1Database {
    return new TestD1Database() as unknown as D1Database;
  }

  function makePayload(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      instance_id: "abc123def456abc0",
      events: [
        {
          repo_hash: "a1b2c3d4e5f6a1b2c3d4e5f6",
          pr_hash: "f6e5d4c3b2a1f6e5d4c3b2a1",
          outcome: "merged",
          gate_verdict: "approve",
          time_to_close_ms: 3600000,
          created_at: "2024-01-01T00:00:00Z",
        },
      ],
      ...overrides,
    });
  }

  it("accepts a valid batch and returns accepted count", async () => {
    const db = makeDb();
    const result = await handleOrbIngest(makePayload(), db);
    expect(result).toEqual({ accepted: 1 });
  });

  it("returns invalid_json when body is not valid JSON (covers JSON.parse catch branch)", async () => {
    const db = makeDb();
    expect(await handleOrbIngest("{not json}", db)).toEqual({ error: "invalid_json" });
  });

  it("returns invalid_payload when instance_id is not a string", async () => {
    const db = makeDb();
    expect(await handleOrbIngest(JSON.stringify({ instance_id: 123, events: [] }), db)).toEqual({ error: "invalid_payload" });
  });

  it("returns invalid_payload when events is not an array (covers !Array.isArray branch)", async () => {
    const db = makeDb();
    expect(await handleOrbIngest(JSON.stringify({ instance_id: "abc", events: "bad" }), db)).toEqual({ error: "invalid_payload" });
  });

  it("returns invalid_payload when instance_id is an empty string (covers !instance_id branch)", async () => {
    const db = makeDb();
    expect(await handleOrbIngest(JSON.stringify({ instance_id: "", events: [{ repo_hash: "a", pr_hash: "b", outcome: "merged" }] }), db)).toEqual({ error: "invalid_payload" });
  });

  it("returns invalid_payload when events array is empty (covers events.length === 0 branch)", async () => {
    const db = makeDb();
    expect(await handleOrbIngest(JSON.stringify({ instance_id: "abc", events: [] }), db)).toEqual({ error: "invalid_payload" });
  });

  it("skips events with a non-string repo_hash (covers typeof repo_hash !== string branch)", async () => {
    const db = makeDb();
    const result = await handleOrbIngest(
      JSON.stringify({ instance_id: "inst1", events: [{ repo_hash: 99, pr_hash: "hash", outcome: "merged" }] }),
      db,
    );
    expect(result).toEqual({ accepted: 0 });
  });

  it("skips events with an empty repo_hash (covers !repo_hash branch)", async () => {
    const db = makeDb();
    const result = await handleOrbIngest(
      JSON.stringify({ instance_id: "inst1", events: [{ repo_hash: "", pr_hash: "hash", outcome: "merged" }] }),
      db,
    );
    expect(result).toEqual({ accepted: 0 });
  });

  it("skips events with a non-string pr_hash (covers typeof pr_hash !== string branch)", async () => {
    const db = makeDb();
    const result = await handleOrbIngest(
      JSON.stringify({ instance_id: "inst1", events: [{ repo_hash: "rhash", pr_hash: null, outcome: "merged" }] }),
      db,
    );
    expect(result).toEqual({ accepted: 0 });
  });

  it("skips events with an empty pr_hash (covers !pr_hash branch)", async () => {
    const db = makeDb();
    const result = await handleOrbIngest(
      JSON.stringify({ instance_id: "inst1", events: [{ repo_hash: "rhash", pr_hash: "", outcome: "merged" }] }),
      db,
    );
    expect(result).toEqual({ accepted: 0 });
  });

  it("skips events with an invalid outcome (covers !VALID_OUTCOMES.has branch)", async () => {
    const db = makeDb();
    const result = await handleOrbIngest(
      JSON.stringify({ instance_id: "inst1", events: [{ repo_hash: "rh", pr_hash: "ph", outcome: "opened" }] }),
      db,
    );
    expect(result).toEqual({ accepted: 0 });
  });

  it("stores null gate_verdict when field is absent (covers typeof gate_verdict !== string branch)", async () => {
    const db = makeDb();
    await handleOrbIngest(
      JSON.stringify({ instance_id: "inst1", events: [{ repo_hash: "rh1", pr_hash: "ph1", outcome: "closed" }] }),
      db,
    );
    const row = await (db as unknown as TestD1Database).prepare("SELECT gate_verdict FROM orb_signals WHERE pr_hash='ph1'").first<{ gate_verdict: string | null }>();
    expect(row?.gate_verdict).toBeNull();
  });

  it("stores gate_verdict string when field is present (covers typeof gate_verdict === string branch)", async () => {
    const db = makeDb();
    await handleOrbIngest(
      JSON.stringify({ instance_id: "inst1", events: [{ repo_hash: "rh2", pr_hash: "ph2", outcome: "merged", gate_verdict: "approve" }] }),
      db,
    );
    const row = await (db as unknown as TestD1Database).prepare("SELECT gate_verdict FROM orb_signals WHERE pr_hash='ph2'").first<{ gate_verdict: string | null }>();
    expect(row?.gate_verdict).toBe("approve");
  });

  it("stores null time_to_close_ms when field is absent (covers typeof time_to_close_ms !== number branch)", async () => {
    const db = makeDb();
    await handleOrbIngest(
      JSON.stringify({ instance_id: "inst1", events: [{ repo_hash: "rh3", pr_hash: "ph3", outcome: "closed" }] }),
      db,
    );
    const row = await (db as unknown as TestD1Database).prepare("SELECT time_to_close_ms FROM orb_signals WHERE pr_hash='ph3'").first<{ time_to_close_ms: number | null }>();
    expect(row?.time_to_close_ms).toBeNull();
  });

  it("stores time_to_close_ms when field is a number (covers typeof time_to_close_ms === number branch)", async () => {
    const db = makeDb();
    await handleOrbIngest(
      JSON.stringify({ instance_id: "inst1", events: [{ repo_hash: "rh4", pr_hash: "ph4", outcome: "merged", time_to_close_ms: 7200000 }] }),
      db,
    );
    const row = await (db as unknown as TestD1Database).prepare("SELECT time_to_close_ms FROM orb_signals WHERE pr_hash='ph4'").first<{ time_to_close_ms: number | null }>();
    expect(row?.time_to_close_ms).toBe(7200000);
  });

  it("stores null sent_at when created_at is absent (covers typeof created_at !== string branch)", async () => {
    const db = makeDb();
    await handleOrbIngest(
      JSON.stringify({ instance_id: "inst1", events: [{ repo_hash: "rh5", pr_hash: "ph5", outcome: "merged" }] }),
      db,
    );
    const row = await (db as unknown as TestD1Database).prepare("SELECT sent_at FROM orb_signals WHERE pr_hash='ph5'").first<{ sent_at: string | null }>();
    expect(row?.sent_at).toBeNull();
  });

  it("stores sent_at when created_at is a string (covers typeof created_at === string branch)", async () => {
    const db = makeDb();
    await handleOrbIngest(
      JSON.stringify({ instance_id: "inst1", events: [{ repo_hash: "rh6", pr_hash: "ph6", outcome: "merged", created_at: "2024-06-01T12:00:00Z" }] }),
      db,
    );
    const row = await (db as unknown as TestD1Database).prepare("SELECT sent_at FROM orb_signals WHERE pr_hash='ph6'").first<{ sent_at: string | null }>();
    expect(row?.sent_at).toBe("2024-06-01T12:00:00Z");
  });

  it("deduplicates via INSERT OR IGNORE — second insert is not counted (covers result.meta.changes === 0 branch)", async () => {
    const db = makeDb();
    const body = JSON.stringify({ instance_id: "inst1", events: [{ repo_hash: "rh7", pr_hash: "ph7", outcome: "merged" }] });
    expect(await handleOrbIngest(body, db)).toEqual({ accepted: 1 });
    expect(await handleOrbIngest(body, db)).toEqual({ accepted: 0 }); // duplicate ignored
  });

  it("counts both accepted and skipped events in the same batch", async () => {
    const db = makeDb();
    const result = await handleOrbIngest(
      JSON.stringify({
        instance_id: "inst1",
        events: [
          { repo_hash: "rh8", pr_hash: "ph8", outcome: "merged" },
          { repo_hash: "", pr_hash: "ph9", outcome: "merged" }, // invalid — skipped
          { repo_hash: "rh10", pr_hash: "ph10", outcome: "invalid" }, // invalid outcome — skipped
        ],
      }),
      db,
    );
    expect(result).toEqual({ accepted: 1 });
  });

  it("caps batch at 500 events (MAX_BATCH) — extra events not inserted", async () => {
    const db = makeDb();
    const events = Array.from({ length: 501 }, (_, i) => ({
      repo_hash: `rh${i}`,
      pr_hash: `ph${i}`,
      outcome: "merged" as const,
    }));
    const result = await handleOrbIngest(JSON.stringify({ instance_id: "inst-batch", events }), db);
    expect(result).toEqual({ accepted: 500 });
  });


  it("rejects an overlong instance_id before inserting rows", async () => {
    const db = makeDb();
    const result = await handleOrbIngest(
      JSON.stringify({ instance_id: "i".repeat(65), events: [{ repo_hash: "rh", pr_hash: "ph", outcome: "merged" }] }),
      db,
    );
    expect(result).toEqual({ error: "invalid_payload" });
  });

  it("skips events with empty or overlong optional strings", async () => {
    const db = makeDb();
    const result = await handleOrbIngest(
      JSON.stringify({
        instance_id: "inst1",
        events: [
          { repo_hash: "rh-overlong-gate", pr_hash: "ph-overlong-gate", outcome: "merged", gate_verdict: "v".repeat(65) },
          { repo_hash: "rh-overlong-date", pr_hash: "ph-overlong-date", outcome: "closed", created_at: "2".repeat(65) },
          { repo_hash: "rh-empty-gate", pr_hash: "ph-empty-gate", outcome: "merged", gate_verdict: "" },
        ],
      }),
      db,
    );
    expect(result).toEqual({ accepted: 0 });
  });

  it("does not throw when the DB throws on insert (covers inner catch branch)", async () => {
    const brokenDb = {
      prepare: () => ({ bind: () => ({ run: () => Promise.reject(new Error("disk full")) }) }),
    } as unknown as D1Database;
    const result = await handleOrbIngest(
      JSON.stringify({ instance_id: "inst1", events: [{ repo_hash: "rh", pr_hash: "ph", outcome: "merged" }] }),
      brokenDb,
    );
    expect(result).toEqual({ accepted: 0 });
  });
});


// ── Orb ingest transport guards ───────────────────────────────────────────────

describe("Orb ingest transport guards", () => {
  it("verifies valid signatures and rejects missing secrets", async () => {
    const body = JSON.stringify({ ok: true });
    expect(await verifyOrbIngestSignature(body, await signOrbBody(body), ORB_INGEST_SECRET)).toBe(true);
    expect(await verifyOrbIngestSignature(body, await signOrbBody(body), undefined)).toBe(false);
  });

  it("reads a body under the byte limit", async () => {
    const request = new Request("https://example.test/v1/orb/ingest", { method: "POST", body: "hello" });
    await expect(readOrbIngestBody(request, "5")).resolves.toBe("hello");
  });

  it("returns an empty string when the request has no body stream", async () => {
    const request = new Request("https://example.test/v1/orb/ingest");
    await expect(readOrbIngestBody(request, null)).resolves.toBe("");
  });

  it("ignores invalid content-length values", async () => {
    const request = new Request("https://example.test/v1/orb/ingest", { method: "POST", body: "hello" });
    await expect(readOrbIngestBody(request, "not-a-number")).resolves.toBe("hello");
  });

  it("rejects content-length values over the byte limit", async () => {
    const request = new Request("https://example.test/v1/orb/ingest", { method: "POST", body: "hello" });
    await expect(readOrbIngestBody(request, "131073")).resolves.toBeNull();
  });

  it("rejects streamed bodies that cross the byte limit without content-length", async () => {
    const request = new Request("https://example.test/v1/orb/ingest", { method: "POST", body: "x".repeat(131073) });
    await expect(readOrbIngestBody(request, null)).resolves.toBeNull();
  });
});

// ── Route integration tests (covers routes.ts new lines) ──────────────────────

describe("POST /v1/orb/ingest route", () => {
  const app = createApp();

  it("returns 200 with accepted count for a valid batch", async () => {
    const body = JSON.stringify({
      instance_id: "abc123def456abc0",
      events: [{ repo_hash: "rhash1234567890123456", pr_hash: "phash1234567890123456", outcome: "merged" }],
    });
    const res = await app.request(
      "/v1/orb/ingest",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-orb-signature": await signOrbBody(body) },
        body,
      },
      createTestEnv({ ORB_INGEST_SECRET }),
    );
    expect(res.status).toBe(200);
    const json = await res.json() as { accepted: number };
    expect(json.accepted).toBe(1);
  });

  it("returns 400 for invalid JSON (covers error-in-result branch)", async () => {
    const env = createTestEnv({ ORB_INGEST_SECRET });
    const body = "{bad";
    const res = await app.request(
      "/v1/orb/ingest",
      { method: "POST", headers: { "content-type": "application/json", "x-orb-signature": await signOrbBody(body) }, body },
      env,
    );
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("invalid_json");
  });


  it("rejects unsigned batches before parsing (regression for unauthenticated signal poisoning)", async () => {
    const env = createTestEnv({ ORB_INGEST_SECRET });
    const body = JSON.stringify({
      instance_id: "abc123def456abc0",
      events: [{ repo_hash: "rhash1234567890123456", pr_hash: "phash1234567890123456", outcome: "merged" }],
    });
    const res = await app.request("/v1/orb/ingest", { method: "POST", headers: { "content-type": "application/json" }, body }, env);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_signature" });
  });

  it("rejects oversized batches before reading the full body", async () => {
    const env = createTestEnv({ ORB_INGEST_SECRET });
    const body = JSON.stringify({ instance_id: "abc123def456abc0", events: [] });
    const res = await app.request(
      "/v1/orb/ingest",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "131073",
          "x-orb-signature": await signOrbBody(body),
        },
        body,
      },
      env,
    );
    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toMatchObject({ error: "payload_too_large" });
  });

  it("returns 400 for an empty body (covers !body branch in route)", async () => {
    const env = createTestEnv({ ORB_INGEST_SECRET });
    const res = await app.request("/v1/orb/ingest", { method: "POST", body: "" }, env);
    expect(res.status).toBe(400);
  });
});
