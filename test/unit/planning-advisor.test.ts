import { describe, expect, it } from "vitest";
import { __rewardRiskInternals } from "../../src/signals/reward-risk";
import { __decisionPackInternals } from "../../src/services/decision-pack";

const { computeCompetitionFactor, computeFreshnessFactor, buildAdvisoryAdvice, buildEligibilityGap, round, clamp } = __rewardRiskInternals;
const { buildDecisionPackAdvisoryAdvice, buildDecisionPackEligibilityGap } = __decisionPackInternals;

// ── helpers ──────────────────────────────────────────────────────────────────

function issue(number: number, state: "open" | "closed", linkedPrs: number[] = [], createdDaysAgo?: number) {
  const createdAt = createdDaysAgo !== undefined
    ? new Date(Date.now() - createdDaysAgo * 24 * 60 * 60 * 1000).toISOString()
    : undefined;
  return { repoFullName: "owner/repo", number, title: `Issue ${number}`, state, labels: [], linkedPrs, createdAt } as any;
}

function pr(number: number, state: "open" | "closed" | "merged", linkedIssues: number[] = []) {
  return { repoFullName: "owner/repo", number, title: `PR ${number}`, state, linkedIssues } as any;
}

function makePreview(openPrCount: number, openPrThreshold: number, credibilityObserved = 0.9, credibilityFloor = 0.8) {
  return {
    gates: { openPrCount, openPrThreshold, credibilityObserved, credibilityFloor },
    laneMath: { directPrSlice: 0.02 },
  } as any;
}

function makeLane(lane: string) {
  return { lane } as any;
}

function makeQueueHealth(level: "low" | "medium" | "high" | "critical") {
  return { level, burdenScore: level === "critical" ? 80 : level === "high" ? 55 : level === "medium" ? 30 : 10 } as any;
}

// ── computeCompetitionFactor ──────────────────────────────────────────────────

describe("computeCompetitionFactor", () => {
  it("returns 1 when there are no open issues", () => {
    expect(computeCompetitionFactor([], [])).toBe(1);
    expect(computeCompetitionFactor([issue(1, "closed")], [])).toBe(1);
  });

  it("returns 1 when no open issues have linked open PRs", () => {
    const issues = [issue(1, "open"), issue(2, "open")];
    const prs = [pr(10, "closed", [1])]; // closed PR does not count
    expect(computeCompetitionFactor(issues, prs)).toBe(1);
  });

  it("returns 0 when every open issue has a competing open PR", () => {
    const issues = [issue(1, "open", [10]), issue(2, "open", [11])];
    const prs = [pr(10, "open", [1]), pr(11, "open", [2])];
    expect(computeCompetitionFactor(issues, prs)).toBe(0);
  });

  it("returns 0.5 when half of open issues are competed", () => {
    const issues = [issue(1, "open"), issue(2, "open")];
    const prs = [pr(10, "open", [1])];
    expect(computeCompetitionFactor(issues, prs)).toBe(0.5);
  });

  it("ignores closed issues when computing ratio", () => {
    const issues = [issue(1, "open"), issue(2, "closed"), issue(3, "closed")];
    const prs = [pr(10, "open", [1])]; // competes with only open issue #1
    expect(computeCompetitionFactor(issues, prs)).toBe(0); // 1 open / 1 total = 100% competed
  });

  it("handles multiple PRs linked to the same issue without double-counting", () => {
    const issues = [issue(1, "open"), issue(2, "open")];
    const prs = [pr(10, "open", [1]), pr(11, "open", [1])]; // both link to issue #1
    // 1 out of 2 issues competed → factor = 0.5
    expect(computeCompetitionFactor(issues, prs)).toBe(0.5);
  });
});

// ── computeFreshnessFactor ───────────────────────────────────────────────────

describe("computeFreshnessFactor", () => {
  it("returns 0.5 when there are no open issues with dates", () => {
    expect(computeFreshnessFactor([])).toBe(0.5);
    expect(computeFreshnessFactor([issue(1, "open", [])])).toBe(0.5); // no createdAt
    expect(computeFreshnessFactor([issue(1, "closed", [], 5)])).toBe(0.5); // closed, not counted
  });

  it("returns close to 1 for very fresh issues (near 0 days old)", () => {
    const factor = computeFreshnessFactor([issue(1, "open", [], 0)]);
    expect(factor).toBeGreaterThan(0.99);
  });

  it("returns lower value for older issues", () => {
    const fresh = computeFreshnessFactor([issue(1, "open", [], 10)]);
    const stale = computeFreshnessFactor([issue(1, "open", [], 180)]);
    expect(fresh).toBeGreaterThan(stale);
  });

  it("uses median age when multiple issues are present", () => {
    // Median of [10, 90, 200] is 90 days → exp(-90/90) = exp(-1) ≈ 0.368
    const issues = [issue(1, "open", [], 10), issue(2, "open", [], 90), issue(3, "open", [], 200)];
    const factor = computeFreshnessFactor(issues);
    expect(factor).toBeCloseTo(Math.exp(-1), 2);
  });

  it("clamps to [0, 1]", () => {
    const factor = computeFreshnessFactor([issue(1, "open", [], 9999)]);
    expect(factor).toBeGreaterThanOrEqual(0);
    expect(factor).toBeLessThanOrEqual(1);
  });
});

// ── buildAdvisoryAdvice ───────────────────────────────────────────────────────

describe("buildAdvisoryAdvice", () => {
  const baseArgs = {
    lane: makeLane("direct_pr"),
    roleContext: { maintainerLane: false } as any,
    currentPreview: makePreview(1, 2),
    repo: { isRegistered: true } as any,
    repoOutcome: undefined,
    currentOpenPrCount: 1,
    queueHealth: makeQueueHealth("low"),
    collisionsHighRiskCount: 0,
  };

  it("returns INFO when everything is clean and there are open PRs within threshold", () => {
    const advice = buildAdvisoryAdvice(baseArgs);
    const levels = advice.map((item) => item.level);
    expect(levels).not.toContain("CRITICAL");
    expect(levels).not.toContain("WARNING");
    expect(advice.some((item) => item.code === "open_prs_within_threshold")).toBe(true);
  });

  it("emits CRITICAL for open PR threshold exceeded", () => {
    const args = { ...baseArgs, currentOpenPrCount: 5, currentPreview: makePreview(5, 2) };
    const advice = buildAdvisoryAdvice(args);
    expect(advice.some((item) => item.level === "CRITICAL" && item.code === "open_pr_threshold_exceeded")).toBe(true);
  });

  it("emits CRITICAL for credibility below floor", () => {
    const args = { ...baseArgs, currentPreview: makePreview(0, 2, 0.5, 0.8) };
    const advice = buildAdvisoryAdvice(args);
    expect(advice.some((item) => item.level === "CRITICAL" && item.code === "credibility_below_floor")).toBe(true);
  });

  it("emits CRITICAL for inactive lane", () => {
    const args = { ...baseArgs, lane: makeLane("inactive") };
    const advice = buildAdvisoryAdvice(args);
    expect(advice.some((item) => item.level === "CRITICAL" && item.code === "inactive_lane")).toBe(true);
  });

  it("emits CRITICAL for unregistered repo", () => {
    const args = { ...baseArgs, repo: { isRegistered: false } as any };
    const advice = buildAdvisoryAdvice(args);
    expect(advice.some((item) => item.level === "CRITICAL" && item.code === "unregistered_repo")).toBe(true);
  });

  it("emits WARNING for high closed PR rate", () => {
    const args = { ...baseArgs, repoOutcome: { closedPullRequestRate: 0.4 } as any };
    const advice = buildAdvisoryAdvice(args);
    expect(advice.some((item) => item.level === "WARNING" && item.code === "high_closed_pr_rate")).toBe(true);
  });

  it("emits WARNING for high queue burden", () => {
    const args = { ...baseArgs, queueHealth: makeQueueHealth("high") };
    const advice = buildAdvisoryAdvice(args);
    expect(advice.some((item) => item.level === "WARNING" && item.code === "high_queue_burden")).toBe(true);
  });

  it("emits WARNING for collision risk", () => {
    const args = { ...baseArgs, collisionsHighRiskCount: 3 };
    const advice = buildAdvisoryAdvice(args);
    expect(advice.some((item) => item.level === "WARNING" && item.code === "collision_risk")).toBe(true);
  });

  it("emits TIP for maintainer lane", () => {
    const args = { ...baseArgs, roleContext: { maintainerLane: true } as any };
    const advice = buildAdvisoryAdvice(args);
    expect(advice.some((item) => item.level === "TIP" && item.code === "maintainer_lane")).toBe(true);
  });

  it("emits TIP for issue-discovery-only repos", () => {
    const args = { ...baseArgs, lane: makeLane("issue_discovery") };
    const advice = buildAdvisoryAdvice(args);
    expect(advice.some((item) => item.level === "TIP" && item.code === "issue_discovery_only")).toBe(true);
  });

  it("does not emit open_prs_within_threshold when open PR count is 0", () => {
    const args = { ...baseArgs, currentOpenPrCount: 0 };
    const advice = buildAdvisoryAdvice(args);
    expect(advice.some((item) => item.code === "open_prs_within_threshold")).toBe(false);
  });
});

// ── buildEligibilityGap ──────────────────────────────────────────────────────

describe("buildEligibilityGap", () => {
  function makeAnalysis(repoFullName: string, openPrCount: number, openPrThreshold: number) {
    return {
      repoFullName,
      riskBreakdown: { openPullRequests: openPrCount },
      currentPreview: { gates: { openPrThreshold } },
    } as any;
  }

  it("returns empty array when no repo exceeds threshold", () => {
    const analyses = [makeAnalysis("owner/a", 1, 2), makeAnalysis("owner/b", 2, 2)];
    expect(buildEligibilityGap(analyses)).toEqual([]);
  });

  it("returns repos where prsNeededToUnlock is 1–5", () => {
    const analyses = [
      makeAnalysis("owner/close", 3, 2),  // needs 1 to unlock
      makeAnalysis("owner/far", 10, 2),   // needs 8, excluded
      makeAnalysis("owner/clean", 1, 2),  // not blocked, excluded
    ];
    const gap = buildEligibilityGap(analyses);
    expect(gap).toHaveLength(1);
    expect(gap[0]!.repoFullName).toBe("owner/close");
    expect(gap[0]!.prsNeededToUnlock).toBe(1);
    expect(gap[0]!.currentOpenPrCount).toBe(3);
    expect(gap[0]!.openPrThreshold).toBe(2);
  });

  it("sorts by prsNeededToUnlock ascending, then by repoFullName", () => {
    const analyses = [
      makeAnalysis("owner/b", 5, 2), // needs 3
      makeAnalysis("owner/a", 4, 2), // needs 2
      makeAnalysis("owner/c", 4, 2), // needs 2, alphabetically after a
    ];
    const gap = buildEligibilityGap(analyses);
    expect(gap[0]!.repoFullName).toBe("owner/a");
    expect(gap[1]!.repoFullName).toBe("owner/c");
    expect(gap[2]!.repoFullName).toBe("owner/b");
  });

  it("includes repos where prsNeededToUnlock is exactly 5", () => {
    const analyses = [makeAnalysis("owner/edge", 7, 2)]; // needs 5
    const gap = buildEligibilityGap(analyses);
    expect(gap).toHaveLength(1);
    expect(gap[0]!.prsNeededToUnlock).toBe(5);
  });
});

// ── buildDecisionPackAdvisoryAdvice ──────────────────────────────────────────

describe("buildDecisionPackAdvisoryAdvice", () => {
  it("returns empty array for no blockers", () => {
    expect(buildDecisionPackAdvisoryAdvice([])).toEqual([]);
  });

  it("maps severity to AdvisoryLevel correctly", () => {
    const blockers = [
      { code: "inactive_or_unknown_lane", severity: "critical", detail: "Lane inactive.", repoFullName: "owner/repo" },
      { code: "closed_pr_credibility", severity: "warning", detail: "Closed rate high.", repoFullName: "owner/repo" },
      { code: "maintainer_lane", severity: "info", detail: "Maintainer lane.", repoFullName: "owner/repo" },
    ] as any;
    const advice = buildDecisionPackAdvisoryAdvice(blockers);
    expect(advice[0]!.level).toBe("CRITICAL");
    expect(advice[1]!.level).toBe("WARNING");
    expect(advice[2]!.level).toBe("INFO");
  });

  it("sorts by severity before slicing to 10", () => {
    const blockers = [
      { code: "a", severity: "info", detail: "info msg.", repoFullName: "r" },
      { code: "b", severity: "critical", detail: "critical msg.", repoFullName: "r" },
      { code: "c", severity: "warning", detail: "warning msg.", repoFullName: "r" },
    ] as any;
    const advice = buildDecisionPackAdvisoryAdvice(blockers);
    expect(advice[0]!.level).toBe("CRITICAL");
    expect(advice[1]!.level).toBe("WARNING");
    expect(advice[2]!.level).toBe("INFO");
  });

  it("slices to at most 10 items", () => {
    const blockers = Array.from({ length: 15 }, (_, i) => ({
      code: `code_${i}`,
      severity: "info",
      detail: `detail ${i}`,
      repoFullName: "owner/repo",
    })) as any;
    expect(buildDecisionPackAdvisoryAdvice(blockers)).toHaveLength(10);
  });

  it("falls back to INFO level and stable order for an unexpected severity", () => {
    // The severity maps are exhaustively typed, but an unexpected severity must never crash: the sort
    // ranks it lowest (?? 3) and the level falls back to "INFO" (?? "INFO").
    const blockers = [
      { code: "x", severity: "bogus", detail: "unknown severity a.", repoFullName: "r" },
      { code: "y", severity: "other", detail: "unknown severity b.", repoFullName: "r" },
    ] as any;
    const advice = buildDecisionPackAdvisoryAdvice(blockers);
    expect(advice).toHaveLength(2);
    expect(advice.every((item) => item.level === "INFO")).toBe(true);
  });
});

// ── buildDecisionPackEligibilityGap ──────────────────────────────────────────

describe("buildDecisionPackEligibilityGap", () => {
  function makeDecision(repoFullName: string, openPullRequests: number) {
    return {
      repoFullName,
      outcome: { openPullRequests },
    } as any;
  }

  it("returns empty array when no repo is near the threshold", () => {
    const decisions = [makeDecision("owner/a", 2), makeDecision("owner/b", 0)];
    expect(buildDecisionPackEligibilityGap(decisions)).toEqual([]);
  });

  it("returns repos where outcome openPullRequests is 5–9 (1–5 PRs needed to go below 5)", () => {
    // threshold is 4 (open_pr_pressure fires at >= 5), so need to go to <= 4
    const decisions = [
      makeDecision("owner/close", 5), // needs 1
      makeDecision("owner/far", 15),  // needs 11, excluded
      makeDecision("owner/ok", 3),    // below threshold, excluded
    ];
    const gap = buildDecisionPackEligibilityGap(decisions);
    expect(gap).toHaveLength(1);
    expect(gap[0]!.repoFullName).toBe("owner/close");
    expect(gap[0]!.prsNeededToUnlock).toBe(1);
    expect(gap[0]!.openPrThreshold).toBe(4);
  });

  it("handles decisions without outcome (defaults to 0 open PRs)", () => {
    const decisions = [{ repoFullName: "owner/no-outcome" }] as any;
    expect(buildDecisionPackEligibilityGap(decisions)).toEqual([]);
  });

  it("sorts ascending by prsNeededToUnlock then repoFullName", () => {
    const decisions = [
      makeDecision("owner/b", 7), // needs 3
      makeDecision("owner/a", 6), // needs 2
    ];
    const gap = buildDecisionPackEligibilityGap(decisions);
    expect(gap[0]!.repoFullName).toBe("owner/a");
    expect(gap[1]!.repoFullName).toBe("owner/b");
  });

  it("breaks ties in prsNeededToUnlock by repoFullName", () => {
    const decisions = [
      makeDecision("owner/b", 6), // needs 2
      makeDecision("owner/a", 6), // needs 2 (tie → localeCompare puts a first)
    ];
    const gap = buildDecisionPackEligibilityGap(decisions);
    expect(gap.map((entry) => entry.repoFullName)).toEqual(["owner/a", "owner/b"]);
  });
});
