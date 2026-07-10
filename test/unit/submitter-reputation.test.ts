import { describe, expect, it } from "vitest";
import {
  classifyOutcome,
  classifySubmissionCadence,
  countOutcomes,
  DEFAULT_REPUTATION_CONFIG,
  getSubmitterReputation,
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

const MINUTE = 60_000;

describe("classifySubmissionCadence — median inter-arrival gap (#4514)", () => {
  it("computes the median gap from ascending timestamps and flags a superhuman-pace outlier", () => {
    // 5 submissions, 4 gaps of exactly 5 minutes each: median 5 <= default 15-minute outlier bar.
    const base = 1_700_000_000_000;
    const timestamps = [0, 1, 2, 3, 4].map((i) => base + i * 5 * MINUTE);
    const cadence = classifySubmissionCadence(timestamps);
    expect(cadence).toEqual({ sampleGaps: 4, medianGapMinutes: 5, isOutlier: true });
  });

  it("sorts unsorted input internally before computing gaps", () => {
    const base = 1_700_000_000_000;
    const ascending = [0, 1, 2, 3, 4].map((i) => base + i * 5 * MINUTE);
    const shuffled = [ascending[2]!, ascending[0]!, ascending[4]!, ascending[1]!, ascending[3]!];
    expect(classifySubmissionCadence(shuffled)).toEqual(classifySubmissionCadence(ascending));
  });

  it("a normal human cadence (well above the outlier bar) is not flagged", () => {
    const base = 1_700_000_000_000;
    // 4 gaps of 3 hours each — nowhere near the 15-minute default bar.
    const timestamps = [0, 1, 2, 3, 4].map((i) => base + i * 3 * 60 * MINUTE);
    const cadence = classifySubmissionCadence(timestamps);
    expect(cadence.isOutlier).toBe(false);
    expect(cadence.medianGapMinutes).toBe(180);
  });

  it("too few gaps (below cadenceMinGaps) never reports an outlier, even at an extreme pace", () => {
    const base = 1_700_000_000_000;
    // 3 submissions, 2 gaps of 1 minute each: default cadenceMinGaps is 4, so this sample is too small.
    const timestamps = [base, base + MINUTE, base + 2 * MINUTE];
    const cadence = classifySubmissionCadence(timestamps);
    expect(cadence.sampleGaps).toBe(2);
    expect(cadence.isOutlier).toBe(false);
    expect(cadence.medianGapMinutes).toBe(1);
  });

  it("reports a null medianGapMinutes for 0 or 1 timestamps (no computable gap)", () => {
    expect(classifySubmissionCadence([])).toEqual({ sampleGaps: 0, medianGapMinutes: null, isOutlier: false });
    expect(classifySubmissionCadence([1_700_000_000_000])).toEqual({
      sampleGaps: 0,
      medianGapMinutes: null,
      isOutlier: false,
    });
  });

  it("computes an even-length median as the average of the two middle gaps", () => {
    const base = 1_700_000_000_000;
    // Gaps (minutes): 2, 4, 6, 8, 10, 12 (6 gaps, 7 timestamps) -> sorted median = avg(6, 8) = 7.
    let cursor = base;
    const gapsMinutes = [2, 4, 6, 8, 10, 12];
    const timestamps = [cursor];
    for (const gap of gapsMinutes) {
      cursor += gap * MINUTE;
      timestamps.push(cursor);
    }
    const cadence = classifySubmissionCadence(timestamps);
    expect(cadence.sampleGaps).toBe(6);
    expect(cadence.medianGapMinutes).toBe(7);
    expect(cadence.isOutlier).toBe(true); // 7 <= the default 15-minute outlier bar
  });

  it("computes an odd-length median as the single middle gap", () => {
    const base = 1_700_000_000_000;
    // Gaps (minutes): 10, 20, 30, 40, 50 (5 gaps, 6 timestamps) -> sorted median (middle of 5) = 30.
    let cursor = base;
    const timestamps = [cursor];
    for (const gap of [10, 20, 30, 40, 50]) {
      cursor += gap * MINUTE;
      timestamps.push(cursor);
    }
    const cadence = classifySubmissionCadence(timestamps);
    expect(cadence.sampleGaps).toBe(5);
    expect(cadence.medianGapMinutes).toBe(30);
    expect(cadence.isOutlier).toBe(false); // 30 > the default 15-minute outlier bar
  });

  it("respects a custom config's cadenceMinGaps and cadenceOutlierMedianGapMinutes", () => {
    const base = 1_700_000_000_000;
    const timestamps = [0, 1, 2].map((i) => base + i * 20 * MINUTE); // 2 gaps of 20 minutes
    const strictConfig: ReputationConfig = { ...DEFAULT_REPUTATION_CONFIG, cadenceMinGaps: 2, cadenceOutlierMedianGapMinutes: 25 };
    expect(classifySubmissionCadence(timestamps, strictConfig)).toEqual({
      sampleGaps: 2,
      medianGapMinutes: 20,
      isOutlier: true, // 20 <= 25 under the widened custom bar, and the sample now clears cadenceMinGaps: 2
    });
    // The SAME timestamps against the default config (cadenceMinGaps: 4) are too small a sample to call.
    expect(classifySubmissionCadence(timestamps).isOutlier).toBe(false);
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

describe("signalFromCounts — cadence tie-breaker, never independent (#4514)", () => {
  // success=1, qualityFail=2, qualityFailLight=2: sample 5, weightedFails 2+1=3, failRate 0.6 -- between the
  // cadence-assist bar (0.5) and the hard low bar (0.7), with success (1) below qualityFailLowMaxSuccess (2).
  const borderlineCounts = () => countOutcomes(rows(["merged", "dual_review_approved", 1], ["closed", "dual_review_declined", 2], ["closed", "checks_failed", 2]));

  it("without cadence, the borderline fail rate stays neutral (the existing baseline)", () => {
    expect(signalFromCounts(borderlineCounts())).toBe("neutral");
  });

  it("a cadence outlier tips the SAME borderline fail rate to 'low'", () => {
    expect(signalFromCounts(borderlineCounts(), DEFAULT_REPUTATION_CONFIG, { sampleGaps: 4, medianGapMinutes: 5, isOutlier: true })).toBe("low");
  });

  it("a non-outlier cadence verdict leaves the borderline case neutral (no change)", () => {
    expect(signalFromCounts(borderlineCounts(), DEFAULT_REPUTATION_CONFIG, { sampleGaps: 4, medianGapMinutes: 180, isOutlier: false })).toBe("neutral");
  });

  it("a cadence outlier NEVER penalizes a well-calibrated actor on its own (success guard + low fail rate hold)", () => {
    // 6 successes, 1 genuine decline: failRate 1/7 ~= 0.14, well under BOTH the assist (0.5) and hard (0.7)
    // bars, and success (6) clears the trusted bar -- an outlier cadence verdict must not touch this.
    const wellCalibrated = countOutcomes(rows(["merged", "dual_review_approved", 6], ["closed", "dual_review_declined", 1]));
    expect(signalFromCounts(wellCalibrated, DEFAULT_REPUTATION_CONFIG, { sampleGaps: 10, medianGapMinutes: 1, isOutlier: true })).toBe("trusted");
  });

  it("a cadence outlier does not affect an already-'low' or already-'trusted' verdict (falls through fine)", () => {
    // Already 'low' via the existing hard rule regardless of cadence.
    const alreadyLow = countOutcomes(rows(["merged", "dual_review_approved", 1], ["closed", "dual_review_declined", 7]));
    expect(signalFromCounts(alreadyLow, DEFAULT_REPUTATION_CONFIG, { sampleGaps: 10, medianGapMinutes: 500, isOutlier: false })).toBe("low");
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

  it("cadence (#4514): a superhuman-pace createdAt spread tips an already-borderline fail rate to low", async () => {
    // Same borderline shape as the pure signalFromCounts cadence test: 1 success, 2 declines, 2 checks_failed
    // (failRate 0.6 -- between the assist and hard bars), but every row is 5 minutes apart -> cadence outlier.
    const base = new Date("2026-07-01T00:00:00.000Z").getTime();
    const windowRows = [
      { status: "merged", reasonCode: "dual_review_approved", createdAt: new Date(base).toISOString() },
      { status: "closed", reasonCode: "dual_review_declined", createdAt: new Date(base + 5 * MINUTE).toISOString() },
      { status: "closed", reasonCode: "dual_review_declined", createdAt: new Date(base + 10 * MINUTE).toISOString() },
      { status: "closed", reasonCode: "checks_failed", createdAt: new Date(base + 15 * MINUTE).toISOString() },
      { status: "closed", reasonCode: "checks_failed", createdAt: new Date(base + 20 * MINUTE).toISOString() },
    ];
    const env = makeEnv({ statRow: { submissions: 5, merged: 1, closed: 4, manual: 0 }, windowRows });
    const rep = await getSubmitterReputation(env, "p", "u");
    expect(rep.signal).toBe("low");
  });

  it("cadence (#4514): the SAME borderline shape at a normal human cadence stays neutral", async () => {
    const base = new Date("2026-07-01T00:00:00.000Z").getTime();
    const windowRows = [
      { status: "merged", reasonCode: "dual_review_approved", createdAt: new Date(base).toISOString() },
      { status: "closed", reasonCode: "dual_review_declined", createdAt: new Date(base + 5 * 60 * MINUTE).toISOString() },
      { status: "closed", reasonCode: "dual_review_declined", createdAt: new Date(base + 10 * 60 * MINUTE).toISOString() },
      { status: "closed", reasonCode: "checks_failed", createdAt: new Date(base + 15 * 60 * MINUTE).toISOString() },
      { status: "closed", reasonCode: "checks_failed", createdAt: new Date(base + 20 * 60 * MINUTE).toISOString() },
    ];
    const env = makeEnv({ statRow: { submissions: 5, merged: 1, closed: 4, manual: 0 }, windowRows });
    const rep = await getSubmitterReputation(env, "p", "u");
    expect(rep.signal).toBe("neutral");
  });

  it("cadence (#4514): a missing/unparseable createdAt is dropped, not treated as a zero-gap outlier", async () => {
    const windowRows = rows(["merged", "dual_review_approved", 1], ["closed", "dual_review_declined", 2], ["closed", "checks_failed", 2]);
    // No createdAt on any row (the existing Row shape) -> makeEnv defaults createdAt to null for all of them.
    const env = makeEnv({ statRow: { submissions: 5, merged: 1, closed: 4, manual: 0 }, windowRows });
    const rep = await getSubmitterReputation(env, "p", "u");
    expect(rep.signal).toBe("neutral"); // same borderline shape, but no usable cadence data -> unaffected
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

// A minimal D1 stub: the first query (.first) returns submitter_stats; the window query (.all) returns the
// review_targets rows. Both come off the same prepared-statement stub (the two call sites use .first vs .all).
function makeEnv(opts: {
  statRow: { submissions: number; merged: number; closed: number; manual: number } | null;
  windowRows: Array<Row & { createdAt?: string | null }>;
}): Env {
  return {
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => opts.statRow,
          all: async () => ({
            results: opts.windowRows.map((r) => ({ status: r.status, reasonCode: r.reasonCode, createdAt: r.createdAt ?? null })),
          }),
        }),
      }),
    },
  } as unknown as Env;
}
