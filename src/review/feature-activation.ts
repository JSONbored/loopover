// Shared per-PR advisory-feature activation resolver (#4616, generalizing the phase-2 per-repo migration this
// file originally shipped for just the `features:`-block keys).
//
// Before this file existed, each feature ran when `isXEnabled(env)` (a global env flag) AND
// `isConvergenceRepoAllowed(env, repo)` (the LOOPOVER_REVIEW_REPOS allowlist) were both true — coarse,
// all-or-nothing per repo, configured only via env. `resolveConvergedFeature` replaced that for the six
// `features:`-block keys (now seven, see below) with a per-repo `.gittensory.yml` override. But that migration
// left ~10 OTHER per-PR advisory capabilities (screenshots, impactMap, reviewMemory, cultureProfile,
// inlineComments, fixHandoff, …) each re-implementing their OWN hand-rolled version of the same boolean
// arithmetic outside this file, with at least four subtly different precedence shapes and no single place
// documenting which feature uses which (#4616's config-sprawl audit finding — already the root cause of one
// production incident, see GITTENSORY_PUBLIC_STATS_REPOS's doc comment in env.d.ts).
//
// `resolveFeatureActivation` below is now the ONE pure core every one of those precedence shapes reduces to.
// `resolveConvergedFeature` and `resolveManifestOnlyFeature` are the two thin adapters over it in actual use:
//   - `resolveConvergedFeature` — the `features:`-block keys (rag/reputation/unifiedComment/safety/grounding/
//     e2eTests/screenshots): env kill-switch → per-repo `features:` override → `LOOPOVER_REVIEW_REPOS`
//     allowlist default. Safety, grounding, and screenshots are the named exceptions this shape has; see
//     `FEATURE_MODE` below.
//   - `resolveManifestOnlyFeature` — the `review:`-block keys with NO allowlist role at all (impactMap /
//     reviewMemory / cultureProfile / inlineComments / fixHandoff): env kill-switch → an EXPLICIT per-repo
//     `review.*` opt-in is the only way to activate. These live under a different `.gittensory.yml` namespace
//     (`review:`, not `features:`) than the seven `ConvergedFeatureKey`s above, so they were never candidates
//     for literally becoming `ConvergedFeatureKey`s — renaming an operator's existing yml key would itself be a
//     behavior break — but they share the exact same underlying arithmetic as "standard" mode with the
//     allowlist input pinned to `false` (a `manifestOnly` feature can never be force-activated by
//     LOOPOVER_REVIEW_REPOS the way its `features:`-block cousins can).
//
// `convergedFeatureActive` is the async convenience that loads the cached focus manifest itself for
// `resolveConvergedFeature`'s callers that don't already hold one.
import { isConvergenceRepoAllowed } from "./cutover-gate";
import { isE2eTestGenerationEnabled } from "./e2e-test-gen-wire";
import { isGroundingEnabled } from "./grounding-wire";
import { isImprovementSignalEnabled } from "./improvement-signal-wire";
import { isRagEnabled } from "./rag-wire";
import { isReputationEnabled } from "./reputation-wire";
import { isSafetyEnabled } from "./safety";
import { isUnifiedReviewCommentEnabled } from "./unified-comment-bridge";
import { isScreenshotsEnabled } from "./visual-wire";
import type { ConvergedFeatureKey, FocusManifest } from "../signals/focus-manifest";
import { loadRepoFocusManifest } from "../signals/focus-manifest-loader";

/**
 * The four per-feature activation precedence shapes actually in use across gittensory's advisory review
 * capabilities (#4616):
 *  - `"standard"`: `override` fully controls (`true` forces on, `false` forces off); `null` (unset) falls back
 *    to `allowlisted`. rag / reputation / unifiedComment / e2eTests / improvementSignal.
 *  - `"forceOnOnly"`: `override` can only force ON (bypassing the allowlist); an untrusted `false` is "no
 *    opinion" and falls through to `allowlisted` — for a feature where a lower-trust, repo-controlled override
 *    must never be able to silently defeat the operator's own enablement. safety (#2269).
 *  - `"allowlistRequired"`: `allowlisted` is a hard requirement regardless of `override`; an override may
 *    ADDITIONALLY force OFF within an allowlisted repo, never force ON outside it. grounding (fetches full
 *    post-change file contents for the AI prompt) and screenshots (launches browser rendering and stores
 *    publicly embedded images), so a repo override alone must never bypass the operator's own allowlist.
 *  - `"manifestOnly"`: there is no allowlist role at all (`allowlisted` is never consulted); an explicit
 *    `override === true` is the ONLY way to activate. impactMap / reviewMemory / cultureProfile /
 *    inlineComments / fixHandoff — each shipped as an explicit-opt-in-only `.gittensory.yml` `review.*` toggle
 *    from day one, with no `LOOPOVER_REVIEW_REPOS` role ever defined for it (see
 *    {@link resolveManifestOnlyFeature}).
 */
export type FeatureActivationMode = "standard" | "forceOnOnly" | "allowlistRequired" | "manifestOnly";

/**
 * The single pure precedence core (#4616) every per-PR advisory-feature activation check in this codebase now
 * shares — env kill-switch, then a per-repo override, then (for two of the four modes) an allowlist default.
 * Deliberately takes already-resolved primitives, not `Env` or a raw `FocusManifest`, specifically so a future
 * per-tenant resolution path (e.g. a tenant DB row standing in for the global env var, or a tenant's own
 * allowlist standing in for `LOOPOVER_REVIEW_REPOS`) can supply the same three booleans without this
 * function — or either of its two callers' precedence logic below — changing at all.
 */
export function resolveFeatureActivation(globalFlagOn: boolean, override: boolean | null, allowlisted: boolean, mode: FeatureActivationMode): boolean {
  if (!globalFlagOn) return false; // master kill-switch — off ⇒ false regardless of override, allowlist, or mode
  if (mode === "forceOnOnly") return override === true || allowlisted;
  if (mode === "allowlistRequired") return allowlisted && override !== false;
  if (mode === "manifestOnly") return override === true;
  return override ?? allowlisted; // "standard"
}

/** The master kill-switch (global env flag) for each converged feature, keyed by the manifest `features:` key. */
const FEATURE_GLOBAL_FLAG: Record<ConvergedFeatureKey, (env: Env) => boolean> = {
  rag: isRagEnabled,
  reputation: isReputationEnabled,
  unifiedComment: isUnifiedReviewCommentEnabled,
  safety: isSafetyEnabled,
  grounding: isGroundingEnabled,
  e2eTests: isE2eTestGenerationEnabled,
  screenshots: isScreenshotsEnabled,
  improvementSignal: isImprovementSignalEnabled,
};

/** The named per-feature exceptions to `resolveConvergedFeature`'s default `"standard"` precedence — every
 *  `ConvergedFeatureKey` not listed here uses `"standard"`. See {@link FeatureActivationMode}'s doc comment for
 *  why each of these features needs its own asymmetric shape. */
const FEATURE_MODE: Partial<Record<ConvergedFeatureKey, FeatureActivationMode>> = {
  safety: "forceOnOnly",
  grounding: "allowlistRequired",
  screenshots: "allowlistRequired",
};

/**
 * Resolve whether a converged feature is active for a repo, given the already-loaded manifest (or null). Pure +
 * synchronous so it carries no I/O and is the single unit-tested place the `features:`-block precedence lives
 * (delegating the actual arithmetic to {@link resolveFeatureActivation}). Precedence: env kill-switch (off ⇒
 * false) → per-repo `features:` override → `LOOPOVER_REVIEW_REPOS` allowlist default. `safety` is asymmetric:
 * an override can only force it ON, never force it OFF (#2269). `grounding` and `screenshots` are asymmetric in
 * the opposite direction: a repo override can only force them OFF, never bypass the operator allowlist.
 */
export function resolveConvergedFeature(
  env: Env,
  manifest: Pick<FocusManifest, "features"> | null | undefined,
  feature: ConvergedFeatureKey,
  repoFullName: string,
): boolean {
  const globalFlagOn = FEATURE_GLOBAL_FLAG[feature](env);
  if (!globalFlagOn) return false; // master kill-switch — short-circuits before the allowlist check below
  const override = manifest?.features?.[feature] ?? null;
  const allowlisted = isConvergenceRepoAllowed(env, repoFullName);
  return resolveFeatureActivation(globalFlagOn, override, allowlisted, FEATURE_MODE[feature] ?? "standard");
}

/**
 * Resolve a "manifest-only" advisory feature (#4616): the operator's global env kill-switch AND an EXPLICIT
 * per-repo `.gittensory.yml` `review.*` opt-in — no `LOOPOVER_REVIEW_REPOS` allowlist role at all. Shared by
 * every `review:`-block feature that was never given an allowlist fallback: impactMap (`shouldComputeImpactMap`,
 * impact-map-wire.ts), reviewMemory (`shouldApplyReviewMemory`, review-memory-wire.ts), cultureProfile
 * (`shouldApplyRepoCultureProfile`, repo-culture-profile-wire.ts), inlineComments (`shouldRequestInlineFindings`,
 * inline-comments.ts, #4099), and fixHandoff (`shouldEmitFixHandoff`, fix-handoff.ts, #4099). `override` accepts
 * `undefined` (in addition to the pure core's `boolean | null`) purely so callers can pass a manifest field
 * straight through without normalizing it first — `undefined` and `null` are both "unset" here, identically to
 * every one of those five wire modules' own prior, independently-hand-rolled `=== true` check.
 */
export function resolveManifestOnlyFeature(globalFlagOn: boolean, override: boolean | null | undefined): boolean {
  return resolveFeatureActivation(globalFlagOn, override ?? null, false, "manifestOnly");
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
