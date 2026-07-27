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
  byStatus: Record<string, number>;
  byVerdict: Record<string, number>;
  terminalCount: number;
  nonTerminal: number;
  manualRate: number;
  stuckRetryable: number;
  failed: number;
  dlqCount: number;
  dlqTargets?: FailedTarget[];
  reversals: number;
  reversalRate: number;
  /** Merged + closed auto-actions in the 7d anomaly window — the reversalRate denominator. */
  recentAutoActions: number;
  failedTargets?: FailedTarget[];
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

/** The minimal review_targets row the decision endpoint reads (inlined from reviewbot src/core/db.ts). */
interface DecisionTargetRow {
  id: string;
  repo: string;
  number: number;
  kind: string;
  status: string;
  verdict: string | null;
  head_sha: string | null;
  decided_sha: string | null;
  attempt_count: number | null;
  terminal_at: string | null;
  decision_json: string | null;
}

// ── Thresholds (byte-faithful from reviewbot src/core/ops.ts) ────────────────────────────────────

const NON_TERMINAL = new Set(["queued", "reviewing", "error_retryable"]);

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
  const [statusRows, verdictRows, failedRows, reversedRows, recentActionsRow, dlqRows, dlqCountRow] = await Promise.all([
    storage(env).prepare(`SELECT status, COUNT(*) AS n FROM review_targets WHERE project = ? GROUP BY status`).bind(slug).all<{ status: string; n: number }>(),
    storage(env).prepare(`SELECT verdict, COUNT(*) AS n FROM review_targets WHERE project = ? AND verdict IS NOT NULL GROUP BY verdict`).bind(slug).all<{ verdict: string; n: number }>(),
    storage(env).prepare(
      `SELECT number, repo, verdict, last_error FROM review_targets
       WHERE project = ? AND status = 'error' AND updated_at > datetime('now', ?)
       ORDER BY updated_at DESC LIMIT ?`,
    ).bind(slug, ANOMALY_WINDOW, LIST_CAP).all<{ number: number; repo: string; verdict: string | null; last_error: string | null }>(),
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
  const byStatus: Record<string, number> = {};
  for (const r of statusRows.results ?? []) byStatus[r.status] = r.n;
  const byVerdict: Record<string, number> = {};
  for (const r of verdictRows.results ?? []) byVerdict[r.verdict] = r.n;
  const terminalCount = (byStatus.merged ?? 0) + (byStatus.closed ?? 0) + (byStatus.commented ?? 0) + (byStatus.manual ?? 0) + (byStatus.error ?? 0);
  const nonTerminal = Object.entries(byStatus).reduce((sum, [s, n]) => (NON_TERMINAL.has(s) ? sum + n : sum), 0);
  const recentAutoActions = recentActionsRow?.n ?? 0;
  const failedTargets: FailedTarget[] = (failedRows.results ?? []).map((r) => ({ number: r.number, repo: r.repo, verdict: r.verdict, lastError: r.last_error }));
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
  return {
    byStatus,
    byVerdict,
    terminalCount,
    nonTerminal,
    manualRate: terminalCount ? Number(((byStatus.manual ?? 0) / terminalCount).toFixed(3)) : 0,
    stuckRetryable: byStatus.error_retryable ?? 0,
    failed: failedTargets.length,
    dlqCount: dlqCountRow?.n ?? dlqTargets.length, // true window count (uncapped); dlqTargets is the display sample
    dlqTargets,
    reversals,
    reversalRate: recentAutoActions ? Number((reversals / recentAutoActions).toFixed(3)) : 0,
    recentAutoActions,
    failedTargets,
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
  const [mergedRows, revRows, closesByReasonRows, disputedRows] = await Promise.all([
    storage(env).prepare(`SELECT id, decision_json FROM review_targets WHERE project = ? AND status = 'merged'`).bind(slug).all<{ id: string; decision_json: string | null }>(),
    storage(env).prepare(`SELECT DISTINCT target_id FROM review_audit WHERE project = ? AND event_type = 'reversal_reverted'`).bind(slug).all<{ target_id: string }>(),
    // Close distribution by reasonCode — the denominator for spotting an over-closing gate.
    storage(env).prepare(
      `SELECT COALESCE(json_extract(decision_json, '$.reasonCode'), '(none)') AS rc, COUNT(*) AS n
       FROM review_targets WHERE project = ? AND status = 'closed' GROUP BY rc`,
    ).bind(slug).all<{ rc: string; n: number }>(),
    // Disputed closes: a bot-close a human REOPENED that the gate did NOT subsequently re-terminalize.
    storage(env).prepare(
      `SELECT COALESCE(json_extract(t.decision_json, '$.reasonCode'), '(none)') AS rc, COUNT(DISTINCT t.id) AS n
       FROM review_audit a JOIN review_targets t ON t.id = a.target_id
       WHERE a.project = ? AND a.event_type = 'reversal_reopened'
         AND NOT (t.terminal_at IS NOT NULL AND t.terminal_at > a.created_at) GROUP BY rc`,
    ).bind(slug).all<{ rc: string; n: number }>(),
  ]);
  const disputedByReason = new Map((disputedRows.results ?? []).map((r) => [r.rc, r.n]));
  const closesByReason = (closesByReasonRows.results ?? [])
    .map((r) => ({ reasonCode: r.rc, closes: r.n, disputed: disputedByReason.get(r.rc) ?? 0 }))
    .sort((a, b) => b.closes - a.closes);
  const disputedCloseCount = [...disputedByReason.values()].reduce((a, b) => a + b, 0);
  const reverted = new Set((revRows.results ?? []).map((r) => r.target_id));
  const confidenceOf = (j: string | null): number | null => {
    if (!j) return null;
    try {
      const c = (JSON.parse(j) as { confidence?: unknown }).confidence;
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
    const isKept = !reverted.has(r.id);
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
    counts: { byStatus: health.byStatus, byVerdict: health.byVerdict },
    health: {
      frozen: health.frozen ?? false,
      holdOnly: health.holdOnly ?? false,
      nonTerminal: health.nonTerminal,
      stuckRetryable: health.stuckRetryable,
      failed: health.failed,
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

  const id = rowId(config.slug, kind, repo, number);
  const target = await storage(env).prepare(`SELECT * FROM review_targets WHERE id = ?`).bind(id).first<DecisionTargetRow>();
  if (!target) return Response.json({ error: "no such target", id }, { status: 404 });

  let decision: unknown = null;
  if (target.decision_json) {
    try {
      decision = JSON.parse(target.decision_json);
    } catch {
      decision = null;
    }
  }
  const audit = await storage(env).prepare(
    `SELECT event_type, decision, substr(summary, 1, 240) AS summary, created_at
     FROM review_audit WHERE project = ? AND target_id = ? ORDER BY created_at DESC LIMIT 25`,
  )
    .bind(config.slug, id)
    .all<{ event_type: string; decision: string | null; summary: string | null; created_at: string }>();

  return Response.json({
    project: config.slug,
    target: {
      id,
      repo: target.repo,
      number: target.number,
      kind: target.kind,
      status: target.status,
      verdict: target.verdict ?? null,
      headSha: target.head_sha ?? null,
      decidedSha: target.decided_sha ?? null,
      attemptCount: target.attempt_count ?? 0,
      terminalAt: target.terminal_at,
    },
    decision, // the cached terminal GateDecision for decidedSha (null if none cached yet)
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
  { table: "review_targets", timestampColumn: "terminal_at", windowDays: 90 },
  { table: "review_audit", timestampColumn: "created_at", windowDays: 7 },
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
