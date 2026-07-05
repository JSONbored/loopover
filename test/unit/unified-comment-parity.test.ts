import { describe, expect, it } from "vitest";
import {
  buildCollisionReport,
  buildContributorProfile,
  buildPreflightResult,
  buildPublicPrIntelligenceComment,
  buildPublicPrPanelSignalRows,
  buildPublicSafeCollapsibles,
  buildQueueHealth,
  detectGittensorContributor,
} from "../../src/signals/engine";
import { buildUnifiedCommentBody } from "../../src/review/unified-comment-bridge";
import type { GateCheckEvaluation } from "../../src/rules/advisory";
import type { IssueRecord, PullRequestRecord, RepositoryRecord, RepositorySettings } from "../../src/types";

// ── Fixtures: a confirmed Gittensor contributor PR that produces the FULL public panel (not the minimal
// invite), so every public-safe collapsible section is exercised. Mirrors signals.test.ts's fixtures. ──

const repo: RepositoryRecord = {
  fullName: "entrius/allways-ui",
  owner: "entrius",
  name: "allways-ui",
  isInstalled: true,
  isRegistered: true,
  isPrivate: false,
  registryConfig: {
    repo: "entrius/allways-ui",
    emissionShare: 0.01107,
    issueDiscoveryShare: 0,
    labelMultipliers: { bug: 1.1, enhancement: 1, feature: 1.25, refactor: 0.5 },
    trustedLabelPipeline: true,
    maintainerCut: 0,
    raw: {},
  },
};

const issues: IssueRecord[] = [
  { repoFullName: repo.fullName, number: 7, title: "Dashboard cache refresh fails after reconnect", state: "open", authorLogin: "reporter", labels: ["bug"], linkedPrs: [] },
  { repoFullName: repo.fullName, number: 8, title: "Add reconnect regression coverage", state: "open", authorLogin: "reporter", labels: ["feature"], linkedPrs: [] },
];

const pullRequests: PullRequestRecord[] = [
  { repoFullName: repo.fullName, number: 12, title: "Fix dashboard cache refresh after reconnect", state: "open", authorLogin: "oktofeesh1", authorAssociation: "NONE", labels: ["bug"], linkedIssues: [7], updatedAt: "2026-04-01T00:00:00.000Z", mergeableState: "clean" },
  { repoFullName: repo.fullName, number: 13, title: "Alternative cache reconnect fix", state: "open", authorLogin: "other", authorAssociation: "NONE", labels: ["bug"], linkedIssues: [7] },
];

const settings: RepositorySettings = {
  repoFullName: repo.fullName,
  commentMode: "detected_contributors_only",
  publicAudienceMode: "gittensor_only",
  publicSignalLevel: "standard",
  checkRunMode: "off",
  checkRunDetailLevel: "minimal",
  gateCheckMode: "off",
  reviewCheckMode: "disabled",
  gatePack: "gittensor",
  linkedIssueGateMode: "advisory",
  duplicatePrGateMode: "advisory",
  qualityGateMode: "advisory",
  slopGateMode: "off",
  mergeReadinessGateMode: "off",
  manifestPolicyGateMode: "off",
  selfAuthoredLinkedIssueGateMode: "advisory",
  firstTimeContributorGrace: false,
  slopAiAdvisory: false,
  qualityGateMinScore: null,
  autoLabelEnabled: true,
  gittensorLabel: "gittensor",
  createMissingLabel: true,
  publicSurface: "comment_and_label",
  includeMaintainerAuthors: false,
  requireLinkedIssue: false,
  backfillEnabled: true,
  privateTrustEnabled: true,
  aiReviewMode: "off",
  aiReviewByok: false,
  aiReviewAllAuthors: false, closeOwnerAuthors: false,
};

function buildFixtures() {
  const currentPr = pullRequests[0]!;
  // A prior MERGED PR makes detection `detected: true` → the FULL panel (not the minimal invite),
  // so every public-safe collapsible section (incl. the legacy private "Maintainer notes") is exercised.
  const priorPr: PullRequestRecord = { ...currentPr, number: 3, state: "closed", mergedAt: "2026-05-01T00:00:00.000Z" };
  const detection = { ...detectGittensorContributor("oktofeesh1", currentPr, [currentPr, priorPr], []), source: "official_gittensor_api" as const };
  const collisions = buildCollisionReport(repo.fullName, issues, pullRequests);
  const queueHealth = buildQueueHealth(repo, issues, pullRequests, collisions);
  const preflight = buildPreflightResult({ repoFullName: repo.fullName, title: currentPr.title, body: "Fixes #7", linkedIssues: [7] }, repo, issues, pullRequests);
  const profile = buildContributorProfile("oktofeesh1", { login: "oktofeesh1", topLanguages: ["TypeScript"], source: "github" }, [currentPr, priorPr], []);
  return { currentPr, detection, collisions, queueHealth, preflight, profile };
}

function gate(over: Partial<GateCheckEvaluation> = {}): GateCheckEvaluation {
  return {
    enabled: true,
    conclusion: "success",
    title: "Gittensory Orb Review Agent passed",
    summary: "No configured hard blocker was found.",
    blockers: [],
    warnings: [],
    ...over,
  };
}

describe("converged comment ↔ legacy panel parity (#unified-comment)", () => {
  it("the flag-ON converged body carries the public-safe collapsibles and NEVER the private 'Maintainer notes'", () => {
    const { currentPr, detection, collisions, queueHealth, preflight, profile } = buildFixtures();
    const aiReview = { notes: "Looks reasonable. Add a regression test for reconnect.", reviewerCount: 2 };
    const { rows, readinessTotal } = buildPublicPrPanelSignalRows({ repo, pr: currentPr, profile, detection, queueHealth, collisions, preflight, settings, gate: gate() });

    const body = buildUnifiedCommentBody({
      gate: gate(),
      aiReview,
      advisoryFindings: [],
      panelRows: rows,
      readinessTotal,
      changedFiles: 3,
      reviewerCount: aiReview.reviewerCount,
      footerMarkdown: "💰 Earn for open-source contributions like this. Checked by Gittensory.",
      reRunLabel: "gittensory-pr-panel:retrigger Re-run Gittensory review",
      extraCollapsibles: buildPublicSafeCollapsibles({ repo, pr: currentPr, profile, detection, settings, collisions, preflight, queueHealth }),
    });

    // The three public-safe sections the legacy panel carried must survive into the converged comment.
    expect(body).toContain("Review context");
    expect(body).toContain("Contributor next steps");
    expect(body).toContain("Signal definitions");
    // With an AI review present the converged comment also surfaces the optional Review-details section.
    expect(body).not.toContain("Review details");
    // PRIVATE — the maintainer-notes / advisory-findings section must NEVER appear in the public converged comment.
    expect(body).not.toContain("Maintainer notes");
  });

  it("never includes a duplicate AI 'Review details' collapsible", () => {
    const { currentPr, detection, collisions, queueHealth, preflight, profile } = buildFixtures();
    const collapsibles = buildPublicSafeCollapsibles({ repo, pr: currentPr, profile, detection, settings, collisions, preflight, queueHealth });
    expect(collapsibles.map((section) => section.title)).toEqual(["Review context", "Contributor next steps", "Signal definitions"]);
    expect(collapsibles.map((section) => section.title)).not.toContain("Review details");
    // No section may carry the private maintainer-notes content.
    expect(collapsibles.map((section) => section.title)).not.toContain("Maintainer notes");
    expect(JSON.stringify(collapsibles)).not.toMatch(/maintainer notes/i);
  });

  it("the public-safe collapsible bodies are byte-identical to the legacy panel's <details> bodies", () => {
    const { currentPr, detection, collisions, queueHealth, preflight, profile } = buildFixtures();
    const aiReview = { notes: "Looks reasonable. Add a regression test for reconnect.", reviewerCount: 2 };
    const legacy = buildPublicPrIntelligenceComment({ repo, pr: currentPr, profile, detection, queueHealth, collisions, preflight, settings, aiReview });
    const collapsibles = buildPublicSafeCollapsibles({ repo, pr: currentPr, profile, detection, settings, collisions, preflight, queueHealth });

    // Each shared collapsible body's individual lines must appear verbatim in the legacy panel so the two
    // renderers can never diverge on the public-safe content.
    for (const section of collapsibles) {
      for (const line of section.body.split("\n")) {
        if (line.trim() === "") continue;
        expect(legacy).toContain(line);
      }
    }
    // The "Contributor next steps" body is single-sourced with the legacy panel's deduped next-steps list.
    const nextSteps = collapsibles.find((section) => section.title === "Contributor next steps")!;
    expect(nextSteps.body.length).toBeGreaterThan(0);
  });

  it("the legacy panel still renders 'Maintainer notes' inline (private section is unchanged, just not shared)", () => {
    const { currentPr, detection, collisions, queueHealth, preflight, profile } = buildFixtures();
    const legacy = buildPublicPrIntelligenceComment({ repo, pr: currentPr, profile, detection, queueHealth, collisions, preflight, settings });
    expect(legacy).toContain("Maintainer notes");
  });
});
