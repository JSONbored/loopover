import { describe, expect, it } from "vitest";
import { computeOpportunityFreshness } from "../../packages/gittensory-engine/src/opportunity-freshness";

const NOW = Date.parse("2026-07-03T12:00:00.000Z");

describe("computeOpportunityFreshness", () => {
  it("prefers updatedAt over createdAt and treats blank timestamps as missing", () => {
    expect(
      computeOpportunityFreshness(
        [{ state: "open", updatedAt: "2026-07-03T00:00:00.000Z", createdAt: "2020-01-01T00:00:00.000Z" }],
        NOW,
      ),
    ).toBeGreaterThan(0.8);
    expect(
      computeOpportunityFreshness(
        [{ state: "open", updatedAt: "   ", createdAt: "2026-07-03T00:00:00.000Z" }],
        NOW,
      ),
    ).toBeGreaterThan(0.8);
  });

  it("accepts uppercase state labels and collapses missing timestamps to maximum freshness", () => {
    expect(
      computeOpportunityFreshness([{ state: "OPEN", updatedAt: "2026-07-03T00:00:00.000Z" }], NOW),
    ).toBeGreaterThan(0.8);
    expect(computeOpportunityFreshness([{ state: "open", updatedAt: "", createdAt: "" }], NOW)).toBe(1);
  });

  it("ignores non-open issues and rejects non-finite clocks", () => {
    expect(
      computeOpportunityFreshness(
        [{ state: "closed", updatedAt: "2026-07-03T00:00:00.000Z" }],
        NOW,
      ),
    ).toBe(0);
    expect(computeOpportunityFreshness([], NOW)).toBe(0);
    expect(computeOpportunityFreshness([{ state: "open", updatedAt: "2026-07-03T00:00:00.000Z" }], Number.NaN)).toBe(
      0,
    );
  });
});
