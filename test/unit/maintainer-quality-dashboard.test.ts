import { describe, expect, it } from "vitest";
import { buildMaintainerQualityDashboard, isMaintainerQualityDataStale, type MaintainerQualityRepoInput } from "../../src/services/maintainer-quality-dashboard";
import type { IssueRecord, PullRequestRecord, RepositoryRecord } from "../../src/types";

const FORBIDDEN_PUBLIC_TERMS = /wallet|hotkey|coldkey|mnemonic|reward|payout|farming|raw trust|trust score|scoreability|credibility|private ranking/i;

function repo(fullName: string): RepositoryRecord {
  return {
    fullName,
    owner: fullName.split("/")[0]!,
    name: fullName.split("/")[1]!,
    isInstalled: true,
    isRegistered: true,
    isPrivate: false,
    registryConfig: { repo: fullName, emissionShare: 0.02, issueDiscoveryShare: 0, labelMultipliers: {}, maintainerCut: 0, raw: {} },
  };
}

function pr(number: number, over: Partial<PullRequestRecord> = {}): PullRequestRecord {
  return {
    repoFullName: "octo/demo",
    number,
    title: `PR ${number}`,
    state: "open",
    authorLogin: "alice",
    authorAssociation: "NONE",
    headSha: `sha${number}`,
    labels: [],
    linkedIssues: [number + 100],
    ...over,
  };
}

function issue(number: number): IssueRecord {
  return { repoFullName: "octo/demo", number, title: `Issue ${number}`, state: "open", authorLogin: "maintainer", authorAssociation: "OWNER", labels: [], linkedPrs: [] };
}

// Default: PRs pr(1)/pr(2) link issues #101/#102, which exist here — so they are genuinely "clean".
function input(over: Partial<MaintainerQualityRepoInput> = {}): MaintainerQualityRepoInput {
  return { repo: repo("octo/demo"), issues: [issue(101), issue(102)], pullRequests: [pr(1), pr(2)], ...over };
}

describe("buildMaintainerQualityDashboard", () => {
  it("shapes per-repo queue bands, duplicate trends, and aggregate quality signals (no raw private scores)", () => {
    const dashboard = buildMaintainerQualityDashboard({ repos: [input()], generatedAt: "2026-06-14T00:00:00.000Z" });
    expect(dashboard.generatedAt).toBe("2026-06-14T00:00:00.000Z");
    expect(dashboard.stale).toBe(false);
    expect(dashboard.repoQuality).toHaveLength(1);
    expect(dashboard.repoQuality[0]).toMatchObject({ repoFullName: "octo/demo", openPrCount: 2 });
    expect(["low", "medium", "high", "critical"]).toContain(dashboard.repoQuality[0]!.queueBand);
    expect(dashboard.qualitySignals).toMatchObject({ openPrs: 2, missingLinkedIssue: 0 });
    // #2201: the aggregate queue-health folds the per-repo QueueHealth signals — open PRs match qualitySignals,
    // and every burden band + age bucket is represented as an observable count.
    expect(dashboard.queueHealth.openPullRequests).toBe(2);
    expect(dashboard.queueHealth.bandCounts).toMatchObject({
      low: expect.any(Number),
      medium: expect.any(Number),
      high: expect.any(Number),
      critical: expect.any(Number),
    });
    expect(dashboard.queueHealth.ageBuckets).toMatchObject({
      under7Days: expect.any(Number),
      days7To30: expect.any(Number),
      over30Days: expect.any(Number),
    });
    expect(JSON.stringify(dashboard)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
    // The per-repo queue burden score is private — only the band is exposed.
    expect(JSON.stringify(dashboard)).not.toMatch(/"burdenScore"/);
  });

  it("aggregates the slop + duplicate signal and its rates, failing safe to null rates with no open PRs (#2202)", () => {
    const flagged = buildMaintainerQualityDashboard({
      repos: [input({ pullRequests: [pr(1), pr(2, { slopBand: "high" })] })],
      generatedAt: "2026-06-14T00:00:00.000Z",
    });
    expect(flagged.slopDuplicate.openPullRequests).toBe(2);
    expect(flagged.slopDuplicate.slopFlaggedPullRequests).toBe(1);
    expect(flagged.slopDuplicate.slopRate).toBeCloseTo(0.5);
    expect(flagged.slopDuplicate.duplicateRate).not.toBeNull();

    // No open PRs → the rates divide-guard to null rather than 0/0.
    const empty = buildMaintainerQualityDashboard({
      repos: [input({ pullRequests: [] })],
      generatedAt: "2026-06-14T00:00:00.000Z",
    });
    expect(empty.slopDuplicate.openPullRequests).toBe(0);
    expect(empty.slopDuplicate.slopRate).toBeNull();
    expect(empty.slopDuplicate.duplicateRate).toBeNull();
  });

  it("counts PRs without a linked issue toward the missing-linked-issue signal", () => {
    const dashboard = buildMaintainerQualityDashboard({
      repos: [input({ pullRequests: [pr(1, { linkedIssues: [] }), pr(2, { linkedIssues: [5] })] })],
      generatedAt: "2026-06-14T00:00:00.000Z",
    });
    expect(dashboard.qualitySignals.missingLinkedIssue).toBe(1);
  });

  it("ranks top contributors by open PR count and assigns a quality band (never a raw number)", () => {
    const dashboard = buildMaintainerQualityDashboard({
      repos: [
        input({
          pullRequests: [
            pr(1, { authorLogin: "alice", linkedIssues: [101] }),
            pr(2, { authorLogin: "alice", linkedIssues: [102] }),
            pr(3, { authorLogin: "bob", linkedIssues: [] }),
          ],
        }),
      ],
      generatedAt: "2026-06-14T00:00:00.000Z",
    });
    expect(dashboard.topContributors[0]).toMatchObject({ login: "alice", openPrCount: 2, band: "strong" });
    expect(dashboard.topContributors.find((entry) => entry.login === "bob")).toMatchObject({ band: "early", openPrCount: 1 });
    // Bands only — no raw clean-ratio/credibility number leaks.
    expect(dashboard.topContributors.every((entry) => ["strong", "developing", "early"].includes(entry.band))).toBe(true);
    expect(JSON.stringify(dashboard.topContributors)).not.toMatch(/"cleanRatio"|"score"/);
  });

  it("ignores closed PRs and handles an empty/missing-author repo deterministically", () => {
    const dashboard = buildMaintainerQualityDashboard({
      repos: [
        input({ pullRequests: [pr(1, { state: "closed" }), pr(2, { authorLogin: null, linkedIssues: [] })] }),
        { repo: repo("octo/empty"), issues: [], pullRequests: [] },
      ],
      generatedAt: "2026-06-14T00:00:00.000Z",
    });
    expect(dashboard.qualitySignals.openPrs).toBe(1);
    expect(dashboard.topContributors).toEqual([{ login: "unknown", band: "early", openPrCount: 1 }]);
    expect(dashboard.repoQuality.map((entry) => entry.repoFullName)).toEqual(["octo/demo", "octo/empty"]);
    expect(dashboard.summary).toContain("Shaped 2 of 2 scoped repo(s)");
    expect(dashboard.truncated).toBe(false);
  });

  it("does not let a fake/nonexistent issue link inflate a contributor to 'strong' (gameability guard)", () => {
    // Two PRs, both linking a NONEXISTENT issue (#999999) — not real, so neither counts as clean.
    const gamed = buildMaintainerQualityDashboard({
      repos: [input({ issues: [issue(101)], pullRequests: [pr(1, { authorLogin: "mallory", linkedIssues: [999999] }), pr(2, { authorLogin: "mallory", linkedIssues: [999999] })] })],
      generatedAt: "2026-06-14T00:00:00.000Z",
    });
    expect(gamed.topContributors[0]).toMatchObject({ login: "mallory", band: "early", openPrCount: 2 });

    // A single genuinely-clean PR is "developing", never "strong" (min-volume guard).
    const single = buildMaintainerQualityDashboard({
      repos: [input({ issues: [issue(101)], pullRequests: [pr(1, { authorLogin: "carol", linkedIssues: [101] })] })],
      generatedAt: "2026-06-14T00:00:00.000Z",
    });
    expect(single.topContributors[0]).toMatchObject({ login: "carol", band: "developing", openPrCount: 1 });
  });

  it("counts genuine duplicate PRs (2+ on the same issue) as high-risk and not clean", () => {
    // Two PRs both linking issue #101 → a real duplicate cluster (2 pull requests) → both high-risk.
    const dashboard = buildMaintainerQualityDashboard({
      repos: [input({ issues: [issue(101)], pullRequests: [pr(1, { authorLogin: "dave", linkedIssues: [101] }), pr(2, { authorLogin: "dave", linkedIssues: [101] })] })],
      generatedAt: "2026-06-14T00:00:00.000Z",
    });
    expect(dashboard.qualitySignals.duplicatePrRisk).toBe(2);
    expect(dashboard.repoQuality[0]!.highRiskDuplicates).toBeGreaterThan(0);
    // Both PRs are in a high-risk duplicate cluster → neither counts clean → not "strong".
    expect(dashboard.topContributors[0]).toMatchObject({ login: "dave", band: "early", openPrCount: 2 });
  });

  it("discloses truncation when there are more scoped repos than were shaped", () => {
    const dashboard = buildMaintainerQualityDashboard({ repos: [input()], generatedAt: "2026-06-14T00:00:00.000Z", repoTotal: 50 });
    expect(dashboard).toMatchObject({ repoTotal: 50, shapedRepoCount: 1, truncated: true });
    expect(dashboard.summary).toContain("Shaped 1 of 50 scoped repo(s)");
    // repoTotal can never be reported below the number actually shaped.
    expect(buildMaintainerQualityDashboard({ repos: [input(), input()], generatedAt: "x", repoTotal: 1 }).repoTotal).toBe(2);
  });

  it("honors the stale flag and an empty repo set", () => {
    expect(buildMaintainerQualityDashboard({ repos: [], generatedAt: "2026-06-14T00:00:00.000Z", stale: true }).stale).toBe(true);
    const empty = buildMaintainerQualityDashboard({ repos: [], generatedAt: "2026-06-14T00:00:00.000Z" });
    expect(empty.repoQuality).toEqual([]);
    expect(empty.topContributors).toEqual([]);
    expect(empty.qualitySignals).toEqual({ openPrs: 0, duplicatePrRisk: 0, missingLinkedIssue: 0 });
  });
});

describe("isMaintainerQualityDataStale", () => {
  const now = Date.parse("2026-06-14T12:00:00.000Z");

  it("is not stale when there are no scoped repos", () => {
    expect(isMaintainerQualityDataStale({ lastCompletedAts: [], repoCount: 0, nowMs: now })).toBe(false);
  });

  it("is stale when no completed sync exists for the scoped repos", () => {
    expect(isMaintainerQualityDataStale({ lastCompletedAts: [null, undefined, "not-a-date"], repoCount: 2, nowMs: now })).toBe(true);
  });

  it("uses the most recent sync and respects the freshness window", () => {
    // Newest sync 1h ago → fresh; an additional older entry must not flip it stale.
    expect(isMaintainerQualityDataStale({ lastCompletedAts: ["2026-06-10T00:00:00.000Z", "2026-06-14T11:00:00.000Z"], repoCount: 1, nowMs: now })).toBe(false);
    // Newest sync 8h ago → stale.
    expect(isMaintainerQualityDataStale({ lastCompletedAts: ["2026-06-14T04:00:00.000Z"], repoCount: 1, nowMs: now })).toBe(true);
    // Custom window.
    expect(isMaintainerQualityDataStale({ lastCompletedAts: ["2026-06-14T11:00:00.000Z"], repoCount: 1, nowMs: now, maxAgeMs: 30 * 60 * 1000 })).toBe(true);
  });
});
