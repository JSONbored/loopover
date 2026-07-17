export const HARNESS_SUBMISSION_TRIGGER_DECISION_EVENT: "harness_submission_trigger_decision";

export type HarnessSubmissionSlopBand = "clean" | "low" | "elevated" | "high";
export type HarnessSubmissionMode = "observe" | "enforce";
export type HarnessSubmissionKillSwitchScope = "global" | "repo" | "none";

export type HarnessSubmissionCandidateInput = {
  /** Forwarded to shouldSubmit's own kill-switch check (#2339). */
  killSwitchScope: HarnessSubmissionKillSwitchScope;
  repoFullName: string;
  handoffPacket: {
    worktreePath: string;
    branchRef?: string;
    diffSummary: string;
    selfReviewVerdict: unknown;
    attemptLogReference: string;
  };
  slopThreshold: HarnessSubmissionSlopBand;
  mode: HarnessSubmissionMode;
  maxConsecutiveGateBlocks?: number;
};

export interface HarnessSubmissionEventLedger {
  appendEvent(event: { type: string; repoFullName?: string; payload: Record<string, unknown> }): { id: number; seq: number; type: string; repoFullName: string | null; payload: Record<string, unknown>; createdAt: string };
  readEvents(filter?: { since?: number; repoFullName?: string }): Array<{ type: string; repoFullName?: string | null; payload?: Record<string, unknown>; createdAt: string }>;
}

export type HarnessSubmissionDeps = {
  eventLedger: HarnessSubmissionEventLedger;
  sessionStartMs?: number;
};

export type HarnessSubmissionDecision = {
  allow: boolean;
  reasons: string[];
  circuitBreakerTripped: boolean;
};

export type HarnessSubmissionResult = {
  decision: HarnessSubmissionDecision;
  event: { id: number; seq: number; type: string; repoFullName: string | null; payload: Record<string, unknown>; createdAt: string };
};

export function countConsecutiveGateBlocks(eventLedger: HarnessSubmissionEventLedger, sinceMs: number): number;

export function evaluateAndRecordHarnessSubmissionTrigger(candidate: HarnessSubmissionCandidateInput, deps: HarnessSubmissionDeps): HarnessSubmissionResult;

/** The exact input shape buildOpenPrSpec (`@loopover/engine`) expects. */
export type OpenPrInput = {
  repoFullName: string;
  base: string;
  head: string;
  title: string;
  body: string;
  draft: boolean;
};

export type PrepareOpenPrSubmissionCandidate = HarnessSubmissionCandidateInput & {
  base: string;
  title: string;
  body?: string;
  draft?: boolean;
};

export type PrepareOpenPrSubmissionResult =
  | { ready: true; decision: HarnessSubmissionDecision; event: HarnessSubmissionResult["event"]; openPrInput: OpenPrInput }
  | { ready: false; decision: HarnessSubmissionDecision; event: HarnessSubmissionResult["event"] };

export function prepareOpenPrSubmission(candidate: PrepareOpenPrSubmissionCandidate, deps: HarnessSubmissionDeps): PrepareOpenPrSubmissionResult;
