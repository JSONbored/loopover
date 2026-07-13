// Repo quality-culture profile wiring (#2995): feeds the AI reviewer a compact, additive grounding block
// derived from the repo's OWN merge history (typical PR size, common accepted labels) so a verdict reads as
// grounded in how THIS repo actually operates, instead of generic boilerplate. Exactly the same shape/seam as
// `./rag-wire.ts` (retrieval) and `./grounding-wire.ts` (CI/file grounding): a thin HOST adapter over the
// self-contained, fixture-testable extractor (`./repo-culture-profile.ts`), splicing a pre-formatted block into
// the reviewer's USER prompt as reference context only.
//
// Two independent switches, same precedence as every other converged review knob in this codebase (see
// `review/feature-activation.ts`'s doc comment): a GLOBAL env kill-switch (LOOPOVER_REVIEW_CULTURE_PROFILE,
// default OFF) gates whether the capability exists AT ALL, and the per-repo `.gittensory.yml`
// `review.culture_profile` boolean (see signals/focus-manifest.ts) opts a specific repo in once the global
// switch is on. Both default OFF/absent ⇒ this module is never invoked, no D1 read happens, and the reviewer
// prompt is byte-identical to today. `shouldApplyRepoCultureProfile` is the "manifestOnly" precedence shape
// (#4616) — see `resolveManifestOnlyFeature`/`FeatureActivationMode` in `./feature-activation` for the shared
// core this, and four sibling `review:`-block features, now delegate to.
//
// ADVISORY GROUNDING ONLY (house rule + #2995 requirement): this NEVER becomes a gate/scoring input. It only
// ever appends a reference-only block to the AI reviewer's USER prompt, exactly like the RAG/grounding/
// enrichment sections it sits alongside in `services/ai-review.ts`'s buildUserPrompt.
import { resolveManifestOnlyFeature } from "./feature-activation";
import { extractRepoCultureProfile, type RepoCultureProfile } from "./repo-culture-profile";
import { neutralizePromptInjection } from "./prompt-injection";

/** True when the culture-profile grounding capability is enabled at all. Flag-OFF (default) → the per-repo
 *  override below is never even consulted (mirrors isRagEnabled / isGroundingEnabled / isReputationEnabled). */
export function isRepoCultureProfileEnabled(env: {
  LOOPOVER_REVIEW_CULTURE_PROFILE?: string | undefined;
}): boolean {
  return /^(1|true|yes|on)$/i.test((env.LOOPOVER_REVIEW_CULTURE_PROFILE ?? "").trim());
}

/** Resolve whether culture-profile grounding should apply for THIS repo/PR: the operator's global env
 *  kill-switch AND the per-repo manifest opt-in. Neither alone is sufficient — mirrors
 *  `shouldComputeImpactMap` / `shouldApplyReviewMemory` (#4616), the same "manifestOnly" shape. Previously
 *  inlined at each of its two call sites in src/queue/processors.ts as `isRepoCultureProfileEnabled(env) &&
 *  x === true`; centralized here so the precedence lives in exactly one place, like every sibling feature. */
export function shouldApplyRepoCultureProfile(
  env: { LOOPOVER_REVIEW_CULTURE_PROFILE?: string | undefined },
  manifestCultureProfileEnabled: boolean,
): boolean {
  return resolveManifestOnlyFeature(isRepoCultureProfileEnabled(env), manifestCultureProfileEnabled);
}

/** Format a present profile into the reviewer-prompt block. Mirrors `formatRetrievedContext`'s
 *  self-labelled, reference-only framing so the model treats it the same way it treats RAG context. */
export function formatRepoCultureProfileSection(profile: RepoCultureProfile): string {
  if (!profile.present) return "";
  const { pullRequestNorms, commonLabels } = profile;
  const lines = [
    "=== REPO QUALITY-CULTURE PROFILE (reference, NOT a rule — derived from this repo's own merge history) ===",
    `Based on ${pullRequestNorms.sampleSize} recently merged pull request(s) in this repository:`,
    `- Typical merged PR size: ${pullRequestNorms.medianSizeBand} (median ${pullRequestNorms.medianChangedFiles} changed file(s)).`,
    `- Typical PR description length: ~${pullRequestNorms.medianDescriptionLength} characters.`,
  ];
  if (commonLabels.length > 0) {
    // entry.label is author/maintainer-controlled GitHub label text from merged PRs -- neutralize it the same
    // way safeReviewTitle neutralizes an untrusted PR title before it reaches the reviewer prompt (#271).
    const labelSummary = commonLabels
      .map((entry) => `${neutralizePromptInjection(entry.label).text} (${Math.round(entry.frequency * 100)}%)`)
      .join(", ");
    lines.push(`- Common labels on merged PRs: ${labelSummary}.`);
  }
  lines.push(
    "Use this ONLY as soft context for what's typical here (e.g. don't flag a PR as unusually large if it matches this repo's own norm); it is NOT a rule and must never be treated as a blocker on its own.",
    "=== END REPO QUALITY-CULTURE PROFILE ===",
  );
  return lines.join("\n");
}

/**
 * Build the culture-profile grounding block to splice into the AI reviewer's USER prompt (flag-gated by the
 * CALLER via `isRepoCultureProfileEnabled` + the per-repo `review.culture_profile` override, fully fail-safe).
 * Returns "" — and the prompt stays byte-identical — whenever the profile is insufficient-data or anything
 * errors. This NEVER throws.
 */
export async function buildRepoCultureProfileContext(env: Env, repoFullName: string): Promise<string> {
  try {
    const profile = await extractRepoCultureProfile(env, repoFullName);
    return formatRepoCultureProfileSection(profile);
  } catch {
    return ""; // any error → review proceeds without this grounding (fail-safe)
  }
}
