import { matchesManifestPath, type PreMergeCheck } from "../focus-manifest/guidance.js";
import type { AdvisoryFinding } from "../types/predicted-gate-types.js";

/** Finding code for a FAILED advisory (default) pre-merge check — surfaced but NEVER blocks. */
export const PRE_MERGE_CHECK_ADVISORY_CODE = "pre_merge_check_failed";
/** Finding code for a FAILED pre-merge check the maintainer marked `enforce: true` — a hard gate blocker
 *  (isConfiguredGateBlocker treats this code as blocking, like secret_leak). */
export const PRE_MERGE_CHECK_BLOCKING_CODE = "pre_merge_check_required";
/** Finding code emitted when an ENFORCED `whenPaths`-gated check cannot be evaluated because the PR's changed-file
 *  set could not be resolved. isEvaluationBlocker (advisory.ts) treats this as a NEUTRAL gate (HELD, re-evaluates
 *  automatically) — never silently skipping a hard requirement (auto-merge bypass) and never hard-closing the
 *  contributor on a transient resolution miss. (#review-audit) */
export const PRE_MERGE_CHECK_UNRESOLVED_CODE = "pre_merge_check_unresolved";

/**
 * Evaluate the maintainer's `.gittensory.yml review.pre_merge_checks` against a PR — DETERMINISTICALLY, with no AI
 * judgment. A check with `whenPaths` applies only when a changed path matches; it PASSES only when EVERY configured
 * assertion holds (the title contains `titleContains`, the body contains `descriptionContains`, and the
 * `requireLabel` label is present — all case-insensitive). Each FAILED check yields ONE finding:
 * `pre_merge_check_required` (severity critical → the gate blocks under enforce) or `pre_merge_check_failed`
 * (severity warning → advisory). Pure + side-effect-free; the caller pushes the findings into the advisory before
 * the gate evaluates. Empty `checks` ⇒ no findings (byte-identical).
 */
export function evaluatePreMergeChecks(
  checks: PreMergeCheck[],
  ctx: { title?: string | null | undefined; body?: string | null | undefined; labels?: string[] | null | undefined; changedPaths: string[]; filesResolved?: boolean | undefined },
): AdvisoryFinding[] {
  const title = (ctx.title ?? "").toLowerCase();
  const body = (ctx.body ?? "").toLowerCase();
  const labels = (ctx.labels ?? []).map((label) => label.toLowerCase());
  const filesResolved = ctx.filesResolved ?? true; // absent ⇒ caller asserts a trustworthy changedPaths set
  const findings: AdvisoryFinding[] = [];
  for (const check of checks) {
    // when_paths gate: a check with whenPaths applies ONLY to PRs that touch a matching path; an unmatched check
    // is N/A (no finding). Empty whenPaths ⇒ the check always applies (title/description/label only).
    if (check.whenPaths.length > 0) {
      if (!filesResolved) {
        // The changed-file set could not be resolved, so we cannot evaluate this path gate. HOLD the gate for an
        // ENFORCED check (re-evaluates when files resolve) instead of silently skipping a hard requirement (which
        // would let a guarded PR auto-merge). An advisory check is just dropped (no noise on a transient miss).
        if (check.enforce)
          findings.push({
            code: PRE_MERGE_CHECK_UNRESOLVED_CODE,
            severity: "warning",
            title: `Pre-merge check held — changed files not resolved: ${check.name}`,
            detail: `LoopOver could not resolve this PR's changed files to evaluate the path-gated check "${check.name}"; the gate is held and re-evaluates automatically.`,
            action: "No action needed — the gate re-evaluates once the PR's files are available.",
          });
        continue;
      }
      if (!ctx.changedPaths.some((path) => check.whenPaths.some((glob) => matchesManifestPath(path, glob)))) continue;
    }
    const unmet: string[] = [];
    if (check.titleContains !== null && !title.includes(check.titleContains.toLowerCase())) unmet.push(`the title must contain "${check.titleContains}"`);
    if (check.descriptionContains !== null && !body.includes(check.descriptionContains.toLowerCase())) unmet.push(`the description must contain "${check.descriptionContains}"`);
    if (check.requireLabel !== null && !labels.includes(check.requireLabel.toLowerCase())) unmet.push(`the "${check.requireLabel}" label must be applied`);
    if (unmet.length === 0) continue; // every configured assertion held → the check passed
    findings.push({
      code: check.enforce ? PRE_MERGE_CHECK_BLOCKING_CODE : PRE_MERGE_CHECK_ADVISORY_CODE,
      severity: check.enforce ? "critical" : "warning",
      title: `Pre-merge check not satisfied: ${check.name}`,
      detail: `This PR does not satisfy the maintainer pre-merge check "${check.name}": ${unmet.join("; ")}.`,
      action: "Update the PR to satisfy the check, then re-run the gate.",
    });
  }
  return findings;
}
