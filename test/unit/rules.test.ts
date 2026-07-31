import { CONFIGURED_GATE_BLOCKER_SIGNAL_CODES } from "../../src/rules/advisory";
import { describe, expect, it } from "vitest";
import {
  buildCheckRunAnnotations,
  buildIssueAdvisory,
  buildPullRequestAdvisory,
  buildRepositoryAdvisory,
  CHECK_RUN_ANNOTATION_LIMIT,
  DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE,
  evaluateGateCheck,
  firstAddedLineFromPatch,
  formatCheckRunOutput,
  formatGateCheckOutput,
  isAiJudgmentOnlyFailure,
  isDuplicateOnlyFailure,
  reconcileGateEvaluationForGreenCi,
  resolveAiReviewLowConfidenceHold,
} from "../../src/rules/advisory";
import type { CollisionReport } from "../../src/signals/engine";
import type { IssueRecord, PullRequestRecord, PullRequestFileRecord, RepositoryRecord } from "../../src/types";

const repo: RepositoryRecord = {
  fullName: "JSONbored/loopover",
  owner: "JSONbored",
  name: "loopover",
  isInstalled: true,
  isRegistered: true,
  isPrivate: true,
  registryConfig: {
    repo: "JSONbored/loopover",
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

  it("REGRESSION (#linked-issue-sparse-first-upsert): does NOT flag a not-yet-body-observed PR as missing a linked issue", () => {
    // pr.bodyObservedAt EXPLICITLY null (a real DB row) means no genuine body sync has landed yet -- the empty
    // linkedIssues here is unverified, not a confirmed empty body. Firing the finding on this state is exactly
    // the false-positive auto-close bug (PRs #5985/#5994) that motivated tracking this field.
    const pr: PullRequestRecord = {
      repoFullName: repo.fullName,
      number: 16,
      title: "Add registry sync",
      state: "open",
      authorLogin: "oktofeesh1",
      authorAssociation: "NONE",
      headSha: "abc123",
      labels: ["feature"],
      linkedIssues: [],
      bodyObservedAt: null,
    };

    const advisory = buildPullRequestAdvisory(repo, pr, { requireLinkedIssue: true });

    expect(advisory.conclusion).toBe("success");
    expect(advisory.findings.map((finding) => finding.code)).not.toContain("missing_linked_issue");
  });

  it("still flags missing linked issue once bodyObservedAt is stamped (a genuinely observed empty body)", () => {
    const pr: PullRequestRecord = {
      repoFullName: repo.fullName,
      number: 17,
      title: "Add registry sync",
      state: "open",
      authorLogin: "oktofeesh1",
      authorAssociation: "NONE",
      headSha: "abc123",
      labels: ["feature"],
      linkedIssues: [],
      bodyObservedAt: "2026-07-14T00:00:00.000Z",
    };

    const advisory = buildPullRequestAdvisory(repo, pr, { requireLinkedIssue: true });

    expect(advisory.conclusion).toBe("neutral");
    expect(advisory.findings.map((finding) => finding.code)).toContain("missing_linked_issue");
  });

  it("does NOT flag a cited-but-unverified linked issue as missing (byte-identical to today when the caller hasn't confirmed it's dead)", () => {
    const pr: PullRequestRecord = {
      repoFullName: repo.fullName,
      number: 13,
      title: "Fix a bug",
      state: "open",
      authorLogin: "oktofeesh1",
      authorAssociation: "NONE",
      headSha: "abc123",
      labels: [],
      linkedIssues: [7],
    };

    const advisory = buildPullRequestAdvisory(repo, pr, { requireLinkedIssue: true });

    expect(advisory.findings.map((finding) => finding.code)).not.toContain("missing_linked_issue");
  });

  it("flags a linked issue as missing when the caller has confirmed none of the citations resolve to an open issue (#unlinked-issue-guardrail-followup)", () => {
    // pr.linkedIssues is populated by a pure body-text regex that never checks the cited issue's real state --
    // a contributor can otherwise satisfy `requireLinkedIssue`/`linkedIssueGateMode: block` by citing an
    // already-CLOSED (or fabricated) issue number. confirmedNoOpenLinkedIssue is the caller's live-verified
    // signal that every citation is conclusively dead.
    const pr: PullRequestRecord = {
      repoFullName: repo.fullName,
      number: 14,
      title: "Fix a bug",
      state: "open",
      authorLogin: "oktofeesh1",
      authorAssociation: "NONE",
      headSha: "abc123",
      labels: [],
      linkedIssues: [7],
    };

    const advisory = buildPullRequestAdvisory(repo, pr, { requireLinkedIssue: true, confirmedNoOpenLinkedIssue: true });

    expect(advisory.conclusion).toBe("neutral");
    const finding = advisory.findings.find((f) => f.code === "missing_linked_issue");
    expect(finding).toBeDefined();
    expect(finding?.detail).toContain("could not be verified as a currently open issue");
  });

  it("confirmedNoOpenLinkedIssue is a no-op when the PR links nothing at all (the existing zero-citation path still drives the finding, with its own detail text)", () => {
    const pr: PullRequestRecord = {
      repoFullName: repo.fullName,
      number: 15,
      title: "Fix a bug",
      state: "open",
      authorLogin: "oktofeesh1",
      authorAssociation: "NONE",
      headSha: "abc123",
      labels: [],
      linkedIssues: [],
    };

    const advisory = buildPullRequestAdvisory(repo, pr, { requireLinkedIssue: true, confirmedNoOpenLinkedIssue: true });

    const finding = advisory.findings.find((f) => f.code === "missing_linked_issue");
    expect(finding?.detail).toBe("No closing reference or linked issue number was found in the PR metadata/body.");
  });

  // #10168: the same confirmedNoOpenLinkedIssue state splits in two once the caller can prove a rival merged
  // after this PR opened and closed its issue. The contributor did not fail to link anything.
  describe("supersession (#10168)", () => {
    const supersededPr: PullRequestRecord = {
      repoFullName: repo.fullName,
      number: 8886,
      title: "Fix a bug",
      state: "open",
      authorLogin: "oktofeesh1",
      authorAssociation: "NONE",
      headSha: "abc123",
      labels: [],
      linkedIssues: [8829],
    };
    const supersededBy = { issueNumber: 8829, rivalPullNumber: 8881, rivalMergedAt: "2026-07-31T09:30:24Z", issueClosedAt: "2026-07-31T09:30:25Z" };

    it("reports a supersession naming the rival, not 'No linked issue detected'", () => {
      const advisory = buildPullRequestAdvisory(repo, supersededPr, { requireLinkedIssue: true, confirmedNoOpenLinkedIssue: true, supersededBy });

      expect(advisory.findings.find((f) => f.code === "missing_linked_issue")).toBeUndefined();
      const finding = advisory.findings.find((f) => f.code === "linked_issue_superseded");
      expect(finding?.title).toBe("Superseded by a merged pull request");
      expect(finding?.detail).toContain("#8829 was closed by #8881");
      // The advice must not be the one that cannot work -- re-linking a closed issue changes nothing.
      expect(finding?.action).not.toContain("link it explicitly in the PR body");
      expect(finding?.action).toContain("#8881");
    });

    it("keeps the anti-gaming reading when no rival is proven (absent and explicit-null both)", () => {
      for (const value of [undefined, null]) {
        const advisory = buildPullRequestAdvisory(repo, supersededPr, { requireLinkedIssue: true, confirmedNoOpenLinkedIssue: true, supersededBy: value });
        expect(advisory.findings.find((f) => f.code === "linked_issue_superseded")).toBeUndefined();
        expect(advisory.findings.find((f) => f.code === "missing_linked_issue")).toBeDefined();
      }
    });

    it("never fires while the linked-issue requirement is off", () => {
      const advisory = buildPullRequestAdvisory(repo, supersededPr, { requireLinkedIssue: false, confirmedNoOpenLinkedIssue: true, supersededBy });
      expect(advisory.findings.find((f) => f.code === "linked_issue_superseded")).toBeUndefined();
    });
  });

  it("marks unknown repositories as action required", () => {
    const advisory = buildRepositoryAdvisory(null, "owner/repo");
    expect(advisory.conclusion).toBe("action_required");
  });

  it("handles uncached PR and issue advisories for unknown repositories", () => {
    expect(buildPullRequestAdvisory(null, null).findings.map((finding) => finding.code)).toEqual(["repo_not_cached", "pr_not_cached"]);
    expect(buildIssueAdvisory(null, null).findings.map((finding) => finding.code)).toEqual(["repo_not_cached", "issue_not_cached"]);
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

  // #9129: a plain body-text overlap (neither side has changedFiles resolved) is UNCORROBORATED -- it gets the
  // separate, always-non-blocking duplicate_pr_risk_unconfirmed code, never the concrete duplicate_pr_risk code.
  it("flags an UNCONFIRMED duplicate risk when another open PR references the same linked issue with no corroborating diff evidence (#9129)", () => {
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

    expect(advisory.findings.map((finding) => finding.code)).toContain("duplicate_pr_risk_unconfirmed");
    expect(advisory.findings.map((finding) => finding.code)).not.toContain("duplicate_pr_risk");
  });

  // #9129: a genuine changed-file-path overlap CORROBORATES the same scenario -- now the concrete duplicate_pr_risk
  // code fires instead, and it stays configurable via duplicatePrGateMode (see the gate-mode tests below).
  it("flags a CONFIRMED duplicate risk when the overlapping open PR shares a changed-file path (#9129)", () => {
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
      changedFiles: ["src/registry/sync.ts"],
    };
    const otherPr: PullRequestRecord = {
      ...pr,
      number: 13,
      title: "Alternative registry sync",
      linkedIssues: [4],
      changedFiles: ["src/registry/sync.ts", "src/registry/other.ts"],
    };

    const advisory = buildPullRequestAdvisory(repo, pr, { otherOpenPullRequests: [otherPr] });

    expect(advisory.findings.map((finding) => finding.code)).toContain("duplicate_pr_risk");
    expect(advisory.findings.map((finding) => finding.code)).not.toContain("duplicate_pr_risk_unconfirmed");
  });

  // #9129: the ALTERNATE corroboration path -- the sibling has a resolved, non-empty changed-file set of its own
  // (a real diff exists), even though it shares no path with this PR's own changes.
  it("flags a CONFIRMED duplicate risk when the sibling PR is a non-trivial real change, even without shared file paths (#9129)", () => {
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
      // This PR's own changedFiles are unresolved -- corroboration must still work off the sibling alone.
    };
    const otherPr: PullRequestRecord = {
      ...pr,
      number: 13,
      title: "Alternative registry sync",
      linkedIssues: [4],
      changedFiles: ["src/registry/other-approach.ts"],
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
      linkedIssueClaimedAt: "2026-06-29T10:00:00.000Z",
    };
    const higherSibling: PullRequestRecord = { ...winner, number: 13, title: "Alternative registry sync", linkedIssueClaimedAt: "2026-06-29T10:01:00.000Z" };

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
      linkedIssueClaimedAt: "2026-06-29T10:01:00.000Z",
    };
    const lowerSibling: PullRequestRecord = { ...loser, number: 12, title: "Add registry sync", linkedIssueClaimedAt: "2026-06-29T10:00:00.000Z" };

    const advisory = buildPullRequestAdvisory(repo, loser, { otherOpenPullRequests: [lowerSibling], duplicateWinnerEnabled: true });

    // Neither PR has changedFiles resolved here, so the finding is the UNCONFIRMED code (#9129) -- the
    // duplicate-winner suppression logic itself is what this test covers, orthogonal to corroboration.
    expect(advisory.findings.map((finding) => finding.code)).toContain("duplicate_pr_risk_unconfirmed");
  });

  // #9033: a cross-issue copycat containment match must feed the SAME duplicate_pr_risk finding a shared linked
  // issue does -- the exact reward-farming gap where two colluding accounts file near-identical fixes under
  // DIFFERENT linked issues and both merge independently.
  describe("copycat cross-issue duplicate overlap (#9033)", () => {
    function candidatePr(over: Partial<PullRequestRecord> = {}): PullRequestRecord {
      return {
        repoFullName: repo.fullName,
        number: 12,
        title: "Add registry sync",
        state: "open",
        authorLogin: "oktofeesh1",
        authorAssociation: "NONE",
        headSha: "abc123",
        labels: [],
        linkedIssues: [4],
        ...over,
      };
    }

    it("flags a CONFIRMED duplicate risk against a sibling citing a DIFFERENT linked issue, once the copycat containment match clears the threshold", () => {
      const pr = candidatePr({ linkedIssues: [4], copycatScore: 92, copycatMatchedPullNumber: 13 });
      const sibling = candidatePr({ number: 13, title: "Alternative registry sync", linkedIssues: [999] });

      const advisory = buildPullRequestAdvisory(repo, pr, { otherOpenPullRequests: [sibling], copycatGateMode: "warn", copycatGateMinScore: 85 });

      expect(advisory.findings.map((finding) => finding.code)).toContain("duplicate_pr_risk");
      expect(advisory.findings.map((finding) => finding.code)).not.toContain("duplicate_pr_risk_unconfirmed");
    });

    it("does NOT flag a duplicate risk when copycatGateMode is off, even with a high containment score", () => {
      const pr = candidatePr({ linkedIssues: [4], copycatScore: 92, copycatMatchedPullNumber: 13 });
      const sibling = candidatePr({ number: 13, title: "Alternative registry sync", linkedIssues: [999] });

      const advisory = buildPullRequestAdvisory(repo, pr, { otherOpenPullRequests: [sibling], copycatGateMode: "off", copycatGateMinScore: 85 });

      expect(advisory.findings.map((finding) => finding.code)).not.toContain("duplicate_pr_risk");
      expect(advisory.findings.map((finding) => finding.code)).not.toContain("duplicate_pr_risk_unconfirmed");
    });

    it("does NOT flag a duplicate risk when the containment score is below the resolved threshold", () => {
      const pr = candidatePr({ linkedIssues: [4], copycatScore: 40, copycatMatchedPullNumber: 13 });
      const sibling = candidatePr({ number: 13, title: "Alternative registry sync", linkedIssues: [999] });

      const advisory = buildPullRequestAdvisory(repo, pr, { otherOpenPullRequests: [sibling], copycatGateMode: "warn", copycatGateMinScore: 85 });

      expect(advisory.findings.map((finding) => finding.code)).not.toContain("duplicate_pr_risk");
    });

    it("#dup-winner + copycat: the cluster winner is spared even when the overlap is a cross-issue copycat match", () => {
      const winner = candidatePr({ number: 12, linkedIssues: [4], linkedIssueClaimedAt: "2026-06-29T10:00:00.000Z", copycatScore: 92, copycatMatchedPullNumber: 13 });
      const laterSibling = candidatePr({ number: 13, title: "Alternative registry sync", linkedIssues: [999], linkedIssueClaimedAt: "2026-06-29T10:01:00.000Z" });

      const advisory = buildPullRequestAdvisory(repo, winner, {
        otherOpenPullRequests: [laterSibling],
        duplicateWinnerEnabled: true,
        copycatGateMode: "warn",
        copycatGateMinScore: 85,
      });

      expect(advisory.findings.map((finding) => finding.code)).not.toContain("duplicate_pr_risk");
    });

    it("a sibling that is BOTH the linked-issue overlap AND the copycat match is not double-counted", () => {
      const pr = candidatePr({ linkedIssues: [4], copycatScore: 92, copycatMatchedPullNumber: 13 });
      const sibling = candidatePr({ number: 13, title: "Alternative registry sync", linkedIssues: [4] }); // SAME linked issue

      const advisory = buildPullRequestAdvisory(repo, pr, { otherOpenPullRequests: [sibling], copycatGateMode: "warn", copycatGateMinScore: 85 });

      const duplicateFindings = advisory.findings.filter((finding) => finding.code === "duplicate_pr_risk");
      expect(duplicateFindings).toHaveLength(1);
      expect(duplicateFindings[0]?.detail).toContain("#13");
      expect(duplicateFindings[0]?.detail.match(/#13/g)).toHaveLength(1);
    });
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
      linkedIssueClaimedAt: "2026-06-29T10:00:00.000Z",
    };
    const higherSibling: PullRequestRecord = { ...wouldBeWinner, number: 13, title: "Alternative registry sync", linkedIssueClaimedAt: "2026-06-29T10:01:00.000Z" };

    const advisory = buildPullRequestAdvisory(repo, wouldBeWinner, { otherOpenPullRequests: [higherSibling], duplicateWinnerEnabled: false });

    // Neither PR has changedFiles resolved here (#9129: uncorroborated code).
    expect(advisory.findings.map((finding) => finding.code)).toContain("duplicate_pr_risk_unconfirmed");
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
      linkedIssueClaimedAt: "2026-06-29T10:00:00.000Z",
    };
    const unrelated: PullRequestRecord = { ...lonePr, number: 13, title: "Unrelated change", linkedIssues: [99], linkedIssueClaimedAt: "2026-06-29T10:01:00.000Z" };

    const advisory = buildPullRequestAdvisory(repo, lonePr, { otherOpenPullRequests: [unrelated], duplicateWinnerEnabled: true });

    expect(advisory.findings.map((finding) => finding.code)).not.toContain("duplicate_pr_risk");
    expect(advisory.findings.map((finding) => finding.code)).not.toContain("duplicate_pr_risk_unconfirmed");
  });

  it("#9160: scopedLinkedIssueClaimedAt overrides pr's blended linkedIssueClaimedAt for the winner election, closing the backdating attack", () => {
    // The attacker's PR carries a backdated BLENDED linkedIssueClaimedAt (from an old, unrelated linked issue
    // whose overlap preserved it) that would make it win against the victim if the raw column were used
    // directly -- see db-parsers.test.ts's REGRESSION (#9160) test for how the per-(PR, issue) ledger produces
    // the correctly-scoped value the caller (queue/duplicate-detection.ts's resolveScopedLinkedIssueClaimedAt)
    // passes in as scopedLinkedIssueClaimedAt.
    const attacker: PullRequestRecord = {
      repoFullName: repo.fullName,
      number: 21,
      title: "Backdated claim",
      state: "open",
      authorLogin: "attacker",
      authorAssociation: "NONE",
      headSha: "abc123",
      labels: [],
      linkedIssues: [7],
      linkedIssueClaimedAt: "2026-06-29T10:00:00.000Z", // blended column: backdated via an unrelated issue #1
    };
    const victim: PullRequestRecord = { ...attacker, number: 22, title: "Victim's genuine claim", authorLogin: "victim", linkedIssueClaimedAt: "2026-07-01T00:00:00.000Z" };

    // Without scoping, the attacker's blended (backdated) timestamp wins -- confirms the vulnerable baseline.
    const unscoped = buildPullRequestAdvisory(repo, attacker, { otherOpenPullRequests: [victim], duplicateWinnerEnabled: true });
    expect(unscoped.findings.map((finding) => finding.code)).not.toContain("duplicate_pr_risk");

    // With the per-issue-scoped claim time (the attacker's OWN ledger row for issue #7, correctly dated AFTER
    // the victim's genuine claim), the attacker is correctly demoted to loser.
    const scoped = buildPullRequestAdvisory(repo, attacker, {
      otherOpenPullRequests: [victim],
      duplicateWinnerEnabled: true,
      scopedLinkedIssueClaimedAt: "2026-07-20T09:00:00.000Z",
    });
    expect(scoped.findings.map((finding) => finding.code)).toContain("duplicate_pr_risk_unconfirmed");
  });

  it("#9160: scopedLinkedIssueClaimedAt undefined falls back to pr.linkedIssueClaimedAt, byte-identical to before this field existed", () => {
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
      linkedIssueClaimedAt: "2026-06-29T10:00:00.000Z",
    };
    const higherSibling: PullRequestRecord = { ...winner, number: 13, title: "Alternative registry sync", linkedIssueClaimedAt: "2026-06-29T10:01:00.000Z" };

    const advisory = buildPullRequestAdvisory(repo, winner, { otherOpenPullRequests: [higherSibling], duplicateWinnerEnabled: true, scopedLinkedIssueClaimedAt: undefined });

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
    expect(output.title).toBe("LoopOver Orb Review Agent passed");
    expect(output.text).toContain("No configured hard blocker");
  });

  it("never blocks on app/infra state — keeps an unsynced repo/PR neutral", () => {
    const advisory = buildPullRequestAdvisory(null, null);
    const gate = evaluateGateCheck(advisory);
    const output = formatGateCheckOutput(gate);

    // App-state findings (repo not synced, PR not cached) must NOT block a contributor on the app's
    // own state — the gate is neutral and re-evaluates automatically.
    expect(advisory.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(["repo_not_cached", "pr_not_cached"]));
    expect(gate.conclusion).toBe("neutral");
    expect(gate.blockers).toEqual([]);
    expect(output.title).toBe("LoopOver Orb Review Agent — not evaluated yet");
    expect(output.summary).toContain("re-evaluates automatically");
    expect(output.text).toBe("LoopOver did not create a contributor-facing failure for this event.");
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

  it("redacts the terms sanitizePublicComment already caught but CHECK_RUN_FORBIDDEN_TERMS missed (#7074)", () => {
    const advisory = buildPullRequestAdvisory(repo, null);
    const gate = evaluateGateCheck(
      {
        ...advisory,
        findings: [
          {
            code: "missing_linked_issue",
            title: "Check for mnemonic and seed phrase leaks across the cohort",
            severity: "warning" as const,
            detail: "This is miner-originated, not human-originated, and touches raw trust plus the rankings.",
          },
        ],
      },
      { linkedIssueGateMode: "block" },
    );
    const output = formatGateCheckOutput(gate);

    expect(gate.conclusion).toBe("failure");
    // None of the newly-added forbidden terms may survive to the public check-run surface.
    expect(output.text).not.toMatch(/mnemonic|seed\s?phrase|cohort|originated|raw\s+trust|ranking/i);
    // The static finding scaffolding still renders, so the finding isn't silently dropped.
    expect(output.text).toContain("[context]");
  });

  it("keeps missing-issue advisory by default, honoring an explicit block mode", () => {
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
  });

  // #9129 ADVERSARIAL REGRESSION: a PR with an overlapping linked issue but NO corroborating diff overlap must
  // never produce a close, under ANY duplicatePrGateMode -- including an explicit "block", which is exactly the
  // live-exploited configuration (.loopover.yml sets `duplicates: block` on this very repo). Before this fix, an
  // attacker could cite the same issue number in a throwaway PR body (no code required) and force this exact
  // scenario to auto-close the victim's PR one-shot.
  it("#9129: an overlapping linked issue with NO diff-overlap corroboration never closes, under any duplicatePrGateMode", () => {
    const pr: PullRequestRecord = {
      repoFullName: repo.fullName,
      number: 22,
      title: "Add review panel",
      state: "open",
      authorLogin: "victim",
      authorAssociation: "NONE",
      headSha: "abc123",
      labels: [],
      linkedIssues: [44],
      // No changedFiles resolved -- the common case, since collision enrichment is scoped away from the gate's
      // own otherOpenPullRequests input by default (see hasDuplicateOverlapCorroboration's doc comment).
    };
    const attackerPr: PullRequestRecord = { ...pr, number: 23, authorLogin: "attacker", title: "Fixes the same thing" };
    const duplicateAdvisory = buildPullRequestAdvisory(repo, pr, { otherOpenPullRequests: [attackerPr] });

    expect(duplicateAdvisory.findings.map((finding) => finding.code)).toContain("duplicate_pr_risk_unconfirmed");
    expect(duplicateAdvisory.findings.map((finding) => finding.code)).not.toContain("duplicate_pr_risk");
    for (const duplicatePrGateMode of ["advisory", "off", "block"] as const) {
      const gate = evaluateGateCheck(duplicateAdvisory, { duplicatePrGateMode });
      expect(gate.conclusion).toBe("success");
      expect(gate.blockers).toEqual([]);
    }
  });

  // #9129: once corroborated (a real changed-file overlap), the finding stays configurable via
  // duplicatePrGateMode -- but "block" now HOLDS (neutral) rather than closing, matching the requirement to
  // "prefer holding BOTH over closing either automatically". The new code-level default (unset ⇒ "advisory")
  // never even holds; a maintainer must opt in to "block" to get the hold behavior at all.
  it("#9129: a CORROBORATED duplicate overlap stays advisory by default, and HOLDS (never closes) under an explicit block mode", () => {
    const pr: PullRequestRecord = {
      repoFullName: repo.fullName,
      number: 22,
      title: "Add review panel",
      state: "open",
      authorLogin: "someone",
      authorAssociation: "NONE",
      headSha: "abc123",
      labels: [],
      linkedIssues: [44],
      changedFiles: ["src/panel.ts"],
    };
    const sibling: PullRequestRecord = { ...pr, number: 23, changedFiles: ["src/panel.ts"] };
    const duplicateAdvisory = buildPullRequestAdvisory(repo, pr, { otherOpenPullRequests: [sibling] });

    expect(duplicateAdvisory.findings.map((finding) => finding.code)).toContain("duplicate_pr_risk");

    // Code-level default (unset) is now "advisory" (#9129, was "block") -- never blocks, never holds.
    expect(evaluateGateCheck(duplicateAdvisory).conclusion).toBe("success");
    expect(evaluateGateCheck(duplicateAdvisory, { duplicatePrGateMode: "advisory" }).conclusion).toBe("success");
    expect(evaluateGateCheck(duplicateAdvisory, { duplicatePrGateMode: "off" }).conclusion).toBe("success");

    // Explicit "block" HOLDS both sides for a human instead of closing either.
    const held = evaluateGateCheck(duplicateAdvisory, { duplicatePrGateMode: "block" });
    expect(held.conclusion).toBe("neutral");
    expect(held.blockers).toEqual([]);
    expect(held.warnings.map((finding) => finding.code)).toContain("duplicate_pr_risk");
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

  describe("aiReviewLowConfidenceDisposition (#4603)", () => {
    const consensusAdvisory = (confidence: number) => ({
      ...buildPullRequestAdvisory(repo, null),
      findings: [
        {
          code: "ai_consensus_defect",
          title: "AI reviewers agree on a likely critical defect",
          severity: "critical" as const,
          detail: "Both reviewers flagged the same blocker.",
          confidence,
        },
      ],
    });
    const belowFloor = DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE - 0.1;
    const atFloor = DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE;

    it("acceptance (4): at-or-above-floor confidence blocks identically across all three dispositions", () => {
      const advisory = consensusAdvisory(atFloor);
      for (const disposition of ["one_shot", "hold_for_review", "advisory_only"] as const) {
        expect(evaluateGateCheck(advisory, { aiReviewGateMode: "block", aiReviewLowConfidenceDisposition: disposition }).conclusion).toBe("failure");
      }
    });

    it("acceptance (2): sub-floor + one_shot closes exactly like today (still a blocker)", () => {
      const advisory = consensusAdvisory(belowFloor);
      expect(evaluateGateCheck(advisory, { aiReviewGateMode: "block", aiReviewLowConfidenceDisposition: "one_shot" }).conclusion).toBe("failure");
    });

    it("sub-floor + hold_for_review (default, explicit or unset) still blocks the gate — the hold is downstream", () => {
      const advisory = consensusAdvisory(belowFloor);
      expect(evaluateGateCheck(advisory, { aiReviewGateMode: "block", aiReviewLowConfidenceDisposition: "hold_for_review" }).conclusion).toBe("failure");
      // Unset ⇒ hold_for_review is the default.
      expect(evaluateGateCheck(advisory, { aiReviewGateMode: "block" }).conclusion).toBe("failure");
    });

    it("acceptance (3): sub-floor + advisory_only drops the finding to fully non-blocking", () => {
      const advisory = consensusAdvisory(belowFloor);
      const evaluation = evaluateGateCheck(advisory, { aiReviewGateMode: "block", aiReviewLowConfidenceDisposition: "advisory_only" });
      expect(evaluation.conclusion).toBe("success");
      expect(evaluation.blockers).toHaveLength(0);
    });

    it("advisory_only respects a custom aiReviewCloseConfidence floor, not just the 0.93 default", () => {
      const advisory = consensusAdvisory(0.5);
      // 0.5 is below a custom 0.6 floor ⇒ non-blocking.
      expect(evaluateGateCheck(advisory, { aiReviewGateMode: "block", aiReviewLowConfidenceDisposition: "advisory_only", aiReviewCloseConfidence: 0.6 }).conclusion).toBe("success");
      // 0.5 clears a custom 0.4 floor ⇒ still blocks.
      expect(evaluateGateCheck(advisory, { aiReviewGateMode: "block", aiReviewLowConfidenceDisposition: "advisory_only", aiReviewCloseConfidence: 0.4 }).conclusion).toBe("failure");
    });

    // #9085: an absent confidence used to degrade to 1.0 (maximum certainty) here -- "the model said nothing"
    // silently cleared even a custom close-confidence floor. It now degrades to CONFIDENCE_WHEN_UNSTATED
    // (0.5), which sits BELOW the 0.93 default floor, so `advisory_only` now correctly treats a sub-floor
    // absent confidence the same as any other sub-floor confidence: non-blocking.
    it("an absent confidence degrades to CONFIDENCE_WHEN_UNSTATED (0.5) — sub-floor, matching any other sub-floor confidence", () => {
      const advisory = {
        ...buildPullRequestAdvisory(repo, null),
        findings: [{ code: "ai_consensus_defect", title: "t", severity: "critical" as const, detail: "d" }],
      };
      expect(evaluateGateCheck(advisory, { aiReviewGateMode: "block", aiReviewLowConfidenceDisposition: "advisory_only" }).conclusion).toBe("success");
    });

    it("aiReviewGateMode !== block stays non-blocking regardless of disposition (unchanged from today)", () => {
      const advisory = consensusAdvisory(belowFloor);
      for (const disposition of ["one_shot", "hold_for_review", "advisory_only"] as const) {
        expect(evaluateGateCheck(advisory, { aiReviewGateMode: "advisory", aiReviewLowConfidenceDisposition: disposition }).conclusion).toBe("success");
      }
    });
  });

  describe("resolveAiReviewLowConfidenceHold (#4603)", () => {
    const finding = (code: string, confidence?: number): import("../../src/types").AdvisoryFinding => ({
      code,
      severity: "critical",
      title: `t:${code}`,
      detail: `d:${code}`,
      ...(confidence !== undefined ? { confidence } : {}),
    });
    const failure = (findings: import("../../src/types").AdvisoryFinding[]): import("../../src/rules/advisory").GateCheckEvaluation => ({
      enabled: true,
      conclusion: "failure",
      title: "LoopOver Orb Review Agent: blocked",
      summary: "A hard blocker was found.",
      blockers: findings,
      warnings: [],
    });
    const belowFloor = DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE - 0.1;
    const atFloor = DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE;

    it("#8849: the hold names its floor's SOURCE — calibrated risk-control threshold vs configured floor", () => {
      const evaluation = failure([finding("ai_consensus_defect", belowFloor)]);
      const calibrated = resolveAiReviewLowConfidenceHold(evaluation, { aiReviewCloseConfidenceCalibrated: true });
      expect(calibrated?.reason).toContain("calibrated risk-control threshold");
      const configured = resolveAiReviewLowConfidenceHold(evaluation, { aiReviewCloseConfidenceCalibrated: false });
      expect(configured?.reason).toContain("configured close-confidence floor");
    });

    it("acceptance (1): sub-floor consensus defect + hold_for_review (default) → returns the hold", () => {
      const evaluation = failure([finding("ai_consensus_defect", belowFloor)]);
      const hold = resolveAiReviewLowConfidenceHold(evaluation, {});
      expect(hold).toBeDefined();
      expect(hold?.reason).toContain("confidence");
      expect(hold?.comment.length).toBeGreaterThan(0);
      // Explicit hold_for_review is identical to the unset default.
      expect(resolveAiReviewLowConfidenceHold(evaluation, { aiReviewLowConfidenceDisposition: "hold_for_review" })).toEqual(hold);
    });

    it("acceptance (2): sub-floor + one_shot → no hold (closes exactly like today)", () => {
      const evaluation = failure([finding("ai_consensus_defect", belowFloor)]);
      expect(resolveAiReviewLowConfidenceHold(evaluation, { aiReviewLowConfidenceDisposition: "one_shot" })).toBeUndefined();
    });

    it("acceptance (3): sub-floor + advisory_only → no hold (the finding is non-blocking, not held)", () => {
      const evaluation = failure([finding("ai_consensus_defect", belowFloor)]);
      expect(resolveAiReviewLowConfidenceHold(evaluation, { aiReviewLowConfidenceDisposition: "advisory_only" })).toBeUndefined();
    });

    it("acceptance (4): at-or-above-floor confidence → no hold across every disposition (nothing to hold)", () => {
      const evaluation = failure([finding("ai_consensus_defect", atFloor)]);
      for (const disposition of ["one_shot", "hold_for_review", "advisory_only"] as const) {
        expect(resolveAiReviewLowConfidenceHold(evaluation, { aiReviewLowConfidenceDisposition: disposition })).toBeUndefined();
      }
    });

    it("respects a custom aiReviewCloseConfidence floor", () => {
      const evaluation = failure([finding("ai_consensus_defect", 0.5)]);
      expect(resolveAiReviewLowConfidenceHold(evaluation, { aiReviewCloseConfidence: 0.6 })).toBeDefined();
      expect(resolveAiReviewLowConfidenceHold(evaluation, { aiReviewCloseConfidence: 0.4 })).toBeUndefined();
    });

    it("never holds a mixed failure — a genuinely different blocker alongside the AI defect must still close", () => {
      const evaluation = failure([finding("ai_consensus_defect", belowFloor), finding("secret_leak")]);
      expect(resolveAiReviewLowConfidenceHold(evaluation, {})).toBeUndefined();
    });

    it("applies to ai_review_split exactly like a consensus defect", () => {
      const evaluation = failure([finding("ai_review_split", belowFloor)]);
      expect(resolveAiReviewLowConfidenceHold(evaluation, {})).toBeDefined();
    });

    // #9085: an absent confidence used to degrade to 1.0 (never below the default 0.93 floor, so it never
    // held). It now degrades to CONFIDENCE_WHEN_UNSTATED (0.5) -- below the floor -- so the default
    // `hold_for_review` disposition correctly holds it, the same as any other sub-floor confidence.
    it("an absent confidence degrades to CONFIDENCE_WHEN_UNSTATED (0.5) — sub-floor, so it holds under the default disposition", () => {
      const evaluation = failure([finding("ai_consensus_defect")]);
      expect(resolveAiReviewLowConfidenceHold(evaluation, {})).toBeDefined();
    });

    it("never holds a non-failure conclusion or an empty blocker list", () => {
      const evaluation = failure([finding("ai_consensus_defect", belowFloor)]);
      expect(resolveAiReviewLowConfidenceHold({ ...evaluation, conclusion: "success" }, {})).toBeUndefined();
      expect(resolveAiReviewLowConfidenceHold({ ...evaluation, blockers: [] }, {})).toBeUndefined();
    });
  });

  it("keeps readiness score advisory even when legacy config says block", () => {
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

    const advisoryGate = evaluateGateCheck(advisory, { qualityGateMode: "block", qualityGateMinScore: 90, readinessScore: 89.4 });

    expect(advisoryGate.conclusion).toBe("success");
    expect(advisoryGate.blockers).toEqual([]);
    expect(advisoryGate.warnings.map((finding) => finding.code)).toEqual(["readiness_score_below_threshold"]);
    expect(formatGateCheckOutput(advisoryGate).text).not.toContain("Readiness score is below the configured threshold");

    expect(evaluateGateCheck(advisory, { qualityGateMode: "block", qualityGateMinScore: 101, readinessScore: -5 }).warnings[0]?.detail).toContain("0/100");
    expect(evaluateGateCheck(advisory, { qualityGateMode: "block", qualityGateMinScore: 99, readinessScore: 102 }).conclusion).toBe("success");
    expect(evaluateGateCheck(advisory, { qualityGateMode: "block", qualityGateMinScore: Number.NaN, readinessScore: 10 }).conclusion).toBe("success");
    expect(evaluateGateCheck(advisory, { mergeReadinessGateMode: "block", qualityGateMinScore: 90, readinessScore: 10 }).conclusion).toBe("success");
  });

  describe("#9167: merge-readiness composite fill-unset-only semantics + fail-closed gate modes", () => {
    // Deliberately NOT duplicate_pr_risk (#9129's duplicate-only HOLD reuses that exact code as its trigger,
    // so a blocker set consisting solely of it always resolves "neutral", never "failure" -- missing_linked_issue
    // has no such special-cased hold and cleanly exercises the plain failure path these tests need).
    const missingLinkedIssueAdvisory = {
      ...buildPullRequestAdvisory(repo, null),
      findings: [{ code: "missing_linked_issue", title: "No linked issue detected", severity: "warning" as const, detail: "No linked issue." }],
    };

    // #9167 considered making the composite only FILL IN a sub-gate mode left unset, so an explicit
    // "block" could never be silently demoted by a looser composite. That's unreachable in practice: every
    // sub-gate mode is already a concrete, DB-defaulted value (RepositorySettings's linkedIssueGateMode/etc.
    // are non-optional) by the time it reaches GateCheckPolicy, so "explicitly authored" vs. "resolved to
    // the shipped default" can't be told apart here -- the composite keeps its original override behavior,
    // and the demotion is now made VISIBLE via config-lint.ts's mergeReadinessCompositeWarnings instead
    // (which operates on the raw, pre-default manifest, where "unset" is a real, meaningful state).
    it("demotes an explicitly-configured block sub-gate to the composite's looser mode (the demotion is now surfaced via a config-lint warning, not prevented here)", () => {
      const gate = evaluateGateCheck(missingLinkedIssueAdvisory, { mergeReadinessGateMode: "advisory", linkedIssueGateMode: "block" });
      expect(gate.conclusion).toBe("success");
      expect(gate.blockers).toEqual([]);
    });

    it("fills in a sub-gate mode the operator left unset", () => {
      const gate = evaluateGateCheck(missingLinkedIssueAdvisory, { mergeReadinessGateMode: "block" });
      expect(gate.conclusion).toBe("failure");
      expect(gate.blockers.map((finding) => finding.code)).toContain("missing_linked_issue");
    });

    it("escalates an explicit looser sub-gate mode (advisory) when the composite is stricter", () => {
      const gate = evaluateGateCheck(missingLinkedIssueAdvisory, { mergeReadinessGateMode: "block", linkedIssueGateMode: "advisory" });
      expect(gate.conclusion).toBe("failure");
      expect(gate.blockers.map((finding) => finding.code)).toContain("missing_linked_issue");
    });

    it("a merge-readiness composite of off leaves sub-gates exactly as configured (no-op)", () => {
      const gate = evaluateGateCheck(missingLinkedIssueAdvisory, { mergeReadinessGateMode: "off", linkedIssueGateMode: "block" });
      expect(gate.conclusion).toBe("failure");
    });

    it("an unrecognized configured gate mode fails CLOSED (blocks) instead of defaulting to advisory", () => {
      // Simulates a malformed value bypassing GateRuleMode's compile-time union (e.g. an untyped config
      // path) -- gateMode() used to coerce this to "advisory" (fail-open); it must now fail closed.
      const gate = evaluateGateCheck(missingLinkedIssueAdvisory, {
        linkedIssueGateMode: "blocc" as unknown as "block",
      });
      expect(gate.conclusion).toBe("failure");
      expect(gate.blockers.map((finding) => finding.code)).toContain("missing_linked_issue");
    });

    it("the three real gate modes (off/advisory/block) still resolve unchanged through gateMode()", () => {
      expect(evaluateGateCheck(missingLinkedIssueAdvisory, { linkedIssueGateMode: "off" }).conclusion).toBe("success");
      expect(evaluateGateCheck(missingLinkedIssueAdvisory, { linkedIssueGateMode: "advisory" }).conclusion).toBe("success");
      expect(evaluateGateCheck(missingLinkedIssueAdvisory, { linkedIssueGateMode: "block" }).conclusion).toBe("failure");
    });
  });

  it("summarizes multiple configured hard blockers without swallowing advisory warnings", () => {
    const gate = evaluateGateCheck(
      {
        ...buildPullRequestAdvisory(repo, null),
        findings: [
          { code: "missing_linked_issue", title: "No linked issue detected", severity: "warning", detail: "No linked issue." },
          { code: "duplicate_pr_risk", title: "Linked issue overlaps another open PR", severity: "warning", detail: "Duplicate." },
          { code: "busy_pr_queue", title: "Review queue is busy", severity: "warning", detail: "Queue context." },
        ],
      },
      { linkedIssueGateMode: "block", duplicatePrGateMode: "block", qualityGateMode: "block", qualityGateMinScore: 90, readinessScore: 42 },
    );

    expect(gate.conclusion).toBe("failure");
    // Title names the blocker count; summary enumerates every active blocker with its fix.
    expect(gate.title).toBe("LoopOver Orb Review Agent: 2 blockers");
    expect(gate.summary).toContain("No linked issue detected");
    expect(gate.summary).toContain("Linked issue overlaps another open PR");
    expect(gate.summary).not.toContain("Readiness score is below the configured threshold");
    expect(gate.blockers.map((finding) => finding.code)).toEqual(["missing_linked_issue", "duplicate_pr_risk"]);
    expect(gate.warnings.map((finding) => finding.code)).toEqual(["busy_pr_queue", "readiness_score_below_threshold"]);
  });

  it("gates NON-confirmed contributors normally — a real blocker closes them like a confirmed author (#gate-nonconfirmed)", () => {
    // Uses missing_linked_issue (not duplicate_pr_risk, #9129): a duplicate-only blocker set now HOLDS instead of
    // closing regardless of confirmed-contributor status, which would confound this test's actual subject (that
    // confirmed-status itself has no effect on the verdict) with the unrelated duplicate-only hold behavior.
    const blockingAdvisory = {
      ...buildPullRequestAdvisory(repo, null),
      findings: [{ code: "missing_linked_issue", title: "No linked issue detected", severity: "warning" as const, detail: "No linked issue." }],
    };

    // Non-confirmed author: gated NORMALLY now — a real blocker → failure (one-shot close), no longer forced to a
    // neutral/held state. Confirmed-status affects only on-chain scoring, never the gate verdict. (#gate-nonconfirmed)
    const nonConfirmed = evaluateGateCheck(blockingAdvisory, { linkedIssueGateMode: "block", confirmedContributor: false });
    expect(nonConfirmed.conclusion).toBe("failure");
    expect(nonConfirmed.title).toBe("LoopOver Orb Review Agent: No linked issue detected");
    expect(nonConfirmed.blockers.map((finding) => finding.code)).toEqual(["missing_linked_issue"]);

    // Confirmed author with the same blocker: identical verdict.
    const confirmed = evaluateGateCheck(blockingAdvisory, { linkedIssueGateMode: "block", confirmedContributor: true });
    expect(confirmed.conclusion).toBe("failure");
    expect(confirmed.blockers.map((finding) => finding.code)).toEqual(["missing_linked_issue"]);

    // A clean PR from a non-confirmed author is a normal success → auto-merges.
    const cleanNonConfirmed = evaluateGateCheck({ ...buildPullRequestAdvisory(repo, null), findings: [] }, { confirmedContributor: false });
    expect(cleanNonConfirmed.conclusion).toBe("success");
  });

  it("formats skipped and neutral Gate outputs as non-failures", () => {
    for (const conclusion of ["neutral", "skipped"] as const) {
      const output = formatGateCheckOutput({
        enabled: true,
        conclusion,
        title: conclusion === "skipped" ? "LoopOver Orb Review Agent skipped" : "LoopOver Orb Review Agent neutral",
        summary: "PR closed before full evaluation.",
        blockers: [],
        warnings: [],
      });

      expect(output.summary).toBe("PR closed before full evaluation.");
      expect(output.text).toBe("LoopOver did not create a contributor-facing failure for this event.");
    }
  });

  it("keeps defensive gate output fallback public-safe", () => {
    const output = formatGateCheckOutput({
      enabled: true,
      conclusion: "failure",
      title: "LoopOver Orb Review Agent is blocking merge",
      summary: "A configured merge-blocking issue was found.",
      blockers: [],
      warnings: [],
    });

    expect(output.text).toBe("A configured hard blocker was found.");
    expect(output.text).not.toMatch(/reward|wallet|hotkey|trust score|payout|farming/i);
  });

  it("discloses how many configured blockers were omitted past the inline cap (#8323)", () => {
    const blockers = Array.from({ length: 11 }, (_, i) => ({
      code: `configured_blocker_${i}`,
      title: `Configured blocker ${i}`,
      severity: "warning" as const,
      detail: `detail ${i}`,
    }));
    const output = formatGateCheckOutput({
      enabled: true,
      conclusion: "failure",
      title: "LoopOver Orb Review Agent is blocking merge",
      summary: "A configured merge-blocking issue was found.",
      blockers,
      warnings: [],
    });

    // Only the first 8 blocker lines are inlined, and the overflow (11 - 8 = 3) is disclosed, not silently dropped.
    expect(output.text.match(/^- Configured blocker/gm)).toHaveLength(8);
    expect(output.text).toContain("…3 more configured blocker(s) omitted from inline check output.");
  });

  it("does not add an omission-disclosure line when blockers are at or under the inline cap (#8323)", () => {
    for (const count of [1, 8]) {
      const blockers = Array.from({ length: count }, (_, i) => ({
        code: `configured_blocker_${i}`,
        title: `Configured blocker ${i}`,
        severity: "warning" as const,
        detail: `detail ${i}`,
      }));
      const output = formatGateCheckOutput({
        enabled: true,
        conclusion: "failure",
        title: "LoopOver Orb Review Agent is blocking merge",
        summary: "A configured merge-blocking issue was found.",
        blockers,
        warnings: [],
      });

      expect(output.text.match(/^- Configured blocker/gm), `count ${count}`).toHaveLength(count);
      expect(output.text, `count ${count}`).not.toContain("omitted from inline check output");
    }
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
    expect(output.title).toBe("LoopOver context checked");
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

  it("matches configured label multipliers case-insensitively and with glob patterns", () => {
    const repoWithPatterns: RepositoryRecord = {
      ...repo,
      registryConfig: {
        ...repo.registryConfig!,
        labelMultipliers: { feature: 1.5, "type:*": 1.2 },
      },
    };
    const caseMismatch = buildPullRequestAdvisory(repoWithPatterns, {
      repoFullName: repo.fullName,
      number: 16,
      title: "Feature work",
      state: "open",
      authorLogin: "miner1",
      authorAssociation: "NONE",
      labels: ["Feature"],
      linkedIssues: [7],
    });
    expect(caseMismatch.findings.some((finding) => finding.code === "label_context_found")).toBe(true);

    const globMatch = buildPullRequestAdvisory(repoWithPatterns, {
      repoFullName: repo.fullName,
      number: 17,
      title: "Bug fix",
      state: "open",
      authorLogin: "miner1",
      authorAssociation: "NONE",
      labels: ["type:bug-fix"],
      linkedIssues: [7],
    });
    expect(globMatch.findings.some((finding) => finding.code === "label_context_found")).toBe(true);

    const noMatch = buildPullRequestAdvisory(repoWithPatterns, {
      repoFullName: repo.fullName,
      number: 18,
      title: "Docs only",
      state: "open",
      authorLogin: "miner1",
      authorAssociation: "NONE",
      labels: ["docs"],
      linkedIssues: [7],
    });
    expect(noMatch.findings.some((finding) => finding.code === "label_context_found")).toBe(false);
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
    for (const level of ["minimal", "standard"] as const) {
      const out = formatCheckRunOutput(poisoned, level);
      expect(out.title).not.toMatch(/rewards?|wallets?|hotkeys?|trust score|score estimate|reviewability|scoreability|farming/i);
      expect(out.summary).not.toMatch(/rewards?|wallets?|hotkeys?|trust score|score estimate|reviewability|scoreability|farming/i);
      expect(out.text).not.toMatch(/rewards?|wallets?|hotkeys?|trust score|score estimate|reviewability|scoreability|farming/i);
    }
  });

  // #7981: a fixed, engineer-authored finding message (e.g. the content lane's deterministic secret-detection
  // text) must render verbatim in the check-run output when it declares alreadyPublicSafe, instead of having a
  // static word like "wallet" mangled into the confusing "[context]" placeholder.
  it("formatCheckRunOutput does NOT sanitize a finding's publicText when alreadyPublicSafe is set", () => {
    const advisory = buildPullRequestAdvisory(repo, null);
    const alreadySafe = {
      ...advisory,
      findings: [
        {
          code: "surface_lane_reject",
          title: "Registry surface review",
          severity: "critical" as const,
          detail: "Subnet document appears to include secret, wallet, PAT, or private-key material.",
          publicText: "Subnet document appears to include secret, wallet, PAT, or private-key material.",
          alreadyPublicSafe: true,
        },
      ],
    };
    const out = formatCheckRunOutput(alreadySafe, "standard");
    expect(out.text).toContain("Subnet document appears to include secret, wallet, PAT, or private-key material.");
    expect(out.text).not.toContain("[context]");
  });

  // #8321: the SAME finding is also rendered as an inline annotation, and buildCheckRunAnnotations used to
  // scrub it unconditionally -- so one PR showed the message verbatim in the check-run text but mangled in the
  // annotation. These two pin both arms of the flag on the annotation path.
  describe("buildCheckRunAnnotations honors alreadyPublicSafe (#8321)", () => {
    const SAFE_TEXT = "Subnet document appears to include secret, wallet, PAT, or private-key material.";
    const annotationsFor = (alreadyPublicSafe: boolean) => {
      const advisory = buildPullRequestAdvisory(repo, {
        repoFullName: repo.fullName, number: 31, title: "Add lane doc", state: "open",
        authorLogin: "contributor", authorAssociation: "NONE", labels: [], linkedIssues: [],
      });
      const files: PullRequestFileRecord[] = [
        { repoFullName: repo.fullName, pullNumber: 31, path: "src/lane/doc.ts", additions: 5, deletions: 0, changes: 5, payload: {} },
      ];
      const collisions: CollisionReport = {
        repoFullName: repo.fullName, generatedAt: "2026-06-10T00:00:00.000Z",
        summary: { clusterCount: 0, highRiskCount: 0, itemsReviewed: 0 }, clusters: [],
      };
      const withFinding = {
        ...advisory,
        findings: [
          {
            code: "surface_lane_reject",
            title: "Registry surface review",
            severity: "critical" as const,
            detail: SAFE_TEXT,
            publicText: SAFE_TEXT,
            ...(alreadyPublicSafe ? { alreadyPublicSafe: true } : {}),
          },
        ],
      };
      return buildCheckRunAnnotations(withFinding, { files, collisions, pullNumber: 31 }, "standard").annotations;
    };

    it("renders an alreadyPublicSafe message verbatim, matching formatCheckRunOutput", () => {
      const entry = annotationsFor(true).find((a) => a.title === "Registry surface review");
      expect(entry, "expected an annotation for the finding").toBeTruthy();
      expect(entry!.message).toBe(SAFE_TEXT);
      expect(entry!.message).not.toContain("[context]");
    });

    it("still sanitizes the message when alreadyPublicSafe is absent (unchanged behavior)", () => {
      const entry = annotationsFor(false).find((a) => a.title === "Registry surface review");
      expect(entry, "expected an annotation for the finding").toBeTruthy();
      expect(entry!.message).toContain("[context]");
      expect(entry!.message).not.toBe(SAFE_TEXT);
    });
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
      "standard",
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
    expect(output.title).toBe("LoopOver context posted");
    expect(output.text).toContain("No detailed findings are published");
    expect(output.text).not.toContain("Critical finding");
  });

  // #9085: severity is otherwise decorative -- a `warning`-labeled finding can be the exact reason the gate
  // closed the PR, while a `critical`-labeled one (e.g. ai_consensus_defect under the advisory-only default)
  // can have no gate effect at all. `blockerCodes` -- the real blocker codes from this SAME advisory's
  // GateCheckEvaluation, when the caller has one -- lets the public check-run text correct for that.
  describe("formatCheckRunOutput blockerCodes (#9085)", () => {
    const advisory = buildPullRequestAdvisory(null, null);
    const withFindings = (findings: import("../../src/types").AdvisoryFinding[]) => ({ ...advisory, findings });

    it("omitting blockerCodes preserves today's exact two-icon rendering (byte-identical for every existing caller)", () => {
      const output = formatCheckRunOutput(
        withFindings([
          { code: "missing_linked_issue", title: "t", severity: "warning", detail: "d", publicText: "warn text" },
          { code: "ai_consensus_defect", title: "t", severity: "critical", detail: "d", publicText: "critical text" },
        ]),
        "standard",
      );
      expect(output.text).toBe("⚠️ warn text\nℹ️ critical text");
    });

    it("a warning-labeled finding that IS an actual blocker in this evaluation renders with the most alarming icon", () => {
      const output = formatCheckRunOutput(
        withFindings([{ code: "missing_linked_issue", title: "t", severity: "warning", detail: "d", publicText: "warn text" }]),
        "standard",
        undefined,
        new Set(["missing_linked_issue"]),
      );
      expect(output.text).toBe("🚫 warn text");
    });

    it("a critical-labeled finding that is NOT actually blocking is capped at the warning icon, never crying wolf", () => {
      const output = formatCheckRunOutput(
        withFindings([{ code: "ai_consensus_defect", title: "t", severity: "critical", detail: "d", publicText: "critical text" }]),
        "standard",
        undefined,
        new Set(), // no real blockers in this evaluation
      );
      expect(output.text).toBe("⚠️ critical text");
    });

    it("an info-labeled finding stays info even when blockerCodes is provided and it isn't a blocker", () => {
      const output = formatCheckRunOutput(
        withFindings([{ code: "some_info_code", title: "t", severity: "info", detail: "d", publicText: "info text" }]),
        "standard",
        undefined,
        new Set(),
      );
      expect(output.text).toBe("ℹ️ info text");
    });
  });

  describe("buildCheckRunAnnotations blockerCodes (#9085)", () => {
    const repoForAnnotations: RepositoryRecord = repo;
    const files: PullRequestFileRecord[] = [
      { repoFullName: repo.fullName, pullNumber: 50, path: "src/a.ts", additions: 3, deletions: 0, changes: 3, payload: {} },
    ];

    it("a non-blocker finding still maps to its own authored annotation level when blockerCodes is provided", () => {
      const advisory = {
        ...buildPullRequestAdvisory(repoForAnnotations, null),
        findings: [{ code: "some_warning_code", title: "t", severity: "warning" as const, detail: "d", publicText: "warn text" }],
      };
      const { annotations } = buildCheckRunAnnotations(advisory, { files, collisions: emptyCollisions(), pullNumber: 50 }, "standard", new Set());
      expect(annotations.find((a) => a.message === "warn text")?.annotation_level).toBe("warning");
    });

    it("a finding that IS an actual blocker in this evaluation always maps to 'failure', regardless of its authored severity", () => {
      const advisory = {
        ...buildPullRequestAdvisory(repoForAnnotations, null),
        findings: [{ code: "missing_linked_issue", title: "t", severity: "warning" as const, detail: "d", publicText: "warn text" }],
      };
      const { annotations } = buildCheckRunAnnotations(
        advisory,
        { files, collisions: emptyCollisions(), pullNumber: 50 },
        "standard",
        new Set(["missing_linked_issue"]),
      );
      expect(annotations.find((a) => a.message === "warn text")?.annotation_level).toBe("failure");
    });
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

  it("does not flag Missing test evidence when a Cypress/e2e test accompanies a code change (regression)", () => {
    // isTestPath now delegates to the canonical src/signals/test-evidence matcher, which recognizes
    // *.cy./*.e2e./__snapshots__/_spec.rb tests. A stale local copy dropped those branches, so a code
    // change shipped with only a Cypress test was wrongly annotated "Missing test evidence".
    const advisory = buildPullRequestAdvisory(repo, {
      repoFullName: repo.fullName,
      number: 20,
      title: "Guard the login route with a Cypress test",
      state: "open",
      authorLogin: "contributor",
      authorAssociation: "NONE",
      labels: [],
      linkedIssues: [],
    });
    const files: PullRequestFileRecord[] = [
      { repoFullName: repo.fullName, pullNumber: 20, path: "src/auth/login.ts", additions: 20, deletions: 0, changes: 20, payload: {} },
      { repoFullName: repo.fullName, pullNumber: 20, path: "cypress/e2e/login.cy.ts", additions: 30, deletions: 0, changes: 30, payload: {} },
    ];
    const collisions: CollisionReport = {
      repoFullName: repo.fullName,
      generatedAt: "2026-06-10T00:00:00.000Z",
      summary: { clusterCount: 0, highRiskCount: 0, itemsReviewed: 0 },
      clusters: [],
    };

    const { annotations } = buildCheckRunAnnotations(advisory, { files, collisions, pullNumber: 20 }, "standard");

    expect(annotations.some((entry) => entry.title === "Missing test evidence")).toBe(false);
  });

  it("does not flag Missing test evidence for a docs-/config-/manifest-only PR (#2722 class)", () => {
    // annotatableFiles is gated by isCodePath, which admits docs/config/data (.md/.yaml/.yml/.json/.toml). Using
    // `!isTestPath` as "code" wrongly flagged those files "Missing test evidence"; isCodeFile counts only genuine
    // source, so a README/CI-config/manifest-only PR (nothing to cover) is no longer annotated.
    const advisory = buildPullRequestAdvisory(repo, {
      repoFullName: repo.fullName, number: 21, title: "Update docs and CI config", state: "open",
      authorLogin: "contributor", authorAssociation: "NONE", labels: [], linkedIssues: [],
    });
    const files: PullRequestFileRecord[] = [
      { repoFullName: repo.fullName, pullNumber: 21, path: "README.md", additions: 12, deletions: 0, changes: 12, payload: {} },
      { repoFullName: repo.fullName, pullNumber: 21, path: ".github/workflows/ci.yml", additions: 8, deletions: 0, changes: 8, payload: {} },
      { repoFullName: repo.fullName, pullNumber: 21, path: "package.json", additions: 3, deletions: 0, changes: 3, payload: {} },
    ];
    const collisions: CollisionReport = {
      repoFullName: repo.fullName, generatedAt: "2026-06-10T00:00:00.000Z",
      summary: { clusterCount: 0, highRiskCount: 0, itemsReviewed: 0 }, clusters: [],
    };

    const { annotations } = buildCheckRunAnnotations(advisory, { files, collisions, pullNumber: 21 }, "standard");

    expect(annotations.some((entry) => entry.title === "Missing test evidence")).toBe(false);
  });

  it("still flags Missing test evidence for genuine source changes shipped without a test (control)", () => {
    const advisory = buildPullRequestAdvisory(repo, {
      repoFullName: repo.fullName, number: 22, title: "Add source without tests", state: "open",
      authorLogin: "contributor", authorAssociation: "NONE", labels: [], linkedIssues: [],
    });
    const sourcePaths = ["src/util/math.ts", "src/native/add.c", "src/native/add.cpp", "include/native/add.h", "src/objc/View.m"];
    const files: PullRequestFileRecord[] = sourcePaths.map((path) => ({
      repoFullName: repo.fullName, pullNumber: 22, path, additions: 15, deletions: 0, changes: 15, payload: {},
    }));
    const collisions: CollisionReport = {
      repoFullName: repo.fullName, generatedAt: "2026-06-10T00:00:00.000Z",
      summary: { clusterCount: 0, highRiskCount: 0, itemsReviewed: 0 }, clusters: [],
    };

    const { annotations } = buildCheckRunAnnotations(advisory, { files, collisions, pullNumber: 22 }, "standard");

    for (const path of sourcePaths) {
      expect(annotations.some((entry) => entry.title === "Missing test evidence" && entry.path === path)).toBe(true);
    }
  });

  it("flags Missing test evidence for Vue/Svelte/Astro source via isCodePath + isCodeFile parity", () => {
    // Regression: isCodeFile was updated but advisory.ts isCodePath still excluded .vue/.svelte/.astro,
    // so buildCheckRunAnnotations filtered those files out of annotatableFiles before missing_tests ran.
    const advisory = buildPullRequestAdvisory(repo, {
      repoFullName: repo.fullName, number: 23, title: "Add Svelte component without tests", state: "open",
      authorLogin: "contributor", authorAssociation: "NONE", labels: [], linkedIssues: [],
    });
    const sourcePaths = ["src/App.vue", "src/Widget.svelte", "src/pages/index.astro"];
    const files: PullRequestFileRecord[] = sourcePaths.map((path) => ({
      repoFullName: repo.fullName, pullNumber: 23, path, additions: 12, deletions: 0, changes: 12, payload: {},
    }));
    const collisions: CollisionReport = {
      repoFullName: repo.fullName, generatedAt: "2026-06-10T00:00:00.000Z",
      summary: { clusterCount: 0, highRiskCount: 0, itemsReviewed: 0 }, clusters: [],
    };

    const { annotations } = buildCheckRunAnnotations(advisory, { files, collisions, pullNumber: 23 }, "standard");

    for (const path of sourcePaths) {
      expect(annotations.some((entry) => entry.title === "Missing test evidence" && entry.path === path)).toBe(true);
    }
  });

  it("flags Missing test evidence for .cc/.hpp C++ source via isCodePath + isCodeFile parity", () => {
    const advisory = buildPullRequestAdvisory(repo, {
      repoFullName: repo.fullName, number: 24, title: "Add C++ modules without tests", state: "open",
      authorLogin: "contributor", authorAssociation: "NONE", labels: [], linkedIssues: [],
    });
    const sourcePaths = ["native/src/parser.cc", "libs/core/types.hpp"];
    const files: PullRequestFileRecord[] = sourcePaths.map((path) => ({
      repoFullName: repo.fullName, pullNumber: 24, path, additions: 10, deletions: 0, changes: 10, payload: {},
    }));
    const collisions: CollisionReport = {
      repoFullName: repo.fullName, generatedAt: "2026-06-10T00:00:00.000Z",
      summary: { clusterCount: 0, highRiskCount: 0, itemsReviewed: 0 }, clusters: [],
    };

    const { annotations } = buildCheckRunAnnotations(advisory, { files, collisions, pullNumber: 24 }, "standard");

    for (const path of sourcePaths) {
      expect(annotations.some((entry) => entry.title === "Missing test evidence" && entry.path === path)).toBe(true);
    }
  });

  it("flags Missing test evidence for Dart source via isCodePath + isCodeFile parity", () => {
    const advisory = buildPullRequestAdvisory(repo, {
      repoFullName: repo.fullName, number: 25, title: "Add Dart widget without tests", state: "open",
      authorLogin: "contributor", authorAssociation: "NONE", labels: [], linkedIssues: [],
    });
    const sourcePaths = ["lib/models/user.dart", "lib/widgets/card.dart"];
    const files: PullRequestFileRecord[] = sourcePaths.map((path) => ({
      repoFullName: repo.fullName, pullNumber: 25, path, additions: 10, deletions: 0, changes: 10, payload: {},
    }));
    const collisions: CollisionReport = {
      repoFullName: repo.fullName, generatedAt: "2026-06-10T00:00:00.000Z",
      summary: { clusterCount: 0, highRiskCount: 0, itemsReviewed: 0 }, clusters: [],
    };

    const { annotations } = buildCheckRunAnnotations(advisory, { files, collisions, pullNumber: 25 }, "standard");

    for (const path of sourcePaths) {
      expect(annotations.some((entry) => entry.title === "Missing test evidence" && entry.path === path)).toBe(true);
    }
  });

  it("flags Missing test evidence for .mts/.cts/.mjs/.cjs/.kts/.scala/.groovy via isCodePath + isCodeFile parity (#9322)", () => {
    // Regression: isCodeFile recognizes these via SOURCE_FILE_EXTENSION, but isCodePath lagged — so
    // annotatablePullRequestFiles dropped them before Missing test evidence annotations could land.
    const advisory = buildPullRequestAdvisory(repo, {
      repoFullName: repo.fullName, number: 26, title: "Add module/JVM sources without tests", state: "open",
      authorLogin: "contributor", authorAssociation: "NONE", labels: [], linkedIssues: [],
    });
    const sourcePaths = [
      "src/loader.mts",
      "src/setup.cts",
      "src/legacy.mjs",
      "src/compat.cjs",
      "build.kts",
      "src/Main.scala",
      "src/App.groovy",
    ];
    const files: PullRequestFileRecord[] = sourcePaths.map((path) => ({
      repoFullName: repo.fullName, pullNumber: 26, path, additions: 10, deletions: 0, changes: 10, payload: {},
    }));
    const collisions: CollisionReport = {
      repoFullName: repo.fullName, generatedAt: "2026-06-10T00:00:00.000Z",
      summary: { clusterCount: 0, highRiskCount: 0, itemsReviewed: 0 }, clusters: [],
    };

    const { annotations } = buildCheckRunAnnotations(advisory, { files, collisions, pullNumber: 26 }, "standard");

    for (const path of sourcePaths) {
      expect(annotations.some((entry) => entry.title === "Missing test evidence" && entry.path === path)).toBe(true);
    }
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
          publicText: "Review queue is elevated; keep changes focused.",
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

    const { annotations } = buildCheckRunAnnotations(advisory, { files, collisions, pullNumber: 15 }, "standard");
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

    const { annotations, omittedCount } = buildCheckRunAnnotations(advisory, { files, collisions, pullNumber: 99 }, "standard");
    expect(annotations).toHaveLength(CHECK_RUN_ANNOTATION_LIMIT);
    expect(omittedCount).toBe(5);

    const output = formatCheckRunOutput(advisory, "standard", { files, collisions, pullNumber: 99 });
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

describe("green-CI compatibility reconciliation of the public comment gate", () => {
  const finding = (code: string): import("../../src/types").AdvisoryFinding => ({ code, severity: "critical", title: `t:${code}`, detail: `d:${code}` });
  const failure = (codes: string[]): import("../../src/rules/advisory").GateCheckEvaluation => ({
    enabled: true,
    conclusion: "failure",
    title: "LoopOver Orb Review Agent: blocked",
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
    // An empty blocker list is not an AI-only failure.
    expect(isAiJudgmentOnlyFailure({ ...failure([]), conclusion: "failure" })).toBe(false);
    // A non-failure conclusion is never AI-only-failure.
    expect(isAiJudgmentOnlyFailure({ ...failure(["ai_consensus_defect"]), conclusion: "success" })).toBe(false);
  });

  it("isDuplicateOnlyFailure: true only when EVERY blocker is EXACTLY duplicate_pr_risk", () => {
    expect(isDuplicateOnlyFailure(failure(["duplicate_pr_risk"]))).toBe(true);
    // An empty blocker list is not a duplicate-only failure.
    expect(isDuplicateOnlyFailure({ ...failure([]), conclusion: "failure" })).toBe(false);
    // A non-failure conclusion is never a duplicate-only failure.
    expect(isDuplicateOnlyFailure({ ...failure(["duplicate_pr_risk"]), conclusion: "success" })).toBe(false);
    // A single genuinely critical blocker (e.g. a committed secret) disqualifies the whole set, mixed or alone.
    expect(isDuplicateOnlyFailure(failure(["secret_leak"]))).toBe(false);
    expect(isDuplicateOnlyFailure(failure(["duplicate_pr_risk", "secret_leak"]))).toBe(false);
    // REGRESSION: other findings are ALSO severity "warning" and ALSO block-mode-escalatable via their own
    // independent maintainer-configured gate (linkedIssueGateMode / selfAuthoredLinkedIssueGateMode /
    // manifestPolicyGateMode) — a scope-creep bug would let applySurfaceGate silently downgrade THOSE deliberate
    // block-mode opt-ins to a hold too. None of them may ever satisfy isDuplicateOnlyFailure, alone or mixed with
    // duplicate_pr_risk.
    for (const code of ["missing_linked_issue", "self_authored_linked_issue", "manifest_linked_issue_required", "manifest_missing_tests"]) {
      expect(isDuplicateOnlyFailure(failure([code]))).toBe(false);
      expect(isDuplicateOnlyFailure(failure(["duplicate_pr_risk", code]))).toBe(false);
    }
  });

  it("enabled + green CI + AI-judgment-only failure stays a failure", () => {
    const fail = failure(["ai_consensus_defect"]);
    expect(reconcileGateEvaluationForGreenCi(fail, "passed", true)).toBe(fail);
  });

  it("enabled + green CI + split-only failure stays a failure too", () => {
    const fail = failure(["ai_review_split"]);
    expect(reconcileGateEvaluationForGreenCi(fail, "passed", true)).toBe(fail);
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
    repoFullName: "JSONbored/loopover",
    generatedAt: "2026-06-10T00:00:00.000Z",
    summary: { clusterCount: 0, highRiskCount: 0, itemsReviewed: 0 },
    clusters: [],
  };
}

// #9085 taxonomy drift: both of these gate REAL closes but were absent from the signal-codes list, so their
// reversals recorded under a different id (or not at all) and the per-rule precision check in
// downgradeCloseToHold could never apply to them — the same shape as the backtest_regression omission that
// this list's own doc comment was written about.
describe("CONFIGURED_GATE_BLOCKER_SIGNAL_CODES covers every code that can close a PR (#9085)", () => {
  it("includes slop_risk_above_threshold, which is pushed directly into blockers", () => {
    expect(CONFIGURED_GATE_BLOCKER_SIGNAL_CODES).toContain("slop_risk_above_threshold");
  });

  it("includes surface_lane_reject, which is live in CONCRETE_EVIDENCE_BLOCKER_CODES", () => {
    expect(CONFIGURED_GATE_BLOCKER_SIGNAL_CODES).toContain("surface_lane_reject");
  });

  it("has no duplicate entries (a duplicate would double-record a single reversal)", () => {
    expect(new Set(CONFIGURED_GATE_BLOCKER_SIGNAL_CODES).size).toBe(CONFIGURED_GATE_BLOCKER_SIGNAL_CODES.length);
  });
});
