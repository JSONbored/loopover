import { describe, expect, it } from "vitest";
import {
  buildCheckRunAnnotations,
  buildIssueAdvisory,
  buildPullRequestAdvisory,
  buildRepositoryAdvisory,
  CHECK_RUN_ANNOTATION_LIMIT,
  evaluateGateCheck,
  firstAddedLineFromPatch,
  formatCheckRunOutput,
  formatGateCheckOutput,
  isAiJudgmentOnlyFailure,
  reconcileGateEvaluationForGreenCi,
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

  it("#dup-winner: flag ON + winner (lowest open PR) ⇒ NO duplicate finding (gate success)", () => {
    const winner: PullRequestRecord = {
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
    const higherSibling: PullRequestRecord = { ...winner, number: 13, title: "Alternative registry sync" };

    const advisory = buildPullRequestAdvisory(repo, winner, { otherOpenPullRequests: [higherSibling], duplicateWinnerEnabled: true });

    expect(advisory.findings.map((finding) => finding.code)).not.toContain("duplicate_pr_risk");
  });

  it("#dup-winner: flag ON + loser (a lower open sibling exists) ⇒ duplicate finding present", () => {
    const loser: PullRequestRecord = {
      repoFullName: repo.fullName,
      number: 13,
      title: "Alternative registry sync",
      state: "open",
      authorLogin: "oktofeesh1",
      authorAssociation: "NONE",
      headSha: "abc123",
      labels: [],
      linkedIssues: [4],
    };
    const lowerSibling: PullRequestRecord = { ...loser, number: 12, title: "Add registry sync" };

    const advisory = buildPullRequestAdvisory(repo, loser, { otherOpenPullRequests: [lowerSibling], duplicateWinnerEnabled: true });

    expect(advisory.findings.map((finding) => finding.code)).toContain("duplicate_pr_risk");
  });

  it("#dup-winner: flag OFF + would-be-winner ⇒ duplicate finding STILL present (byte-identical)", () => {
    const wouldBeWinner: PullRequestRecord = {
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
    const higherSibling: PullRequestRecord = { ...wouldBeWinner, number: 13, title: "Alternative registry sync" };

    const advisory = buildPullRequestAdvisory(repo, wouldBeWinner, { otherOpenPullRequests: [higherSibling], duplicateWinnerEnabled: false });

    expect(advisory.findings.map((finding) => finding.code)).toContain("duplicate_pr_risk");
  });

  it("#dup-winner: flag ON + no overlap ⇒ no duplicate finding (alone in cluster)", () => {
    const lonePr: PullRequestRecord = {
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
    const unrelated: PullRequestRecord = { ...lonePr, number: 13, title: "Unrelated change", linkedIssues: [99] };

    const advisory = buildPullRequestAdvisory(repo, lonePr, { otherOpenPullRequests: [unrelated], duplicateWinnerEnabled: true });

    expect(advisory.findings.map((finding) => finding.code)).not.toContain("duplicate_pr_risk");
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

  it("never blocks on app/infra state — keeps an unsynced repo/PR neutral", () => {
    const advisory = buildPullRequestAdvisory(null, null);
    const gate = evaluateGateCheck(advisory);
    const output = formatGateCheckOutput(gate);

    // App-state findings (repo not synced, PR not cached) must NOT block a contributor on the app's
    // own state — the gate is neutral and re-evaluates automatically.
    expect(advisory.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(["repo_not_registered", "pr_not_cached"]));
    expect(gate.conclusion).toBe("neutral");
    expect(gate.blockers).toEqual([]);
    expect(output.title).toBe("Gittensory Gate — not evaluated yet");
    expect(output.summary).toContain("re-evaluates automatically");
    expect(output.text).toBe("Gittensory did not create a contributor-facing failure for this event.");
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

  it("keeps missing-issue advisory by default, blocks duplicates by default, honoring explicit modes", () => {
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

    // Missing linked issue defaults to ADVISORY — issues aren't always available, so it only blocks
    // when a repo explicitly opts in.
    expect(evaluateGateCheck(missingIssueAdvisory).conclusion).toBe("success");
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

  it("a reviewer SPLIT (ai_review_split) blocks → close, gated like a consensus defect by aiReviewGateMode (#ai-review-split)", () => {
    const splitAdvisory = {
      ...buildPullRequestAdvisory(repo, null),
      findings: [{ code: "ai_review_split", title: "An AI reviewer flagged a likely blocking defect", severity: "critical" as const, detail: "One reviewer flagged a blocker the other did not." }],
    };
    // reviewbot quorum: a single rejection (split) blocks → gate failure → close, but ONLY when aiReviewGateMode
    // is `block` (advisory/off keep it non-blocking, exactly like ai_consensus_defect).
    expect(evaluateGateCheck(splitAdvisory, { aiReviewGateMode: "block" }).conclusion).toBe("failure");
    expect(evaluateGateCheck(splitAdvisory, { aiReviewGateMode: "advisory" }).conclusion).toBe("success");
    expect(evaluateGateCheck(splitAdvisory).conclusion).toBe("success");
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
    // Title names the blocker count; summary enumerates every active blocker with its fix.
    expect(gate.title).toBe("Gittensory Gate: 3 blockers");
    expect(gate.summary).toContain("No linked issue detected");
    expect(gate.summary).toContain("Linked issue overlaps another open PR");
    expect(gate.summary).toContain("Readiness score is below the configured threshold — Address the short explicit PR panel actions");
    expect(gate.blockers.map((finding) => finding.code)).toEqual(["missing_linked_issue", "duplicate_pr_risk", "readiness_score_below_threshold"]);
    expect(gate.warnings.map((finding) => finding.code)).toEqual(["busy_pr_queue"]);
  });

  it("gates NON-confirmed contributors normally — a real blocker closes them like a confirmed author (#gate-nonconfirmed)", () => {
    const blockingAdvisory = {
      ...buildPullRequestAdvisory(repo, null),
      findings: [{ code: "duplicate_pr_risk", title: "Linked issue overlaps another open PR", severity: "warning" as const, detail: "Duplicate." }],
    };

    // Non-confirmed author: gated NORMALLY now — a real blocker → failure (one-shot close), no longer forced to a
    // neutral/held state. Confirmed-status affects only on-chain scoring, never the gate verdict. (#gate-nonconfirmed)
    const nonConfirmed = evaluateGateCheck(blockingAdvisory, { duplicatePrGateMode: "block", confirmedContributor: false });
    expect(nonConfirmed.conclusion).toBe("failure");
    expect(nonConfirmed.title).toBe("Gittensory Gate: Linked issue overlaps another open PR");
    expect(nonConfirmed.blockers.map((finding) => finding.code)).toEqual(["duplicate_pr_risk"]);

    // Confirmed author with the same blocker: identical verdict.
    const confirmed = evaluateGateCheck(blockingAdvisory, { duplicatePrGateMode: "block", confirmedContributor: true });
    expect(confirmed.conclusion).toBe("failure");
    expect(confirmed.blockers.map((finding) => finding.code)).toEqual(["duplicate_pr_risk"]);

    // A clean PR from a non-confirmed author is a normal success → auto-merges.
    const cleanNonConfirmed = evaluateGateCheck({ ...buildPullRequestAdvisory(repo, null), findings: [] }, { confirmedContributor: false });
    expect(cleanNonConfirmed.conclusion).toBe("success");
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

  it("buildCheckRunAnnotations only targets annotatable live changed files", () => {
    const advisory = {
      ...buildPullRequestAdvisory(repo, null),
      findings: [
        {
          code: "public_lane",
          title: "Configured lane",
          severity: "info" as const,
          detail: "Private detail",
          publicText: "Public context for the changed file.",
        },
      ],
    };
    const files: PullRequestFileRecord[] = [
      { repoFullName: repo.fullName, pullNumber: 41, path: "src/deleted.ts", status: "removed", additions: 0, deletions: 5, changes: 5, payload: {} },
      { repoFullName: repo.fullName, pullNumber: 41, path: "src/renamed.ts", status: "renamed", additions: 2, deletions: 1, changes: 3, payload: { patch: "@@ -1,1 +3,2 @@\n+renamed" } },
      { repoFullName: repo.fullName, pullNumber: 41, path: "assets/diagram.png", status: "added", additions: 1, deletions: 0, changes: 1, payload: {} },
      { repoFullName: repo.fullName, pullNumber: 41, path: "src/live.ts", status: "modified", additions: 1, deletions: 0, changes: 1, payload: { patch: "@@ -10,0 +11,1 @@\n+const live = true;" } },
      { repoFullName: repo.fullName, pullNumber: 41, path: "src/no-added-lines.ts", status: "modified", additions: 0, deletions: 1, changes: 1, payload: { patch: "@@ -1,1 +1,0 @@\n-const stale = true;" } },
    ];

    const { annotations } = buildCheckRunAnnotations(advisory, { files, collisions: emptyCollisions(), pullNumber: 41 }, "standard");

    expect(annotations.map((entry) => entry.path)).toEqual(["src/live.ts", "src/live.ts"]);
    expect(annotations.every((entry) => entry.start_line === 11 && entry.end_line === 11)).toBe(true);
  });

  it("buildCheckRunAnnotations drops a modified file whose patch has no anchorable added line", () => {
    const advisory = {
      ...buildPullRequestAdvisory(repo, null),
      findings: [
        {
          code: "public_lane",
          title: "Configured lane",
          severity: "info" as const,
          detail: "Private detail",
          publicText: "Public context for the changed file.",
        },
      ],
    };
    // additions > 0 and status "modified", but the patch has no `@@ -x +y @@` header,
    // so firstAddedLineFromPatch returns null -> annotationLineForFile null -> file filtered out.
    const files: PullRequestFileRecord[] = [
      {
        repoFullName: repo.fullName,
        pullNumber: 42,
        path: "src/no-header.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: { patch: "+const orphan = true;" },
      },
    ];

    const { annotations } = buildCheckRunAnnotations(advisory, { files, collisions: emptyCollisions(), pullNumber: 42 }, "standard");
    expect(annotations).toEqual([]);
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

describe("firstAddedLineFromPatch", () => {
  it("returns null for a patch with no parseable hunk header (no added line to anchor)", () => {
    // Deletion-only body lines without any `@@ -x +y @@` header -> nothing to anchor on.
    const patch = "-const removed = 1;\n-const alsoRemoved = 2;\n const kept = 3;";
    expect(firstAddedLineFromPatch(patch)).toBeNull();
  });

  it("returns null for an empty patch or non-annotatable diff text", () => {
    expect(firstAddedLineFromPatch("")).toBeNull();
    expect(firstAddedLineFromPatch("Binary files a/x.png and b/x.png differ")).toBeNull();
  });

  it("returns the first added line for a normal added-line hunk", () => {
    const patch = "@@ -10,0 +11,1 @@\n+const live = true;";
    expect(firstAddedLineFromPatch(patch)).toBe(11);
  });

  it("uses the first hunk header when multiple hunks are present", () => {
    const patch = "@@ -1,2 +5,3 @@\n+first added\n@@ -40,1 +60,2 @@\n+later added";
    expect(firstAddedLineFromPatch(patch)).toBe(5);
  });

  it("clamps a zero-based hunk start up to line 1", () => {
    const patch = "@@ -0,0 +0,1 @@\n+first line of a new file";
    expect(firstAddedLineFromPatch(patch)).toBe(1);
  });
});

  describe("self_authored_linked_issue finding", () => {
    const prBase: PullRequestRecord = {
      repoFullName: repo.fullName,
      number: 55,
      title: "Fix login bug",
      state: "open",
      authorLogin: "contributor1",
      authorAssociation: "NONE",
      headSha: "sha55",
      labels: [],
      linkedIssues: [10],
    };

    it("raises self_authored_linked_issue when the PR author also opened the linked issue", () => {
      const advisory = buildPullRequestAdvisory(repo, prBase, { linkedIssueAuthorLogins: ["contributor1"] });
      expect(advisory.findings.map((f) => f.code)).toContain("self_authored_linked_issue");
    });

    it("is case-insensitive when comparing author logins", () => {
      const advisory = buildPullRequestAdvisory(repo, prBase, { linkedIssueAuthorLogins: ["Contributor1"] });
      expect(advisory.findings.map((f) => f.code)).toContain("self_authored_linked_issue");
    });

    it("does not raise the finding when the PR author differs from the issue author", () => {
      const advisory = buildPullRequestAdvisory(repo, prBase, { linkedIssueAuthorLogins: ["someone_else"] });
      expect(advisory.findings.map((f) => f.code)).not.toContain("self_authored_linked_issue");
    });

    it("does not raise the finding when linkedIssueAuthorLogins is absent (fail-open: unknown authorship stays advisory-only)", () => {
      const advisory = buildPullRequestAdvisory(repo, prBase);
      expect(advisory.findings.map((f) => f.code)).not.toContain("self_authored_linked_issue");
    });

    it("does not raise the finding when linkedIssueAuthorLogins contains only null values (author unknown)", () => {
      const advisory = buildPullRequestAdvisory(repo, prBase, { linkedIssueAuthorLogins: [null, undefined] });
      expect(advisory.findings.map((f) => f.code)).not.toContain("self_authored_linked_issue");
    });

    it("does not raise the finding when the PR has no linked issues", () => {
      const noIssuePr = { ...prBase, linkedIssues: [] };
      const advisory = buildPullRequestAdvisory(repo, noIssuePr, { linkedIssueAuthorLogins: ["contributor1"] });
      expect(advisory.findings.map((f) => f.code)).not.toContain("self_authored_linked_issue");
    });

    it("does not raise the finding when the PR author is unknown (null authorLogin)", () => {
      const noAuthorPr = { ...prBase, authorLogin: null };
      const advisory = buildPullRequestAdvisory(repo, noAuthorPr, { linkedIssueAuthorLogins: ["contributor1"] });
      expect(advisory.findings.map((f) => f.code)).not.toContain("self_authored_linked_issue");
    });

    it("raises the finding when at least one linked issue author matches the PR author (mixed authors)", () => {
      const advisory = buildPullRequestAdvisory(repo, prBase, { linkedIssueAuthorLogins: ["other_user", "contributor1"] });
      expect(advisory.findings.map((f) => f.code)).toContain("self_authored_linked_issue");
    });

    it("is advisory by default: self_authored_linked_issue is NOT a gate blocker without policy override", () => {
      const advisory = buildPullRequestAdvisory(repo, prBase, { linkedIssueAuthorLogins: ["contributor1"] });
      const gate = evaluateGateCheck(advisory);
      expect(gate.conclusion).toBe("success");
      expect(gate.blockers.map((f) => f.code)).not.toContain("self_authored_linked_issue");
      expect(gate.warnings.map((f) => f.code)).toContain("self_authored_linked_issue");
    });

    it("is advisory when selfAuthoredLinkedIssueGateMode is advisory", () => {
      const advisory = buildPullRequestAdvisory(repo, prBase, { linkedIssueAuthorLogins: ["contributor1"] });
      const gate = evaluateGateCheck(advisory, { selfAuthoredLinkedIssueGateMode: "advisory" });
      expect(gate.conclusion).toBe("success");
      expect(gate.blockers.map((f) => f.code)).not.toContain("self_authored_linked_issue");
    });

    it("is advisory when selfAuthoredLinkedIssueGateMode is off", () => {
      const advisory = buildPullRequestAdvisory(repo, prBase, { linkedIssueAuthorLogins: ["contributor1"] });
      const gate = evaluateGateCheck(advisory, { selfAuthoredLinkedIssueGateMode: "off" });
      expect(gate.conclusion).toBe("success");
      expect(gate.blockers.map((f) => f.code)).not.toContain("self_authored_linked_issue");
    });

    it("blocks when selfAuthoredLinkedIssueGateMode is block", () => {
      const advisory = buildPullRequestAdvisory(repo, prBase, { linkedIssueAuthorLogins: ["contributor1"] });
      const gate = evaluateGateCheck(advisory, { selfAuthoredLinkedIssueGateMode: "block" });
      expect(gate.conclusion).toBe("failure");
      expect(gate.blockers.map((f) => f.code)).toContain("self_authored_linked_issue");
    });

    it("does not block when selfAuthoredLinkedIssueGateMode is block but no self-authored issue finding exists", () => {
      const advisory = buildPullRequestAdvisory(repo, prBase, { linkedIssueAuthorLogins: ["someone_else"] });
      const gate = evaluateGateCheck(advisory, { selfAuthoredLinkedIssueGateMode: "block" });
      expect(gate.conclusion).toBe("success");
      expect(gate.blockers.map((f) => f.code)).not.toContain("self_authored_linked_issue");
    });
  });

describe("CI-refutation of the public comment gate (#ai-ci-refutation)", () => {
  const finding = (code: string): import("../../src/types").AdvisoryFinding => ({ code, severity: "critical", title: `t:${code}`, detail: `d:${code}` });
  const failure = (codes: string[]): import("../../src/rules/advisory").GateCheckEvaluation => ({
    enabled: true,
    conclusion: "failure",
    title: "Gittensory Gate: blocked",
    summary: "A hard blocker was found.",
    blockers: codes.map(finding),
    warnings: [],
  });

  it("isAiJudgmentOnlyFailure: true only when EVERY blocker is an AI-judgment code", () => {
    expect(isAiJudgmentOnlyFailure(failure(["ai_consensus_defect"]))).toBe(true);
    expect(isAiJudgmentOnlyFailure(failure(["ai_review_split"]))).toBe(true);
    expect(isAiJudgmentOnlyFailure(failure(["ai_consensus_defect", "ai_review_split"]))).toBe(true);
    expect(isAiJudgmentOnlyFailure(failure(["ai_consensus_defect", "duplicate_open_pr"]))).toBe(false);
    expect(isAiJudgmentOnlyFailure(failure(["slop_high"]))).toBe(false);
    expect(isAiJudgmentOnlyFailure(failure(["ai_review_inconclusive"]))).toBe(false);
    // An empty blocker list is not a refutable AI-only failure.
    expect(isAiJudgmentOnlyFailure({ ...failure([]), conclusion: "failure" })).toBe(false);
    // A non-failure conclusion is never AI-only-failure.
    expect(isAiJudgmentOnlyFailure({ ...failure(["ai_consensus_defect"]), conclusion: "success" })).toBe(false);
  });

  it("enabled + green CI + AI-judgment-only failure → SUCCESS with cleared blockers (matches the merge disposition)", () => {
    const out = reconcileGateEvaluationForGreenCi(failure(["ai_consensus_defect"]), "passed", true);
    expect(out.conclusion).toBe("success");
    expect(out.blockers).toEqual([]);
    expect(out.title).toBe("Gittensory Gate passed");
    expect(out.summary).toContain("advisory, not blocking");
  });

  it("enabled + green CI + split-only failure → SUCCESS too", () => {
    expect(reconcileGateEvaluationForGreenCi(failure(["ai_review_split"]), "passed", true).conclusion).toBe("success");
  });

  it("is GATED by `enabled` — enabled=false returns the failure UNCHANGED even on green CI", () => {
    const fail = failure(["ai_consensus_defect"]);
    expect(reconcileGateEvaluationForGreenCi(fail, "passed", false)).toBe(fail);
  });

  it("does NOT reconcile when CI is red — the real failing check stands", () => {
    const fail = failure(["ai_consensus_defect"]);
    expect(reconcileGateEvaluationForGreenCi(fail, "failed", true)).toBe(fail);
  });

  it("does NOT reconcile when CI is unverified", () => {
    const fail = failure(["ai_consensus_defect"]);
    expect(reconcileGateEvaluationForGreenCi(fail, "unverified", true)).toBe(fail);
  });

  it("does NOT reconcile a mixed failure (any deterministic blocker present) even on green CI", () => {
    const fail = failure(["ai_consensus_defect", "duplicate_open_pr"]);
    expect(reconcileGateEvaluationForGreenCi(fail, "passed", true)).toBe(fail);
    expect(reconcileGateEvaluationForGreenCi(fail, "passed", true).conclusion).toBe("failure");
  });

  it("does NOT reconcile a deterministic-only failure on green CI (e.g. slop)", () => {
    const fail = failure(["slop_high"]);
    expect(reconcileGateEvaluationForGreenCi(fail, "passed", true)).toBe(fail);
  });

  it("does NOT reconcile a success gate (no-op pass-through)", () => {
    const ok = { ...failure([]), conclusion: "success" as const, blockers: [] };
    expect(reconcileGateEvaluationForGreenCi(ok, "passed", true)).toBe(ok);
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
