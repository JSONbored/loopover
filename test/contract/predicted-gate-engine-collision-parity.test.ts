import { describe, expect, it } from "vitest";

import {
  buildCollisionReport,
  buildPreflightResult,
  buildPublicReadinessScore,
  buildQueueHealth,
  itemSharesPlannedLinkedIssue,
} from "../../packages/loopover-engine/src/signals/predicted-gate-engine";
import type { CollisionItem, IssueRecord, PullRequestRecord, RegistryRepoConfig, RepositoryRecord } from "../../packages/loopover-engine/src/types/predicted-gate-types";

describe("predicted-gate engine collision parity (#2283)", () => {
  it("flags possible duplicate work when the planned title overlaps an existing cluster", () => {
    const directRepo = repo("owner/direct");
    const issues = [issue(directRepo.fullName, 41, "Login redirect loop on OAuth callback fails")];
    const pullRequests = [pr(directRepo.fullName, 42, "Fix login redirect loop OAuth callback", { authorLogin: "dev", linkedIssues: [] })];

    const preflight = buildPreflightResult(
      {
        repoFullName: directRepo.fullName,
        title: "Resolve the login redirect loop happening at the OAuth callback",
        body: "",
        changedFiles: ["src/auth.ts"],
        linkedIssues: [],
      },
      directRepo,
      issues,
      pullRequests,
    );

    expect(preflight.findings.map((finding) => finding.code)).toContain("possible_duplicate_work");
  });

  it("matches duplicate work by a shared linked issue, not a coincident PR number", () => {
    const directRepo = repo("owner/direct");
    const sharedIssue = issue(directRepo.fullName, 7, "Token refresh race in the auth middleware");
    const linkingPr = pr(directRepo.fullName, 50, "Guard the token refresh race", { linkedIssues: [7] });

    const coincidentNumber = buildPreflightResult(
      { repoFullName: directRepo.fullName, title: "Add pagination to the labels export endpoint", body: "Fixes #50", changedFiles: ["src/api/labels.ts"], linkedIssues: [50] },
      directRepo,
      [sharedIssue],
      [linkingPr],
    );
    expect(coincidentNumber.findings.map((finding) => finding.code)).not.toContain("possible_duplicate_work");

    const sharedLinkedIssue = buildPreflightResult(
      { repoFullName: directRepo.fullName, title: "Add pagination to the labels export endpoint", body: "Fixes #7", changedFiles: ["src/api/labels.ts"], linkedIssues: [7] },
      directRepo,
      [sharedIssue],
      [linkingPr],
    );
    expect(sharedLinkedIssue.findings.map((finding) => finding.code)).toContain("possible_duplicate_work");
  });

  it("itemSharesPlannedLinkedIssue intersects linked-issue sets and tolerates missing linkedIssues", () => {
    const prItemValue: CollisionItem = { type: "pull_request", number: 42, title: "Unrelated PR", linkedIssues: [9] };
    expect(itemSharesPlannedLinkedIssue(prItemValue, [9])).toBe(true);
    expect(itemSharesPlannedLinkedIssue(prItemValue, [42])).toBe(false);
    expect(itemSharesPlannedLinkedIssue({ type: "pull_request", number: 9, title: "No links" }, [9])).toBe(false);
  });

  it("does not treat global repo collision clusters as planned-work overlap", () => {
    const directRepo = repo("owner/noisy");
    const unrelatedIssues = Array.from({ length: 12 }, (_, index) => issue(directRepo.fullName, index + 1, `Unrelated cache issue ${index + 1}`));
    const unrelatedPullRequests = unrelatedIssues.map((record, index) =>
      pr(directRepo.fullName, index + 10, `Unrelated cache fix ${index + 1}`, { linkedIssues: [record.number], body: `Fixes #${record.number}` }),
    );
    const currentPr = pr(directRepo.fullName, 99, "Isolated docs cleanup", { authorLogin: "dev", linkedIssues: [999], body: "Fixes #999" });
    const collisions = buildCollisionReport(directRepo.fullName, unrelatedIssues, [...unrelatedPullRequests, currentPr]);
    const preflight = buildPreflightResult(
      { repoFullName: directRepo.fullName, title: currentPr.title, body: currentPr.body ?? undefined, linkedIssues: currentPr.linkedIssues },
      directRepo,
      unrelatedIssues,
      [...unrelatedPullRequests, currentPr],
    );

    expect(collisions.summary.clusterCount).toBeGreaterThan(0);
    expect(preflight.collisions).toHaveLength(0);
  });

  it("drops self-authored path-only overlap between open PRs", () => {
    const directRepo = repo("owner/direct");
    const collisions = buildCollisionReport(directRepo.fullName, [], [
      { ...pr(directRepo.fullName, 1, "foo bar", { authorLogin: "alice", linkedIssues: [] }), changedFiles: ["src/services/upload/retry.ts"] },
      { ...pr(directRepo.fullName, 2, "baz qux", { authorLogin: "alice", linkedIssues: [] }), changedFiles: ["src/services/upload/retry.ts"] },
    ]);
    expect(collisions.clusters).toHaveLength(0);
  });

  it("REGRESSION (#6629): risk uses freshly-computed linkedPrs only — stale issue.linkedPrs cannot inflate to high", () => {
    const directRepo = repo("owner/parity");
    // Exactly one open PR actually references the issue; the issue's own linkedPrs field is stale/inflated.
    const shared = issue(directRepo.fullName, 7, "Auth token refresh race", { linkedPrs: [50, 51, 52] });
    const onlyLocal = pr(directRepo.fullName, 50, "Guard the token refresh race", { linkedIssues: [7] });
    const collisions = buildCollisionReport(directRepo.fullName, [shared], [onlyLocal]);
    const cluster = collisions.clusters.find((c) => c.id === "issue-7");
    expect(cluster).toBeDefined();
    expect(cluster?.risk).toBe("medium");
  });

  it("buildQueueHealth counts draft PRs and fires inactive_draft_prs finding when stale", () => {
    const directRepo = repo("owner/draft-test");
    const collisions = buildCollisionReport(directRepo.fullName, [], []);
    const staleDate = new Date(Date.now() - 20 * 86_400_000).toISOString();
    const recentDate = new Date().toISOString();

    const staleDraftPr = pr(directRepo.fullName, 10, "Draft: refactor auth", { isDraft: true, updatedAt: staleDate });
    const recentDraftPr = pr(directRepo.fullName, 11, "Draft: add pagination", { isDraft: true, updatedAt: recentDate });
    const nonDraftPr = pr(directRepo.fullName, 12, "Fix login redirect", { isDraft: false });

    const withStaleDraft = buildQueueHealth(directRepo, [], [staleDraftPr, nonDraftPr], collisions);
    expect(withStaleDraft.signals.draftPullRequests).toBe(1);
    expect(withStaleDraft.findings.some((f) => f.code === "inactive_draft_prs")).toBe(true);

    const withRecentDraft = buildQueueHealth(directRepo, [], [recentDraftPr, nonDraftPr], collisions);
    expect(withRecentDraft.findings.some((f) => f.code === "inactive_draft_prs")).toBe(false);
  });

  it("buildPublicReadinessScore reports queue pressure for stale unlinked queues", () => {
    const directRepo = repo("owner/readiness");
    const currentPr = pr(directRepo.fullName, 31, "Maintenance cleanup", { authorLogin: "dev", linkedIssues: [1] });
    const preflight = buildPreflightResult(
      { repoFullName: directRepo.fullName, title: currentPr.title, body: currentPr.body ?? undefined, linkedIssues: currentPr.linkedIssues },
      directRepo,
      [],
      [currentPr],
    );
    const staleQueuePullRequests = [44, 45, 46, 47].map((number) =>
      pr(directRepo.fullName, number, `Stale unlinked queue item ${number}`, { updatedAt: "2020-01-01T00:00:00.000Z" }),
    );
    const criticalBurdenQueue = buildQueueHealth(
      directRepo,
      [],
      staleQueuePullRequests,
      buildCollisionReport(directRepo.fullName, [], staleQueuePullRequests),
    );
    const score = buildPublicReadinessScore({
      pr: currentPr,
      preflight: { ...preflight, status: "ready", reviewBurden: "low", findings: [] },
      queueHealth: criticalBurdenQueue,
    });
    expect(score.components.find((c) => c.key === "queue_pressure")?.evidence).toContain("4 stale");
  });
});

function repo(fullName: string, overrides: Partial<RegistryRepoConfig> = {}): RepositoryRecord {
  const [owner, name] = fullName.split("/") as [string, string];
  return {
    fullName,
    owner,
    name,
    isInstalled: true,
    isRegistered: true,
    isPrivate: false,
    registryConfig: {
      repo: fullName,
      emissionShare: 0.02,
      issueDiscoveryShare: 0,
      labelMultipliers: {},
      maintainerCut: 0,
      raw: {},
      ...overrides,
    },
  };
}

function issue(repoFullName: string, number: number, title: string, overrides: Partial<IssueRecord> = {}): IssueRecord {
  return {
    repoFullName,
    number,
    title,
    state: "open",
    labels: [],
    linkedPrs: [],
    ...overrides,
  };
}

function pr(repoFullName: string, number: number, title: string, overrides: Partial<PullRequestRecord> = {}): PullRequestRecord {
  return {
    repoFullName,
    number,
    title,
    state: "open",
    authorLogin: "dev",
    labels: [],
    linkedIssues: [],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}
