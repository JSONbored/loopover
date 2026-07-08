// Per-repo activation resolver for the converged review features (phase 2 of the per-repo migration).
//
// Before: each feature ran when `isXEnabled(env)` (a global env flag) AND `isConvergenceRepoAllowed(env, repo)`
// (the GITTENSORY_REVIEW_REPOS allowlist) were both true — coarse, all-or-nothing per repo, and configured only
// via env. Now a self-host operator toggles features individually PER REPO in the container-private `.gittensory.yml`
// (`features:` block). The precedence, highest to lowest:
//   1. GLOBAL env flag (GITTENSORY_REVIEW_*) — a MASTER KILL-SWITCH. Off ⇒ the feature never runs anywhere,
//      regardless of any per-repo override (so an operator keeps one deploy-wide off switch per feature).
//   2. Per-repo `features:` override — `true`/`false` forces the feature on/off for this repo. EXCEPTIONS:
//      `safety` (prompt-injection defanging) is security-critical and `.gittensory.yml` lives in the repo
//      itself, writable by a lower-trust actor than the operator — so a repo override may only TIGHTEN
//      (force-on) the operator's global enablement, never loosen it. `features.safety: false` is treated as
//      "no opinion" (falls through to the allowlist default below) rather than an active force-off (#2269).
//      `grounding` can fetch full post-change file contents for the AI prompt, so the operator allowlist remains
//      mandatory; a repo override may only disable grounding inside that allowlist.
//   3. `GITTENSORY_REVIEW_REPOS` allowlist — the back-compat DEFAULT when the manifest says nothing, so a repo
//      that sets no `features:` block behaves exactly as it did before this change.
//
// `resolveConvergedFeature` is the pure core (takes the already-loaded manifest). `convergedFeatureActive` is the
// async convenience that loads the cached focus manifest itself — used at call sites that don't already hold one.
import { isConvergenceRepoAllowed } from "./cutover-gate";
import { isE2eTestGenerationEnabled } from "./e2e-test-gen-wire";
import { isGroundingEnabled } from "./grounding-wire";
import { isRagEnabled } from "./rag-wire";
import { isReputationEnabled } from "./reputation-wire";
import { isSafetyEnabled } from "./safety";
import { isUnifiedReviewCommentEnabled } from "./unified-comment-bridge";
import type { ConvergedFeatureKey, FocusManifest } from "../signals/focus-manifest";
import { loadRepoFocusManifest } from "../signals/focus-manifest-loader";

/** The master kill-switch (global env flag) for each converged feature, keyed by the manifest `features:` key. */
const FEATURE_GLOBAL_FLAG: Record<ConvergedFeatureKey, (env: Env) => boolean> = {
  rag: isRagEnabled,
  reputation: isReputationEnabled,
  unifiedComment: isUnifiedReviewCommentEnabled,
  safety: isSafetyEnabled,
  grounding: isGroundingEnabled,
  e2eTests: isE2eTestGenerationEnabled,
};

/**
 * Resolve whether a converged feature is active for a repo, given the already-loaded manifest (or null). Pure +
 * synchronous so it carries no I/O and is the single unit-tested place the precedence lives. Precedence: env
 * kill-switch (off ⇒ false) → per-repo `features:` override → `GITTENSORY_REVIEW_REPOS` allowlist default.
 * `safety` is asymmetric: an override can only force it ON, never force it OFF (#2269). `grounding` is also
 * asymmetric in the opposite direction: a repo override can only force it OFF, never bypass the operator allowlist.
 */
export function resolveConvergedFeature(
  env: Env,
  manifest: Pick<FocusManifest, "features"> | null | undefined,
  feature: ConvergedFeatureKey,
  repoFullName: string,
): boolean {
  if (!FEATURE_GLOBAL_FLAG[feature](env)) return false; // master kill-switch
  const override = manifest?.features?.[feature] ?? null;
  // Security-critical: a repo-controlled override must not silently defeat the operator's global enablement.
  // `false` is downgraded to "no opinion" so it falls through to the allowlist default instead of forcing off.
  const allowlisted = isConvergenceRepoAllowed(env, repoFullName);
  if (feature === "safety") return override === true || allowlisted;
  if (feature === "grounding") return allowlisted && override !== false;
  if (override !== null) return override; // explicit per-repo on/off
  return allowlisted; // back-compat allowlist default
}

/**
 * Async convenience: resolve a converged feature for a repo, loading the (cached) focus manifest internally.
 * Short-circuits BEFORE the manifest load when the env kill-switch is off, so a globally-disabled feature pays
 * no I/O. The manifest load is fail-safe (a read error degrades to null ⇒ the allowlist default applies).
 */
export async function convergedFeatureActive(env: Env, repoFullName: string, feature: ConvergedFeatureKey): Promise<boolean> {
  if (!FEATURE_GLOBAL_FLAG[feature](env)) return false; // no manifest load when globally off
  const manifest = await loadRepoFocusManifest(env, repoFullName).catch(() => null);
  return resolveConvergedFeature(env, manifest, feature, repoFullName);
}
