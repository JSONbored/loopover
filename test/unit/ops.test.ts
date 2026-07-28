import { describe, expect, it, vi } from "vitest";
import {
  buildCalibrationBins,
  checkReviewSourceFreshness,
  computeAgentHealth,
  computeCalibration,
  defaultOpsHealthDeps,
  handleInternalCalibration,
  handleInternalDecision,
  handleInternalStatus,
  type OpsAgentConfig,
} from "../../src/review/ops";
import { clearProcessLocalGlobalAgentFrozenCacheForTest, setGlobalAgentFrozen } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

describe("defaultOpsHealthDeps.isFrozen — DB-backed global freeze (#audit-§5.2)", () => {
  it("reports the live DB freeze state and fails open on a read error", async () => {
    clearProcessLocalGlobalAgentFrozenCacheForTest();
    const env = createTestEnv();
    expect(await defaultOpsHealthDeps.isFrozen(env, "owner/repo")).toBe(false); // default singleton frozen=0
    await setGlobalAgentFrozen(env, true);
    expect(await defaultOpsHealthDeps.isFrozen(env, "owner/repo")).toBe(true);
    const broken = { ...env, DB: null } as unknown as Env;
    expect(await defaultOpsHealthDeps.isFrozen(broken, "owner/repo")).toBe(true); // sticky fail-closed after freeze
  });

  it("warns (but still fails open) on a read error and on an absent singleton row (#2125)", async () => {
    clearProcessLocalGlobalAgentFrozenCacheForTest();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const env = createTestEnv();
    const broken = { ...env, DB: null } as unknown as Env;
    expect(await defaultOpsHealthDeps.isFrozen(broken, "owner/repo")).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("global_kill_switch_read_error"));
    warn.mockClear();

    await env.DB.prepare("DELETE FROM global_agent_controls WHERE id = 'singleton'").run();
    expect(await defaultOpsHealthDeps.isFrozen(env, "owner/repo")).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("global_kill_switch_row_missing"));
    warn.mockRestore();
  });

  it("formats a non-Error throw (e.g. a driver rejecting with a plain string) without crashing", async () => {
    clearProcessLocalGlobalAgentFrozenCacheForTest();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const thrown: Env = {
      DB: {
        prepare: () => {
          throw "driver exploded"; // eslint-disable-line no-throw-literal -- exercising the non-Error catch arm
        },
      } as unknown as Env["DB"],
    } as unknown as Env;
    expect(await defaultOpsHealthDeps.isFrozen(thrown, "owner/repo")).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("driver exploded"));
    warn.mockRestore();
  });
});

// ── computeCalibration (ported from reviewbot test/calibration.test.ts) ──────────────────────────

/**
 * #9136: reads are sourced from decision_records + review_audit now, not the orphaned review_targets.
 *
 * The old stub keyed on `FROM review_targets` and handed BOTH queries the same bare ids ("a"/"b"/"c"), which
 * quietly made the two id namespaces agree — so these tests passed for as long as production was broken by
 * exactly that disagreement. Ids here are the real `owner/repo#n` target keys both live tables actually use,
 * so a namespace regression fails the test instead of hiding in it.
 *
 * Also note the calibration queries are a mix of bound (`.bind(slug).all()`) and unbound (`.all()`) calls —
 * decision_records carries no `project` column — so the stub supports both shapes.
 */
function calibrationEnv(merged: Array<{ id: string; confidence: number }>, revertedIds: string[]): Env {
  const results = (sql: string): { results: unknown[] } => {
    if (sql.includes("FROM decision_records") && sql.includes("'merge'")) {
      return { results: merged.map((m) => ({ target_id: m.id, decision_json: JSON.stringify({ action: "merge", aiConfidence: m.confidence }) })) };
    }
    if (sql.includes("FROM review_audit") && sql.includes("reversal_reverted")) {
      return { results: revertedIds.map((target_id) => ({ target_id })) };
    }
    return { results: [] }; // closes-by-reason and disputed-closes: not under test here
  };
  return {
    DB: {
      prepare(sql: string) {
        const all = async () => results(sql);
        return { all, bind: () => ({ all }) };
      },
    },
  } as unknown as Env;
}

const calConfig: OpsAgentConfig = { slug: "metagraphed", confidenceFloor: 0.9, secrets: {} };

describe("computeCalibration", () => {
  it("recommends raising the floor above the highest-confidence reverted merge", async () => {
    const env = calibrationEnv([{ id: "o/r#1", confidence: 0.95 }, { id: "o/r#2", confidence: 0.92 }, { id: "o/r#3", confidence: 0.99 }], ["o/r#2"]);
    const cal = await computeCalibration(env, calConfig);
    expect(cal.revertedCount).toBe(1);
    expect(cal.revertedMaxConfidence).toBe(0.92);
    expect(cal.recommendedFloor).toBe(0.94); // 0.92 + 0.02
    expect(cal.bins.find((bin) => bin.label === "90–100%")).toMatchObject({
      sampleSize: 3,
      keptCount: 2,
      revertedCount: 1,
      keptRate: expect.closeTo(2 / 3, 3),
    });
  });

  it("recommends no change when nothing was reverted", async () => {
    const env = calibrationEnv([{ id: "o/r#1", confidence: 0.95 }], []);
    const cal = await computeCalibration(env, calConfig);
    expect(cal.recommendedFloor).toBeNull();
    expect(cal.note).toMatch(/adequate/);
  });

  it("recommends no change when the floor already sits above the reverted merges", async () => {
    const env = calibrationEnv([{ id: "o/r#1", confidence: 0.85 }], ["o/r#1"]); // reverted at 0.85, floor 0.9 already higher
    const cal = await computeCalibration(env, calConfig);
    expect(cal.recommendedFloor).toBeNull();
  });

  it("treats a missing confidenceFloor as 0 (config.confidenceFloor ?? 0)", async () => {
    const env = calibrationEnv([{ id: "o/r#1", confidence: 0.5 }], ["o/r#1"]); // reverted at 0.5 → suggest 0.52 > floor 0
    const cal = await computeCalibration(env, { slug: "x", secrets: {} }); // no confidenceFloor
    expect(cal.currentFloor).toBe(0);
    expect(cal.recommendedFloor).toBe(0.52);
  });
});

describe("buildCalibrationBins", () => {
  it("returns five empty bins when there are no confidence samples", () => {
    expect(buildCalibrationBins([])).toEqual([
      { label: "50–60%", minConfidence: 0.5, maxConfidence: 0.6, sampleSize: 0, keptCount: 0, revertedCount: 0, keptRate: null },
      { label: "60–70%", minConfidence: 0.6, maxConfidence: 0.7, sampleSize: 0, keptCount: 0, revertedCount: 0, keptRate: null },
      { label: "70–80%", minConfidence: 0.7, maxConfidence: 0.8, sampleSize: 0, keptCount: 0, revertedCount: 0, keptRate: null },
      { label: "80–90%", minConfidence: 0.8, maxConfidence: 0.9, sampleSize: 0, keptCount: 0, revertedCount: 0, keptRate: null },
      { label: "90–100%", minConfidence: 0.9, maxConfidence: 1, sampleSize: 0, keptCount: 0, revertedCount: 0, keptRate: null },
    ]);
  });

  it("folds a single sample into one populated bin", () => {
    expect(buildCalibrationBins([{ confidence: 0.95, kept: true }])).toEqual(
      expect.arrayContaining([
        { label: "90–100%", minConfidence: 0.9, maxConfidence: 1, sampleSize: 1, keptCount: 1, revertedCount: 0, keptRate: 1 },
      ]),
    );
  });

  it("builds a full kept-rate curve across multiple confidence bands", () => {
    const bins = buildCalibrationBins([
      { confidence: 0.75, kept: true },
      { confidence: 0.85, kept: true },
      { confidence: 0.85, kept: false },
      { confidence: 0.95, kept: true },
      { confidence: 0.95, kept: false },
    ]);
    expect(bins.find((bin) => bin.label === "70–80%")).toMatchObject({ sampleSize: 1, keptRate: 1 });
    expect(bins.find((bin) => bin.label === "80–90%")).toMatchObject({ sampleSize: 2, keptRate: 0.5 });
    expect(bins.find((bin) => bin.label === "90–100%")).toMatchObject({ sampleSize: 2, keptRate: 0.5 });
  });
});

describe("handleInternalCalibration", () => {
  const cfg: OpsAgentConfig = { slug: "metagraphed", confidenceFloor: 0.9, secrets: { internalSecret: "INTERNAL_SECRET" } };
  const env = (extra: Record<string, unknown>) => ({ ...calibrationEnv([], []), ...extra }) as unknown as Env;

  it("404 when no internalSecret is configured", async () => {
    const r = await handleInternalCalibration(new Request("https://x/c"), env({}), { slug: "x", secrets: {} });
    expect(r.status).toBe(404);
  });
  it("401 on a bad bearer", async () => {
    const r = await handleInternalCalibration(new Request("https://x/c", { headers: { authorization: "Bearer nope" } }), env({ INTERNAL_SECRET: "s3cret" }), cfg);
    expect(r.status).toBe(401);
  });
  it("401 when the configured secret env var is not a string (readSecret `?? \"\"`)", async () => {
    // INTERNAL_SECRET is a number → readSecret returns "" → `!expected` → 401
    const r = await handleInternalCalibration(new Request("https://x/c", { headers: { authorization: "Bearer s3cret" } }), env({ INTERNAL_SECRET: 12345 }), cfg);
    expect(r.status).toBe(401);
  });
  it("200 + calibration for the correct token", async () => {
    const r = await handleInternalCalibration(new Request("https://x/c", { headers: { authorization: "Bearer s3cret" } }), env({ INTERNAL_SECRET: "s3cret" }), cfg);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { calibration: { currentFloor: number } };
    expect(body.calibration.currentFloor).toBe(0.9);
  });
});

// ── handleInternalDecision (ported from reviewbot test/decision-endpoint.test.ts) ────────────────

/**
 * #9136: the endpoint reads pull_requests (realized state) + decision_records (the standing decision) +
 * review_audit (the trail), not the orphaned review_targets. `prRow` null models "no such PR" — which, before
 * this fix, was the answer for EVERY pull request opened since the 2026-06-22 cutover.
 */
function decisionEnv(prRow: Record<string, unknown> | null, recordRow: Record<string, unknown> | null = null, auditRows?: unknown[]): Env {
  return {
    INTERNAL_SECRET: "s3cret",
    DB: {
      prepare(sql: string) {
        return {
          bind() {
            return {
              first: async () => (sql.includes("FROM pull_requests") ? prRow : sql.includes("FROM decision_records") ? recordRow : null),
              all: async () => ({
                results: sql.includes("review_audit")
                  ? (auditRows ?? [{ event_type: "reviewed", decision: "manual", summary: "needs human", created_at: "2026-06-13T00:00:00Z" }])
                  : [],
              }),
            };
          },
        };
      },
    },
  } as unknown as Env;
}

/** A merged PR row in the live pull_requests shape. */
function livePr(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { repo_full_name: "o/r", number: 5, state: "open", head_sha: "head1", merged_at: null, merge_attempt_count: 1, ...over };
}

const decisionConfig: OpsAgentConfig = { slug: "metagraphed", secrets: { internalSecret: "INTERNAL_SECRET" } };
const auth = { authorization: "Bearer s3cret" };
const url = "https://x/metagraphed/internal/decision?repo=o/r&number=5";

describe("handleInternalDecision", () => {
  it("404 when no internalSecret is configured", async () => {
    const cfg: OpsAgentConfig = { slug: "x", secrets: {} };
    const r = await handleInternalDecision(new Request(url), decisionEnv(null), cfg);
    expect(r.status).toBe(404);
  });

  it("401 on a bad bearer", async () => {
    const r = await handleInternalDecision(new Request(url, { headers: { authorization: "Bearer nope" } }), decisionEnv(null), decisionConfig);
    expect(r.status).toBe(401);
  });

  it("400 when repo/number are missing or malformed", async () => {
    const r = await handleInternalDecision(new Request("https://x/metagraphed/internal/decision?repo=bad", { headers: auth }), decisionEnv(null), decisionConfig);
    expect(r.status).toBe(400);
  });

  it("400 (and exercises the no-repo-param `?? \"\"` fallback) when repo is absent", async () => {
    const r = await handleInternalDecision(new Request("https://x/metagraphed/internal/decision?number=5", { headers: auth }), decisionEnv(null), decisionConfig);
    expect(r.status).toBe(400);
  });

  it("401 when no authorization header is sent (header `?? \"\"` fallback)", async () => {
    const r = await handleInternalDecision(new Request(url), decisionEnv(null), decisionConfig); // no headers
    expect(r.status).toBe(401);
  });

  it("404 when the target doesn't exist", async () => {
    const r = await handleInternalDecision(new Request(url, { headers: auth }), decisionEnv(null), decisionConfig);
    expect(r.status).toBe(404);
  });

  it("REGRESSION (#9136): returns the standing decision + audit trail for a live PR, which used to 404", async () => {
    // Every PR since the 2026-06-22 cutover hit the `!target` 404 above, because the only lookup was against
    // a table nothing writes. The endpoint stayed routed and authenticated the whole time.
    const record = { head_sha: "abc", action: "hold", reason_code: "ownership_sensitive", record_json: JSON.stringify({ action: "hold", aiConfidence: 0.4 }), created_at: "2026-06-13T00:00:00Z" };
    const r = await handleInternalDecision(new Request(url, { headers: auth }), decisionEnv(livePr(), record), decisionConfig);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { target: { status: string; attemptCount: number; verdict: string; decidedSha: string; reasonCode: string; terminalAt: string | null }; decision: { action: string }; audit: unknown[] };
    expect(body.target.status).toBe("open");
    expect(body.target.attemptCount).toBe(1);
    expect(body.target.verdict).toBe("hold");
    expect(body.target.decidedSha).toBe("abc"); // the sha the standing decision was actually made on
    expect(body.target.reasonCode).toBe("ownership_sensitive");
    expect(body.target.terminalAt).toBeNull(); // a hold is not terminal
    expect(body.decision.action).toBe("hold");
    expect(body.audit).toHaveLength(1);
  });

  it("reports the realized disposition: merged wins over state, and a close is terminal at its decision", async () => {
    const merged = await handleInternalDecision(new Request(url, { headers: auth }), decisionEnv(livePr({ state: "closed", merged_at: "2026-06-14T00:00:00Z" })), decisionConfig);
    expect((await merged.json() as { target: { status: string; terminalAt: string } }).target).toMatchObject({ status: "merged", terminalAt: "2026-06-14T00:00:00Z" });

    const closeRecord = { head_sha: "abc", action: "close", reason_code: "duplicate", record_json: null, created_at: "2026-06-15T00:00:00Z" };
    const closed = await handleInternalDecision(new Request(url, { headers: auth }), decisionEnv(livePr({ state: "closed" }), closeRecord), decisionConfig);
    expect((await closed.json() as { target: { status: string; terminalAt: string } }).target).toMatchObject({ status: "closed", terminalAt: "2026-06-15T00:00:00Z" });
  });

  it("a PR with no decision record yet reports nulls rather than failing", async () => {
    const r = await handleInternalDecision(new Request(url, { headers: auth }), decisionEnv(livePr()), decisionConfig);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { target: { verdict: null; decidedSha: null; reasonCode: null }; decision: null };
    expect(body.target).toMatchObject({ verdict: null, decidedSha: null, reasonCode: null });
    expect(body.decision).toBeNull();
  });
});

// ── computeAgentHealth + handleInternalStatus (native D1 + injected gate deps) ────────────────────

function healthEnv(): Env {
  return {
    INTERNAL_SECRET: "s3cret",
    DB: {
      prepare(sql: string) {
        return {
          bind() {
            return {
              first: async () => {
                // #9136: recentAutoActions repointed onto review_audit's own gate_decision rows.
                if (sql.includes("event_type = 'gate_decision'") && sql.includes("decision IN ('merge', 'close')")) return { n: 2 };
                if (sql.includes("event_type = 'dead_lettered'") && sql.includes("COUNT(*)")) return { n: 0 };
                return { n: 0 };
              },
              all: async () => {
                // #9136: byStatus/byVerdict -> byDecision, from review_audit's own gate_decision rows.
                if (sql.includes("GROUP BY decision")) return { results: [{ decision: "merge", n: 8 }, { decision: "close", n: 2 }, { decision: "hold", n: 1 }] };
                // #9136: repo/number parsed from target_id (owner/repo#n), no review_targets join.
                if (sql.includes("reversal_reverted")) return { results: [{ target_id: "o/r#99", event_type: "reversal_reverted" }] };
                if (sql.includes("event_type IN ('reviewed', 'shadow_reviewed')")) return { results: [{ target_id: "t1", decision: "merge", summary: "ok", created_at: "2026-06-13T00:00:00Z" }] };
                return { results: [] };
              },
            };
          },
        };
      },
    },
  } as unknown as Env;
}

const healthConfig: OpsAgentConfig = { slug: "loopover", confidenceFloor: 0.9, secrets: { internalSecret: "INTERNAL_SECRET" } };

describe("computeAgentHealth (native D1, default gate deps)", () => {
  it("computes terminal/manual-rate/reversals from the ledger; defaults to no config issues / unfrozen", async () => {
    const h = await computeAgentHealth(healthEnv(), healthConfig);
    expect(h.byDecision.merge).toBe(8);
    expect(h.nonTerminal).toBe(1); // hold — the gate deferring to a human
    expect(h.terminalCount).toBe(10); // merge 8 + close 2 — the gate acting
    // #9136: hold / ALL decisions (11), not the old hold / terminalCount, whose denominator excluded the
    // very rows it was counting.
    expect(h.manualRate).toBe(0.091);
    expect(h.reversals).toBe(1);
    expect(h.reversalRate).toBe(0.5); // 1 reversal / 2 recent auto-actions
    expect(h.recentAutoActions).toBe(2);
    expect(h.configIssues).toEqual([]);
    expect(h.frozen).toBe(false);
    expect(h.holdOnly).toBe(false);
  });

  it("threads injected gate deps (config invariants + kill-switch + circuit-breaker)", async () => {
    const h = await computeAgentHealth(healthEnv(), healthConfig, {
      validateAgentConfig: () => ["bad slug"],
      isFrozen: async () => true,
      isHoldOnly: async () => true,
    });
    expect(h.configIssues).toEqual(["bad slug"]);
    expect(h.frozen).toBe(true);
    expect(h.holdOnly).toBe(true);
  });
});

describe("handleInternalStatus", () => {
  it("401 on a bad bearer", async () => {
    const r = await handleInternalStatus(new Request("https://x/s", { headers: { authorization: "Bearer nope" } }), healthEnv(), healthConfig);
    expect(r.status).toBe(401);
  });
  it("200 + health snapshot for the correct token, folding the injected AI-error count", async () => {
    const r = await handleInternalStatus(new Request("https://x/s", { headers: auth }), healthEnv(), healthConfig, {
      validateAgentConfig: () => [],
      isFrozen: async () => false,
      isHoldOnly: async () => false,
      recentAiErrorCount: async () => 4,
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { health: { manualRate: number; aiErrors: number }; recent: unknown[] };
    expect(body.health.manualRate).toBe(0.091); // hold 1 / all 11 decisions (#9136)
    expect(body.health.aiErrors).toBe(4);
    expect(body.recent).toHaveLength(1);
  });
  it("defaults frozen/holdOnly to false in the response when the gate deps resolve undefined", async () => {
    // health.frozen / health.holdOnly come back undefined → the `?? false` fallbacks (lines 350-351)
    const r = await handleInternalStatus(new Request("https://x/s", { headers: auth }), healthEnv(), healthConfig, {
      validateAgentConfig: () => [],
      isFrozen: async () => undefined as unknown as boolean,
      isHoldOnly: async () => undefined as unknown as boolean,
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { health: { frozen: boolean; holdOnly: boolean } };
    expect(body.health.frozen).toBe(false);
    expect(body.health.holdOnly).toBe(false);
  });

  it("defaults the AI-error count to 0 and recent[] to empty when deps/rows are absent", async () => {
    // env whose DB returns undefined `results` everywhere (exercises the `?? []` / `?? 0` fallbacks)
    const emptyEnv = {
      INTERNAL_SECRET: "s3cret",
      DB: {
        prepare() {
          return { bind() { return { first: async () => undefined, all: async () => ({}) }; } };
        },
      },
    } as unknown as Env;
    const r = await handleInternalStatus(new Request("https://x/s", { headers: auth }), emptyEnv, healthConfig);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { health: { aiErrors: number; manualRate: number; reversalRate: number; frozen: boolean; holdOnly: boolean }; counts: { byDecision: Record<string, number> }; recent: unknown[] };
    expect(body.health.aiErrors).toBe(0); // defaultRecentAiErrorCount
    expect(body.health.manualRate).toBe(0); // terminalCount 0 → ternary false branch
    expect(body.health.reversalRate).toBe(0); // recentAutoActions 0 → ternary false branch
    expect(body.health.frozen).toBe(false); // health.frozen ?? false (undefined → false not exercised, but default deps give false)
    expect(body.counts.byDecision).toEqual({});
    expect(body.recent).toEqual([]);
  });
});

// ── timingSafeEqual: native crypto.subtle.timingSafeEqual fast-path (line 99) ─────────────────────

describe("requireInternalAuth via native crypto.subtle.timingSafeEqual", () => {
  it("uses the runtime's timingSafeEqual when present (equal-length, matching token)", async () => {
    const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (a: Uint8Array, b: Uint8Array) => boolean };
    const had = "timingSafeEqual" in subtle;
    const calls: number[] = [];
    // Inject a native-style timingSafeEqual that does a real byte compare so the gate still works.
    (subtle as { timingSafeEqual?: (a: Uint8Array, b: Uint8Array) => boolean }).timingSafeEqual = (a, b) => {
      calls.push(1);
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
      return true;
    };
    try {
      const r = await handleInternalCalibration(
        new Request("https://x/c", { headers: { authorization: "Bearer s3cret" } }),
        { ...calibrationEnv([], []), INTERNAL_SECRET: "s3cret" } as unknown as Env,
        { slug: "metagraphed", confidenceFloor: 0.9, secrets: { internalSecret: "INTERNAL_SECRET" } },
      );
      expect(r.status).toBe(200); // matched via the native path
      expect(calls.length).toBeGreaterThan(0);
    } finally {
      if (!had) delete (subtle as { timingSafeEqual?: unknown }).timingSafeEqual;
    }
  });

  it("compares unequal-length tokens byte-wise via the fallback (left shorter → leftBytes[i] ?? 0)", async () => {
    // provided "Bearer s3cre" (12) is SHORTER than expected "Bearer s3cret" (13): the loop reads
    // leftBytes past its end → the `?? 0` fallback on the left operand (line 104).
    const r = await handleInternalCalibration(
      new Request("https://x/c", { headers: { authorization: "Bearer s3cre" } }),
      { ...calibrationEnv([], []), INTERNAL_SECRET: "s3cret" } as unknown as Env,
      { slug: "metagraphed", confidenceFloor: 0.9, secrets: { internalSecret: "INTERNAL_SECRET" } },
    );
    expect(r.status).toBe(401);
  });

  it("returns 401 via the native path when lengths differ (skips the native call)", async () => {
    const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (a: Uint8Array, b: Uint8Array) => boolean };
    const had = "timingSafeEqual" in subtle;
    (subtle as { timingSafeEqual?: (a: Uint8Array, b: Uint8Array) => boolean }).timingSafeEqual = () => true; // would wrongly pass if called
    try {
      const r = await handleInternalCalibration(
        // provided "Bearer x" length != "Bearer s3cret" length → short-circuits before timingSafeEqual
        new Request("https://x/c", { headers: { authorization: "Bearer x" } }),
        { ...calibrationEnv([], []), INTERNAL_SECRET: "s3cret" } as unknown as Env,
        { slug: "metagraphed", confidenceFloor: 0.9, secrets: { internalSecret: "INTERNAL_SECRET" } },
      );
      expect(r.status).toBe(401);
    } finally {
      if (!had) delete (subtle as { timingSafeEqual?: unknown }).timingSafeEqual;
    }
  });
});

// ── confidenceOf / decision-parse error paths (lines 271, 392) ────────────────────────────────────

describe("computeCalibration confidenceOf branches", () => {
  it("skips merges with null decision_json and merges whose confidence isn't a number", async () => {
    const env = {
      DB: {
        prepare(sql: string) {
          const all = async () => {
            if (sql.includes("FROM decision_records") && sql.includes("'merge'")) {
              return {
                results: [
                  { target_id: "o/r#1", decision_json: null }, // confidenceOf → null (if !j)
                  { target_id: "o/r#2", decision_json: "{not json" }, // JSON.parse throws → catch returns null
                  { target_id: "o/r#3", decision_json: JSON.stringify({ aiConfidence: "high" }) }, // non-number → null
                  { target_id: "o/r#4", decision_json: JSON.stringify({ aiConfidence: 0.8 }) }, // counted
                  // #9136: the LEGACY spelling still parses, so records written before decision_records
                  // renamed the field are not silently dropped from the curve.
                  { target_id: "o/r#5", decision_json: JSON.stringify({ confidence: 0.8 }) }, // counted
                ],
              };
            }
            return { results: [] };
          };
          return { all, bind: () => ({ all }) };
        },
      },
    } as unknown as Env;
    const cal = await computeCalibration(env, calConfig);
    // only the two numeric-confidence rows (new and legacy spelling) count, both kept (none reverted)
    expect(cal.keptAvgConfidence).toBe(0.8);
    expect(cal.mergedCount).toBe(5); // every merge row counts; only the confidence CURVE skips the unusable ones
    expect(cal.recommendedFloor).toBeNull();
    expect(cal.note).toMatch(/adequate/);
  });

  it("defaults closesByReason + disputedByReason to [] when those queries return no results", async () => {
    const env = {
      // every query: undefined results. Both call shapes, since decision_records reads are unbound.
      DB: { prepare() { const all = async () => ({}); return { all, bind: () => ({ all }) }; } },
    } as unknown as Env;
    const cal = await computeCalibration(env, calConfig);
    expect(cal.closesByReason).toEqual([]);
    expect(cal.disputedCloseCount).toBe(0);
    expect(cal.mergedCount).toBe(0);
    expect(cal.revertedCount).toBe(0);
  });

  it("populates closesByReason + disputedCloseCount and tolerates absent rows", async () => {
    const env = {
      DB: {
        prepare(sql: string) {
          const all = async () => {
            // The disputed-closes query ALSO reads decision_records with action 'close' and groups by rc, so
            // it must be matched FIRST or the closes-by-reason branch swallows it.
            if (sql.includes("reversal_reopened")) return { results: [{ rc: "duplicate", n: 1 }] };
            if (sql.includes("FROM decision_records") && sql.includes("'close'") && sql.includes("GROUP BY rc")) {
              return { results: [{ rc: "duplicate", n: 5 }, { rc: "conflict", n: 2 }] };
            }
            return {}; // merged + reverted: undefined results → `?? []` fallback
          };
          return {
            all,
            bind: () => ({ all }),
          };
        },
      },
    } as unknown as Env;
    const cal = await computeCalibration(env, calConfig);
    expect(cal.mergedCount).toBe(0);
    expect(cal.closesByReason[0]).toEqual({ reasonCode: "duplicate", closes: 5, disputed: 1 });
    expect(cal.closesByReason[1]).toEqual({ reasonCode: "conflict", closes: 2, disputed: 0 });
    expect(cal.disputedCloseCount).toBe(1);
  });
});

describe("handleInternalDecision decision_json parse + nullish target fields", () => {
  it("returns decision:null when the cached decision_json is malformed (catch, line 392)", async () => {
    const row = {
      id: "metagraphed:pull_request:o/r#5",
      project: "metagraphed",
      kind: "pull_request",
      repo: "o/r",
      number: 5,
      status: "manual",
      verdict: null, // exercises `target.verdict ?? null`
      head_sha: null,
      decided_sha: null,
      attempt_count: null, // exercises `attempt_count ?? 0`
      terminal_at: null,
      decision_json: "{broken json", // JSON.parse throws → decision = null
    };
    const r = await handleInternalDecision(new Request(url, { headers: auth }), decisionEnv(row), decisionConfig);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { decision: unknown; target: { verdict: unknown; attemptCount: number; headSha: unknown; decidedSha: unknown } };
    expect(body.decision).toBeNull();
    expect(body.target.verdict).toBeNull();
    expect(body.target.attemptCount).toBe(0);
    expect(body.target.headSha).toBeNull();
    expect(body.target.decidedSha).toBeNull();
  });

  it("defaults the audit list to empty when review_audit returns no results", async () => {
    const env = {
      INTERNAL_SECRET: "s3cret",
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return {
                first: async () => (sql.includes("FROM pull_requests") ? livePr({ state: "closed", merged_at: "2026-06-13T00:00:00Z", merge_attempt_count: 2 }) : null),
                all: async () => ({}), // undefined results -> the `?? []` fallback
              };
            },
          };
        },
      },
    } as unknown as Env;
    const r = await handleInternalDecision(new Request(url, { headers: auth }), env, decisionConfig);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { decision: unknown; audit: unknown[]; target: { terminalAt: unknown } };
    expect(body.decision).toBeNull(); // no decision record for this PR
    expect(body.audit).toEqual([]);
    expect(body.target.terminalAt).toBe("2026-06-13T00:00:00Z");
  });

  it("defaults kind to pull_request when ?kind is an unknown value", async () => {
    // exercises the `params.get("kind") === "issue" ? "issue" : "pull_request"` false branch with a non-issue value
    const r = await handleInternalDecision(new Request("https://x/d?repo=o/r&number=5&kind=bogus", { headers: auth }), decisionEnv(livePr()), decisionConfig);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { target: { kind: string } };
    expect(body.target.kind).toBe("pull_request");
  });

  it("treats ?kind=issue as an issue target", async () => {
    const row = { id: "metagraphed:issue:o/r#5", repo: "o/r", number: 5, kind: "issue", status: "merged", verdict: "merge", head_sha: "a", decided_sha: "a", attempt_count: 1, terminal_at: null, decision_json: null };
    const r = await handleInternalDecision(new Request("https://x/d?repo=o/r&number=5&kind=issue", { headers: auth }), decisionEnv(row), decisionConfig);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { target: { kind: string } };
    expect(body.target.kind).toBe("issue");
  });
});

// ── computeAgentHealth: empty ledger fallbacks (the `?? []` / `?? 0` / ternary false sides) ────────

describe("computeAgentHealth empty-ledger fallbacks", () => {
  it("returns a zeroed snapshot when every query is empty (results undefined, counts undefined)", async () => {
    const emptyEnv = {
      DB: {
        prepare() {
          return { bind() { return { first: async () => undefined, all: async () => ({}) }; } };
        },
      },
    } as unknown as Env;
    const h = await computeAgentHealth(emptyEnv, healthConfig);
    expect(h.byDecision).toEqual({});
    expect(h.terminalCount).toBe(0);
    expect(h.nonTerminal).toBe(0);
    expect(h.manualRate).toBe(0); // no decisions at all → ternary false branch
    expect(h.dlqCount).toBe(0); // dlqCountRow?.n ?? dlqTargets.length (both fall through)
    expect(h.dlqTargets).toEqual([]);
    expect(h.reversals).toBe(0);
    expect(h.reversalRate).toBe(0); // recentAutoActions 0 → ternary false branch
    expect(h.recentAutoActions).toBe(0);
  });

  it("computes manualRate with decisions but no holds (the `?? 0` fallback)", async () => {
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return {
                first: async () => ({}),
                all: async () => {
                  if (sql.includes("GROUP BY decision")) return { results: [{ decision: "merge", n: 4 }] }; // acted, never held
                  return {};
                },
              };
            },
          };
        },
      },
    } as unknown as Env;
    const h = await computeAgentHealth(env, healthConfig);
    expect(h.terminalCount).toBe(4);
    expect(h.manualRate).toBe(0); // (byDecision.hold ?? 0) / 4
  });

  // #9136: the "maps recent failed (status='error') rows into failedTargets" test is GONE with the signal it
  // covered. `status='error'` was a review_targets processing state the convergence cutover removed as a
  // concept, so that query could only ever return nothing; dlqTargets (tested directly below) is the live
  // signal for the same operator question.

  it("uses dlqTargets.length as the dlqCount fallback when the COUNT row lacks n", async () => {
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return {
                first: async () => {
                  if (sql.includes("event_type = 'gate_decision'") && sql.includes("decision IN ('merge', 'close')")) return { n: 1 };
                  if (sql.includes("event_type = 'dead_lettered'") && sql.includes("COUNT(*)")) return {}; // no n → `?? dlqTargets.length`
                  return {};
                },
                all: async () => {
                  // #9136: dead-letter display sample (has rows) — target_id/summary, no review_targets join
                  // — and a row with a null summary (lastError null).
                  if (sql.includes("event_type = 'dead_lettered'")) return { results: [{ target_id: "o/r#7", summary: null }] };
                  return {};
                },
              };
            },
          };
        },
      },
    } as unknown as Env;
    const h = await computeAgentHealth(env, healthConfig);
    expect(h.dlqTargets).toHaveLength(1);
    expect(h.dlqTargets?.[0]).toEqual({ number: 7, repo: "o/r", verdict: null, lastError: null });
    expect(h.dlqCount).toBe(1); // fell back to dlqTargets.length
  });
});

// ── #9136: the generalizable fix — the NEXT orphaning (a table a downstream module treats as live,
// silently stopped being written) must be loud, not silent, the way review_targets' own 2026-06-22
// orphaning was for months. Real D1 (createTestEnv applies every migration), not a hand-rolled mock, so
// the actual `datetime('now', ?)` window arithmetic is exercised for real. ─────────────────────────────
describe("checkReviewSourceFreshness (#9136)", () => {
  it("reads both live sources as STALE when both are empty", async () => {
    const env = createTestEnv();
    const checks = await checkReviewSourceFreshness(env);
    expect(checks).toEqual([
      { table: "review_audit", windowDays: 7, fresh: false },
      { table: "decision_records", windowDays: 7, fresh: false },
    ]);
  });

  it("REGRESSION: review_targets is no longer probed at all — a frozen table cannot be 'fresh' again", async () => {
    // It was checked on a 90-day window against a table with no writer since 2026-06-22, so the gauge read 0
    // forever: an alert nothing could ever clear, which is noise rather than signal. A staleness probe only
    // earns its place while something still READS the table, and nothing does now.
    const env = createTestEnv();
    expect((await checkReviewSourceFreshness(env)).map((c) => c.table)).not.toContain("review_targets");
  });

  it("reads review_audit as FRESH when it has a row inside its 7-day window (the live, steady-state case)", async () => {
    const env = createTestEnv();
    await env.DB.prepare(
      `INSERT INTO review_audit (id, project, target_id, event_type, created_at) VALUES (?, ?, ?, 'gate_decision', datetime('now'))`,
    )
      .bind("a1", "loopover", "o/r#1")
      .run();
    const checks = await checkReviewSourceFreshness(env);
    expect(checks.find((c) => c.table === "review_audit")).toEqual({ table: "review_audit", windowDays: 7, fresh: true });
  });

  it("reads review_audit as STALE when its only row is OUTSIDE the 7-day window (the boundary arm)", async () => {
    const env = createTestEnv();
    await env.DB.prepare(
      `INSERT INTO review_audit (id, project, target_id, event_type, created_at) VALUES (?, ?, ?, 'gate_decision', datetime('now', '-8 days'))`,
    )
      .bind("a2", "loopover", "o/r#2")
      .run();
    const checks = await checkReviewSourceFreshness(env);
    expect(checks.find((c) => c.table === "review_audit")).toEqual({ table: "review_audit", windowDays: 7, fresh: false });
  });

  it("reads decision_records as FRESH inside its window and STALE outside it — the source the calibration and decision surfaces now read", async () => {
    const fresh = createTestEnv();
    await fresh.DB.prepare(
      `INSERT INTO decision_records (id, repo_full_name, pull_number, head_sha, action, reason_code, record_digest, record_json, created_at)
       VALUES (?, ?, 1, 'sha', 'merge', 'gate_pass', 'd', '{}', datetime('now'))`,
    ).bind("record:o/r#1@sha", "o/r").run();
    expect((await checkReviewSourceFreshness(fresh)).find((c) => c.table === "decision_records")).toEqual({ table: "decision_records", windowDays: 7, fresh: true });

    const stale = createTestEnv();
    await stale.DB.prepare(
      `INSERT INTO decision_records (id, repo_full_name, pull_number, head_sha, action, reason_code, record_digest, record_json, created_at)
       VALUES (?, ?, 1, 'sha', 'merge', 'gate_pass', 'd', '{}', datetime('now', '-8 days'))`,
    ).bind("record:o/r#1@sha", "o/r").run();
    expect((await checkReviewSourceFreshness(stale)).find((c) => c.table === "decision_records")).toEqual({ table: "decision_records", windowDays: 7, fresh: false });
  });

  it("fails CLOSED (stale) on a read error, e.g. a dropped/missing table, rather than throwing", async () => {
    const env = {
      DB: {
        prepare() {
          throw new Error("no such table: review_audit");
        },
      },
    } as unknown as Env;
    const checks = await checkReviewSourceFreshness(env);
    expect(checks.every((c) => c.fresh === false)).toBe(true);
  });
});

// ── #9136: repo/number parsed from review_audit's own target_id (parseReviewAuditTargetId) ────────
describe("computeAgentHealth target_id parsing (#9136)", () => {
  it("derives 'closed' status for a reversal_reopened row (the other ternary arm vs 'merged')", async () => {
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return {
                first: async () => ({ n: 0 }),
                all: async () => {
                  if (sql.includes("reversal_reverted")) return { results: [{ target_id: "o/r#5", event_type: "reversal_reopened" }] };
                  return {};
                },
              };
            },
          };
        },
      },
    } as unknown as Env;
    const h = await computeAgentHealth(env, healthConfig);
    expect(h.reversedTargets?.[0]).toEqual({ number: 5, repo: "o/r", status: "closed", eventType: "reversal_reopened" });
  });

  it("filters out a reversal row whose target_id can't be parsed, without dropping a well-formed sibling", async () => {
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return {
                first: async () => ({ n: 0 }),
                all: async () => {
                  if (sql.includes("reversal_reverted")) {
                    return {
                      results: [
                        { target_id: "no-hash-at-all", event_type: "reversal_reverted" }, // no '#' -> null
                        { target_id: "#5", event_type: "reversal_reverted" }, // hashIndex === 0 -> null
                        { target_id: "o/r#not-a-number", event_type: "reversal_reverted" }, // NaN -> null
                        { target_id: "o/r#12", event_type: "reversal_reverted" }, // well-formed
                      ],
                    };
                  }
                  return {};
                },
              };
            },
          };
        },
      },
    } as unknown as Env;
    const h = await computeAgentHealth(env, healthConfig);
    expect(h.reversedTargets).toHaveLength(1);
    expect(h.reversedTargets?.[0]).toEqual({ number: 12, repo: "o/r", status: "merged", eventType: "reversal_reverted" });
  });

  it("filters out a dead-letter row whose target_id can't be parsed", async () => {
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return {
                first: async () => ({ n: 0 }),
                all: async () => {
                  if (sql.includes("event_type = 'dead_lettered'")) {
                    return {
                      results: [
                        { target_id: "unparseable", summary: "boom" },
                        { target_id: "o/r#9", summary: "ok" },
                      ],
                    };
                  }
                  return {};
                },
              };
            },
          };
        },
      },
    } as unknown as Env;
    const h = await computeAgentHealth(env, healthConfig);
    expect(h.dlqTargets).toHaveLength(1);
    expect(h.dlqTargets?.[0]).toEqual({ number: 9, repo: "o/r", verdict: null, lastError: "ok" });
  });
});
