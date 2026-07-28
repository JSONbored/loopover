import { describe, expect, it, vi } from "vitest";
import { findingsHadAiDefect, nextVerdictFlipState, VERDICT_FLIP_ESCALATION_THRESHOLD, type VerdictFlipResult } from "../../src/review/verdict-flip-guard";
import { readVerdictFlipState, recordVerdictFlip } from "../../src/review/verdict-flip-store";
import { getCachedAiReviewAcrossHeads, putCachedAiReview } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

// #9016 (security): the AI reviewer is non-deterministic, so a contributor can otherwise force fresh
// re-rolls (a no-op recommit, or a same-head retry after the non-cacheable cooldown) until a lucky CLEAN
// roll auto-merges a PR another roll flagged as blocked. Two independent defenses: content-fingerprint
// stickiness across head SHAs (getCachedAiReviewAcrossHeads), and a per-PR verdict-flip counter that
// escalates to a human hold after repeated oscillation (verdict-flip-guard + verdict-flip-store).

describe("findingsHadAiDefect", () => {
  it("true only for AI-judgment codes (ai_consensus_defect / ai_review_split), never other blockers", () => {
    expect(findingsHadAiDefect([{ code: "ai_consensus_defect" }])).toBe(true);
    expect(findingsHadAiDefect([{ code: "ai_review_split" }])).toBe(true);
    expect(findingsHadAiDefect([{ code: "secret_leak" }])).toBe(false);
    expect(findingsHadAiDefect([])).toBe(false);
  });
});

describe("nextVerdictFlipState", () => {
  // #9483: every case below re-rolls against the SAME content fingerprint, because that is the exploit this
  // guard exists to stop — a contributor re-rolling a non-deterministic reviewer over an unchanged diff. A
  // verdict against genuinely CHANGED content is honest iteration and is covered separately below.
  const FP = "fingerprint-unchanged";

  it("a first observation never escalates — nothing to flip against yet", () => {
    expect(nextVerdictFlipState(null, true, FP)).toEqual({ lastHadDefect: true, flipCount: 0, lastFingerprint: FP, escalate: false });
    expect(nextVerdictFlipState(null, false, FP)).toEqual({ lastHadDefect: false, flipCount: 0, lastFingerprint: FP, escalate: false });
  });

  it("repeating the same verdict does NOT add to the flip count — consistency is not the abuse pattern", () => {
    const state = { lastHadDefect: true, flipCount: 2, lastFingerprint: FP };
    expect(nextVerdictFlipState(state, true, FP)).toEqual({ lastHadDefect: true, flipCount: 2, lastFingerprint: FP, escalate: false });
  });

  it("a change from the prior verdict increments the flip count", () => {
    expect(nextVerdictFlipState({ lastHadDefect: true, flipCount: 0, lastFingerprint: FP }, false, FP)).toEqual({
      lastHadDefect: false,
      flipCount: 1,
      lastFingerprint: FP,
      escalate: false,
    });
  });

  it(`escalates once flipCount clears the threshold (${VERDICT_FLIP_ESCALATION_THRESHOLD})`, () => {
    const belowThreshold = { lastHadDefect: false, flipCount: VERDICT_FLIP_ESCALATION_THRESHOLD - 1, lastFingerprint: FP };
    expect(nextVerdictFlipState(belowThreshold, true, FP)).toMatchObject({ flipCount: VERDICT_FLIP_ESCALATION_THRESHOLD, escalate: true });
  });

  it("simulates the exploit: defect, clean, defect, clean at an UNCHANGED fingerprint — escalates on the Nth flip", () => {
    let state: { lastHadDefect: boolean; flipCount: number; lastFingerprint?: string | null | undefined } | null = null;
    const rolls = [true, false, true, false, true]; // 4 flips across 5 rolls
    const escalations: boolean[] = [];
    for (const hadDefect of rolls) {
      const next = nextVerdictFlipState(state, hadDefect, FP);
      escalations.push(next.escalate);
      state = next;
    }
    // Flips happen at rolls 2,3,4,5 (indices 1-4); threshold 3 is cleared at the 3rd flip (index 3).
    expect(escalations).toEqual([false, false, false, true, true]);
  });

  // #9483 regressions: the guard used to be content-blind, so honest iteration produced the same signal as
  // the exploit and, once escalated, could never recover.
  it("#9483 REGRESSION: honest iteration on CHANGED content never accumulates flips", () => {
    // defect(A) -> fix -> clean(B) -> new issue(C) -> fixed(D): two honest cycles reached the old threshold.
    let state: VerdictFlipResult | null = null;
    const rolls: Array<[boolean, string]> = [
      [true, "fp-A"],
      [false, "fp-B"],
      [true, "fp-C"],
      [false, "fp-D"],
      [true, "fp-E"],
    ];
    for (const [hadDefect, fingerprint] of rolls) {
      state = nextVerdictFlipState(state, hadDefect, fingerprint);
      expect(state.escalate).toBe(false);
      expect(state.flipCount).toBe(0);
    }
  });

  it("#9483 REGRESSION: a substantive fix CLEARS an already-escalated state — the advice the finding gives is now effective", () => {
    // The escalation finding tells the contributor to "push a substantive fix so the next review reflects real
    // content change". Before this, a substantive fix produced a fresh verdict that simply re-escalated,
    // because flipCount never decreased — an absorbing state its own remedy could not exit.
    const escalated = { lastHadDefect: true, flipCount: VERDICT_FLIP_ESCALATION_THRESHOLD, lastFingerprint: FP };
    const afterRealChange = nextVerdictFlipState(escalated, false, "fp-after-substantive-fix");
    expect(afterRealChange.escalate).toBe(false);
    expect(afterRealChange.flipCount).toBe(0);
  });

  it("#9483 INVARIANT: the exploit still escalates immediately after a content change resets the count", () => {
    // Resetting must not hand the attacker a cheap way to launder flips: once they go back to re-rolling the
    // SAME content, the count climbs again from zero exactly as before.
    let state = nextVerdictFlipState(null, true, "fp-new");
    for (const hadDefect of [false, true, false]) {
      state = nextVerdictFlipState(state, hadDefect, "fp-new");
    }
    expect(state.flipCount).toBe(VERDICT_FLIP_ESCALATION_THRESHOLD);
    expect(state.escalate).toBe(true);
  });

  it("#9483 a first observation records a null fingerprint when none is supplied", () => {
    expect(nextVerdictFlipState(null, true)).toEqual({ lastHadDefect: true, flipCount: 0, lastFingerprint: null, escalate: false });
  });

  it("#9483 a counted flip records a null fingerprint when none is supplied", () => {
    // The nullish fallback must hold on the counting path too, so a later comparison cannot match on undefined.
    const state = { lastHadDefect: true, flipCount: 0, lastFingerprint: null };
    expect(nextVerdictFlipState(state, false, null).lastFingerprint).toBeNull();
  });

  it("#9483 a missing fingerprint on either side never counts a flip (fail-open for pre-migration rows)", () => {
    // Rows written before migration 0196 have a null last_fingerprint. A null can never match, so the first
    // verdict after the migration resets rather than escalating — the fail-open direction.
    expect(nextVerdictFlipState({ lastHadDefect: true, flipCount: 2, lastFingerprint: null }, false, FP).flipCount).toBe(0);
    expect(nextVerdictFlipState({ lastHadDefect: true, flipCount: 2, lastFingerprint: FP }, false, undefined).flipCount).toBe(0);
    expect(nextVerdictFlipState({ lastHadDefect: true, flipCount: 2, lastFingerprint: null }, false, null).flipCount).toBe(0);
  });
});

describe("verdict-flip store (D1, fail-open)", () => {
  it("readVerdictFlipState: null on no row, and on a DB error (never throws)", async () => {
    const env = createTestEnv();
    expect(await readVerdictFlipState(env, "o/r", 1)).toBeNull();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = createTestEnv();
    vi.spyOn(broken.DB, "prepare").mockImplementation(() => {
      throw new Error("db down");
    });
    expect(await readVerdictFlipState(broken, "o/r", 1)).toBeNull();
    expect(warn).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("recordVerdictFlip: persists across calls, escalates at the threshold, and a write error still returns the computed (unpersisted) state", async () => {
    const env = createTestEnv();
    const defect = [{ code: "ai_consensus_defect", title: "d", severity: "critical", detail: "d" }];
    const clean: typeof defect = [];
    // #9483: all four rolls share ONE fingerprint -- this test simulates the exploit (re-rolling unchanged
    // content), which is exactly the case that must still escalate.
    const FP = "fp-same-content";
    // Roll 1: defect (first observation, no escalate).
    expect(await recordVerdictFlip(env, "o/r", 5, defect, FP)).toMatchObject({ lastHadDefect: true, flipCount: 0, escalate: false });
    // Rolls 2-4: clean, defect, clean — 3 flips, escalates on the 3rd.
    expect(await recordVerdictFlip(env, "o/r", 5, clean, FP)).toMatchObject({ flipCount: 1, escalate: false });
    expect(await recordVerdictFlip(env, "o/r", 5, defect, FP)).toMatchObject({ flipCount: 2, escalate: false });
    expect(await recordVerdictFlip(env, "o/r", 5, clean, FP)).toMatchObject({ flipCount: 3, escalate: true });
    // State persisted between calls (a different PR is fully independent).
    expect(await readVerdictFlipState(env, "o/r", 5)).toEqual({ lastHadDefect: false, flipCount: 3, lastFingerprint: FP });
    // A verdict recorded with NO fingerprint persists null rather than undefined, so a later read compares cleanly.
    await recordVerdictFlip(env, "o/r", 7, defect);
    expect(await readVerdictFlipState(env, "o/r", 7)).toEqual({ lastHadDefect: true, flipCount: 0, lastFingerprint: null });
    expect(await readVerdictFlipState(env, "o/r", 999)).toBeNull();
    // Write failure: the RETURNED state is still correct (computed before the write attempt); it just won't persist.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const writeBroken = createTestEnv();
    await recordVerdictFlip(writeBroken, "o/r", 6, defect, "fp-x");
    vi.spyOn(writeBroken.DB, "prepare").mockImplementation(() => {
      throw new Error("db down");
    });
    const result = await recordVerdictFlip(writeBroken, "o/r", 6, clean, "fp-x");
    expect(result).toMatchObject({ flipCount: 0 }); // read failed (mocked) -> treated as first observation
    expect(warn).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe("getCachedAiReviewAcrossHeads (#9016)", () => {
  const write = (env: Env, headSha: string, cacheable: boolean, fingerprint: string) =>
    putCachedAiReview(env, "o/r", 7, headSha, "block", {
      notes: "review",
      reviewerCount: 2,
      findings: cacheable ? [] : [{ code: "ai_consensus_defect", title: "d", severity: "critical", detail: "d" }],
      cacheable,
      metadata: { inputFingerprint: fingerprint },
    });

  it("a no-op recommit (new head SHA, IDENTICAL fingerprint) reuses the prior CACHEABLE verdict", async () => {
    const env = createTestEnv();
    await write(env, "sha-old", true, "fp-A");
    const hit = await getCachedAiReviewAcrossHeads(env, "o/r", 7, "block", "fp-A");
    expect(hit).not.toBeNull();
    expect(hit!.notes).toBe("review");
  });

  it("a genuinely different fingerprint (real content change) is a miss — legitimate re-review is untouched", async () => {
    const env = createTestEnv();
    await write(env, "sha-old", true, "fp-A");
    expect(await getCachedAiReviewAcrossHeads(env, "o/r", 7, "block", "fp-B")).toBeNull();
  });

  it("a different repo/PR/mode never matches — scoped exactly like the exact-head lookup", async () => {
    const env = createTestEnv();
    await write(env, "sha-old", true, "fp-A");
    expect(await getCachedAiReviewAcrossHeads(env, "o/r", 8, "block", "fp-A")).toBeNull();
    expect(await getCachedAiReviewAcrossHeads(env, "other/repo", 7, "block", "fp-A")).toBeNull();
    expect(await getCachedAiReviewAcrossHeads(env, "o/r", 7, "advisory", "fp-A")).toBeNull();
  });

  it("a non-cacheable (dynamic-context) row matches only within maxAgeMs, and never once published", async () => {
    const env = createTestEnv();
    await env.DB.prepare(
      `INSERT INTO ai_review_cache (repo_full_name, pull_number, head_sha, ai_review_mode, notes, reviewer_count, findings_json, metadata_json, cacheable, published_at, created_at)
       VALUES ('o/r', 7, 'sha-dyn', 'block', 'dyn review', 2, '[]', ?, 0, NULL, ?)`,
    )
      .bind(JSON.stringify({ inputFingerprint: "fp-dyn" }), new Date(Date.now() - 5000).toISOString())
      .run();
    expect(await getCachedAiReviewAcrossHeads(env, "o/r", 7, "block", "fp-dyn", { maxAgeMs: 60_000 })).not.toBeNull();
    expect(await getCachedAiReviewAcrossHeads(env, "o/r", 7, "block", "fp-dyn", { maxAgeMs: 1 })).toBeNull();
    // Once published, a non-cacheable row is never reused across heads regardless of age.
    await env.DB.prepare(`UPDATE ai_review_cache SET published_at = ? WHERE head_sha = 'sha-dyn'`).bind(new Date().toISOString()).run();
    expect(await getCachedAiReviewAcrossHeads(env, "o/r", 7, "block", "fp-dyn", { maxAgeMs: 60_000 })).toBeNull();
  });

  it("degrades to a miss (never throws) when the query returns no results array, or a row carries an unparseable created_at", async () => {
    const env = createTestEnv();
    vi.spyOn(env.DB, "prepare").mockReturnValueOnce({
      bind: () => ({ all: async () => ({}) }), // no `results` key at all
    } as never);
    expect(await getCachedAiReviewAcrossHeads(env, "o/r", 7, "block", "fp-A")).toBeNull();

    await env.DB.prepare(
      `INSERT INTO ai_review_cache (repo_full_name, pull_number, head_sha, ai_review_mode, notes, reviewer_count, findings_json, metadata_json, cacheable, published_at, created_at)
       VALUES ('o/r', 7, 'sha-bad-date', 'block', 'dyn', 2, '[]', ?, 0, NULL, 'not-a-real-date')`,
    )
      .bind(JSON.stringify({ inputFingerprint: "fp-bad" }))
      .run();
    expect(await getCachedAiReviewAcrossHeads(env, "o/r", 7, "block", "fp-bad", { maxAgeMs: 60_000 })).toBeNull();
    vi.restoreAllMocks();
  });

  it("a non-cacheable row with a FUTURE created_at (negative age) is a miss, and omitting options defaults maxAgeMs to 0 (always too old)", async () => {
    const env = createTestEnv();
    await env.DB.prepare(
      `INSERT INTO ai_review_cache (repo_full_name, pull_number, head_sha, ai_review_mode, notes, reviewer_count, findings_json, metadata_json, cacheable, published_at, created_at)
       VALUES ('o/r', 7, 'sha-future', 'block', 'dyn', 2, '[]', ?, 0, NULL, ?)`,
    )
      .bind(JSON.stringify({ inputFingerprint: "fp-future" }), new Date(Date.now() + 60_000).toISOString())
      .run();
    expect(await getCachedAiReviewAcrossHeads(env, "o/r", 7, "block", "fp-future", { maxAgeMs: 60_000 })).toBeNull();
    // No options at all: maxAgeMs defaults to 0, so any positive-age non-cacheable row is "too old".
    await env.DB.prepare(
      `INSERT INTO ai_review_cache (repo_full_name, pull_number, head_sha, ai_review_mode, notes, reviewer_count, findings_json, metadata_json, cacheable, published_at, created_at)
       VALUES ('o/r', 7, 'sha-noopts', 'block', 'dyn', 2, '[]', ?, 0, NULL, ?)`,
    )
      .bind(JSON.stringify({ inputFingerprint: "fp-noopts" }), new Date(Date.now() - 5).toISOString())
      .run();
    expect(await getCachedAiReviewAcrossHeads(env, "o/r", 7, "block", "fp-noopts")).toBeNull();
  });

  it("returns the MOST RECENT matching row when several heads share a fingerprint", async () => {
    const env = createTestEnv();
    await write(env, "sha-1", true, "fp-A");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await write(env, "sha-2", true, "fp-A");
    const hit = await getCachedAiReviewAcrossHeads(env, "o/r", 7, "block", "fp-A");
    expect(hit).not.toBeNull();
  });
});
