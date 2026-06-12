import { describe, expect, it } from "vitest";
import {
  buildCheckRunAnnotations,
  buildIssueAdvisory,
  buildPullRequestAdvisory,
  buildRepositoryAdvisory,
  CHECK_RUN_ANNOTATION_LIMIT,
  evaluateGateCheck,
  formatCheckRunOutput,
  formatGateCheckOutput,
} from "../../src/rules/advisory";
import type { CollisionReport } from "../../src/signals/engine";
import type { IssueRecord, PullRequestRecord, PullRequestFileRecord, RepositoryRecord } from "../../src/types";

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
    expect(output.text).toContain("No configured hard blocker");
  });

  it("maps broken evaluation state to action_required gate output", () => {
    const advisory = buildPullRequestAdvisory(null, null);
    const gate = evaluateGateCheck(advisory);
    const output = formatGateCheckOutput(gate);

    expect(gate.conclusion).toBe("action_required");
    expect(gate.blockers.map((finding) => finding.code)).toEqual(["repo_not_registered", "pr_not_cached"]);
    expect(output.title).toBe("Gittensory Gate needs app attention");
    expect(output.text).toContain("Repository registration is unknown");
    expect(output.text).toContain("Action: Refresh the Gittensor registry snapshot.");
  });

  it("formats and sanitizes gate blockers without leaking private scoring terms", () => {
    const advisory = buildPullRequestAdvisory(repo, null);
    const gate = evaluateGateCheck(
      {
        ...advisory,
        findings: [
          {
            code: "missing_linked_issue",
            title: "No linked issue near reward wallet trust score",
            severity: "warning" as const,
            detail: "Private score estimate detail.",
          },
        ],
      },
      { linkedIssueGateMode: "block" },
    );
    const output = formatGateCheckOutput(gate);

    expect(gate.conclusion).toBe("failure");
    expect(output.text).toContain("No linked issue near");
    expect(output.text).not.toMatch(/reward|wallet|trust score|score estimate/i);
  });

  it("keeps legacy Gate blockers by default while honoring explicit advisory or off modes", () => {
    const pr: PullRequestRecord = {
      repoFullName: repo.fullName,
      number: 21,
      title: "Add review panel",
      state: "open",
      authorLogin: "contributor",
      authorAssociation: "NONE",
      headSha: "abc123",
      labels: [],
      linkedIssues: [],
    };
    const missingIssueAdvisory = buildPullRequestAdvisory(repo, pr, { requireLinkedIssue: true });

    expect(evaluateGateCheck(missingIssueAdvisory).conclusion).toBe("failure");
    expect(evaluateGateCheck(missingIssueAdvisory, { linkedIssueGateMode: "advisory" }).conclusion).toBe("success");
    expect(evaluateGateCheck(missingIssueAdvisory, { linkedIssueGateMode: "off" }).conclusion).toBe("success");
    expect(evaluateGateCheck(missingIssueAdvisory, { linkedIssueGateMode: "block" }).conclusion).toBe("failure");

    const linkedPr: PullRequestRecord = { ...pr, number: 22, linkedIssues: [44] };
    const duplicateAdvisory = buildPullRequestAdvisory(repo, linkedPr, {
      otherOpenPullRequests: [{ ...linkedPr, number: 23, linkedIssues: [44] }],
    });

    expect(duplicateAdvisory.findings.map((finding) => finding.code)).toContain("duplicate_pr_risk");
    expect(evaluateGateCheck(duplicateAdvisory).conclusion).toBe("failure");
    expect(evaluateGateCheck(duplicateAdvisory, { duplicatePrGateMode: "advisory" }).conclusion).toBe("success");
    expect(evaluateGateCheck(duplicateAdvisory, { duplicatePrGateMode: "off" }).conclusion).toBe("success");
    expect(evaluateGateCheck(duplicateAdvisory, { duplicatePrGateMode: "block" }).conclusion).toBe("failure");
  });

  it("only enforces readiness score when quality gate mode is block", () => {
    const advisory = buildPullRequestAdvisory(repo, {
      repoFullName: repo.fullName,
      number: 24,
      title: "Add quality panel",
      state: "open",
      authorLogin: "contributor",
      authorAssociation: "NONE",
      headSha: "abc123",
      labels: [],
      linkedIssues: [9],
    });

    expect(evaluateGateCheck(advisory, { qualityGateMode: "advisory", qualityGateMinScore: 90, readinessScore: 10 }).conclusion).toBe("success");
    expect(evaluateGateCheck(advisory, { qualityGateMode: "off", qualityGateMinScore: 90, readinessScore: 10 }).conclusion).toBe("success");
    expect(evaluateGateCheck(advisory, { qualityGateMode: "block", qualityGateMinScore: null, readinessScore: 10 }).conclusion).toBe("success");
    expect(evaluateGateCheck(advisory, { qualityGateMode: "block", qualityGateMinScore: 90, readinessScore: null }).conclusion).toBe("success");
    expect(evaluateGateCheck(advisory, { qualityGateMode: "block", qualityGateMinScore: 90, readinessScore: 90 }).conclusion).toBe("success");

    const failingGate = evaluateGateCheck(advisory, { qualityGateMode: "block", qualityGateMinScore: 90, readinessScore: 89.4 });
    const output = formatGateCheckOutput(failingGate);

    expect(failingGate.conclusion).toBe("failure");
    expect(failingGate.blockers.map((finding) => finding.code)).toEqual(["readiness_score_below_threshold"]);
    expect(output.text).toContain("Readiness score is below the configured threshold");
    expect(output.text).toContain("Action: Address the short explicit PR panel actions");

    expect(evaluateGateCheck(advisory, { qualityGateMode: "block", qualityGateMinScore: 101, readinessScore: -5 }).blockers[0]?.detail).toContain("0/100");
    expect(evaluateGateCheck(advisory, { qualityGateMode: "block", qualityGateMinScore: 99, readinessScore: 102 }).conclusion).toBe("success");
    expect(evaluateGateCheck(advisory, { qualityGateMode: "block", qualityGateMinScore: Number.NaN, readinessScore: 10 }).conclusion).toBe("success");
  });

  it("summarizes multiple configured hard blockers without swallowing advisory warnings", () => {
    const gate = evaluateGateCheck(
      {
        ...buildPullRequestAdvisory(repo, null),
        findings: [
          { code: "missing_linked_issue", title: "No linked issue detected", severity: "warning", detail: "No linked issue." },
          { code: "duplicate_pr_risk", title: "Linked issue overlaps another open PR", severity: "warning", detail: "Duplicate." },
          { code: "busy_pr_queue", title: "Open PR queue is busy", severity: "warning", detail: "Queue context." },
        ],
      },
      { linkedIssueGateMode: "block", duplicatePrGateMode: "block", qualityGateMode: "block", qualityGateMinScore: 90, readinessScore: 42 },
    );

    expect(gate.conclusion).toBe("failure");
    expect(gate.summary).toBe("3 configured hard blockers found.");
    expect(gate.blockers.map((finding) => finding.code)).toEqual(["missing_linked_issue", "duplicate_pr_risk", "readiness_score_below_threshold"]);
    expect(gate.warnings.map((finding) => finding.code)).toEqual(["busy_pr_queue"]);
  });

  it("formats skipped and neutral Gate outputs as non-failures", () => {
    for (const conclusion of ["neutral", "skipped"] as const) {
      const output = formatGateCheckOutput({
        enabled: true,
        conclusion,
        title: conclusion === "skipped" ? "Gittensory Gate skipped" : "Gittensory Gate neutral",
        summary: "PR closed before full evaluation.",
        blockers: [],
        warnings: [],
      });

      expect(output.summary).toBe("PR closed before full evaluation.");
      expect(output.text).toBe("Gittensory did not create a contributor-facing failure for this event.");
    }
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

    expect(output.text).toBe("A configured hard blocker was found.");
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

  it("buildCheckRunAnnotations maps duplicate overlap and missing-test hotspots onto changed files", () => {
    const advisory = buildPullRequestAdvisory(repo, {
      repoFullName: repo.fullName,
      number: 12,
      title: "Add registry sync",
      state: "open",
      authorLogin: "contributor",
      authorAssociation: "NONE",
      labels: [],
      linkedIssues: [],
    });
    const files: PullRequestFileRecord[] = [
      { repoFullName: repo.fullName, pullNumber: 12, path: "src/registry/sync.ts", additions: 12, deletions: 0, changes: 12, payload: {} },
    ];
    const collisions: CollisionReport = {
      repoFullName: repo.fullName,
      generatedAt: "2026-06-10T00:00:00.000Z",
      summary: { clusterCount: 1, highRiskCount: 1, itemsReviewed: 2 },
      clusters: [
        {
          id: "pr-12--pr-13",
          risk: "high",
          reason: "Titles/paths share 4 meaningful terms.",
          items: [
            { type: "pull_request", number: 12, title: "Add registry sync" },
            { type: "pull_request", number: 13, title: "Registry sync cleanup" },
          ],
        },
      ],
    };

    const { annotations } = buildCheckRunAnnotations(advisory, { files, collisions, pullNumber: 12 }, "standard");

    expect(annotations.some((entry) => entry.title === "Missing test evidence" && entry.path === "src/registry/sync.ts")).toBe(true);
    expect(annotations.some((entry) => entry.title === "Possible duplicate overlap")).toBe(true);
    expect(JSON.stringify(annotations)).not.toMatch(/trust score|wallet|hotkey|reward estimate|reviewability/i);
  });

  it("buildCheckRunAnnotations uses notice level for medium-risk collisions and critical public finding text", () => {
    const advisory = {
      ...buildPullRequestAdvisory(repo, null),
      findings: [
        {
          code: "public_lane",
          title: "Issue discovery is disabled for this repo",
          severity: "critical" as const,
          detail: "Private detail",
          publicText: "This repo is configured for direct contribution review rather than issue-discovery flow.",
        },
      ],
    };
    const files: PullRequestFileRecord[] = [
      { repoFullName: repo.fullName, pullNumber: 14, path: "src/api/routes.ts", additions: 2, deletions: 0, changes: 2, payload: {} },
      { repoFullName: repo.fullName, pullNumber: 14, path: "src/api/routes.test.ts", additions: 2, deletions: 0, changes: 2, payload: {} },
    ];
    const collisions: CollisionReport = {
      repoFullName: repo.fullName,
      generatedAt: "2026-06-10T00:00:00.000Z",
      summary: { clusterCount: 1, highRiskCount: 0, itemsReviewed: 2 },
      clusters: [
        {
          id: "pr-14--pr-15",
          risk: "medium",
          reason: "Titles/paths share 2 meaningful terms.",
          items: [
            { type: "pull_request", number: 14, title: "Add routes" },
            { type: "pull_request", number: 15, title: "Routes cleanup" },
          ],
        },
      ],
    };

    const { annotations } = buildCheckRunAnnotations(advisory, { files, collisions, pullNumber: 14 }, "standard");

    expect(annotations.some((entry) => entry.annotation_level === "notice" && entry.title === "Possible duplicate overlap")).toBe(true);
    expect(annotations.some((entry) => entry.annotation_level === "failure" && entry.title === "Issue discovery is disabled for this repo")).toBe(true);
    expect(annotations.some((entry) => entry.title === "Missing test evidence")).toBe(false);
  });

  it("buildCheckRunAnnotations ignores blank public text and maps info findings to notice", () => {
    const advisory = {
      ...buildPullRequestAdvisory(repo, null),
      findings: [
        {
          code: "blank_public",
          title: "   ",
          severity: "info" as const,
          detail: "Private detail",
          publicText: "   ",
        },
        {
          code: "info_public",
          title: "Configured lane",
          severity: "info" as const,
          detail: "Private detail",
          publicText: "This repo is configured for direct contribution review rather than issue-discovery flow.",
        },
        {
          code: "warn_public",
          title: "Queue pressure",
          severity: "warning" as const,
          detail: "Private detail",
          publicText: "Open PR queue is elevated; keep changes focused.",
        },
      ],
    };
    const files: PullRequestFileRecord[] = [
      { repoFullName: repo.fullName, pullNumber: 15, path: "src/api/routes.ts", additions: 2, deletions: 0, changes: 2, payload: {} },
      { repoFullName: repo.fullName, pullNumber: 15, path: "src/api/routes.test.ts", additions: 2, deletions: 0, changes: 2, payload: {} },
    ];
    const collisions: CollisionReport = {
      repoFullName: repo.fullName,
      generatedAt: "2026-06-10T00:00:00.000Z",
      summary: { clusterCount: 1, highRiskCount: 0, itemsReviewed: 2 },
      clusters: [
        {
          id: "pr-15--pr-16",
          risk: "low",
          reason: "Titles/paths share 2 meaningful terms.",
          items: [
            { type: "pull_request", number: 15, title: "Add routes" },
            { type: "pull_request", number: 16, title: "Routes cleanup" },
          ],
        },
      ],
    };

    const { annotations } = buildCheckRunAnnotations(advisory, { files, collisions, pullNumber: 15 }, "deep");
    expect(annotations.some((entry) => entry.annotation_level === "notice" && entry.title === "Configured lane")).toBe(true);
    expect(annotations.some((entry) => entry.annotation_level === "warning" && entry.title === "Queue pressure")).toBe(true);
    expect(annotations.some((entry) => entry.title === "   ")).toBe(false);
  });

  it("buildCheckRunAnnotations caps output at 50 annotations and reports omitted count via formatCheckRunOutput", () => {
    const advisory = { ...buildPullRequestAdvisory(repo, null), findings: [] };
    const files = Array.from({ length: CHECK_RUN_ANNOTATION_LIMIT + 5 }, (_, index) => ({
      repoFullName: repo.fullName,
      pullNumber: 99,
      path: `src/feature/file-${index}.ts`,
      additions: 3,
      deletions: 0,
      changes: 3,
      payload: {},
    }));
    const collisions: CollisionReport = {
      repoFullName: repo.fullName,
      generatedAt: "2026-06-10T00:00:00.000Z",
      summary: { clusterCount: 0, highRiskCount: 0, itemsReviewed: 0 },
      clusters: [],
    };

    const { annotations, omittedCount } = buildCheckRunAnnotations(advisory, { files, collisions, pullNumber: 99 }, "deep");
    expect(annotations).toHaveLength(CHECK_RUN_ANNOTATION_LIMIT);
    expect(omittedCount).toBe(5);

    const output = formatCheckRunOutput(advisory, "deep", { files, collisions, pullNumber: 99 });
    expect(output.annotations).toHaveLength(CHECK_RUN_ANNOTATION_LIMIT);
    expect(output.text).toContain("…5 more hotspot annotation(s) omitted from inline check output.");
  });

  it("buildCheckRunAnnotations stays empty for minimal detail level", () => {
    const files: PullRequestFileRecord[] = [
      { repoFullName: repo.fullName, pullNumber: 1, path: "src/x.ts", additions: 1, deletions: 0, changes: 1, payload: {} },
    ];
    const { annotations } = buildCheckRunAnnotations(buildPullRequestAdvisory(repo, null), { files, collisions: emptyCollisions(), pullNumber: 1 }, "minimal");
    expect(annotations).toEqual([]);
  });

  it("buildCheckRunAnnotations skips findings without public text and duplicate overlap clusters for other pulls", () => {
    const advisory = {
      ...buildPullRequestAdvisory(repo, null),
      findings: [
        {
          code: "private_only",
          title: "Internal detail",
          severity: "warning" as const,
          detail: "Private detail",
        },
        {
          code: "public_lane",
          title: "Configured lane",
          severity: "info" as const,
          detail: "Private detail",
          publicText: "This repo is configured for direct contribution review rather than issue-discovery flow.",
        },
      ],
    };
    const files: PullRequestFileRecord[] = [
      { repoFullName: repo.fullName, pullNumber: 20, path: "src/api/routes.ts", additions: 2, deletions: 0, changes: 2, payload: {} },
      { repoFullName: repo.fullName, pullNumber: 20, path: "src/api/routes.test.ts", additions: 4, deletions: 0, changes: 4, payload: {} },
    ];
    const collisions: CollisionReport = {
      repoFullName: repo.fullName,
      generatedAt: "2026-06-10T00:00:00.000Z",
      summary: { clusterCount: 1, highRiskCount: 0, itemsReviewed: 2 },
      clusters: [
        {
          id: "pr-21--pr-22",
          risk: "medium",
          reason: "Titles/paths share 3 meaningful terms.",
          items: [
            { type: "pull_request", number: 21, title: "Other overlap" },
            { type: "pull_request", number: 22, title: "Other overlap cleanup" },
          ],
        },
      ],
    };

    const { annotations } = buildCheckRunAnnotations(advisory, { files, collisions, pullNumber: 20 }, "standard");

    expect(annotations.some((entry) => entry.title === "Missing test evidence")).toBe(false);
    expect(annotations.some((entry) => entry.title === "Possible duplicate overlap")).toBe(false);
    expect(annotations.filter((entry) => entry.title === "Configured lane")).toHaveLength(2);
  });

  it("buildCheckRunAnnotations deduplicates identical hotspot annotations", () => {
    const advisory = { ...buildPullRequestAdvisory(repo, null), findings: [] };
    const files: PullRequestFileRecord[] = [
      { repoFullName: repo.fullName, pullNumber: 30, path: "src/a.ts", additions: 1, deletions: 0, changes: 1, payload: {} },
    ];
    const collisions: CollisionReport = {
      repoFullName: repo.fullName,
      generatedAt: "2026-06-10T00:00:00.000Z",
      summary: { clusterCount: 2, highRiskCount: 0, itemsReviewed: 4 },
      clusters: [
        {
          id: "pr-30--pr-31",
          risk: "medium",
          reason: "Titles/paths share 3 meaningful terms.",
          items: [
            { type: "pull_request", number: 30, title: "Overlap" },
            { type: "pull_request", number: 31, title: "Overlap cleanup" },
          ],
        },
        {
          id: "pr-30--pr-32",
          risk: "medium",
          reason: "Titles/paths share 3 meaningful terms.",
          items: [
            { type: "pull_request", number: 30, title: "Overlap" },
            { type: "pull_request", number: 32, title: "Overlap follow-up" },
          ],
        },
      ],
    };

    const { annotations } = buildCheckRunAnnotations(advisory, { files, collisions, pullNumber: 30 }, "standard");
    expect(annotations.filter((entry) => entry.title === "Possible duplicate overlap")).toHaveLength(1);
  });

  it("buildCheckRunAnnotations ignores public findings when changed files have no paths", () => {
    const advisory = {
      ...buildPullRequestAdvisory(repo, null),
      findings: [
        {
          code: "public_lane",
          title: "Configured lane",
          severity: "info" as const,
          detail: "Private detail",
          publicText: "This repo is configured for direct contribution review rather than issue-discovery flow.",
        },
      ],
    };
    const files: PullRequestFileRecord[] = [
      { repoFullName: repo.fullName, pullNumber: 40, path: "", additions: 1, deletions: 0, changes: 1, payload: {} },
    ];

    const { annotations } = buildCheckRunAnnotations(advisory, { files, collisions: emptyCollisions(), pullNumber: 40 }, "standard");
    expect(annotations).toEqual([]);
  });
});

function emptyCollisions(): CollisionReport {
  return {
    repoFullName: "JSONbored/gittensory",
    generatedAt: "2026-06-10T00:00:00.000Z",
    summary: { clusterCount: 0, highRiskCount: 0, itemsReviewed: 0 },
    clusters: [],
  };
}
