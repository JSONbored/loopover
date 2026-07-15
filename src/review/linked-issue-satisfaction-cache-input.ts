import { sha256Hex } from "../utils/crypto";

// #linked-issue-satisfaction-cache: mirrors ai-slop-cache-input.ts's fingerprint discipline, but includes
// every prompt input that is not already represented by the row key. The row key handles repo/pull/head SHA
// and primary linked issue number; this fingerprint handles reviewer configuration plus mutable GitHub text
// (issue title/body and PR title/body) so edits cannot replay a verdict for an older prompt. Diff text is
// included defensively too, keeping the cache tied to exactly the model prompt that produced the opinion.
export const LINKED_ISSUE_SATISFACTION_CACHE_INPUT_VERSION = "linked-issue-satisfaction-input:v2";

export type LinkedIssueSatisfactionCacheInput = {
  byok: boolean;
  provider: string | null | undefined;
  model: string | null | undefined;
  issueText?: string | null | undefined;
  prTitle?: string | null | undefined;
  prBody?: string | null | undefined;
  diff?: string | null | undefined;
};

export async function linkedIssueSatisfactionCacheInputFingerprint(input: LinkedIssueSatisfactionCacheInput): Promise<string> {
  // Structurally-delimited payload (mirrors ai-slop-cache-input.ts): a bare "|"-join of free-form
  // GitHub text let an unescaped "|" inside one field shift a field boundary, so two genuinely different
  // inputs could serialize identically and collide on the same fingerprint. JSON.stringify escapes the
  // field values, so distinct inputs always produce distinct payloads.
  const payload = {
    version: LINKED_ISSUE_SATISFACTION_CACHE_INPUT_VERSION,
    byok: input.byok,
    provider: input.provider ?? "",
    model: input.model ?? "",
    issueText: input.issueText ?? "",
    prTitle: input.prTitle ?? "",
    prBody: input.prBody ?? "",
    diff: input.diff ?? "",
  };
  return `${LINKED_ISSUE_SATISFACTION_CACHE_INPUT_VERSION}:${await sha256Hex(JSON.stringify(payload))}`;
}
