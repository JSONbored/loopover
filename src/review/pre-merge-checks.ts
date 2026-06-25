import { matchesManifestPath, type PreMergeCheck } from "../signals/focus-manifest";
import type { AdvisoryFinding } from "../types";

/** Finding code for a FAILED advisory (default) pre-merge check — surfaced but NEVER blocks. */
export const PRE_MERGE_CHECK_ADVISORY_CODE = "pre_merge_check_failed";
/** Finding code for a FAILED pre-merge check the maintainer marked `enforce: true` — a hard gate blocker
 *  (isConfiguredGateBlocker treats this code as blocking, like secret_leak). */
export const PRE_MERGE_CHECK_BLOCKING_CODE = "pre_merge_check_required";

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
  ctx: { title?: string | null | undefined; body?: string | null | undefined; labels?: string[] | null | undefined; changedPaths: string[] },
): AdvisoryFinding[] {
  const title = (ctx.title ?? "").toLowerCase();
  const body = (ctx.body ?? "").toLowerCase();
  const labels = (ctx.labels ?? []).map((label) => label.toLowerCase());
  const findings: AdvisoryFinding[] = [];
  for (const check of checks) {
    // when_paths gate: a check with whenPaths applies ONLY to PRs that touch a matching path; an unmatched check
    // is N/A (no finding). Empty whenPaths ⇒ the check always applies.
    if (check.whenPaths.length > 0 && !ctx.changedPaths.some((path) => check.whenPaths.some((glob) => matchesManifestPath(path, glob)))) continue;
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
