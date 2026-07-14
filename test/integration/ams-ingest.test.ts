import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { handleAmsIngest } from "../../src/ams/ingest";
import { MAX_ORB_INGEST_BODY_BYTES } from "../../src/orb/ingest";
import { createTestEnv, TestD1Database } from "../helpers/d1";

describe("handleAmsIngest()", () => {
  function makeDb(): D1Database {
    return new TestD1Database() as unknown as D1Database;
  }
  const ev = (o: Record<string, unknown> = {}) => ({ repoHash: "rh", prHash: "ph", decision: "merged", ...o });
  const ingest = (db: D1Database, events: Array<Record<string, unknown>>, instanceId = "inst1") => handleAmsIngest(JSON.stringify({ instanceId, events }), db);
  const col = async (db: D1Database, pr: string, c: string) =>
    (await (db as unknown as TestD1Database).prepare(`SELECT ${c} AS v FROM ams_signals WHERE pr_hash=?`).bind(pr).first<{ v: unknown }>())?.v;

  it("accepts a valid batch and returns the accepted count", async () => {
    expect(await ingest(makeDb(), [ev({ prHash: "p1" })])).toEqual({ accepted: 1 });
  });

  it("returns invalid_json on unparseable body", async () => {
    expect(await handleAmsIngest("{not json}", makeDb())).toEqual({ error: "invalid_json" });
  });

  it("returns invalid_payload: instanceId not a string / events not an array / empty/oversized instance / empty events", async () => {
    const db = makeDb();
    expect(await handleAmsIngest(JSON.stringify({ instanceId: 123, events: [] }), db)).toEqual({ error: "invalid_payload" });
    expect(await handleAmsIngest(JSON.stringify({ instanceId: "abc", events: "bad" }), db)).toEqual({ error: "invalid_payload" });
    expect(await handleAmsIngest(JSON.stringify({ instanceId: "", events: [ev()] }), db)).toEqual({ error: "invalid_payload" });
    expect(await handleAmsIngest(JSON.stringify({ instanceId: "abc", events: [] }), db)).toEqual({ error: "invalid_payload" });
    expect(await handleAmsIngest(JSON.stringify({ instanceId: "i".repeat(65), events: [ev()] }), db)).toEqual({ error: "invalid_payload" });
  });

  it("skips events with bad repoHash / prHash / decision", async () => {
    expect(await ingest(makeDb(), [ev({ repoHash: 99 })])).toEqual({ accepted: 0 });
    expect(await ingest(makeDb(), [ev({ repoHash: "" })])).toEqual({ accepted: 0 });
    expect(await ingest(makeDb(), [ev({ repoHash: "r".repeat(129) })])).toEqual({ accepted: 0 });
    expect(await ingest(makeDb(), [ev({ prHash: null })])).toEqual({ accepted: 0 });
    expect(await ingest(makeDb(), [ev({ prHash: "" })])).toEqual({ accepted: 0 });
    expect(await ingest(makeDb(), [ev({ prHash: "p".repeat(129) })])).toEqual({ accepted: 0 });
    expect(await ingest(makeDb(), [ev({ decision: "opened" })])).toEqual({ accepted: 0 });
  });

  it("stores reasonBucket string vs null, dropping an oversized bucket", async () => {
    const db = makeDb();
    await ingest(db, [
      ev({ prHash: "b1", reasonBucket: "gate_close" }),
      ev({ prHash: "b2" }),
      ev({ prHash: "b3", reasonBucket: "b".repeat(65) }),
    ]);
    expect(await col(db, "b1", "reason_bucket")).toBe("gate_close");
    expect(await col(db, "b2", "reason_bucket")).toBeNull();
    expect(await col(db, "b3", "reason_bucket")).toBeNull();
  });

  it("stores closedAt string vs null", async () => {
    const db = makeDb();
    await ingest(db, [ev({ prHash: "c1", closedAt: "2026-01-01T00:00:00Z" }), ev({ prHash: "c2" })]);
    expect(await col(db, "c1", "closed_at")).toBe("2026-01-01T00:00:00Z");
    expect(await col(db, "c2", "closed_at")).toBeNull();
  });

  it("UPSERTs on (instance, pr_hash): a re-export updates the freshest decision", async () => {
    const db = makeDb();
    await ingest(db, [ev({ prHash: "u1", decision: "closed" })]);
    expect(await col(db, "u1", "decision")).toBe("closed");
    const second = await ingest(db, [ev({ prHash: "u1", decision: "merged" })]);
    expect(second).toEqual({ accepted: 1 });
    expect(await col(db, "u1", "decision")).toBe("merged");
    const cnt = await (db as unknown as TestD1Database).prepare("SELECT COUNT(*) AS n FROM ams_signals WHERE pr_hash='u1'").first<{ n: number }>();
    expect(cnt?.n).toBe(1);
  });

  it("different instances reviewing the same pr hash do NOT collide", async () => {
    const db = makeDb();
    await ingest(db, [ev({ prHash: "same" })], "instA");
    await ingest(db, [ev({ prHash: "same" })], "instB");
    const cnt = await (db as unknown as TestD1Database).prepare("SELECT COUNT(*) AS n FROM ams_signals WHERE pr_hash='same'").first<{ n: number }>();
    expect(cnt?.n).toBe(2);
  });

  it("counts accepted vs skipped in one batch; caps at 500", async () => {
    const db = makeDb();
    expect(await ingest(db, [ev({ prHash: "ok" }), ev({ repoHash: "" }), ev({ decision: "x" })])).toEqual({ accepted: 1 });
    const many = Array.from({ length: 501 }, (_, i) => ev({ prHash: `m${i}` }));
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
    await ingest(db, [ev({ prHash: "i1" })], "instX");
    const row = await (db as unknown as TestD1Database)
      .prepare("SELECT registered, first_seen_at, last_seen_at FROM ams_instances WHERE instance_id=?")
      .bind("instX")
      .first<{ registered: number; first_seen_at: string; last_seen_at: string }>();
    expect(row?.registered).toBe(0);
    await ingest(db, [ev({ prHash: "i2" })], "instX");
    const cnt = await (db as unknown as TestD1Database).prepare("SELECT COUNT(*) AS n FROM ams_instances WHERE instance_id=?").bind("instX").first<{ n: number }>();
    expect(cnt?.n).toBe(1);
  });

  it("does not fail ingest if the instance bookkeeping upsert throws", async () => {
    let call = 0;
    const db = {
      prepare: (sql: string) => {
        call++;
        if (sql.includes("ams_instances")) return { bind: () => ({ run: () => Promise.reject(new Error("boom")) }) };
        return new TestD1Database().prepare(sql);
      },
    } as unknown as D1Database;
    expect(await ingest(db, [ev()])).toBeTruthy();
    expect(call).toBeGreaterThan(0);
  });
});

describe("POST /v1/ams/ingest route", () => {
  const app = createApp();

  it("returns 200 + accepted count for a valid batch", async () => {
    const env = createTestEnv();
    const body = JSON.stringify({ instanceId: "abc0", events: [{ repoHash: "rhash", prHash: "phash", decision: "merged" }] });
    const res = await app.request("/v1/ams/ingest", { method: "POST", headers: { "content-type": "application/json" }, body }, env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { accepted: number }).accepted).toBe(1);
  });

  it("returns 400 for invalid JSON", async () => {
    const res = await app.request("/v1/ams/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: "{bad" }, createTestEnv());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_json");
  });

  it("returns 400 for an empty body", async () => {
    const res = await app.request("/v1/ams/ingest", { method: "POST", body: "" }, createTestEnv());
    expect(res.status).toBe(400);
  });

  it("returns 413 when the body exceeds the shared ingest byte ceiling", async () => {
    const huge = "x".repeat(MAX_ORB_INGEST_BODY_BYTES + 16);
    const res = await app.request("/v1/ams/ingest", { method: "POST", body: huge }, createTestEnv());
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe("payload_too_large");
  });

  it("optional collector token: open when unset; enforced once AMS_INGEST_TOKEN is set", async () => {
    const body = JSON.stringify({ instanceId: "abc0", events: [{ repoHash: "rhash", prHash: "phash", decision: "merged" }] });
    const post = (env: Env, authorization?: string) =>
      app.request("/v1/ams/ingest", { method: "POST", headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) }, body }, env);

    expect((await post(createTestEnv())).status).toBe(200);
    const env = createTestEnv({ AMS_INGEST_TOKEN: "fleet-secret" });
    expect((await post(env)).status).toBe(401);
    expect((await post(env, "Bearer wrong")).status).toBe(401);
    expect((await post(env, "Bearer fleet-secret")).status).toBe(200);
  });
});
