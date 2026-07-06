// Fix-handoff blocks (#2176, config slice for #1962) — copy-paste remediation guidance the reviewer can emit
// ALONGSIDE the decision summary. Default OFF at every layer, mirroring the inline-comments precedent: the operator
// flag GITTENSORY_REVIEW_FIX_HANDOFF, the per-repo convergence cutover allowlist, AND the per-repo `.gittensory.yml`
// review.fixHandoff toggle are ALL ANDed before a fix-handoff block is ever emitted. This is the config/gate slice:
// pure resolvers only — no emission/render here (that is a separate slice), so the gate/verdict is never touched.

import { isConvergenceRepoAllowed } from "./cutover-gate";

/** True when the operator enabled fix-handoff globally. Flag-OFF (default) ⇒ the caller never emits fix-handoff
 *  blocks. Truthy follows the codebase convention (same regex as isInlineCommentsEnabled). */
export function isFixHandoffEnabled(env: { GITTENSORY_REVIEW_FIX_HANDOFF?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test(env.GITTENSORY_REVIEW_FIX_HANDOFF ?? "");
}

/** PURE: should the reviewer emit fix-handoff blocks for this PR? True ONLY when ALL THREE gates pass — the per-repo
 *  `.gittensory.yml` toggle (`manifestToggle`), the operator flag, AND the convergence cutover allowlist — so the
 *  feature is off by default at every layer. Mirrors shouldRequestInlineFindings, keeping the three-way gate in one
 *  unit-testable place. */
export function shouldEmitFixHandoff(
  env: { GITTENSORY_REVIEW_FIX_HANDOFF?: string | undefined; GITTENSORY_REVIEW_REPOS?: string | undefined },
  repoFullName: string,
  manifestToggle: boolean | undefined,
): boolean {
  return manifestToggle === true && isFixHandoffEnabled(env) && isConvergenceRepoAllowed(env, repoFullName);
}
