import { sha256Hex } from "../utils/crypto";

// #ai-slop-cache: unlike ai-review-cache-input.ts (whose fingerprint spans a large, independently-mutable
// prompt-shaping surface -- reviewer plan, model overrides, path instructions, feature toggles, ...), the slop
// advisory's ONLY input that can change independently of the PR's head SHA is which provider writes the
// opinion: the free/default reviewer vs. a maintainer's BYOK key/model (see AiSlopInput in ../services/ai-slop).
// Title/body/diff/deterministicBand are all already pinned to the head SHA -- the same commit always produces
// the same diff and the same deterministic band, so none of them need fingerprinting. A repo flipping BYOK on
// or changing its BYOK provider/model must miss the cache rather than replay an opinion written under a
// different reviewer.
export const AI_SLOP_CACHE_INPUT_VERSION = "ai-slop-input:v1";

export type AiSlopCacheInput = {
  byok: boolean;
  provider: string | null | undefined;
  model: string | null | undefined;
};

export async function aiSlopCacheInputFingerprint(input: AiSlopCacheInput): Promise<string> {
  const payload = [
    AI_SLOP_CACHE_INPUT_VERSION,
    input.byok ? "1" : "0",
    input.provider ?? "",
    input.model ?? "",
  ].join("|");
  return `${AI_SLOP_CACHE_INPUT_VERSION}:${await sha256Hex(payload)}`;
}
