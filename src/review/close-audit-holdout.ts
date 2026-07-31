// Randomized close-audit holdout (#8831, epic #8828 Phase 2) — the selective-labels fix.
//
// WHY: when the bot closes a PR we never observe whether merging would have been fine, so close-precision is
// estimated only on the closes humans happened to contest — a biased sample (Lakkaraju et al., KDD 2017).
// ORB is deterministic, so every off-policy estimator is undefined (propensities are 0/1, no overlap). The
// ONLY fix is randomization: a small fraction ε of would-AUTO-close PRs is HELD for human adjudication
// instead, with the draw and ε logged — the propensity record that makes counterfactual evaluation
// well-defined for the first time.
//
// PLACEMENT CONTRACT: the draw consumes the FINAL post-breaker plan — it runs after every gate/breaker
// decision is made and can therefore never influence the decision itself, only whether the already-decided
// close executes or is diverted to a human. ε = 0 (the default, and any repo without the
// gate.closeAuditHoldoutPct manifest knob) returns the plan untouched with zero I/O — byte-identical to
// today.
//
// SCOPE: heuristic closes only. Policy closes (contributor cap, blacklist, copycat, review-nag, linked-issue
// hard rule) are enforcement, not quality predictions (#8827) — holding one for an accuracy audit would
// suspend enforcement for no measurement gain. Staged (auto_with_approval) closes already get a human; only
// autonomy-auto closes need the instrument.
//
// #9135: the draw itself used to be `Math.random()`, recorded nowhere — two decisions with identical
// findings/policy could carry `action: "close"` and `action: "hold"` with no trace of why. Fixed by deriving
// the draw from `HMAC(instance secret, seed)` (see `computeHoldoutDraw` below) instead of raw entropy, and by
// returning the decision-time holdout outcome (`{epsilonPct, draw, diverted}`) alongside the plan so the
// caller can persist it — onto `DecisionRecord.divertedByHoldout` (public) and
// `DecisionReplayInput.holdout` (private, `src/review/decision-replay.ts`) — instead of dropping it on the
// floor. The HMAC seed is the decision's own eventual record id (`record:<repo>#<pr>@<head sha>`), so the
// draw is BOTH reproducible (an operator holding the instance secret can recompute it straight from the
// published record's own identity fields) AND unpredictable to a contributor without that secret trying to
// time a PR to dodge the holdout.
import { DECISION_AUDIT_RUBRIC_VERSION } from "./decision-audit";
import { recordAuditEvent } from "../db/repositories";
import { incr } from "../selfhost/metrics";
import { withManualReviewHoldLabel, type AgentDispositionLabelSettings, type PlannedAgentAction } from "../settings/agent-actions";
import type { DecisionReplayHoldout } from "./decision-replay";
import { hmacHex } from "../utils/crypto";
import { errorMessage, nowIso } from "../utils/json";

/** system_flags key for this instrument's own dedicated HMAC secret (#9135). */
const CLOSE_AUDIT_HOLDOUT_SECRET_FLAG = "close_audit_holdout:secret";

/** 256-bit random secret, lowercase hex. Web Crypto (worker + node) -- no external dependency needed for a
 *  one-shot key generation. */
function generateHoldoutSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The instance's dedicated secret for deriving the close-audit holdout draw (#9135) — 256-bit, generated
 * once and persisted in `system_flags`, race-safe across instances sharing a Postgres DB (INSERT OR IGNORE +
 * re-read, mirroring `src/selfhost/orb-collector.ts`'s `getOrCreateAnonSecret`). SINGLE-PURPOSE: never the
 * telemetry anonymization secret, the GitHub App private key, or any webhook-verification secret (key
 * separation, the same discipline those other secrets already follow) — reusing one of them here would let
 * this instrument's own published draw values leak information about a differently-scoped credential, and
 * mixing this secret into telemetry hashing would do the reverse.
 */
async function getOrCreateCloseAuditHoldoutSecret(env: Env): Promise<string> {
  const read = async (): Promise<string | undefined> => {
    const row = await env.DB.prepare("SELECT value FROM system_flags WHERE key = ?")
      .bind(CLOSE_AUDIT_HOLDOUT_SECRET_FLAG)
      .first<{ value: string }>();
    return row?.value;
  };
  const existing = await read();
  if (existing) return existing;
  const generated = generateHoldoutSecret();
  await env.DB.prepare("INSERT OR IGNORE INTO system_flags (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
    .bind(CLOSE_AUDIT_HOLDOUT_SECRET_FLAG, generated)
    .run();
  /* v8 ignore next -- a row always exists after INSERT OR IGNORE, so the ?? fallback is unreachable */
  return (await read()) ?? generated;
}

/** The deterministic seed a decision's draw is derived from — the SAME string `buildDecisionRecord`'s caller
 *  assembles as the record id (`record:<repo>#<pr>@<head sha>`), so a verifier holding the instance secret
 *  can recompute the draw directly from the published record's own identity fields, with no side channel
 *  beyond the secret itself. Every re-evaluation of the same (repo, PR, head sha) reproduces the identical
 *  seed, and therefore the identical draw — the holdout does not re-flip a coin on every webhook retry. */
function holdoutSeed(repoFullName: string, pullNumber: number, headSha: string | null | undefined): string {
  return `record:${repoFullName}#${pullNumber}@${headSha ?? "unknown"}`;
}

/** Map an HMAC-SHA256 hex digest to a [0,1) float from its first 4 bytes (32 bits) — the same width
 *  `Math.random()` promises, uniform enough for a fairness-audit draw (this is a reproducible SUBSTITUTE for
 *  `Math.random()`, not a cryptographic use of the resulting number). Exported so tests can assert the exact
 *  mapping against a known HMAC output. */
export function hmacHexToUnitFloat(hex: string): number {
  return Number.parseInt(hex.slice(0, 8), 16) / 0x100000000;
}

/** The production draw (#9135): `HMAC(instance secret, seed)` rather than `Math.random()`, so it is
 *  reproducible from the record without storing raw entropy, and unpredictable to a contributor who does not
 *  hold the instance secret trying to time a PR to dodge the holdout. */
async function computeHoldoutDraw(env: Env, seed: string): Promise<number> {
  const secret = await getOrCreateCloseAuditHoldoutSecret(env);
  return hmacHexToUnitFloat(await hmacHex(secret, seed));
}

/** A planned close the holdout may divert: heuristic (quality) closes executing WITHOUT a human in the loop. */
export function holdoutEligibleClose(planned: PlannedAgentAction[]): PlannedAgentAction | undefined {
  return planned.find((action) => action.actionClass === "close" && action.closeKind === "heuristic" && action.requiresApproval !== true);
}

/** PURE plan transform: drop the eligible close(s) and surface the manual-review label, mirroring
 *  downgradeCloseToHold's conversion exactly (drop + idempotent label add, never a merge/approve). */
export function applyCloseAuditHoldout(planned: PlannedAgentAction[], labelSettings: AgentDispositionLabelSettings = {}): PlannedAgentAction[] {
  const isEligible = (action: PlannedAgentAction): boolean => action.actionClass === "close" && action.closeKind === "heuristic" && action.requiresApproval !== true;
  const next = planned.filter((action) => !isEligible(action));
  // #10164: via withManualReviewHoldLabel, which also drops a planned RELEASE of this same label. This
  // transform is where the flap was actually observed -- JSONbored/loopover#10155 cycled the label roughly
  // every 90 seconds because the planner's release and this add both landed in one plan.
  return withManualReviewHoldLabel(next, labelSettings, {
    // Authorized by `close` — the class actually being diverted (#label-scoping, mirrors downgradeCloseToHold).
    autonomyClass: "close",
    requiresApproval: false,
    reason: "close-audit holdout drew this PR — would-close held for human adjudication (#8831)",
  });
}

/**
 * The full holdout step: eligibility → draw → (on fire) divert the plan, persist the propensity record and
 * the pending adjudication label row. Returns the (possibly diverted) plan AND the decision-time holdout
 * outcome (#9135) so the caller can persist it onto the decision record and its replay input — `null` when
 * the holdout never evaluated at all (ε absent/0, close autonomy not auto, or no eligible close — the
 * overwhelmingly common, zero-I/O path).
 *
 * Best-effort persistence with a HARD ordering rule: the plan is only diverted when the propensity record
 * WROTE — a hold whose draw was never logged is invisible to every downstream estimator and would silently
 * bias coverage, so on a write failure the close proceeds unheld (the instrument, not the gate, degrades).
 * `holdout.diverted` always reflects what ACTUALLY happened to the plan (false on a write-failure
 * degradation too), never merely "the draw fell under ε."
 */
export async function maybeApplyCloseAuditHoldout(
  env: Env,
  input: {
    repoFullName: string;
    pullNumber: number;
    /** #9135: this decision's head sha — part of the deterministic draw seed (see `holdoutSeed`) and
     *  reproduced verbatim in the eventual decision record id. Absent only for a caller that genuinely has
     *  no head sha yet (mirrors `buildDecisionRecord`'s own `headSha ?? "unknown"` fallback). */
    headSha?: string | null | undefined;
    planned: PlannedAgentAction[];
    /** gate.closeAuditHoldoutPct — percent 0-20; absent/0/invalid disables. */
    epsilonPct: number | null | undefined;
    /** True only when close autonomy resolves to full-auto — staged closes already get a human. */
    closeAutonomyIsAuto: boolean;
    labelSettings?: AgentDispositionLabelSettings;
    rng?: () => number;
  },
): Promise<{ planned: PlannedAgentAction[]; holdout: DecisionReplayHoldout | null }> {
  const epsilonPct = input.epsilonPct ?? 0;
  if (epsilonPct <= 0 || !input.closeAutonomyIsAuto) return { planned: input.planned, holdout: null };
  const eligible = holdoutEligibleClose(input.planned);
  if (eligible === undefined) return { planned: input.planned, holdout: null };

  const draw = input.rng ? input.rng() : await computeHoldoutDraw(env, holdoutSeed(input.repoFullName, input.pullNumber, input.headSha));
  if (draw >= epsilonPct / 100) return { planned: input.planned, holdout: { epsilonPct, draw, diverted: false } };

  const targetId = `${input.repoFullName}#${input.pullNumber}`;
  try {
    // Propensity record FIRST (the ordering rule above). The label row rides the same try: the adjudication
    // queue entry and the propensity log land together or the close proceeds unheld.
    await recordAuditEvent(env, {
      eventType: "decision_audit_holdout",
      actor: null,
      targetKey: targetId,
      outcome: "completed",
      detail: `would-close held for adjudication (ε=${epsilonPct}%)`,
      // closeKind is pinned by holdoutEligibleClose's predicate — only heuristic closes are ever eligible.
      metadata: { repoFullName: input.repoFullName, pullNumber: input.pullNumber, epsilonPct, draw, counterfactualAction: "close", closeKind: "heuristic" },
    });
    await env.DB.prepare(
      `INSERT OR IGNORE INTO decision_audit_labels (id, project, target_id, verdict, outcome, stratum, rubric_version, sampled_at)
       VALUES (?, ?, ?, 'close', NULL, 'holdout_close', ?, ?)`,
    )
      .bind(`audit:${targetId}`.slice(0, 190), input.repoFullName.slice(0, 200), targetId, DECISION_AUDIT_RUBRIC_VERSION, nowIso())
      .run();
  } catch (error) {
    console.warn(JSON.stringify({ event: "close_audit_holdout_record_error", target: targetId, message: errorMessage(error).slice(0, 160) }));
    return { planned: input.planned, holdout: { epsilonPct, draw, diverted: false } }; // unlogged hold = biased instrument; the decided close proceeds instead
  }
  incr("loopover_close_audit_holdouts_total");
  return { planned: applyCloseAuditHoldout(input.planned, input.labelSettings), holdout: { epsilonPct, draw, diverted: true } };
}
