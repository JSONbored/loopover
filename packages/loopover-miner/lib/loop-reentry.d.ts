export declare const LOOP_REENTRY_DECISION_EVENT = "loop_reentry_decision";
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
    appendEvent(event: {
        type: string;
        repoFullName?: string;
        payload: Record<string, unknown>;
    }): {
        id: number;
        seq: number;
        type: string;
        repoFullName: string | null;
        payload: Record<string, unknown>;
        createdAt: string;
    };
    readEvents(filter?: {
        since?: number;
        repoFullName?: string;
    }): Array<{
        type: string;
        repoFullName?: string | null;
        payload?: Record<string, unknown>;
        createdAt: string;
    }>;
}
export interface LoopReentryPortfolioQueue {
    dequeueNext(): {
        repoFullName: string;
        identifier: string;
        priority: number;
        status: string;
        enqueuedAt: string;
    } | null;
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
    decision: {
        reenter: boolean;
        reasons: string[];
    };
    dequeued: {
        repoFullName: string;
        identifier: string;
        priority: number;
        status: string;
        enqueuedAt: string;
    } | null;
    event: {
        id: number;
        seq: number;
        type: string;
        repoFullName: string | null;
        payload: Record<string, unknown>;
        createdAt: string;
    };
};
/**
 * Count a repo's CONSECUTIVE disengaged (closed-without-merge) PR outcomes, walking backward from the most
 * recently recorded PR for that repo until a merged outcome breaks the streak (or history runs out).
 */
export declare function countConsecutiveDisengagements(eventLedger: LoopReentryEventLedger, repoFullName: string): number;
/** Count prior re-entries (successful, i.e. `reentered: true`) recorded at or after `sinceMs`. */
export declare function countReentriesSince(eventLedger: LoopReentryEventLedger, sinceMs: number): number;
/**
 * Evaluate and (if allowed) PERFORM re-entry for one resolved outcome: reads real history to compute the
 * circuit-breaker and rate-cap tallies, consults the pure `shouldReenter` policy, and -- only when it allows --
 * dequeues the next candidate and transitions run-state to `"discovering"`. Always appends exactly one audit
 * event. Fails closed (throws) on a malformed candidate or missing required dependency, mirroring
 * `recordManagePollSnapshot`'s own validation style.
 */
export declare function attemptLoopReentry(candidate: LoopReentryCandidateInput, deps: LoopReentryDeps): LoopReentryResult;
