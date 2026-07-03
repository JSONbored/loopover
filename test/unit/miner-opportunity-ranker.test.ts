import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import {
  rankCandidateIssues,
  rankCandidateIssuesWithSummary,
} from "../../packages/gittensory-miner/lib/opportunity-ranker.js";

const NOW = Date.parse("2026-07-03T12:00:00.000Z");

function rawIssue(overrides: Record<string, unknown> = {}) {
  return {
    owner: "acme",
    repo: "widgets",
    repoFullName: "acme/widgets",
    issueNumber: 42,
    title: "Add queue retry helper",
    labels: ["help wanted"],
    commentsCount: 1,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    htmlUrl: "https://github.com/acme/widgets/issues/42",
    aiPolicyAllowed: true as const,
    aiPolicySource: "CONTRIBUTING.md" as const,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rankCandidateIssues (#2302 follow-up)", () => {
  it("ranks valid fan-out candidates and annotates rankScore", () => {
    const ranked = rankCandidateIssues(
      [
        rawIssue({ issueNumber: 1, labels: ["question"] }),
        rawIssue({ issueNumber: 2, labels: ["help wanted", "good first issue"] }),
        rawIssue({ issueNumber: 3, labels: ["enhancement"] }),
      ],
      { nowMs: NOW },
    );

    expect(ranked[0]?.issueNumber).toBe(2);
    expect(ranked[0]?.rankScore).toBeGreaterThan(ranked[1]?.rankScore ?? 0);
    expect(ranked.every((entry) => entry.rankScore >= 0)).toBe(true);
  });

  it("deduplicates repo/issue pairs and drops malformed entries", () => {
    const ranked = rankCandidateIssues(
      [
        rawIssue(),
        rawIssue(),
        { ...rawIssue(), issueNumber: "nope" as unknown as number },
        { ...rawIssue(), repoFullName: "" },
        null as unknown as ReturnType<typeof rawIssue>,
      ],
      { nowMs: NOW },
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.issueNumber).toBe(42);
  });

  it("parses per-repo goal-spec YAML content when ranking", () => {
    const ranked = rankCandidateIssues([rawIssue({ labels: ["feature"] })], {
      nowMs: NOW,
      goalSpecContentByRepo: {
        "acme/widgets": "preferredLabels: [feature]\nissueDiscoveryPolicy: encouraged\n",
      },
    });
    expect(ranked[0]?.laneFit).toBeGreaterThanOrEqual(0.85);
  });

  it("raises dupRisk when repo-level contention inputs are provided", () => {
    const calm = rankCandidateIssues([rawIssue()], { nowMs: NOW, highRiskDuplicateClusters: 0, openPullRequests: 4 });
    const busy = rankCandidateIssues([rawIssue()], { nowMs: NOW, highRiskDuplicateClusters: 4, openPullRequests: 4 });
    expect(busy[0]?.dupRisk).toBeGreaterThan(calm[0]?.dupRisk ?? 0);
    expect(busy[0]?.rankScore ?? 1).toBeLessThan(calm[0]?.rankScore ?? 0);
  });

  it("summary reports skipped invalid rows and default goal-spec usage", () => {
    const summary = rankCandidateIssuesWithSummary(
      [rawIssue(), { bad: true } as unknown as ReturnType<typeof rawIssue>, rawIssue({ issueNumber: 0 })],
      {
        nowMs: NOW,
      },
    );
    expect(summary.issues).toHaveLength(1);
    expect(summary.skippedInvalid).toBe(2);
    expect(summary.usedDefaultGoalSpec).toBe(true);
    expect(summary.defaultGoalSpec.minerEnabled).toBe(true);
  });

  it("prefers fresher, better-labeled opportunities over stale question threads", () => {
    const ranked = rankCandidateIssues(
      [
        rawIssue({
          issueNumber: 10,
          labels: ["question"],
          updatedAt: "2023-01-01T00:00:00.000Z",
          commentsCount: 30,
        }),
        rawIssue({
          issueNumber: 11,
          labels: ["help wanted", "bug"],
          updatedAt: "2026-07-03T08:00:00.000Z",
          commentsCount: 0,
        }),
      ],
      { nowMs: NOW },
    );
    expect(ranked[0]?.issueNumber).toBe(11);
  });

  it("never mutates the input array", () => {
    const input = [rawIssue(), rawIssue({ issueNumber: 43, title: "Second issue" })];
    const snapshot = structuredClone(input);
    rankCandidateIssues(input, { nowMs: NOW });
    expect(input).toEqual(snapshot);
  });

  it("returns an empty list for non-array input", () => {
    expect(rankCandidateIssues(undefined as never, { nowMs: NOW })).toEqual([]);
  });

  it("accepts pre-parsed goal specs and normalizes ai policy metadata", () => {
    const ranked = rankCandidateIssues(
      [
        rawIssue({
          aiPolicySource: "none",
          labels: ["documentation"],
        }),
      ],
      {
        nowMs: NOW,
        goalSpecsByRepo: {
          "acme/widgets": {
            minerEnabled: true,
            wantedPaths: [],
            blockedPaths: [],
            preferredLabels: ["documentation"],
            blockedLabels: [],
            maxConcurrentClaims: 2,
            issueDiscoveryPolicy: "neutral",
          },
        },
      },
    );
    expect(ranked[0]?.laneFit).toBe(1);
    expect(ranked[0]?.aiPolicySource).toBe("none");
  });
});
