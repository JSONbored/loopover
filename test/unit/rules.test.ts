import { describe, expect, it } from "vitest";
import {
  buildIssueAdvisory,
  buildPullRequestAdvisory,
  buildRepositoryAdvisory,
  evaluateGateCheck,
  formatCheckRunOutput,
  formatGateCheckOutput,
} from "../../src/rules/advisory";
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

  it("keeps weak queue warnings advisory-only for the opt-in gate", () => {
    const pr: PullRequestRecord = {
      repoFullName: repo.fullName,
      number: 12,
      title: "Add registry sync",
      state: "open",
      authorLogin: "contributor",
      authorAssociation: "NONE",
      headSha: "abc123",
      labels: [],
      linkedIssues: [4],
    };
    const otherOpenPullRequests = Array.from({ length: 10 }, (_, index): PullRequestRecord => ({
      ...pr,
      number: 100 + index,
      linkedIssues: [20 + index],
    }));

    const advisory = buildPullRequestAdvisory(repo, pr, { otherOpenPullRequests });
    const gate = evaluateGateCheck(advisory);
    const output = formatGateCheckOutput(gate);

    expect(advisory.findings.map((finding) => finding.code)).toContain("busy_pr_queue");
    expect(gate.conclusion).toBe("success");
    expect(gate.blockers).toEqual([]);
    expect(gate.warnings.map((finding) => finding.code)).not.toContain("busy_pr_queue");
    expect(output.title).toBe("Gittensory Gate passed");
    expect(output.text).toContain("No configured merge-blocking issue");
  });

  it("maps broken evaluation state to action_required gate output", () => {
    const advisory = buildPullRequestAdvisory(null, null);
    const gate = evaluateGateCheck(advisory);
    const output = formatGateCheckOutput(gate);

    expect(gate.conclusion).toBe("action_required");
    expect(gate.blockers.map((finding) => finding.code)).toEqual(["repo_not_registered", "pr_not_cached"]);
    expect(output.title).toBe("Gittensory Gate is blocking merge");
    expect(output.text).toContain("Repository registration is unknown");
    expect(output.text).toContain("Action: Refresh the Gittensor registry snapshot.");
  });

  it("formats and sanitizes gate blockers without leaking private scoring terms", () => {
    const advisory = buildPullRequestAdvisory(repo, null);
    const gate = evaluateGateCheck({
      ...advisory,
      findings: [
        {
          code: "missing_linked_issue",
          title: "No linked issue near reward wallet trust score",
          severity: "warning" as const,
          detail: "Private score estimate detail.",
        },
      ],
    });
    const output = formatGateCheckOutput(gate);

    expect(gate.conclusion).toBe("failure");
    expect(output.text).toContain("No linked issue near");
    expect(output.text).not.toMatch(/reward|wallet|trust score|score estimate/i);
  });

  it("keeps defensive gate output fallback public-safe", () => {
    const output = formatGateCheckOutput({
      enabled: true,
      conclusion: "failure",
      title: "Gittensory Gate is blocking merge",
      summary: "A configured merge-blocking issue was found.",
      blockers: [],
      warnings: [],
    });

    expect(output.text).toBe("A configured merge-blocking issue was found.");
    expect(output.text).not.toMatch(/reward|wallet|hotkey|trust score|payout|farming/i);
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

  it("formatCheckRunOutput respects detailLevel — minimal always omits findings text", () => {
    const pr: PullRequestRecord = {
      repoFullName: repo.fullName,
      number: 50,
      title: "PR with findings",
      state: "open",
      authorLogin: "contributor",
      authorAssociation: "NONE",
      labels: [],
      linkedIssues: [],
    };
    const advisory = buildPullRequestAdvisory(repo, pr, { requireLinkedIssue: true, otherOpenPullRequests: [] });
    expect(advisory.findings.length).toBeGreaterThan(0);

    const minimal = formatCheckRunOutput(advisory, "minimal");
    expect(minimal.text).toContain("No detailed findings are published");

    const standard = formatCheckRunOutput(advisory, "standard");
    expect(standard.text).not.toContain("No detailed findings are published");
    expect(standard.text).toMatch(/⚠️|ℹ️/);

    const deep = formatCheckRunOutput(advisory, "deep");
    expect(deep.text).not.toContain("No detailed findings are published");
    expect(deep.text).toMatch(/⚠️|ℹ️/);
  });

  it("formatCheckRunOutput sanitizes forbidden terms at every detail level", () => {
    const poisonedAdvisory = buildPullRequestAdvisory(repo, null);
    const poisoned = {
      ...poisonedAdvisory,
      findings: [
        {
          code: "test_finding",
          title: "reward wallet hotkey trust score reviewability",
          severity: "warning" as const,
          detail: "private detail",
          publicText: "rewards and farming content near wallets hotkeys with trust score and score estimate",
          action: "Check your scoreability and reviewability",
        },
      ],
    };
    for (const level of ["minimal", "standard", "deep"] as const) {
      const out = formatCheckRunOutput(poisoned, level);
      expect(out.title).not.toMatch(/rewards?|wallets?|hotkeys?|trust score|score estimate|reviewability|scoreability|farming/i);
      expect(out.summary).not.toMatch(/rewards?|wallets?|hotkeys?|trust score|score estimate|reviewability|scoreability|farming/i);
      expect(out.text).not.toMatch(/rewards?|wallets?|hotkeys?|trust score|score estimate|reviewability|scoreability|farming/i);
    }
  });

  it("formatCheckRunOutput publishes only explicit public finding text", () => {
    const advisory = buildPullRequestAdvisory(repo, null);
    const output = formatCheckRunOutput(
      {
        ...advisory,
        findings: [
          {
            code: "private_title",
            title: "Maintainer allocation is configured",
            severity: "info" as const,
            detail: "Private allocation detail",
            action: "Deep action exposes trust score and rewards estimate.",
          },
          {
            code: "public_text",
            title: "Private score estimate title",
            severity: "warning" as const,
            detail: "Private detail",
            publicText: "Safe public repo context with trust score and rewards variants removed.",
            action: "Do not publish this trust score action.",
          },
        ],
      },
      "deep",
    );

    expect(output.text).toContain("Safe public repo context");
    expect(output.text).not.toContain("Maintainer allocation is configured");
    expect(output.text).not.toContain("Private score estimate title");
    expect(output.text).not.toContain("Deep action exposes");
    expect(output.text).not.toContain("Do not publish this");
    expect(output.text).not.toMatch(/trust score|rewards|score estimate/i);
  });

  it("classifies critical-severity findings as action_required", () => {
    const advisory = buildPullRequestAdvisory(null, null);
    const withCritical = {
      ...advisory,
      findings: [{ code: "critical_test", title: "Critical finding", severity: "critical" as const, detail: "Something broke." }],
    };
    const output = formatCheckRunOutput(withCritical, "standard");
    expect(output.title).toBe("Gittensory context posted");
    expect(output.text).toContain("No detailed findings are published");
    expect(output.text).not.toContain("Critical finding");
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
