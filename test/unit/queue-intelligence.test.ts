import { describe, expect, it } from "vitest";
import {
  analyzePRQueue,
  generatePublicComment,
  sanitizePublicComment,
  FORBIDDEN_PUBLIC_COMMENT_WORDS,
} from "../../src/queue-intelligence";
import type { ChecksStatus, PullRequestInput, RepoContext, Recommendation } from "../../src/queue-intelligence";

const defaultContext: RepoContext = {
  totalOpenPRs: 10,
  avgReviewTimeDays: 3,
  maintainerWorkload: 0.5,
};

function makePR(overrides: Partial<PullRequestInput> & { number: number }): PullRequestInput {
  const now = Date.now();
  const createdAt = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();
  const lastUpdatedAt = new Date(now - 60 * 60 * 1000).toISOString();
  return {
    author: "oktofeesh1",
    authorRole: "contributor",
    isConfirmedMiner: true,
    linkedIssue: { qualityScore: 0.9 },
    checksStatus: "passing",
    isStale: false,
    additions: 50,
    deletions: 10,
    title: "Fix cache refresh",
    body: "Fixes #123",
    duplicateCandidates: [],
    createdAt,
    lastUpdatedAt,
    ...overrides,
  };
}

describe("analyzePRQueue — recommendations", () => {
  it("assigns review_now to a confirmed miner with passing checks and good issue quality", async () => {
    const pr = makePR({ number: 1 });
    const { rankedPRs, recommendations } = await analyzePRQueue([pr], defaultContext);
    expect(recommendations.get(1)).toBe("review_now");
    expect(rankedPRs[0]).toBe(pr);
  });

  it("assigns review_now when checksStatus is pending but updated less than 2 days ago", async () => {
    const recentUpdate = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const pr = makePR({ number: 2, checksStatus: "pending", lastUpdatedAt: recentUpdate });
    const { recommendations } = await analyzePRQueue([pr], defaultContext);
    expect(recommendations.get(2)).toBe("review_now");
  });

  it("assigns needs_author when checksStatus is failing", async () => {
    const pr = makePR({ number: 3, checksStatus: "failing" });
    const { recommendations } = await analyzePRQueue([pr], defaultContext);
    expect(recommendations.get(3)).toBe("needs_author");
  });

  it("assigns needs_author when linkedIssue is null", async () => {
    const pr = makePR({ number: 4, linkedIssue: null });
    const { recommendations } = await analyzePRQueue([pr], defaultContext);
    expect(recommendations.get(4)).toBe("needs_author");
  });

  it("assigns needs_author when linkedIssue quality score is below threshold", async () => {
    const pr = makePR({ number: 5, linkedIssue: { qualityScore: 0.2 } });
    const { recommendations } = await analyzePRQueue([pr], defaultContext);
    expect(recommendations.get(5)).toBe("needs_author");
  });

  it("assigns needs_author when PR title is empty", async () => {
    const pr = makePR({ number: 6, title: "" });
    const { recommendations } = await analyzePRQueue([pr], defaultContext);
    expect(recommendations.get(6)).toBe("needs_author");
  });

  it("assigns needs_author when PR title is whitespace only", async () => {
    const pr = makePR({ number: 7, title: "   " });
    const { recommendations } = await analyzePRQueue([pr], defaultContext);
    expect(recommendations.get(7)).toBe("needs_author");
  });

  it("assigns needs_author when PR body is empty", async () => {
    const pr = makePR({ number: 8, body: "" });
    const { recommendations } = await analyzePRQueue([pr], defaultContext);
    expect(recommendations.get(8)).toBe("needs_author");
  });

  it("assigns needs_author when PR body is whitespace only", async () => {
    const pr = makePR({ number: 9, body: "   " });
    const { recommendations } = await analyzePRQueue([pr], defaultContext);
    expect(recommendations.get(9)).toBe("needs_author");
  });

  it("assigns redirect when duplicateCandidates is non-empty", async () => {
    const pr = makePR({ number: 10, duplicateCandidates: [42, 43] });
    const { recommendations } = await analyzePRQueue([pr], defaultContext);
    expect(recommendations.get(10)).toBe("redirect");
  });

  it("assigns maintainer_lane when author role is maintainer", async () => {
    const pr = makePR({ number: 11, authorRole: "maintainer" });
    const { recommendations } = await analyzePRQueue([pr], defaultContext);
    expect(recommendations.get(11)).toBe("maintainer_lane");
  });

  it("assigns maintainer_lane even when checks are failing (maintainer takes priority)", async () => {
    const pr = makePR({ number: 12, authorRole: "maintainer", checksStatus: "failing" });
    const { recommendations } = await analyzePRQueue([pr], defaultContext);
    expect(recommendations.get(12)).toBe("maintainer_lane");
  });

  it("assigns watch when PR is stale", async () => {
    const pr = makePR({ number: 13, isStale: true });
    const { recommendations } = await analyzePRQueue([pr], defaultContext);
    expect(recommendations.get(13)).toBe("watch");
  });

  it("assigns watch when PR is very large (additions + deletions > 1500)", async () => {
    const pr = makePR({ number: 14, additions: 1000, deletions: 600 });
    const { recommendations } = await analyzePRQueue([pr], defaultContext);
    expect(recommendations.get(14)).toBe("watch");
  });

  it("assigns watch when checksStatus is pending for more than 2 days", async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const pr = makePR({ number: 15, checksStatus: "pending", lastUpdatedAt: threeDaysAgo });
    const { recommendations } = await analyzePRQueue([pr], defaultContext);
    expect(recommendations.get(15)).toBe("watch");
  });

  it("returns an empty rankedPRs and empty recommendations map for an empty input array", async () => {
    const { rankedPRs, recommendations } = await analyzePRQueue([], defaultContext);
    expect(rankedPRs).toHaveLength(0);
    expect(recommendations.size).toBe(0);
  });
});

describe("analyzePRQueue — ranking (reviewability + burden reduction)", () => {
  it("sorts PRs by privateReviewabilityScore descending, then privateBurdenReductionScore descending", async () => {
    const now = Date.now();
    const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();
    const oneDayAgo = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString();

    // score = 90: miner(+50) + passing(+20) + quality>0.7(+20)
    const highScoreRecent = makePR({ number: 1, createdAt: oneDayAgo });

    // score = 90 but older → higher burdenReduction → ranks above highScoreRecent
    const highScoreOld = makePR({ number: 2, createdAt: tenDaysAgo });

    // score = 70: miner(+50) + passing(+20), qualityScore=0.5 ≤ 0.7 → no quality bonus
    const medScore = makePR({ number: 3, linkedIssue: { qualityScore: 0.5 }, createdAt: tenDaysAgo });

    // score = -10: not miner, failing(+20 quality, -30 needsAuthor)
    const lowScore = makePR({
      number: 4,
      isConfirmedMiner: false,
      checksStatus: "failing",
      createdAt: tenDaysAgo,
    });

    const { rankedPRs } = await analyzePRQueue(
      [lowScore, medScore, highScoreRecent, highScoreOld],
      defaultContext,
    );

    expect(rankedPRs[0]).toBe(highScoreOld);
    expect(rankedPRs[1]).toBe(highScoreRecent);
    expect(rankedPRs[2]).toBe(medScore);
    expect(rankedPRs[3]).toBe(lowScore);
  });

  it("breaks tied reviewability scores by privateBurdenReductionScore (older/larger PR wins)", async () => {
    const now = Date.now();
    const old = new Date(now - 20 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString();
    const prOld = makePR({ number: 1, createdAt: old });
    const prRecent = makePR({ number: 2, createdAt: recent });

    const { rankedPRs } = await analyzePRQueue([prRecent, prOld], defaultContext);
    expect(rankedPRs[0]).toBe(prOld);
    expect(rankedPRs[1]).toBe(prRecent);
  });
});

describe("analyzePRQueue — performance", () => {
  it("ranks 120 PRs in under 50ms", async () => {
    const prs: PullRequestInput[] = Array.from({ length: 120 }, (_, i) =>
      makePR({ number: i + 1, isConfirmedMiner: i % 3 !== 0, checksStatus: i % 5 === 0 ? "failing" : "passing" }),
    );
    const start = performance.now();
    await analyzePRQueue(prs, defaultContext);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});

describe("generatePublicComment — Rule 1: non-miners receive no comment", () => {
  it("returns null when isConfirmedMiner is false", () => {
    const pr = makePR({ number: 1 });
    expect(generatePublicComment(pr, "review_now", false)).toBeNull();
  });

  it("returns null for non-miner regardless of checksStatus", () => {
    const prFailing = makePR({ number: 2, checksStatus: "failing" });
    expect(generatePublicComment(prFailing, "needs_author", false)).toBeNull();
    const prPending = makePR({ number: 3, checksStatus: "pending" });
    expect(generatePublicComment(prPending, "watch", false)).toBeNull();
  });
});

describe("generatePublicComment — Rule 2: minimal and safe comments for confirmed miners", () => {
  it("returns passing comment when checksStatus is passing", () => {
    const pr = makePR({ number: 1, checksStatus: "passing" });
    expect(generatePublicComment(pr, "review_now", true)).toBe("Checks are passing. Ready for review.");
  });

  it("returns failing comment when checksStatus is failing", () => {
    const pr = makePR({ number: 2, checksStatus: "failing" });
    expect(generatePublicComment(pr, "needs_author", true)).toBe("Please address the failing checks.");
  });

  it("returns failing comment when checksStatus is pending", () => {
    const pr = makePR({ number: 3, checksStatus: "pending" });
    expect(generatePublicComment(pr, "watch", true)).toBe("Please address the failing checks.");
  });
});

describe("generatePublicComment — Rule 3: public/private boundary invariant", () => {
  const allRecommendations: Recommendation[] = [
    "review_now",
    "needs_author",
    "watch",
    "redirect",
    "maintainer_lane",
  ];

  it("never leaks the internal recommendation string in the public comment", () => {
    const pr = makePR({ number: 1 });
    for (const rec of allRecommendations) {
      const comment = generatePublicComment(pr, rec, true);
      expect(comment).not.toContain("review_now");
      expect(comment).not.toContain("needs_author");
      expect(comment).not.toContain("watch");
      expect(comment).not.toContain("redirect");
      expect(comment).not.toContain("maintainer_lane");
    }
  });

  it("never leaks private score variable names or numeric score values in the public comment", () => {
    const pr = makePR({ number: 2 });
    const comment = generatePublicComment(pr, "review_now", true);
    expect(comment).not.toMatch(/privateReviewabilityScore|privateBurdenReductionScore/);
    expect(comment).not.toMatch(/\b\d+\s*(points?|score)\b/i);
  });
});

describe("sanitizePublicComment — sanitizer regression", () => {
  it("throws for each forbidden word (case-insensitive)", () => {
    for (const forbiddenWord of FORBIDDEN_PUBLIC_COMMENT_WORDS) {
      expect(() =>
        sanitizePublicComment(`This comment contains ${forbiddenWord} information`),
      ).toThrow(forbiddenWord);
      expect(() =>
        sanitizePublicComment(`Check: ${forbiddenWord.toUpperCase()} is present`),
      ).toThrow();
    }
  });

  it("passes clean comments through unchanged", () => {
    const passing = "Checks are passing. Ready for review.";
    const failing = "Please address the failing checks.";
    expect(sanitizePublicComment(passing)).toBe(passing);
    expect(sanitizePublicComment(failing)).toBe(failing);
  });

  it("public comment output never contains any forbidden word", () => {
    const prPassing = makePR({ number: 1, checksStatus: "passing" });
    const prFailing = makePR({ number: 2, checksStatus: "failing" });
    const passingComment = generatePublicComment(prPassing, "review_now", true)!;
    const failingComment = generatePublicComment(prFailing, "needs_author", true)!;

    for (const forbiddenWord of FORBIDDEN_PUBLIC_COMMENT_WORDS) {
      expect(passingComment.toLowerCase()).not.toContain(forbiddenWord.toLowerCase());
      expect(failingComment.toLowerCase()).not.toContain(forbiddenWord.toLowerCase());
    }
  });

  it("generatePublicComment output never matches forbidden language across all inputs (explicit regex)", () => {
    const forbiddenPattern =
      /wallet|hotkey|raw trust score|payout|reward estimate|farming|private reviewability|public score estimate/i;
    const allChecksStatuses: Array<ChecksStatus> = ["passing", "failing", "pending"];
    const allRecommendations: Recommendation[] = [
      "review_now",
      "needs_author",
      "watch",
      "redirect",
      "maintainer_lane",
    ];

    for (const checksStatus of allChecksStatuses) {
      for (const rec of allRecommendations) {
        const pr = makePR({ number: 1, checksStatus });
        const comment = generatePublicComment(pr, rec, true);
        expect(JSON.stringify(comment)).not.toMatch(forbiddenPattern);
      }
    }
  });
});
