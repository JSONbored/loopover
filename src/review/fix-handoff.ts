// Fix-handoff blocks (#2176, config slice for #1962) — copy-paste remediation guidance the reviewer can emit
// ALONGSIDE the decision summary. Default OFF: the operator flag LOOPOVER_REVIEW_FIX_HANDOFF is a master
// kill-switch, and the per-repo `.gittensory.yml` review.fixHandoff toggle (#4099) fully controls activation by
// itself when explicitly set — the per-repo convergence cutover allowlist no longer applies to this feature (an
// unset manifest toggle preserves the ORIGINAL always-off default; it was never sufficient to be allowlisted
// alone). This is the config/gate slice: pure resolvers only — no emission/render here (that is a separate
// slice), so the gate/verdict is never touched. `shouldEmitFixHandoff` is the "manifestOnly" precedence shape
// (#4616) — see `resolveManifestOnlyFeature`/`FeatureActivationMode` in `./feature-activation` for the shared
// core this, and four sibling `review:`-block features, now delegate to.

import { resolveManifestOnlyFeature } from "./feature-activation";

/** True when the operator enabled fix-handoff globally. Flag-OFF (default) ⇒ the caller never emits fix-handoff
 *  blocks. Truthy follows the codebase convention (same regex as isInlineCommentsEnabled). */
export function isFixHandoffEnabled(env: {
  LOOPOVER_REVIEW_FIX_HANDOFF?: string | undefined;
}): boolean {
  return /^(1|true|yes|on)$/i.test((env.LOOPOVER_REVIEW_FIX_HANDOFF ?? "").trim());
}

/** PURE (#4099): should the reviewer emit fix-handoff blocks for this PR? (1) The operator's
 *  LOOPOVER_REVIEW_FIX_HANDOFF flag is an absolute MASTER KILL-SWITCH — off ⇒ always false, regardless of the
 *  manifest, and no per-repo config can bypass it (consistent with every other converged feature — see
 *  `resolveConvergedFeature` in `feature-activation.ts`). (2) An explicit per-repo `.gittensory.yml`
 *  `review.fixHandoff` override (`true`/`false`) now FULLY controls the feature by itself — a repo can turn this
 *  on without needing the LOOPOVER_REVIEW_REPOS cutover allowlist at all. (3) `manifestToggle` unset
 *  (`undefined`) preserves this feature's ORIGINAL design exactly: being on the allowlist alone was never
 *  sufficient, so this stays `false` regardless of the allowlist, byte-identical to every repo's behavior before
 *  this change. Exactly mirrors `shouldRequestInlineFindings`'s shape and precedence (both are now the SAME
 *  `resolveManifestOnlyFeature` call, #4616). `repoFullName` is kept for a stable call signature even though
 *  it's unused now that the allowlist no longer applies here. */
export function shouldEmitFixHandoff(
  // LOOPOVER_REVIEW_REPOS is accepted (not just LOOPOVER_REVIEW_FIX_HANDOFF) purely for call-site signature
  // stability with existing callers/tests that pass a wider env object -- it's no longer read, see the doc
  // comment above.
  env: { LOOPOVER_REVIEW_FIX_HANDOFF?: string | undefined; LOOPOVER_REVIEW_REPOS?: string | undefined },
  repoFullName: string,
  manifestToggle: boolean | undefined,
): boolean {
  void repoFullName; // kept for call-site signature stability, see doc comment above
  return resolveManifestOnlyFeature(isFixHandoffEnabled(env), manifestToggle);
}
