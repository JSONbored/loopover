// Rejection state machine (#4278): the missing detector + classifier that turns a closed-without-merge PR
// into a rejection-reason bucket and, for the first time, drives `renderRejectionMessage`
// (rejection-templates.js, which until now had zero callers outside its own test). Pure classification and
// content only — no GitHub calls, no network, no writes. The caller (a poller) persists the result locally.
//
// DESIGN DECISIONS (called out explicitly by #4278):
//   • "disengaged" is a per-PR OUTCOME, not a per-repo run-state. A rejection is about one PR, so it belongs
//     with the `manage-poll.js` outcome family (ready / needs-work / open), NOT `run-state.js`'s RUN_STATES
//     (idle / discovering / planning / preparing). `DISENGAGED_OUTCOME` is defined HERE and left for a poller
//     to adopt — this module deliberately does NOT mutate manage-poll.js's or run-state.js's enum as a side
//     effect (the issue explicitly warns against silently expanding another module's vocabulary).
//   • Zero-signal fallback: with no gate/duplicate signal, a rejection classifies as `maintainer_close_no_reason`
//     — the courteous, non-assuming bucket — rather than being left unclassified, so a rejection ALWAYS renders
//     a note.
//   • This surfaces the PR's terminal fields from a payload the poller already fetches (ci-poller.js's
//     `fetchHeadSha` GETs the full `/pulls/{n}` body, :155-163, and discards all but `head.sha`) via a pure
//     extractor — no second API call, and no behavioral change to the existing fetch.

import { renderRejectionMessage } from "./rejection-templates.js";

/** Per-PR terminal outcome for a rejected (closed-without-merge) PR. A poller adds this to its own outcome
 *  vocabulary alongside ready / needs-work / open. */
export const DISENGAGED_OUTCOME = "disengaged";

/**
 * Pull the terminal-outcome fields from a `GET /pulls/{n}` payload the poller already has. Pure — no API call.
 * Missing/malformed fields normalize to null/false so a partial payload never throws here.
 * @param {unknown} prPayload
 * @returns {{ state: string | null, merged: boolean, mergedAt: string | null, closedAt: string | null }}
 */
export function extractPrOutcomeFields(prPayload) {
  const p = prPayload && typeof prPayload === "object" ? prPayload : {};
  return {
    state: typeof p.state === "string" ? p.state : null,
    merged: p.merged === true,
    mergedAt: typeof p.merged_at === "string" ? p.merged_at : null,
    closedAt: typeof p.closed_at === "string" ? p.closed_at : null,
  };
}

/**
 * True when a PR is closed WITHOUT a merge — the rejection this state machine acts on. A merged PR (even though
 * GitHub also marks it `state: "closed"`) is NOT a rejection. Pure.
 * @param {{ state?: string | null, merged?: boolean }} fields
 */
export function isRejectedPr(fields) {
  const f = fields && typeof fields === "object" ? fields : {};
  return f.state === "closed" && f.merged !== true;
}

/**
 * Classify a detected rejection into one of the rejection-reason buckets from the available signal.
 * Precedence: an explicit gate close outranks a duplicate signal (the gate is the more specific, actionable
 * cause). With neither signal, defaults to `maintainer_close_no_reason` (the documented zero-signal fallback).
 * Pure.
 * @param {{ gateClosed?: boolean, supersededByDuplicate?: boolean }} [signal]
 * @returns {"gate_close" | "superseded_by_duplicate" | "maintainer_close_no_reason"}
 */
export function classifyRejectionReason(signal = {}) {
  const s = signal && typeof signal === "object" ? signal : {};
  if (s.gateClosed === true) return "gate_close";
  if (s.supersededByDuplicate === true) return "superseded_by_duplicate";
  return "maintainer_close_no_reason";
}

/**
 * The full transition. Given a PR payload, an optional gate/duplicate signal, and the render context
 * (`{ repoFullName, prNumber }`), decide whether the PR is a rejection and, if so, produce the disengaged
 * transition: the classified reason and the rendered courtesy note (this is `renderRejectionMessage`'s first
 * real caller). Returns null when the PR is not a rejection (still open, or merged) — nothing to disengage.
 * Pure and deterministic; the caller persists `{ outcome, reason, note }` via its local event ledger.
 * @returns {{ outcome: string, reason: string, note: string,
 *   fields: ReturnType<typeof extractPrOutcomeFields> } | null}
 */
export function resolveRejection(prPayload, signal, context) {
  const fields = extractPrOutcomeFields(prPayload);
  if (!isRejectedPr(fields)) return null;
  const reason = classifyRejectionReason(signal);
  const note = renderRejectionMessage(reason, context); // throws on malformed context — a half-note never emits
  return { outcome: DISENGAGED_OUTCOME, reason, note, fields };
}
