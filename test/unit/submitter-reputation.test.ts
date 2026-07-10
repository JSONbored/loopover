import { describe, expect, it } from "vitest";
import {
  classifyOutcome,
  computeSubmissionCadence,
  countOutcomes,
  DEFAULT_REPUTATION_CONFIG,
  getSubmitterCadence,
  getSubmitterReputation,
  isMachinePacedCadence,
  recordSubmissionOutcome,
  REPUTATION_WINDOW_DAYS,
  type ReputationConfig,
  signalFromCounts,
} from "../../src/review/submitter-reputation";

// NOTE: this is the SELF-CONTAINED native port of reviewbot's submitter-reputation test. The reviewbot
// original also exercised applyNonContentGate / decideNonContentGate (the gate wiring + owner exemption);
// those modules were NOT ported (out of scope — they'd drag in change-classifier / ai-review / github), so
// those suites are intentionally omitted. The pure classifiers + the D1 fail-safe reads are covered here.

// Build a list of (status, reasonCode) rows (the shape getSubmitterReputation pulls from review_targets).
type Row = { status: string; reasonCode: string | null };
const rows = (...specs: Array<[string, string | null, number]>): Row[] => {
  const out: Row[] = [];
  for (const [status, reasonCode, n] of specs) for (let i = 0; i < n; i++) out.push({ status, reasonCode });
  return out;
};
const signalOf = (...specs: Array<[string, string | null, number]>) => signalFromCounts(countOutcomes(rows(...specs)));

describe("classifyOutcome — reasonCode → quality bucket (#reputation-redesign)", () => {
  it("a merged row is always SUCCESS (even with a source_* code — it shipped)", () => {
    expect(classifyOutcome("merged", "dual_review_approved")).toBe("success");
    expect(classifyOutcome("merged", null)).toBe("success"); // merged-with-null-reasonCode
    expect(classifyOutcome("merged", "dual_review_approved_tiebreak")).toBe("success");
    expect(classifyOutcome("merged", "maintainer_cleanup")).toBe("success");
    expect(classifyOutcome("merged", "source_prompt_injection")).toBe("success");
  });
  it("conflict / out-of-band closes are EXCLUDED (a rebase artifact, not quality)", () => {
    expect(classifyOutcome("closed", "merge_conflict_closed")).toBe("exclude");
    expect(classifyOutcome("closed", "merge_conflict_close")).toBe("exclude");
    expect(classifyOutcome("closed", "pr_closed_before_merge")).toBe("exclude");
    expect(classifyOutcome("closed", null)).toBe("exclude"); // closed w/ null reasonCode = out-of-band
    expect(classifyOutcome("closed", "dual_review_approved")).toBe("exclude"); // approved-but-closed = out-of-band
  });
  it("manual / held rows are EXCLUDED (neutral)", () => {
    expect(classifyOutcome("manual", "merge_failed_manual")).toBe("exclude");
    expect(classifyOutcome("manual", null)).toBe("exclude");
  });
  it("genuine reviewer rejects are QUALITY_FAIL; checks_failed is the lighter bucket", () => {
    expect(classifyOutcome("closed", "dual_review_declined")).toBe("quality_fail");
    expect(classifyOutcome("closed", "scope_failure")).toBe("quality_fail");
    expect(classifyOutcome("closed", "thin_description")).toBe("quality_fail");
    expect(classifyOutcome("closed", "checks_failed")).toBe("quality_fail_light");
  });
  it("prompt-injection is the only HARD-abuse bucket; honest-collision / transient codes are LIGHT (#reputation-too-harsh)", () => {
    expect(classifyOutcome("closed", "source_prompt_injection")).toBe("prompt_injection");
    // Previously hard-ABUSE; now the LIGHT bucket — usually honest collisions / transient fetch failures.
    expect(classifyOutcome("closed", "strict_duplicate")).toBe("quality_fail_light");
    expect(classifyOutcome("closed", "source_unfetchable")).toBe("quality_fail_light");
    expect(classifyOutcome("closed", "source_archived")).toBe("quality_fail_light");
    expect(classifyOutcome("closed", "protected_metadata_edit")).toBe("quality_fail_light");
  });
  it("an unknown close reasonCode is EXCLUDED (be generous — never penalise on an unknown code)", () => {
    expect(classifyOutcome("closed", "some_future_reason")).toBe("exclude");
  });
});

describe("signalFromCounts — generous, quality-weighted, recency-aware (#reputation-redesign)", () => {
  it("neutral below the minimum quality sample (a small history never brands anyone)", () => {
    // 2 merges + 1 decline = sample 3 < MIN_SAMPLE → neutral, even though it's >50% fail.
    expect(signalOf(["merged", "dual_review_approved", 2], ["closed", "dual_review_declined", 1])).toBe("neutral");
  });

  it("high-volume contributor WITH merges → never 'low' (the core fix)", () => {
    // Lots of recent merges plus several declines: failRate 8/28 ≈ 0.29 (> trusted 0.2, < low 0.7) → neutral.
    // The KEY property is it is NOT 'low' despite the absolute fail count, because the success guard holds.
    expect(signalOf(["merged", "dual_review_approved", 20], ["closed", "dual_review_declined", 8])).toBe("neutral");
    // Even a rougher mix (nearly as many fails as merges) with solid successes stays neutral, never low.
    expect(signalOf(["merged", "dual_review_approved", 10], ["closed", "dual_review_declined", 9])).toBe("neutral");
  });

  it("high-volume contributor with MANY duplicates / unfetchable → neutral, NOT low (#reputation-too-harsh)", () => {
    // The live false-positive cases: lots of recent merges + a pile of strict_duplicate / source_unfetchable
    // closes. These are now the LIGHT bucket (0.5 weight) AND the success guard holds → neutral, never 'low'.
    expect(signalOf(["merged", "dual_review_approved", 127], ["closed", "strict_duplicate", 5])).not.toBe("low");
    // many merges + a big batch of soft signals. weightedFails = 30*0.5 = 15; sample 199; rate ≈ 0.075 < 0.7.
    expect(signalOf(["merged", "dual_review_approved", 169], ["closed", "strict_duplicate", 20], ["closed", "source_unfetchable", 10])).not.toBe("low");
    // Even an extreme duplicate-only batch (no merges) stays out of 'low' on its own: 8 dups → weightedFails
    // 4, rate 0.5 < 0.7 → neutral. (Honest collisions never brand alone.)
    expect(signalOf(["closed", "strict_duplicate", 8])).toBe("neutral");
  });

  it("genuine serial spam — prompt-injection with ~no merges → low", () => {
    expect(signalOf(["merged", "dual_review_approved", 1], ["closed", "source_prompt_injection", 1], ["closed", "dual_review_declined", 5])).toBe("low");
  });
  it("any single prompt-injection (over a sufficient sample) → low", () => {
    expect(signalOf(["closed", "source_prompt_injection", 1], ["closed", "dual_review_declined", 4])).toBe("low");
  });
  it("a serial quality-failure history with very few successes → low", () => {
    // 1 success, 7 genuine declines: failRate 7/8 = 0.875 >= 0.7 AND success < 2 → low.
    expect(signalOf(["merged", "dual_review_approved", 1], ["closed", "dual_review_declined", 7])).toBe("low");
  });
  it("serial SOFT-fails with ~no merges → low (rate clears 0.7 once they dominate)", () => {
    // 6 declines + 4 duplicates, 1 merge: weightedFails 6 + 4*0.5 = 8; sample 11; rate ≈ 0.73 ≥ 0.7,
    // success 1 < 2 → low.
    expect(signalOf(["merged", "dual_review_approved", 1], ["closed", "dual_review_declined", 6], ["closed", "strict_duplicate", 4])).toBe("low");
  });

  it("flaky CI alone (checks_failed) is the LIGHTER weight — does not brand 'low' by itself", () => {
    // 0 merges, 6 checks_failed: weighted fails = 6*0.5 = 3, rate 3/6 = 0.5 < 0.7 → NOT low. Neutral.
    expect(signalOf(["closed", "checks_failed", 6])).toBe("neutral");
  });

  it("conflict-only / artifact-only history → neutral (excluded rows never reach the sample)", () => {
    // All EXCLUDE-bucket rows → quality sample is 0 < MIN_SAMPLE → neutral, never low.
    expect(signalOf(["closed", "merge_conflict_closed", 8], ["closed", null, 5], ["manual", null, 3])).toBe("neutral");
  });

  it("trusted when recent successes are solid and the fail rate is low", () => {
    expect(signalOf(["merged", "dual_review_approved", 12], ["closed", "dual_review_declined", 1])).toBe("trusted");
  });
  it("a mixed mid-band contributor → neutral", () => {
    expect(signalOf(["merged", "dual_review_approved", 6], ["closed", "dual_review_declined", 4])).toBe("neutral");
  });
});

describe("signalFromCounts — config-overridable thresholds (#private-config params)", () => {
  it("defaults to DEFAULT_REPUTATION_CONFIG when no config is passed (behavior-preserving)", () => {
    const c = countOutcomes(rows(["merged", "dual_review_approved", 12], ["closed", "dual_review_declined", 1]));
    expect(signalFromCounts(c)).toBe("trusted");
    expect(signalFromCounts(c, DEFAULT_REPUTATION_CONFIG)).toBe("trusted"); // identical
  });
  it("an override changes the outcome — a stricter trusted bar demotes a would-be 'trusted' to neutral", () => {
    const c = countOutcomes(rows(["merged", "dual_review_approved", 12], ["closed", "dual_review_declined", 1]));
    const strict: ReputationConfig = { ...DEFAULT_REPUTATION_CONFIG, trustedMinSuccess: 50 };
    expect(signalFromCounts(c, DEFAULT_REPUTATION_CONFIG)).toBe("trusted");
    expect(signalFromCounts(c, strict)).toBe("neutral");
  });
  it("a higher minSample keeps a small history neutral that a lower one would brand", () => {
    // 1 merge + 4 genuine declines: sample 5 ≥ default minSample → 'low'. Raise minSample to 6 → neutral.
    const c = countOutcomes(rows(["merged", "dual_review_approved", 1], ["closed", "dual_review_declined", 4]));
    expect(signalFromCounts(c, DEFAULT_REPUTATION_CONFIG)).toBe("low");
    expect(signalFromCounts(c, { ...DEFAULT_REPUTATION_CONFIG, minSample: 6 })).toBe("neutral");
  });

  it("an empty sample with minSample 0 exercises the failRate sample-0 guard → neutral (not low/trusted)", () => {
    // With minSample lowered to 0, an all-EXCLUDE (sample 0) history passes the `sample < minSample` floor
    // (0 < 0 is false) and reaches `failRate = sample > 0 ? … : 0`, taking the `: 0` (sample === 0) branch.
    // failRate 0 → not 'low'; success 0 < trustedMinSuccess → not 'trusted'; stays neutral.
    const c = countOutcomes(rows(["closed", "merge_conflict_closed", 3], ["manual", null, 2]));
    expect(c).toEqual({ success: 0, qualityFail: 0, qualityFailLight: 0, promptInjection: 0 });
    expect(signalFromCounts(c, { ...DEFAULT_REPUTATION_CONFIG, minSample: 0 })).toBe("neutral");
  });
});

describe("getSubmitterReputation — recency window (#reputation-redesign)", () => {
  it("OLD closes outside the window are not in the query result → they don't count (auto-correct)", async () => {
    // Simulate the DB returning ONLY in-window rows (the SQL `terminal_at >= datetime('now', -90 days)` filters
    // the old over-strict closes out). In-window: 10 merges, 1 decline → trusted, NOT trapped at 'low'.
    const inWindow = rows(["merged", "dual_review_approved", 10], ["closed", "dual_review_declined", 1]);
    const env = makeEnv({ statRow: { submissions: 100, merged: 10, closed: 90, manual: 0 }, windowRows: inWindow });
    const rep = await getSubmitterReputation(env, "p", "u");
    expect(rep.signal).toBe("trusted");
    // closeRate still reflects the all-time submitter_stats aggregate (for /stats), independent of the signal.
    expect(rep.closeRate).toBeCloseTo(0.9);
  });
  it("exposes the window constant for the SQL cutoff", () => {
    expect(REPUTATION_WINDOW_DAYS).toBe(90);
  });
});

describe("recordSubmissionOutcome / getSubmitterReputation (D1, fail-safe)", () => {
  it("getSubmitterReputation → neutral with no DB or no row", async () => {
    expect((await getSubmitterReputation({} as Env, "p", "u")).signal).toBe("neutral");
    const env = makeEnv({ statRow: null, windowRows: [] });
    expect((await getSubmitterReputation(env, "p", "u")).signal).toBe("neutral");
  });
  it("derives a LOW signal from the windowed review_targets rows (not the all-time ratio)", async () => {
    // submitter_stats says lots of closes, but the in-window quality rows are genuine serial declines → low.
    const env = makeEnv({ statRow: { submissions: 10, merged: 1, closed: 9, manual: 0 }, windowRows: rows(["merged", "dual_review_approved", 1], ["closed", "dual_review_declined", 7]) });
    const rep = await getSubmitterReputation(env, "p", "u");
    expect(rep.signal).toBe("low");
    expect(rep.closeRate).toBeCloseTo(0.9); // aggregate closeRate is still surfaced for /stats
  });
  it("fail-safe → neutral when the window query throws (never throws into the gate)", async () => {
    const env = {
      DB: {
        prepare: (_sql: string) => ({
          bind: () => ({
            first: async () => ({ submissions: 5, merged: 5, closed: 0, manual: 0 }),
            all: async () => {
              throw new Error("D1 boom");
            },
          }),
        }),
      },
    } as unknown as Env;
    const rep = await getSubmitterReputation(env, "p", "u");
    expect(rep.signal).toBe("neutral");
  });
  it("recordSubmissionOutcome never throws (no submitter / no DB / DB ok)", async () => {
    await expect(recordSubmissionOutcome({} as Env, "p", undefined, "merged")).resolves.toBeUndefined();
    await expect(recordSubmissionOutcome({ DB: { prepare: () => ({ bind: () => ({ run: async () => undefined }) }) } } as unknown as Env, "p", "u", "closed")).resolves.toBeUndefined();
  });

  it("recordSubmissionOutcome binds the right column per outcome (merged / closed / manual ternary)", async () => {
    // Capture the prepared SQL so we can assert the `${col}` interpolation picks the correct column for each
    // outcome — exercises both ternary arms of `col` (merged → "merged", closed → "closed", manual → "manual").
    const seen: string[] = [];
    const mkEnv = () =>
      ({
        DB: {
          prepare: (sql: string) => {
            seen.push(sql);
            return { bind: () => ({ run: async () => undefined }) };
          },
        },
      }) as unknown as Env;

    await recordSubmissionOutcome(mkEnv(), "p", "u", "merged");
    expect(seen[0]).toContain(", merged, last_seen)");
    expect(seen[0]).toContain("submissions = submitter_stats.submissions + 1");
    expect(seen[0]).toContain("merged = submitter_stats.merged + 1");

    seen.length = 0;
    await recordSubmissionOutcome(mkEnv(), "p", "u", "closed");
    expect(seen[0]).toContain(", closed, last_seen)");
    expect(seen[0]).toContain("submissions = submitter_stats.submissions + 1");
    expect(seen[0]).toContain("closed = submitter_stats.closed + 1");

    seen.length = 0;
    await recordSubmissionOutcome(mkEnv(), "p", "u", "manual");
    expect(seen[0]).toContain(", manual, last_seen)");
    expect(seen[0]).toContain("submissions = submitter_stats.submissions + 1");
    expect(seen[0]).toContain("manual = submitter_stats.manual + 1");
  });

  it("recordSubmissionOutcome swallows a DB error fail-safe (logs, never throws)", async () => {
    // Exercises the catch path (the console.log fail-safe branch) — a throwing .run() must degrade to a no-op.
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            run: async () => {
              throw new Error("D1 write boom");
            },
          }),
        }),
      },
    } as unknown as Env;
    await expect(recordSubmissionOutcome(env, "p", "u", "merged")).resolves.toBeUndefined();
  });

  it("getSubmitterReputation → neutral with no submitter (early return guard)", async () => {
    // The `if (!submitter) return neutral` early-return branch: undefined submitter never touches the DB.
    const rep = await getSubmitterReputation({} as Env, "p", undefined);
    expect(rep).toEqual({ submissions: 0, merged: 0, closed: 0, manual: 0, closeRate: 0, signal: "neutral" });
  });

  it("getSubmitterReputation → neutral when the window query returns a malformed result (?? [] fallback)", async () => {
    // `.all()` resolves to undefined (no `results` key) → `result?.results ?? []` takes the `?? []` fallback,
    // so countOutcomes sees an empty list and the signal degrades to neutral — never throws.
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => ({ submissions: 3, merged: 2, closed: 1, manual: 0 }),
            all: async () => undefined,
          }),
        }),
      },
    } as unknown as Env;
    const rep = await getSubmitterReputation(env, "p", "u");
    expect(rep.signal).toBe("neutral");
    expect(rep.closeRate).toBeCloseTo(1 / 3); // closed 1 / (merged 2 + closed 1)
  });
});

describe("computeSubmissionCadence (pure) (#4514)", () => {
  it("returns count and null medianGapMs for 0 or 1 samples (nothing to measure a gap between)", () => {
    expect(computeSubmissionCadence([])).toEqual({ count: 0, medianGapMs: null });
    expect(computeSubmissionCadence(["2026-01-01T00:00:00.000Z"])).toEqual({ count: 1, medianGapMs: null });
  });

  it("computes the median gap between consecutive submissions, order-independent", () => {
    // Gaps: 10min, 20min, 30min -> sorted [10,20,30] -> median 20min.
    const t0 = new Date("2026-01-01T00:00:00.000Z").getTime();
    const timestamps = [t0, t0 + 10 * 60_000, t0 + 30 * 60_000, t0 + 60 * 60_000].map((ms) => new Date(ms).toISOString());
    // Shuffle the input order -- the function must sort internally, not assume caller ordering.
    const shuffled = [timestamps[2]!, timestamps[0]!, timestamps[3]!, timestamps[1]!];
    expect(computeSubmissionCadence(shuffled)).toEqual({ count: 4, medianGapMs: 20 * 60_000 });
  });

  it("averages the two middle gaps for an even number of gaps", () => {
    // 3 timestamps -> 2 gaps: 10min, 30min -> even count -> average = 20min.
    const t0 = new Date("2026-01-01T00:00:00.000Z").getTime();
    const timestamps = [t0, t0 + 10 * 60_000, t0 + 40 * 60_000].map((ms) => new Date(ms).toISOString());
    expect(computeSubmissionCadence(timestamps)).toEqual({ count: 3, medianGapMs: 20 * 60_000 });
  });
});

describe("isMachinePacedCadence (pure) (#4514)", () => {
  it("requires BOTH the minimum sample size AND a sub-threshold median gap", () => {
    // Below minSample (5) -- fast, but not enough samples to call it a pattern.
    expect(isMachinePacedCadence({ count: 4, medianGapMs: 60_000 })).toBe(false);
    // Enough samples, but the gap is comfortably human (well over 10min).
    expect(isMachinePacedCadence({ count: 10, medianGapMs: 60 * 60_000 })).toBe(false);
    // No gap at all to measure (count < 2 internally, or explicitly null).
    expect(isMachinePacedCadence({ count: 8, medianGapMs: null })).toBe(false);
    // Enough samples AND a tight gap -- machine-paced.
    expect(isMachinePacedCadence({ count: 5, medianGapMs: 5 * 60_000 })).toBe(true);
    expect(isMachinePacedCadence({ count: 20, medianGapMs: 60_000 })).toBe(true);
  });

  it("is a boundary at exactly the configured thresholds", () => {
    // Exactly at minSample, exactly under the max gap -- still counts.
    expect(isMachinePacedCadence({ count: 5, medianGapMs: 10 * 60_000 - 1 })).toBe(true);
    // Exactly AT the max gap -- not strictly under, so not machine-paced.
    expect(isMachinePacedCadence({ count: 5, medianGapMs: 10 * 60_000 })).toBe(false);
  });
});

describe("getSubmitterCadence (D1, fail-safe) (#4514)", () => {
  function makeCadenceEnv(createdAts: string[]): Env {
    return {
      DB: {
        prepare: () => ({
          bind: () => ({
            all: async () => ({ results: createdAts.map((createdAt) => ({ createdAt })) }),
          }),
        }),
      },
    } as unknown as Env;
  }

  it("returns count 0 / null with no submitter (early return, no DB touch)", async () => {
    expect(await getSubmitterCadence({} as Env, "p", undefined)).toEqual({ count: 0, medianGapMs: null });
  });

  it("derives cadence from the queried created_at timestamps", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z").getTime();
    const env = makeCadenceEnv([t0, t0 + 5 * 60_000, t0 + 10 * 60_000, t0 + 15 * 60_000, t0 + 20 * 60_000].map((ms) => new Date(ms).toISOString()));
    const cadence = await getSubmitterCadence(env, "p", "farmer99");
    expect(cadence).toEqual({ count: 5, medianGapMs: 5 * 60_000 });
    expect(isMachinePacedCadence(cadence)).toBe(true);
  });

  it("fail-safe: degrades to count 0 / null when the query throws, never throws into the caller", async () => {
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            all: async () => {
              throw new Error("D1 boom");
            },
          }),
        }),
      },
    } as unknown as Env;
    expect(await getSubmitterCadence(env, "p", "farmer99")).toEqual({ count: 0, medianGapMs: null });
  });

  it("fail-safe: degrades to count 0 / null when the query returns a malformed result (?? [] fallback)", async () => {
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            all: async () => undefined,
          }),
        }),
      },
    } as unknown as Env;
    expect(await getSubmitterCadence(env, "p", "farmer99")).toEqual({ count: 0, medianGapMs: null });
  });
});

// A minimal D1 stub: the first query (.first) returns submitter_stats; the window query (.all) returns the
// review_targets rows. Both come off the same prepared-statement stub (the two call sites use .first vs .all).
function makeEnv(opts: { statRow: { submissions: number; merged: number; closed: number; manual: number } | null; windowRows: Row[] }): Env {
  return {
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => opts.statRow,
          all: async () => ({ results: opts.windowRows.map((r) => ({ status: r.status, reasonCode: r.reasonCode })) }),
        }),
      }),
    },
  } as unknown as Env;
}
