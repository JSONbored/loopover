import { matchesManifestPath } from "../signals/focus-manifest";

export type ReviewEligibilitySkipReason = "ignored_author";

export type ReviewEligibilityInput = {
  authorLogin?: string | null | undefined;
  ignoreAuthors?: readonly string[] | null | undefined;
};

export type ReviewEligibilityDecision =
  | {
      eligible: true;
      skipReason: null;
      matchedPattern: null;
    }
  | {
      eligible: false;
      skipReason: ReviewEligibilitySkipReason;
      matchedPattern: string;
    };

export const REVIEW_ELIGIBLE: ReviewEligibilityDecision = {
  eligible: true,
  skipReason: null,
  matchedPattern: null,
};

function normalizeAuthorLogin(login: string | null | undefined): string {
  return (login ?? "").trim();
}

/**
 * Decide whether the auto-review pipeline should spend/reply for this PR author. This is intentionally narrower
 * than the gate decision: ignored authors only suppress review/public output, never create a blocker.
 */
export function decideReviewEligibility(input: ReviewEligibilityInput): ReviewEligibilityDecision {
  const author = normalizeAuthorLogin(input.authorLogin);
  if (!author) return REVIEW_ELIGIBLE;

  for (const pattern of input.ignoreAuthors ?? []) {
    const trimmed = pattern.trim();
    if (!trimmed) continue;
    if (matchesManifestPath(author, trimmed)) {
      return {
        eligible: false,
        skipReason: "ignored_author",
        matchedPattern: trimmed,
      };
    }
  }

  return REVIEW_ELIGIBLE;
}
