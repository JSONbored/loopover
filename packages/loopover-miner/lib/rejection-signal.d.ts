import type { SelfReviewContextFetch } from "./self-review-context.js";

type OwnRejectionHistorySubmission = { pullRequestNumber?: number | null };

type ListOwnSubmissions = (filter: { repoFullName?: string }) => OwnRejectionHistorySubmission[];

export interface OwnRejectionHistoryOptions {
  listSubmissions?: ListOwnSubmissions;
  fetchImpl?: SelfReviewContextFetch;
  githubToken?: string;
  githubApiBaseUrl?: string;
  maxRejectionHistoryChecks?: number;
}

export interface RejectionSignaledOptions extends OwnRejectionHistoryOptions {
  rawContentBaseUrl?: string;
}

export type RejectionSignaledReason = "ai_usage_policy_ban" | "own_submission_rejected";

export const REJECTION_REASON_AI_USAGE_POLICY_BAN: "ai_usage_policy_ban";
export const REJECTION_REASON_OWN_SUBMISSION_REJECTED: "own_submission_rejected";

export function resolveRejectionSignaled(
  repoFullName: string,
  options?: RejectionSignaledOptions,
): Promise<false | RejectionSignaledReason>;

export function resolveOwnRejectionHistory(
  repoFullName: string,
  options?: OwnRejectionHistoryOptions,
): Promise<boolean>;
