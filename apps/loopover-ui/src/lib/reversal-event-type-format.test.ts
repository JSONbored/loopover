import { describe, expect, it } from "vitest";

import { formatReversalEventType } from "@/components/site/app-panels/reversal-health-card-model";

// (#8665) Direct unit coverage for formatReversalEventType. Previously only the "reversal_reopened"
// arm was exercised — and only indirectly, through ReversalHealthCard's render in
// reversal-health-card.test.tsx. The headline "reversal_reverted" -> "merge reverted" branch (the
// bot-merge-revert case this card exists to surface) and the generic underscore-humanizing fallback
// had no direct test, so a typo or refactor regression in either string comparison would go
// undetected. These assert each of the three branches against the pure helper itself.
describe("formatReversalEventType (#8665)", () => {
  it("maps reversal_reverted to the 'merge reverted' headline", () => {
    expect(formatReversalEventType("reversal_reverted")).toBe("merge reverted");
  });

  it("maps reversal_reopened to 'close reopened'", () => {
    expect(formatReversalEventType("reversal_reopened")).toBe("close reopened");
  });

  it("humanizes any other event type by replacing every underscore with a space", () => {
    expect(formatReversalEventType("some_new_event")).toBe("some new event");
    expect(formatReversalEventType("a_b_c")).toBe("a b c");
  });
});
