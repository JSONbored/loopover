import { describe, expect, it } from "vitest";

import { formatReversalEventType } from "@/components/site/app-panels/reversal-health-card-model";

// #8665: formatReversalEventType has three branches, but only the "reversal_reopened" case was ever
// exercised — indirectly, through reversal-health-card.test.tsx's render. The headline
// "reversal_reverted" (bot-merge revert) branch and the generic fallback were untested, so a typo in
// either string comparison would go undetected. These are direct unit assertions on the function
// itself (a .ts test file, deliberately not .tsx), one per branch.
describe("formatReversalEventType (#8665)", () => {
  it('maps "reversal_reverted" to the "merge reverted" headline label', () => {
    expect(formatReversalEventType("reversal_reverted")).toBe("merge reverted");
  });

  it('maps "reversal_reopened" to "close reopened"', () => {
    expect(formatReversalEventType("reversal_reopened")).toBe("close reopened");
  });

  it("falls back to underscore-to-space humanization for any other event type", () => {
    expect(formatReversalEventType("some_new_event")).toBe("some new event");
    // Multiple underscores are all replaced (replaceAll, not replace).
    expect(formatReversalEventType("a_b_c")).toBe("a b c");
  });
});
