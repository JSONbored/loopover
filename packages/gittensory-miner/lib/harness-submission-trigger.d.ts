export const HARNESS_SUBMISSION_TRIGGER_DECISION_EVENT: "harness_submission_trigger_decision";

export type HarnessSubmissionSlopBand = "clean" | "low" | "elevated" | "high";
export type HarnessSubmissionMode = "observe" | "enforce";

export type HarnessSubmissionCandidateInput = {
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
