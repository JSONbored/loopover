import { sha256Hex } from "../utils/crypto";

// #ai-slop-cache: the cache key anchors on repo/PR/head SHA, but the prompt still includes mutable PR metadata
// (title/body) plus the currently-built diff and deterministic band. Those can drift for the same head when a PR
// is edited, retargeted, or re-evaluated under changed settings, so they are hashed alongside the provider
// identity to avoid replaying an advisory written for a different prompt.
export const AI_SLOP_CACHE_INPUT_VERSION = "ai-slop-input:v2";

export type AiSlopCacheInput = {
  title?: string | null | undefined;
  body?: string | null | undefined;
  diff?: string | null | undefined;
  deterministicBand?: string | null | undefined;
  byok: boolean;
  provider: string | null | undefined;
  model: string | null | undefined;
};

export async function aiSlopCacheInputFingerprint(input: AiSlopCacheInput): Promise<string> {
  const payload = {
    version: AI_SLOP_CACHE_INPUT_VERSION,
    title: input.title ?? "",
    body: input.body ?? null,
    diff: input.diff ?? "",
    deterministicBand: input.deterministicBand ?? null,
    byok: input.byok,
    provider: input.provider ?? null,
    model: input.model ?? null,
  };
  return `${AI_SLOP_CACHE_INPUT_VERSION}:${await sha256Hex(JSON.stringify(payload))}`;
}
