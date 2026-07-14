import type { AdvisoryFinding } from "../types/predicted-gate-types.js";

/** Finding code raised when `gate.claMode` is opted in (advisory/block) and neither configured detection method
 *  (the PR body consent phrase, or the named CLA-bot check-run) confirms consent. ALWAYS severity "warning" at
 *  generation time — mirrors `manifest_missing_tests`/`manifest_linked_issue_required` (focus-manifest.ts): a
 *  single finding code whose escalation to a hard blocker is decided entirely by the configured gate MODE
 *  (isConfiguredGateBlocker, src/rules/advisory.ts), not by this evaluator. */
export const CLA_CONSENT_MISSING_CODE = "cla_consent_missing";
/** Finding code emitted when check-run detection is the ONLY configured method and its conclusion could not be
 *  resolved (a transient fetch failure, not a resolved "no such check-run"). Mirrors `pre_merge_check_unresolved`
 *  (review/pre-merge-checks.ts): isEvaluationBlocker (advisory.ts) treats this as a NEUTRAL gate (HELD,
 *  re-evaluates automatically) — never silently skipping a hard requirement and never hard-closing the
 *  contributor on a transient resolution miss. */
export const CLA_CHECK_UNRESOLVED_CODE = "cla_check_unresolved";

export type ClaCheckConfig = {
  /** Public-safe-filtered consent phrase a maintainer requires somewhere in the PR body (case-insensitive
   *  substring match), e.g. "I have read and agree to the CLA". `null` ⇒ phrase-match detection is not configured. */
  consentPhrase: string | null;
  /** Name of a separate CLA-bot check-run this repo also runs (e.g. "CLA Assistant Lite"). When set, a
   *  `success`/`neutral` conclusion for a check-run with this exact name (case-insensitive) also satisfies
   *  consent. `null` ⇒ check-run detection is not configured. */
  checkRunName: string | null;
};

/**
 * Evaluate `.gittensory.yml gate.claMode` + `gate.cla` (consentPhrase / checkRunName) against a PR —
 * DETERMINISTICALLY, mirroring the pre-merge-checks title/description phrase-match pattern (review/pre-merge-checks.ts)
 * exactly: a case-insensitive substring match against already-resolved PR data, no AI judgment. Consent is
 * satisfied when EITHER configured method holds (an "either" contract, not "all", because a repo may only be able
 * to detect ONE method for a given PR — e.g. no check-run data was resolved): the PR body contains
 * `consentPhrase`, OR a check-run named `checkRunName` concluded `success`/`neutral`. When NEITHER method is
 * configured (both null), there is nothing to evaluate — no finding (byte-identical, matches `pre_merge_checks`'
 * empty-checks behavior).
 *
 * `checkRunConclusion` is `undefined` when the caller could not resolve check-run data at all (a transient
 * fetch failure, or the predicted-gate metadata-only path, which never sees live check-runs) — that is NOT the
 * same as a resolved-but-absent check-run (`null`, "no check-run with this name exists"). When check-run
 * detection is configured and its conclusion is unresolved (a transient fetch failure, or "not yet run"), this
 * HOLDS (`cla_check_unresolved`) instead of failing closed — exactly like an unresolved changed-file set HOLDS
 * a path-gated pre-merge check rather than silently skipping (auto-merge bypass) or hard-closing on a
 * transient miss. This applies EVEN WHEN `consentPhrase` is ALSO configured but not (yet) satisfied: per the
 * "either method holds ⇒ satisfied" contract above, an unresolved check-run might still satisfy consent, so
 * deciding purely from a not-yet-satisfied phrase would hard-fail a PR the check-run could have saved (#2564
 * gate-review finding). A hold only degrades to a hard `cla_consent_missing` once EVERY configured method has
 * been definitively resolved and none of them is satisfied. Pure + side-effect-free; the caller pushes the
 * finding into the advisory before the gate evaluates.
 */
export function evaluateClaCheck(
  config: ClaCheckConfig,
  ctx: { body?: string | null | undefined; checkRunConclusion?: string | null | undefined },
): AdvisoryFinding[] {
  if (config.consentPhrase === null && config.checkRunName === null) return []; // nothing configured ⇒ no finding
  const phraseSatisfied = config.consentPhrase !== null && (ctx.body ?? "").toLowerCase().includes(config.consentPhrase.toLowerCase());
  const checkRunSatisfied = config.checkRunName !== null && (ctx.checkRunConclusion === "success" || ctx.checkRunConclusion === "neutral");
  if (phraseSatisfied || checkRunSatisfied) return [];
  // A configured check-run whose conclusion is unresolved: cannot confirm OR deny consent via that method, so
  // HOLD rather than fail closed — regardless of whether consentPhrase is ALSO configured (a not-yet-satisfied
  // phrase does not mean consent is definitively absent while the check-run could still satisfy it).
  if (config.checkRunName !== null && ctx.checkRunConclusion === undefined) {
    return [
      {
        code: CLA_CHECK_UNRESOLVED_CODE,
        severity: "warning",
        title: `CLA check held — "${config.checkRunName}" not resolved`,
        detail: `LoopOver could not resolve the "${config.checkRunName}" check-run's conclusion for this PR; the gate is held and re-evaluates automatically.`,
        action: "No action needed — the gate re-evaluates once the check-run's conclusion is available.",
      },
    ];
  }
  const missing: string[] = [];
  if (config.consentPhrase !== null) missing.push(`the PR description must contain "${config.consentPhrase}"`);
  if (config.checkRunName !== null) missing.push(`the "${config.checkRunName}" check must pass`);
  return [
    {
      code: CLA_CONSENT_MISSING_CODE,
      severity: "warning",
      title: "CLA consent not confirmed",
      detail: `This PR does not confirm contributor license agreement consent: ${missing.join(" or ")}.`,
      action: "Add the required CLA consent phrase to the PR description, or complete the CLA check, then re-run the gate.",
    },
  ];
}
