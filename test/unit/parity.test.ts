import { describe, expect, it } from "vitest";
import {
  computeGateEval,
  computeGateParity,
  type GateParityRow,
  isParityCutoverReady,
  MIN_PARITY_SAMPLE,
  PARITY_AGREEMENT_FLOOR,
} from "../../src/review/parity";

// NOTE: this is the SELF-CONTAINED native port of reviewbot's parity test (eval.test.ts). The reviewbot
// original also had an "insertAudit — stamps source + head_sha" suite that exercises a DIFFERENT module
// (src/core/db.ts), which was NOT ported here (out of scope — this port is eval.ts's pure parity/eval
// functions). That suite is intentionally omitted; the column-stamping it covers is the later D1-migration
// prerequisite noted in the module header.

const NOW = Date.parse("2026-06-20T00:00:00Z");

// Stub D1 returning a fixed parity result set. The cross-system self-join is exercised against the real
// query in production; here we verify the FOLD (paired matrix → agreement / unsafe / per-reasonCode) and
// that the SQL carries both source binds. Each cell is one (auth_act, shadow_act, reason) pair count.
function parityEnv(
  cells: Array<{ project: string; auth_act: string; shadow_act: string; reason: string; n: number }>,
  capture?: { sql?: string; binds?: unknown[] },
): Env {
  return {
    DB: {
      prepare: (sql: string) => {
        if (capture) capture.sql = sql;
        return {
          bind: (...binds: unknown[]) => {
            if (capture) capture.binds = binds;
            return { all: async () => ({ results: cells }) };
          },
        };
      },
    },
  } as unknown as Env;
}

describe("computeGateParity — cross-system gate-decision agreement (#preconv-parity)", () => {
  it("folds the paired matrix into agreement / disagree counts + rate", async () => {
    const out = await computeGateParity(
      parityEnv([
        { project: "gittensory", auth_act: "merge", shadow_act: "merge", reason: "dual_review_approved", n: 40 },
        { project: "gittensory", auth_act: "close", shadow_act: "close", reason: "consensus_close", n: 10 },
        { project: "gittensory", auth_act: "hold", shadow_act: "hold", reason: "split", n: 5 },
        { project: "gittensory", auth_act: "hold", shadow_act: "close", reason: "split", n: 2 }, // benign disagree
      ]),
      { days: 90, nowMs: NOW },
    );
    const g = out.rows[0];
    expect(g).toBeDefined();
    if (!g) return;
    expect(g.project).toBe("gittensory");
    expect(g.pairedSamples).toBe(57);
    expect(g.bothMerge).toBe(40);
    expect(g.bothClose).toBe(10);
    expect(g.bothHold).toBe(5);
    expect(g.disagree).toBe(2);
    expect(g.agreementRate).toBeCloseTo(55 / 57);
    expect(g.unsafeDisagreements).toBe(0); // hold→close is the SAFE direction
    expect(out.authoritative).toBe("reviewbot");
    expect(out.shadow).toBe("gittensory");
  });

  it("counts ONLY the dangerous direction (shadow MERGES where authoritative HOLDs/CLOSEs) as unsafe", async () => {
    const out = await computeGateParity(
      parityEnv([
        { project: "p", auth_act: "merge", shadow_act: "merge", reason: "ok", n: 20 },
        { project: "p", auth_act: "hold", shadow_act: "merge", reason: "split", n: 3 }, // UNSAFE: shadow ships a hold
        { project: "p", auth_act: "close", shadow_act: "merge", reason: "consensus_close", n: 1 }, // UNSAFE: shadow ships a close
        { project: "p", auth_act: "merge", shadow_act: "hold", reason: "ok", n: 4 }, // NOT unsafe (shadow more conservative)
        { project: "p", auth_act: "merge", shadow_act: "close", reason: "ok", n: 2 }, // NOT unsafe
      ]),
      { days: 90, nowMs: NOW },
    );
    const r = out.rows[0];
    expect(r).toBeDefined();
    if (!r) return;
    expect(r.unsafeDisagreements).toBe(4); // 3 + 1, NOT the conservative-direction 6
    expect(r.disagree).toBe(10); // all four disagreeing buckets
    expect(r.bothMerge).toBe(20);
  });

  it("produces a per-reasonCode agree/disagree breakdown sorted by paired volume", async () => {
    const out = await computeGateParity(
      parityEnv([
        { project: "p", auth_act: "merge", shadow_act: "merge", reason: "small_correct", n: 30 },
        { project: "p", auth_act: "merge", shadow_act: "hold", reason: "small_correct", n: 5 },
        { project: "p", auth_act: "close", shadow_act: "close", reason: "incorrect", n: 8 },
      ]),
      { days: 90, nowMs: NOW },
    );
    const rc = out.rows[0]?.byReasonCode;
    expect(rc).toBeDefined();
    if (!rc) return;
    expect(rc[0]).toEqual({ reasonCode: "small_correct", paired: 35, agree: 30, disagree: 5 });
    expect(rc[1]).toEqual({ reasonCode: "incorrect", paired: 8, agree: 8, disagree: 0 });
  });

  it("binds BOTH source filters (authoritative + shadow) so two distinct writers are compared", async () => {
    const cap: { sql?: string; binds?: unknown[] } = {};
    await computeGateParity(parityEnv([], cap), { days: 90, nowMs: NOW, authoritative: "reviewbot", shadow: "gittensory" });
    // binds order: auth-source, fromIso, shadow-source, fromIso (no project filter).
    expect(cap.binds?.[0]).toBe("reviewbot");
    expect(cap.binds?.[2]).toBe("gittensory");
    // The per-commit join key requires a non-null head_sha on BOTH sides.
    expect(cap.sql).toContain("head_sha IS NOT NULL");
    expect(cap.sql).toContain("auth.head_sha = shad.head_sha");
  });

  it("passes the project filter through to both CTE binds when scoped", async () => {
    const cap: { sql?: string; binds?: unknown[] } = {};
    await computeGateParity(parityEnv([], cap), { days: 90, nowMs: NOW, project: "gittensory" });
    // binds: auth, fromIso, project, shadow, fromIso, project
    expect(cap.binds).toHaveLength(6);
    expect(cap.binds?.[2]).toBe("gittensory");
    expect(cap.binds?.[5]).toBe("gittensory");
  });

  it("excludes pairs whose action isn't a comparable merge/close/hold", async () => {
    const out = await computeGateParity(
      parityEnv([
        { project: "p", auth_act: "merge", shadow_act: "merge", reason: "ok", n: 5 },
        { project: "p", auth_act: "comment", shadow_act: "merge", reason: "weird", n: 9 }, // not a gate action → skipped
      ]),
      { days: 90, nowMs: NOW },
    );
    expect(out.rows[0]?.pairedSamples).toBe(5);
    expect(out.rows[0]?.unsafeDisagreements).toBe(0);
  });

  it("is fail-safe → empty report when the query throws", async () => {
    const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => { throw new Error("d1 down"); } }) }) } } as unknown as Env;
    const out = await computeGateParity(env, { days: 90, nowMs: NOW });
    expect(out.rows).toEqual([]);
    expect(out.hasSignal).toBe(false);
    expect(out.authoritative).toBe("reviewbot");
  });

  it("skips when the SHADOW side action isn't comparable (exercises the right ||-operand of the gate-action guard)", async () => {
    // auth_act is a valid gate action; shadow_act is NOT → the second isGateAction() must short-circuit-exclude.
    const out = await computeGateParity(
      parityEnv([
        { project: "p", auth_act: "merge", shadow_act: "merge", reason: "ok", n: 7 },
        { project: "p", auth_act: "merge", shadow_act: "comment", reason: "weird", n: 11 }, // shadow not a gate action → skipped
      ]),
      { days: 90, nowMs: NOW },
    );
    const r = out.rows[0];
    expect(r).toBeDefined();
    if (!r) return;
    expect(r.pairedSamples).toBe(7); // the 11 comment-shadow pairs are excluded
    expect(r.bothMerge).toBe(7);
    expect(r.disagree).toBe(0);
  });

  it("yields a null agreementRate for a project row whose only paired cell has n=0 (pairedSamples stays 0)", async () => {
    // A row gets seeded by any cell, but pairedSamples += n; with n=0 the row exists with pairedSamples 0,
    // driving the `pairedSamples > 0 ? agree/paired : null` FALSE branch.
    const out = await computeGateParity(
      parityEnv([{ project: "z", auth_act: "merge", shadow_act: "merge", reason: "ok", n: 0 }]),
      { days: 90, nowMs: NOW },
    );
    const r = out.rows[0];
    expect(r).toBeDefined();
    if (!r) return;
    expect(r.project).toBe("z");
    expect(r.pairedSamples).toBe(0);
    expect(r.agreementRate).toBeNull();
  });

  it("treats the AUTHORITATIVE merge→close disagreement (shadow more conservative) as NOT unsafe", async () => {
    // Covers the unsafe-direction `&&` when shadow_act !== 'merge': disagree increments but unsafe must not.
    const out = await computeGateParity(
      parityEnv([
        { project: "p", auth_act: "merge", shadow_act: "close", reason: "ok", n: 6 },
        { project: "p", auth_act: "close", shadow_act: "hold", reason: "x", n: 3 }, // also benign (shadow not merge)
      ]),
      { days: 90, nowMs: NOW },
    );
    const r = out.rows[0];
    expect(r).toBeDefined();
    if (!r) return;
    expect(r.disagree).toBe(9);
    expect(r.unsafeDisagreements).toBe(0);
  });

  it("counts a shadow-merge against an authoritative HOLD as unsafe but a shadow-merge against an authoritative MERGE-disagree-free path stays safe", async () => {
    // Drives the `auth_act === 'hold' || auth_act === 'close'` ||: hold side true, and a shadow=merge with
    // auth=merge is the agreed path (never reaches the unsafe check).
    const out = await computeGateParity(
      parityEnv([
        { project: "p", auth_act: "hold", shadow_act: "merge", reason: "split", n: 2 }, // unsafe (hold side of ||)
        { project: "p", auth_act: "merge", shadow_act: "merge", reason: "ok", n: 4 }, // agreed, never unsafe
      ]),
      { days: 90, nowMs: NOW },
    );
    const r = out.rows[0];
    expect(r).toBeDefined();
    if (!r) return;
    expect(r.unsafeDisagreements).toBe(2);
    expect(r.bothMerge).toBe(4);
  });

  it("uses explicit authoritative/shadow overrides instead of the defaults", async () => {
    const out = await computeGateParity(
      parityEnv([{ project: "p", auth_act: "merge", shadow_act: "merge", reason: "ok", n: 1 }]),
      { days: 90, nowMs: NOW, authoritative: "alpha", shadow: "beta" },
    );
    expect(out.authoritative).toBe("alpha"); // ?? right-hand default NOT taken
    expect(out.shadow).toBe("beta");
  });

  it("sorts multiple project rows by project name ascending", async () => {
    const out = await computeGateParity(
      parityEnv([
        { project: "zeta", auth_act: "merge", shadow_act: "merge", reason: "ok", n: 1 },
        { project: "alpha", auth_act: "close", shadow_act: "close", reason: "x", n: 1 },
        { project: "mid", auth_act: "hold", shadow_act: "hold", reason: "y", n: 1 },
      ]),
      { days: 90, nowMs: NOW },
    );
    expect(out.rows.map((r) => r.project)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("defaults to a null/empty result set when the driver returns no `results` field", async () => {
    // Exercises the `res.results ?? []` nullish fallback (results undefined → []).
    const env = {
      DB: { prepare: () => ({ bind: () => ({ all: async () => ({}) }) }) },
    } as unknown as Env;
    const out = await computeGateParity(env, { days: 90, nowMs: NOW });
    expect(out.rows).toEqual([]);
    expect(out.hasSignal).toBe(false);
  });

  it("clamps an over-long days window to 730 and defaults a non-positive/non-finite days to 90", async () => {
    const capBig: { binds?: unknown[] } = {};
    await computeGateParity(parityEnv([], capBig), { days: 9999, nowMs: NOW }); // > 730 → clamp
    const bigFrom = capBig.binds?.[1] as string;
    expect(bigFrom).toBe(new Date(NOW - 730 * 86_400_000).toISOString().slice(0, 10));

    const capDefault: { binds?: unknown[] } = {};
    await computeGateParity(parityEnv([], capDefault), { days: 0, nowMs: NOW }); // non-positive → 90
    const defFrom = capDefault.binds?.[1] as string;
    expect(defFrom).toBe(new Date(NOW - 90 * 86_400_000).toISOString().slice(0, 10));

    const capNaN: { binds?: unknown[] } = {};
    await computeGateParity(parityEnv([], capNaN), { days: Number.NaN, nowMs: NOW }); // non-finite → 90
    const nanFrom = capNaN.binds?.[1] as string;
    expect(nanFrom).toBe(new Date(NOW - 90 * 86_400_000).toISOString().slice(0, 10));
  });
});

describe("isParityCutoverReady — the per-repo cutover gate (#preconv-parity)", () => {
  const base = (over: Partial<GateParityRow>): GateParityRow => ({
    project: "p",
    pairedSamples: MIN_PARITY_SAMPLE,
    bothMerge: 0,
    bothClose: 0,
    bothHold: 0,
    disagree: 0,
    agreementRate: 1,
    unsafeDisagreements: 0,
    byReasonCode: [],
    ...over,
  });

  it("is ready: enough samples, zero unsafe, agreement at/above the floor", () => {
    expect(isParityCutoverReady(base({ agreementRate: PARITY_AGREEMENT_FLOOR }))).toBe(true);
  });

  it("NOT ready on a thin sample even with perfect agreement", () => {
    expect(isParityCutoverReady(base({ pairedSamples: MIN_PARITY_SAMPLE - 1, agreementRate: 1 }))).toBe(false);
  });

  it("NOT ready when even ONE unsafe disagreement exists (the hard safety gate)", () => {
    expect(isParityCutoverReady(base({ unsafeDisagreements: 1, agreementRate: 1 }))).toBe(false);
  });

  it("NOT ready when agreement is below the documented floor", () => {
    expect(isParityCutoverReady(base({ agreementRate: PARITY_AGREEMENT_FLOOR - 0.001 }))).toBe(false);
  });

  it("NOT ready when no samples paired (agreementRate null)", () => {
    expect(isParityCutoverReady(base({ pairedSamples: 0, agreementRate: null }))).toBe(false);
  });
});

describe("computeGateEval — source scoping for per-system standalone accuracy (#preconv-parity)", () => {
  it("binds the source filter when a source is given", async () => {
    let boundSql = "";
    let bound: unknown[] = [];
    const env = {
      DB: {
        prepare: (sql: string) => {
          boundSql = sql;
          return { bind: (...a: unknown[]) => { bound = a; return { all: async () => ({ results: [] }) }; } };
        },
      },
    } as unknown as Env;
    await computeGateEval(env, { days: 90, nowMs: NOW, source: "gittensory" });
    expect(boundSql).toContain("AND source = ?");
    expect(bound).toContain("gittensory");
  });

  it("omits the source filter (scores ALL writers) when no source is given — behavior-preserving", async () => {
    let boundSql = "";
    let bound: unknown[] = [];
    const env = {
      DB: {
        prepare: (sql: string) => {
          boundSql = sql;
          return { bind: (...a: unknown[]) => { bound = a; return { all: async () => ({ results: [] }) }; } };
        },
      },
    } as unknown as Env;
    await computeGateEval(env, { days: 90, nowMs: NOW });
    expect(boundSql).not.toContain("AND source = ?");
    expect(bound).toHaveLength(1); // only fromIso
  });

  it("folds the prediction-vs-outcome confusion matrix into per-project precisions", async () => {
    // A stub D1 returning the gd⨝po cells directly (the self-join is exercised against real SQL in prod;
    // here we drive the FOLD): merge-correct/merge-false/close-correct/close-false/hold buckets.
    const cells = [
      { project: "p", pred: "merge", truth: "merged", n: 8 }, // would-merge, human merged → confirmed
      { project: "p", pred: "merge", truth: "closed", n: 2 }, // would-merge, human closed → the dangerous false
      { project: "p", pred: "close", truth: "closed", n: 5 }, // would-close, human closed → confirmed
      { project: "p", pred: "close", truth: "merged", n: 1 }, // would-close, human merged → false-close
      { project: "p", pred: "hold", truth: "merged", n: 3 }, // hold → neither a merge nor a close prediction
    ];
    const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: cells }) }) }) } } as unknown as Env;
    const out = await computeGateEval(env, { days: 90, nowMs: NOW });
    const r = out.rows[0];
    expect(r).toBeDefined();
    if (!r) return;
    expect(r.project).toBe("p");
    expect(r.wouldMerge).toBe(10);
    expect(r.mergeConfirmed).toBe(8);
    expect(r.mergeFalse).toBe(2);
    expect(r.mergePrecision).toBeCloseTo(0.8); // 8/10
    expect(r.wouldClose).toBe(6);
    expect(r.closeConfirmed).toBe(5);
    expect(r.closeFalse).toBe(1);
    expect(r.closePrecision).toBeCloseTo(5 / 6);
    expect(r.hold).toBe(3);
    expect(r.decided).toBe(19);
    expect(out.hasSignal).toBe(true); // decided(19) >= MIN_DECIDED_FOR_SIGNAL(10)
  });

  it("is fail-safe → empty report when the eval query throws", async () => {
    const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => { throw new Error("d1 down"); } }) }) } } as unknown as Env;
    const out = await computeGateEval(env, { days: 90, nowMs: NOW });
    expect(out.rows).toEqual([]);
    expect(out.hasSignal).toBe(false);
  });

  it("leaves precisions null and hasSignal false when a project has no merge/close predictions or too few decided", async () => {
    const cells = [{ project: "q", pred: "hold", truth: "merged", n: 4 }]; // only holds, 4 decided
    const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: cells }) }) }) } } as unknown as Env;
    const out = await computeGateEval(env, { days: 90, nowMs: NOW });
    const r = out.rows[0];
    expect(r?.mergePrecision).toBeNull(); // no would-merge → null, not 0/0
    expect(r?.closePrecision).toBeNull();
    expect(r?.hold).toBe(4);
    expect(out.hasSignal).toBe(false); // 4 < MIN_DECIDED_FOR_SIGNAL(10)
  });

  it("counts decided but no confusion bucket for an unknown prediction (none of merge/close/hold)", async () => {
    // pred falls through every `pred === ...` arm: decided increments, all matrix counters stay 0.
    const cells = [{ project: "p", pred: "comment", truth: "merged", n: 6 }];
    const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: cells }) }) }) } } as unknown as Env;
    const out = await computeGateEval(env, { days: 90, nowMs: NOW });
    const r = out.rows[0];
    expect(r).toBeDefined();
    if (!r) return;
    expect(r.decided).toBe(6);
    expect(r.wouldMerge).toBe(0);
    expect(r.wouldClose).toBe(0);
    expect(r.hold).toBe(0);
    expect(r.mergePrecision).toBeNull();
    expect(r.closePrecision).toBeNull();
  });

  it("ignores a merge/close prediction whose outcome is neither merged nor closed (e.g. expired)", async () => {
    // merge-pred truth='expired' → wouldMerge counts, but neither mergeConfirmed nor mergeFalse;
    // close-pred truth='expired' → wouldClose counts, but neither closeConfirmed nor closeFalse.
    const cells = [
      { project: "p", pred: "merge", truth: "expired", n: 4 },
      { project: "p", pred: "close", truth: "expired", n: 3 },
    ];
    const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: cells }) }) }) } } as unknown as Env;
    const out = await computeGateEval(env, { days: 90, nowMs: NOW });
    const r = out.rows[0];
    expect(r).toBeDefined();
    if (!r) return;
    expect(r.wouldMerge).toBe(4);
    expect(r.mergeConfirmed).toBe(0);
    expect(r.mergeFalse).toBe(0);
    expect(r.mergePrecision).toBe(0); // 0 confirmed / 4 would-merge → 0, NOT null
    expect(r.wouldClose).toBe(3);
    expect(r.closeConfirmed).toBe(0);
    expect(r.closeFalse).toBe(0);
    expect(r.closePrecision).toBe(0);
  });

  it("defaults to [] when the eval driver returns no `results` field (nullish fallback)", async () => {
    const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => ({}) }) }) } } as unknown as Env;
    const out = await computeGateEval(env, { days: 90, nowMs: NOW });
    expect(out.rows).toEqual([]);
    expect(out.hasSignal).toBe(false);
  });

  it("sorts multiple eval project rows by project name ascending", async () => {
    const cells = [
      { project: "yankee", pred: "merge", truth: "merged", n: 1 },
      { project: "bravo", pred: "close", truth: "closed", n: 1 },
    ];
    const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: cells }) }) }) } } as unknown as Env;
    const out = await computeGateEval(env, { days: 90, nowMs: NOW });
    expect(out.rows.map((r) => r.project)).toEqual(["bravo", "yankee"]);
  });

  it("clamps an over-long days window to 730 and defaults a non-positive/non-finite days to 90", async () => {
    const cap = (capture: { binds?: unknown[] }): Env =>
      ({
        DB: {
          prepare: () => ({
            bind: (...a: unknown[]) => {
              capture.binds = a;
              return { all: async () => ({ results: [] }) };
            },
          }),
        },
      }) as unknown as Env;

    const big: { binds?: unknown[] } = {};
    await computeGateEval(cap(big), { days: 9999, nowMs: NOW }); // > 730 → clamp
    expect(big.binds?.[0]).toBe(new Date(NOW - 730 * 86_400_000).toISOString().slice(0, 10));

    const zero: { binds?: unknown[] } = {};
    await computeGateEval(cap(zero), { days: -5, nowMs: NOW }); // non-positive → 90
    expect(zero.binds?.[0]).toBe(new Date(NOW - 90 * 86_400_000).toISOString().slice(0, 10));

    const nan: { binds?: unknown[] } = {};
    await computeGateEval(cap(nan), { days: Number.POSITIVE_INFINITY, nowMs: NOW }); // non-finite → 90
    expect(nan.binds?.[0]).toBe(new Date(NOW - 90 * 86_400_000).toISOString().slice(0, 10));
  });
});
