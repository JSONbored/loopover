import { describe, expect, it } from "vitest";
import { MERGE_TRAIN_MAX_WAIT_MS, shouldWaitForOlderSiblings, type MergeTrainSibling, type ShouldWaitForOlderSiblingsInput } from "../../src/review/merge-train";

const NOW = Date.parse("2026-07-07T12:00:00.000Z");

// Every sibling defaults to sharing linked issue #1 with "this PR" (see `decide`'s default
// thisPrLinkedIssues below) so the age/staleness/dirty tests below -- none of which are about
// overlap -- don't each have to opt into it separately. Overlap-specific tests override explicitly.
const sibling = (number: number, createdAt: string | null | undefined, mergeableState?: string | null, linkedIssues: readonly number[] = [1]): MergeTrainSibling => ({
  number,
  createdAt,
  mergeableState,
  linkedIssues,
});

function decide(
  thisPrNumber: number,
  thisPrCreatedAt: string | null | undefined,
  siblings: readonly MergeTrainSibling[],
  nowMs: number,
  overrides: Partial<Pick<ShouldWaitForOlderSiblingsInput, "thisPrLinkedIssues" | "thisPrChangedFiles">> = {},
) {
  return shouldWaitForOlderSiblings({
    thisPrNumber,
    thisPrCreatedAt,
    thisPrLinkedIssues: overrides.thisPrLinkedIssues ?? [1],
    thisPrChangedFiles: overrides.thisPrChangedFiles,
    siblings,
    nowMs,
  });
}

describe("shouldWaitForOlderSiblings (#selfhost-merge-train)", () => {
  it("waits for a genuinely older, viable, overlapping sibling (by createdAt)", () => {
    const siblings = [sibling(105, "2026-07-07T10:00:00.000Z")];
    expect(decide(110, "2026-07-07T11:00:00.000Z", siblings, NOW)).toEqual({ wait: true, blockingPr: 105 });
  });

  it("does not wait for a NEWER sibling (by createdAt)", () => {
    const siblings = [sibling(115, "2026-07-07T11:30:00.000Z")];
    expect(decide(110, "2026-07-07T11:00:00.000Z", siblings, NOW)).toEqual({ wait: false });
  });

  it("does not wait when there are no other open siblings", () => {
    expect(decide(110, "2026-07-07T11:00:00.000Z", [], NOW)).toEqual({ wait: false });
  });

  it("never counts itself as its own blocking sibling", () => {
    const siblings = [sibling(110, "2026-07-07T09:00:00.000Z")];
    expect(decide(110, "2026-07-07T11:00:00.000Z", siblings, NOW)).toEqual({ wait: false });
  });

  it("a git-conflicted older sibling never blocks — it is stuck, not about to merge", () => {
    const siblings = [sibling(105, "2026-07-07T10:00:00.000Z", "dirty")];
    expect(decide(110, "2026-07-07T11:00:00.000Z", siblings, NOW)).toEqual({ wait: false });
  });

  it("a non-dirty mergeableState (clean/unknown/unstable) still blocks", () => {
    const siblings = [sibling(105, "2026-07-07T10:00:00.000Z", "unstable")];
    expect(decide(110, "2026-07-07T11:00:00.000Z", siblings, NOW)).toEqual({ wait: true, blockingPr: 105 });
  });

  it("the OLDEST of several viable older siblings is the blocker", () => {
    const siblings = [sibling(107, "2026-07-07T10:30:00.000Z"), sibling(105, "2026-07-07T10:00:00.000Z"), sibling(108, "2026-07-07T10:45:00.000Z")];
    expect(decide(110, "2026-07-07T11:00:00.000Z", siblings, NOW)).toEqual({ wait: true, blockingPr: 105 });
  });

  it("staleness cap: an older sibling past MERGE_TRAIN_MAX_WAIT_MS no longer blocks", () => {
    const staleCreatedAt = new Date(NOW - MERGE_TRAIN_MAX_WAIT_MS - 1000).toISOString();
    const siblings = [sibling(105, staleCreatedAt)];
    expect(decide(110, "2026-07-07T11:00:00.000Z", siblings, NOW)).toEqual({ wait: false });
  });

  it("staleness cap: an older sibling just under the cap still blocks", () => {
    // thisPrCreatedAt is pinned at NOW (not the fixed 11:00:00 literal used elsewhere) so a sibling whose AGE
    // is just under the cap is unambiguously older than this PR too, decoupling "is it stale" from "is it older".
    const freshCreatedAt = new Date(NOW - MERGE_TRAIN_MAX_WAIT_MS + 1000).toISOString();
    const siblings = [sibling(105, freshCreatedAt)];
    expect(decide(110, new Date(NOW).toISOString(), siblings, NOW)).toEqual({ wait: true, blockingPr: 105 });
  });

  it("missing createdAt on the sibling falls back to PR-number tiebreak (lower number = older)", () => {
    const siblings = [sibling(105, null)];
    expect(decide(110, "2026-07-07T11:00:00.000Z", siblings, NOW)).toEqual({ wait: true, blockingPr: 105 });
  });

  it("missing createdAt on the sibling + higher sibling number ⇒ does not block", () => {
    const siblings = [sibling(115, undefined)];
    expect(decide(110, "2026-07-07T11:00:00.000Z", siblings, NOW)).toEqual({ wait: false });
  });

  it("missing createdAt on THIS pr but sibling has one still falls back to PR-number tiebreak", () => {
    const siblings = [sibling(115, "2026-07-07T09:00:00.000Z")];
    expect(decide(110, null, siblings, NOW)).toEqual({ wait: false });
  });

  it("missing createdAt on both sides falls back to PR-number tiebreak", () => {
    const siblings = [sibling(105, undefined)];
    expect(decide(110, undefined, siblings, NOW)).toEqual({ wait: true, blockingPr: 105 });
  });

  it("an exact createdAt tie falls back to PR-number tiebreak", () => {
    const tie = "2026-07-07T11:55:00.000Z"; // recent, well clear of the staleness boundary tested separately above
    const siblings = [sibling(105, tie)];
    expect(decide(110, tie, siblings, NOW)).toEqual({ wait: true, blockingPr: 105 });
  });

  it("an exact createdAt tie with a LOWER-numbered current PR does not block", () => {
    const tie = "2026-07-07T11:55:00.000Z"; // recent, well clear of the staleness boundary tested separately above
    const siblings = [sibling(115, tie)];
    expect(decide(110, tie, siblings, NOW)).toEqual({ wait: false });
  });

  describe("overlap scoping (#selfhost-merge-train-overlap)", () => {
    it("does NOT wait for an older, unrelated sibling (no shared linked issue, no shared file)", () => {
      const siblings = [sibling(105, "2026-07-07T10:00:00.000Z", null, [99])];
      expect(decide(110, "2026-07-07T11:00:00.000Z", siblings, NOW, { thisPrLinkedIssues: [1], thisPrChangedFiles: ["src/a.ts"] })).toEqual({ wait: false });
    });

    it("waits for an older sibling sharing a linked issue, even with no changed-file data on either side", () => {
      const siblings = [sibling(105, "2026-07-07T10:00:00.000Z", null, [42])];
      expect(decide(110, "2026-07-07T11:00:00.000Z", siblings, NOW, { thisPrLinkedIssues: [42] })).toEqual({ wait: true, blockingPr: 105 });
    });

    it("waits for an older sibling sharing a meaningful changed file, even with no linked-issue overlap", () => {
      const siblings: MergeTrainSibling[] = [{ number: 105, createdAt: "2026-07-07T10:00:00.000Z", linkedIssues: [99], changedFiles: ["src/queue/processors.ts"] }];
      expect(decide(110, "2026-07-07T11:00:00.000Z", siblings, NOW, { thisPrLinkedIssues: [1], thisPrChangedFiles: ["src/queue/processors.ts"] })).toEqual({ wait: true, blockingPr: 105 });
    });

    it("does NOT treat a shared lockfile or generated-output path as meaningful overlap", () => {
      const siblings: MergeTrainSibling[] = [{ number: 105, createdAt: "2026-07-07T10:00:00.000Z", linkedIssues: [99], changedFiles: ["package-lock.json", "dist/bundle.js"] }];
      expect(decide(110, "2026-07-07T11:00:00.000Z", siblings, NOW, { thisPrLinkedIssues: [1], thisPrChangedFiles: ["package-lock.json", "dist/bundle.js"] })).toEqual({ wait: false });
    });

    it("does NOT treat a shared non-npm canonical lockfile (poetry.lock/go.sum) as meaningful overlap (#8647)", () => {
      // The hand-rolled 4-name regex only knew package-lock/yarn/pnpm/Cargo, so these forced a spurious wait;
      // delegating to the canonical isLockfile covers all 24+ formats.
      const siblings: MergeTrainSibling[] = [{ number: 105, createdAt: "2026-07-07T10:00:00.000Z", linkedIssues: [99], changedFiles: ["poetry.lock", "backend/go.sum"] }];
      expect(decide(110, "2026-07-07T11:00:00.000Z", siblings, NOW, { thisPrLinkedIssues: [1], thisPrChangedFiles: ["poetry.lock", "backend/go.sum"] })).toEqual({ wait: false });
    });

    it("does NOT treat a shared vendored-directory path (vendor/third_party) as meaningful overlap (#8647)", () => {
      const siblings: MergeTrainSibling[] = [{ number: 105, createdAt: "2026-07-07T10:00:00.000Z", linkedIssues: [99], changedFiles: ["vendor/lib/x.go", "third_party/pkg/y.js"] }];
      expect(decide(110, "2026-07-07T11:00:00.000Z", siblings, NOW, { thisPrLinkedIssues: [1], thisPrChangedFiles: ["vendor/lib/x.go", "third_party/pkg/y.js"] })).toEqual({ wait: false });
    });

    it("a sibling with no linkedIssues field at all (undefined) can still match via a shared changed file", () => {
      const siblings: MergeTrainSibling[] = [{ number: 105, createdAt: "2026-07-07T10:00:00.000Z", changedFiles: ["src/a.ts"] }];
      expect(decide(110, "2026-07-07T11:00:00.000Z", siblings, NOW, { thisPrLinkedIssues: [1], thisPrChangedFiles: ["src/a.ts"] })).toEqual({ wait: true, blockingPr: 105 });
    });

    it("a sibling with unresolved changedFiles can still match via a shared linked issue", () => {
      const siblings: MergeTrainSibling[] = [{ number: 105, createdAt: "2026-07-07T10:00:00.000Z", linkedIssues: [7] }];
      expect(decide(110, "2026-07-07T11:00:00.000Z", siblings, NOW, { thisPrLinkedIssues: [7], thisPrChangedFiles: ["src/a.ts"] })).toEqual({ wait: true, blockingPr: 105 });
    });

    it("this PR having no changedFiles resolved does not manufacture a file-based match (issue-only fallback)", () => {
      const siblings: MergeTrainSibling[] = [{ number: 105, createdAt: "2026-07-07T10:00:00.000Z", linkedIssues: [99], changedFiles: ["src/a.ts"] }];
      expect(decide(110, "2026-07-07T11:00:00.000Z", siblings, NOW, { thisPrLinkedIssues: [1] })).toEqual({ wait: false });
    });

    it("an unrelated older sibling stuck in review does not block a newer, unrelated, ready PR", () => {
      // The scenario question 1 worried about: an older sibling held for manual review (still mergeableState
      // "clean"/"unstable", not "dirty") must not wedge an unrelated newer PR just because it's older.
      const siblings = [sibling(105, "2026-07-07T10:00:00.000Z", "unstable", [777])];
      expect(decide(110, "2026-07-07T11:00:00.000Z", siblings, NOW, { thisPrLinkedIssues: [1], thisPrChangedFiles: ["docs/readme.md"] })).toEqual({ wait: false });
    });

    it("an OVERLAPPING older sibling stuck in review still blocks (bounded by the 24h staleness cap)", () => {
      const siblings = [sibling(105, "2026-07-07T10:00:00.000Z", "unstable", [1])];
      expect(decide(110, "2026-07-07T11:00:00.000Z", siblings, NOW)).toEqual({ wait: true, blockingPr: 105 });
    });

    it("with several older siblings, only the oldest OVERLAPPING one is the blocker (an unrelated older sibling is skipped over)", () => {
      const siblings = [sibling(104, "2026-07-07T09:30:00.000Z", null, [999]), sibling(105, "2026-07-07T10:00:00.000Z", null, [1]), sibling(107, "2026-07-07T10:30:00.000Z", null, [1])];
      expect(decide(110, "2026-07-07T11:00:00.000Z", siblings, NOW)).toEqual({ wait: true, blockingPr: 105 });
    });
  });

  describe("manual-review eviction (#9039 -- confirmed #8735 incident)", () => {
    it("REGRESSION: an older, OVERLAPPING sibling held for manual review does NOT block -- it is evicted, not waited for", () => {
      const siblings: MergeTrainSibling[] = [{ number: 105, createdAt: "2026-07-07T10:00:00.000Z", linkedIssues: [1], heldForManualReview: true }];
      expect(decide(110, "2026-07-07T11:00:00.000Z", siblings, NOW)).toEqual({ wait: false });
    });

    it("heldForManualReview: false (or absent/undefined) leaves the OVERLAPPING older sibling blocking exactly as before", () => {
      const held = [{ number: 105, createdAt: "2026-07-07T10:00:00.000Z", linkedIssues: [1], heldForManualReview: false }];
      expect(decide(110, "2026-07-07T11:00:00.000Z", held, NOW)).toEqual({ wait: true, blockingPr: 105 });
      const absent: MergeTrainSibling[] = [{ number: 105, createdAt: "2026-07-07T10:00:00.000Z", linkedIssues: [1] }];
      expect(decide(110, "2026-07-07T11:00:00.000Z", absent, NOW)).toEqual({ wait: true, blockingPr: 105 });
    });

    it("a manual-review-held sibling is skipped over in favor of the next-oldest still-viable overlapping sibling", () => {
      const siblings: MergeTrainSibling[] = [
        { number: 105, createdAt: "2026-07-07T10:00:00.000Z", linkedIssues: [1], heldForManualReview: true },
        { number: 107, createdAt: "2026-07-07T10:30:00.000Z", linkedIssues: [1] },
      ];
      expect(decide(110, "2026-07-07T11:00:00.000Z", siblings, NOW)).toEqual({ wait: true, blockingPr: 107 });
    });

    it("a manual-review-held sibling that is also unrelated/newer/dirty is unaffected -- the flag only matters when it would otherwise block", () => {
      const siblings: MergeTrainSibling[] = [{ number: 105, createdAt: "2026-07-07T10:00:00.000Z", linkedIssues: [999], heldForManualReview: true }];
      expect(decide(110, "2026-07-07T11:00:00.000Z", siblings, NOW)).toEqual({ wait: false });
    });
  });
});
