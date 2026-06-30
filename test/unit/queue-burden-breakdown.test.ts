import { describe, expect, it } from "vitest";
import { explainQueueBurden } from "../../src/services/queue-burden-breakdown";
import { buildQueueHealth, type CollisionReport, type QueueHealth } from "../../src/signals/engine";
import type { PullRequestRecord, RepositoryRecord } from "../../src/types";

const FORBIDDEN = /\b(wallet|hotkey|coldkey|mnemonic|payout|reward|raw[-_\s]?trust|credibility|farming)\b/i;

const clamp = (value: number): number => Math.max(0, Math.min(100, value));

function makeHealth(input: {
  openPullRequests?: number;
  openIssues?: number;
  unlinkedPullRequests?: number;
  stalePullRequests?: number;
  over30Days?: number;
  collisionClusters?: number;
  likelyReviewablePullRequests?: number;
  burdenScore?: number;
  level?: QueueHealth["level"];
  repoFullName?: string;
  generatedAt?: string;
}): QueueHealth {
  return {
    repoFullName: input.repoFullName ?? "owner/repo",
    generatedAt: input.generatedAt ?? "2026-06-30T00:00:00.000Z",
    burdenScore: input.burdenScore ?? 0,
    level: input.level ?? "low",
    summary: "fixture",
    signals: {
      openIssues: input.openIssues ?? 0,
      openPullRequests: input.openPullRequests ?? 0,
      unlinkedPullRequests: input.unlinkedPullRequests ?? 0,
      stalePullRequests: input.stalePullRequests ?? 0,
      draftPullRequests: 0,
      maintainerAuthoredPullRequests: 0,
      collisionClusters: input.collisionClusters ?? 0,
      ageBuckets: { under7Days: 0, days7To30: 0, over30Days: input.over30Days ?? 0 },
      likelyReviewablePullRequests: input.likelyReviewablePullRequests ?? 0,
    },
    findings: [],
  };
}

const componentByName = (breakdown: ReturnType<typeof explainQueueBurden>, name: string) =>
  breakdown.components.find((entry) => entry.component === name)!;

describe("queue burden breakdown", () => {
  it("reports all-zero burden with no active levers and a complete component set", () => {
    const breakdown = explainQueueBurden(makeHealth({}));
    expect(breakdown.totalPenalty).toBe(0);
    expect(breakdown.totalCredit).toBe(0);
    expect(breakdown.rawBurden).toBe(0);
    expect(breakdown.clamped).toBe(false);
    // Six penalty signals plus the reviewable credit.
    expect(breakdown.components).toHaveLength(7);
    for (const entry of breakdown.components.filter((c) => c.component !== "likelyReviewablePullRequests")) {
      expect(entry.band).toBe("none");
      expect(entry.sharePercent).toBe(0);
      expect(entry.leverageScore).toBe(0);
    }
    const credit = componentByName(breakdown, "likelyReviewablePullRequests");
    expect(credit.band).toBe("credit");
    expect(credit.leverageScore).toBe(0);
    // No active penalty → an honest no-op lever, never an arbitrary alphabetically-first component.
    expect(breakdown.highestLeverageLever.component).toBe("none");
    expect(breakdown.highestLeverageLever.reason).toMatch(/no active penalty/i);
    expect(breakdown.summary).toMatch(/no active contributors/i);
  });

  it("breaks an equal-share tie toward the heavier-weighted contributor, not alphabetical order", () => {
    // unlinked (weight 8) and stale (weight 6) both reach a 24-point contribution → equal share; the heavier
    // per-unit weight (unlinked) is the better lever even though "stalePullRequests" sorts later alphabetically.
    const breakdown = explainQueueBurden(makeHealth({ unlinkedPullRequests: 3, stalePullRequests: 4, burdenScore: 48 }));
    expect(componentByName(breakdown, "unlinkedPullRequests").sharePercent).toBe(50);
    expect(componentByName(breakdown, "stalePullRequests").sharePercent).toBe(50);
    expect(breakdown.highestLeverageLever.component).toBe("unlinkedPullRequests");
  });

  it("names a real penalty lever even when the reviewable credit is offsetting burden", () => {
    // Realistic: 3 open PRs (18 penalty), 3 reviewable (-6 credit) → still an open-PR lever to pull.
    const breakdown = explainQueueBurden(makeHealth({ openPullRequests: 3, likelyReviewablePullRequests: 3 }));
    expect(breakdown.highestLeverageLever.component).toBe("openPullRequests");
    expect(breakdown.highestLeverageLever.component).not.toBe("none");
  });

  it("flags the dominant contributor as high band and the top lever", () => {
    // collisionClusters carries weight 10 → 50 of a 64 total penalty (≈78% share, high band).
    const breakdown = explainQueueBurden(
      makeHealth({ collisionClusters: 5, unlinkedPullRequests: 1, openPullRequests: 1, burdenScore: 64, level: "high" }),
    );
    const collisions = componentByName(breakdown, "collisionClusters");
    expect(collisions.contribution).toBe(50);
    expect(collisions.sharePercent).toBe(78);
    expect(collisions.band).toBe("high");
    expect(breakdown.totalPenalty).toBe(64);
    expect(breakdown.rawBurden).toBe(64);
    expect(breakdown.clamped).toBe(false);
    expect(breakdown.highestLeverageLever.component).toBe("collisionClusters");
    expect(breakdown.highestLeverageLever.reason).toMatch(/dominant/i);
    // unlinked at 8/64 ≈ 13% is below the moderate threshold → low band.
    expect(componentByName(breakdown, "unlinkedPullRequests").band).toBe("low");
  });

  it("classifies a moderate top contributor and names the largest-remaining lever", () => {
    // Three equal 12-point contributors → 36 total, 33% each (moderate); name tie-break picks openPullRequests.
    const breakdown = explainQueueBurden(
      makeHealth({ openPullRequests: 2, stalePullRequests: 2, over30Days: 3, burdenScore: 36, level: "medium" }),
    );
    const openPr = componentByName(breakdown, "openPullRequests");
    expect(openPr.sharePercent).toBe(33);
    expect(openPr.band).toBe("moderate");
    expect(breakdown.highestLeverageLever.component).toBe("openPullRequests");
    expect(breakdown.highestLeverageLever.reason).toMatch(/largest remaining/i);
  });

  it("marks the breakdown clamped when raw penalties exceed 100", () => {
    const breakdown = explainQueueBurden(makeHealth({ collisionClusters: 11, burdenScore: 100, level: "critical" }));
    expect(breakdown.rawBurden).toBe(110);
    expect(breakdown.clamped).toBe(true);
    expect(breakdown.burdenScore).toBe(100);
  });

  it("applies the reviewable credit as an offset without ever driving burden negative", () => {
    // Realistic: reviewable PRs cannot exceed open PRs. 4 open (24 penalty) with 4 reviewable (-8 credit).
    const breakdown = explainQueueBurden(makeHealth({ openPullRequests: 4, likelyReviewablePullRequests: 4 }));
    expect(breakdown.totalPenalty).toBe(24);
    expect(breakdown.totalCredit).toBe(8);
    expect(breakdown.rawBurden).toBe(16);
    expect(breakdown.clamped).toBe(false);
    const credit = componentByName(breakdown, "likelyReviewablePullRequests");
    expect(credit.contribution).toBe(-8);
    expect(credit.band).toBe("credit");
    expect(credit.leverageScore).toBe(0);
    expect(credit.summary).toMatch(/readily reviewable/i);
  });

  it("passes through repo identity, level, and generatedAt", () => {
    const breakdown = explainQueueBurden(
      makeHealth({ repoFullName: "acme/widgets", generatedAt: "2026-01-02T03:04:05.000Z", level: "high", burdenScore: 60, collisionClusters: 6 }),
    );
    expect(breakdown.repoFullName).toBe("acme/widgets");
    expect(breakdown.generatedAt).toBe("2026-01-02T03:04:05.000Z");
    expect(breakdown.level).toBe("high");
    expect(breakdown.summary).toMatch(/queue burden is high/i);
  });

  it("never leaks private or reward terminology in any rendered string", () => {
    const breakdown = explainQueueBurden(
      makeHealth({ openPullRequests: 4, openIssues: 3, unlinkedPullRequests: 2, stalePullRequests: 2, over30Days: 1, collisionClusters: 2, likelyReviewablePullRequests: 1 }),
    );
    for (const entry of breakdown.components) {
      expect(entry.summary).not.toMatch(FORBIDDEN);
      expect(entry.lever).not.toMatch(FORBIDDEN);
    }
    expect(breakdown.highestLeverageLever.reason).not.toMatch(FORBIDDEN);
    expect(breakdown.summary).not.toMatch(FORBIDDEN);
  });

  it("recomposes the exact burdenScore the engine computes (weight drift guard)", () => {
    const repo = { fullName: "owner/repo", isRegistered: true } as unknown as RepositoryRecord;
    const fresh = new Date().toISOString();
    const pullRequests: PullRequestRecord[] = [
      // Linked + fresh → readily reviewable credit, not unlinked, not stale.
      { repoFullName: "owner/repo", number: 1, title: "linked fresh", state: "open", labels: [], linkedIssues: [10], updatedAt: fresh },
      // Unlinked + aged → unlinked + stale + over-30.
      { repoFullName: "owner/repo", number: 2, title: "aged unlinked", state: "open", labels: [], linkedIssues: [], updatedAt: "2020-01-01T00:00:00.000Z" },
      // Unlinked + aged draft → unlinked + stale + over-30.
      { repoFullName: "owner/repo", number: 3, title: "aged draft", state: "open", labels: [], linkedIssues: [], updatedAt: "2020-01-01T00:00:00.000Z", isDraft: true },
    ];
    const issues = [{ repoFullName: "owner/repo", number: 10, title: "open issue", state: "open", labels: [], linkedPrs: [], body: null }];
    const collisions = { repoFullName: "owner/repo", summary: { clusterCount: 2, highRiskCount: 0 } } as unknown as CollisionReport;

    const health = buildQueueHealth(repo, issues, pullRequests, collisions);
    const breakdown = explainQueueBurden(health);

    // openPRs 3×6 + openIssues 1×1 + unlinked 2×8 + stale 2×6 + over30 2×4 + clusters 2×10 − reviewable 1×2 = 73.
    expect(health.burdenScore).toBe(73);
    expect(breakdown.rawBurden).toBe(73);
    expect(clamp(breakdown.rawBurden)).toBe(health.burdenScore);
    expect(componentByName(breakdown, "unlinkedPullRequests").count).toBe(2);
    expect(componentByName(breakdown, "likelyReviewablePullRequests").count).toBe(1);
  });
});
