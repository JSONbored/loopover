import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import {
  GITTENSORY_NATIVE_SOURCE,
  computeParityReadiness,
  isParityAuditEnabled,
  nativeGateActionFromConclusion,
  recordNativeGateDecision,
} from "../../src/review/parity-wire";
import { createTestEnv } from "../helpers/d1";

// ── Direct D1 helpers over the real migrated schema (0049 review_audit) ──────────────────────────────────────

async function rawAll(env: Env, sql: string, ...binds: unknown[]): Promise<Record<string, unknown>[]> {
  const res = await (env.DB as unknown as { prepare: (s: string) => { bind: (...v: unknown[]) => { all: <T>() => Promise<{ results: T[] }> } } })
    .prepare(sql)
    .bind(...binds)
    .all<Record<string, unknown>>();
  return res.results;
}

// Seed an authoritative ('reviewbot') gate_decision row directly — this is what reviewbot's deploy-time dual-run
// writes; here we stand it in so a PAIR exists for the parity self-join.
async function seedReviewbotDecision(env: Env, project: string, pr: number, headSha: string, decision: string, summary: string): Promise<void> {
  await (env.DB as unknown as { prepare: (s: string) => { bind: (...v: unknown[]) => { run: () => Promise<unknown> } } })
    .prepare(
      `INSERT INTO review_audit (id, project, target_id, event_type, decision, source, head_sha, summary, created_at)
       VALUES (?, ?, ?, 'gate_decision', ?, 'reviewbot', ?, ?, CURRENT_TIMESTAMP)`,
    )
    .bind(`gate:reviewbot:${project}#${pr}@${headSha}`, project, `${project}#${pr}`, decision, headSha, summary)
    .run();
}

// ── isParityAuditEnabled — default OFF, truthy convention ────────────────────────────────────────────────────

describe("isParityAuditEnabled — default OFF, truthy convention", () => {
  it("is OFF for unset / false / empty, ON for 1/true/yes/on", () => {
    for (const off of [undefined, "", "false", "no", "0", "off"]) expect(isParityAuditEnabled({ REVIEWBOT_PARITY_AUDIT: off })).toBe(false);
    for (const on of ["1", "true", "yes", "on", "TRUE", "On"]) expect(isParityAuditEnabled({ REVIEWBOT_PARITY_AUDIT: on })).toBe(true);
  });
});

// ── nativeGateActionFromConclusion — gittensory conclusion → comparable GateAction (pure) ────────────────────

describe("nativeGateActionFromConclusion — gittensory gate conclusion → parity GateAction", () => {
  it("maps success → merge, failure/action_required → hold (gittensory never closes), neutral/skipped → null", () => {
    expect(nativeGateActionFromConclusion("success")).toBe("merge");
    expect(nativeGateActionFromConclusion("failure")).toBe("hold");
    expect(nativeGateActionFromConclusion("action_required")).toBe("hold");
    expect(nativeGateActionFromConclusion("neutral")).toBeNull();
    expect(nativeGateActionFromConclusion("skipped")).toBeNull();
  });
});

// ── Migration 0049 round-trip + flag-gated recording ─────────────────────────────────────────────────────────

describe("recordNativeGateDecision — flag-gated SHADOW recording into review_audit (0049 round-trip)", () => {
  it("flag-ON records ONE gittensory-native gate_decision row (migration applies; round-trips via TestD1Database)", async () => {
    const env = createTestEnv({ REVIEWBOT_PARITY_AUDIT: "true" });
    await recordNativeGateDecision(env, { project: "owner/repo", pullNumber: 7, headSha: "abc123", conclusion: "success", reasonCode: "all_clear" });

    const rows = await rawAll(env, "SELECT * FROM review_audit");
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      project: "owner/repo",
      target_id: "owner/repo#7",
      event_type: "gate_decision",
      decision: "merge", // success → merge
      source: GITTENSORY_NATIVE_SOURCE,
      head_sha: "abc123",
      summary: "all_clear",
    });
    expect(typeof rows[0]!.created_at).toBe("string");
  });

  it("a re-run at the SAME commit REPLACES the prior decision (latest finalize wins, no duplicate)", async () => {
    const env = createTestEnv({ REVIEWBOT_PARITY_AUDIT: "true" });
    await recordNativeGateDecision(env, { project: "owner/repo", pullNumber: 7, headSha: "abc123", conclusion: "success", reasonCode: "all_clear" });
    await recordNativeGateDecision(env, { project: "owner/repo", pullNumber: 7, headSha: "abc123", conclusion: "failure", reasonCode: "slop_risk" });

    const rows = await rawAll(env, "SELECT * FROM review_audit");
    expect(rows.length).toBe(1); // same (source, project, pr, sha) → one row
    expect(rows[0]).toMatchObject({ decision: "hold", summary: "slop_risk" }); // failure → hold, latest wins
  });

  it("a new commit gets its OWN row", async () => {
    const env = createTestEnv({ REVIEWBOT_PARITY_AUDIT: "true" });
    await recordNativeGateDecision(env, { project: "owner/repo", pullNumber: 7, headSha: "sha1", conclusion: "success" });
    await recordNativeGateDecision(env, { project: "owner/repo", pullNumber: 7, headSha: "sha2", conclusion: "failure" });
    expect((await rawAll(env, "SELECT * FROM review_audit")).length).toBe(2);
  });

  it("does NOT record a non-comparable conclusion (neutral/skipped) or a decision with no head_sha", async () => {
    const env = createTestEnv({ REVIEWBOT_PARITY_AUDIT: "true" });
    await recordNativeGateDecision(env, { project: "owner/repo", pullNumber: 1, headSha: "sha", conclusion: "neutral" });
    await recordNativeGateDecision(env, { project: "owner/repo", pullNumber: 2, headSha: "sha", conclusion: "skipped" });
    await recordNativeGateDecision(env, { project: "owner/repo", pullNumber: 3, headSha: null, conclusion: "success" });
    expect((await rawAll(env, "SELECT * FROM review_audit")).length).toBe(0);
  });

  it("flag-OFF records NOTHING — no D1 write (byte-identical review path)", async () => {
    const env = createTestEnv(); // flag unset → OFF
    await recordNativeGateDecision(env, { project: "owner/repo", pullNumber: 7, headSha: "abc123", conclusion: "success", reasonCode: "all_clear" });
    expect((await rawAll(env, "SELECT * FROM review_audit")).length).toBe(0);
    // ...and explicitly false-valued flags are OFF too.
    const envFalse = createTestEnv({ REVIEWBOT_PARITY_AUDIT: "false" });
    await recordNativeGateDecision(envFalse, { project: "owner/repo", pullNumber: 7, headSha: "abc123", conclusion: "failure" });
    expect((await rawAll(envFalse, "SELECT * FROM review_audit")).length).toBe(0);
  });

  it("fails safe: a D1 write error is swallowed + logged (telemetry never breaks finalization)", async () => {
    const env = createTestEnv({ REVIEWBOT_PARITY_AUDIT: "true" });
    // Poison the audit INSERT so .run() rejects → the catch logs parity_audit_record_error and resolves.
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (/review_audit/i.test(sql)) throw new Error("poisoned write");
      return realPrepare(sql);
    }) as typeof env.DB.prepare;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      recordNativeGateDecision(env, { project: "owner/repo", pullNumber: 7, headSha: "abc123", conclusion: "failure", reasonCode: "slop_risk" }),
    ).resolves.toBeUndefined();

    expect(warn.mock.calls.map((c) => String(c[0])).some((line) => line.includes("parity_audit_record_error"))).toBe(true);
    warn.mockRestore();
  });
});

// ── computeParityReadiness — parity rate + cutover-readiness over the recorded data ──────────────────────────

describe("computeParityReadiness — runs computeGateParity / isParityCutoverReady over review_audit", () => {
  it("with ONLY gittensory-native rows (no reviewbot dual-run) there are no PAIRS → empty, no signal", async () => {
    const env = createTestEnv({ REVIEWBOT_PARITY_AUDIT: "true" });
    for (let i = 1; i <= 40; i += 1) {
      await recordNativeGateDecision(env, { project: "owner/repo", pullNumber: i, headSha: `sha${i}`, conclusion: "success" });
    }
    const report = await computeParityReadiness(env, { nowMs: Date.now() });
    expect(report.shadow).toBe(GITTENSORY_NATIVE_SOURCE);
    expect(report.authoritative).toBe("reviewbot");
    expect(report.rows).toEqual([]); // nothing to pair against → no rows
    expect(report.hasSignal).toBe(false);
  });

  it("PERFECT agreement over >= 30 paired commits → cutoverReady true, zero unsafe disagreements", async () => {
    const env = createTestEnv({ REVIEWBOT_PARITY_AUDIT: "true" });
    const nowMs = Date.now();
    for (let i = 1; i <= 35; i += 1) {
      const sha = `sha${i}`;
      // Both systems agree: even PRs both merge, odd PRs both hold.
      const conclusion = i % 2 === 0 ? "success" : "failure";
      const action = i % 2 === 0 ? "merge" : "hold";
      await seedReviewbotDecision(env, "owner/repo", i, sha, action, "slop_risk");
      await recordNativeGateDecision(env, { project: "owner/repo", pullNumber: i, headSha: sha, conclusion });
    }
    const report = await computeParityReadiness(env, { nowMs });
    const row = report.rows.find((r) => r.project === "owner/repo");
    expect(row).toBeDefined();
    expect(row!.pairedSamples).toBe(35);
    expect(row!.disagree).toBe(0);
    expect(row!.unsafeDisagreements).toBe(0);
    expect(row!.agreementRate).toBe(1);
    expect(row!.cutoverReady).toBe(true);
    expect(report.hasSignal).toBe(true);
  });

  it("an UNSAFE disagreement (shadow merges where reviewbot holds) blocks cutover even at high agreement", async () => {
    const env = createTestEnv({ REVIEWBOT_PARITY_AUDIT: "true" });
    const nowMs = Date.now();
    for (let i = 1; i <= 35; i += 1) {
      const sha = `sha${i}`;
      // PR 1: reviewbot HOLDS but the shadow MERGES → the dangerous direction. Every other PR: both merge.
      await seedReviewbotDecision(env, "owner/repo", i, sha, i === 1 ? "hold" : "merge", "slop_risk");
      await recordNativeGateDecision(env, { project: "owner/repo", pullNumber: i, headSha: sha, conclusion: "success" });
    }
    const report = await computeParityReadiness(env, { nowMs });
    const row = report.rows.find((r) => r.project === "owner/repo")!;
    expect(row.unsafeDisagreements).toBe(1);
    expect(row.cutoverReady).toBe(false); // any unsafe disagreement is a hard block
  });
});

// ── GET /v1/internal/parity — bearer-gated, flag-gated endpoint ──────────────────────────────────────────────

describe("GET /v1/internal/parity — bearer-gated, flag-gated endpoint", () => {
  const bearer = (env: Env) => ({ authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}` });

  it("401s without the internal token (the /v1/internal/* middleware gate)", async () => {
    const app = createApp();
    const env = createTestEnv({ REVIEWBOT_PARITY_AUDIT: "true" });
    expect((await app.request("/v1/internal/parity", {}, env)).status).toBe(401);
    expect((await app.request("/v1/internal/parity", { headers: { authorization: "Bearer nope" } }, env)).status).toBe(401);
  });

  it("404s when REVIEWBOT_PARITY_AUDIT is OFF — the endpoint does not exist (byte-identical to today)", async () => {
    const app = createApp();
    const env = createTestEnv(); // flag unset → OFF
    const res = await app.request("/v1/internal/parity", { headers: bearer(env) }, env);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("not_found");
  });

  it("200s with the parity readiness report when ON and authorized", async () => {
    const app = createApp();
    const env = createTestEnv({ REVIEWBOT_PARITY_AUDIT: "true" });
    for (let i = 1; i <= 35; i += 1) {
      const sha = `sha${i}`;
      await seedReviewbotDecision(env, "owner/repo", i, sha, "merge", "slop_risk");
      await recordNativeGateDecision(env, { project: "owner/repo", pullNumber: i, headSha: sha, conclusion: "success" });
    }
    const res = await app.request("/v1/internal/parity", { headers: bearer(env) }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authoritative: string; shadow: string; hasSignal: boolean; rows: Array<{ project: string; pairedSamples: number; cutoverReady: boolean }> };
    expect(body.authoritative).toBe("reviewbot");
    expect(body.shadow).toBe(GITTENSORY_NATIVE_SOURCE);
    const row = body.rows.find((r) => r.project === "owner/repo");
    expect(row?.pairedSamples).toBe(35);
    expect(row?.cutoverReady).toBe(true);
    // Privacy: aggregate only — never actor logins / trust internals.
    expect(JSON.stringify(body)).not.toMatch(/login|actor|reward|payout|trust|wallet|hotkey/i);
  });
});
