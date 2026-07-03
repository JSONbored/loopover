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

  it("accepts uppercase state labels and treats missing timestamps as stale", () => {
    expect(
      computeOpportunityFreshness([{ state: "OPEN", updatedAt: "2026-07-03T00:00:00.000Z" }], NOW),
    ).toBeGreaterThan(0.8);
    expect(computeOpportunityFreshness([{ state: "open", updatedAt: "", createdAt: "" }], NOW)).toBe(0.05);
    expect(
      computeOpportunityFreshness([{ state: "open", createdAt: "not-a-date", updatedAt: "also-bad" }], NOW),
    ).toBe(0.05);
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

  it("falls back cleanly when timestamps are absent or non-string", () => {
    expect(
      computeOpportunityFreshness(
        [{ state: "open", updatedAt: null, createdAt: "   " }],
        NOW,
      ),
    ).toBe(0.05);
    expect(
      computeOpportunityFreshness(
        [{ state: "open", updatedAt: 123 as unknown as string, createdAt: "2026-07-03T00:00:00.000Z" }],
        NOW,
      ),
    ).toBeGreaterThan(0.8);
  });
});
