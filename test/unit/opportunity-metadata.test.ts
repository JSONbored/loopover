import { describe, expect, it } from "vitest";

import {
  DEFAULT_MINER_GOAL_SPEC,
  buildMetadataRankInput,
  computeMetadataDupRisk,
  computeMetadataFeasibility,
  computeMetadataPotential,
  rankMetadataOpportunities,
  type MetadataCandidateIssue,
  type MetadataRankContext,
} from "../../packages/loopover-engine/src/index";
import { opportunityMetadataInternals } from "../../packages/loopover-engine/src/opportunity-metadata";

// #9616: direct unit tests for every branch opportunity-metadata.ts's blanket `v8 ignore` directives
// used to hide, mirrored from packages/loopover-engine/test/opportunity-metadata.test.ts so the
// backend flag's vitest run grades the same arms the engine flag's node:test suite does.

const NOW_ISO = "2026-07-29T00:00:00Z";
const NOW = Date.parse(NOW_ISO);

function issueFor(overrides: Partial<MetadataCandidateIssue> = {}): MetadataCandidateIssue {
  return {
    repoFullName: "acme/widgets",
    issueNumber: 1,
    title: "improve the flaky retry logic in ci",
    labels: [],
    commentsCount: 0,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides,
  };
}

describe("computeMetadataPotential (#9616)", () => {
  it("collapses on a negative label, even alongside positive ones", () => {
    expect(computeMetadataPotential({ labels: ["blocked"] })).toBe(0);
    expect(computeMetadataPotential({ labels: ["help wanted", "wontfix"] })).toBe(0);
  });

  it("applies positive/bug/refactor bonuses over the neutral 0.45 baseline", () => {
    expect(computeMetadataPotential({ labels: ["chore"] })).toBeCloseTo(0.45, 9);
    expect(computeMetadataPotential({ labels: [] })).toBeCloseTo(0.45, 9);
    expect(computeMetadataPotential({ labels: ["help wanted"] })).toBeCloseTo(0.8, 9);
    expect(computeMetadataPotential({ labels: ["bug"] })).toBeCloseTo(0.55, 9);
    expect(computeMetadataPotential({ labels: ["refactor"] })).toBeCloseTo(0.5, 9);
    expect(computeMetadataPotential({ labels: ["bug", "refactor"] })).toBeCloseTo(0.6, 9);
    expect(computeMetadataPotential({ labels: ["good first issue", "bug", "refactor"] })).toBeCloseTo(0.95, 9);
  });

  it("normalizes labels: trims, lowercases, drops non-strings and blanks", () => {
    expect(computeMetadataPotential({ labels: ["  BUG  "] })).toBeCloseTo(0.55, 9);
    expect(computeMetadataPotential({ labels: ["", "   ", 7, null] as never })).toBeCloseTo(0.45, 9);
  });
});

describe("computeMetadataFeasibility (#9616)", () => {
  it("degrades to zero on a non-finite clock", () => {
    expect(computeMetadataFeasibility(issueFor(), Number.NaN)).toBe(0);
    expect(computeMetadataFeasibility(issueFor(), Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("applies the title-length tiers at >= 8, 4-7, and < 4 on the normalized title", () => {
    expect(computeMetadataFeasibility(issueFor({ title: "abcdefgh" }), NOW)).toBeCloseTo(1, 9);
    expect(computeMetadataFeasibility(issueFor({ title: "abcd" }), NOW)).toBeCloseTo(0.94, 9);
    expect(computeMetadataFeasibility(issueFor({ title: "abc" }), NOW)).toBeCloseTo(0.88, 9);
    expect(computeMetadataFeasibility(issueFor({ title: "  a   b  " }), NOW)).toBeCloseTo(0.88, 9);
  });

  it("handles comment load, malformed counts, and timestamp fallbacks", () => {
    expect(computeMetadataFeasibility(issueFor({ commentsCount: 25 }), NOW)).toBeCloseTo(0.55, 9);
    expect(computeMetadataFeasibility(issueFor({ commentsCount: Number.NaN }), NOW)).toBe(
      computeMetadataFeasibility(issueFor({ commentsCount: 0 }), NOW),
    );
    expect(computeMetadataFeasibility(issueFor({ commentsCount: -3 }), NOW)).toBe(
      computeMetadataFeasibility(issueFor({ commentsCount: 0 }), NOW),
    );
    expect(computeMetadataFeasibility(issueFor({ updatedAt: null, createdAt: null }), NOW)).toBeCloseTo(0.65, 9);
    expect(computeMetadataFeasibility(issueFor({ updatedAt: "not a date", createdAt: NOW_ISO }), NOW)).toBeCloseTo(1, 9);
  });

  it("hits the stale sentinel when a validated timestamp later fails to re-parse (defensive guard)", () => {
    // pickMetadataTimestamp validates with the same parser issueAgeDays re-parses with, so the
    // re-parse guard can only be exercised by making the parser disagree between the two calls.
    const realParse = Date.parse;
    let calls = 0;
    Date.parse = ((value: string) => {
      calls += 1;
      return calls === 1 ? realParse(value) : Number.NaN;
    }) as typeof Date.parse;
    try {
      const reparseFailed = computeMetadataFeasibility(issueFor(), NOW);
      const noTimestamps = computeMetadataFeasibility(issueFor({ updatedAt: null, createdAt: null }), NOW);
      expect(reparseFailed).toBe(noTimestamps);
      expect(calls).toBe(2);
    } finally {
      Date.parse = realParse;
    }
  });

  it("clamps a non-finite intermediate score to zero (clamp01 defensive guard)", () => {
    const realExp = Math.exp;
    Math.exp = (() => Number.NaN) as typeof Math.exp;
    try {
      expect(computeMetadataFeasibility(issueFor(), NOW)).toBeCloseTo(0.65, 9);
    } finally {
      Math.exp = realExp;
    }
  });
});

describe("opportunityMetadataInternals (#9616)", () => {
  it("titlesOverlap: emptiness, equality, containment threshold, and swap arms", () => {
    const { titlesOverlap } = opportunityMetadataInternals;
    expect(titlesOverlap("", "anything")).toBe(false);
    expect(titlesOverlap("anything", "")).toBe(false);
    expect(titlesOverlap("same words", "same words")).toBe(true);
    expect(titlesOverlap("fix the retry logic", "please fix the retry logic now")).toBe(true);
    expect(titlesOverlap("short one", "short one plus context")).toBe(false);
    expect(titlesOverlap("please fix the retry logic now", "fix the retry logic")).toBe(true);
    expect(titlesOverlap("abcdefghijklmnop", "qrstuvwxyz0123456789")).toBe(false);
  });

  it("normalizeLabels, pickMetadataTimestamp, and resolveGoalSpec cover their normalization arms", () => {
    const { normalizeLabels, pickMetadataTimestamp, resolveGoalSpec } = opportunityMetadataInternals;
    expect(normalizeLabels(["  Bug ", "", 7, null] as never)).toEqual(["bug"]);

    expect(pickMetadataTimestamp(issueFor())).toBe(NOW_ISO);
    expect(pickMetadataTimestamp(issueFor({ updatedAt: `  ${NOW_ISO}  ` }))).toBe(NOW_ISO);
    expect(pickMetadataTimestamp(issueFor({ updatedAt: "not a date", createdAt: NOW_ISO }))).toBe(NOW_ISO);
    expect(pickMetadataTimestamp(issueFor({ updatedAt: "   ", createdAt: "   " }))).toBe("");
    expect(pickMetadataTimestamp(issueFor({ updatedAt: null, createdAt: "garbage" }))).toBe("");
    expect(pickMetadataTimestamp(issueFor({ updatedAt: null, createdAt: null }))).toBe("");

    const custom = { ...DEFAULT_MINER_GOAL_SPEC, minerEnabled: false };
    const context: MetadataRankContext = { nowMs: NOW, goalSpecsByRepo: { "  ACME/Widgets  ": custom } };
    expect(resolveGoalSpec("acme/widgets", context)).toBe(custom);
    expect(resolveGoalSpec("other/repo", context)).toBe(DEFAULT_MINER_GOAL_SPEC);
    expect(resolveGoalSpec("acme/widgets", { nowMs: NOW })).toBe(DEFAULT_MINER_GOAL_SPEC);
  });
});

describe("computeMetadataDupRisk (#9616)", () => {
  it("treats a blank title as maximum dup risk", () => {
    expect(computeMetadataDupRisk(issueFor({ title: "" }), [])).toBe(1);
    expect(computeMetadataDupRisk(issueFor({ title: "   " }), [])).toBe(1);
  });

  it("skips the self row and cross-repo peers, counts same-repo overlaps only", () => {
    expect(computeMetadataDupRisk(issueFor(), [issueFor({ repoFullName: "  ACME/Widgets  " })])).toBe(0);
    expect(computeMetadataDupRisk(issueFor(), [issueFor({ repoFullName: "other/repo" })])).toBe(0);
    expect(computeMetadataDupRisk(issueFor(), [issueFor({ repoFullName: "other/repo", issueNumber: 9 })])).toBe(0);
    const overlapping = issueFor({ issueNumber: 2, title: "Improve the flaky retry logic in CI for the queue" });
    expect(computeMetadataDupRisk(issueFor(), [overlapping])).toBeCloseTo(0.5, 9);
    const second = issueFor({ issueNumber: 3, title: "improve the flaky retry logic in ci again" });
    expect(computeMetadataDupRisk(issueFor(), [overlapping, second])).toBeCloseTo(2 / 3, 9);
    expect(computeMetadataDupRisk(issueFor(), [issueFor({ issueNumber: 4, title: "completely unrelated words" })])).toBe(0);
  });
});

describe("buildMetadataRankInput / rankMetadataOpportunities (#9616)", () => {
  it("builds the five inputs with competition context present and absent, timestamps present and absent", () => {
    const withContext = buildMetadataRankInput(issueFor({ labels: ["bug"] }), [], {
      nowMs: NOW,
      highRiskDuplicateClusters: 2,
      openPullRequests: 4,
    });
    expect(withContext.potential).toBeCloseTo(0.55, 9);
    expect(withContext.feasibility).toBeCloseTo(1, 9);
    expect(withContext.dupRisk).toBeCloseTo(0.5, 9);
    expect(withContext.laneFit).toBeGreaterThanOrEqual(0);
    expect(withContext.laneFit).toBeLessThanOrEqual(1);
    expect(withContext.freshness).toBeGreaterThanOrEqual(0);
    expect(withContext.freshness).toBeLessThanOrEqual(1);

    const bare = buildMetadataRankInput(issueFor({ updatedAt: null, createdAt: null }), [], { nowMs: NOW });
    expect(bare.dupRisk).toBe(0);
    expect(bare.freshness).toBeGreaterThanOrEqual(0);
    expect(bare.freshness).toBeLessThanOrEqual(1);
  });

  it("ranks targetable candidates and drops repos whose goal spec opts out", () => {
    const strong = issueFor({ issueNumber: 10, title: "add retry backoff to the queue worker", labels: ["help wanted", "bug"] });
    const weak = issueFor({ issueNumber: 11, title: "abc", labels: ["chore"], commentsCount: 40, updatedAt: null, createdAt: null });
    const ranked = rankMetadataOpportunities([strong, weak], { nowMs: NOW });
    expect(ranked).toHaveLength(2);
    expect(typeof ranked[0]?.rankScore).toBe("number");
    expect(ranked[0]?.rankScore ?? 0).toBeGreaterThanOrEqual(ranked[1]?.rankScore ?? 0);
    expect(ranked[0]?.issueNumber).toBe(10);

    const optedOut = rankMetadataOpportunities([strong, issueFor({ repoFullName: "other/repo", issueNumber: 12 })], {
      nowMs: NOW,
      goalSpecsByRepo: { "acme/widgets": { ...DEFAULT_MINER_GOAL_SPEC, minerEnabled: false } },
    });
    expect(optedOut.map((candidate) => candidate.issueNumber)).toEqual([12]);
  });
});
