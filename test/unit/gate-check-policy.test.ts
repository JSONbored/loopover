import { describe, expect, it } from "vitest";
import { gateCheckPolicy } from "../../src/queue/processors";
import { evaluateGateCheck } from "../../src/rules/advisory";
import { parseFocusManifest, resolveEffectiveSettings } from "../../src/signals/focus-manifest";
import type { Advisory, RepositorySettings } from "../../src/types";

function settings(over: Partial<RepositorySettings> = {}): RepositorySettings {
  return {
    commentMode: "detected_contributors_only",
    gateCheckMode: "enabled",
    linkedIssueGateMode: "advisory",
    duplicatePrGateMode: "block",
    qualityGateMode: "advisory",
    qualityGateMinScore: null,
    ...over,
  } as unknown as RepositorySettings;
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

describe(".gittensory.yml settings override (resolveEffectiveSettings)", () => {
  it("returns the DB settings unchanged when the manifest has no overrides", () => {
    const eff = resolveEffectiveSettings(settings({ linkedIssueGateMode: "block" }), parseFocusManifest(null));
    expect(eff.linkedIssueGateMode).toBe("block");
    expect(eff.duplicatePrGateMode).toBe("block");
    expect(eff.gateCheckMode).toBe("enabled");
  });

  it("overlays the friendly gate: alias over DB settings (incl. gate.enabled -> gateCheckMode)", () => {
    const eff = resolveEffectiveSettings(
      settings({ gateCheckMode: "enabled", linkedIssueGateMode: "advisory", duplicatePrGateMode: "block", qualityGateMode: "off", qualityGateMinScore: 10 }),
      parseFocusManifest({ gate: { enabled: false, linkedIssue: "block", duplicates: "off", readiness: { mode: "block", minScore: 70 } } }),
    );
    expect(eff.gateCheckMode).toBe("off"); // gate.enabled: false disables from config
    expect(eff.linkedIssueGateMode).toBe("block");
    expect(eff.duplicatePrGateMode).toBe("off");
    expect(eff.qualityGateMode).toBe("block");
    expect(eff.qualityGateMinScore).toBe(70);
  });

  it("overlays the generic settings: block over DB, and gate: wins for gate fields", () => {
    const eff = resolveEffectiveSettings(
      settings({ commentMode: "off", publicSurface: "off", gateCheckMode: "off", linkedIssueGateMode: "off" }),
      parseFocusManifest({ settings: { commentMode: "all_prs", publicSurface: "comment_only", gateCheckMode: "enabled", linkedIssueGateMode: "advisory" }, gate: { linkedIssue: "block" } }),
    );
    expect(eff.commentMode).toBe("all_prs"); // settings: override
    expect(eff.publicSurface).toBe("comment_only"); // settings: override
    expect(eff.gateCheckMode).toBe("enabled"); // settings: override (config enables the gate)
    expect(eff.linkedIssueGateMode).toBe("block"); // gate: wins over settings:
  });

  it("end-to-end: a manifest linkedIssue:block blocks a confirmed author's no-issue PR even when DB is advisory", () => {
    const eff = resolveEffectiveSettings(settings({ linkedIssueGateMode: "advisory" }), parseFocusManifest({ gate: { linkedIssue: "block" } }));
    const blocked = evaluateGateCheck(missingIssueAdvisory(), gateCheckPolicy(eff, null, true));
    expect(blocked.conclusion).toBe("failure");
    expect(blocked.blockers.map((finding) => finding.code)).toEqual(["missing_linked_issue"]);
  });

  it("end-to-end: a manifest linkedIssue:advisory un-blocks even when DB is block (config-as-code relief)", () => {
    const eff = resolveEffectiveSettings(settings({ linkedIssueGateMode: "block" }), parseFocusManifest({ gate: { linkedIssue: "advisory" } }));
    expect(evaluateGateCheck(missingIssueAdvisory(), gateCheckPolicy(eff, null, true)).conclusion).toBe("success");
  });

  it("still only blocks confirmed contributors regardless of the config", () => {
    const eff = resolveEffectiveSettings(settings({ linkedIssueGateMode: "advisory" }), parseFocusManifest({ gate: { linkedIssue: "block" } }));
    const nonConfirmed = evaluateGateCheck(missingIssueAdvisory(), gateCheckPolicy(eff, null, false));
    expect(nonConfirmed.conclusion).toBe("neutral");
    expect(nonConfirmed.blockers).toEqual([]);
  });
});

describe("policy pack (#692)", () => {
  it("gittensor pack hard-blocks only confirmed contributors", () => {
    const gittensor = settings({ gatePack: "gittensor", linkedIssueGateMode: "block" });
    expect(evaluateGateCheck(missingIssueAdvisory(), gateCheckPolicy(gittensor, null, false)).conclusion).toBe("neutral");
    expect(evaluateGateCheck(missingIssueAdvisory(), gateCheckPolicy(gittensor, null, true)).conclusion).toBe("failure");
  });

  it("oss-anti-slop pack blocks ANY author whose PR trips an opted-in rule (no confirmed-contributor gate)", () => {
    const oss = settings({ gatePack: "oss-anti-slop", linkedIssueGateMode: "block" });
    const blocked = evaluateGateCheck(missingIssueAdvisory(), gateCheckPolicy(oss, null, false));
    expect(blocked.conclusion).toBe("failure");
    expect(blocked.blockers.map((finding) => finding.code)).toEqual(["missing_linked_issue"]);
    // Still passes a clean PR (no opted-in blocker) regardless of author.
    expect(evaluateGateCheck(missingIssueAdvisory(), gateCheckPolicy(settings({ gatePack: "oss-anti-slop", linkedIssueGateMode: "advisory" }), null, false)).conclusion).toBe("success");
  });

  it("gateCheckPolicy drops confirmedContributor under oss-anti-slop and keeps it (incl. default) under gittensor", () => {
    expect(gateCheckPolicy(settings({ gatePack: "oss-anti-slop" }), null, false).confirmedContributor).toBeUndefined();
    expect(gateCheckPolicy(settings({ gatePack: "oss-anti-slop" }), null, true).confirmedContributor).toBeUndefined();
    expect(gateCheckPolicy(settings({ gatePack: "gittensor" }), null, false).confirmedContributor).toBe(false);
    expect(gateCheckPolicy(settings({ gatePack: "gittensor" }), null, true).confirmedContributor).toBe(true);
  });

  it(".gittensory.yml gate.pack overlays the pack and flips the gate to block any author end-to-end", () => {
    const eff = resolveEffectiveSettings(settings({ gatePack: "gittensor", linkedIssueGateMode: "block" }), parseFocusManifest({ gate: { pack: "oss-anti-slop" } }));
    expect(eff.gatePack).toBe("oss-anti-slop");
    expect(evaluateGateCheck(missingIssueAdvisory(), gateCheckPolicy(eff, null, false)).conclusion).toBe("failure");
  });
});

describe("AI consensus defect gate blocker", () => {
  function aiDefectAdvisory(): Advisory {
    return { ...missingIssueAdvisory(), findings: [{ code: "ai_consensus_defect", title: "AI reviewers agree on a likely critical defect", severity: "critical", detail: "Both models flagged a null deref.", action: "Resolve it." }] };
  }

  it("is advisory by default — an AI consensus defect does NOT block when aiReview mode is off/advisory", () => {
    expect(evaluateGateCheck(aiDefectAdvisory(), gateCheckPolicy(settings({ aiReviewMode: "off" }), null, true)).conclusion).toBe("success");
    expect(evaluateGateCheck(aiDefectAdvisory(), gateCheckPolicy(settings({ aiReviewMode: "advisory" }), null, true)).conclusion).toBe("success");
  });

  it("blocks a confirmed contributor when the maintainer opts into aiReview: block (incl. via .gittensory.yml)", () => {
    const blocked = evaluateGateCheck(aiDefectAdvisory(), gateCheckPolicy(settings({ aiReviewMode: "block" }), null, true));
    expect(blocked.conclusion).toBe("failure");
    expect(blocked.blockers.map((f) => f.code)).toEqual(["ai_consensus_defect"]);
    const eff = resolveEffectiveSettings(settings({ aiReviewMode: "off" }), parseFocusManifest({ gate: { aiReview: { mode: "block" } } }));
    expect(evaluateGateCheck(aiDefectAdvisory(), gateCheckPolicy(eff, null, true)).conclusion).toBe("failure");
  });

  it("never blocks a non-confirmed contributor even with aiReview: block", () => {
    const result = evaluateGateCheck(aiDefectAdvisory(), gateCheckPolicy(settings({ aiReviewMode: "block" }), null, false));
    expect(result.conclusion).toBe("neutral");
    expect(result.blockers).toEqual([]);
  });
});
