import { describe, expect, it } from "vitest";
import { SUPERSEDED_LOOKBACK_MS } from "../../src/review/reversal-superseded";
import { RAW_CONTEXT_MAX_DIFF_CHARS } from "../../src/rules/advisory";
import {
  backfillFiredId,
  backfillOverrideId,
  matchRetroSuccessors,
  patchFiredMetadataWithDiff,
  patchOverrideMetadataToReversed,
  renderPhase2Report,
  RETRO_SUCCESSOR_PROVENANCE,
  RAW_CONTEXT_REFETCH_PROVENANCE,
  type HistoricalCloseSide,
  type Phase2Report,
  type SuccessorSide,
} from "../../scripts/backfill-calibration-corpus-phase2-core";

// #8170: the pure core of the phase-2 GitHub-truth backfill. The matching itself is #8166's
// evaluateSuccessorMatch (tested in its own suite); these tests pin the retro windowing, the
// deterministic earliest-successor pick, and both patchers' idempotency.

const CLOSE_AT = "2026-06-01T00:00:00.000Z";

function close(over: Partial<HistoricalCloseSide> = {}): HistoricalCloseSide {
  return {
    targetKey: "acme/widgets#7",
    repo: "acme/widgets",
    number: 7,
    closedAt: CLOSE_AT,
    authorLogin: "alice",
    linkedIssues: [42],
    files: ["src/a.ts", "src/b.ts"],
    ...over,
  };
}

function successor(over: Partial<SuccessorSide> = {}): SuccessorSide {
  return {
    number: 9,
    mergedAt: "2026-06-02T00:00:00.000Z",
    authorLogin: "alice",
    linkedIssues: [42],
    files: ["src/a.ts", "src/b.ts"],
    ...over,
  };
}

describe("matchRetroSuccessors (#8170)", () => {
  it("matches a shared-linked-issue successor inside the lookback window", () => {
    const match = matchRetroSuccessors(close(), [successor()]);
    expect(match).toMatchObject({ targetKey: "acme/widgets#7", supersededBy: 9 });
    expect(match!.heuristics.sameLinkedIssue).toBe(true);
  });

  it("is directional and bounded: merges before the close, past the lookback, the close itself, and bad timestamps never match", () => {
    // Merged BEFORE the close.
    expect(matchRetroSuccessors(close(), [successor({ mergedAt: "2026-05-30T00:00:00.000Z" })])).toBeNull();
    // Merged after the 30-day lookback.
    const past = new Date(Date.parse(CLOSE_AT) + SUPERSEDED_LOOKBACK_MS + 1).toISOString();
    expect(matchRetroSuccessors(close(), [successor({ mergedAt: past })])).toBeNull();
    // At the boundary exactly: still inside (inclusive).
    const boundary = new Date(Date.parse(CLOSE_AT) + SUPERSEDED_LOOKBACK_MS).toISOString();
    expect(matchRetroSuccessors(close(), [successor({ mergedAt: boundary })])).not.toBeNull();
    // The close's own number can never supersede it.
    expect(matchRetroSuccessors(close(), [successor({ number: 7 })])).toBeNull();
    // Unparseable timestamps on either side.
    expect(matchRetroSuccessors(close({ closedAt: "not-a-date" }), [successor()])).toBeNull();
    expect(matchRetroSuccessors(close(), [successor({ mergedAt: "not-a-date" })])).toBeNull();
  });

  it("picks the EARLIEST qualifying merge (ties broken by number) so re-runs with more candidates stay stable", () => {
    const later = successor({ number: 20, mergedAt: "2026-06-05T00:00:00.000Z" });
    const earlier = successor({ number: 11, mergedAt: "2026-06-03T00:00:00.000Z" });
    const tie = successor({ number: 10, mergedAt: "2026-06-03T00:00:00.000Z" });
    expect(matchRetroSuccessors(close(), [later, earlier, tie])!.supersededBy).toBe(10);
  });

  it("skips non-matching successors and records nothing on a borderline (conservative by #8166's own bar)", () => {
    const stranger = successor({ authorLogin: "bob", linkedIssues: [], files: [] });
    expect(matchRetroSuccessors(close({ linkedIssues: [] }), [stranger])).toBeNull();
    // A non-matching earlier successor must not shadow a matching later one.
    const matching = successor({ number: 15, mergedAt: "2026-06-09T00:00:00.000Z" });
    expect(matchRetroSuccessors(close(), [stranger, matching])!.supersededBy).toBe(15);
  });
});

describe("metadata patchers (#8170)", () => {
  const match = { targetKey: "acme/widgets#7", supersededBy: 9, heuristics: { sameLinkedIssue: true, sameAuthorFileOverlap: false, fileOverlapRatio: null } };

  it("flips a phase-1 confirmed override to reversed with the retro provenance + evidence", () => {
    const original = JSON.stringify({ verdict: "confirmed", backfilled: true, provenance: "review_targets_decision_level" });
    const patched = JSON.parse(patchOverrideMetadataToReversed(original, match)!) as Record<string, unknown>;
    expect(patched.verdict).toBe("reversed");
    expect(patched.backfilled).toBe(true); // phase-1 fields survive
    expect(patched.retroLabel).toMatchObject({ provenance: RETRO_SUCCESSOR_PROVENANCE, supersededBy: 9 });
  });

  it("is idempotent and never guesses: already-reversed and unparseable metadata both return null", () => {
    expect(patchOverrideMetadataToReversed(JSON.stringify({ verdict: "reversed" }), match)).toBeNull();
    expect(patchOverrideMetadataToReversed("not-json", match)).toBeNull();
    expect(patchOverrideMetadataToReversed('["array"]', match)).toBeNull();
  });

  it("patches a fired row with the bounded diff exactly once", () => {
    const original = JSON.stringify({ confidence: 0.95, backfilled: true });
    const patched = JSON.parse(patchFiredMetadataWithDiff(original, "diff --git a/x b/x")!) as Record<string, unknown>;
    expect(patched.diff).toBe("diff --git a/x b/x");
    expect(patched.rawContextProvenance).toBe(RAW_CONTEXT_REFETCH_PROVENANCE);
    // Second run: diff present -> null.
    expect(patchFiredMetadataWithDiff(JSON.stringify(patched), "different")).toBeNull();
  });

  it("bounds an oversized diff to the live capture's own cap and refuses empty diffs / bad metadata", () => {
    const oversized = "x".repeat(RAW_CONTEXT_MAX_DIFF_CHARS + 5);
    const patched = JSON.parse(patchFiredMetadataWithDiff("{}", oversized)!) as { diff: string };
    expect(patched.diff).toHaveLength(RAW_CONTEXT_MAX_DIFF_CHARS);
    expect(patchFiredMetadataWithDiff("{}", "")).toBeNull();
    expect(patchFiredMetadataWithDiff("not-json", "diff")).toBeNull();
  });
});

describe("ids + report rendering (#8170)", () => {
  it("derives the deterministic phase-1 row ids (the only rows the passes may touch)", () => {
    expect(backfillOverrideId("acme/widgets#7")).toBe("backfill:ai_consensus_defect:acme/widgets#7:override");
    expect(backfillFiredId("acme/widgets#7")).toBe("backfill:ai_consensus_defect:acme/widgets#7:fired");
  });

  it("renders both passes' reports, including the budget-exhausted resumable form", () => {
    const base: Phase2Report = { pass: "successors", scanned: 5, patched: 2, alreadyPatched: 1, noMatch: 2, matchedSameAuthor: 1, matchedSharedIssueOnly: 1, requestsUsed: 42, exhaustedBudget: false, resumeFrom: null };
    const report = renderPhase2Report(base, "dry-run");
    expect(report).toContain(RETRO_SUCCESSOR_PROVENANCE);
    expect(report).toContain("scanned: 5");
    // The apply decision hinges on this split (same-author = strong; shared-issue-only = routine duplicate competition).
    expect(report).toContain("same-author rework 1, shared-issue-only (different author) 1");
    const exhausted = renderPhase2Report(
      { ...base, pass: "raw-context", exhaustedBudget: true, resumeFrom: "acme/widgets#7" },
      "apply",
    );
    expect(exhausted).toContain(RAW_CONTEXT_REFETCH_PROVENANCE);
    expect(exhausted).toContain("budget exhausted");
    expect(exhausted).toContain("resume from: acme/widgets#7");
  });
});
