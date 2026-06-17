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

  it("end-to-end: manifest gate.mergeReadiness:block drives the composite even when the DB sub-gate is advisory (#822)", () => {
    const eff = resolveEffectiveSettings(settings({ linkedIssueGateMode: "advisory", mergeReadinessGateMode: "off" }), parseFocusManifest({ gate: { mergeReadiness: "block" } }));
    expect(eff.mergeReadinessGateMode).toBe("block");
    expect(evaluateGateCheck(missingIssueAdvisory(), gateCheckPolicy(eff, null, true)).conclusion).toBe("failure");
  });

  it("end-to-end: manifest gate.firstTimeContributorGrace:true softens a newcomer's block to advisory (#822/#552)", () => {
    const eff = resolveEffectiveSettings(settings({ linkedIssueGateMode: "block", firstTimeContributorGrace: false }), parseFocusManifest({ gate: { firstTimeContributorGrace: true } }));
    expect(eff.firstTimeContributorGrace).toBe(true);
    const newcomerPolicy = gateCheckPolicy(eff, null, true, null, { mergedPrCount: 0, closedUnmergedPrCount: 0 });
    expect(evaluateGateCheck(missingIssueAdvisory(), newcomerPolicy).conclusion).toBe("neutral");
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

describe("slop gate (#530/#532)", () => {
  function cleanAdvisory(): Advisory {
    return { ...missingIssueAdvisory(), findings: [] };
  }

  it("never blocks on slop in advisory/off mode, even at a high slop score", () => {
    expect(evaluateGateCheck(cleanAdvisory(), { slopGateMode: "advisory", slopRisk: 90, slopGateMinScore: 60, confirmedContributor: true }).conclusion).toBe("success");
    expect(evaluateGateCheck(cleanAdvisory(), { slopGateMode: "off", slopRisk: 90, confirmedContributor: true }).conclusion).toBe("success");
  });

  it("blocks when slop: block and slopRisk is at/above the threshold", () => {
    const blocked = evaluateGateCheck(cleanAdvisory(), { slopGateMode: "block", slopGateMinScore: 60, slopRisk: 70, confirmedContributor: true });
    expect(blocked.conclusion).toBe("failure");
    expect(blocked.blockers.map((finding) => finding.code)).toContain("slop_risk_above_threshold");
  });

  it("does not block when slopRisk is below the threshold", () => {
    expect(evaluateGateCheck(cleanAdvisory(), { slopGateMode: "block", slopGateMinScore: 60, slopRisk: 40, confirmedContributor: true }).conclusion).toBe("success");
  });

  it("defaults the block threshold to 60 when no minScore is set", () => {
    expect(evaluateGateCheck(cleanAdvisory(), { slopGateMode: "block", slopRisk: 60, confirmedContributor: true }).conclusion).toBe("failure");
    expect(evaluateGateCheck(cleanAdvisory(), { slopGateMode: "block", slopRisk: 59, confirmedContributor: true }).conclusion).toBe("success");
  });

  it("respects the confirmed-contributor gate (never blocks a non-confirmed author)", () => {
    expect(evaluateGateCheck(cleanAdvisory(), { slopGateMode: "block", slopGateMinScore: 60, slopRisk: 90, confirmedContributor: false }).conclusion).toBe("neutral");
  });

  it("gateCheckPolicy threads slop settings + the live slopRisk into the policy (incl. .gittensory.yml)", () => {
    const eff = resolveEffectiveSettings(settings({ slopGateMode: "off" }), parseFocusManifest({ gate: { slop: { mode: "block", minScore: 50 } } }));
    expect(eff.slopGateMode).toBe("block");
    expect(eff.slopGateMinScore).toBe(50);
    const blocked = evaluateGateCheck(cleanAdvisory(), gateCheckPolicy(eff, null, true, 80));
    expect(blocked.conclusion).toBe("failure");
    expect(blocked.blockers.map((finding) => finding.code)).toContain("slop_risk_above_threshold");
  });
});

describe("merge-readiness composite gate (#551)", () => {
  it("block escalates an otherwise-advisory sub-gate (linked-issue) into a hard blocker", () => {
    const eff = resolveEffectiveSettings(settings({ linkedIssueGateMode: "advisory", mergeReadinessGateMode: "block" }), parseFocusManifest(null));
    const result = evaluateGateCheck(missingIssueAdvisory(), gateCheckPolicy(eff, null, true));
    expect(result.conclusion).toBe("failure");
    expect(result.summary).toContain("No linked issue detected");
  });

  it("advisory keeps the composite non-blocking even when a sub-gate is individually set to block", () => {
    const eff = resolveEffectiveSettings(settings({ linkedIssueGateMode: "block", mergeReadinessGateMode: "advisory" }), parseFocusManifest(null));
    expect(evaluateGateCheck(missingIssueAdvisory(), gateCheckPolicy(eff, null, true)).conclusion).toBe("success");
  });

  it("off is a no-op: sub-gates keep their own modes (linked-issue stays advisory -> non-blocking)", () => {
    const eff = resolveEffectiveSettings(settings({ linkedIssueGateMode: "advisory", mergeReadinessGateMode: "off" }), parseFocusManifest(null));
    expect(evaluateGateCheck(missingIssueAdvisory(), gateCheckPolicy(eff, null, true)).conclusion).toBe("success");
  });

  it("the blocking summary lists each unmet sub-gate condition", () => {
    const advisory = missingIssueAdvisory();
    advisory.findings.push({ code: "duplicate_pr_risk", title: "Possible duplicate PR", severity: "warning", detail: "Overlaps #9.", action: "Close the duplicate." });
    const eff = resolveEffectiveSettings(settings({ mergeReadinessGateMode: "block" }), parseFocusManifest(null));
    const result = evaluateGateCheck(advisory, gateCheckPolicy(eff, null, true));
    expect(result.conclusion).toBe("failure");
    expect(result.summary).toContain("No linked issue detected");
    expect(result.summary).toContain("Possible duplicate PR");
  });
});

describe("first-time-contributor grace (#552)", () => {
  // A would-be hard blocker for a confirmed contributor (linked-issue: block trips on the missing-issue PR).
  const blockingPolicy = { linkedIssueGateMode: "block" as const, confirmedContributor: true };

  it("(a) softens the block to a neutral/advisory gate for a genuine newcomer (0 merged, 0 closed-unmerged)", () => {
    const result = evaluateGateCheck(missingIssueAdvisory(), {
      ...blockingPolicy,
      firstTimeContributorGrace: true,
      authorMergedPrCount: 0,
      authorClosedUnmergedPrCount: 0,
    });
    expect(result.conclusion).toBe("neutral");
    expect(result.blockers).toEqual([]);
    expect(result.title).toContain("first-contribution grace");
  });

  it("(b) still blocks a repeat offender (0 merged, >= 3 closed-unmerged) — grace does not apply", () => {
    const result = evaluateGateCheck(missingIssueAdvisory(), {
      ...blockingPolicy,
      firstTimeContributorGrace: true,
      authorMergedPrCount: 0,
      authorClosedUnmergedPrCount: 3,
    });
    expect(result.conclusion).toBe("failure");
    expect(result.blockers.map((finding) => finding.code)).toEqual(["missing_linked_issue"]);
  });

  it("(c) blocks normally when the grace setting is off, even for a newcomer", () => {
    const result = evaluateGateCheck(missingIssueAdvisory(), {
      ...blockingPolicy,
      firstTimeContributorGrace: false,
      authorMergedPrCount: 0,
      authorClosedUnmergedPrCount: 0,
    });
    expect(result.conclusion).toBe("failure");
    expect(result.blockers.map((finding) => finding.code)).toEqual(["missing_linked_issue"]);
  });

  it("(d) blocks an author with merge history (not a newcomer) even with grace on", () => {
    const result = evaluateGateCheck(missingIssueAdvisory(), {
      ...blockingPolicy,
      firstTimeContributorGrace: true,
      authorMergedPrCount: 2,
      authorClosedUnmergedPrCount: 0,
    });
    expect(result.conclusion).toBe("failure");
    expect(result.blockers.map((finding) => finding.code)).toEqual(["missing_linked_issue"]);
  });

  it("gateCheckPolicy threads firstTimeContributorGrace + the author's per-repo history into the policy", () => {
    const policy = gateCheckPolicy(settings({ firstTimeContributorGrace: true }), null, true, null, { mergedPrCount: 0, closedUnmergedPrCount: 1 });
    expect(policy.firstTimeContributorGrace).toBe(true);
    expect(policy.authorMergedPrCount).toBe(0);
    expect(policy.authorClosedUnmergedPrCount).toBe(1);
    expect(evaluateGateCheck(missingIssueAdvisory(), { ...policy, linkedIssueGateMode: "block" }).conclusion).toBe("neutral");
  });
});

describe("focus-manifest policy gate (#555)", () => {
  // The three enforceable manifest-policy findings buildFocusManifestGuidance emits.
  const POLICY_FINDINGS = {
    manifest_blocked_path: { code: "manifest_blocked_path", title: "Change touches a maintainer-blocked area", severity: "critical" as const, detail: "Changed paths match maintainer-blocked patterns.", action: "Move out of the blocked area." },
    manifest_linked_issue_required: { code: "manifest_linked_issue_required", title: "Maintainer requires a linked issue", severity: "warning" as const, detail: "Manifest requires a linked issue.", action: "Link the issue." },
    manifest_missing_tests: { code: "manifest_missing_tests", title: "Maintainer test expectations unmet", severity: "warning" as const, detail: "Manifest expects test evidence.", action: "Add tests." },
  };

  function manifestAdvisory(code: keyof typeof POLICY_FINDINGS): Advisory {
    return { ...missingIssueAdvisory(), findings: [POLICY_FINDINGS[code]] };
  }

  for (const code of Object.keys(POLICY_FINDINGS) as (keyof typeof POLICY_FINDINGS)[]) {
    describe(code, () => {
      it("blocks a confirmed contributor when manifestPolicy: block", () => {
        const result = evaluateGateCheck(manifestAdvisory(code), { manifestPolicyGateMode: "block", confirmedContributor: true });
        expect(result.conclusion).toBe("failure");
        expect(result.blockers.map((finding) => finding.code)).toContain(code);
      });

      it("does not block when manifestPolicy: off (advisory-only)", () => {
        expect(evaluateGateCheck(manifestAdvisory(code), { manifestPolicyGateMode: "off", confirmedContributor: true }).conclusion).toBe("success");
      });

      it("does not block when manifestPolicy: advisory (advisory != block)", () => {
        expect(evaluateGateCheck(manifestAdvisory(code), { manifestPolicyGateMode: "advisory", confirmedContributor: true }).conclusion).toBe("success");
      });

      it("never blocks a non-confirmed contributor even with manifestPolicy: block", () => {
        const result = evaluateGateCheck(manifestAdvisory(code), { manifestPolicyGateMode: "block", confirmedContributor: false });
        expect(result.conclusion).toBe("neutral");
        expect(result.blockers).toEqual([]);
      });
    });
  }

  it("is an INDEPENDENT dimension: mergeReadiness: block does NOT promote a manifest-policy finding (kept out of the composite)", () => {
    const eff = resolveEffectiveSettings(settings({ manifestPolicyGateMode: "off", mergeReadinessGateMode: "block" }), parseFocusManifest(null));
    expect(evaluateGateCheck(manifestAdvisory("manifest_blocked_path"), gateCheckPolicy(eff, null, true)).conclusion).toBe("success");
  });

  it("gateCheckPolicy threads manifestPolicyGateMode into the policy", () => {
    expect(gateCheckPolicy(settings({ manifestPolicyGateMode: "block" }), null, true).manifestPolicyGateMode).toBe("block");
  });

  it("end-to-end: a manifest gate.manifestPolicy: block sets effective.manifestPolicyGateMode and blocks a blockedPath PR", () => {
    const eff = resolveEffectiveSettings(settings({ manifestPolicyGateMode: "off" }), parseFocusManifest({ gate: { manifestPolicy: "block" } }));
    expect(eff.manifestPolicyGateMode).toBe("block");
    const result = evaluateGateCheck(manifestAdvisory("manifest_blocked_path"), gateCheckPolicy(eff, null, true));
    expect(result.conclusion).toBe("failure");
    expect(result.blockers.map((finding) => finding.code)).toContain("manifest_blocked_path");
  });
});
