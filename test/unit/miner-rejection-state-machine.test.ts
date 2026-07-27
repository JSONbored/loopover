import { describe, expect, it } from "vitest";
import {
  DISENGAGED_OUTCOME,
  extractPrOutcomeFields,
  isRejectedPr,
  classifyRejectionReason,
  resolveRejection,
} from "../../packages/loopover-miner/lib/rejection-state-machine";

const CONTEXT = { repoFullName: "JSONbored/loopover", prNumber: 4278 } as const;
const closedUnmerged = { state: "closed", merged: false, merged_at: null, closed_at: "2026-07-09T18:00:00Z" };

describe("loopover-miner rejection state machine (#4278)", () => {
  it("extracts terminal-outcome fields from a full PR payload", () => {
    expect(extractPrOutcomeFields(closedUnmerged)).toEqual({
      state: "closed",
      merged: false,
      mergedAt: null,
      closedAt: "2026-07-09T18:00:00Z",
    });
  });

  it("normalizes missing/malformed payload fields to null/false without throwing", () => {
    expect(extractPrOutcomeFields(undefined)).toEqual({ state: null, merged: false, mergedAt: null, closedAt: null });
    expect(extractPrOutcomeFields({ state: 42, merged: "yes" })).toEqual({
      state: null,
      merged: false,
      mergedAt: null,
      closedAt: null,
    });
  });

  it("carries a real merged_at string through when the PR was actually merged", () => {
    expect(
      extractPrOutcomeFields({ state: "closed", merged: true, merged_at: "2026-07-10T00:00:00Z", closed_at: null }),
    ).toEqual({ state: "closed", merged: true, mergedAt: "2026-07-10T00:00:00Z", closedAt: null });
  });

  it("detects closed-without-merge as a rejection, but not a merged or open PR", () => {
    expect(isRejectedPr({ state: "closed", merged: false })).toBe(true);
    expect(isRejectedPr({ state: "closed", merged: true })).toBe(false); // merged PRs are also state:closed
    expect(isRejectedPr({ state: "open", merged: false })).toBe(false);
    expect(isRejectedPr(undefined)).toBe(false);
  });

  it("classifies each reason bucket, defaulting to maintainer_close_no_reason with no signal", () => {
    expect(classifyRejectionReason({ gateClosed: true })).toBe("gate_close");
    expect(classifyRejectionReason({ supersededByDuplicate: true })).toBe("superseded_by_duplicate");
    expect(classifyRejectionReason({})).toBe("maintainer_close_no_reason");
    expect(classifyRejectionReason()).toBe("maintainer_close_no_reason"); // zero-signal fallback
  });

  it("prefers the gate cause when both gate and duplicate signals are present", () => {
    expect(classifyRejectionReason({ gateClosed: true, supersededByDuplicate: true })).toBe("gate_close");
  });

  it("treats a non-object signal the same as an absent one, defaulting to maintainer_close_no_reason", () => {
    // A caller outside TS's guarantees (plain JS, or a malformed payload) can hand this a non-object; the
    // runtime guard must fall back to {} rather than throw on a null/primitive .gateClosed read.
    expect(classifyRejectionReason(null as unknown as undefined)).toBe("maintainer_close_no_reason");
  });

  it("resolveRejection drives the renderer and returns the disengaged transition for each reason", () => {
    for (const [signal, reason] of [
      [{ gateClosed: true }, "gate_close"],
      [{ supersededByDuplicate: true }, "superseded_by_duplicate"],
      [{}, "maintainer_close_no_reason"],
    ] as const) {
      const result = resolveRejection(closedUnmerged, signal, CONTEXT);
      expect(result).not.toBeNull();
      expect(result?.outcome).toBe(DISENGAGED_OUTCOME);
      expect(result?.reason).toBe(reason);
      expect(result?.note).toContain("JSONbored/loopover");
      expect(result?.note).toContain("#4278");
      expect(result?.note).not.toMatch(/\{[^}]+\}/); // renderer left no unresolved placeholder
    }
  });

  it("resolveRejection returns null for a PR that is not a rejection (open or merged)", () => {
    expect(resolveRejection({ state: "open", merged: false }, {}, CONTEXT)).toBeNull();
    expect(resolveRejection({ state: "closed", merged: true }, {}, CONTEXT)).toBeNull();
  });

  it("exposes 'disengaged' as the per-PR outcome constant", () => {
    expect(DISENGAGED_OUTCOME).toBe("disengaged");
  });
});
