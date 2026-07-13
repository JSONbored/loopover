import { describe, expect, it } from "vitest";
import { applyReviewMemorySuppression, isReviewMemoryEnabled, shouldApplyReviewMemory } from "../../src/review/review-memory-wire";
import { fingerprint } from "../../src/review/review-memory-match";
import type { AdvisoryFinding, ReviewSuppressionRecord } from "../../src/types";

describe("isReviewMemoryEnabled", () => {
  it("is OFF for unset/false and ON for the truthy convention", () => {
    expect(isReviewMemoryEnabled({})).toBe(false);
    expect(isReviewMemoryEnabled({ LOOPOVER_REVIEW_MEMORY: "false" })).toBe(false);
    expect(isReviewMemoryEnabled({ LOOPOVER_REVIEW_MEMORY: "true" })).toBe(true);
    expect(isReviewMemoryEnabled({ LOOPOVER_REVIEW_MEMORY: "1" })).toBe(true);
    expect(isReviewMemoryEnabled({ LOOPOVER_REVIEW_MEMORY: "on" })).toBe(true);
    expect(isReviewMemoryEnabled({ LOOPOVER_REVIEW_MEMORY: "yes" })).toBe(true);
  });
});

describe("shouldApplyReviewMemory", () => {
  it("requires BOTH the operator env flag AND the per-repo manifest opt-in", () => {
    expect(shouldApplyReviewMemory({ LOOPOVER_REVIEW_MEMORY: "true" }, true)).toBe(true);
  });

  it("is OFF when the operator flag is on but the manifest didn't opt in", () => {
    expect(shouldApplyReviewMemory({ LOOPOVER_REVIEW_MEMORY: "true" }, false)).toBe(false);
  });

  it("is OFF when the manifest opted in but the operator flag is off (repo cannot self-enable)", () => {
    expect(shouldApplyReviewMemory({ LOOPOVER_REVIEW_MEMORY: "false" }, true)).toBe(false);
  });

  it("is OFF when both are off", () => {
    expect(shouldApplyReviewMemory({}, false)).toBe(false);
  });
});

describe("applyReviewMemorySuppression (#2181)", () => {
  function finding(overrides: Partial<AdvisoryFinding> = {}): AdvisoryFinding {
    return { code: "ai_review_split", title: "An AI reviewer flagged a likely blocking defect", severity: "warning", detail: "Some finding detail.", ...overrides };
  }

  function signal(overrides: Partial<ReviewSuppressionRecord> = {}): ReviewSuppressionRecord {
    return { id: "sig-1", repoFullName: "owner/repo", category: "ai_review_split", pathGlob: "", patternHash: "irrelevant", createdAt: "2026-01-01T00:00:00.000Z", createdBy: null, ...overrides };
  }

  function findingHash(f: AdvisoryFinding): string {
    return fingerprint({ category: f.code, message: `${f.title} ${f.detail}` });
  }

  it("is a no-op (byte-identical array) when there are no findings", () => {
    const result = applyReviewMemorySuppression([], [signal()]);
    expect(result).toEqual({ findings: [], suppressedCount: 0, demotedCount: 0 });
  });

  it("is a no-op (byte-identical array) when there are no stored signals", () => {
    const f = finding();
    const result = applyReviewMemorySuppression([f], []);
    expect(result).toEqual({ findings: [f], suppressedCount: 0, demotedCount: 0 });
  });

  it("drops a finding that exactly matches a stored suppression signal", () => {
    const f = finding();
    const signals = [signal({ patternHash: findingHash(f) })];
    const result = applyReviewMemorySuppression([f], signals);
    expect(result).toEqual({ findings: [], suppressedCount: 1, demotedCount: 0 });
  });

  it("keeps but moves a scope-matched (category, different message) finding to the END of the list", () => {
    const a = finding({ code: "ai_review_split", title: "Finding A", detail: "detail a" });
    const b = finding({ code: "ai_consensus_defect", title: "Finding B", detail: "detail b" });
    // A scope-only match for "a" (same category, different message hash); "b" has no matching signal at all.
    const signals = [signal({ category: "ai_review_split", patternHash: "unrelated-hash" })];
    const result = applyReviewMemorySuppression([a, b], signals);
    expect(result.suppressedCount).toBe(0);
    expect(result.demotedCount).toBe(1);
    expect(result.findings).toEqual([b, a]); // demoted "a" moved to the end; "b" (kept) stays first
  });

  it("keeps a finding untouched (in its original position) when nothing matches its category/path scope", () => {
    const f = finding({ code: "ai_review_inconclusive" });
    const signals = [signal({ category: "ai_consensus_defect", patternHash: "whatever" })];
    const result = applyReviewMemorySuppression([f], signals);
    expect(result).toEqual({ findings: [f], suppressedCount: 0, demotedCount: 0 });
  });

  it("handles a mix of suppress/demote/keep across several findings in one call", () => {
    const suppressMe = finding({ code: "ai_review_split", title: "Suppress me", detail: "d1" });
    const demoteMe = finding({ code: "ai_review_split", title: "Demote me", detail: "d2" });
    const keepMe = finding({ code: "ai_review_inconclusive", title: "Keep me", detail: "d3" });
    const signals = [
      signal({ id: "exact", category: "ai_review_split", patternHash: findingHash(suppressMe) }),
      signal({ id: "scope", category: "ai_review_split", patternHash: "some-other-hash" }),
    ];
    const result = applyReviewMemorySuppression([suppressMe, demoteMe, keepMe], signals);
    expect(result.suppressedCount).toBe(1);
    expect(result.demotedCount).toBe(1);
    expect(result.findings).toEqual([keepMe, demoteMe]);
  });

  it("never mutates the input findings array or its elements", () => {
    const f = finding();
    const findings = [f];
    const signals = [signal({ patternHash: findingHash(f) })];
    applyReviewMemorySuppression(findings, signals);
    expect(findings).toEqual([f]); // original array untouched despite f being suppressed in the result
  });
});
