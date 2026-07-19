export const LOOP_REENTRY_DECISION_EVENT: "loop_reentry_decision";

export type LoopReentryOutcome = "merged" | "disengaged" | "other";
export type LoopReentryKillSwitchScope = "global" | "repo" | "none";

export type LoopReentryCandidateInput = {
  /** Checked FIRST by the pure `shouldReenter` policy, before any other logic. */
  killSwitchScope: LoopReentryKillSwitchScope;
  repoFullName: string;
  outcome: LoopReentryOutcome;
  maxConsecutiveDisengagements?: number;
  maxReentriesPerHour?: number;
  maxReentriesPerSession?: number;
};

export interface LoopReentryEventLedger {
  appendEvent(event: { type: string; repoFullName?: string; payload: Record<string, unknown> }): { id: number; seq: number; type: string; repoFullName: string | null; payload: Record<string, unknown>; createdAt: string };
  readEvents(filter?: { since?: number; repoFullName?: string }): Array<{ type: string; repoFullName?: string | null; payload?: Record<string, unknown>; createdAt: string }>;
}

export interface LoopReentryPortfolioQueue {
  dequeueNext(): { repoFullName: string; identifier: string; priority: number; status: string; enqueuedAt: string } | null;
}

export interface LoopReentryRunState {
  setRunState(repoFullName: string, state: string): unknown;
}

export type LoopReentryDeps = {
  eventLedger: LoopReentryEventLedger;
  portfolioQueue: LoopReentryPortfolioQueue;
  runState?: LoopReentryRunState;
  nowMs?: number;
  sessionStartMs?: number;
  /** The just-completed cycle's read-only summary (loop-closure.js's `buildLoopClosureSummary`), threaded
   *  through verbatim into the audit event's payload for traceability. Not used to compute the circuit-
   *  breaker/rate-cap tallies -- see loop-reentry.js's own comment on why. */
  loopSummary?: unknown;
};

export type LoopReentryResult = {
  decision: { reenter: boolean; reasons: string[] };
  dequeued: { repoFullName: string; identifier: string; priority: number; status: string; enqueuedAt: string } | null;
  event: { id: number; seq: number; type: string; repoFullName: string | null; payload: Record<string, unknown>; createdAt: string };
};

export function countConsecutiveDisengagements(eventLedger: LoopReentryEventLedger, repoFullName: string): number;

export function countReentriesSince(eventLedger: LoopReentryEventLedger, sinceMs: number): number;

export function attemptLoopReentry(candidate: LoopReentryCandidateInput, deps: LoopReentryDeps): LoopReentryResult;
