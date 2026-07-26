import { describe, expect, it } from "vitest";

import { DEFAULT_MINER_GOAL_SPEC } from "../../packages/loopover-engine/src/miner-goal-spec";
import { rankMetadataOpportunitiesAtOrAboveScore } from "../../packages/loopover-engine/src/metadata-min-score";

const NOW = Date.parse("2026-07-03T12:00:00.000Z");

const base = {
  repoFullName: "acme/widgets",
  issueNumber: 10,
  title: "Improve queue retry semantics",
  labels: ["help wanted"],
  commentsCount: 2,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-02T12:00:00.000Z",
};

describe("rankMetadataOpportunitiesAtOrAboveScore", () => {
  const candidates = [
    { ...base, issueNumber: 1, labels: ["wontfix"] },
    { ...base, issueNumber: 2, labels: ["help wanted"] },
    { ...base, issueNumber: 3, labels: ["help wanted", "bug"] },
  ];

  it("keeps only metadata candidates at or above the score threshold in rank order", () => {
    const filtered = rankMetadataOpportunitiesAtOrAboveScore(candidates, { nowMs: NOW }, 0.05);
    expect(filtered.map((entry) => entry.issueNumber)).toEqual([3, 2]);
    expect(filtered.every((entry) => entry.rankScore >= 0.05)).toBe(true);
  });

  it("returns every targetable candidate when the threshold is zero", () => {
    expect(
      rankMetadataOpportunitiesAtOrAboveScore(candidates, { nowMs: NOW }, 0).map((entry) => entry.issueNumber),
    ).toEqual([3, 2, 1]);
  });

  it("skips miner-disabled repos before applying the score threshold", () => {
    const ranked = rankMetadataOpportunitiesAtOrAboveScore(
      [
        { ...base, issueNumber: 1, repoFullName: "acme/disabled" },
        { ...base, issueNumber: 2, labels: ["help wanted"] },
      ],
      {
        nowMs: NOW,
        goalSpecsByRepo: {
          "acme/disabled": { ...DEFAULT_MINER_GOAL_SPEC, minerEnabled: false },
        },
      },
      0,
    );
    expect(ranked.map((entry) => entry.issueNumber)).toEqual([2]);
  });

  it("returns an empty array for a non-finite threshold or no candidates", () => {
    expect(rankMetadataOpportunitiesAtOrAboveScore(candidates, { nowMs: NOW }, Number.NaN)).toEqual([]);
    expect(rankMetadataOpportunitiesAtOrAboveScore(candidates, { nowMs: NOW }, Number.POSITIVE_INFINITY)).toEqual(
      [],
    );
    expect(rankMetadataOpportunitiesAtOrAboveScore([], { nowMs: NOW }, 0.5)).toEqual([]);
  });

  it("clamps out-of-range thresholds before filtering", () => {
    expect(
      rankMetadataOpportunitiesAtOrAboveScore(candidates, { nowMs: NOW }, -0.5).map((entry) => entry.issueNumber),
    ).toEqual([3, 2, 1]);
    expect(
      rankMetadataOpportunitiesAtOrAboveScore(candidates, { nowMs: NOW }, 1.5).map((entry) => entry.issueNumber),
    ).toEqual([]);
  });

  it("is exported from the package barrel", async () => {
    const barrel = await import("../../packages/loopover-engine/src/index");
    expect(typeof barrel.rankMetadataOpportunitiesAtOrAboveScore).toBe("function");
    expect(
      barrel.rankMetadataOpportunitiesAtOrAboveScore(candidates, { nowMs: NOW }, 0.05).map(
        (entry: { issueNumber: number }) => entry.issueNumber,
      ),
    ).toEqual([3, 2]);
  });
});
