import { describe, expect, it } from "vitest";
import { buildIssueAdvisory, buildPullRequestAdvisory, buildRepositoryAdvisory, formatCheckRunOutput } from "../../src/rules/advisory";
import type { IssueRecord, PullRequestRecord, RepositoryRecord } from "../../src/types";

const repo: RepositoryRecord = {
  fullName: "JSONbored/gittensory",
  owner: "JSONbored",
  name: "gittensory",
  isInstalled: true,
  isRegistered: true,
  isPrivate: true,
  registryConfig: {
    repo: "JSONbored/gittensory",
    emissionShare: 0.02,
    issueDiscoveryShare: 0,
    labelMultipliers: { feature: 1.5 },
    maintainerCut: 0,
    raw: {},
  },
};

describe("advisory rules", () => {
  it("suppresses missing linked issues on direct-contribution PR advisories by default", () => {
    const pr: PullRequestRecord = {
      repoFullName: repo.fullName,
      number: 12,
      title: "Add registry sync",
      state: "open",
      authorLogin: "oktofeesh1",
      authorAssociation: "NONE",
      headSha: "abc123",
      labels: ["feature"],
      linkedIssues: [],
    };

    const advisory = buildPullRequestAdvisory(repo, pr);

    expect(advisory.conclusion).toBe("success");
    expect(advisory.findings.map((finding) => finding.code)).not.toContain("missing_linked_issue");
    expect(formatCheckRunOutput(advisory).text).not.toMatch(/reward|farming/i);
  });

  it("flags missing linked issues only when a repo explicitly requires linkage", () => {
    const pr: PullRequestRecord = {
      repoFullName: repo.fullName,
      number: 12,
      title: "Add registry sync",
      state: "open",
      authorLogin: "oktofeesh1",
      authorAssociation: "NONE",
      headSha: "abc123",
      labels: ["feature"],
      linkedIssues: [],
    };

    const advisory = buildPullRequestAdvisory(repo, pr, { requireLinkedIssue: true });

    expect(advisory.conclusion).toBe("neutral");
    expect(advisory.findings.map((finding) => finding.code)).toContain("missing_linked_issue");
  });

  it("marks unknown repositories as action required", () => {
    const advisory = buildRepositoryAdvisory(null, "owner/repo");
    expect(advisory.conclusion).toBe("action_required");
  });

  it("handles uncached PR and issue advisories for unknown repositories", () => {
    expect(buildPullRequestAdvisory(null, null).findings.map((finding) => finding.code)).toEqual(["repo_not_registered", "pr_not_cached"]);
    expect(buildIssueAdvisory(null, null).findings.map((finding) => finding.code)).toEqual(["repo_not_registered", "issue_not_cached"]);
  });

  it("warns when an issue already has linked PRs", () => {
    const issue: IssueRecord = {
      repoFullName: repo.fullName,
      number: 4,
      title: "Improve check runs",
      state: "open",
      authorLogin: "maintainer",
      authorAssociation: "OWNER",
      labels: [],
      linkedPrs: [10],
    };

    const advisory = buildIssueAdvisory(repo, issue);
    expect(advisory.findings.map((finding) => finding.code)).toContain("issue_has_linked_prs");
  });

  it("flags duplicate risk when another open PR references the same linked issue", () => {
    const pr: PullRequestRecord = {
      repoFullName: repo.fullName,
      number: 12,
      title: "Add registry sync",
      state: "open",
      authorLogin: "oktofeesh1",
      authorAssociation: "NONE",
      headSha: "abc123",
      labels: [],
      linkedIssues: [4],
    };
    const otherPr: PullRequestRecord = {
      ...pr,
      number: 13,
      title: "Alternative registry sync",
      linkedIssues: [4],
    };

    const advisory = buildPullRequestAdvisory(repo, pr, { otherOpenPullRequests: [otherPr] });

    expect(advisory.findings.map((finding) => finding.code)).toContain("duplicate_pr_risk");
  });

  it("keeps private reviewability context out of check output", () => {
    const pr: PullRequestRecord = {
      repoFullName: repo.fullName,
      number: 12,
      title: "Add registry sync",
      state: "open",
      authorLogin: "oktofeesh1",
      authorAssociation: "NONE",
      headSha: "abc123",
      labels: [],
      linkedIssues: [4],
    };

    const advisory = buildPullRequestAdvisory(repo, pr);
    const output = formatCheckRunOutput(advisory);

    expect(advisory.findings.map((finding) => finding.code)).not.toContain("private_reviewability_context");
    expect(output.text).not.toMatch(/reviewability|likely_duplicate|needs_author|reward|farming|wallet|hotkey/i);
    expect(output.title).toBe("Gittensory context checked");
  });

  it("covers repository config lane advisories", () => {
    const issueDiscoveryRepo: RepositoryRecord = {
      ...repo,
      registryConfig: {
        ...repo.registryConfig!,
        issueDiscoveryShare: 1,
        maintainerCut: 0.2,
      },
    };
    const missingConfigRepo: RepositoryRecord = { ...repo, registryConfig: null };
    const unregisteredRepo: RepositoryRecord = { ...repo, isRegistered: false };

    expect(buildRepositoryAdvisory(issueDiscoveryRepo, repo.fullName).findings.map((finding) => finding.code)).toEqual([
      "direct_pr_pool_disabled",
      "maintainer_cut_enabled",
    ]);
    expect(buildRepositoryAdvisory(missingConfigRepo, repo.fullName).findings.map((finding) => finding.code)).toContain("repo_config_missing");
    expect(buildRepositoryAdvisory(unregisteredRepo, repo.fullName).conclusion).toBe("action_required");
  });

  it("classifies closed and maintainer-authored PR metadata", () => {
    const pr: PullRequestRecord = {
      repoFullName: repo.fullName,
      number: 15,
      title: "Tidy registry sync",
      state: "closed",
      authorLogin: "maintainer",
      authorAssociation: "OWNER",
      labels: ["feature"],
      linkedIssues: [9],
    };
    const otherOpenPullRequests = Array.from({ length: 10 }, (_, index): PullRequestRecord => ({
      ...pr,
      number: 100 + index,
      state: "open",
      authorAssociation: "NONE",
      linkedIssues: [20 + index],
    }));

    const advisory = buildPullRequestAdvisory(repo, pr, { otherOpenPullRequests });
    const codes = advisory.findings.map((finding) => finding.code);

    expect(codes).toEqual(expect.arrayContaining(["pr_not_open", "busy_pr_queue", "label_context_found", "maintainer_authored_pr"]));
  });

  it("handles uncached PRs and closed issues", () => {
    const closedIssue: IssueRecord = {
      repoFullName: repo.fullName,
      number: 22,
      title: "Closed issue",
      state: "closed",
      authorLogin: "reporter",
      labels: [],
      linkedPrs: [],
    };
    const uncachedPr = buildPullRequestAdvisory(repo, null);
    const issueAdvisory = buildIssueAdvisory(repo, closedIssue);

    expect(uncachedPr.findings.map((finding) => finding.code)).toContain("pr_not_cached");
    expect(issueAdvisory.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(["issue_not_open", "issue_discovery_not_configured"]));
    expect(formatCheckRunOutput({ ...uncachedPr, findings: [] }).text).toContain("No detailed findings are published");
  });

  it("separates issue-discovery-only issues from clean split-lane issue advisories", () => {
    const issue: IssueRecord = {
      repoFullName: repo.fullName,
      number: 33,
      title: "Actionable issue",
      state: "open",
      authorLogin: "reporter",
      labels: [],
      linkedPrs: [],
    };
    const issueDiscoveryRepo: RepositoryRecord = {
      ...repo,
      registryConfig: { ...repo.registryConfig!, issueDiscoveryShare: 1 },
    };
    const splitRepo: RepositoryRecord = {
      ...repo,
      registryConfig: { ...repo.registryConfig!, issueDiscoveryShare: 0.5 },
    };

    const issueOnly = buildIssueAdvisory(issueDiscoveryRepo, issue);
    const cleanSplit = buildIssueAdvisory(splitRepo, issue);

    expect(issueOnly.findings.map((finding) => finding.code)).toContain("direct_pr_pool_disabled");
    expect(issueOnly.findings.map((finding) => finding.code)).not.toContain("issue_discovery_not_configured");
    expect(cleanSplit.findings).toEqual([]);
    expect(cleanSplit.summary).toBe("Issue advisory generated.");
    expect(cleanSplit.conclusion).toBe("success");
  });
});
