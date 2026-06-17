import { describe, expect, it } from "vitest";
import { buildPublicRepoQuality } from "../../src/services/public-repo-quality";
import type { PullRequestRecord } from "../../src/types";

const NOW = Date.parse("2026-06-15T00:00:00.000Z");

function pr(overrides: Partial<PullRequestRecord> = {}): PullRequestRecord {
  return {
    repoFullName: "acme/widgets",
    number: 1,
    title: "PR",
    state: "merged",
    labels: [],
    linkedIssues: [],
    ...overrides,
  };
}

function merged(createdAt: string, mergedAt: string, slopBand?: string): PullRequestRecord {
  return pr({ state: "merged", createdAt, mergedAt, ...(slopBand ? { slopBand } : {}) });
}

describe("buildPublicRepoQuality", () => {
  it("returns public-safe defaults for an empty repo", () => {
    expect(buildPublicRepoQuality([], NOW)).toEqual({
      medianTimeToMergeHours: null,
      realContributionPct: null,
      queueHealthLevel: "low",
      mergedSampleSize: 0,
      assessedSampleSize: 0,
    });
  });

  it("computes the odd-count median time-to-merge in whole hours", () => {
    const quality = buildPublicRepoQuality(
      [
        merged("2026-06-01T00:00:00Z", "2026-06-01T02:00:00Z"), // 2h
        merged("2026-06-01T00:00:00Z", "2026-06-01T06:00:00Z"), // 6h
        merged("2026-06-01T00:00:00Z", "2026-06-01T10:00:00Z"), // 10h
      ],
      NOW,
    );
    expect(quality.medianTimeToMergeHours).toBe(6);
    expect(quality.mergedSampleSize).toBe(3);
  });

  it("averages the two middle values for an even-count median", () => {
    expect(
      buildPublicRepoQuality(
        [merged("2026-06-01T00:00:00Z", "2026-06-01T02:00:00Z"), merged("2026-06-01T00:00:00Z", "2026-06-01T08:00:00Z")],
        NOW,
      ).medianTimeToMergeHours,
    ).toBe(5);
  });

  it("excludes merges with missing or impossible timestamps from the median", () => {
    const quality = buildPublicRepoQuality(
      [
        merged("2026-06-01T00:00:00Z", "2026-06-01T04:00:00Z"), // 4h, valid
        pr({ state: "merged", mergedAt: "2026-06-02T00:00:00Z" }), // no createdAt
        pr({ state: "merged", createdAt: "2026-06-03T05:00:00Z", mergedAt: "2026-06-03T00:00:00Z" }), // merged < created
      ],
      NOW,
    );
    expect(quality.medianTimeToMergeHours).toBe(4);
    expect(quality.mergedSampleSize).toBe(3);
  });

  it("treats state=merged without mergedAt as merged for sample size", () => {
    expect(buildPublicRepoQuality([pr({ state: "MERGED" })], NOW).mergedSampleSize).toBe(1);
  });

  it("computes the non-slop contribution share only over assessed merges", () => {
    const quality = buildPublicRepoQuality(
      [
        merged("2026-06-01T00:00:00Z", "2026-06-01T01:00:00Z", "clean"),
        merged("2026-06-01T00:00:00Z", "2026-06-01T01:00:00Z", "LOW"), // case-insensitive non-slop
        merged("2026-06-01T00:00:00Z", "2026-06-01T01:00:00Z", "high"), // slop
        merged("2026-06-01T00:00:00Z", "2026-06-01T01:00:00Z"), // not assessed → excluded
      ],
      NOW,
    );
    expect(quality.assessedSampleSize).toBe(3);
    expect(quality.realContributionPct).toBe(67); // 2 of 3 assessed are non-slop
  });

  it("returns null real-contribution share when no merge is assessed", () => {
    expect(buildPublicRepoQuality([merged("2026-06-01T00:00:00Z", "2026-06-01T01:00:00Z")], NOW).realContributionPct).toBeNull();
  });

  it("classifies queue health by open volume and staleness", () => {
    const openFresh = (count: number) =>
      Array.from({ length: count }, (_, i) => pr({ number: i + 1, state: "open", updatedAt: "2026-06-14T00:00:00Z" }));
    const openStale = (count: number) =>
      Array.from({ length: count }, (_, i) => pr({ number: i + 100, state: "open", updatedAt: "2026-05-01T00:00:00Z" }));

    expect(buildPublicRepoQuality(openFresh(3), NOW).queueHealthLevel).toBe("low");
    expect(buildPublicRepoQuality(openFresh(6), NOW).queueHealthLevel).toBe("medium");
    expect(buildPublicRepoQuality(openStale(2), NOW).queueHealthLevel).toBe("medium"); // staleness path
    expect(buildPublicRepoQuality(openFresh(20), NOW).queueHealthLevel).toBe("high");
    expect(buildPublicRepoQuality(openStale(8), NOW).queueHealthLevel).toBe("high");
    expect(buildPublicRepoQuality(openFresh(50), NOW).queueHealthLevel).toBe("critical");
    expect(buildPublicRepoQuality(openStale(20), NOW).queueHealthLevel).toBe("critical");
  });

  it("falls back to createdAt, then ignores, when open PRs lack updatedAt", () => {
    const staleByCreated = pr({ number: 1, state: "open", createdAt: "2026-05-01T00:00:00Z" }); // no updatedAt → use createdAt → stale
    const alsoStale = pr({ number: 2, state: "open", createdAt: "2026-05-01T00:00:00Z" });
    const noTimestamps = pr({ number: 3, state: "open" }); // neither field → not counted as stale
    expect(buildPublicRepoQuality([staleByCreated, alsoStale, noTimestamps], NOW).queueHealthLevel).toBe("medium");
  });

  it("never exposes contributor-level or private terms", () => {
    const quality = buildPublicRepoQuality([merged("2026-06-01T00:00:00Z", "2026-06-01T01:00:00Z", "clean")], NOW);
    expect(JSON.stringify(quality)).not.toMatch(/wallet|hotkey|trust|reward|login|author|scoreability/i);
  });
});
