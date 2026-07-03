import { describe, expect, it } from "vitest";
import { opportunityFreshnessInternals } from "../../packages/gittensory-engine/src/opportunity-freshness";
import { opportunityMetadataInternals } from "../../packages/gittensory-engine/src/opportunity-metadata";
import { DEFAULT_MINER_GOAL_SPEC } from "../../packages/gittensory-engine/src/miner-goal-spec";

const NOW = Date.parse("2026-07-03T12:00:00.000Z");

describe("opportunity branch internals", () => {
  it("pickTimestamp prefers updatedAt, then createdAt, then null", () => {
    const { pickTimestamp } = opportunityFreshnessInternals;
    expect(
      pickTimestamp({
        state: "open",
        updatedAt: "2026-07-03T00:00:00.000Z",
        createdAt: "2020-01-01T00:00:00.000Z",
      }),
    ).toBe("2026-07-03T00:00:00.000Z");
    expect(
      pickTimestamp({
        state: "open",
        updatedAt: "   ",
        createdAt: "2026-07-03T00:00:00.000Z",
      }),
    ).toBe("2026-07-03T00:00:00.000Z");
    expect(
      pickTimestamp({
        state: "open",
        updatedAt: null,
        createdAt: null,
      }),
    ).toBeNull();
    expect(
      pickTimestamp({
        state: "open",
        updatedAt: 123 as unknown as string,
        createdAt: "2026-07-03T00:00:00.000Z",
      }),
    ).toBe("2026-07-03T00:00:00.000Z");
  });

  it("issueAgeDays floors invalid timestamps to stale age", () => {
    const { issueAgeDays } = opportunityFreshnessInternals;
    expect(issueAgeDays(null, NOW)).toBe(9999);
    expect(issueAgeDays("not-a-date", NOW)).toBe(9999);
    expect(issueAgeDays("2026-07-03T00:00:00.000Z", NOW)).toBeGreaterThanOrEqual(0);
  });

  it("titlesOverlap covers empty, exact, orientation, and substring guards", () => {
    const { titlesOverlap } = opportunityMetadataInternals;
    expect(titlesOverlap("", "anything")).toBe(false);
    expect(titlesOverlap("anything", "")).toBe(false);
    expect(titlesOverlap("same title here", "same title here")).toBe(true);
    expect(titlesOverlap("queue retry helper", "queue retry helper for workers")).toBe(true);
    expect(titlesOverlap("queue retry helper for workers", "queue retry helper")).toBe(true);
    expect(titlesOverlap("alpha beta gamma", "delta epsilon zeta")).toBe(false);
    expect(titlesOverlap("tiny extra words", "tiny")).toBe(false);
  });

  it("normalizeLabels and resolveGoalSpec cover adapter edge branches", () => {
    const { normalizeLabels, resolveGoalSpec } = opportunityMetadataInternals;
    expect(normalizeLabels(["  ", null as unknown as string, " Bug "])).toEqual(["bug"]);
    expect(
      resolveGoalSpec("acme/widgets", {
        nowMs: NOW,
        goalSpecsByRepo: {
          "other/repo": DEFAULT_MINER_GOAL_SPEC,
          "ACME/Widgets": {
            minerEnabled: true,
            wantedPaths: [],
            blockedPaths: [],
            preferredLabels: ["feature"],
            blockedLabels: [],
            maxConcurrentClaims: 1,
            issueDiscoveryPolicy: "encouraged",
          },
        },
      }).preferredLabels,
    ).toEqual(["feature"]);
  });
});
