// AMS → ORB reputation bridge (#6485, implementing the #6208 design decision). An opt-in, PULL-only,
// UPGRADE-only read path that lets a submitter's genuine AMS (Autonomous Miner Score) track record IMPROVE —
// never worsen — the INTERNAL reputation signal `submitter-reputation.ts` derives. STRICTLY INTERNAL, exactly
// like every other reputation input: the AMS bridge NEVER surfaces publicly (no label, comment, or check-run);
// it only feeds the private AI-spend gate via `reputation-wire.ts`.
//
// Why this shape (verbatim from #6208's pinned decision):
//   • GitHub-login-keyed — reuses the same public `authorLogin` axis the reputation module already keys on; no
//     new hotkey/wallet identity surface (those are forbidden/redacted terms in this codebase).
//   • ORB PULLS from AMS (never AMS pushing into ORB) — a push model would let any AMS instance write arbitrary
//     trust into ORB's store, a direct gaming vector. Pull keeps ORB in control and degrades like every other
//     optional signal here: AMS unreachable/absent → no bonus, neutral default, NEVER throws into the gate.
//   • UPGRADE-only — a strong AMS record can move a submitter toward `trusted`, NEVER toward `low`. This closes
//     the exact gaming vector #6208's Boundaries flagged: an AMS record must never be usable punitively.
//   • Privacy-safe by construction — consumes the existing, versioned `TrackRecordSummaryReadResult` contract
//     (#6246), which has no score/ranking/wallet/hotkey fields, so nothing new can cross the public boundary.
//
// Config-as-code, DEFAULT OFF: gated behind `LOOPOVER_REVIEW_AMS_BRIDGE` (same on/off regex convention as
// `isReputationEnabled`) AND an operator-set `LOOPOVER_AMS_ENDPOINT`. With either unset the whole path is an
// immediate no-op that returns the caller's signal untouched — byte-identical behavior for any repo that has
// not opted in or has no AMS instance. Timeout-bounded so a slow/unreachable AMS never slows gate evaluation.

import { PRODUCT_USER_AGENT } from "../github/client";
import { TRACK_RECORD_SUMMARY_READ_VERSION, type TrackRecordSummary, type TrackRecordSummaryReadResult } from "../../packages/loopover-engine/src/track-record-summary";
import type { ReputationSignal } from "./submitter-reputation";

/** A slow or unreachable AMS instance must never slow gate evaluation — a few hundred ms, consistent with this
 *  codebase's other fail-safe external-read patterns. The whole feature is off by default, so this only ever
 *  applies once an operator has explicitly pointed ORB at a LOCAL AMS endpoint. */
export const AMS_BRIDGE_TIMEOUT_MS = 300;

/** Tunable thresholds for what counts as a "strong" AMS track record worth an upgrade. GENERIC mechanism (it
 *  reveals no review DIRECTION), so the defaults are committed. Deliberately conservative: only a solid,
 *  clearly-positive record lifts a signal — a sparse or middling one yields no bonus (neutral). */
export interface AmsBridgeConfig {
  /** Need at least this many RESOLVED (merged + closed) public PRs before AMS can lift a signal at all. */
  minResolved: number;
  /** A merge ratio at/above this reads as a strong track record → `trusted`. */
  trustedMergeRatio: number;
}

/** The committed, behavior-preserving defaults. Mirrors the reputation module's own "solid recent record"
 *  philosophy (minSample 5 / a clear majority succeeding). */
export const DEFAULT_AMS_BRIDGE_CONFIG: AmsBridgeConfig = {
  minResolved: 5,
  trustedMergeRatio: 0.6,
};

/** True when the AMS bridge is switched on. Flag-OFF (default) → every helper here is a no-op. Same truthy
 *  convention as `isReputationEnabled` / `isSafetyEnabled` (`/^(1|true|yes|on)$/i`). */
export function isAmsBridgeEnabled(env: { LOOPOVER_REVIEW_AMS_BRIDGE?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test((env.LOOPOVER_REVIEW_AMS_BRIDGE ?? "").trim());
}

/** The operator-configured LOCAL AMS endpoint base URL, trimmed. Returns `undefined` when unset/blank — the
 *  bridge then degrades to a no-op (there is nothing to pull from). */
export function amsEndpointUrl(env: { LOOPOVER_AMS_ENDPOINT?: string | undefined }): string | undefined {
  const raw = env.LOOPOVER_AMS_ENDPOINT?.trim();
  return raw ? raw : undefined;
}

// Ordinal rank of each signal on the neutral-anchored axis the bridge moves along: low < neutral < trusted.
const SIGNAL_RANK: Record<ReputationSignal, number> = { low: 0, neutral: 1, trusted: 2 };

/** UPGRADE-only merge: the result is whichever of the two signals ranks HIGHER, so an AMS signal can only ever
 *  lift `current` toward `trusted` and can NEVER downgrade it — even if the AMS signal were somehow `low`. This
 *  is the single invariant the whole bridge exists to guarantee. Pure + total. */
export function applyAmsUpgrade(current: ReputationSignal, ams: ReputationSignal): ReputationSignal {
  return SIGNAL_RANK[ams] > SIGNAL_RANK[current] ? ams : current;
}

/** Derive the upgrade-only bonus signal from a pulled AMS track-record summary. Returns `trusted` ONLY for a
 *  clearly-strong, incident-free record (enough resolved PRs AND a high merge ratio); anything else — a public
 *  conduct incident, too little history, or a weak ratio — yields `neutral` (no bonus). NEVER returns `low`:
 *  the bridge is upgrade-only and must not manufacture a downgrade. Pure + total. */
export function amsSignalFromSummary(summary: TrackRecordSummary, cfg: AmsBridgeConfig = DEFAULT_AMS_BRIDGE_CONFIG): "trusted" | "neutral" {
  if (summary.incidents.hasPublicIncident) return "neutral";
  const { ratio, denominator } = summary.mergeRate;
  if (ratio !== null && denominator >= cfg.minResolved && ratio >= cfg.trustedMergeRatio) return "trusted";
  return "neutral";
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fail-safe parse of an untrusted AMS response into the versioned {@link TrackRecordSummaryReadResult} read
 *  contract (#6246). Returns `null` on ANY shape mismatch — not an object, an unexpected/absent envelope
 *  version, or a summary missing its `mergeRate` / `incidents` blocks — so a malformed response degrades to
 *  "no bonus" rather than trusting arbitrary caller-supplied fields. */
export function parseTrackRecordReadResult(value: unknown): TrackRecordSummaryReadResult | null {
  if (!isRecordObject(value)) return null;
  if (value.version !== TRACK_RECORD_SUMMARY_READ_VERSION) return null;
  const summary = value.summary;
  if (!isRecordObject(summary)) return null;
  if (!isRecordObject(summary.mergeRate)) return null;
  if (!isRecordObject(summary.incidents)) return null;
  return value as unknown as TrackRecordSummaryReadResult;
}

/** Pull one submitter's AMS track-record summary from the operator's LOCAL endpoint. Fail-safe: any fetch
 *  error, timeout, non-OK status, or malformed body degrades to `null` (no bonus signal) — it must NEVER throw
 *  into the gate, matching every other guard in the reputation path. Timeout-bounded by
 *  {@link AMS_BRIDGE_TIMEOUT_MS}. The login is passed as a `login` query parameter on the operator's base URL. */
export async function fetchAmsTrackRecord(login: string, endpoint: string): Promise<TrackRecordSummaryReadResult | null> {
  try {
    const url = new URL(endpoint);
    url.searchParams.set("login", login);
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": PRODUCT_USER_AGENT },
      signal: AbortSignal.timeout(AMS_BRIDGE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return parseTrackRecordReadResult(await response.json());
  } catch {
    return null; // fail-safe — a slow/unreachable/malformed AMS instance yields no bonus, never throws.
  }
}

/** The bridge entry point: given a submitter and their already-computed ORB reputation signal, PULL their AMS
 *  track record and return the (upgrade-only) merged signal. A no-op returning `current` unchanged when the
 *  bridge is off, unconfigured, the submitter is absent, the signal is already `trusted` (nothing to lift, so
 *  the external read is skipped entirely), or the AMS read yields nothing. Fully fail-safe — never throws. */
export async function bridgeAmsReputation(env: Env, args: { submitter: string | null | undefined; current: ReputationSignal }): Promise<ReputationSignal> {
  const { current } = args;
  if (!isAmsBridgeEnabled(env)) return current;
  if (current === "trusted") return current;
  const endpoint = amsEndpointUrl(env);
  if (!endpoint) return current;
  const submitter = args.submitter?.trim();
  if (!submitter) return current;
  const read = await fetchAmsTrackRecord(submitter, endpoint);
  if (!read) return current;
  return applyAmsUpgrade(current, amsSignalFromSummary(read.summary));
}
