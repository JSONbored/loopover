// ORB/AMS reputation bridge (#6485), implementing #6208's decided design. ORB PULLS a submitter's AMS track
// record on demand and may only ever UPGRADE the locally-computed ReputationSignal toward "trusted" -- never
// downgrade it. Rationale (from #6208): a push model would let any AMS instance -- including a self-hosted one
// running against an arbitrary repo -- write arbitrary trust signals into ORB's internal reputation store, a
// direct gaming vector. Pull keeps ORB in control; upgrade-only closes the second vector (an AMS track record
// must never be usable punitively against a contributor's standing on an unrelated repo).
//
// Identity is plain `authorLogin` -- the same axis `submitter-reputation.ts` already keys on, and the same axis
// `TrackRecordPullRequestOutcome` already carries. No new identity system, and deliberately NOT hotkey/wallet
// (forbidden/redacted terms in this codebase).
//
// Privacy: `TrackRecordPullRequestOutcome` has no score/ranking/wallet/hotkey fields by construction, so the
// consumed shape is already safe -- nothing new to redact. STRICTLY INTERNAL, inherited from
// `submitter-reputation.ts`: never surfaced in a label, comment, or check-run.
//
// Fail-safe contract, matching every other guard in the reputation path: any fetch error, timeout, non-OK
// status, or malformed payload degrades to "no bonus signal applied" -- this must never throw into the gate.

import type { TrackRecordPullRequestOutcome } from "@loopover/engine";
import type { ReputationSignal } from "./submitter-reputation";

/** A slow or unreachable AMS instance must never slow gate evaluation -- a few hundred ms, consistent with the
 *  other fail-safe external reads in this codebase. */
export const AMS_TRACK_RECORD_TIMEOUT_MS = 400;

/** `trusted` needs at least this many merged AMS PRs. Mirrors `submitter-reputation.ts`'s "default GENEROUS"
 *  philosophy: a sparse record is simply no bonus, never a penalty. */
export const AMS_BRIDGE_TRUSTED_MIN_MERGED = 3;

/** …AND a merge rate at/above this share of that submitter's terminal AMS outcomes (0–1). */
export const AMS_BRIDGE_TRUSTED_MIN_MERGE_RATE = 0.6;

export type AmsTrackRecordFetch = (url: string, init: RequestInit) => Promise<Response>;

export type AmsBridgeOptions = {
  /** The operator-configured AMS endpoint base (`LOOPOVER_AMS_TRACK_RECORD_URL`). */
  endpoint: string | undefined;
  fetchImpl?: AmsTrackRecordFetch | undefined;
  timeoutMs?: number | undefined;
};

/** PURE: is a raw value a usable TrackRecordPullRequestOutcome for this bridge? Only the two fields the bridge
 *  actually reads are required -- a payload carrying extra keys is fine (and any score-ish key is simply never
 *  read), but one missing `authorLogin`/`state` is malformed and dropped. */
function isUsableOutcome(value: unknown): value is TrackRecordPullRequestOutcome {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.authorLogin === "string" && row.authorLogin.trim() !== "" && typeof row.state === "string";
}

/** PURE: keep only this login's outcomes from a payload. Case-insensitive, matching GitHub login semantics. */
export function outcomesForLogin(rows: readonly unknown[], login: string): TrackRecordPullRequestOutcome[] {
  const wanted = login.trim().toLowerCase();
  if (!wanted) return [];
  return rows.filter(isUsableOutcome).filter((row) => row.authorLogin.trim().toLowerCase() === wanted);
}

/**
 * PURE: does this AMS track record qualify the submitter as `trusted`? Deliberately a single boolean rather
 * than a full ReputationSignal: the bridge is upgrade-only, so "does not qualify" and "looks bad" are the same
 * outcome (no bonus) -- there is no representable way for AMS data to push a submitter down.
 */
export function amsRecordQualifiesAsTrusted(outcomes: readonly TrackRecordPullRequestOutcome[]): boolean {
  const merged = outcomes.filter((o) => o.state === "merged").length;
  // Only TERMINAL outcomes form the denominator: an open PR is not yet evidence either way.
  const terminal = outcomes.filter((o) => o.state === "merged" || o.state === "closed").length;
  if (merged < AMS_BRIDGE_TRUSTED_MIN_MERGED) return false;
  /* v8 ignore next -- merged >= 3 above guarantees terminal >= 3, so terminal is never 0 here; the guard is kept
     so a future caller passing pre-filtered rows can never divide by zero. */
  if (terminal === 0) return false;
  return merged / terminal >= AMS_BRIDGE_TRUSTED_MIN_MERGE_RATE;
}

/**
 * PURE: the upgrade-only merge. `neutral`/`low` may move to `trusted` when AMS vouches; nothing else changes.
 * An already-`trusted` submitter is unaffected, and no input can ever move a submitter DOWN -- the whole point
 * of #6208's upgrade-only weighting.
 */
export function upgradeReputationSignal(local: ReputationSignal, amsTrusted: boolean): ReputationSignal {
  return amsTrusted ? "trusted" : local;
}

/**
 * Fetch a login's AMS track record from the operator-configured endpoint. Returns null -- meaning "no bonus
 * signal applied" -- when the bridge has no endpoint configured, the login is blank, or the call fails in ANY
 * way (network error, timeout, non-OK status, non-array/malformed body). Never throws.
 */
export async function fetchAmsTrackRecord(login: string, options: AmsBridgeOptions): Promise<TrackRecordPullRequestOutcome[] | null> {
  const endpoint = typeof options.endpoint === "string" ? options.endpoint.trim().replace(/\/+$/, "") : "";
  const submitter = typeof login === "string" ? login.trim() : "";
  if (!endpoint || !submitter) return null;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? AMS_TRACK_RECORD_TIMEOUT_MS;
  try {
    const response = await fetchImpl(`${endpoint}/track-record/${encodeURIComponent(submitter)}`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    // Accept either a bare array or a { pullRequests: [...] } envelope; anything else is malformed → no bonus.
    const rows = Array.isArray(payload) ? payload : Array.isArray((payload as { pullRequests?: unknown })?.pullRequests) ? (payload as { pullRequests: unknown[] }).pullRequests : null;
    if (!rows) return null;
    return outcomesForLogin(rows, submitter);
  } catch {
    return null; // fail-safe: unreachable / timed out / malformed JSON ⇒ no bonus, never a throw into the gate.
  }
}

/**
 * The bridge entry point: given the locally-computed signal, return the possibly-UPGRADED signal for `login`.
 * Callers must only invoke this once `resolveConvergedFeature(env, manifest, "amsReputationBridge", repo)` is
 * true; when the feature is off this is never reached and the local signal stands, byte-identical to today.
 */
export async function bridgeAmsReputation(local: ReputationSignal, login: string | undefined, options: AmsBridgeOptions): Promise<ReputationSignal> {
  // Already at the ceiling — skip the network entirely; an upgrade-only bridge has nothing to add.
  if (local === "trusted") return local;
  if (!login) return local;
  const outcomes = await fetchAmsTrackRecord(login, options);
  if (outcomes === null) return local;
  return upgradeReputationSignal(local, amsRecordQualifiesAsTrusted(outcomes));
}
