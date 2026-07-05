import { describe, expect, it } from "vitest";

import { DEFAULT_MINER_GOAL_SPEC } from "../../packages/gittensory-engine/src/miner-goal-spec";
import { bestMetadataOpportunity } from "../../packages/gittensory-engine/src/metadata-best-pick";

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

describe("bestMetadataOpportunity", () => {
  it("returns null for an empty candidate list", () => {
    expect(bestMetadataOpportunity([], { nowMs: NOW })).toBeNull();
  });

  it("returns the highest-scoring metadata candidate", () => {
    const best = bestMetadataOpportunity(
      [
        { ...base, issueNumber: 1, labels: ["wontfix"] },
        { ...base, issueNumber: 2, labels: ["help wanted"] },
        { ...base, issueNumber: 3, labels: ["help wanted", "bug"] },
      ],
      { nowMs: NOW },
    );
    expect(best?.issueNumber).toBe(3);
    expect(best?.rankScore).toBeGreaterThan(0);
  });

  it("returns null when every candidate is miner-disabled", () => {
    expect(
      bestMetadataOpportunity(
        [{ ...base, issueNumber: 1, repoFullName: "acme/disabled" }],
        {
          nowMs: NOW,
          goalSpecsByRepo: {
            "acme/disabled": { ...DEFAULT_MINER_GOAL_SPEC, minerEnabled: false },
          },
        },
      ),
    ).toBeNull();
  });

  it("breaks score ties by input order", () => {
    const tie = { potential: 0.8, feasibility: 0.8, laneFit: 1, freshness: 1, dupRisk: 0 };
    const best = bestMetadataOpportunity(
      [
        { ...base, issueNumber: 1, ...tie },
        { ...base, issueNumber: 2, ...tie },
      ],
      { nowMs: NOW },
    );
    expect(best?.issueNumber).toBe(1);
  });

  it("is exported from the package barrel", async () => {
    const barrel = await import("../../packages/gittensory-engine/src/index");
    expect(typeof barrel.bestMetadataOpportunity).toBe("function");
    expect(
      barrel.bestMetadataOpportunity([{ ...base, issueNumber: 9, labels: ["help wanted"] }], { nowMs: NOW })
        ?.issueNumber,
    ).toBe(9);
  });
});
