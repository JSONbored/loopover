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
/** Event-ledger vocabulary for a miner-local PR outcome. */
export const MINER_PR_OUTCOME_EVENT = "pr_outcome";
/** The terminal decisions a miner records for one of its own PRs. */
export const MINER_PR_OUTCOME_DECISIONS = Object.freeze(["merged", "closed"]);
const decisionSet = new Set(MINER_PR_OUTCOME_DECISIONS);
const reasonSet = new Set(REJECTION_REASONS);
function optionalString(value) {
    if (value === undefined || value === null)
        return null;
    if (typeof value !== "string")
        return null;
    const trimmed = value.trim();
    return trimmed || null;
}
/**
 * Validate + normalize a PR-outcome payload; returns `null` on any malformed shape (mirrors manage-status.js's
 * `normalizeManageUpdatePayload`, so a bad row can neither be written nor read back). A `closed` decision may carry
 * a reason bucket drawn from {@link REJECTION_REASONS} (shared with the rejection-state-machine sibling); a `merged`
 * decision — or an unrecognized reason — normalizes the reason to `null` (a merged PR has no rejection reason).
 */
export function normalizePrOutcomePayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
        return null;
    const record = payload;
    if (!Number.isInteger(record.prNumber) || record.prNumber <= 0)
        return null;
    const decision = optionalString(record.decision);
    if (!decision || !decisionSet.has(decision))
        return null;
    const reasonRaw = optionalString(record.reason);
    const reason = decision === "closed" && reasonRaw !== null && reasonSet.has(reasonRaw) ? reasonRaw : null;
    return {
        prNumber: record.prNumber,
        decision: decision,
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
export function recordPrOutcomeSnapshot(input, options = {}) {
    const eventLedger = options.eventLedger;
    if (!eventLedger || typeof eventLedger.appendEvent !== "function")
        throw new Error("invalid_event_ledger");
    const repoFullName = typeof input?.repoFullName === "string" ? input.repoFullName.trim() : "";
    if (!repoFullName)
        return null;
    const payload = normalizePrOutcomePayload({
        prNumber: input?.prNumber,
        decision: input?.decision,
        closedAt: input?.closedAt,
        reason: input?.reason,
    });
    if (!payload)
        return null;
    return eventLedger.appendEvent({ type: MINER_PR_OUTCOME_EVENT, repoFullName, payload: payload });
}
/**
 * Reconstruct the latest outcome per repo/PR from the ledger's ascending append-only event stream (mirrors
 * manage-status.js's `indexLatestManageUpdates`). Reads via the injected ledger's `readEvents(filter)` and reduces
 * the pure result — a later event for the same repo/PR supersedes an earlier one. Returns a `Map` keyed by
 * `repoFullName:prNumber`.
 */
export function readPrOutcomes(eventLedger, filter = {}) {
    const events = eventLedger && typeof eventLedger.readEvents === "function" ? eventLedger.readEvents(filter) : [];
    const latest = new Map();
    for (const event of Array.isArray(events) ? events : []) {
        const record = event;
        if (record?.type !== MINER_PR_OUTCOME_EVENT)
            continue;
        if (typeof record.repoFullName !== "string" || !record.repoFullName.trim())
            continue;
        const normalized = normalizePrOutcomePayload(record.payload);
        if (!normalized)
            continue;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicHItb3V0Y29tZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInByLW91dGNvbWUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsaUhBQWlIO0FBQ2pILDBHQUEwRztBQUMxRyxpSEFBaUg7QUFDakgsOEJBQThCO0FBQzlCLEVBQUU7QUFDRiw2R0FBNkc7QUFDN0csK0dBQStHO0FBQy9HLDhHQUE4RztBQUM5RyxrSEFBa0g7QUFDbEgsMkZBQTJGO0FBRTNGLE9BQU8sRUFBRSxpQkFBaUIsRUFBRSxNQUFNLDBCQUEwQixDQUFDO0FBRzdELDREQUE0RDtBQUM1RCxNQUFNLENBQUMsTUFBTSxzQkFBc0IsR0FBRyxZQUFZLENBQUM7QUFJbkQscUVBQXFFO0FBQ3JFLE1BQU0sQ0FBQyxNQUFNLDBCQUEwQixHQUFzQyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsUUFBUSxFQUFFLFFBQVEsQ0FBQyxDQUFDLENBQUM7QUEyQmpILE1BQU0sV0FBVyxHQUFnQixJQUFJLEdBQUcsQ0FBQywwQkFBMEIsQ0FBQyxDQUFDO0FBQ3JFLE1BQU0sU0FBUyxHQUFnQixJQUFJLEdBQUcsQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDO0FBRTFELFNBQVMsY0FBYyxDQUFDLEtBQWM7SUFDcEMsSUFBSSxLQUFLLEtBQUssU0FBUyxJQUFJLEtBQUssS0FBSyxJQUFJO1FBQUUsT0FBTyxJQUFJLENBQUM7SUFDdkQsSUFBSSxPQUFPLEtBQUssS0FBSyxRQUFRO1FBQUUsT0FBTyxJQUFJLENBQUM7SUFDM0MsTUFBTSxPQUFPLEdBQUcsS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDO0lBQzdCLE9BQU8sT0FBTyxJQUFJLElBQUksQ0FBQztBQUN6QixDQUFDO0FBRUQ7Ozs7O0dBS0c7QUFDSCxNQUFNLFVBQVUseUJBQXlCLENBQUMsT0FBZ0I7SUFDeEQsSUFBSSxDQUFDLE9BQU8sSUFBSSxPQUFPLE9BQU8sS0FBSyxRQUFRLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUM7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