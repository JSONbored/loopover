import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { handleOrbIngest, MAX_ORB_INGEST_BODY_BYTES, readOrbIngestBody } from "../../src/orb/ingest";
import { createTestEnv, TestD1Database } from "../helpers/d1";

describe("handleOrbIngest()", () => {
  function makeDb(): D1Database {
    return new TestD1Database() as unknown as D1Database;
  }
  const ev = (o: Record<string, unknown> = {}) => ({ repo_hash: "rh", pr_hash: "ph", outcome: "merged", ...o });
  const ingest = (db: D1Database, events: Array<Record<string, unknown>>, instance_id = "inst1") => handleOrbIngest(JSON.stringify({ instance_id, events }), db);
  const col = async (db: D1Database, pr: string, c: string) =>
    (await (db as unknown as TestD1Database).prepare(`SELECT ${c} AS v FROM orb_signals WHERE pr_hash=?`).bind(pr).first<{ v: unknown }>())?.v;

  it("accepts a valid batch and returns the accepted count", async () => {
    expect(await ingest(makeDb(), [ev({ pr_hash: "p1" })])).toEqual({ accepted: 1 });
  });

  it("returns invalid_json on unparseable body", async () => {
    expect(await handleOrbIngest("{not json}", makeDb())).toEqual({ error: "invalid_json" });
  });

  it("returns invalid_payload: instance_id not a string / events not an array / empty instance / empty events", async () => {
    const db = makeDb();
    expect(await handleOrbIngest(JSON.stringify({ instance_id: 123, events: [] }), db)).toEqual({ error: "invalid_payload" });
    expect(await handleOrbIngest(JSON.stringify({ instance_id: "abc", events: "bad" }), db)).toEqual({ error: "invalid_payload" });
    expect(await handleOrbIngest(JSON.stringify({ instance_id: "", events: [ev()] }), db)).toEqual({ error: "invalid_payload" });
    expect(await handleOrbIngest(JSON.stringify({ instance_id: "abc", events: [] }), db)).toEqual({ error: "invalid_payload" });
  });

  it("skips events with bad repo_hash / pr_hash / outcome", async () => {
    expect(await ingest(makeDb(), [ev({ repo_hash: 99 })])).toEqual({ accepted: 0 });
    expect(await ingest(makeDb(), [ev({ repo_hash: "" })])).toEqual({ accepted: 0 });
    expect(await ingest(makeDb(), [ev({ pr_hash: null })])).toEqual({ accepted: 0 });
    expect(await ingest(makeDb(), [ev({ pr_hash: "" })])).toEqual({ accepted: 0 });
    expect(await ingest(makeDb(), [ev({ outcome: "opened" })])).toEqual({ accepted: 0 });
  });

  it("stores gate_verdict string vs null", async () => {
    const db = makeDb();
    await ingest(db, [ev({ pr_hash: "v1", gate_verdict: "merge" }), ev({ pr_hash: "v2" })]);
    expect(await col(db, "v1", "gate_verdict")).toBe("merge");
    expect(await col(db, "v2", "gate_verdict")).toBeNull();
  });

  it("whitelists reversal_flag: valid kept, invalid + absent → 'none'", async () => {
    const db = makeDb();
    await ingest(db, [
      ev({ pr_hash: "r1", reversal_flag: "reverted" }),
      ev({ pr_hash: "r2", reversal_flag: "bogus" }),
      ev({ pr_hash: "r3" }),
    ]);
    expect(await col(db, "r1", "reversal_flag")).toBe("reverted");
    expect(await col(db, "r2", "reversal_flag")).toBe("none");
    expect(await col(db, "r3", "reversal_flag")).toBe("none");
  });

  it("stores gate_reasoncode_bucket string vs null", async () => {
    const db = makeDb();
    await ingest(db, [ev({ pr_hash: "b1", gate_reasoncode_bucket: "duplicate_risk" }), ev({ pr_hash: "b2" })]);
    expect(await col(db, "b1", "gate_reasoncode_bucket")).toBe("duplicate_risk");
    expect(await col(db, "b2", "gate_reasoncode_bucket")).toBeNull();
  });

  it("clamps time_to_close_ms: valid kept; absent / <1s / >1y → null", async () => {
    const db = makeDb();
    await ingest(db, [
      ev({ pr_hash: "c1", time_to_close_ms: 7_200_000 }),
      ev({ pr_hash: "c2" }),
      ev({ pr_hash: "c3", time_to_close_ms: 500 }),
      ev({ pr_hash: "c4", time_to_close_ms: 40_000_000_000 }),
      ev({ pr_hash: "c5", time_to_close_ms: "nope" }),
    ]);
    expect(await col(db, "c1", "time_to_close_ms")).toBe(7_200_000);
    expect(await col(db, "c2", "time_to_close_ms")).toBeNull();
    expect(await col(db, "c3", "time_to_close_ms")).toBeNull();
    expect(await col(db, "c4", "time_to_close_ms")).toBeNull();
    expect(await col(db, "c5", "time_to_close_ms")).toBeNull();
  });

  it("stores decision_timestamp + outcome_timestamp (and mirrors outcome_timestamp to sent_at) — string vs null", async () => {
    const db = makeDb();
    await ingest(db, [
      ev({ pr_hash: "t1", decision_timestamp: "2026-01-01T00:00:00Z", outcome_timestamp: "2026-01-01T01:00:00Z" }),
      ev({ pr_hash: "t2" }),
    ]);
    expect(await col(db, "t1", "decision_timestamp")).toBe("2026-01-01T00:00:00Z");
    expect(await col(db, "t1", "outcome_timestamp")).toBe("2026-01-01T01:00:00Z");
    expect(await col(db, "t1", "sent_at")).toBe("2026-01-01T01:00:00Z");
    expect(await col(db, "t2", "decision_timestamp")).toBeNull();
    expect(await col(db, "t2", "sent_at")).toBeNull();
  });

  it("UPSERTs on (instance, repo_hash, pr_hash): a re-export updates the freshest outcome (e.g. a later reversal)", async () => {
    const db = makeDb();
    await ingest(db, [ev({ pr_hash: "u1", reversal_flag: "none" })]);
    expect(await col(db, "u1", "reversal_flag")).toBe("none");
    // same PR re-exported with a reversal now present
    const second = await ingest(db, [ev({ pr_hash: "u1", reversal_flag: "reverted" })]);
    expect(second).toEqual({ accepted: 1 }); // OR REPLACE counts as a write
    expect(await col(db, "u1", "reversal_flag")).toBe("reverted");
    const cnt = await (db as unknown as TestD1Database).prepare("SELECT COUNT(*) AS n FROM orb_signals WHERE pr_hash='u1'").first<{ n: number }>();
    expect(cnt?.n).toBe(1); // still one row (upsert, not duplicate)
  });

  it("different instances reviewing the same repo#pr do NOT collide", async () => {
    const db = makeDb();
    await ingest(db, [ev({ pr_hash: "same" })], "instA");
    await ingest(db, [ev({ pr_hash: "same" })], "instB");
    const cnt = await (db as unknown as TestD1Database).prepare("SELECT COUNT(*) AS n FROM orb_signals WHERE pr_hash='same'").first<{ n: number }>();
    expect(cnt?.n).toBe(2);
  });

  it("counts accepted vs skipped in one batch; caps at 500", async () => {
    const db = makeDb();
    expect(await ingest(db, [ev({ pr_hash: "ok" }), ev({ repo_hash: "" }), ev({ outcome: "x" })])).toEqual({ accepted: 1 });
    const many = Array.from({ length: 501 }, (_, i) => ev({ pr_hash: `m${i}` }));
    expect(await ingest(makeDb(), many)).toEqual({ accepted: 500 });
  });

  it("swallows a DB error (inner catch)", async () => {
    const brokenDb = { prepare: () => ({ bind: () => ({ run: () => Promise.reject(new Error("boom")) }) }) } as unknown as D1Database;
    expect(await ingest(brokenDb, [ev()])).toEqual({ accepted: 0 });
  });

  it("does not count a row when the write reports no change (changes === 0)", async () => {
    const db = { prepare: () => ({ bind: () => ({ run: () => Promise.resolve({ meta: { changes: 0 } }) }) }) } as unknown as D1Database;
    expect(await ingest(db, [ev()])).toEqual({ accepted: 0 });
  });

  it("records the instance on first contact (registered=0) and bumps last_seen on re-ingest", async () => {
    const db = makeDb();
    await ingest(db, [ev({ pr_hash: "i1" })], "instX");
    const row = await (db as unknown as TestD1Database)
      .prepare("SELECT registered, first_seen_at, last_seen_at FROM orb_instances WHERE instance_id=?")
      .bind("instX")
      .first<{ registered: number; first_seen_at: string; last_seen_at: string }>();
    expect(row?.registered).toBe(0); // not trusted until an operator registers it
    await ingest(db, [ev({ pr_hash: "i2" })], "instX"); // same instance again → still one row
    const cnt = await (db as unknown as TestD1Database).prepare("SELECT COUNT(*) AS n FROM orb_instances WHERE instance_id=?").bind("instX").first<{ n: number }>();
    expect(cnt?.n).toBe(1);
  });

  it("does not fail ingest if the instance bookkeeping upsert throws", async () => {
    // First prepare() (orb_instances upsert) rejects; ingest must still process the batch best-effort.
    let call = 0;
    const db = {
      prepare: (sql: string) => {
        call++;
        if (sql.includes("orb_instances")) return { bind: () => ({ run: () => Promise.reject(new Error("boom")) }) };
        return new TestD1Database().prepare(sql);
      },
    } as unknown as D1Database;
    expect(await ingest(db, [ev()])).toBeTruthy();
    expect(call).toBeGreaterThan(0);
  });
});

describe("readOrbIngestBody()", () => {
  const reqWithBody = (body: BodyInit, headers?: Record<string, string>) =>
    new Request("http://collector/v1/orb/ingest", { method: "POST", body, ...(headers ? { headers } : {}) });

  it("reads a normal body", async () => {
    expect(await readOrbIngestBody(reqWithBody("hello"), "5")).toBe("hello");
  });

  it("returns '' when there is no request body", async () => {
    expect(await readOrbIngestBody(new Request("http://collector", { method: "POST" }), null)).toBe("");
  });

  it("rejects (null) when the declared content-length exceeds the cap — without reading", async () => {
    expect(await readOrbIngestBody(reqWithBody("tiny"), String(MAX_ORB_INGEST_BODY_BYTES + 1))).toBeNull();
  });

  it("ignores a non-numeric content-length and reads normally", async () => {
    expect(await readOrbIngestBody(reqWithBody("ok"), "not-a-number")).toBe("ok");
  });

  it("rejects (null) when the streamed body exceeds the cap with no declared length", async () => {
    const big = new Uint8Array(MAX_ORB_INGEST_BODY_BYTES + 8);
    const stream = new ReadableStream<Uint8Array>({ start(ctrl) { ctrl.enqueue(big); ctrl.close(); } });
    const req = new Request("http://collector", { method: "POST", body: stream, ...({ duplex: "half" } as object) });
    expect(await readOrbIngestBody(req, null)).toBeNull();
  });
});

describe("POST /v1/orb/ingest route", () => {
  const app = createApp();

  it("returns 200 + accepted count for a valid batch", async () => {
    const env = createTestEnv();
    const body = JSON.stringify({ instance_id: "abc0", events: [{ repo_hash: "rhash", pr_hash: "phash", outcome: "merged", reversal_flag: "none" }] });
    const res = await app.request("/v1/orb/ingest", { method: "POST", headers: { "content-type": "application/json" }, body }, env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { accepted: number }).accepted).toBe(1);
  });

  it("returns 400 for invalid JSON", async () => {
    const res = await app.request("/v1/orb/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: "{bad" }, createTestEnv());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_json");
  });

  it("returns 400 for an empty body", async () => {
    const res = await app.request("/v1/orb/ingest", { method: "POST", body: "" }, createTestEnv());
    expect(res.status).toBe(400);
  });

  it("returns 413 when the body exceeds the ingest byte ceiling", async () => {
    const huge = "x".repeat(MAX_ORB_INGEST_BODY_BYTES + 16);
    const res = await app.request("/v1/orb/ingest", { method: "POST", body: huge }, createTestEnv());
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe("payload_too_large");
  });
});

describe("Orb instance registry routes (/v1/internal/orb/instances)", () => {
  const app = createApp();
  const auth = { authorization: "Bearer dev-internal-token" };
  const ingestOne = (env: Env, instance: string) =>
    app.request("/v1/orb/ingest", { method: "POST", body: JSON.stringify({ instance_id: instance, events: [{ repo_hash: "r", pr_hash: `${instance}-p`, outcome: "merged" }] }) }, env);

  it("lists ingested instances as unregistered with their stored-signal count", async () => {
    const env = createTestEnv();
    await ingestOne(env, "inst-a");
    const res = await app.request("/v1/internal/orb/instances", { headers: auth }, env);
    expect(res.status).toBe(200);
    const { instances } = (await res.json()) as { instances: Array<{ instanceId: string; registered: boolean; signalCount: number }> };
    expect(instances).toEqual([expect.objectContaining({ instanceId: "inst-a", registered: false, signalCount: 1 })]);
  });

  it("401 without the internal token", async () => {
    expect((await app.request("/v1/internal/orb/instances", {}, createTestEnv())).status).toBe(401);
  });

  it("registers an instance (and can unregister it)", async () => {
    const env = createTestEnv();
    await ingestOne(env, "inst-b");
    const reg = await app.request("/v1/internal/orb/instances/register", { method: "POST", headers: auth, body: JSON.stringify({ instanceId: "inst-b" }) }, env);
    expect(((await reg.json()) as { registered: boolean }).registered).toBe(true);
    const off = await app.request("/v1/internal/orb/instances/register", { method: "POST", headers: auth, body: JSON.stringify({ instanceId: "inst-b", registered: false }) }, env);
    expect(((await off.json()) as { registered: boolean }).registered).toBe(false);
  });

  it("registers an instance that has not ingested yet (upsert)", async () => {
    const env = createTestEnv();
    const reg = await app.request("/v1/internal/orb/instances/register", { method: "POST", headers: auth, body: JSON.stringify({ instanceId: "never-seen" }) }, env);
    expect(reg.status).toBe(200);
    const list = (await (await app.request("/v1/internal/orb/instances", { headers: auth }, env)).json()) as { instances: Array<{ instanceId: string; registered: boolean }> };
    expect(list.instances).toEqual([expect.objectContaining({ instanceId: "never-seen", registered: true })]);
  });

  it("400 when instanceId is missing", async () => {
    const res = await app.request("/v1/internal/orb/instances/register", { method: "POST", headers: auth, body: JSON.stringify({}) }, createTestEnv());
    expect(res.status).toBe(400);
  });

  it("400 on a non-JSON register body (json().catch → null)", async () => {
    const res = await app.request("/v1/internal/orb/instances/register", { method: "POST", headers: auth, body: "{bad" }, createTestEnv());
    expect(res.status).toBe(400);
  });

  it("tolerates a list query that omits results (rows.results ?? [])", async () => {
    const env = { ...createTestEnv(), DB: { prepare: () => ({ all: () => Promise.resolve({}) }) } } as unknown as Env;
    const res = await app.request("/v1/internal/orb/instances", { headers: auth }, env);
    expect(((await res.json()) as { instances: unknown[] }).instances).toEqual([]);
  });
});

describe("GET /v1/internal/fleet/analytics route", () => {
  const app = createApp();

  it("returns the fleet report, honoring ?days (bearer-gated)", async () => {
    const res = await app.request("/v1/internal/fleet/analytics?days=30", { headers: { authorization: "Bearer dev-internal-token" } }, createTestEnv());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { windowDays: number }).windowDays).toBe(30);
  });

  it("defaults the window when ?days is omitted", async () => {
    const res = await app.request("/v1/internal/fleet/analytics", { headers: { authorization: "Bearer dev-internal-token" } }, createTestEnv());
    expect(((await res.json()) as { windowDays: number }).windowDays).toBe(90);
  });

  it("401 without the internal token", async () => {
    const res = await app.request("/v1/internal/fleet/analytics", {}, createTestEnv());
    expect(res.status).toBe(401);
  });
});
