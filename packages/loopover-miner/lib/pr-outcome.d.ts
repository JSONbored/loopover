import type { AppendEventInput, LedgerEntry } from "./event-ledger.js";
/** Event-ledger vocabulary for a miner-local PR outcome. */
export declare const MINER_PR_OUTCOME_EVENT = "pr_outcome";
export type MinerPrOutcomeDecision = "merged" | "closed";
/** The terminal decisions a miner records for one of its own PRs. */
export declare const MINER_PR_OUTCOME_DECISIONS: readonly MinerPrOutcomeDecision[];
export interface NormalizedPrOutcomePayload {
    prNumber: number;
    decision: MinerPrOutcomeDecision;
    closedAt: string | null;
    reason: string | null;
}
export interface PrOutcomeInput {
    repoFullName?: unknown;
    prNumber?: unknown;
    decision?: unknown;
    closedAt?: unknown;
    reason?: unknown;
}
export interface RecordPrOutcomeOptions {
    /** Optional at the type level so a caller can pass an unusable ledger to exercise the fail-closed guard; the
     *  writer throws `invalid_event_ledger` at runtime when this is absent or lacks `appendEvent`. */
    eventLedger?: {
        appendEvent(event: AppendEventInput): LedgerEntry;
    };
}
export interface PrOutcomeLedgerReader {
    readEvents(filter?: {
        since?: number;
        repoFullName?: string;
    }): unknown[];
}
/**
 * Validate + normalize a PR-outcome payload; returns `null` on any malformed shape (mirrors manage-status.js's
 * `normalizeManageUpdatePayload`, so a bad row can neither be written nor read back). A `closed` decision may carry
 * a reason bucket drawn from {@link REJECTION_REASONS} (shared with the rejection-state-machine sibling); a `merged`
 * decision — or an unrecognized reason — normalizes the reason to `null` (a merged PR has no rejection reason).
 */
export declare function normalizePrOutcomePayload(payload: unknown): NormalizedPrOutcomePayload | null;
/**
 * Thin writer over an INJECTED event ledger (same dependency-injection shape as manage-poll.js's
 * `recordManagePollSnapshot`, so it's unit-testable without a real ledger file). Appends one
 * {@link MINER_PR_OUTCOME_EVENT} scoped to the repo and returns the appended entry. Fail-soft on a malformed
 * snapshot: a missing repo or an invalid payload returns `null` rather than throwing (an unusable ledger is the
 * only hard error, since that is a programmer wiring mistake).
 */
export declare function recordPrOutcomeSnapshot(input: PrOutcomeInput, options?: RecordPrOutcomeOptions): LedgerEntry | null;
/**
 * Reconstruct the latest outcome per repo/PR from the ledger's ascending append-only event stream (mirrors
 * manage-status.js's `indexLatestManageUpdates`). Reads via the injected ledger's `readEvents(filter)` and reduces
 * the pure result — a later event for the same repo/PR supersedes an earlier one. Returns a `Map` keyed by
 * `repoFullName:prNumber`.
 */
export declare function readPrOutcomes(eventLedger: PrOutcomeLedgerReader, filter?: {
    since?: number;
    repoFullName?: string;
}): Map<string, NormalizedPrOutcomePayload & {
    repoFullName: string;
}>;
