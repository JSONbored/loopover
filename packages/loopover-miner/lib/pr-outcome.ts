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
import {
  buildAmsPrOutcomePayload,
  scheduleAmsNotificationEvents,
  type PublishAmsNotificationEventsOptions,
} from "./ams-notifications.js";

/** Event-ledger vocabulary for a miner-local PR outcome. */
export const MINER_PR_OUTCOME_EVENT = "pr_outcome" as const;

/** The terminal decisions a miner records for one of its own PRs. */
export const MINER_PR_OUTCOME_DECISIONS = Object.freeze(["merged", "closed"] as const);

export type MinerPrOutcomeDecision = (typeof MINER_PR_OUTCOME_DECISIONS)[number];

export type NormalizedPrOutcomePayload = {
  prNumber: number;
  decision: MinerPrOutcomeDecision;
  closedAt: string | null;
  reason: string | null;
};

export type PrOutcomeInput = {
  repoFullName?: unknown;
  prNumber?: unknown;
  decision?: unknown;
  closedAt?: unknown;
  reason?: unknown;
};

export type RecordPrOutcomeOptions = {
  /** Optional at the type level so a caller can pass an unusable ledger to exercise the fail-closed guard; the
   *  writer throws `invalid_event_ledger` at runtime when this is absent or lacks `appendEvent`. Reuses the
   *  real EventLedger#appendEvent signature so a genuine EventLedger (not just a same-shaped stub) type-checks. */
  eventLedger?: { appendEvent(event: AppendEventInput): LedgerEntry };
  /** Recipient for AMS badge notify (#7657). When absent, notification is skipped (ledger write still happens). */
  recipientLogin?: string;
  env?: Record<string, string | undefined>;
  scheduleAmsNotifications?: (
    events: Parameters<typeof scheduleAmsNotificationEvents>[0],
    options?: PublishAmsNotificationEventsOptions,
  ) => void;
};

export type PrOutcomeLedgerReader = {
  readEvents(filter?: { since?: number; repoFullName?: string }): unknown[];
};

const decisionSet = new Set<string>(MINER_PR_OUTCOME_DECISIONS);
const reasonSet = new Set<string>(REJECTION_REASONS);

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
export function recordPrOutcomeSnapshot(input: PrOutcomeInput, options: RecordPrOutcomeOptions = {}): unknown {
  const eventLedger = options.eventLedger;
  if (!eventLedger || typeof eventLedger.appendEvent !== "function") throw new Error("invalid_event_ledger");
  const repoFullName = typeof input.repoFullName === "string" ? input.repoFullName.trim() : "";
  if (!repoFullName) return null;
  const payload = normalizePrOutcomePayload({
    prNumber: input.prNumber,
    decision: input.decision,
    closedAt: input.closedAt,
    reason: input.reason,
  });
  if (!payload) return null;
  const entry = eventLedger.appendEvent({ type: MINER_PR_OUTCOME_EVENT, repoFullName, payload });
  // AMS badge notify (#7657): fire-and-forget when a recipient login is known (loop-cli passes minerLogin).
  const recipientLogin = typeof options.recipientLogin === "string" ? options.recipientLogin.trim() : "";
  if (recipientLogin) {
    const schedule = options.scheduleAmsNotifications ?? scheduleAmsNotificationEvents;
    schedule(
      [
        buildAmsPrOutcomePayload({
          recipientLogin,
          repoFullName,
          pullNumber: payload.prNumber,
          decision: payload.decision,
          closedAt: payload.closedAt,
        }),
      ],
      { env: options.env ?? process.env },
    );
  }
  return entry;
}

/**
 * Reconstruct the latest outcome per repo/PR from the ledger's ascending append-only event stream (mirrors
 * manage-status.js's `indexLatestManageUpdates`). Reads via the injected ledger's `readEvents(filter)` and reduces
 * the pure result — a later event for the same repo/PR supersedes an earlier one. Returns a `Map` keyed by
 * `repoFullName:prNumber`.
 */
export function readPrOutcomes(
  eventLedger: PrOutcomeLedgerReader | null | undefined,
  filter: { since?: number; repoFullName?: string } = {},
): Map<string, NormalizedPrOutcomePayload & { repoFullName: string }> {
  const events = eventLedger && typeof eventLedger.readEvents === "function" ? eventLedger.readEvents(filter) : [];
  const latest = new Map<string, NormalizedPrOutcomePayload & { repoFullName: string }>();
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== "object") continue;
    const row = event as { type?: unknown; repoFullName?: unknown; payload?: unknown };
    if (row.type !== MINER_PR_OUTCOME_EVENT) continue;
    if (typeof row.repoFullName !== "string" || !row.repoFullName.trim()) continue;
    const normalized = normalizePrOutcomePayload(row.payload);
    if (!normalized) continue;
    // Re-key on every event so Map iteration order tracks most-recently-UPDATED last, not first-seen (#7222). A
    // bare Map.set() on an existing key updates the value but leaves the key frozen at its original position, so a
    // later outcome for the same PR (e.g. closed-without-merge, then reopened + merged) stayed at its old slot --
    // breaking recency-ordered consumers like loop-reentry.js's countConsecutiveDisengagements. Deleting first
    // moves the freshly-updated entry to the end, matching this reducer's own "a later event supersedes" contract.
    const key = `${row.repoFullName}:${normalized.prNumber}`;
    latest.delete(key);
    latest.set(key, { ...normalized, repoFullName: row.repoFullName });
  }
  return latest;
}
