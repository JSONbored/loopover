import type {
  ReviewPathInstruction,
  ReviewProfile,
  SelfHostAiModelConfig,
} from "../signals/focus-manifest";
import { sha256Hex } from "../utils/crypto";

export const AI_REVIEW_CACHE_INPUT_VERSION = "ai-review-input:v1";

// #regate-churn (root cause, confirmed in production): this fingerprint USED to also hash the PR's live
// `baseSha`, on the theory that a rebase/retarget can change the diff GitHub reports for an otherwise-unchanged
// head SHA even though `changedPaths` (just the path list) stays the same. That reasoning already had a fix --
// `reviewFiles` below hashes the actual per-file PATCH content (not just paths), which is the real signal for
// "did the reviewed content change." Hashing raw `baseSha` on top of that was redundant when the patch is
// unchanged and actively harmful when it isn't: `baseSha` is the live tip of the base branch, which advances on
// EVERY unrelated merge to it, so on an active repo it differs on almost every evaluation regardless of whether
// this PR's own diff changed at all -- causing a same-head PR to miss the cache (and re-spend a real AI call,
// producing non-deterministic LLM output that can even flip the published verdict) on every scheduled re-gate
// sweep. Removed entirely; `reviewFiles`' patch content is the sole source of truth for reviewed-content drift.
export type AiReviewCacheInput = {
  // The PR title is threaded into the reviewer prompt (see runAiReviewForAdvisory's pr.title), so a same-head
  // `edited` event that changes only the title must miss the cache rather than replay a review generated for
  // different prompt metadata.
  title: string;
  mode: string;
  byok: boolean;
  provider: string | null | undefined;
  model: string | null | undefined;
  // Eligibility/interpretation settings that don't shape the prompt itself but decide whether AI runs at all
  // (aiReviewAllAuthors, gatePack) or how a cached finding's embedded confidence is later interpreted
  // (aiReviewCloseConfidence). None of these change what the model would output for the same prompt, but a
  // repo flipping any of them warrants a fresh review rather than replaying a decision made under different
  // eligibility/interpretation rules.
  aiReviewAllAuthors: boolean;
  aiReviewCloseConfidence: number | null | undefined;
  // Per-repo dual-AI combine overrides (#2567): these directly shape the EFFECTIVE combine/onMerge/reviewers
  // resolveEffectiveAiReviewPlan produces (which drives whether/how a consensus defect is computed), separate
  // from `reviewerPlan` below (the operator's own boot-config plan). A repo flipping any of these warrants a
  // fresh review under the new effective plan, not a replay of a decision made under the old one -- the same
  // reasoning as aiReviewCloseConfidence above.
  aiReviewCombine: string | null | undefined;
  aiReviewOnMerge: string | null | undefined;
  aiReviewReviewers: readonly { model: string; fallback?: string | null | undefined }[] | null | undefined;
  gatePack: string | null | undefined;
  reviewerPlan:
    | {
        combine?: string | null | undefined;
        reviewers?: readonly { model?: string | null | undefined; fallback?: string | null | undefined }[] | undefined;
      }
    | null
    | undefined;
  // reviewerPlan only names WHICH self-host provider(s) are active (e.g. "codex" with fallback "claude-code") --
  // it does not carry that provider's own model/effort/timeout/base-url, which are resolved separately at review-call time (see
  // src/selfhost/ai.ts's buildProvider). Fingerprint those too so switching a provider's underlying model or
  // endpoint (while the provider name/plan stays the same) forces a cache miss instead of reusing a review
  // produced against a different configuration. Deliberately excludes API keys (secrets, and irrelevant to output).
  selfHostProviderConfig:
    | {
        claudeModel?: string | null | undefined;
        claudeEffort?: string | null | undefined;
        claudeTimeoutMs?: string | null | undefined;
        codexModel?: string | null | undefined;
        codexEffort?: string | null | undefined;
        codexTimeoutMs?: string | null | undefined;
        ollamaBaseUrl?: string | null | undefined;
        ollamaModel?: string | null | undefined;
        openaiCompatibleBaseUrl?: string | null | undefined;
        openaiCompatibleModel?: string | null | undefined;
        openaiBaseUrl?: string | null | undefined;
        openaiModel?: string | null | undefined;
        anthropicBaseUrl?: string | null | undefined;
        anthropicModel?: string | null | undefined;
      }
    | null
    | undefined;
  // `.gittensory.yml` review.ai_model (#selfhost-ai-model-override): the PER-REPO override, distinct from
  // selfHostProviderConfig above (the operator's global env vars) -- a repo flipping its own ai_model warrants a
  // fresh review under the new model/effort, not a replay of a decision made under the old one. All-null (the
  // default, no override set) fingerprints the same as an absent manifest, so this is a no-op for every repo that
  // has never configured it.
  selfHostAiModelOverride: SelfHostAiModelConfig | null | undefined;
  profile: ReviewProfile | null | undefined;
  securityFocus: boolean;
  inlineComments: boolean;
  pathInstructions: readonly ReviewPathInstruction[];
  pathGuidance: string;
  repoInstructions: string | null | undefined;
  excludePaths: readonly string[];
  pathFilters: readonly string[];
  changedPaths: readonly string[];
  reviewFiles: readonly {
    path: string;
    status?: string | null | undefined;
    patch?: string | null | undefined;
    additions: number;
    deletions: number;
  }[];
  // grounding/rag/enrichment/reputation each pull TIME-VARYING external context that can change for an
  // unchanged head SHA without any of these booleans flipping (live CI checks, the vector index, REES/CVE data,
  // the submitter's evolving reputation) -- a boolean can't detect that drift, so the caller bypasses the cache
  // entirely whenever any of these is true rather than relying on this fingerprint to catch a content change.
  features: {
    grounding: boolean;
    rag: boolean;
    enrichment: boolean;
    reputation: boolean;
  };
};

export async function aiReviewCacheInputFingerprint(input: AiReviewCacheInput): Promise<string> {
  const payload = {
    version: AI_REVIEW_CACHE_INPUT_VERSION,
    title: input.title,
    mode: input.mode,
    byok: input.byok,
    provider: input.provider ?? null,
    model: input.model ?? null,
    aiReviewAllAuthors: input.aiReviewAllAuthors,
    aiReviewCloseConfidence: input.aiReviewCloseConfidence ?? null,
    aiReviewCombine: input.aiReviewCombine ?? null,
    aiReviewOnMerge: input.aiReviewOnMerge ?? null,
    // Nullish (no repo override) and an explicit [] are DIFFERENT effective plans (src/services/ai-review.ts's
    // resolveEffectiveAiReviewPlan falls through to the built-in default reviewers for nullish but treats an
    // explicit [] as a real, empty override) -- collapsing both to the same fingerprint would let a same-SHA
    // cache hit replay a verdict produced under a different effective reviewer plan.
    aiReviewReviewers:
      input.aiReviewReviewers == null
        ? null
        : input.aiReviewReviewers.map((reviewer) => ({ model: reviewer.model, fallback: reviewer.fallback ?? null })),
    gatePack: input.gatePack ?? null,
    reviewerPlan: input.reviewerPlan
      ? {
          combine: input.reviewerPlan.combine ?? null,
          reviewers: (input.reviewerPlan.reviewers ?? []).map((reviewer) => ({
            model: reviewer.model ?? null,
            fallback: reviewer.fallback ?? null,
          })),
        }
      : null,
    selfHostProviderConfig: input.selfHostProviderConfig
      ? {
          claudeModel: input.selfHostProviderConfig.claudeModel ?? null,
          claudeEffort: input.selfHostProviderConfig.claudeEffort ?? null,
          claudeTimeoutMs: input.selfHostProviderConfig.claudeTimeoutMs ?? null,
          codexModel: input.selfHostProviderConfig.codexModel ?? null,
          codexEffort: input.selfHostProviderConfig.codexEffort ?? null,
          codexTimeoutMs: input.selfHostProviderConfig.codexTimeoutMs ?? null,
          ollamaBaseUrl: input.selfHostProviderConfig.ollamaBaseUrl ?? null,
          ollamaModel: input.selfHostProviderConfig.ollamaModel ?? null,
          openaiCompatibleBaseUrl: input.selfHostProviderConfig.openaiCompatibleBaseUrl ?? null,
          openaiCompatibleModel: input.selfHostProviderConfig.openaiCompatibleModel ?? null,
          openaiBaseUrl: input.selfHostProviderConfig.openaiBaseUrl ?? null,
          openaiModel: input.selfHostProviderConfig.openaiModel ?? null,
          anthropicBaseUrl: input.selfHostProviderConfig.anthropicBaseUrl ?? null,
          anthropicModel: input.selfHostProviderConfig.anthropicModel ?? null,
        }
      : null,
    selfHostAiModelOverride: input.selfHostAiModelOverride
      ? {
          claudeModel: input.selfHostAiModelOverride.claudeModel ?? null,
          claudeEffort: input.selfHostAiModelOverride.claudeEffort ?? null,
          codexModel: input.selfHostAiModelOverride.codexModel ?? null,
          codexEffort: input.selfHostAiModelOverride.codexEffort ?? null,
        }
      : null,
    profile: input.profile ?? null,
    securityFocus: input.securityFocus,
    inlineComments: input.inlineComments,
    pathInstructions: input.pathInstructions.map((instruction) => ({
      path: instruction.path,
      instructions: instruction.instructions,
    })),
    pathGuidance: input.pathGuidance,
    repoInstructions: input.repoInstructions?.trim() || null,
    excludePaths: normalizeStringList(input.excludePaths),
    pathFilters: normalizeStringList(input.pathFilters),
    changedPaths: normalizeStringList(input.changedPaths),
    reviewFiles: [...input.reviewFiles]
      .map((file) => ({
        path: file.path,
        status: file.status ?? null,
        patch: file.patch ?? null,
        additions: file.additions,
        deletions: file.deletions,
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    features: input.features,
  };
  return `${AI_REVIEW_CACHE_INPUT_VERSION}:${await sha256Hex(stableStringify(payload))}`;
}

function normalizeStringList(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
