// Per-rule (not just per-project) gate-decision accuracy (#7984, epic #7980).
//
// computeGateEval (parity.ts) scores prediction-vs-ground-truth AGGREGATED PER PROJECT — one systematically
// wrong deterministic rule (like the 2026-07-21/22 hotkey/coldkey regex bug, #7981) can sit at effectively 0%
// precision while hiding inside an otherwise-healthy project-wide close-precision number, diluted by every
// OTHER correct close reason the SAME project produces. The precision-over-time circuit breaker (auto-tune.ts)
// can never isolate and react to a single broken RULE this way, even in principle. This module adds that
// missing dimension, by RE-AGGREGATING data that's already recorded — review_audit's gate_decision rows
// already carry a reason code (`summary`, the disposition's blockerClass/first blocker code, or the gate's own
// conclusion for a clean merge) — no new collection pipeline, no new table.
//
// Structure mirrors contributor-gate-eval.ts EXACTLY (that file's own header names this same "new dimension on
// the same fold" pattern as the established convention for extending computeGateEval): one function keyed by
// (project, ruleCode) for a "which rule is broken on which repo" view, and a BLENDED counterpart keyed by
// ruleCode ALONE, pooling raw counts across every project — because a rule's trustworthiness is a property of
// the rule itself, not of any one repo it happened to fire in, and that's the exact question #7986 (which
// consumes this module) needs to ask when deciding whether to still exempt a concrete-evidence close from the
// breaker.
//
// READ/REPORTING ONLY (#7984's own stated boundary): nothing here changes any gate/disposition decision.
// #7986 is what actually reads this data to change breaker behavior.

import { AUTOTUNE_CLOSE_PRECISION_FLOOR, AUTOTUNE_MIN_DECIDED } from "./auto-tune";
import { REVERSAL_DISCOUNT_WEIGHT } from "./parity";

export interface RuleGateEvalRow {
  project: string;
  ruleCode: string;
  wouldMerge: number;
  mergeConfirmed: number;
  mergeFalse: number;
  wouldClose: number;
  closeConfirmed: number;
  closeFalse: number;
  decided: number;
  mergePrecision: number | null;
  closePrecision: number | null;
  weightedMergeConfirmed: number;
  weightedCloseConfirmed: number;
  weightedMergePrecision: number | null;
  weightedClosePrecision: number | null;
}

export interface RuleGateEvalReport {
  rows: RuleGateEvalRow[];
  hasSignal: boolean;
}

export interface BlendedRuleGateEvalRow {
  ruleCode: string;
  /** Distinct projects this rule has decided rows on, contributing to the blend. */
  projectCount: number;
  wouldMerge: number;
  mergeConfirmed: number;
  mergeFalse: number;
  wouldClose: number;
  closeConfirmed: number;
  closeFalse: number;
  decided: number;
  mergePrecision: number | null;
  closePrecision: number | null;
  weightedMergeConfirmed: number;
  weightedCloseConfirmed: number;
  weightedMergePrecision: number | null;
  weightedClosePrecision: number | null;
}

export interface BlendedRuleGateEvalReport {
  rows: BlendedRuleGateEvalRow[];
  hasSignal: boolean;
}

const MIN_DECIDED_FOR_SIGNAL = 10;

/** Storage seam matching parity.ts's own `storage(env)`. */
function storage(env: Env): D1Database {
  return env.DB;
}

type RuleGateCell = { project: string; ruleCode: string; pred: string; truth: string; reversed: number; n: number };

/**
 * Shared read: review_audit's latest gate_decision per target joined to the latest pr_outcome (ground truth),
 * grouped down to one row per (project, ruleCode, pred, truth, reversed) cell — the finest grain both
 * computeRuleGateEval (folds by project+ruleCode) and computeBlendedRuleGateEval (folds by ruleCode alone,
 * pooling projects) need. Keeping the SQL in one place guarantees both consumers see the exact same underlying
 * facts; only the in-memory fold differs. Pure read; fail-safe -> [].
 *
 * `ruleCode` is `review_audit.summary` — the SAME single reason-code string computeGateEval's own query reads
 * (via `decision`/`pred`) but does NOT currently select (parity.ts's `gd` CTE only selects `project`/`pred`).
 * For a MERGE decision this is typically the gate's own conclusion (e.g. "success"), not a "rule" in the
 * #7986 sense — those rows are harmless to include (they just aren't interesting) and are included here rather
 * than filtered out, so this stays a faithful, complete re-aggregation of the same underlying data
 * computeGateEval reads, not a second, narrower read with its own selection bias.
 */
async function queryRuleGateCells(env: Env, opts: { days: number; nowMs: number; source?: string; minerOnly?: boolean }): Promise<RuleGateCell[]> {
  const days = Number.isFinite(opts.days) && opts.days > 0 ? Math.min(opts.days, 730) : 90;
  const fromIso = new Date(opts.nowMs - days * 86_400_000).toISOString().slice(0, 10);
  const sourceFilter = opts.source ? "AND source = ?" : "";
  const minerFilter = opts.minerOnly ? "AND miner_authored = 1" : "";
  // Latest row per target_id via ROW_NUMBER()+rn=1 -- NOT SQLite's "bare column with MAX()" trick, which
  // Postgres rejects outright ("column must appear in the GROUP BY clause") -- mirrors computeGateEval's own
  // identical portability note (parity.ts) and contributor-gate-eval.ts's queryContributorGateCells.
  const sql = `
    WITH gd AS (
      SELECT target_id, project, decision AS pred, summary AS rule_code, created_at,
             ROW_NUMBER() OVER (PARTITION BY target_id ORDER BY created_at DESC) AS rn
      FROM review_audit WHERE event_type = 'gate_decision' AND decision IS NOT NULL AND created_at >= ? ${sourceFilter} ${minerFilter}
    ),
    po AS (
      SELECT target_id, decision AS truth, created_at,
             ROW_NUMBER() OVER (PARTITION BY target_id ORDER BY created_at DESC) AS rn
      FROM review_audit WHERE event_type = 'pr_outcome' AND decision IS NOT NULL
    ),
    rev AS (
      SELECT DISTINCT target_id FROM review_audit WHERE event_type IN ('reversal_reverted', 'reversal_reopened')
    )
    SELECT gd.project AS project, COALESCE(gd.rule_code, 'unknown') AS ruleCode, gd.pred AS pred, po.truth AS truth,
           CASE WHEN rev.target_id IS NOT NULL THEN 1 ELSE 0 END AS reversed, COUNT(*) AS n
    FROM gd JOIN po ON gd.target_id = po.target_id
    LEFT JOIN rev ON gd.target_id = rev.target_id
    WHERE gd.rn = 1 AND po.rn = 1
    GROUP BY gd.project, ruleCode, gd.pred, po.truth, reversed`;

  try {
    const stmt = storage(env).prepare(sql);
    const bound = opts.source ? stmt.bind(fromIso, opts.source) : stmt.bind(fromIso);
    const res = await bound.all<RuleGateCell>();
    return res.results ?? [];
  } catch {
    return [];
  }
}

function foldCell(
  target: { wouldMerge: number; mergeConfirmed: number; mergeFalse: number; wouldClose: number; closeConfirmed: number; closeFalse: number; decided: number; weightedMergeConfirmed: number; weightedCloseConfirmed: number },
  c: RuleGateCell,
): void {
  target.decided += c.n;
  const weightedN = c.reversed ? c.n * REVERSAL_DISCOUNT_WEIGHT : c.n;
  if (c.pred === "merge") {
    target.wouldMerge += c.n;
    if (c.truth === "merged") {
      target.mergeConfirmed += c.n;
      target.weightedMergeConfirmed += weightedN;
    } else if (c.truth === "closed") target.mergeFalse += c.n;
  } else if (c.pred === "close") {
    target.wouldClose += c.n;
    if (c.truth === "closed") {
      target.closeConfirmed += c.n;
      target.weightedCloseConfirmed += weightedN;
    } else if (c.truth === "merged") target.closeFalse += c.n;
  }
}

/**
 * Per-(project, ruleCode) gate accuracy over review_audit's existing gate_decision predictions vs the realized
 * pr_outcome. Pure read; fail-safe -> empty report. Mirrors computeGateEval (parity.ts) exactly, with
 * `ruleCode` (review_audit.summary) added to both the GROUP BY and the fold key — so a maintainer can see
 * "rule X: 0/4 correct" on a repo even while that repo's OWN project-wide aggregate still looks healthy.
 */
export async function computeRuleGateEval(env: Env, opts: { days: number; nowMs: number; source?: string; minerOnly?: boolean }): Promise<RuleGateEvalReport> {
  const cells = await queryRuleGateCells(env, opts);
  if (cells.length === 0) return { rows: [], hasSignal: false };

  const byKey = new Map<string, RuleGateEvalRow>();
  const row = (project: string, ruleCode: string): RuleGateEvalRow => {
    const key = `${project}:${ruleCode}`;
    let r = byKey.get(key);
    if (!r) {
      r = {
        project, ruleCode, wouldMerge: 0, mergeConfirmed: 0, mergeFalse: 0, wouldClose: 0, closeConfirmed: 0, closeFalse: 0, decided: 0,
        mergePrecision: null, closePrecision: null, weightedMergeConfirmed: 0, weightedCloseConfirmed: 0, weightedMergePrecision: null, weightedClosePrecision: null,
      };
      byKey.set(key, r);
    }
    return r;
  };

  for (const c of cells) foldCell(row(c.project, c.ruleCode), c);

  const rows = [...byKey.values()]
    .map((r) => ({
      ...r,
      mergePrecision: r.wouldMerge > 0 ? r.mergeConfirmed / r.wouldMerge : null,
      closePrecision: r.wouldClose > 0 ? r.closeConfirmed / r.wouldClose : null,
      weightedMergePrecision: r.wouldMerge > 0 ? r.weightedMergeConfirmed / r.wouldMerge : null,
      weightedClosePrecision: r.wouldClose > 0 ? r.weightedCloseConfirmed / r.wouldClose : null,
    }))
    .sort((a, b) => a.project.localeCompare(b.project) || a.ruleCode.localeCompare(b.ruleCode));
  return { rows, hasSignal: rows.some((r) => r.decided >= MIN_DECIDED_FOR_SIGNAL) };
}

/**
 * The global, cross-repo blended counterpart to computeRuleGateEval: one row per ruleCode, POOLING raw
 * prediction/outcome counts across every project that code has fired on before computing a single precision
 * ratio -- volume-weighted, not an average of each project's own precision, so a code with 40 decided
 * instances on one repo and 2 on another isn't distorted toward a 50/50 blend. This is the report #7986
 * actually consumes: a rule's own track record, independent of which repo happened to trip it.
 */
export async function computeBlendedRuleGateEval(env: Env, opts: { days: number; nowMs: number; source?: string; minerOnly?: boolean }): Promise<BlendedRuleGateEvalReport> {
  const cells = await queryRuleGateCells(env, opts);
  if (cells.length === 0) return { rows: [], hasSignal: false };

  const byRuleCode = new Map<string, BlendedRuleGateEvalRow>();
  const projectsByRuleCode = new Map<string, Set<string>>();
  const row = (ruleCode: string): BlendedRuleGateEvalRow => {
    let r = byRuleCode.get(ruleCode);
    if (!r) {
      r = {
        ruleCode, projectCount: 0, wouldMerge: 0, mergeConfirmed: 0, mergeFalse: 0, wouldClose: 0, closeConfirmed: 0, closeFalse: 0, decided: 0,
        mergePrecision: null, closePrecision: null, weightedMergeConfirmed: 0, weightedCloseConfirmed: 0, weightedMergePrecision: null, weightedClosePrecision: null,
      };
      byRuleCode.set(ruleCode, r);
    }
    return r;
  };

  for (const c of cells) {
    let projects = projectsByRuleCode.get(c.ruleCode);
    if (!projects) {
      projects = new Set<string>();
      projectsByRuleCode.set(c.ruleCode, projects);
    }
    projects.add(c.project);
    foldCell(row(c.ruleCode), c);
  }

  const rows = [...byRuleCode.values()]
    .map((r) => ({
      ...r,
      // Every ruleCode in byRuleCode was inserted into projectsByRuleCode in the SAME loop iteration above --
      // the two maps always have identical keysets, so this lookup can never miss.
      projectCount: projectsByRuleCode.get(r.ruleCode)!.size,
      mergePrecision: r.wouldMerge > 0 ? r.mergeConfirmed / r.wouldMerge : null,
      closePrecision: r.wouldClose > 0 ? r.closeConfirmed / r.wouldClose : null,
      weightedMergePrecision: r.wouldMerge > 0 ? r.weightedMergeConfirmed / r.wouldMerge : null,
      weightedClosePrecision: r.wouldClose > 0 ? r.weightedCloseConfirmed / r.wouldClose : null,
    }))
    .sort((a, b) => a.ruleCode.localeCompare(b.ruleCode));
  return { rows, hasSignal: rows.some((r) => r.decided >= MIN_DECIDED_FOR_SIGNAL) };
}

/**
 * Blended rows whose close-side sample has cleared enough volume to trust (`wouldClose >= minDecided`, default
 * {@link AUTOTUNE_MIN_DECIDED} — the SAME floor the project-level close-precision breaker in auto-tune.ts
 * uses) but whose weighted close precision sits below `floor` (default {@link AUTOTUNE_CLOSE_PRECISION_FLOOR})
 * — exactly the "rule X: 0/4 correct" signal #7984 exists to surface, pure fold over an already-fetched
 * {@link BlendedRuleGateEvalReport}'s rows (no I/O). This is also the exact lookup #7986 reads to decide
 * whether a rule's concrete-evidence breaker exemption should still hold: a rule NOT in this list either has
 * an insufficient sample (stays exempt, per #7986's own "insufficient sample defaults to keeping the
 * exemption" rule) or a healthy track record (stays exempt, correctly).
 */
export function rulesBelowClosePrecisionFloor(
  rows: readonly BlendedRuleGateEvalRow[],
  floor: number = AUTOTUNE_CLOSE_PRECISION_FLOOR,
  minDecided: number = AUTOTUNE_MIN_DECIDED,
): BlendedRuleGateEvalRow[] {
  return rows.filter((r) => r.wouldClose >= minDecided && r.weightedClosePrecision != null && r.weightedClosePrecision < floor);
}
