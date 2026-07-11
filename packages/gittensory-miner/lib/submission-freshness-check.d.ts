export const SUBMISSION_FRESHNESS_ABORT_EVENT: "submission_freshness_abort";

export type FreshnessAbortReason = "issue_closed" | "already_addressed" | "claim_superseded" | "live_state_unavailable";

export type SubmissionFreshnessCandidate = {
  repoFullName: string;
  issueNumber: number;
  minerLogin: string;
};

export type LiveIssueSnapshot = {
  state: "open" | "closed";
  referencingPrs: Array<{ number: number; state: "open" | "closed" | "merged"; authorLogin: string }>;
};

export type SubmissionFreshnessClaimLedger = {
  listClaims(filter: { repoFullName?: string; status?: string }): Array<{ repoFullName: string; issueNumber: number; status: string }>;
};

export type SubmissionFreshnessEventLedger = {
  appendEvent(event: { type: string; repoFullName?: string; payload: Record<string, unknown> }): unknown;
};

export type SubmissionFreshnessDeps = {
  claimLedger: SubmissionFreshnessClaimLedger;
  fetchLiveIssueSnapshot: (repoFullName: string, issueNumber: number) => Promise<LiveIssueSnapshot | null>;
  eventLedger: SubmissionFreshnessEventLedger;
};

export type SubmissionFreshnessResult = { fresh: true } | { fresh: false; reason: FreshnessAbortReason };

export function checkSubmissionFreshness(candidate: SubmissionFreshnessCandidate, deps: SubmissionFreshnessDeps): Promise<SubmissionFreshnessResult>;
