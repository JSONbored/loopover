// Operational endpoints (the ops capability — reviewbot→gittensory convergence, ADDITIVE, NATIVE port of
// reviewbot src/core/ops.ts). Bearer-protected per agent. Surfaces enough to answer "is this agent
// behaving?": health snapshot (status/verdict breakdown, manual-rate, stuck/failed/DLQ targets, reversals),
// confidence-vs-outcome calibration + a recommended floor, and the decision trail for one target.
//
// SELF-CONTAINED: every type + helper this module needs is defined HERE. No imports from reviewbot. The
// logic is byte-faithful to the reviewbot source; the only deltas are mechanical guards for gittensory's
// stricter tsconfig + an INJECTED-DEPS seam for the runtime-gate-specific pieces.
//
// STORAGE: gittensory has no platform/access adapter — `Env` is a global ambient interface with `DB`.
//
// SCOPE (deferred): reviewbot's ops.ts ALSO exposes the auto-tune override handlers
// (handleApplyRecommendation / handleClearOverride / handleOverrideAudit). Those are HEAVILY entangled with
// reviewbot's runtime override store (src/core/tunables.ts — a 257-line shadow-soak/sanitize/tighten-only
// engine) and are intentionally NOT ported here — porting them would drag the auto-tune engine into the
// gittensory tree. Likewise handleInternalStatus's account-wide AI-error count is the runtime AI-health
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
}

/** The minimal agent-config shape the ops endpoints read. (Subset of reviewbot's AgentConfig.) */
export interface OpsAgentConfig {
  slug: string;
  confidenceFloor?: number;
  secrets: { internalSecret?: string };
}

// ── Inlined helpers (byte-faithful from reviewbot src/core/{crypto,util,db}.ts) ──────────────────

/** Storage seam: gittensory's `Env` is a global ambient interface with `DB`. */
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
const DLQ_RECOVERED_STATUSES = "('merged', 'closed', 'commented', 'manual', 'ignored')";

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
    // Recent human reversals of a bot auto-action. A reopened bot-close the gate SUBSEQUENTLY
    // RE-TERMINALIZED (terminal_at AFTER the reopen) is excluded — the gate re-reviewed and ACTED on it.
    storage(env).prepare(
      `SELECT t.number AS number, t.repo AS repo, t.status AS status, a.event_type AS event_type
       FROM review_audit a JOIN review_targets t ON t.id = a.target_id
       WHERE a.project = ? AND a.event_type IN ('reversal_reverted', 'reversal_reopened')
         AND a.created_at > datetime('now', ?)
         AND NOT (a.event_type = 'reversal_reopened' AND t.terminal_at IS NOT NULL AND t.terminal_at > a.created_at)
       ORDER BY a.created_at DESC LIMIT ?`,
    ).bind(slug, ANOMALY_WINDOW, LIST_CAP).all<{ number: number; repo: string; status: string; event_type: string }>(),
    // Auto-actions in the SAME 7d window — the rate denominator.
    storage(env).prepare(`SELECT COUNT(*) AS n FROM review_targets WHERE project = ? AND status IN ('merged', 'closed') AND terminal_at > datetime('now', ?)`).bind(slug, ANOMALY_WINDOW).first<{ n: number }>(),
    // RECENT, UNRECOVERED dead-letter events, WITH the PR.
    storage(env).prepare(
      `SELECT t.number AS number, t.repo AS repo, t.verdict AS verdict, t.last_error AS last_error
       FROM review_audit a JOIN review_targets t ON t.id = a.target_id
       WHERE a.project = ? AND a.event_type = 'dead_lettered' AND a.created_at > datetime('now', ?)
         AND t.status NOT IN ${DLQ_RECOVERED_STATUSES}
       ORDER BY a.created_at DESC LIMIT ?`,
    ).bind(slug, DLQ_WINDOW, LIST_CAP).all<{ number: number; repo: string; verdict: string | null; last_error: string | null }>(),
    // TRUE count of recent UNRECOVERED dead-letters — a separate COUNT(*) so a storm of >LIST_CAP isn't
    // undercounted, and so recovered targets never inflate it.
    storage(env).prepare(
      `SELECT COUNT(*) AS n FROM review_audit a JOIN review_targets t ON t.id = a.target_id
       WHERE a.project = ? AND a.event_type = 'dead_lettered' AND a.created_at > datetime('now', ?)
         AND t.status NOT IN ${DLQ_RECOVERED_STATUSES}`,
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
  const reversedTargets: ReversedTarget[] = (reversedRows.results ?? []).map((r) => ({ number: r.number, repo: r.repo, status: r.status, eventType: r.event_type }));
  const dlqTargets: FailedTarget[] = (dlqRows.results ?? []).map((r) => ({ number: r.number, repo: r.repo, verdict: r.verdict, lastError: r.last_error }));
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
  for (const r of mergedRows.results ?? []) {
    const c = confidenceOf(r.decision_json);
    if (c == null) continue;
    (reverted.has(r.id) ? rev : kept).push(c);
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
