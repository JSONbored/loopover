// Convergence (PR improvement signal, #4738, foundation phase of the #4737 epic): the master kill-switch for the
// `improvementSignal` converged feature -- a read-only, ADVISORY quality-delta signal that is the positive-axis
// counterpart to src/signals/slop.ts's risk-only score (see #4737 for the full design). This file is deliberately
// minimal for now (just the env flag), mirroring the shape of `e2e-test-gen-wire.ts`/`rag-wire.ts` at the same
// stage of their own rollout -- the deterministic (REES) tier, the LLM tier, and panel surfacing land in later,
// separate sub-issues (#4739-#4746) once this flag exists for them to gate on. This PR wires activation only:
// nothing calls resolveConvergedFeature(env, manifest, "improvementSignal", repoFullName) yet outside this
// feature's own tests.
//
// Single env switch: LOOPOVER_REVIEW_IMPROVEMENT_SIGNAL. Default OFF (unset/"false") -- when OFF the feature
// never runs anywhere, regardless of any per-repo `.gittensory.yml` override (see `resolveConvergedFeature` in
// `./feature-activation`). Truthy follows the codebase convention (`/^(1|true|yes|on)$/i`, same as
// isRagEnabled / isE2eTestGenerationEnabled).

/** True when the PR improvement signal is enabled at the deployment level. Flag-OFF (default) → the feature is
 *  never active for any repo, regardless of a per-repo `features.improvementSignal` override. */
export function isImprovementSignalEnabled(env: {
  LOOPOVER_REVIEW_IMPROVEMENT_SIGNAL?: string | undefined;
}): boolean {
  return /^(1|true|yes|on)$/i.test((env.LOOPOVER_REVIEW_IMPROVEMENT_SIGNAL ?? "").trim());
}
