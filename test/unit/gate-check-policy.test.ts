import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { clearInstallationTokenCacheForTest } from "../../src/github/app";
import { buildAuthorizedPrActionAdvisory, gateCheckPolicy, resolveLinkedIssueAuthorLogins, shouldCollectLinkedIssueEvidence, shouldCollectSlopEvidence, shouldRefreshFilesForPreMergeChecks, shouldRunSlopAiAdvisory } from "../../src/queue/processors";
import { createTestEnv } from "../helpers/d1";
import { upsertIssueFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { evaluateGateCheck } from "../../src/rules/advisory";
import { REVIEW_THREAD_BLOCKER_CODE } from "../../src/review/review-thread-findings";
import { parseFocusManifest, resolveEffectiveSettings } from "../../src/signals/focus-manifest";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import type { Advisory, PullRequestRecord, RepositorySettings } from "../../src/types";

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
      // readiness.mode: "block" is downgraded to "advisory" at parse time (#2267) — readiness/quality can
      // never hard-block, so this exercises the SAME downgrade flowing through resolveEffectiveSettings.
      parseFocusManifest({ gate: { enabled: false, linkedIssue: "block", duplicates: "off", readiness: { mode: "block", minScore: 70 } } }),
    );
    expect(eff.gateCheckMode).toBe("off"); // gate.enabled: false disables from config
    expect(eff.linkedIssueGateMode).toBe("block");
    expect(eff.duplicatePrGateMode).toBe("off");
    expect(eff.qualityGateMode).toBe("advisory");
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

  it("end-to-end: manifest gate.firstTimeContributorGrace:true no longer softens a newcomer's blocker (#822/#552)", () => {
    const eff = resolveEffectiveSettings(settings({ linkedIssueGateMode: "block", firstTimeContributorGrace: false }), parseFocusManifest({ gate: { firstTimeContributorGrace: true } }));
    expect(eff.firstTimeContributorGrace).toBe(true);
    const newcomerPolicy = gateCheckPolicy(eff, null, true, null, { mergedPrCount: 0, closedUnmergedPrCount: 0 });
    expect(evaluateGateCheck(missingIssueAdvisory(), newcomerPolicy).conclusion).toBe("failure");
  });

  it("blocks a non-confirmed contributor identically to a confirmed one (#gate-nonconfirmed)", () => {
    const eff = resolveEffectiveSettings(settings({ linkedIssueGateMode: "advisory" }), parseFocusManifest({ gate: { linkedIssue: "block" } }));
    // Non-confirmed now gates NORMALLY: a configured blocker → failure, the same verdict a confirmed author gets.
    const nonConfirmed = evaluateGateCheck(missingIssueAdvisory(), gateCheckPolicy(eff, null, false));
    expect(nonConfirmed.conclusion).toBe("failure");
    expect(nonConfirmed.blockers.map((finding) => finding.code)).toEqual(["missing_linked_issue"]);
  });
});

describe("AI fail-closed hold (#ai-fail-closed)", () => {
  it("holds the gate NEUTRAL (held for human, never a failure-close) when an AI review is inconclusive", () => {
    const adv: Advisory = {
      ...missingIssueAdvisory(),
      findings: [{ code: "ai_review_inconclusive", title: "AI review could not be completed", severity: "warning", detail: "no usable verdict", action: "held for human" }],
    };
    const result = evaluateGateCheck(adv, gateCheckPolicy(settings(), null, true));
    expect(result.conclusion).toBe("neutral");
    expect(result.blockers).toEqual([]);
  });

  it("a deterministic hard blocker (secret_leak) still FAILS even when the AI review is inconclusive (#audit-3.5)", () => {
    const adv: Advisory = {
      ...missingIssueAdvisory(),
      findings: [
        { code: "secret_leak", title: "Possible leaked secret", severity: "critical", detail: "a committed token", action: "remove and rotate it" },
        { code: "ai_review_inconclusive", title: "AI review could not be completed", severity: "warning", detail: "no usable verdict", action: "held for human" },
      ],
    };
    const result = evaluateGateCheck(adv, gateCheckPolicy(settings(), null, true));
    // An inconclusive AI can no longer bury a real violation in a "held" state — the secret_leak still hard-blocks.
    expect(result.conclusion).toBe("failure");
    expect(result.blockers.map((blocker) => blocker.code)).toContain("secret_leak");
  });

  it("holds the gate NEUTRAL (never a failure-close) when the AI review lock is held by another in-flight pass (#confirmed-bug)", () => {
    // Same code, different finding text — the lock-contention finding constructed by runAiReviewForAdvisory's
    // new claim-failure branch. advisory.ts only keys on `code`, so this proves the mechanism end-to-end for
    // the new finding shape without needing to touch advisory.ts.
    const adv: Advisory = {
      ...missingIssueAdvisory(),
      findings: [
        {
          code: "ai_review_inconclusive",
          title: "AI review already in progress for this PR head",
          severity: "warning",
          detail: "Another Gittensory pass is already running the AI review for this exact PR head. This pass is skipping to avoid a duplicate LLM call.",
          action: "The gate is held for a human reviewer rather than passed automatically; it re-evaluates once the in-flight review completes or on the next update.",
        },
      ],
    };
    const result = evaluateGateCheck(adv, gateCheckPolicy(settings(), null, true));
    expect(result.conclusion).toBe("neutral");
    expect(result.blockers).toEqual([]);
  });

  it("a deterministic hard blocker (secret_leak) still FAILS even when the AI review is held by lock contention (#confirmed-bug)", () => {
    const adv: Advisory = {
      ...missingIssueAdvisory(),
      findings: [
        { code: "secret_leak", title: "Possible leaked secret", severity: "critical", detail: "a committed token", action: "remove and rotate it" },
        {
          code: "ai_review_inconclusive",
          title: "AI review already in progress for this PR head",
          severity: "warning",
          detail: "Another Gittensory pass is already running the AI review for this exact PR head. This pass is skipping to avoid a duplicate LLM call.",
          action: "The gate is held for a human reviewer rather than passed automatically; it re-evaluates once the in-flight review completes or on the next update.",
        },
      ],
    };
    const result = evaluateGateCheck(adv, gateCheckPolicy(settings(), null, true));
    expect(result.conclusion).toBe("failure");
    expect(result.blockers.map((blocker) => blocker.code)).toContain("secret_leak");
  });

  it("an enforced pre-merge check (pre_merge_check_required) hard-blocks; the advisory variant never does (#review-pre-merge-checks)", () => {
    const enforced: Advisory = {
      ...missingIssueAdvisory(),
      findings: [{ code: "pre_merge_check_required", title: "Pre-merge check not satisfied: Required label", severity: "critical", detail: "the 'approved' label must be applied", action: "apply it" }],
    };
    const enforcedResult = evaluateGateCheck(enforced, gateCheckPolicy(settings(), null, true));
    expect(enforcedResult.conclusion).toBe("failure");
    expect(enforcedResult.blockers.map((blocker) => blocker.code)).toContain("pre_merge_check_required");

    const advisoryOnly: Advisory = {
      ...missingIssueAdvisory(),
      findings: [{ code: "pre_merge_check_failed", title: "Pre-merge check not satisfied: Migration note", severity: "warning", detail: "the description must contain 'migration'", action: "add it" }],
    };
    const advisoryResult = evaluateGateCheck(advisoryOnly, gateCheckPolicy(settings(), null, true));
    expect(advisoryResult.conclusion).toBe("success"); // advisory finding stays advisory — never blocks
    expect(advisoryResult.blockers).toEqual([]);
    expect(advisoryResult.warnings.map((warning) => warning.code)).toContain("pre_merge_check_failed");
  });

  it("an unresolved-files enforced pre-merge check HOLDS the gate (neutral), never close or pass (#review-audit)", () => {
    const held: Advisory = {
      ...missingIssueAdvisory(),
      findings: [{ code: "pre_merge_check_unresolved", title: "Pre-merge check held — changed files not resolved: Migrations documented", severity: "warning", detail: "could not resolve files", action: "re-evaluates automatically" }],
    };
    const result = evaluateGateCheck(held, gateCheckPolicy(settings(), null, true));
    expect(result.conclusion).toBe("neutral"); // held: not a pass (would auto-merge past the unverified check) nor a failure (would auto-close on a transient miss)
    expect(result.blockers).toEqual([]);
  });
});

describe("CLA / license-compatibility gate (#2564)", () => {
  function claAdvisory(): Advisory {
    return {
      ...missingIssueAdvisory(),
      findings: [{ code: "cla_consent_missing", title: "CLA consent not confirmed", severity: "warning", detail: 'the PR description must contain "I agree to the CLA"', action: "add it" }],
    };
  }

  it("blocks a confirmed contributor when claMode: block", () => {
    const result = evaluateGateCheck(claAdvisory(), { claGateMode: "block", confirmedContributor: true });
    expect(result.conclusion).toBe("failure");
    expect(result.blockers.map((finding) => finding.code)).toContain("cla_consent_missing");
  });

  it("blocks a non-confirmed contributor under claMode: block, the same as a confirmed one (#gate-nonconfirmed)", () => {
    const result = evaluateGateCheck(claAdvisory(), { claGateMode: "block", confirmedContributor: false });
    expect(result.conclusion).toBe("failure");
    expect(result.blockers.map((finding) => finding.code)).toContain("cla_consent_missing");
  });

  it("does not block when claMode: advisory (surfaces as a warning, never blocks)", () => {
    const result = evaluateGateCheck(claAdvisory(), { claGateMode: "advisory", confirmedContributor: true });
    expect(result.conclusion).toBe("success");
    expect(result.blockers).toEqual([]);
    expect(result.warnings.map((finding) => finding.code)).toContain("cla_consent_missing");
  });

  it("does not block when claMode is unset/off (default) — zero behavior change for a repo that has not opted in", () => {
    expect(evaluateGateCheck(claAdvisory(), { confirmedContributor: true }).conclusion).toBe("success");
    expect(evaluateGateCheck(claAdvisory(), { claGateMode: "off", confirmedContributor: true }).conclusion).toBe("success");
  });

  it("an UNRESOLVED CLA check-run (cla_check_unresolved) HOLDS the gate (neutral) under claMode: block, never close or pass", () => {
    const held: Advisory = {
      ...missingIssueAdvisory(),
      findings: [{ code: "cla_check_unresolved", title: 'CLA check held — "CLA Assistant Lite" not resolved', severity: "warning", detail: "could not resolve the check-run", action: "re-evaluates automatically" }],
    };
    const result = evaluateGateCheck(held, { claGateMode: "block", confirmedContributor: true });
    expect(result.conclusion).toBe("neutral");
    expect(result.blockers).toEqual([]);
  });

  // #2564 gate-review finding: advisory mode's whole contract is "surface findings, never affect the verdict"
  // — an unresolved check-run must NOT hold the gate under claMode: advisory, unlike claMode: block above.
  it("an UNRESOLVED CLA check-run does NOT hold the gate under claMode: advisory — surfaces as a warning only", () => {
    const held: Advisory = {
      ...missingIssueAdvisory(),
      findings: [{ code: "cla_check_unresolved", title: 'CLA check held — "CLA Assistant Lite" not resolved', severity: "warning", detail: "could not resolve the check-run", action: "re-evaluates automatically" }],
    };
    const result = evaluateGateCheck(held, { claGateMode: "advisory", confirmedContributor: true });
    expect(result.conclusion).toBe("success");
    expect(result.blockers).toEqual([]);
    expect(result.warnings.map((finding) => finding.code)).toContain("cla_check_unresolved");
  });

  it("gateCheckPolicy threads claGateMode into the policy", () => {
    expect(gateCheckPolicy(settings({ claGateMode: "block" }), null, true).claGateMode).toBe("block");
  });

  it("resolveEffectiveSettings maps gate.claMode / gate.cla.{consentPhrase,checkRunName} onto the effective settings", () => {
    const eff = resolveEffectiveSettings(settings({}), parseFocusManifest({ gate: { claMode: "block", cla: { consentPhrase: "I agree to the CLA", checkRunName: "CLA Assistant Lite", checkRunAppSlug: "cla-assistant" } } }));
    expect(eff.claGateMode).toBe("block");
    expect(eff.claConsentPhrase).toBe("I agree to the CLA");
    expect(eff.claCheckRunName).toBe("CLA Assistant Lite");
    expect(eff.claCheckRunAppSlug).toBe("cla-assistant");
  });

  it("resolveEffectiveSettings leaves claGateMode unset when the manifest has no gate.claMode (byte-identical default)", () => {
    const eff = resolveEffectiveSettings(settings({}), parseFocusManifest(null));
    expect(eff.claGateMode).toBeUndefined();
    expect(eff.claConsentPhrase).toBeUndefined();
    expect(eff.claCheckRunName).toBeUndefined();
    expect(eff.claCheckRunAppSlug).toBeUndefined();
  });

  it("end-to-end: a manifest gate.claMode: block + consentPhrase blocks a PR missing CLA consent (acceptance criterion)", () => {
    const eff = resolveEffectiveSettings(settings({}), parseFocusManifest({ gate: { claMode: "block", cla: { consentPhrase: "I agree to the CLA" } } }));
    const result = evaluateGateCheck(claAdvisory(), gateCheckPolicy(eff, null, true));
    expect(result.conclusion).toBe("failure");
    expect(result.blockers.map((finding) => finding.code)).toContain("cla_consent_missing");
  });
});

describe("policy pack (#692)", () => {
  it("gittensor pack hard-blocks every author the same — confirmed status no longer changes the verdict (#gate-nonconfirmed)", () => {
    const gittensor = settings({ gatePack: "gittensor", linkedIssueGateMode: "block" });
    expect(evaluateGateCheck(missingIssueAdvisory(), gateCheckPolicy(gittensor, null, false)).conclusion).toBe("failure");
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

  it("blocks a non-confirmed contributor under aiReview: block, the same as a confirmed one (#gate-nonconfirmed)", () => {
    const result = evaluateGateCheck(aiDefectAdvisory(), gateCheckPolicy(settings({ aiReviewMode: "block" }), null, false));
    expect(result.conclusion).toBe("failure");
    expect(result.blockers.map((f) => f.code)).toEqual(["ai_consensus_defect"]);
  });
});

describe("AI close-confidence threshold gate (#7)", () => {
  const aiDefectWith = (confidence: number | undefined): Advisory => ({
    ...missingIssueAdvisory(),
    findings: [{ code: "ai_consensus_defect", title: "AI reviewers agree on a likely critical defect", severity: "critical", detail: "Both models flagged a null deref.", action: "Resolve it.", ...(confidence !== undefined ? { confidence } : {}) }],
  });
  const splitDefectWith = (confidence: number): Advisory => ({
    ...missingIssueAdvisory(),
    findings: [{ code: "ai_review_split", title: "An AI reviewer flagged a likely blocking defect", severity: "critical", detail: "One reviewer flagged it.", action: "Resolve it.", confidence }],
  });

  it("blocks when mode=block AND confidence >= the default 0.93 floor", () => {
    const out = evaluateGateCheck(aiDefectWith(0.95), gateCheckPolicy(settings({ aiReviewMode: "block" }), null, true));
    expect(out.conclusion).toBe("failure");
    expect(out.blockers.map((f) => f.code)).toEqual(["ai_consensus_defect"]);
  });

  it("blocks when mode=block even when confidence is below the configured floor (#7 regression)", () => {
    const out = evaluateGateCheck(aiDefectWith(0.92), gateCheckPolicy(settings({ aiReviewMode: "block" }), null, true));
    expect(out.conclusion).toBe("failure");
    expect(out.blockers.map((f) => f.code)).toEqual(["ai_consensus_defect"]);
  });

  it("threads a custom floor but does not use it to downgrade below-floor defects", () => {
    // policy.aiReviewCloseConfidence is threaded onto the policy from settings.
    const policy = gateCheckPolicy(settings({ aiReviewMode: "block", aiReviewCloseConfidence: 0.7 }), null, true);
    expect(policy.aiReviewCloseConfidence).toBe(0.7);
    expect(evaluateGateCheck(aiDefectWith(0.7), policy).conclusion).toBe("failure");
    expect(evaluateGateCheck(aiDefectWith(0.69), policy).conclusion).toBe("failure");
  });

  it("keeps custom aiReviewCloseConfidence as calibration context without softening blockers (#7)", () => {
    const strict = gateCheckPolicy(settings({ aiReviewMode: "block", aiReviewCloseConfidence: 0.99 }), null, true);
    expect(evaluateGateCheck(aiDefectWith(0.95), strict).conclusion).toBe("failure");
    const lenient = gateCheckPolicy(settings({ aiReviewMode: "block", aiReviewCloseConfidence: 0.3 }), null, true);
    expect(evaluateGateCheck(aiDefectWith(0.5), lenient).conclusion).toBe("failure");
  });

  it("a finding WITHOUT a confidence still blocks under aiReview:block (#7)", () => {
    const out = evaluateGateCheck(aiDefectWith(undefined), gateCheckPolicy(settings({ aiReviewMode: "block" }), null, true));
    expect(out.conclusion).toBe("failure");
  });

  it("never blocks when mode=advisory, regardless of a high confidence (#7)", () => {
    expect(evaluateGateCheck(aiDefectWith(1), gateCheckPolicy(settings({ aiReviewMode: "advisory" }), null, true)).conclusion).toBe("success");
  });

  it("applies the same confidence floor to an ai_review_split finding (#7)", () => {
    const policy = gateCheckPolicy(settings({ aiReviewMode: "block" }), null, true);
    expect(evaluateGateCheck(splitDefectWith(0.95), policy).conclusion).toBe("failure");
    expect(evaluateGateCheck(splitDefectWith(0.92), policy).conclusion).toBe("failure");
  });

  it("resolveEffectiveSettings maps gate.aiReview.closeConfidence (clamped) into the policy floor (#7)", () => {
    const eff = resolveEffectiveSettings(settings({ aiReviewMode: "off" }), parseFocusManifest({ gate: { aiReview: { mode: "block", closeConfidence: 0.4 } } }));
    expect(eff.aiReviewCloseConfidence).toBe(0.4);
    expect(eff.aiReviewMode).toBe("block");
    expect(evaluateGateCheck(aiDefectWith(0.5), gateCheckPolicy(eff, null, true)).conclusion).toBe("failure");
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

  it("blocks a non-confirmed author on slop the same as a confirmed one (#gate-nonconfirmed)", () => {
    const result = evaluateGateCheck(cleanAdvisory(), { slopGateMode: "block", slopGateMinScore: 60, slopRisk: 90, confirmedContributor: false });
    expect(result.conclusion).toBe("failure");
    expect(result.blockers.map((finding) => finding.code)).toContain("slop_risk_above_threshold");
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

describe("merge-readiness evidence collection (#551)", () => {
  it("collects linked-issue evidence when the aggregate gate is enabled even if the sub-gate is off", () => {
    expect(shouldCollectLinkedIssueEvidence(settings({ requireLinkedIssue: false, linkedIssueGateMode: "off", mergeReadinessGateMode: "block" }))).toBe(true);
    expect(shouldCollectLinkedIssueEvidence(settings({ requireLinkedIssue: false, linkedIssueGateMode: "off", mergeReadinessGateMode: "advisory" }))).toBe(true);
    expect(shouldCollectLinkedIssueEvidence(settings({ requireLinkedIssue: false, linkedIssueGateMode: "off", mergeReadinessGateMode: "off" }))).toBe(false);
  });

  it("collects deterministic slop evidence when the aggregate gate is enabled even if the sub-gate is off", () => {
    expect(shouldCollectSlopEvidence(settings({ slopGateMode: "off", mergeReadinessGateMode: "block" }))).toBe(true);
    expect(shouldCollectSlopEvidence(settings({ slopGateMode: "off", mergeReadinessGateMode: "advisory" }))).toBe(true);
    expect(shouldCollectSlopEvidence(settings({ slopGateMode: "off", mergeReadinessGateMode: "off" }))).toBe(false);
  });

  it("refreshes files when pre-merge checks are path-gated (#review-pre-merge-checks)", async () => {
    const env = createTestEnv();

    expect(await shouldRefreshFilesForPreMergeChecks(env, "JSONbored/gittensory")).toBe(false);

    await upsertRepoFocusManifest(env, "JSONbored/gittensory", {
      review: { pre_merge_checks: [{ name: "Approval", require_label: "approved" }] },
    });
    expect(await shouldRefreshFilesForPreMergeChecks(env, "JSONbored/gittensory")).toBe(false);

    await upsertRepoFocusManifest(env, "JSONbored/gittensory", {
      review: { pre_merge_checks: [{ name: "Migration approval", require_label: "approved", when_paths: ["migrations/**"] }] },
    });
    expect(await shouldRefreshFilesForPreMergeChecks(env, "JSONbored/gittensory")).toBe(true);
  });

  it("fails safe to false when the focus-manifest load throws (#review-pre-merge-checks)", async () => {
    // A manifest-load failure must NOT trigger a refresh — the `.catch(() => null)` fail-safe resolves to an
    // empty check set, so `.some()` is false and the path-gated refresh stays off.
    const env = createTestEnv({
      DB: {
        prepare() {
          throw new Error("D1 unavailable");
        },
      } as unknown as Env["DB"],
    });
    expect(await shouldRefreshFilesForPreMergeChecks(env, "JSONbored/gittensory")).toBe(false);
  });

  it("runs AI slop advisory only when the slop gate is explicitly enabled", () => {
    expect(shouldRunSlopAiAdvisory(settings({ slopGateMode: "advisory", slopAiAdvisory: true }))).toBe(true);
    expect(shouldRunSlopAiAdvisory(settings({ slopGateMode: "block", slopAiAdvisory: true }))).toBe(true);
    expect(shouldRunSlopAiAdvisory(settings({ slopGateMode: "off", mergeReadinessGateMode: "advisory", slopAiAdvisory: true }))).toBe(false);
    expect(shouldRunSlopAiAdvisory(settings({ slopGateMode: "advisory", slopAiAdvisory: false }))).toBe(false);
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

  it("does not escalate readiness score into a blocker", () => {
    const eff = resolveEffectiveSettings(settings({ mergeReadinessGateMode: "block", qualityGateMinScore: 90 }), parseFocusManifest(null));
    const result = evaluateGateCheck({ ...missingIssueAdvisory(), findings: [] }, gateCheckPolicy(eff, 42, true));
    expect(result.conclusion).toBe("success");
    expect(result.blockers).toEqual([]);
    expect(result.warnings.map((finding) => finding.code)).toEqual(["readiness_score_below_threshold"]);
  });
});

describe("first-time-contributor grace compatibility (#552)", () => {
  // A would-be hard blocker for a confirmed contributor (linked-issue: block trips on the missing-issue PR).
  const blockingPolicy = { linkedIssueGateMode: "block" as const, confirmedContributor: true };

  it("(a) does not soften blockers for a genuine newcomer (0 merged, 0 closed-unmerged)", () => {
    const result = evaluateGateCheck(missingIssueAdvisory(), {
      ...blockingPolicy,
      firstTimeContributorGrace: true,
      authorMergedPrCount: 0,
      authorClosedUnmergedPrCount: 0,
    });
    expect(result.conclusion).toBe("failure");
    expect(result.blockers.map((finding) => finding.code)).toEqual(["missing_linked_issue"]);
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
    expect(evaluateGateCheck(missingIssueAdvisory(), { ...policy, linkedIssueGateMode: "block" }).conclusion).toBe("failure");
  });
});

describe("review-thread blocker gate", () => {
  it("always blocks unresolved review-thread findings", () => {
    const advisory: Advisory = {
      ...missingIssueAdvisory(),
      findings: [{ code: REVIEW_THREAD_BLOCKER_CODE, severity: "critical", title: "review thread unresolved", detail: "Resolve it." }],
    };
    const result = evaluateGateCheck(advisory);
    expect(result.conclusion).toBe("failure");
    expect(result.blockers.map((finding) => finding.code)).toEqual([REVIEW_THREAD_BLOCKER_CODE]);
  });
});

describe("focus-manifest policy gate (#555)", () => {
  // The manifest-policy findings buildFocusManifestGuidance emits and the gate can enforce.
  // Path-based manual review lives in settings.hardGuardrailGlobs, not manifest policy.
  const POLICY_FINDINGS = {
    manifest_linked_issue_required: { code: "manifest_linked_issue_required", title: "Maintainer requires a linked issue", severity: "warning" as const, detail: "Manifest requires a linked issue.", action: "Link the issue." },
    manifest_missing_tests: { code: "manifest_missing_tests", title: "Maintainer test expectations unmet", severity: "warning" as const, detail: "Manifest expects test evidence.", action: "Add tests." },
  };

  function manifestAdvisory(code: keyof typeof POLICY_FINDINGS): Advisory {
    return { ...missingIssueAdvisory(), findings: [POLICY_FINDINGS[code]] };
  }

  for (const code of ["manifest_linked_issue_required", "manifest_missing_tests"] as const) {
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

      it("blocks a non-confirmed contributor under manifestPolicy: block, the same as a confirmed one (#gate-nonconfirmed)", () => {
        const result = evaluateGateCheck(manifestAdvisory(code), { manifestPolicyGateMode: "block", confirmedContributor: false });
        expect(result.conclusion).toBe("failure");
        expect(result.blockers.map((finding) => finding.code)).toContain(code);
      });
    });
  }

  it("ignores legacy manifest_blocked_path findings even when manifestPolicy:block is enabled", () => {
    const advisory: Advisory = {
      ...missingIssueAdvisory(),
      findings: [{
        code: "manifest_blocked_path",
        title: "Change touches a maintainer-blocked area",
        severity: "critical",
        detail: "Changed paths match maintainer-blocked patterns.",
        action: "Move out of the blocked area.",
      }],
    };
    const result = evaluateGateCheck(advisory, { manifestPolicyGateMode: "block", confirmedContributor: true });
    expect(result.conclusion).toBe("success");
    expect(result.blockers).toEqual([]);
    expect(result.warnings.map((finding) => finding.code)).not.toContain("manifest_blocked_path");
  });

  it("is an INDEPENDENT dimension: mergeReadiness: block does NOT promote a manifest-policy finding (kept out of the composite)", () => {
    const eff = resolveEffectiveSettings(settings({ manifestPolicyGateMode: "off", mergeReadinessGateMode: "block" }), parseFocusManifest(null));
    expect(evaluateGateCheck(manifestAdvisory("manifest_missing_tests"), gateCheckPolicy(eff, null, true)).conclusion).toBe("success");
  });

  it("gateCheckPolicy threads manifestPolicyGateMode into the policy", () => {
    expect(gateCheckPolicy(settings({ manifestPolicyGateMode: "block" }), null, true).manifestPolicyGateMode).toBe("block");
  });

  it("end-to-end: a manifest gate.manifestPolicy: block sets effective.manifestPolicyGateMode and blocks enforceable manifest policy", () => {
    const eff = resolveEffectiveSettings(settings({ manifestPolicyGateMode: "off" }), parseFocusManifest({ gate: { manifestPolicy: "block" } }));
    expect(eff.manifestPolicyGateMode).toBe("block");
    const result = evaluateGateCheck(manifestAdvisory("manifest_missing_tests"), gateCheckPolicy(eff, null, true));
    expect(result.conclusion).toBe("failure");
    expect(result.blockers.map((finding) => finding.code)).toContain("manifest_missing_tests");
  });
});

describe("resolveLinkedIssueAuthorLogins", () => {
  // Clear the global installation-token cache so each live-fetch test mints deterministically (no cross-test reuse).
  beforeEach(() => clearInstallationTokenCacheForTest());

  it("returns [] immediately for an empty linkedIssues array (no DB work)", async () => {
    const env = createTestEnv();
    const result = await resolveLinkedIssueAuthorLogins(env, null, "owner/repo", []);
    expect(result).toEqual([]);
  });

  it("returns the authorLogin for each linked issue found in the DB", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 1);
    await upsertIssueFromGitHub(env, "owner/repo", { number: 10, title: "Bug report", body: "", state: "open", user: { login: "alice" }, labels: [], html_url: "https://github.com/owner/repo/issues/10", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    await upsertIssueFromGitHub(env, "owner/repo", { number: 11, title: "Feature", body: "", state: "open", user: { login: "bob" }, labels: [], html_url: "https://github.com/owner/repo/issues/11", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });

    const result = await resolveLinkedIssueAuthorLogins(env, null, "owner/repo", [10, 11]);
    expect(result).toEqual(["alice", "bob"]);
  });

  it("returns null for an issue not in the DB (fail-open: unknown author does not trigger the finding)", async () => {
    const env = createTestEnv();
    const result = await resolveLinkedIssueAuthorLogins(env, null, "owner/repo", [99]);
    expect(result).toEqual([null]);
  });

  it("swallows per-issue DB errors and returns null for the erroring issue", async () => {
    const env = createTestEnv();
    // Pass a broken DB binding to force a DB error.
    const brokenEnv = { ...env, DB: null } as unknown as typeof env;
    const result = await resolveLinkedIssueAuthorLogins(brokenEnv, null, "owner/repo", [1]);
    expect(result).toEqual([null]);
  });

  it("falls back to a LIVE fetch for the author when the issue is not cached (#audit-3.11)", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }).toString(), GITHUB_APP_SLUG: "gittensory" });
    // Issue #50 is NOT in the local cache; a fresh GitHub fetch must still resolve its author so the
    // self-authored detection isn't silently voided by a cache miss.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/issues/50")) return Response.json({ number: 50, state: "open", user: { login: "self-farmer" }, labels: [], assignees: [] });
      return new Response("not found", { status: 404 });
    });
    try {
      const result = await resolveLinkedIssueAuthorLogins(env, 123, "owner/repo", [50], true);
      expect(result).toEqual(["self-farmer"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns the cached results unchanged when the live token cannot be minted", async () => {
    clearInstallationTokenCacheForTest(); // ensure the bad-key mint actually runs (no cached token from a prior test)
    // createTestEnv's GITHUB_APP_PRIVATE_KEY is not a real RSA key → the JWT/token mint throws → fail-safe.
    const env = createTestEnv();
    const result = await resolveLinkedIssueAuthorLogins(env, 424242, "owner/repo", [50], true);
    expect(result).toEqual([null]);
  });

  it("yields null for a cache-missed issue whose live fetch returns no facts (fail-safe)", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }).toString(), GITHUB_APP_SLUG: "gittensory" });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      return new Response("not found", { status: 404 }); // the issue fetch 404s → no facts → null
    });
    try {
      const result = await resolveLinkedIssueAuthorLogins(env, 555, "owner/repo", [50], true);
      expect(result).toEqual([null]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("live-fetches only the cache-missed issues, keeping the cached authors (mixed list)", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }).toString(), GITHUB_APP_SLUG: "gittensory" });
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 1);
    await upsertIssueFromGitHub(env, "owner/repo", { number: 10, title: "Cached", body: "", state: "open", user: { login: "alice" }, labels: [], html_url: "https://github.com/owner/repo/issues/10", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.includes("/issues/11")) return Response.json({ number: 11, state: "open", user: { login: "bob" }, labels: [], assignees: [] });
      return new Response("not found", { status: 404 });
    });
    try {
      const result = await resolveLinkedIssueAuthorLogins(env, 123, "owner/repo", [10, 11], true);
      expect(result).toEqual(["alice", "bob"]); // #10 from cache (no fetch), #11 resolved live
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("buildAuthorizedPrActionAdvisory self-authored parity (#self-authored-parity)", () => {
  it("threads linked-issue authors so an authorized PR action blocks a self-authored linked issue", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 1);
    await upsertIssueFromGitHub(env, "owner/repo", { number: 12, title: "Self-authored bug", body: "", state: "open", user: { login: "miner1" }, labels: [], html_url: "https://github.com/owner/repo/issues/12", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    // PR author "Miner1" matches issue author "miner1" case-insensitively → self-authored.
    const pr: PullRequestRecord = { repoFullName: "owner/repo", number: 99, title: "Fix self-authored bug", state: "open", authorLogin: "Miner1", body: "Closes #12", labels: [], linkedIssues: [12] };

    const policy = settings({ selfAuthoredLinkedIssueGateMode: "block" });
    const { advisory } = await buildAuthorizedPrActionAdvisory(env, "owner/repo", pr, policy);
    const gate = evaluateGateCheck(advisory, gateCheckPolicy(policy, null));

    expect(advisory.findings.some((finding) => finding.code === "self_authored_linked_issue")).toBe(true);
    expect(gate.conclusion).toBe("failure");
    expect(gate.blockers.some((finding) => finding.code === "self_authored_linked_issue")).toBe(true);
  });

  it("does not flag a linked issue authored by someone else", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 1);
    await upsertIssueFromGitHub(env, "owner/repo", { number: 13, title: "Reported by another", body: "", state: "open", user: { login: "reporter" }, labels: [], html_url: "https://github.com/owner/repo/issues/13", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    const pr: PullRequestRecord = { repoFullName: "owner/repo", number: 100, title: "Fix reported bug", state: "open", authorLogin: "fixer", body: "Closes #13", labels: [], linkedIssues: [13] };

    const { advisory } = await buildAuthorizedPrActionAdvisory(env, "owner/repo", pr, settings({ selfAuthoredLinkedIssueGateMode: "block" }));
    expect(advisory.findings.some((finding) => finding.code === "self_authored_linked_issue")).toBe(false);
  });

  it("tolerates a repo absent from the DB and a non-blocking mode (no installation id, no live fetch)", async () => {
    const env = createTestEnv();
    // No repository row → getRepository returns null → repo?.installationId ?? null = null; mode !== "block" → no live fetch.
    const pr: PullRequestRecord = { repoFullName: "owner/missing", number: 101, title: "Fix something", state: "open", authorLogin: "someone", body: "Closes #14", labels: [], linkedIssues: [14] };
    const { advisory } = await buildAuthorizedPrActionAdvisory(env, "owner/missing", pr, settings({ selfAuthoredLinkedIssueGateMode: "advisory" }));
    expect(advisory.findings.some((finding) => finding.code === "self_authored_linked_issue")).toBe(false);
  });
});

describe("size + guardrail manual-review HOLD (#gate-size / #gate-guardrail)", () => {
  const clean = (): Advisory => ({ ...missingIssueAdvisory(), findings: [] });
  it("holds (neutral) an oversized PR; passes under thresholds; off/unset = no hold", () => {
    expect(evaluateGateCheck(clean(), { sizeGateMode: "advisory", changedFileCount: 12, changedLineCount: 10 }).conclusion).toBe("neutral"); // > 10 files
    expect(evaluateGateCheck(clean(), { sizeGateMode: "advisory", changedFileCount: 2, changedLineCount: 1000 }).conclusion).toBe("neutral"); // >= 1000 lines
    expect(evaluateGateCheck(clean(), { sizeGateMode: "advisory", changedFileCount: 9, changedLineCount: 999 }).conclusion).toBe("success"); // under both thresholds
    expect(evaluateGateCheck(clean(), { sizeGateMode: "off", changedFileCount: 50, changedLineCount: 9000 }).conclusion).toBe("success"); // gate off ⇒ no hold
    expect(evaluateGateCheck(clean(), { changedFileCount: 50, changedLineCount: 9000 }).conclusion).toBe("success"); // mode unset ⇒ no hold
    expect(evaluateGateCheck(clean(), { sizeGateMode: "advisory" }).conclusion).toBe("success"); // no counts ⇒ 0 ⇒ no hold
  });
  it("holds (neutral) on a guardrail hit, surfacing the hold finding in warnings", () => {
    const out = evaluateGateCheck(clean(), { guardrailHit: true, guardrailMatches: [{ path: "src/settings/agent-actions.ts", glob: "src/settings/**" }] });
    expect(out.conclusion).toBe("neutral");
    const hold = out.warnings.find((w) => w.code === "guardrail_hold");
    expect(hold).toBeTruthy();
    expect(hold?.detail).toContain("src/settings/agent-actions.ts");
    expect(hold?.detail).toContain("src/settings/**");
  });
  it("holds fail-closed when the caller reports a guardrail hit without match details", () => {
    const out = evaluateGateCheck(clean(), { guardrailHit: true });
    const hold = out.warnings.find((w) => w.code === "guardrail_hold");
    expect(out.conclusion).toBe("neutral");
    expect(hold?.detail).toContain("could not be verified");
  });
  it("a real hard blocker WINS over a size/guardrail hold (failure, not neutral)", () => {
    const out = evaluateGateCheck(missingIssueAdvisory(), { linkedIssueGateMode: "block", sizeGateMode: "advisory", changedFileCount: 50, changedLineCount: 9000, guardrailHit: true });
    expect(out.conclusion).toBe("failure");
  });
  it("resolveEffectiveSettings maps gate.size.mode → sizeGateMode", () => {
    const eff = resolveEffectiveSettings(settings({}), parseFocusManifest({ gate: { size: { mode: "advisory" } } }));
    expect(eff.sizeGateMode).toBe("advisory");
  });
});

describe("lockfile-tamper-risk gate blocker (#2563)", () => {
  const lockfileAdvisory = (): Advisory => ({
    ...missingIssueAdvisory(),
    findings: [{ code: "lockfile_tamper_risk", title: "Possible lockfile tamper risk (lodash)", severity: "warning", detail: "resolved/integrity changed without a version bump.", action: "Regenerate the lockfile." }],
  });

  it("blocks (failure) under lockfileIntegrityGateMode: block, confirmed contributor", () => {
    const result = evaluateGateCheck(lockfileAdvisory(), { lockfileIntegrityGateMode: "block", confirmedContributor: true });
    expect(result.conclusion).toBe("failure");
    expect(result.blockers.map((b) => b.code)).toContain("lockfile_tamper_risk");
  });

  it("stays advisory (never blocks) under off (default/unset) or advisory mode", () => {
    expect(evaluateGateCheck(lockfileAdvisory(), {}).conclusion).toBe("success"); // unset ⇒ off
    expect(evaluateGateCheck(lockfileAdvisory(), { lockfileIntegrityGateMode: "off" }).conclusion).toBe("success");
    const advisoryResult = evaluateGateCheck(lockfileAdvisory(), { lockfileIntegrityGateMode: "advisory" });
    expect(advisoryResult.conclusion).toBe("success");
    expect(advisoryResult.warnings.map((w) => w.code)).toContain("lockfile_tamper_risk");
  });

  it("resolveEffectiveSettings maps gate.lockfileIntegrity → lockfileIntegrityGateMode, and gateCheckPolicy threads it", () => {
    const eff = resolveEffectiveSettings(settings({}), parseFocusManifest({ gate: { lockfileIntegrity: "block" } }));
    expect(eff.lockfileIntegrityGateMode).toBe("block");
    expect(gateCheckPolicy(settings({ lockfileIntegrityGateMode: "block" }), null, true).lockfileIntegrityGateMode).toBe("block");
  });
});

describe("dry-run disposition (#gate-dryrun): would-be verdict without enforcing", () => {
  // #disposition-redesign: the dry-run shadow promotes ONLY the AI sub-gate. CLOSE is driven by AI confidence; the
  // advisory signals (linked issue, readiness/quality, slop, duplicates) can NEVER drive a would-be close.
  const aiDefect = (): Advisory => ({
    ...missingIssueAdvisory(),
    findings: [{ code: "ai_consensus_defect", title: "AI consensus defect", severity: "warning", detail: "both models flagged a real defect", action: "fix it" }],
  });
  it("an advisory AI defect previews a would-be close (AI sub-gate is the only one promoted)", () => {
    const out = evaluateGateCheck(aiDefect(), { dryRun: true, aiReviewGateMode: "advisory" });
    expect(out.conclusion).toBe("success"); // POSTED — non-blocking (AI is advisory)
    expect(out.displayConclusion).toBe("failure"); // would-be — drives the "close" verdict in the comment
  });
  it("a MISSING LINKED ISSUE never drives a dry-run close (advisory-only signal)", () => {
    const out = evaluateGateCheck(missingIssueAdvisory(), { dryRun: true, linkedIssueGateMode: "advisory" });
    expect(out.conclusion).toBe("success");
    expect(out.displayConclusion).toBe("success"); // NOT promoted ⇒ no would-be close
  });
  it("a LOW READINESS score never drives a dry-run close (advisory-only signal)", () => {
    const out = evaluateGateCheck({ ...missingIssueAdvisory(), findings: [] }, { dryRun: true, qualityGateMode: "advisory", qualityGateMinScore: 70, readinessScore: 40 });
    expect(out.displayConclusion).toBe("success"); // readiness is advisory-only, never promoted to a close
  });
  it("a clean PR in dry-run shows a would-be PASS (displayConclusion = success)", () => {
    const clean = { ...missingIssueAdvisory(), findings: [] };
    expect(evaluateGateCheck(clean, { dryRun: true, aiReviewGateMode: "advisory" }).displayConclusion).toBe("success");
  });
  it("outside dry-run, displayConclusion is absent (the verdict falls back to the posted conclusion)", () => {
    const out = evaluateGateCheck(aiDefect(), { aiReviewGateMode: "advisory" });
    expect(out.conclusion).toBe("success");
    expect(out.displayConclusion).toBeUndefined();
  });
  it("resolveEffectiveSettings maps gate.dryRun → gateDryRun", () => {
    const eff = resolveEffectiveSettings(settings({}), parseFocusManifest({ gate: { dryRun: true } }));
    expect(eff.gateDryRun).toBe(true);
  });
});
