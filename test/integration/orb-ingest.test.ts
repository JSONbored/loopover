import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { handleOrbIngest } from "../../src/orb/ingest";
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
