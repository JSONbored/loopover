import { describe, expect, it } from "vitest";

import { DEFAULT_MINER_GOAL_SPEC } from "../../packages/loopover-engine/src/miner-goal-spec";
import { pickTopMetadataOpportunitiesAtOrAboveScore } from "../../packages/loopover-engine/src/metadata-top-min-score";

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

describe("pickTopMetadataOpportunitiesAtOrAboveScore", () => {
  const candidates = [
    { ...base, issueNumber: 1, labels: ["wontfix"] },
    { ...base, issueNumber: 2, labels: ["help wanted"] },
    { ...base, issueNumber: 3, labels: ["help wanted", "bug"] },
    { ...base, issueNumber: 4, labels: ["help wanted", "documentation"] },
  ];

  it("returns the top survivors after applying the score threshold", () => {
    const topTwo = pickTopMetadataOpportunitiesAtOrAboveScore(candidates, { nowMs: NOW }, 0.05, 2);
    expect(topTwo.map((entry) => entry.issueNumber)).toEqual([3, 2]);
    expect(topTwo.every((entry) => entry.rankScore >= 0.05)).toBe(true);
  });

  it("returns every qualifying candidate when the limit exceeds the filtered list", () => {
    expect(
      pickTopMetadataOpportunitiesAtOrAboveScore(candidates, { nowMs: NOW }, 0.05, 10).map(
        (entry) => entry.issueNumber,
      ),
    ).toEqual([3, 2, 4]);
  });

  it("returns an empty array when the score threshold excludes every candidate", () => {
    expect(pickTopMetadataOpportunitiesAtOrAboveScore(candidates, { nowMs: NOW }, 1, 2)).toEqual([]);
  });

  it("returns an empty array for a non-finite or zero limit", () => {
    expect(pickTopMetadataOpportunitiesAtOrAboveScore(candidates, { nowMs: NOW }, 0.1, 0)).toEqual([]);
    expect(pickTopMetadataOpportunitiesAtOrAboveScore(candidates, { nowMs: NOW }, 0.1, -1)).toEqual([]);
    expect(pickTopMetadataOpportunitiesAtOrAboveScore(candidates, { nowMs: NOW }, 0.1, Number.NaN)).toEqual([]);
    expect(
      pickTopMetadataOpportunitiesAtOrAboveScore(candidates, { nowMs: NOW }, 0.1, Number.POSITIVE_INFINITY),
    ).toEqual([]);
  });

  it("skips miner-disabled repos before thresholding and slicing", () => {
    const ranked = pickTopMetadataOpportunitiesAtOrAboveScore(
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
      5,
    );
    expect(ranked.map((entry) => entry.issueNumber)).toEqual([2]);
  });

  it("is exported from the package barrel", async () => {
    const barrel = await import("../../packages/loopover-engine/src/index");
    expect(typeof barrel.pickTopMetadataOpportunitiesAtOrAboveScore).toBe("function");
    expect(
      barrel.pickTopMetadataOpportunitiesAtOrAboveScore(candidates, { nowMs: NOW }, 0.1, 1).map(
        (entry: { issueNumber: number }) => entry.issueNumber,
      ),
    ).toEqual([3]);
  });
});
