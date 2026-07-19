// Miner-local PR-outcome record (#4274). The miner's OWN local record of the outcomes of its OWN PRs — merged or
// closed — written to the miner's local SQLite via the generic append-only event-ledger.js, mirroring how
// manage-status.js layers a specific typed event (MANAGE_PR_UPDATE_EVENT + a payload normalizer + a thin writer)
// on top of that same ledger.
//
// DISTINCT from the server-side `pr_outcome` concept: src/review/outcomes-wire.ts's `recordPrOutcome` writes
// `pr_outcome` rows to the HOSTED backend's D1 audit tables from the GitHub App's webhook stream — that is the
// loopover SERVER recording ground truth for every contributor. THIS is a laptop-mode miner's local record of
// its own PRs (it may have no webhook relay at all): same concept name, different codebase layer, no shared code.
// The distinct `MINER_PR_OUTCOME_EVENT` local constant keeps the two from being conflated.

import { REJECTION_REASONS } from "./rejection-templates.js";
import type { AppendEventInput, LedgerEntry } from "./event-ledger.js";

/** Event-ledger vocabulary for a miner-local PR outcome. */
export const MINER_PR_OUTCOME_EVENT = "pr_outcome";

export type MinerPrOutcomeDecision = "merged" | "closed";

/** The terminal decisions a miner records for one of its own PRs. */
export const MINER_PR_OUTCOME_DECISIONS: readonly MinerPrOutcomeDecision[] = Object.freeze(["merged", "closed"]);

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
  eventLedger?: { appendEvent(event: AppendEventInput): LedgerEntry };
}

export interface PrOutcomeLedgerReader {
  readEvents(filter?: { since?: number; repoFullName?: string }): unknown[];
}

const decisionSet: Set<string> = new Set(MINER_PR_OUTCOME_DECISIONS);
const reasonSet: Set<string> = new Set(REJECTION_REASONS);

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * Validate + normalize a PR-outcome payload; returns `null` on any malformed shape (mirrors manage-status.js's
 * `normalizeManageUpdatePayload`, so a bad row can neither be written nor read back). A `closed` decision may carry
 * a reason bucket drawn from {@link REJECTION_REASONS} (shared with the rejection-state-machine sibling); a `merged`
 * decision — or an unrecognized reason — normalizes the reason to `null` (a merged PR has no rejection reason).
 */
export function normalizePrOutcomePayload(payload: unknown): NormalizedPrOutcomePayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (!Number.isInteger(record.prNumber) || (record.prNumber as number) <= 0) return null;
  const decision = optionalString(record.decision);
  if (!decision || !decisionSet.has(decision)) return null;
  const reasonRaw = optionalString(record.reason);
  const reason = decision === "closed" && reasonRaw !== null && reasonSet.has(reasonRaw) ? reasonRaw : null;
  return {
    prNumber: record.prNumber as number,
    decision: decision as MinerPrOutcomeDecision,
    closedAt: optionalString(record.closedAt),
    reason,
  };
}

/**
 * Thin writer over an INJECTED event ledger (same dependency-injection shape as manage-poll.js's
 * `recordManagePollSnapshot`, so it's unit-testable without a real ledger file). Appends one
 * {@link MINER_PR_OUTCOME_EVENT} scoped to the repo and returns the appended entry. Fail-soft on a malformed
 * snapshot: a missing repo or an invalid payload returns `null` rather than throwing (an unusable ledger is the
 * only hard error, since that is a programmer wiring mistake).
 */
export function recordPrOutcomeSnapshot(input: PrOutcomeInput, options: RecordPrOutcomeOptions = {}): LedgerEntry | null {
  const eventLedger = options.eventLedger;
  if (!eventLedger || typeof eventLedger.appendEvent !== "function") throw new Error("invalid_event_ledger");
  const repoFullName = typeof input?.repoFullName === "string" ? input.repoFullName.trim() : "";
  if (!repoFullName) return null;
  const payload = normalizePrOutcomePayload({
    prNumber: input?.prNumber,
    decision: input?.decision,
    closedAt: input?.closedAt,
    reason: input?.reason,
  });
  if (!payload) return null;
  return eventLedger.appendEvent({ type: MINER_PR_OUTCOME_EVENT, repoFullName, payload: payload as unknown as Record<string, unknown> });
}

/**
 * Reconstruct the latest outcome per repo/PR from the ledger's ascending append-only event stream (mirrors
 * manage-status.js's `indexLatestManageUpdates`). Reads via the injected ledger's `readEvents(filter)` and reduces
 * the pure result — a later event for the same repo/PR supersedes an earlier one. Returns a `Map` keyed by
 * `repoFullName:prNumber`.
 */
export function readPrOutcomes(
  eventLedger: PrOutcomeLedgerReader,
  filter: { since?: number; repoFullName?: string } = {},
): Map<string, NormalizedPrOutcomePayload & { repoFullName: string }> {
  const events = eventLedger && typeof eventLedger.readEvents === "function" ? eventLedger.readEvents(filter) : [];
  const latest = new Map<string, NormalizedPrOutcomePayload & { repoFullName: string }>();
  for (const event of Array.isArray(events) ? events : []) {
    const record = event as { type?: unknown; repoFullName?: unknown; payload?: unknown } | null;
    if (record?.type !== MINER_PR_OUTCOME_EVENT) continue;
    if (typeof record.repoFullName !== "string" || !record.repoFullName.trim()) continue;
    const normalized = normalizePrOutcomePayload(record.payload);
    if (!normalized) continue;
    // Re-key on every event so Map iteration order tracks most-recently-UPDATED last, not first-seen (#7222). A
    // bare Map.set() on an existing key updates the value but leaves the key frozen at its original position, so a
    // later outcome for the same PR (e.g. closed-without-merge, then reopened + merged) stayed at its old slot --
    // breaking recency-ordered consumers like loop-reentry.js's countConsecutiveDisengagements. Deleting first
    // moves the freshly-updated entry to the end, matching this reducer's own "a later event supersedes" contract.
    const key = `${record.repoFullName}:${normalized.prNumber}`;
    latest.delete(key);
    latest.set(key, { ...normalized, repoFullName: record.repoFullName });
  }
  return latest;
}
