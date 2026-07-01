import type {
  ReviewPathInstruction,
  ReviewProfile,
} from "../signals/focus-manifest";
import { sha256Hex } from "../utils/crypto";

export const AI_REVIEW_CACHE_INPUT_VERSION = "ai-review-input:v1";

export type AiReviewCacheInput = {
  mode: string;
  byok: boolean;
  provider: string | null | undefined;
  model: string | null | undefined;
  reviewerPlan:
    | {
        combine?: string | null | undefined;
        reviewers?: readonly { model?: string | null | undefined }[] | undefined;
      }
    | null
    | undefined;
  // reviewerPlan only names WHICH self-host provider(s) are active (e.g. "claude-code") -- it does not carry that
  // provider's own model/effort/timeout/base-url, which are resolved separately at review-call time (see
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
  profile: ReviewProfile | null | undefined;
  inlineComments: boolean;
  pathInstructions: readonly ReviewPathInstruction[];
  pathGuidance: string;
  repoInstructions: string | null | undefined;
  excludePaths: readonly string[];
  changedPaths: readonly string[];
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
    mode: input.mode,
    byok: input.byok,
    provider: input.provider ?? null,
    model: input.model ?? null,
    reviewerPlan: input.reviewerPlan
      ? {
          combine: input.reviewerPlan.combine ?? null,
          reviewers: (input.reviewerPlan.reviewers ?? []).map((reviewer) => reviewer.model ?? null),
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
    profile: input.profile ?? null,
    inlineComments: input.inlineComments,
    pathInstructions: input.pathInstructions.map((instruction) => ({
      path: instruction.path,
      instructions: instruction.instructions,
    })),
    pathGuidance: input.pathGuidance,
    repoInstructions: input.repoInstructions?.trim() || null,
    excludePaths: normalizeStringList(input.excludePaths),
    changedPaths: normalizeStringList(input.changedPaths),
    features: input.features,
  };
  return `${AI_REVIEW_CACHE_INPUT_VERSION}:${await sha256Hex(stableStringify(payload))}`;
}

export function aiReviewCacheInputMatches(
  metadata: Record<string, unknown> | null | undefined,
  fingerprint: string,
): boolean {
  return (
    metadata?.inputVersion === AI_REVIEW_CACHE_INPUT_VERSION &&
    metadata.inputFingerprint === fingerprint
  );
}

export function cacheMetadataForAiReviewInput(
  metadata: Record<string, unknown> | null | undefined,
  fingerprint: string,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    inputVersion: AI_REVIEW_CACHE_INPUT_VERSION,
    inputFingerprint: fingerprint,
  };
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
