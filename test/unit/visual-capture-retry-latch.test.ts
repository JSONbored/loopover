// #9876: the visual-capture retry latch must be releasable by TIME, not only by code paths.
//
// The regression these tests pin is not a wrong branch, it is an unreachable one: twice, the code that
// released this latch could not run in production, and both times a PR froze permanently because the gate
// could neither close nor pass it. So the cases below deliberately assert the ABSENCE of a live latch in every
// state that is not a genuinely-in-flight retry -- including the states a reasonable reading would call
// "unknown" (no timestamp, unparseable timestamp), because "unknown" resolving to "live" is precisely the
// freeze.
import { describe, expect, it } from "vitest";
import {
  visualCaptureRetryLatchState,
  VISUAL_CAPTURE_RETRY_LATCH_MAX_AGE_MS,
} from "../../src/review/visual/visual-capture-retry-latch";
import { MAX_PREVIEW_POLL_ATTEMPTS, PREVIEW_POLL_SECONDS } from "../../src/review/visual/preview-poll-budget";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const NOW = Date.parse("2026-07-29T18:00:00.000Z");
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

describe("visualCaptureRetryLatchState", () => {
  it("is live while a retry for this exact head is plausibly still in flight", () => {
    expect(visualCaptureRetryLatchState({ latchSha: HEAD, latchAtIso: iso(-60_000), headSha: HEAD, nowMs: NOW })).toEqual({ live: true });
  });

  it("is absent when no latch was ever recorded", () => {
    expect(visualCaptureRetryLatchState({ latchSha: null, latchAtIso: null, headSha: HEAD, nowMs: NOW })).toEqual({
      live: false,
      reason: "absent",
    });
  });

  it("is absent when the latch was recorded against a head that has since been superseded", () => {
    // A new commit re-arms the screenshot requirement from scratch, so the old head's latch must not defer the
    // gate for the new one.
    expect(visualCaptureRetryLatchState({ latchSha: OTHER, latchAtIso: iso(-1000), headSha: HEAD, nowMs: NOW })).toEqual({
      live: false,
      reason: "absent",
    });
  });

  it("is absent when the PR has no head SHA at all", () => {
    expect(visualCaptureRetryLatchState({ latchSha: HEAD, latchAtIso: iso(-1000), headSha: null, nowMs: NOW })).toEqual({
      live: false,
      reason: "absent",
    });
  });

  it("expires once the latch is older than any retry chain could be", () => {
    const state = visualCaptureRetryLatchState({
      latchSha: HEAD,
      latchAtIso: iso(-VISUAL_CAPTURE_RETRY_LATCH_MAX_AGE_MS - 1),
      headSha: HEAD,
      nowMs: NOW,
    });
    expect(state.live).toBe(false);
    expect(state).toMatchObject({ reason: "expired" });
  });

  it("expires exactly AT the deadline, not one tick after it", () => {
    // Pins the boundary as >=, so a latch sitting precisely on the deadline releases rather than surviving
    // another whole evaluation cycle.
    expect(
      visualCaptureRetryLatchState({ latchSha: HEAD, latchAtIso: iso(-VISUAL_CAPTURE_RETRY_LATCH_MAX_AGE_MS), headSha: HEAD, nowMs: NOW }),
    ).toEqual({ live: false, reason: "expired", ageMs: VISUAL_CAPTURE_RETRY_LATCH_MAX_AGE_MS });
  });

  it("stays live one millisecond before the deadline", () => {
    expect(
      visualCaptureRetryLatchState({
        latchSha: HEAD,
        latchAtIso: iso(-VISUAL_CAPTURE_RETRY_LATCH_MAX_AGE_MS + 1),
        headSha: HEAD,
        nowMs: NOW,
      }),
    ).toEqual({ live: true });
  });

  it("reports the latch's real age when it expires", () => {
    const ageMs = VISUAL_CAPTURE_RETRY_LATCH_MAX_AGE_MS + 90_000;
    expect(visualCaptureRetryLatchState({ latchSha: HEAD, latchAtIso: iso(-ageMs), headSha: HEAD, nowMs: NOW })).toEqual({
      live: false,
      reason: "expired",
      ageMs,
    });
  });

  it("treats a latch with NO timestamp as expired, not live", () => {
    // The rows that were already frozen when this column shipped are exactly the rows with a sha and no
    // timestamp. Defaulting them to "live" would have preserved the freeze for the only PRs that needed it
    // lifted, so this is the case the whole migration exists for.
    expect(visualCaptureRetryLatchState({ latchSha: HEAD, latchAtIso: null, headSha: HEAD, nowMs: NOW })).toEqual({
      live: false,
      reason: "expired",
      ageMs: VISUAL_CAPTURE_RETRY_LATCH_MAX_AGE_MS,
    });
  });

  it("treats an unparseable timestamp as expired, not live", () => {
    expect(visualCaptureRetryLatchState({ latchSha: HEAD, latchAtIso: "not-a-date", headSha: HEAD, nowMs: NOW })).toEqual({
      live: false,
      reason: "expired",
      ageMs: VISUAL_CAPTURE_RETRY_LATCH_MAX_AGE_MS,
    });
  });

  it("keeps a future-dated latch live with a clamped age of zero", () => {
    // Clock skew between an ORB and its database must not produce a negative age (which would still be < the
    // deadline and so read live, but by accident rather than by intent).
    expect(visualCaptureRetryLatchState({ latchSha: HEAD, latchAtIso: iso(5 * 60_000), headSha: HEAD, nowMs: NOW })).toEqual({ live: true });
  });

  it("derives the deadline from the retry budget, so neither can drift from the other", () => {
    // The bound is only defensible if it is longer than the chain it bounds. Asserting the relationship rather
    // than the literal keeps that true when either budget dimension is retuned.
    const longestPossibleChainMs = MAX_PREVIEW_POLL_ATTEMPTS * PREVIEW_POLL_SECONDS * 1000;
    expect(VISUAL_CAPTURE_RETRY_LATCH_MAX_AGE_MS).toBeGreaterThan(longestPossibleChainMs);
    expect(VISUAL_CAPTURE_RETRY_LATCH_MAX_AGE_MS % longestPossibleChainMs).toBe(0);
  });
});
