import { describe, expect, it } from "vitest";
import { MERGE_TRAIN_MAX_WAIT_MS, shouldWaitForOlderSiblings, type MergeTrainSibling } from "../../src/review/merge-train";

const NOW = Date.parse("2026-07-07T12:00:00.000Z");
const sibling = (number: number, createdAt: string | null | undefined, mergeableState?: string | null): MergeTrainSibling => ({
  number,
  createdAt,
  mergeableState,
});

describe("shouldWaitForOlderSiblings (#selfhost-merge-train)", () => {
  it("waits for a genuinely older, viable sibling (by createdAt)", () => {
    const siblings = [sibling(105, "2026-07-07T10:00:00.000Z")];
    expect(shouldWaitForOlderSiblings(110, "2026-07-07T11:00:00.000Z", siblings, NOW)).toEqual({ wait: true, blockingPr: 105 });
  });

  it("does not wait for a NEWER sibling (by createdAt)", () => {
    const siblings = [sibling(115, "2026-07-07T11:30:00.000Z")];
    expect(shouldWaitForOlderSiblings(110, "2026-07-07T11:00:00.000Z", siblings, NOW)).toEqual({ wait: false });
  });

  it("does not wait when there are no other open siblings", () => {
    expect(shouldWaitForOlderSiblings(110, "2026-07-07T11:00:00.000Z", [], NOW)).toEqual({ wait: false });
  });

  it("never counts itself as its own blocking sibling", () => {
    const siblings = [sibling(110, "2026-07-07T09:00:00.000Z")];
    expect(shouldWaitForOlderSiblings(110, "2026-07-07T11:00:00.000Z", siblings, NOW)).toEqual({ wait: false });
  });

  it("a git-conflicted older sibling never blocks — it is stuck, not about to merge", () => {
    const siblings = [sibling(105, "2026-07-07T10:00:00.000Z", "dirty")];
    expect(shouldWaitForOlderSiblings(110, "2026-07-07T11:00:00.000Z", siblings, NOW)).toEqual({ wait: false });
  });

  it("a non-dirty mergeableState (clean/unknown/unstable) still blocks", () => {
    const siblings = [sibling(105, "2026-07-07T10:00:00.000Z", "unstable")];
    expect(shouldWaitForOlderSiblings(110, "2026-07-07T11:00:00.000Z", siblings, NOW)).toEqual({ wait: true, blockingPr: 105 });
  });

  it("the OLDEST of several viable older siblings is the blocker", () => {
    const siblings = [sibling(107, "2026-07-07T10:30:00.000Z"), sibling(105, "2026-07-07T10:00:00.000Z"), sibling(108, "2026-07-07T10:45:00.000Z")];
    expect(shouldWaitForOlderSiblings(110, "2026-07-07T11:00:00.000Z", siblings, NOW)).toEqual({ wait: true, blockingPr: 105 });
  });

  it("staleness cap: an older sibling past MERGE_TRAIN_MAX_WAIT_MS no longer blocks", () => {
    const staleCreatedAt = new Date(NOW - MERGE_TRAIN_MAX_WAIT_MS - 1000).toISOString();
    const siblings = [sibling(105, staleCreatedAt)];
    expect(shouldWaitForOlderSiblings(110, "2026-07-07T11:00:00.000Z", siblings, NOW)).toEqual({ wait: false });
  });

  it("staleness cap: an older sibling just under the cap still blocks", () => {
    // thisPrCreatedAt is pinned at NOW (not the fixed 11:00:00 literal used elsewhere) so a sibling whose AGE
    // is just under the cap is unambiguously older than this PR too, decoupling "is it stale" from "is it older".
    const freshCreatedAt = new Date(NOW - MERGE_TRAIN_MAX_WAIT_MS + 1000).toISOString();
    const siblings = [sibling(105, freshCreatedAt)];
    expect(shouldWaitForOlderSiblings(110, new Date(NOW).toISOString(), siblings, NOW)).toEqual({ wait: true, blockingPr: 105 });
  });

  it("missing createdAt on the sibling falls back to PR-number tiebreak (lower number = older)", () => {
    const siblings = [sibling(105, null)];
    expect(shouldWaitForOlderSiblings(110, "2026-07-07T11:00:00.000Z", siblings, NOW)).toEqual({ wait: true, blockingPr: 105 });
  });

  it("missing createdAt on the sibling + higher sibling number ⇒ does not block", () => {
    const siblings = [sibling(115, undefined)];
    expect(shouldWaitForOlderSiblings(110, "2026-07-07T11:00:00.000Z", siblings, NOW)).toEqual({ wait: false });
  });

  it("missing createdAt on THIS pr but sibling has one still falls back to PR-number tiebreak", () => {
    const siblings = [sibling(115, "2026-07-07T09:00:00.000Z")];
    expect(shouldWaitForOlderSiblings(110, null, siblings, NOW)).toEqual({ wait: false });
  });

  it("missing createdAt on both sides falls back to PR-number tiebreak", () => {
    const siblings = [sibling(105, undefined)];
    expect(shouldWaitForOlderSiblings(110, undefined, siblings, NOW)).toEqual({ wait: true, blockingPr: 105 });
  });

  it("an exact createdAt tie falls back to PR-number tiebreak", () => {
    const tie = "2026-07-07T11:55:00.000Z"; // recent, well clear of the staleness boundary tested separately above
    const siblings = [sibling(105, tie)];
    expect(shouldWaitForOlderSiblings(110, tie, siblings, NOW)).toEqual({ wait: true, blockingPr: 105 });
  });

  it("an exact createdAt tie with a LOWER-numbered current PR does not block", () => {
    const tie = "2026-07-07T11:55:00.000Z"; // recent, well clear of the staleness boundary tested separately above
    const siblings = [sibling(115, tie)];
    expect(shouldWaitForOlderSiblings(110, tie, siblings, NOW)).toEqual({ wait: false });
  });
});
