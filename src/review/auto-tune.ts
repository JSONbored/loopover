// Autonomous self-improvement — accuracy circuit-breaker (#self-improve, reviewbot→gittensory convergence).
// The ONE tuning action safe to take unattended: when the gate eval shows merge precision dropping below a
// floor over a real sample, the system DISABLES its own auto-merge for that project (sets the holdonly flag)
// so it stops repeating a bad call, and alerts a human. It only ever makes itself MORE cautious — loosening /
// going live stays with the advisor + a human. Forward-measured (no offline back-test): every decision keeps
// being scored, so engaging the breaker is judged on real outcomes, and a human clears it once fixed.
//
// SELF-CONTAINED NATIVE PORT: every type + helper this module needs is defined HERE. ZERO imports from
// reviewbot. The eval-report SHAPE (GateEvalReport/GateEvalRow) and the system-flags accessors
// (isHoldOnly/setFlag/flagSetAt) are inlined as INJECTED interfaces so this ports the PURE calibration logic
// without dragging in the engine. The logic is byte-faithful to the reviewbot source (src/core/auto-tune.ts);
// the only deltas are mechanical guards for gittensory's stricter tsconfig (noUncheckedIndexedAccess,
// exactOptionalPropertyTypes), which do not change behavior.
//
// DEFERRED INFRA (out of scope here — this ports the pure logic + tests):
//   • the `system_flags` D1 table the flag accessors read/write (holdonly:<scope> rows).
//   • the cron-tick wiring that calls applyAutoTune / maybeAutoClearHoldOnly each scheduled run.
//   • the live eval data source (computeGateEval over the review_audit store) that produces the report.
// The host wires those at cutover; the FlagStore interface below is the seam.

// ── Inlined eval-report shape (ported from reviewbot src/core/eval.ts) ──────────────────────────────────
// Only the fields the breaker reads are load-bearing, but the full row shape is preserved for a faithful port.

/** Per-project confusion matrix + precisions for the gate's PREDICTION vs the human's realized outcome. */
export interface GateEvalRow {
  project: string;
  wouldMerge: number;
  mergeConfirmed: number; // would-merge AND human merged
  mergeFalse: number; // would-merge BUT human closed (the dangerous error)
  wouldClose: number;
  closeConfirmed: number; // would-close AND human closed
  closeFalse: number; // would-close BUT human merged
  hold: number;
  decided: number; // predictions that have a known outcome
  mergePrecision: number | null;
  closePrecision: number | null;
}

/** The gate eval report: per-project rows + a coarse "enough data to read" flag. */
export interface GateEvalReport {
  rows: GateEvalRow[];
  /** True once at least one project has enough decided samples to read meaningfully. */
  hasSignal: boolean;
}

// ── Inlined operational-flag store seam (ported from reviewbot src/core/system-flags.ts) ────────────────
// The breaker only needs three flag operations. Expressed as an INJECTED interface so the pure logic is
// testable with a stub and the live D1-backed `system_flags` implementation is DEFERRED to the host.

/** The minimal operational-flag surface the breaker needs. The live impl is D1-backed (holdonly:<scope>
 *  rows); both reads fail OPEN (last-known / null) so a DB blip never silently changes behavior. */
export interface FlagStore {
  /** Circuit-breaker: is auto-merge disabled (would-merge → hold) for this project (or globally)? */
  isHoldOnly(project: string): Promise<boolean>;
  /** Set (or clear) a flag key (e.g. `holdonly:<project>`). */
  setFlag(key: string, on: boolean): Promise<void>;
  /** When a flag was set (its updated_at, UTC) — or null if unset. Used to age-out an auto-engaged breaker. */
  flagSetAt(key: string): Promise<string | null>;
}

// ── Calibration constants (faithful to reviewbot) ───────────────────────────────────────────────────────

// Engage the breaker only with a real sample AND a meaningful precision drop — never on noise.
export const AUTOTUNE_MIN_DECIDED = 10;
export const AUTOTUNE_MERGE_PRECISION_FLOOR = 0.85;
// Auto-clear an AUTO-engaged breaker after a cooldown IF precision is no longer failing. While held there are
// no new auto-merges to score, so this is a time-boxed retry: clear → auto-merge resumes → re-engages next
// eval if still bad. A human-set global freeze/holdonly is NEVER auto-cleared. (#272)
export const AUTOCLEAR_AFTER_MS = 24 * 60 * 60 * 1000;

export interface AutoTuneAction {
  project: string;
  mergePrecision: number;
  decided: number;
  message: string;
}

/** PURE: which projects' merge precision has dropped enough to warrant engaging the circuit-breaker? */
export function planAutoTune(report: GateEvalReport): AutoTuneAction[] {
  const actions: AutoTuneAction[] = [];
  for (const r of report.rows) {
    if (r.decided < AUTOTUNE_MIN_DECIDED || r.mergePrecision == null) continue;
    if (r.mergePrecision < AUTOTUNE_MERGE_PRECISION_FLOOR) {
      actions.push({
        project: r.project,
        mergePrecision: r.mergePrecision,
        decided: r.decided,
        message: `Auto-merge DISABLED for ${r.project}: merge precision ${Math.round(r.mergePrecision * 100)}% over ${r.decided} decided PR(s) (< ${Math.round(AUTOTUNE_MERGE_PRECISION_FLOOR * 100)}%). Would-merges now HOLD for review. Investigate, then clear holdonly:${r.project}.`,
      });
    }
  }
  return actions;
}

/** Engage the breaker for each flagged project that isn't already held. Returns the NEWLY engaged actions
 *  (so the caller audits + alerts once, not every cron tick). Fail-safe — a write error is swallowed. */
export async function applyAutoTune(flags: FlagStore, report: GateEvalReport): Promise<AutoTuneAction[]> {
  const engaged: AutoTuneAction[] = [];
  for (const action of planAutoTune(report)) {
    try {
      if (await flags.isHoldOnly(action.project)) continue; // already engaged → don't re-alert
      await flags.setFlag(`holdonly:${action.project}`, true);
      engaged.push(action);
    } catch (error) {
      console.log(JSON.stringify({ ev: "auto_tune_error", project: action.project, message: String(error).slice(0, 120) }));
    }
  }
  return engaged;
}

/** PURE: should an auto-engaged breaker for `project` be cleared now? True when the per-project holdonly flag
 *  was set ≥ AUTOCLEAR_AFTER_MS ago AND merge precision is no longer failing (recovered, or no recent merge
 *  predictions to judge). Never considers a human-set global holdonly (no per-project row → setAt is null). */
export function shouldAutoClear(report: GateEvalReport, project: string, setAtIso: string | null, nowMs: number): boolean {
  if (!setAtIso) return false; // not auto-engaged for THIS project (global breaker is human-only)
  // SQLite CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS" in UTC (no zone). Normalize to ISO and FORCE a UTC zone
  // when none is present, so a "T"-without-"Z" string is never parsed as LOCAL time (would skew the cooldown by
  // the host's offset). (#272 tz-fix, per P0 adversarial review)
  const t = setAtIso.includes("T") ? setAtIso : setAtIso.replace(" ", "T");
  const hasZone = t.endsWith("Z") || /[+-]\d\d:?\d\d$/.test(t);
  const setMs = Date.parse(hasZone ? t : `${t}Z`);
  if (!Number.isFinite(setMs) || nowMs - setMs < AUTOCLEAR_AFTER_MS) return false; // still in cooldown
  const row = report.rows.find((r) => r.project === project);
  const stillFailing = !!row && row.mergePrecision != null && row.decided >= AUTOTUNE_MIN_DECIDED && row.mergePrecision < AUTOTUNE_MERGE_PRECISION_FLOOR;
  return !stillFailing; // cooldown elapsed + precision recovered (or no signal) → clear and let it retry
}

/** Clear `project`'s auto-engaged breaker if the cooldown elapsed + precision recovered. Returns true if cleared. */
export async function maybeAutoClearHoldOnly(flags: FlagStore, report: GateEvalReport, project: string, nowMs: number): Promise<boolean> {
  try {
    const setAt = await flags.flagSetAt(`holdonly:${project}`);
    if (!shouldAutoClear(report, project, setAt, nowMs)) return false;
    await flags.setFlag(`holdonly:${project}`, false);
    return true;
  } catch {
    return false;
  }
}

// ── Tuning advisor (ported from reviewbot src/core/tuning.ts) ───────────────────────────────────────────
// The decision brain of the self-improvement loop: reads the gate eval and emits concrete, ranked
// recommendations — when a gate is ready to flip live, and which way to adjust it when it isn't. The SAFE
// half of the loop (recommend; a human or the soak-gated apply path applies). Pure → trivially testable.

export type RecSeverity = "good" | "warn" | "info";

/** Machine-consumable tightening the auto-apply path can write to the override store. ONLY ever describes a
 *  STRICTLY-TIGHTENING change (raise the floor / shrink the cap); the apply path enforces the direction
 *  against the live config. A loosening recommendation never carries a payload (autonomous loosening is the
 *  regression risk the loop exists to avoid). (#275) */
export interface OverridePayload {
  confidenceFloor?: number;
  scopeCap?: { files: number; lines: number };
}
export interface TuningRec {
  project: string;
  severity: RecSeverity;
  message: string;
  /** Present only on AUTO-APPLICABLE (tightening) recommendations. Auxiliary to `message`, never replaces it. */
  overridePayload?: OverridePayload;
}

// A gate is "ready to flip live" only with high merge precision AND no false closes over a real sample.
const MIN_DECIDED = 10;
const READY_MERGE_PRECISION = 0.95;
const READY_CLOSE_PRECISION = 0.9;
const RISK_MERGE_PRECISION = 0.9;
// The tighten TARGET for a merge-precision failure: raise the floor to the known-good "ready" bar. It is a
// project-agnostic, principled target — the apply path raises ONLY if it is above the project's current floor,
// so an already-strict project is never affected (and a higher target can't add a bad auto-merge). (#275)
const TIGHTEN_FLOOR_TARGET = READY_MERGE_PRECISION;

const pct = (x: number | null): string => (x == null ? "—" : `${Math.round(x * 100)}%`);

/** Turn the eval confusion-matrix into actionable, ranked tuning recommendations (warn before good). */
export function computeTuningRecommendations(report: GateEvalReport): TuningRec[] {
  const recs: TuningRec[] = [];
  for (const r of report.rows) {
    if (r.decided < MIN_DECIDED) {
      recs.push({ project: r.project, severity: "info", message: `Only ${r.decided} decided PR(s) — collect more shadow data before judging accuracy or flipping live.` });
      continue;
    }
    let flagged = false;
    // The dangerous error: would auto-merge something the human closed.
    if (r.mergePrecision != null && r.mergePrecision < RISK_MERGE_PRECISION) {
      recs.push({
        project: r.project,
        severity: "warn",
        message: `Would have auto-merged ${r.mergeFalse} PR(s) the human CLOSED (merge precision ${pct(r.mergePrecision)} over ${r.wouldMerge}). Tighten guardrails / raise the confidence floor — do NOT flip live yet.`,
        // Auto-applicable TIGHTENING: raise the floor to the ready bar. Strictly safe-ward (a higher floor can
        // only HOLD more would-merges, never add a bad one), so the apply path can promote it. (#275)
        overridePayload: { confidenceFloor: TIGHTEN_FLOOR_TARGET },
      });
      flagged = true;
    }
    // The other error: would auto-close something the human merged.
    if (r.closeFalse > 0) {
      recs.push({
        project: r.project,
        severity: "warn",
        message: `Would have auto-closed ${r.closeFalse} PR(s) the human MERGED (close precision ${pct(r.closePrecision)}). Loosen the area/scope rules before going live.`,
      });
      flagged = true;
    }
    if (!flagged && r.mergePrecision != null && r.mergePrecision >= READY_MERGE_PRECISION && (r.closePrecision == null || r.closePrecision >= READY_CLOSE_PRECISION)) {
      recs.push({
        project: r.project,
        severity: "good",
        message: `Merge precision ${pct(r.mergePrecision)} over ${r.decided} decided PR(s) with no false closes — looks ready to flip live (shadow:false).`,
      });
    }
  }
  // warn first, then good, then info — most actionable at the top.
  const order: Record<RecSeverity, number> = { warn: 0, good: 1, info: 2 };
  recs.sort((a, b) => order[a.severity] - order[b.severity] || a.project.localeCompare(b.project));
  return recs;
}
