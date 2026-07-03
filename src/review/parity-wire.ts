// Convergence prep (#preconv-parity) — the RECORDING + READINESS harness for the shadow-parity audit.
//
// PURPOSE: before any per-repo cutover from reviewbot to the gittensory-native review, we must PROVE the
// gittensory-native gate decision matches reviewbot's on the SAME PR at the SAME COMMIT. The pure comparison
// LOGIC already lives in src/review/parity.ts (computeGateParity / isParityCutoverReady). This module is the
// other half: it RECORDS the gittensory-native gate decision into the `review_audit` audit-source table
// (migration 0049) so the harness has data to read, and exposes the readiness rollup the endpoint serves.
//
// SHADOW CONTRACT on the CLOUD WORKER (must hold under every path there):
//   • flag-OFF (default) → recordNativeGateDecision is an immediate no-op (NO D1 write) and the parity endpoint
//     404s. The review path is BYTE-IDENTICAL to today: the recorder is the only new statement on the gate
//     path and it returns before touching D1 when off.
//   • flag-ON → SHADOW mode: the recorder writes ONE row per finalized gate decision with
//     source='gittensory-native'. It records ONLY; it NEVER changes what the gate does. The write is
//     best-effort (a failure is swallowed) so telemetry can never break finalization.
//
// SELF-HOSTED INSTANCES ALWAYS RECORD, regardless of the flag (#orb-telemetry-gate-decision-gap). The flag
// exists to guard write volume/cost on the SHARED Cloudflare D1 for a now-historical pre-cutover comparison
// use case -- a self-hosted instance's review_audit is its own local SQLite/Postgres, so there is no shared-
// resource concern, and this is the ONLY writer of gate_decision rows: exportOrbBatch's fleet-telemetry query
// (src/selfhost/orb-collector.ts) INNER JOINs gate_decision to pr_outcome, so without this row every self-host
// export silently returns zero events forever, even though pr_outcome rows (written unconditionally) exist.
//
// WHAT THIS RECORDS vs WHAT IS DEFERRED: this writes the gittensory-native (SHADOW) side only. The actual
// cross-system COMPARISON needs reviewbot's authoritative rows (source='reviewbot') in the SAME table — those
// are written by reviewbot during the deploy-time dual-run shadow step (both systems reviewing the same PRs),
// NOT here. This module + the endpoint read whatever has been recorded; the live shadow run is a deploy-time
// cutover step, out of scope for this PR.

import { computeGateParity, isParityCutoverReady, type GateAction, type GateParityRow } from "./parity";
import type { GateCheckConclusion } from "../rules/advisory";
import { isSelfHostedReviewRuntime } from "../selfhost/review-runtime";
import { errorMessage, nowIso } from "../utils/json";

/** True when the shadow-parity audit is enabled. Flag-OFF (default) → recordNativeGateDecision is a no-op and
 *  the parity endpoint 404s. Truthy follows the codebase convention (`/^(1|true|yes|on)$/i`, same as
 *  isOpsEnabled / isSelfTuneEnabled). */
export function isParityAuditEnabled(env: { GITTENSORY_REVIEW_PARITY_AUDIT?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test(env.GITTENSORY_REVIEW_PARITY_AUDIT ?? "");
}

/** The `source` discriminator this writer stamps on every row — the SHADOW side computeGateParity compares
 *  against the authoritative 'reviewbot' rows. */
export const GITTENSORY_NATIVE_SOURCE = "gittensory-native";

/** Cutover-readiness defaults the endpoint applies before computing parity: a 90-day window (the parity
 *  read's own default) over all recorded sources. The agreement FLOOR (0.98) + MIN sample (30) live in
 *  parity.ts (PARITY_AGREEMENT_FLOOR / MIN_PARITY_SAMPLE) and isParityCutoverReady enforces them. */
const PARITY_WINDOW_DAYS = 90;

/**
 * PURE: map a gittensory gate-check conclusion to the parity-comparable {@link GateAction}, or `null` when the
 * conclusion carries no comparable terminal decision.
 *
 * The gittensory gate is a CHECK that passes or blocks a merge — it NEVER auto-closes a PR. So the honest,
 * safe mapping is:
 *   • 'success'                        → 'merge' — the gate would ALLOW the merge.
 *   • 'failure' | 'action_required'    → 'hold'  — the gate BLOCKS the merge (holds it for a human); gittensory
 *                                                  does not close, so this is 'hold', not 'close'. This also
 *                                                  keeps the parity SAFETY metric honest: a shadow 'hold' is
 *                                                  never the dangerous "shadow merges where authoritative
 *                                                  wouldn't" direction.
 *   • 'neutral' | 'skipped'            → null    — no decision was made (not gated / pre-empted); not recorded,
 *                                                  so it is never paired.
 *
 * (computeGateParity only pairs 'merge' | 'close' | 'hold'; a null here means the row is simply not written.)
 */
export function nativeGateActionFromConclusion(conclusion: GateCheckConclusion): GateAction | null {
  switch (conclusion) {
    case "success":
      return "merge";
    case "failure":
    case "action_required":
      return "hold";
    default:
      return null; // neutral / skipped → no comparable decision
  }
}

/** The minimal env shape the recorder needs (the D1/local-DB binding, the flag, and the self-host signal). */
type ParityRecorderEnv = {
  DB: D1Database;
  GITTENSORY_REVIEW_PARITY_AUDIT?: string | undefined;
  SELFHOST_TRANSIENT_CACHE?: NonNullable<Env["SELFHOST_TRANSIENT_CACHE"]>;
};

/**
 * Record one gittensory-native gate decision into `review_audit` (source='gittensory-native').
 *
 * On the cloud worker: flag-OFF (default) → returns immediately, NO D1 write (the review path is byte-
 * identical); flag-ON → SHADOW-records for the pre-cutover parity comparison. On a self-hosted instance, this
 * ALWAYS records regardless of the flag (see the module header) — it's the instance's own local DB, and
 * exportOrbBatch's fleet-telemetry export depends on this data existing.
 *
 * Writes ONE row keyed `gate:<source>:<project>#<pr>@<sha>` with decision/head_sha/summary. RECORD-ONLY — it
 * never changes the gate. Best-effort: a write failure is swallowed (telemetry must not break finalization). A
 * conclusion with no comparable action (neutral/skipped) records nothing.
 *
 * Caller passes the FINALIZED gate conclusion + the head_sha it was evaluated on. The caller should also guard
 * on {@link isParityAuditEnabled} for the cloud-worker byte-identical-when-off contract, but this function
 * re-checks both the flag and the self-host signal so it is safe to call unconditionally.
 */
export async function recordNativeGateDecision(
  env: ParityRecorderEnv,
  input: { project: string; pullNumber: number; headSha: string | null | undefined; conclusion: GateCheckConclusion; reasonCode?: string | null | undefined },
): Promise<void> {
  // Self-hosted instances always record (their own local DB; exportOrbBatch needs this data). The cloud
  // worker keeps the exact flag-gated, byte-identical-when-off contract.
  if (!isSelfHostedReviewRuntime(env) && !isParityAuditEnabled(env)) return;
  const action = nativeGateActionFromConclusion(input.conclusion);
  if (action === null) return; // not a comparable decision (neutral/skipped) → nothing to record
  if (!input.headSha) return; // parity REQUIRES head_sha to pair a decision to a commit; no sha → not comparable
  const project = input.project.slice(0, 200);
  const targetId = `${project}#${input.pullNumber}`;
  const summary = input.reasonCode ? input.reasonCode.slice(0, 200) : null;
  try {
    // Deterministic id per (source, project, pr, sha): a re-run at the SAME commit REPLACES its prior decision
    // (the latest finalize wins), while a new commit gets its own row. event_type/source default in the schema
    // but are written explicitly for clarity.
    await env.DB.prepare(
      `INSERT INTO review_audit (id, project, target_id, event_type, decision, source, head_sha, summary, created_at)
       VALUES (?, ?, ?, 'gate_decision', ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET decision = excluded.decision, summary = excluded.summary, created_at = excluded.created_at`,
    )
      .bind(`gate:${GITTENSORY_NATIVE_SOURCE}:${targetId}@${input.headSha}`, project, targetId, action, GITTENSORY_NATIVE_SOURCE, input.headSha, summary, nowIso())
      .run();
  } catch (error) {
    // Telemetry must never break finalization.
    console.warn(JSON.stringify({ ev: "parity_audit_record_error", project, pr: input.pullNumber, message: errorMessage(error).slice(0, 200) }));
  }
}

// ── Readiness rollup the endpoint serves ────────────────────────────────────────────────────────────────────

/** One project's parity row plus the hard cutover-ready verdict (isParityCutoverReady over the floor + min
 *  sample + zero unsafe disagreements). */
export interface ParityReadinessRow extends GateParityRow {
  cutoverReady: boolean;
}

export interface ParityReadinessReport {
  /** The authoritative writer (default 'reviewbot') and the shadow writer ('gittensory') being compared. */
  authoritative: string;
  shadow: string;
  /** Whether enough paired evidence exists anywhere to read parity meaningfully (>= MIN_PARITY_SAMPLE). */
  hasSignal: boolean;
  /** Per-project parity + per-project cutover-ready verdict. */
  rows: ParityReadinessRow[];
}

/**
 * Run computeGateParity over the recorded audit data and annotate each project with isParityCutoverReady.
 * Pure READ (D1 only via parity.ts, which is itself fail-safe → empty report). This is what the bearer-gated
 * GET /v1/internal/parity endpoint returns.
 *
 * Reads WHATEVER is recorded: with only gittensory-native rows present (no reviewbot dual-run yet) there are
 * no PAIRS, so rows is empty and hasSignal is false — the honest "not enough evidence to cut over" state. The
 * report becomes meaningful once reviewbot's authoritative rows land via the deploy-time shadow run.
 */
export async function computeParityReadiness(
  env: Env,
  opts: { nowMs?: number; days?: number; project?: string } = {},
): Promise<ParityReadinessReport> {
  const report = await computeGateParity(env, {
    days: opts.days ?? PARITY_WINDOW_DAYS,
    nowMs: opts.nowMs ?? Date.now(),
    // The shadow source MUST match what recordNativeGateDecision stamps ('gittensory-native'); computeGateParity
    // defaults `shadow` to 'gittensory', so pass it explicitly or the self-join would find no shadow rows. The
    // authoritative side stays the default 'reviewbot' (the deploy-time dual-run writer).
    shadow: GITTENSORY_NATIVE_SOURCE,
    ...(opts.project ? { project: opts.project } : {}),
  });
  return {
    authoritative: report.authoritative,
    shadow: report.shadow,
    hasSignal: report.hasSignal,
    rows: report.rows.map((row) => ({ ...row, cutoverReady: isParityCutoverReady(row) })),
  };
}
