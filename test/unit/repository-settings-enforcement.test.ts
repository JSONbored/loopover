import { describe, expect, it } from "vitest";
import { gateCheckPolicy } from "../../src/queue/processors";
import { evaluateGateCheck } from "../../src/rules/advisory";
import { runAiReviewForAdvisory } from "../../src/queue/processors";
import { buildMaintainerActivationPreview } from "../../src/services/maintainer-activation";
import { decidePublicSurface } from "../../src/signals/settings-preview";
import { parseFocusManifest, resolveEffectiveSettings } from "../../src/signals/focus-manifest";
import type { Advisory, PullRequestRecord, RepositoryRecord, RepositorySettings } from "../../src/types";

function settings(over: Partial<RepositorySettings> = {}): RepositorySettings {
  return {
    repoFullName: "owner/repo",
    commentMode: "detected_contributors_only",
    publicAudienceMode: "oss_maintainer",
    publicSignalLevel: "standard",
    checkRunMode: "off",
    checkRunDetailLevel: "standard",
    gateCheckMode: "enabled",
    gatePack: "gittensor",
    linkedIssueGateMode: "off",
    duplicatePrGateMode: "advisory",
    qualityGateMode: "advisory",
    slopGateMode: "off",
    mergeReadinessGateMode: "off",
    manifestPolicyGateMode: "off",
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
    aiReviewProvider: null,
    aiReviewModel: null,
    ...over,
  };
}

function missingIssueAdvisory(): Advisory {
  return {
    id: "advisory-policy",
    targetType: "pull_request",
    targetKey: "owner/repo#7",
    repoFullName: "owner/repo",
    pullNumber: 7,
    headSha: "sha7",
    conclusion: "neutral",
    severity: "warning",
    title: "Gittensory advisory available",
    summary: "1 advisory finding generated.",
    findings: [{ code: "missing_linked_issue", title: "No linked issue detected", severity: "warning", detail: "No closing reference.", action: "Link the issue." }],
    generatedAt: "2026-06-13T00:00:00.000Z",
  };
}

describe("repository settings enforcement audit (#797)", () => {
  it("maps requireLinkedIssue to linkedIssueGateMode block when the gate mode is off", () => {
    const effective = resolveEffectiveSettings(settings({ requireLinkedIssue: true, linkedIssueGateMode: "off" }), parseFocusManifest(null));
    expect(effective.linkedIssueGateMode).toBe("block");
  });

  it("blocks confirmed contributors when requireLinkedIssue is enabled via the boolean alone", () => {
    const effective = resolveEffectiveSettings(settings({ requireLinkedIssue: true, linkedIssueGateMode: "off" }), parseFocusManifest(null));
    const result = evaluateGateCheck(missingIssueAdvisory(), gateCheckPolicy(effective, null, true));
    expect(result.conclusion).toBe("failure");
  });

  it("skips maintainer-authored public surfaces when includeMaintainerAuthors is false", () => {
    const decision = decidePublicSurface({
      settings: settings({ includeMaintainerAuthors: false }),
      authorLogin: "owner",
      authorType: "User",
      authorAssociation: "OWNER",
      minerStatus: "confirmed",
    });
    expect(decision).toMatchObject({ skipped: true, skipReason: "maintainer_author" });
  });

  it("no-ops AI review when aiReviewMode is off", async () => {
    const advisory = missingIssueAdvisory();
    const notes = await runAiReviewForAdvisory({} as Env, {
      settings: settings({ aiReviewMode: "off" }),
      advisory,
      repoFullName: "owner/repo",
      pr: { number: 7, title: "Test" },
      author: "miner",
      confirmedContributor: true,
    });
    expect(notes).toBeUndefined();
    expect(advisory.findings.some((finding) => finding.code === "ai_consensus_defect")).toBe(false);
  });

  it("uses the repo requireLinkedIssue setting in maintainer activation previews", () => {
    const repo: RepositoryRecord = {
      fullName: "owner/repo",
      owner: "owner",
      name: "repo",
      isInstalled: true,
      isRegistered: true,
      isPrivate: false,
      registryConfig: { repo: "owner/repo", emissionShare: 0.01, issueDiscoveryShare: 0, maintainerCut: 0, labelMultipliers: {}, raw: {} },
    };
    const pull: PullRequestRecord = {
      repoFullName: repo.fullName,
      number: 1,
      title: "No issue link",
      state: "open",
      authorLogin: "miner",
      body: "No closing reference.",
      labels: [],
      linkedIssues: [],
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    };
    const withRequirement = buildMaintainerActivationPreview({
      repoFullName: repo.fullName,
      repo,
      settings: settings({ requireLinkedIssue: true }),
      pullRequests: [pull],
      generatedAt: "2026-06-01T00:00:00.000Z",
    });
    const withoutRequirement = buildMaintainerActivationPreview({
      repoFullName: repo.fullName,
      repo,
      settings: settings({ requireLinkedIssue: false, linkedIssueGateMode: "off" }),
      pullRequests: [pull],
      generatedAt: "2026-06-01T00:00:00.000Z",
    });
    expect(withRequirement.samples[0]?.findings.some((finding) => finding.code === "missing_linked_issue")).toBe(true);
    expect(withoutRequirement.samples[0]?.findings.some((finding) => finding.code === "missing_linked_issue")).toBe(false);
  });
});
