import type { RejectionContext, RejectionReason } from "./rejection-templates.js";
export type PrOutcomeFields = {
    state: string | null;
    merged: boolean;
    mergedAt: string | null;
    closedAt: string | null;
};
export type RejectionSignal = {
    gateClosed?: boolean;
    supersededByDuplicate?: boolean;
};
export type RejectionTransition = {
    outcome: "disengaged";
    reason: RejectionReason;
    note: string;
    fields: PrOutcomeFields;
};
/** Per-PR terminal outcome for a rejected (closed-without-merge) PR. A poller adds this to its own outcome
 *  vocabulary alongside ready / needs-work / open. */
export declare const DISENGAGED_OUTCOME: "disengaged";
/**
 * Pull the terminal-outcome fields from a `GET /pulls/{n}` payload the poller already has. Pure — no API call.
 * Missing/malformed fields normalize to null/false so a partial payload never throws here.
 */
export declare function extractPrOutcomeFields(prPayload: unknown): PrOutcomeFields;
/**
 * True when a PR is closed WITHOUT a merge — the rejection this state machine acts on. A merged PR (even though
 * GitHub also marks it `state: "closed"`) is NOT a rejection. Pure.
 */
export declare function isRejectedPr(fields: {
    state?: string | null;
    merged?: boolean;
} | null | undefined): boolean;
/**
 * Classify a detected rejection into one of the rejection-reason buckets from the available signal.
 * Precedence: an explicit gate close outranks a duplicate signal (the gate is the more specific, actionable
 * cause). With neither signal, defaults to `maintainer_close_no_reason` (the documented zero-signal fallback).
 * Pure.
 */
export declare function classifyRejectionReason(signal?: RejectionSignal): RejectionReason;
/**
 * The full transition. Given a PR payload, an optional gate/duplicate signal, and the render context
 * (`{ repoFullName, prNumber }`), decide whether the PR is a rejection and, if so, produce the disengaged
 * transition: the classified reason and the rendered courtesy note (this is `renderRejectionMessage`'s first
 * real caller). Returns null when the PR is not a rejection (still open, or merged) — nothing to disengage.
 * Pure and deterministic; the caller persists `{ outcome, reason, note }` via its local event ledger.
 */
export declare function resolveRejection(prPayload: unknown, signal: RejectionSignal | undefined, context: RejectionContext): RejectionTransition | null;
