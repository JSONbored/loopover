// Gate eval + cross-system gate-decision PARITY harness (#gate-eval / #preconv-parity).
//
// Two pure read-only analyses over the gate-decision audit log:
//   computeGateEval  — scores ONE system's PREDICTION (persisted `gate_decision` would-action) against
//                      GROUND TRUTH (the PR's real `pr_outcome` — merged vs closed). The human's normal
//                      merge/close IS the answer key, so accuracy is measurable with zero manual labeling.
//   computeGateParity — compares TWO systems (an authoritative writer vs a shadow writer) against EACH
//                      OTHER on the SAME PR at the SAME COMMIT, to prove the gittensory-app gate matches
//                      reviewbot's before a per-repo cutover. isParityCutoverReady is the hard gate.
//
// SELF-CONTAINED NATIVE PORT (reviewbot→gittensory convergence): every type + helper this module needs is
// defined HERE. No imports from reviewbot — the reviewbot `storage(env)` adapter is inlined as `env.DB`, and
// `Env` is gittensory's global ambient interface (referenced directly). The FOLD logic + SQL are byte-faithful
// to the reviewbot source (src/core/eval.ts); the only deltas are mechanical guards for gittensory's stricter
// tsconfig (noUncheckedIndexedAccess / exactOptionalPropertyTypes), which don't change behavior.
//
// ⚠ LIVE-USE PREREQUISITE (OUT OF SCOPE here): using this live requires gittensory's gate-decision audit rows
// to carry a `source` (which writer) + `head_sha` (which commit) column — computeGateParity self-joins on
// (project, target_id, head_sha) per source, and computeGateEval can scope predictions by source. Those
// columns land in a LATER D1 migration. This port is the PURE functions + their tests; the reads degrade
// fail-safe (empty report) against any schema that doesn't yet have them.

// ── Inlined minimal deps (no reviewbot imports) ─────────────────────────────────────────────────────────

/** The D1 binding this module reads. `Env` is gittensory's global ambient interface (env.DB: D1Database); it is
 *  referenced directly. The reviewbot `storage(env)` adapter maps to `env.DB` here. */
function storage(env: Env): D1Database {
  return env.DB;
}

// ── computeGateEval: one system's prediction vs the realized human outcome (#gate-eval) ───────────────────

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

export interface GateEvalReport {
  rows: GateEvalRow[];
  /** True once at least one project has enough decided samples to read meaningfully. */
  hasSignal: boolean;
}

const MIN_DECIDED_FOR_SIGNAL = 10;

/** Join the latest prediction (gate_decision) and the latest ground truth (pr_outcome) per target, then
 *  fold into a per-project confusion matrix + precisions. Pure read; fail-safe → empty report.
 *  `source` scopes the predictions to ONE writer (#preconv-parity standalone accuracy) — default the
 *  authoritative 'reviewbot' rows when set; omit to score ALL writers' predictions as before. The
 *  pr_outcome (ground truth) is the human's realized merge/close, so it is NOT source-scoped — both
 *  systems are graded against the same answer key. */
export async function computeGateEval(env: Env, opts: { days: number; nowMs: number; source?: string }): Promise<GateEvalReport> {
  const days = Number.isFinite(opts.days) && opts.days > 0 ? Math.min(opts.days, 730) : 90;
  const fromIso = new Date(opts.nowMs - days * 86_400_000).toISOString().slice(0, 10);
  // SQLite "bare column with MAX()" picks the column from the max-created_at row → the LATEST decision /
  // outcome per target (a reopened+reclosed PR keeps its final state).
  const sourceFilter = opts.source ? "AND source = ?" : "";
  const sql = `
    WITH gd AS (
      SELECT target_id, project, decision AS pred, MAX(created_at) AS t
      FROM review_audit WHERE event_type = 'gate_decision' AND decision IS NOT NULL AND created_at >= ? ${sourceFilter}
      GROUP BY target_id
    ),
    po AS (
      SELECT target_id, decision AS truth, MAX(created_at) AS t
      FROM review_audit WHERE event_type = 'pr_outcome' AND decision IS NOT NULL
      GROUP BY target_id
    )
    SELECT gd.project AS project, gd.pred AS pred, po.truth AS truth, COUNT(*) AS n
    FROM gd JOIN po ON gd.target_id = po.target_id
    GROUP BY gd.project, gd.pred, po.truth`;

  let cells: Array<{ project: string; pred: string; truth: string; n: number }> = [];
  try {
    const stmt = storage(env).prepare(sql);
    const bound = opts.source ? stmt.bind(fromIso, opts.source) : stmt.bind(fromIso);
    const res = await bound.all<{ project: string; pred: string; truth: string; n: number }>();
    cells = res.results ?? [];
  } catch {
    return { rows: [], hasSignal: false };
  }

  const byProject = new Map<string, GateEvalRow>();
  const row = (p: string): GateEvalRow => {
    let r = byProject.get(p);
    if (!r) {
      r = { project: p, wouldMerge: 0, mergeConfirmed: 0, mergeFalse: 0, wouldClose: 0, closeConfirmed: 0, closeFalse: 0, hold: 0, decided: 0, mergePrecision: null, closePrecision: null };
      byProject.set(p, r);
    }
    return r;
  };

  for (const c of cells) {
    const r = row(c.project);
    r.decided += c.n;
    if (c.pred === "merge") {
      r.wouldMerge += c.n;
      if (c.truth === "merged") r.mergeConfirmed += c.n;
      else if (c.truth === "closed") r.mergeFalse += c.n;
    } else if (c.pred === "close") {
      r.wouldClose += c.n;
      if (c.truth === "closed") r.closeConfirmed += c.n;
      else if (c.truth === "merged") r.closeFalse += c.n;
    } else if (c.pred === "hold") {
      r.hold += c.n;
    }
  }

  const rows = [...byProject.values()].map((r) => ({
    ...r,
    mergePrecision: r.wouldMerge > 0 ? r.mergeConfirmed / r.wouldMerge : null,
    closePrecision: r.wouldClose > 0 ? r.closeConfirmed / r.wouldClose : null,
  }));
  rows.sort((a, b) => a.project.localeCompare(b.project));
  return { rows, hasSignal: rows.some((r) => r.decided >= MIN_DECIDED_FOR_SIGNAL) };
}

// ── Cross-system gate-decision PARITY (#preconv-parity) ───────────────────────────────────────────────
// Phase-2 of the gittensory convergence proves the gittensory-app's gate decisions MATCH reviewbot's on
// the SAME PR at the SAME COMMIT before a per-repo cutover. computeGateEval scores ONE system vs the
// realized human outcome (accuracy); this compares TWO systems against EACH OTHER. The two never live in
// the same gate_decision row — they're distinct `source` writers in the SAME review_audit store — so we
// join the latest gate_decision per (project, target_id, head_sha) for the authoritative source vs a
// shadow source. The head_sha is in the join key precisely so reviewbot@shaA is never compared to
// gittensory@shaB (a different commit = a different decision; comparing across commits is meaningless).

/** The canonical gate actions a decision can take. Anything else (or a missing head_sha) is excluded from
 *  the parity pairing — only a clean merge/close/hold on a known commit is comparable. */
export type GateAction = "merge" | "close" | "hold";

export interface ParityReasonBreakdown {
  /** The authoritative side's reasonCode for this bucket (from the `summary` column the gate writes). */
  reasonCode: string;
  paired: number;
  agree: number;
  disagree: number;
}

export interface GateParityRow {
  project: string;
  /** Pairs where BOTH systems decided on the SAME (target_id, head_sha) — the only comparable unit. */
  pairedSamples: number;
  /** Agreement matrix: both took the same action. */
  bothMerge: number;
  bothClose: number;
  bothHold: number;
  /** Any pair where the two systems chose different actions. */
  disagree: number;
  /** (bothMerge+bothClose+bothHold) / pairedSamples, or null when nothing paired. */
  agreementRate: number | null;
  /** THE safety metric: pairs where the SHADOW would MERGE while the AUTHORITATIVE would HOLD or CLOSE —
   *  the dangerous direction (the shadow shipping something the authoritative wouldn't). MUST be 0 to cut over. */
  unsafeDisagreements: number;
  /** Per authoritative-reasonCode agree/disagree breakdown, to localize WHERE the systems diverge. */
  byReasonCode: ParityReasonBreakdown[];
}

export interface GateParityReport {
  /** The authoritative writer (default 'reviewbot') and the shadow writer being compared. */
  authoritative: string;
  shadow: string;
  rows: GateParityRow[];
  hasSignal: boolean;
}

/** Minimum paired samples (per project) before a parity read is trustworthy enough to gate a cutover.
 *  Below this the agreement rate is noise. (#preconv-parity) */
export const MIN_PARITY_SAMPLE = 30;

/** Documented agreement-rate floor for cutover: the shadow must match the authoritative on at least this
 *  fraction of paired commits. 0.98 ≈ at most a 2% benign-direction divergence (e.g. hold-vs-close where
 *  neither ships a bad merge); the hard unsafe-direction count must still be exactly 0. (#preconv-parity) */
export const PARITY_AGREEMENT_FLOOR = 0.98;

/** The per-repo cutover gate: enough paired evidence, ZERO unsafe (shadow-merges-where-authoritative-
 *  wouldn't) disagreements, and an agreement rate at/above the documented floor. */
export function isParityCutoverReady(row: GateParityRow): boolean {
  return (
    row.pairedSamples >= MIN_PARITY_SAMPLE &&
    row.unsafeDisagreements === 0 &&
    row.agreementRate != null &&
    row.agreementRate >= PARITY_AGREEMENT_FLOOR
  );
}

const isGateAction = (v: string): v is GateAction => v === "merge" || v === "close" || v === "hold";

/** Join the LATEST gate_decision per (project, target_id, head_sha) for the authoritative source against
 *  the same key for a shadow source, and fold into a per-project agreement matrix + unsafe-direction count
 *  + per-reasonCode breakdown. Pure read; fail-safe → empty report. (#preconv-parity) */
export async function computeGateParity(
  env: Env,
  opts: { days: number; nowMs: number; project?: string; authoritative?: string; shadow?: string },
): Promise<GateParityReport> {
  const authoritative = opts.authoritative ?? "reviewbot";
  const shadow = opts.shadow ?? "gittensory";
  const days = Number.isFinite(opts.days) && opts.days > 0 ? Math.min(opts.days, 730) : 90;
  const fromIso = new Date(opts.nowMs - days * 86_400_000).toISOString().slice(0, 10);

  // Per-source latest decision per (project, target_id, head_sha). head_sha MUST be non-null so the
  // self-join compares the same commit (a NULL head_sha can't anchor a per-commit comparison). The "bare
  // column with MAX(created_at)" trick picks the latest row's decision/summary per group (SQLite/our PG
  // parser both honour this for our single-writer-per-commit data).
  const projectFilter = opts.project ? "AND project = ?" : "";
  const sql = `
    WITH auth AS (
      SELECT project, target_id, head_sha, decision AS act, summary AS reason, MAX(created_at) AS t
      FROM review_audit
      WHERE event_type = 'gate_decision' AND decision IS NOT NULL AND head_sha IS NOT NULL
        AND source = ? AND created_at >= ? ${projectFilter}
      GROUP BY project, target_id, head_sha
    ),
    shad AS (
      SELECT project, target_id, head_sha, decision AS act, MAX(created_at) AS t
      FROM review_audit
      WHERE event_type = 'gate_decision' AND decision IS NOT NULL AND head_sha IS NOT NULL
        AND source = ? AND created_at >= ? ${projectFilter}
      GROUP BY project, target_id, head_sha
    )
    SELECT auth.project AS project, auth.act AS auth_act, shad.act AS shadow_act,
           COALESCE(auth.reason, '') AS reason, COUNT(*) AS n
    FROM auth JOIN shad
      ON auth.project = shad.project AND auth.target_id = shad.target_id AND auth.head_sha = shad.head_sha
    GROUP BY auth.project, auth.act, shad.act, reason`;

  type Cell = { project: string; auth_act: string; shadow_act: string; reason: string; n: number };
  let cells: Cell[] = [];
  try {
    const binds = opts.project
      ? [authoritative, fromIso, opts.project, shadow, fromIso, opts.project]
      : [authoritative, fromIso, shadow, fromIso];
    const res = await storage(env).prepare(sql).bind(...binds).all<Cell>();
    cells = res.results ?? [];
  } catch {
    return { authoritative, shadow, rows: [], hasSignal: false };
  }

  const byProject = new Map<string, GateParityRow>();
  const reasonByProject = new Map<string, Map<string, ParityReasonBreakdown>>();
  const row = (p: string): GateParityRow => {
    let r = byProject.get(p);
    if (!r) {
      r = { project: p, pairedSamples: 0, bothMerge: 0, bothClose: 0, bothHold: 0, disagree: 0, agreementRate: null, unsafeDisagreements: 0, byReasonCode: [] };
      byProject.set(p, r);
      reasonByProject.set(p, new Map());
    }
    return r;
  };

  for (const c of cells) {
    if (!isGateAction(c.auth_act) || !isGateAction(c.shadow_act)) continue; // only comparable actions pair
    const r = row(c.project);
    r.pairedSamples += c.n;
    const agreed = c.auth_act === c.shadow_act;
    if (agreed) {
      if (c.auth_act === "merge") r.bothMerge += c.n;
      else if (c.auth_act === "close") r.bothClose += c.n;
      else r.bothHold += c.n;
    } else {
      r.disagree += c.n;
      // The dangerous direction: the shadow would MERGE where the authoritative would HOLD or CLOSE.
      if (c.shadow_act === "merge" && (c.auth_act === "hold" || c.auth_act === "close")) {
        r.unsafeDisagreements += c.n;
      }
    }
    const reasons = reasonByProject.get(c.project);
    // reasonByProject always has an entry for c.project here (row() seeded it). Guard for strict indexing only.
    if (!reasons) continue;
    let rb = reasons.get(c.reason);
    if (!rb) {
      rb = { reasonCode: c.reason, paired: 0, agree: 0, disagree: 0 };
      reasons.set(c.reason, rb);
    }
    rb.paired += c.n;
    if (agreed) rb.agree += c.n;
    else rb.disagree += c.n;
  }

  const rows = [...byProject.values()].map((r) => {
    const reasons = reasonByProject.get(r.project);
    const agree = r.bothMerge + r.bothClose + r.bothHold;
    return {
      ...r,
      agreementRate: r.pairedSamples > 0 ? agree / r.pairedSamples : null,
      byReasonCode: reasons ? [...reasons.values()].sort((a, b) => b.paired - a.paired) : [],
    };
  });
  rows.sort((a, b) => a.project.localeCompare(b.project));
  return { authoritative, shadow, rows, hasSignal: rows.some((r) => r.pairedSamples >= MIN_PARITY_SAMPLE) };
}
