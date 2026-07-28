// Operational endpoints (the ops capability — reviewbot→loopover convergence, ADDITIVE, NATIVE port of
// reviewbot src/core/ops.ts). Bearer-protected per agent. Surfaces enough to answer "is this agent
// behaving?": health snapshot (status/verdict breakdown, manual-rate, stuck/failed/DLQ targets, reversals),
// confidence-vs-outcome calibration + a recommended floor, and the decision trail for one target.
//
// SELF-CONTAINED: every type + helper this module needs is defined HERE. No imports from reviewbot. The
// logic is byte-faithful to the reviewbot source; the only deltas are mechanical guards for loopover's
// stricter tsconfig + an INJECTED-DEPS seam for the runtime-gate-specific pieces.
//
// STORAGE: loopover has no platform/access adapter — `Env` is a global ambient interface with `DB`.
//
// SCOPE (deferred): reviewbot's ops.ts ALSO exposes the auto-tune override handlers
// (handleApplyRecommendation / handleClearOverride / handleOverrideAudit). Those are HEAVILY entangled with
// reviewbot's runtime override store (src/core/tunables.ts — a 257-line shadow-soak/sanitize/tighten-only
// engine) and are intentionally NOT ported here — porting them would drag the auto-tune engine into the
// loopover tree. Likewise handleInternalStatus's account-wide AI-error count is the runtime AI-health
// pacer (src/core/ai-health.ts) and is taken as an INJECTED dep (default 0). What IS ported is the clean,
// D1-only / pure surface: computeAgentHealth, computeCalibration, the bearer gate, and the status / decision
// / calibration read endpoints.

// ── Inlined minimal types (ported from reviewbot src/core/{ops,types}.ts) ────────────────────────

export type TargetKind = "pull_request" | "issue";

/** A permanently-failed review, with the PR + reason so the alert is actionable (not just a count). */
export interface FailedTarget {
  number: number;
  repo: string;
  verdict: string | null;
  lastError: string | null;
}

/** A bot auto-action a human overrode (revert of a bot-merge / reopen of a bot-close), with the PR. */
export interface ReversedTarget {
  number: number;
  repo: string;
  status: string;
  eventType: string;
}

/** Per-agent health snapshot from review_targets + config invariants. Shared by /status and alerting. */
export interface AgentHealth {
  /** #9136: the gate's own decision breakdown (merge / close / hold) from review_audit's gate_decision rows.
   *  Replaces the former `byStatus` + `byVerdict` pair, which were near-duplicates of each other sourced from
   *  the orphaned review_targets and had been frozen since the 2026-06-22 cutover. */
  byDecision: Record<string, number>;
  terminalCount: number;
  nonTerminal: number;
  manualRate: number;
  dlqCount: number;
  dlqTargets?: FailedTarget[];
  reversals: number;
  reversalRate: number;
  /** Merged + closed auto-actions in the 7d anomaly window — the reversalRate denominator. */
  recentAutoActions: number;
  reversedTargets?: ReversedTarget[];
  configIssues: string[];
  frozen?: boolean;
  holdOnly?: boolean;
}

export interface Calibration {
  currentFloor: number;
  mergedCount: number;
  revertedCount: number;
  keptAvgConfidence: number | null;
  revertedMaxConfidence: number | null;
  /** A suggested confidenceFloor (only when it would be HIGHER than current); null = no change needed. */
  recommendedFloor: number | null;
  note: string;
  /** Per-reasonCode close distribution + how many of each a human REOPENED and the gate did NOT re-merge. */
  closesByReason: Array<{ reasonCode: string; closes: number; disputed: number }>;
  disputedCloseCount: number;
  /** Predicted merge-confidence band vs realized kept-rate (not reverted) per bucket. */
  bins: CalibrationBin[];
}

/** One confidence band in the calibration curve (#2192). */
export type CalibrationBin = {
  label: string;
  minConfidence: number;
  maxConfidence: number;
  sampleSize: number;
  keptCount: number;
  revertedCount: number;
  /** keptCount / sampleSize; null when sampleSize === 0. */
  keptRate: number | null;
};

const CALIBRATION_BIN_EDGES = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0] as const;

/** Fold merge-confidence samples into fixed calibration bins for the analytics curve card. */
export function buildCalibrationBins(
  samples: ReadonlyArray<{ confidence: number; kept: boolean }>,
): CalibrationBin[] {
  const bins: CalibrationBin[] = [];
  for (let i = 0; i < CALIBRATION_BIN_EDGES.length - 1; i += 1) {
    const min = CALIBRATION_BIN_EDGES[i]!;
    const max = CALIBRATION_BIN_EDGES[i + 1]!;
    const isLast = i === CALIBRATION_BIN_EDGES.length - 2;
    const inBin = samples.filter(
      (sample) => sample.confidence >= min && (isLast ? sample.confidence <= max : sample.confidence < max),
    );
    const keptCount = inBin.filter((sample) => sample.kept).length;
    const sampleSize = inBin.length;
    bins.push({
      label: `${Math.round(min * 100)}–${Math.round(max * 100)}%`,
      minConfidence: min,
      maxConfidence: max,
      sampleSize,
      keptCount,
      revertedCount: sampleSize - keptCount,
      keptRate: sampleSize > 0 ? Number((keptCount / sampleSize).toFixed(3)) : null,
    });
  }
  return bins;
}

/** The minimal agent-config shape the ops endpoints read. (Subset of reviewbot's AgentConfig.) */
export interface OpsAgentConfig {
  slug: string;
  confidenceFloor?: number;
  secrets: { internalSecret?: string };
}

// ── Inlined helpers (byte-faithful from reviewbot src/core/{crypto,util,db}.ts) ──────────────────

/** Storage seam: loopover's `Env` is a global ambient interface with `DB`. */
function storage(env: Env): D1Database {
  return env.DB;
}

const timingSafeEncoder = new TextEncoder();

/** Constant-time string compare (reviewbot src/core/crypto.ts). */
function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = timingSafeEncoder.encode(left);
  const rightBytes = timingSafeEncoder.encode(right);
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (left: Uint8Array, right: Uint8Array) => boolean;
  };
  if (leftBytes.length === rightBytes.length && typeof subtle.timingSafeEqual === "function") {
    return subtle.timingSafeEqual(leftBytes, rightBytes);
  }
  const maxLength = Math.max(leftBytes.length, rightBytes.length);
  let diff = leftBytes.length === rightBytes.length ? 0 : 1;
  for (let index = 0; index < maxLength; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return diff === 0;
}

/** Read a per-agent secret/var from the worker env by name (reviewbot src/core/util.ts). */
function readSecret(env: Env, name: string): string {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" ? value : "";
}

/** Project-namespaced row id (reviewbot src/core/db.ts rowId). */
function rowId(project: string, kind: TargetKind, repo: string, number: number): string {
  return `${project}:${kind}:${repo}#${number}`;
}

// #9136: DecisionTargetRow and NON_TERMINAL are gone with the last review_targets reads. NON_TERMINAL listed
// the processing states (queued / reviewing / error_retryable) the convergence cutover removed as a concept;
// non-terminal is now simply the gate's `hold` count.

// ── Thresholds (byte-faithful from reviewbot src/core/ops.ts) ────────────────────────────────────

/** How far back the anomaly signals (failed / reversals) look. */
const ANOMALY_WINDOW = "-7 days";
// DLQ spike = a RECENT burst of dead-letters whose targets HAVEN'T recovered.
const DLQ_WINDOW = "-6 hours";

// #9136: `review_targets` has NO live writer anywhere in this codebase (the 2026-06-22 convergence cutover
// orphaned it -- see src/db/repo-identity-rename.ts / src/review/public-stats.ts's own comments) — every
// query below that used to join or read it saw a permanently-empty table, silently zeroing the reversals
// and DLQ anomaly signals. `review_audit` (migration 0049) IS live: parity-wire.ts writes 'gate_decision'
// rows on every finalized verdict, and outcomes-wire.ts writes 'pr_outcome'/'reversal_reverted'/
// 'reversal_reopened' rows on the realized outcome. Repointing reversals + DLQ (the two signals detectAnomalies
// can ACT on directly) onto review_audit alone -- parsing repo/number out of its own target_id instead of
// joining review_targets for them -- also fixes a SEPARATE bug the join had: review_audit.target_id is
// `owner/repo#123` (reviewAuditTargetId, outcomes-wire.ts) while review_targets.id is `project:kind:owner/repo#123`
// (rowId, above) -- a different namespace the join could never actually match, even while review_targets was
// still live. byStatus/verdictRows/failedRows below are UNCHANGED (still review_targets-sourced, and so still
// silently zero) -- deferred; see the PR description for the full scope decision and #9136 for the tracked
// remainder (manualRate/stuckRetryable/failed/calibration bins, submitter-reputation.ts, ams-miner-cohort.ts).
/**
 * #9136: a PR accumulates one decision_records row per head sha, and its own header states
 * "latest-finalize-wins per id". Every calibration read wants the decision that actually stands, so this
 * restricts to the newest record for each (repo, pull) — the direct analogue of review_targets' single
 * terminal row per target, and the same shape as submitter-reputation.ts's LATEST_PR_OUTCOME_FILTER.
 *
 * Correlated on the alias `dr`, so every query using it must name its decision_records table `dr`.
 */
export const LATEST_DECISION_RECORD_FILTER = `dr.created_at = (
       SELECT MAX(newer.created_at) FROM decision_records newer
       WHERE newer.repo_full_name = dr.repo_full_name AND newer.pull_number = dr.pull_number
     )`;

function parseReviewAuditTargetId(targetId: string): { repo: string; number: number } | null {
  const hashIndex = targetId.lastIndexOf("#");
  if (hashIndex <= 0) return null;
  const repo = targetId.slice(0, hashIndex);
  const number = Number(targetId.slice(hashIndex + 1));
  return Number.isInteger(number) && number > 0 ? { repo, number } : null;
}

// ── Injected runtime-gate deps (config invariants + kill-switch/circuit-breaker flags + AI errors) ───

/** The runtime-gate-specific pieces computeAgentHealth/handleInternalStatus fold in. The host supplies
 *  its own; the defaults below treat the agent as having no config issues, unfrozen, not hold-only, no
 *  recent AI errors — so the health snapshot stays computable without the gate runtime. */
export interface OpsHealthDeps {
  validateAgentConfig: (config: OpsAgentConfig) => string[];
  isFrozen: (env: Env, project: string) => Promise<boolean>;
  isHoldOnly: (env: Env, project: string) => Promise<boolean>;
}

export const defaultOpsHealthDeps: OpsHealthDeps = {
  validateAgentConfig: () => [],
  // The DB-backed global kill-switch (#audit-§5.2): /status now reports the REAL freeze state instead of a
  // hardcoded false. Raw SQL keeps this module self-contained; fail-open on a read error — but this is the
  // operator-facing health surface used to CONFIRM a freeze took effect, so a swallowed read failure must be
  // visible, not silently reported as an ordinary "unfrozen" (#2125).
  isFrozen: async (env, _project) => (await import("../db/repositories")).isGlobalAgentFrozen(env),
  isHoldOnly: async () => false,
};

/** Per-agent health snapshot from review_targets + config invariants. Shared by /status and alerting. */
export async function computeAgentHealth(env: Env, config: OpsAgentConfig, deps: OpsHealthDeps = defaultOpsHealthDeps): Promise<AgentHealth> {
  const slug = config.slug;
  // LIMIT high enough that `.length` is an accurate count for the anomaly signal (the alert only DISPLAYS
  // a few); recent failed/reversal counts + the rate denominator are all 7-day-windowed. `manualRate` is
  // all-time on purpose (a different, lifetime signal).
  const LIST_CAP = 100;
  const [decisionRows, reversedRows, recentActionsRow, dlqRows, dlqCountRow] = await Promise.all([
    // #9136, the last three review_targets reads in this file. byStatus/byVerdict/failedRows were the only
    // survivors of the convergence cutover's orphaning, and so returned a frozen set that has been silently
    // shrinking since 2026-06-22 -- taking manualRate, terminalCount and two Discord alerts down with them.
    //
    // Resolved by splitting them on whether a live analogue EXISTS, rather than repointing all three at
    // something approximate:
    //
    //   byStatus/byVerdict -> byDecision, sourced from review_audit's own gate_decision rows. The disposition
    //     half of the old status vocabulary (merged/closed/manual) maps exactly onto merge/close/hold, and it
    //     is what terminalCount/nonTerminal/manualRate were really measuring. The two fields also collapse
    //     into one: separate status and verdict breakdowns were near-duplicates of each other.
    //
    //   stuckRetryable / failed / failedTargets -> DELETED, not repointed. `queued/reviewing/error/
    //     error_retryable` were PROCESSING states, and the cutover removed the concept, not just the table --
    //     nothing live records them (this file's own comment below the fold said as much). `failed` was
    //     additionally redundant: dlqCount/dlqTargets already cover "permanently failed", are live, and have
    //     their own alert. An alert that cannot fire is worse than no alert, because it reads as coverage.
    storage(env).prepare(
      `SELECT decision, COUNT(*) AS n FROM review_audit
       WHERE project = ? AND event_type = 'gate_decision' AND decision IS NOT NULL GROUP BY decision`,
    ).bind(slug).all<{ decision: string; n: number }>(),
    // #9136: repointed off review_targets (see this file's own header comment above). Recent human reversals
    // of a bot auto-action, read directly from review_audit's own reversal_* rows -- repo/number parsed from
    // target_id, no join. A reopened bot-close the gate SUBSEQUENTLY re-acted on (a LATER gate_decision row
    // for the same target_id) is excluded, mirroring the review_targets.terminal_at check this replaces.
    storage(env).prepare(
      `SELECT a.target_id AS target_id, a.event_type AS event_type
       FROM review_audit a
       WHERE a.project = ? AND a.event_type IN ('reversal_reverted', 'reversal_reopened')
         AND a.created_at > datetime('now', ?)
         AND NOT (
           a.event_type = 'reversal_reopened' AND EXISTS (
             SELECT 1 FROM review_audit g
             WHERE g.project = a.project AND g.target_id = a.target_id
               AND g.event_type = 'gate_decision' AND g.created_at > a.created_at
           )
         )
       ORDER BY a.created_at DESC LIMIT ?`,
    ).bind(slug, ANOMALY_WINDOW, LIST_CAP).all<{ target_id: string; event_type: string }>(),
    // #9136: auto-actions in the SAME 7d window — the reversalRate denominator. Repointed onto review_audit's
    // own gate_decision rows (decision IN merge/close) instead of review_targets' terminal-status count.
    storage(env).prepare(
      `SELECT COUNT(*) AS n FROM review_audit WHERE project = ? AND event_type = 'gate_decision' AND decision IN ('merge', 'close') AND created_at > datetime('now', ?)`,
    ).bind(slug, ANOMALY_WINDOW).first<{ n: number }>(),
    // #9136: repointed off review_targets. RECENT dead-letter events, read directly from review_audit (the
    // event type pg-queue.ts's self-host dead-letter path now writes, #9139) -- repo/number/lastError parsed
    // from target_id + summary, no join. Unlike the review_targets-joined query this replaces, this does NOT
    // exclude a target that later recovered (review_targets' terminal-status recheck has no live equivalent
    // here) -- a conservative direction change: it can only make the alert fire on a real dead-letter more
    // readily, never mask one.
    storage(env).prepare(
      `SELECT target_id, summary FROM review_audit
       WHERE project = ? AND event_type = 'dead_lettered' AND created_at > datetime('now', ?)
       ORDER BY created_at DESC LIMIT ?`,
    ).bind(slug, DLQ_WINDOW, LIST_CAP).all<{ target_id: string; summary: string | null }>(),
    // TRUE count of recent dead-letters — a separate COUNT(*) so a storm of >LIST_CAP isn't undercounted.
    storage(env).prepare(
      `SELECT COUNT(*) AS n FROM review_audit WHERE project = ? AND event_type = 'dead_lettered' AND created_at > datetime('now', ?)`,
    ).bind(slug, DLQ_WINDOW).first<{ n: number }>(),
  ]);
  const byDecision: Record<string, number> = {};
  for (const r of decisionRows.results ?? []) byDecision[r.decision] = r.n;
  // merge/close are the gate acting; hold is it deferring to a human. That is exactly the terminal /
  // non-terminal split the old status vocabulary encoded, minus the processing states that no longer exist.
  const terminalCount = (byDecision.merge ?? 0) + (byDecision.close ?? 0);
  const nonTerminal = byDecision.hold ?? 0;
  const recentAutoActions = recentActionsRow?.n ?? 0;
  // #9136: repo/number parsed from review_audit's own target_id (no review_targets join -- see this file's
  // header comment). A target_id this malformed to parse is skipped (filtered out) rather than crashing the
  // whole snapshot over one bad row -- defensive only; every writer of this column (outcomes-wire.ts,
  // pg-queue.ts/sqlite-queue.ts's dead-letter path) always stamps the well-formed `owner/repo#n` shape.
  const reversedTargets: ReversedTarget[] = (reversedRows.results ?? [])
    .map((r) => {
      const parsed = parseReviewAuditTargetId(r.target_id);
      if (!parsed) return null;
      // No live review_targets status to read anymore -- derived purely from the reversal's OWN event_type,
      // which already tells us what the PR's terminal status must have been: a reverted action was a MERGE
      // (only a merge can be "reverted" by a separate revert PR); a reopened action was a CLOSE.
      const status = r.event_type === "reversal_reverted" ? "merged" : "closed";
      return { number: parsed.number, repo: parsed.repo, status, eventType: r.event_type };
    })
    .filter((t): t is ReversedTarget => t !== null);
  const dlqTargets: FailedTarget[] = (dlqRows.results ?? [])
    .map((r): FailedTarget | null => {
      const parsed = parseReviewAuditTargetId(r.target_id);
      return parsed ? { number: parsed.number, repo: parsed.repo, verdict: null, lastError: r.summary } : null;
    })
    .filter((t): t is FailedTarget => t !== null);
  const reversals = reversedTargets.length;
  // The share of decisions the gate handed to a human instead of acting on. Denominator is ALL decisions
  // (including holds), not just the terminal ones -- the old `manual / terminalCount` divided by a
  // denominator that excluded the very rows it was counting.
  const allDecisions = terminalCount + nonTerminal;
  return {
    byDecision,
    terminalCount,
    nonTerminal,
    manualRate: allDecisions ? Number((nonTerminal / allDecisions).toFixed(3)) : 0,
    dlqCount: dlqCountRow?.n ?? dlqTargets.length, // true window count (uncapped); dlqTargets is the display sample
    dlqTargets,
    reversals,
    reversalRate: recentAutoActions ? Number((reversals / recentAutoActions).toFixed(3)) : 0,
    recentAutoActions,
    reversedTargets,
    configIssues: deps.validateAgentConfig(config),
    frozen: await deps.isFrozen(env, slug),
    holdOnly: await deps.isHoldOnly(env, slug),
  };
}

/**
 * Confidence calibration: compare predicted merge confidence against the realized outcome (kept vs
 * reverted) and recommend a confidenceFloor that would have kept the bot above the highest-confidence
 * merge that was later reverted. Pure read (D1 only).
 */
export async function computeCalibration(env: Env, config: OpsAgentConfig): Promise<Calibration> {
  const slug = config.slug;
  // #9136: all four reads were sourced from review_targets, which the 2026-06-22 convergence cutover orphaned
  // (no writer exists anywhere), so every one of them returned a frozen and shrinking set. Repointed onto the
  // live ledgers: decision_records (#8836, the acted disposition + its reasonCode + the record JSON carrying
  // aiConfidence) and review_audit (the realized reversal signal).
  //
  // This also retires the target_id NAMESPACE MISMATCH that made two of them unfixable even in principle.
  // review_audit.target_id is `owner/repo#123`; review_targets.id was `project:kind:owner/repo#123`. The
  // disputed-closes JOIN below could therefore never match a row, and — less visibly — the `reverted` Set a
  // few lines down was built from review_audit target_ids and tested against review_targets ids, so
  // `!reverted.has(...)` was ALWAYS true: every merge read as kept, `rev` was always empty, and
  // recommendedFloor was structurally always null. decision_records keys on
  // `repo_full_name || '#' || pull_number`, the SAME namespace as review_audit, so both now genuinely match.
  //
  // No `project` filter on decision_records: it has no such column because it is written only by this
  // deployment (one instance, one project), unlike review_audit which carries the slug for historical export.
  const [mergedRows, revRows, closesByReasonRows, disputedRows] = await Promise.all([
    // Every acted MERGE and the confidence that justified it. Latest record per PR wins, mirroring
    // decision_records' own "latest-finalize-wins per id" semantics across a PR's successive head shas.
    storage(env).prepare(
      `SELECT dr.repo_full_name || '#' || dr.pull_number AS target_id, dr.record_json AS decision_json
       FROM decision_records dr
       WHERE dr.action = 'merge' AND ${LATEST_DECISION_RECORD_FILTER}`,
    ).all<{ target_id: string; decision_json: string | null }>(),
    storage(env).prepare(`SELECT DISTINCT target_id FROM review_audit WHERE project = ? AND event_type = 'reversal_reverted'`).bind(slug).all<{ target_id: string }>(),
    // Close distribution by reasonCode — the denominator for spotting an over-closing gate.
    storage(env).prepare(
      `SELECT dr.reason_code AS rc, COUNT(*) AS n
       FROM decision_records dr
       WHERE dr.action = 'close' AND ${LATEST_DECISION_RECORD_FILTER}
       GROUP BY rc`,
    ).all<{ rc: string; n: number }>(),
    // Disputed closes: a bot-close a human REOPENED that the gate did NOT subsequently re-terminalize.
    // "Re-terminalized" is now expressed against the live ledger as "a later decision record exists for the
    // same target", which is what review_targets.terminal_at > a.created_at meant.
    storage(env).prepare(
      `SELECT dr.reason_code AS rc, COUNT(DISTINCT dr.repo_full_name || '#' || dr.pull_number) AS n
       FROM review_audit a
       JOIN decision_records dr ON dr.repo_full_name || '#' || dr.pull_number = a.target_id
       WHERE a.project = ? AND a.event_type = 'reversal_reopened' AND dr.action = 'close'
         AND ${LATEST_DECISION_RECORD_FILTER}
         AND NOT EXISTS (
           SELECT 1 FROM decision_records later
           WHERE later.repo_full_name = dr.repo_full_name AND later.pull_number = dr.pull_number
             AND later.created_at > a.created_at
         )
       GROUP BY rc`,
    ).bind(slug).all<{ rc: string; n: number }>(),
  ]);
  const disputedByReason = new Map((disputedRows.results ?? []).map((r) => [r.rc, r.n]));
  const closesByReason = (closesByReasonRows.results ?? [])
    .map((r) => ({ reasonCode: r.rc, closes: r.n, disputed: disputedByReason.get(r.rc) ?? 0 }))
    .sort((a, b) => b.closes - a.closes);
  const disputedCloseCount = [...disputedByReason.values()].reduce((a, b) => a + b, 0);
  // Both sides are `owner/repo#123` now — see the namespace note on the queries above for why this
  // membership test silently answered "kept" for every single merge before.
  const reverted = new Set((revRows.results ?? []).map((r) => r.target_id));
  // #9136: review_targets.decision_json spelled this `confidence`; decision_records' canonical record spells
  // it `aiConfidence` (see risk-control-wire.ts, which reads the same field off the same JSON). Both are
  // accepted — reading only the new name would silently yield null for every row and leave the calibration
  // exactly as dead as the orphaned table left it, which is the failure mode this repoint exists to end.
  const confidenceOf = (j: string | null): number | null => {
    if (!j) return null;
    try {
      const record = JSON.parse(j) as { aiConfidence?: unknown; confidence?: unknown };
      const c = typeof record.aiConfidence === "number" ? record.aiConfidence : record.confidence;
      return typeof c === "number" ? c : null;
    } catch {
      return null;
    }
  };
  const kept: number[] = [];
  const rev: number[] = [];
  const binSamples: Array<{ confidence: number; kept: boolean }> = [];
  for (const r of mergedRows.results ?? []) {
    const c = confidenceOf(r.decision_json);
    if (c == null) continue;
    const isKept = !reverted.has(r.target_id);
    binSamples.push({ confidence: c, kept: isKept });
    (isKept ? kept : rev).push(c);
  }
  const avg = (xs: number[]): number | null => (xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3)) : null);
  const currentFloor = config.confidenceFloor ?? 0;
  const revertedMax = rev.length ? Math.max(...rev) : null;
  const suggested = revertedMax != null ? Math.min(0.99, Number((revertedMax + 0.02).toFixed(3))) : null;
  const recommendedFloor = suggested != null && suggested > currentFloor ? suggested : null;
  const note = recommendedFloor
    ? `Raise confidenceFloor ${currentFloor} → ${recommendedFloor}: a merge at ${revertedMax} confidence was reverted.`
    : rev.length === 0
      ? "No reverted auto-merges — the current floor looks adequate."
      : "Current floor already sits above the reverted merges.";
  return {
    currentFloor,
    mergedCount: (mergedRows.results ?? []).length,
    revertedCount: reverted.size,
    keptAvgConfidence: avg(kept),
    revertedMaxConfidence: revertedMax,
    recommendedFloor,
    note,
    closesByReason,
    disputedCloseCount,
    bins: buildCalibrationBins(binSamples),
  };
}

/** Bearer-gate an internal endpoint. Returns an error Response when not authorized, else null. */
function requireInternalAuth(request: Request, env: Env, config: OpsAgentConfig): Response | null {
  const secretName = config.secrets.internalSecret;
  if (!secretName) return new Response("not found", { status: 404 });
  const expected = readSecret(env, secretName);
  const provided = request.headers.get("authorization") ?? "";
  if (!expected || !timingSafeEqual(provided, `Bearer ${expected}`)) {
    return new Response("unauthorized", { status: 401 });
  }
  return null;
}

/** Injected account-wide AI-error count (reviewbot's runtime AI-health pacer; default 0). */
export type RecentAiErrorCount = (env: Env) => Promise<number>;
const defaultRecentAiErrorCount: RecentAiErrorCount = async () => 0;

/**
 * GET /<slug>/internal/status — per-agent health + trust metrics. Disabled unless
 * secrets.internalSecret is set. Surfaces status/verdict breakdown, manual-rate, stuck targets, config
 * invariant violations, and the most recent decisions with their reasons.
 */
export async function handleInternalStatus(
  request: Request,
  env: Env,
  config: OpsAgentConfig,
  deps: OpsHealthDeps & { recentAiErrorCount?: RecentAiErrorCount } = defaultOpsHealthDeps,
): Promise<Response> {
  const denied = requireInternalAuth(request, env, config);
  if (denied) return denied;

  const slug = config.slug;
  const recentAiErrorCount = deps.recentAiErrorCount ?? defaultRecentAiErrorCount;
  const [health, recentRows, aiErrors] = await Promise.all([
    computeAgentHealth(env, config, deps),
    storage(env).prepare(
      `SELECT target_id, decision, substr(summary, 1, 160) AS summary, created_at
       FROM review_audit WHERE project = ? AND event_type IN ('reviewed', 'shadow_reviewed')
       ORDER BY created_at DESC LIMIT 10`,
    ).bind(slug).all<{ target_id: string; decision: string | null; summary: string | null; created_at: string }>(),
    recentAiErrorCount(env),
  ]);

  return Response.json({
    project: slug,
    counts: { byDecision: health.byDecision },
    health: {
      frozen: health.frozen ?? false,
      holdOnly: health.holdOnly ?? false,
      nonTerminal: health.nonTerminal,
      dlqCount: health.dlqCount,
      aiErrors,
      manualRate: health.manualRate,
      reversals: health.reversals,
      reversalRate: health.reversalRate,
      configIssues: health.configIssues,
    },
    recent: (recentRows.results ?? []).map((r) => ({ target: r.target_id, verdict: r.decision, summary: r.summary, at: r.created_at })),
  });
}

/**
 * GET /<slug>/internal/decision?repo=<owner/repo>&number=<n>[&kind=pull_request|issue]
 * The decision trail for one target: its row state + the cached terminal decision + the audit event log —
 * so any verdict is explainable on demand. Bearer-protected like /status.
 */
export async function handleInternalDecision(request: Request, env: Env, config: OpsAgentConfig): Promise<Response> {
  const denied = requireInternalAuth(request, env, config);
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  const repo = params.get("repo") ?? "";
  const number = Number(params.get("number"));
  const kind = (params.get("kind") === "issue" ? "issue" : "pull_request") as TargetKind;
  if (!repo.includes("/") || !Number.isInteger(number) || number <= 0) {
    return Response.json({ error: "provide ?repo=<owner/repo>&number=<n>" }, { status: 400 });
  }

  // #9136: this endpoint read review_targets, which the convergence cutover orphaned — so it returned 404 for
  // EVERY pull request opened since 2026-06-22, silently, while still being routed and authenticated. Rebuilt
  // on the live ledgers: pull_requests for the target's realized state, decision_records for the decision that
  // explains it, review_audit for the trail.
  //
  // The audit lookup is also a namespace fix: it bound `rowId(...)` (`project:kind:owner/repo#n`) against
  // review_audit.target_id (`owner/repo#n`), so the trail came back empty even when rows existed.
  const id = rowId(config.slug, kind, repo, number);
  const targetKey = `${repo}#${number}`;
  const [target, record, audit] = await Promise.all([
    storage(env).prepare(
      `SELECT repo_full_name, number, state, head_sha, merged_at, merge_attempt_count
       FROM pull_requests WHERE repo_full_name = ? AND number = ?`,
    ).bind(repo, number).first<{ repo_full_name: string; number: number; state: string; head_sha: string | null; merged_at: string | null; merge_attempt_count: number | null }>(),
    // The decision that stands for this PR — the newest record across its successive head shas.
    storage(env).prepare(
      `SELECT head_sha, action, reason_code, record_json, created_at
       FROM decision_records WHERE repo_full_name = ? AND pull_number = ? ORDER BY created_at DESC LIMIT 1`,
    ).bind(repo, number).first<{ head_sha: string; action: string; reason_code: string; record_json: string | null; created_at: string }>(),
    storage(env).prepare(
      `SELECT event_type, decision, substr(summary, 1, 240) AS summary, created_at
       FROM review_audit WHERE project = ? AND target_id = ? ORDER BY created_at DESC LIMIT 25`,
    ).bind(config.slug, targetKey).all<{ event_type: string; decision: string | null; summary: string | null; created_at: string }>(),
  ]);
  if (!target) return Response.json({ error: "no such target", id }, { status: 404 });

  let decision: unknown = null;
  if (record?.record_json) {
    try {
      decision = JSON.parse(record.record_json);
    } catch {
      decision = null;
    }
  }

  return Response.json({
    project: config.slug,
    target: {
      id,
      repo: target.repo_full_name,
      number: target.number,
      kind,
      // review_targets' status enum (queued/reviewing/error/error_retryable/merged/closed/manual) has no live
      // equivalent — the cutover kept the realized DISPOSITION and dropped the processing states. Reported as
      // the disposition, which is the half every consumer of this endpoint actually reads.
      status: target.merged_at ? "merged" : target.state === "closed" ? "closed" : "open",
      verdict: record?.action ?? null,
      headSha: target.head_sha ?? null,
      // The sha the standing decision was actually made on. review_targets' `decided_sha` was a cache of the
      // same idea; this is the authoritative version rather than a reconstruction of it.
      decidedSha: record?.head_sha ?? null,
      attemptCount: target.merge_attempt_count ?? 0,
      terminalAt: target.merged_at ?? (record && record.action !== "hold" ? record.created_at : null),
      reasonCode: record?.reason_code ?? null,
    },
    decision, // the canonical DecisionRecord that explains the standing verdict (null if none recorded yet)
    audit: (audit.results ?? []).map((r) => ({ event: r.event_type, decision: r.decision, summary: r.summary, at: r.created_at })),
  });
}

/** GET /<slug>/internal/calibration — confidence-vs-outcome calibration + a recommended floor. */
export async function handleInternalCalibration(request: Request, env: Env, config: OpsAgentConfig): Promise<Response> {
  const denied = requireInternalAuth(request, env, config);
  if (denied) return denied;
  return Response.json({ project: config.slug, calibration: await computeCalibration(env, config) });
}

// ── Source-table freshness (#9136, the generalizable fix) ───────────────────────────────────────────

/** One source table's freshness verdict: does it have a row inside ITS OWN consumer's window, not just
 *  "any row ever". `fresh: false` on a read error too (a missing/dropped table is itself a staleness
 *  signal — fail CLOSED, never masquerade a broken read as "everything's fine"). */
export interface ReviewSourceFreshnessCheck {
  table: string;
  /** The consuming window (days) a stale table would fall outside of -- the same window value the real
   *  consumer(s) use, so this check fails at EXACTLY the moment those consumers' own queries would start
   *  reading an empty result. */
  windowDays: number;
  fresh: boolean;
}

/** Every table an ops/reputation module treats as a LIVE, windowed source, with that consumer's own
 *  window. `review_targets` was silently orphaned by the 2026-06-22 convergence cutover (no live writer
 *  anywhere — see src/db/repo-identity-rename.ts / src/review/public-stats.ts's own comments) and nobody
 *  noticed for months; this is the generalizable fix so the NEXT orphaning is loud, not silent.
 *   - review_targets: submitter-reputation.ts (#9136) has SINCE been repointed off this table onto the live
 *     review_audit/pull_requests ledgers — its own REPUTATION_WINDOW_DAYS (90) no longer reads this table at
 *     all. The remaining live readers are THIS file's own computeAgentHealth (byStatus/byVerdict/failedRows/
 *     manualRate/stuckRetryable/failed) and computeCalibration (mergedRows/closesByReasonRows/disputedRows) —
 *     deferred here because review_targets' non-terminal states (queued/reviewing/error/error_retryable) and
 *     the attempt-exhausted 'failed' bucket have no live per-target equivalent post-cutover: gate_decision's
 *     own `decision` column only ever records 'merge' | 'close' | 'hold' (parity.ts's GateAction), not the
 *     full status enum review_targets tracked. This table's newest row is frozen at the 2026-06-22 cutover,
 *     so ANY windowDays here eventually reads permanently stale — 90 is kept as a conservative, still-fires-
 *     eventually value, not because a live consumer still uses that exact number. See #9136 for the tracked
 *     remainder and the reasoning above.
 *   - review_audit: this module's own ANOMALY_WINDOW (7 days) — IS live today (parity-wire.ts writes
 *     'gate_decision' rows, outcomes-wire.ts writes the outcome/reversal types), so this should read fresh
 *     in steady state. If both writers ever stop, this is what catches the alerter going silently inert
 *     again, exactly the shape review_targets' own orphaning took.
 */
const REVIEW_SOURCE_FRESHNESS_SOURCES: ReadonlyArray<{ table: string; timestampColumn: string; windowDays: number }> = [
  // #9136: review_targets is GONE from this list, with the last reader that consumed it. The table is
  // permanently frozen (the 2026-06-22 convergence cutover left it with no writer), so a 90-day freshness
  // probe against it reported `fresh: false` forever — a gauge pinned at 0 that no action could ever clear,
  // which is alert noise rather than a signal. A staleness check only earns its place while something still
  // reads the table.
  //
  // decision_records takes its slot: it is what the calibration and decision surfaces read now, so IT is the
  // source whose silence would mean those surfaces have quietly gone dark. 7 days matches review_audit — both
  // are written on every gate decision, so a week of silence on either is a real outage, not a quiet period.
  { table: "review_audit", timestampColumn: "created_at", windowDays: 7 },
  { table: "decision_records", timestampColumn: "created_at", windowDays: 7 },
];

/** Check every tracked source table for a row inside its own consuming window. Read-only; a per-table
 *  query failure degrades that ONE table to `fresh: false` (fail closed) rather than throwing the whole
 *  check — a broken table is exactly the condition this exists to surface, not to hide behind an
 *  unhandled rejection. */
export async function checkReviewSourceFreshness(env: Env): Promise<ReviewSourceFreshnessCheck[]> {
  return Promise.all(
    REVIEW_SOURCE_FRESHNESS_SOURCES.map(async ({ table, timestampColumn, windowDays }): Promise<ReviewSourceFreshnessCheck> => {
      try {
        const row = await storage(env)
          .prepare(`SELECT 1 AS x FROM ${table} WHERE ${timestampColumn} IS NOT NULL AND ${timestampColumn} > datetime('now', ?) LIMIT 1`)
          .bind(`-${windowDays} days`)
          .first<{ x: number }>();
        return { table, windowDays, fresh: row != null };
      } catch {
        return { table, windowDays, fresh: false };
      }
    }),
  );
}
