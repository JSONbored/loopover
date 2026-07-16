// Durable visual-preview poll budget (#6323): bounds how many times buildCapture will treat a still-building
// preview deploy as "keep trying" for a given head SHA, REGARDLESS of which trigger (the dedicated self-poll
// job chain, a CI-completion webhook, a deployment_status webhook, or a sweep pass) caused this particular
// buildCapture call.
//
// The pre-existing MAX_PREVIEW_POLLS cap in processors.ts only bounded the self-poll job chain's OWN
// `attempt` payload field. Every OTHER re-review trigger calls reReviewStoredPullRequest without threading
// that counter through at all, so it silently reads back as 0 -- each one independently re-arms a fresh
// 5-attempt budget. A repo whose CI never produces a discoverable preview deployment (buildCapture's
// discovery chain finds nothing to attach a URL to) then gets polled far more than 5 times total, for as
// long as ANY of those other triggers keeps firing. Confirmed live: JSONbored/metagraphed#6036 -- 12+
// re-review comment edits over 52+ minutes on a single PR, still ongoing when observed.
//
// This module makes the budget durable and keyed by headSha instead of by job-chain payload, mirroring
// actions-fallback.ts's own isFallbackDispatchInFlight/markFallbackDispatched R2-marker pattern exactly
// (same fail-open-on-read-error contract, same best-effort-write contract, same max-age fail-safe expiry so
// a marker can never block a genuinely NEW attempt forever). buildCapture consults + increments this before
// treating a "still building" preview-build state as poll-worthy; once the budget is exhausted for a head,
// buildCapture stops signaling previewPending for it, so EVERY caller's existing "only reschedule when
// previewPending" logic naturally stops rescheduling too -- no other call site needs to change.
import { sha256Hex } from "../../utils/crypto";

const BUDGET_R2_NAMESPACE = "loopover/preview-poll-budget/";
// A stale marker must eventually stop mattering even if nothing ever explicitly resets it (an abandoned PR,
// a repo whose preview pipeline was reconfigured) -- 24h comfortably outlives any real preview-build wait,
// well past actions-fallback.ts's own 18-minute dispatch-marker expiry for the same reason.
const BUDGET_MARKER_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// The total number of "still building, keep trying" attempts allowed per head SHA across ALL triggers
// combined -- the single source of truth processors.ts's own scheduling logic also imports, so the two
// never drift out of sync.
export const MAX_PREVIEW_POLL_ATTEMPTS = 5;

type BudgetMarker = { count: number; firstAttemptAt: number };

async function budgetR2Key(headSha: string): Promise<string> {
  const fingerprint = await sha256Hex(`${headSha}:preview-poll-budget`);
  return `${BUDGET_R2_NAMESPACE}${fingerprint.slice(0, 40)}.json`;
}

/** Shared read path for both public functions below. Returns null (fail-open toward "no attempts yet") on
 *  any read error, a malformed marker, or one older than BUDGET_MARKER_MAX_AGE_MS -- a stale marker is
 *  treated as absent, not as "budget still exhausted from a previous, unrelated review cycle". */
async function readBudgetMarker(env: Env, headSha: string): Promise<BudgetMarker | null> {
  if (!env.REVIEW_AUDIT) return null;
  try {
    const object = await env.REVIEW_AUDIT.get(await budgetR2Key(headSha));
    if (!object) return null;
    const marker = JSON.parse(await new Response(object.body).text()) as Partial<BudgetMarker>;
    if (typeof marker.count !== "number" || typeof marker.firstAttemptAt !== "number") return null;
    if (Date.now() - marker.firstAttemptAt >= BUDGET_MARKER_MAX_AGE_MS) return null;
    return { count: marker.count, firstAttemptAt: marker.firstAttemptAt };
  } catch {
    return null;
  }
}

/** How many preview-poll attempts have already been recorded for `headSha` -- 0 when no marker exists,
 *  storage is unavailable, or the existing marker has expired. Consulted by buildCapture BEFORE treating a
 *  "still building" preview state as worth another attempt. */
export async function previewPollAttemptCount(env: Env, headSha: string): Promise<number> {
  return (await readBudgetMarker(env, headSha))?.count ?? 0;
}

/** Record one more preview-poll attempt for `headSha`, preserving the marker's original `firstAttemptAt`
 *  across increments so BUDGET_MARKER_MAX_AGE_MS expires from the FIRST attempt in this cycle, not resets on
 *  every poll (which would let a marker live forever as long as attempts keep arriving inside the window).
 *  Best effort -- a failed write just means this specific attempt doesn't count toward the budget, degrading
 *  toward "keep trying a bit longer" rather than toward "stuck forever", the safer failure direction for a
 *  budget whose whole purpose is bounding retries, not enabling them. */
export async function recordPreviewPollAttempt(env: Env, headSha: string): Promise<void> {
  if (!env.REVIEW_AUDIT) return;
  try {
    const existing = await readBudgetMarker(env, headSha);
    const marker: BudgetMarker = { count: (existing?.count ?? 0) + 1, firstAttemptAt: existing?.firstAttemptAt ?? Date.now() };
    await env.REVIEW_AUDIT.put(await budgetR2Key(headSha), JSON.stringify(marker), { httpMetadata: { contentType: "application/json" } });
  } catch {
    // best effort -- see doc comment above
  }
}
