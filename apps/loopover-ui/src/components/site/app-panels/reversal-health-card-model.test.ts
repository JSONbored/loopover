import { describe, expect, it } from "vitest";

import { formatReversalEventType } from "@/components/site/app-panels/reversal-health-card-model";

// (#8665) Direct unit coverage for all three formatReversalEventType branches. Previously only
// "reversal_reopened" was reached indirectly via reversal-health-card.test.tsx's card render.

describe("formatReversalEventType (#8665)", () => {
  it('maps reversal_reverted to "merge reverted"', () => {
    expect(formatReversalEventType("reversal_reverted")).toBe("merge reverted");
  });

  it('maps reversal_reopened to "close reopened"', () => {
    expect(formatReversalEventType("reversal_reopened")).toBe("close reopened");
  });

  it("falls back to replacing underscores with spaces for unknown event types", () => {
    expect(formatReversalEventType("some_new_event")).toBe("some new event");
  });
});
