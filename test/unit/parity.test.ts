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
});
