// Cross-project stats endpoint (reviewbot→gittensory convergence — ADDITIVE, NATIVE port of reviewbot
// src/core/stats.ts). Read-only feed powering a local dashboard: per-project, per-verdict decision counts
// bucketed over time, plus human-reversal counts + non-content gate-decision counts — all from D1 (the
// source of truth; full history, no Analytics sampling cap). Returns ONLY aggregate counts, never PR
// content. Bearer-gated by a stats token and CORS-open so a local file:// viewer can fetch it with the
// token (the token is the gate, not the origin).
//
// SELF-CONTAINED: every type + helper this module needs is defined HERE. No imports from reviewbot. The
// logic is byte-faithful to the reviewbot source; the only deltas are mechanical guards for gittensory's
// stricter tsconfig + an INJECTED-DEPS seam.
//
// STORAGE: gittensory has no platform/access adapter — `Env` is a global ambient interface with `DB`.
//
// EVAL / PARITY / TUNING are the runtime gate's eval engine (reviewbot src/core/{eval,tuning}.ts) — they
// are NOT part of this aggregation and are heavily entangled with the gate. They are taken as INJECTED
// deps so the core decision/reversal/gate-action aggregation is fully native here. The host wires its own
// implementations (or the defaults below, which emit empty/no-signal reports, keeping the payload shape).

// ── Inlined report types (ported shapes from reviewbot src/core/{eval,tuning}.ts) ────────────────

export interface GateEvalRow {
  project: string;
  wouldMerge: number;
  mergeConfirmed: number;
  mergeFalse: number;
  wouldClose: number;
  closeConfirmed: number;
  closeFalse: number;
  hold: number;
  decided: number;
  mergePrecision: number | null;
  closePrecision: number | null;
}

export interface GateEvalReport {
  rows: GateEvalRow[];
  /** True once at least one project has enough decided samples to read meaningfully. */
  hasSignal: boolean;
}

export type RecSeverity = "info" | "warn" | "good";

export interface TuningRec {
  project: string;
  severity: RecSeverity;
  message: string;
  /** Present only on AUTO-APPLICABLE (tightening) recommendations. Auxiliary to `message`. */
  overridePayload?: unknown;
}

export interface ParityReasonBreakdown {
  reasonCode: string;
  paired: number;
  agree: number;
  disagree: number;
}

export interface GateParityRow {
  project: string;
  pairedSamples: number;
  bothMerge: number;
  bothClose: number;
  bothHold: number;
  disagree: number;
  agreementRate: number | null;
  unsafeDisagreements: number;
  byReasonCode: ParityReasonBreakdown[];
}

export interface GateParityReport {
  authoritative: string;
  shadow: string;
  rows: GateParityRow[];
  hasSignal: boolean;
}

/** Minimum paired samples (per project) before a parity read is trustworthy enough to gate a cutover. */
export const MIN_PARITY_SAMPLE = 30;
/** Documented agreement-rate floor for cutover. */
export const PARITY_AGREEMENT_FLOOR = 0.98;

/** The per-repo cutover gate: enough paired evidence, ZERO unsafe disagreements, agreement ≥ floor. */
export function isParityCutoverReady(row: GateParityRow): boolean {
  return (
    row.pairedSamples >= MIN_PARITY_SAMPLE &&
    row.unsafeDisagreements === 0 &&
    row.agreementRate != null &&
    row.agreementRate >= PARITY_AGREEMENT_FLOOR
  );
}

// ── Injected eval/parity/tuning seam (the gate engine; defaults emit empty/no-signal reports) ────

/** The runtime eval engine the stats feed folds in. The host supplies its own; the defaults below keep the
 *  payload shape stable (empty report) without dragging the gate into this module. */
export interface StatsEvalDeps {
  computeGateEval: (env: Env, opts: { days: number; nowMs: number; source?: string }) => Promise<GateEvalReport>;
  computeTuningRecommendations: (report: GateEvalReport) => TuningRec[];
  computeGateParity: (
    env: Env,
    opts: { days: number; nowMs: number; project?: string; authoritative?: string; shadow?: string },
  ) => Promise<GateParityReport>;
}

const EMPTY_EVAL: GateEvalReport = { rows: [], hasSignal: false };
const emptyParity = (authoritative = "reviewbot", shadow = "gittensory"): GateParityReport => ({ authoritative, shadow, rows: [], hasSignal: false });

/** Default deps: no-signal eval, no recommendations, empty parity. Keeps the payload shape with no engine. */
export const defaultStatsEvalDeps: StatsEvalDeps = {
  computeGateEval: async () => EMPTY_EVAL,
  computeTuningRecommendations: () => [],
  computeGateParity: async (_env, opts) => emptyParity(opts.authoritative, opts.shadow),
};

// ── Inlined helpers (byte-faithful from reviewbot src/core/{crypto,util}.ts) ─────────────────────

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

// ── Stats config (byte-faithful from reviewbot src/core/stats.ts) ────────────────────────────────

const STATS_TOKEN_SECRET = "REVIEWBOT_STATS_TOKEN";

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,content-type",
  "access-control-allow-methods": "GET,OPTIONS",
};

// Whitelisted bucket → SQLite strftime expression. NEVER interpolate the raw param into SQL.
const BUCKET_SQL: Record<string, string> = {
  day: "date(created_at)",
  week: "strftime('%Y-W%W', created_at)",
  month: "strftime('%Y-%m', created_at)",
};

export interface StatsPayload {
  generatedAt: string;
  window: { fromIso: string; days: number; bucket: string };
  projects: string[];
  verdicts: string[];
  /** One row per (bucket, project, verdict) — the dashboard pivots these into toggleable line series. */
  rows: Array<{ bucket: string; project: string; verdict: string; n: number }>;
  /** Human overrides of an auto-action (revert of a bot-merge / reopen of a bot-close), per bucket+project. */
  reversals: Array<{ bucket: string; project: string; n: number }>;
  /** Non-content gate decisions (incl. SHADOW would-actions), per project+action. */
  gateActions: Array<{ project: string; action: string; n: number }>;
  /** Gate eval: prediction scored against the PR's real outcome — merge/close precision per project. */
  gateEval: GateEvalReport;
  /** Ranked tuning recommendations derived from the eval (ready-to-flip / tighten / loosen). */
  recommendations: TuningRec[];
  /** Cross-system gate-decision parity: a SHADOW writer's gate decisions vs the authoritative ones. */
  gateParity: GateParityReport & { cutoverReady: Array<{ project: string; ready: boolean }> };
}

/** Aggregate the decision ledger for the dashboard. Pure-ish (reads D1 only); no GitHub I/O. */
export async function computeStats(
  env: Env,
  opts: { days: number; bucket: string; nowMs: number },
  deps: StatsEvalDeps = defaultStatsEvalDeps,
): Promise<StatsPayload> {
  const days = Number.isFinite(opts.days) && opts.days > 0 ? Math.min(opts.days, 730) : 90;
  // hasOwn (not `in`) so prototype keys like "constructor"/"toString" can't defeat the whitelist and
  // interpolate a non-SQL value into the query.
  const bucket = Object.hasOwn(BUCKET_SQL, opts.bucket) ? opts.bucket : "day";
  const bucketExpr = BUCKET_SQL[bucket] ?? BUCKET_SQL.day;
  const fromIso = new Date(opts.nowMs - days * 86_400_000).toISOString().slice(0, 10); // YYYY-MM-DD

  const [decisionRows, reversalRows] = await Promise.all([
    storage(env).prepare(
      `SELECT ${bucketExpr} AS bucket, project, COALESCE(verdict, status) AS verdict, COUNT(*) AS n
       FROM review_targets
       WHERE created_at >= ?
       GROUP BY bucket, project, verdict
       ORDER BY bucket ASC`,
    ).bind(fromIso).all<{ bucket: string; project: string; verdict: string; n: number }>(),
    storage(env).prepare(
      `SELECT ${bucketExpr} AS bucket, project, COUNT(*) AS n
       FROM review_audit
       WHERE event_type IN ('reversal_reverted', 'reversal_reopened') AND created_at >= ?
       GROUP BY bucket, project
       ORDER BY bucket ASC`,
    ).bind(fromIso).all<{ bucket: string; project: string; n: number }>(),
  ]);

  // Non-content gate decisions (incl. SHADOW would-actions) — recorded as `gate_decision` audit rows with
  // the action in `decision`. Lets the dashboard show would-merge/close/hold counts before going live.
  const gateRows = await storage(env).prepare(
    `SELECT project, decision AS action, COUNT(*) AS n
     FROM review_audit
     WHERE event_type = 'gate_decision' AND decision IS NOT NULL AND created_at >= ?
     GROUP BY project, action
     ORDER BY n DESC`,
  )
    .bind(fromIso)
    .all<{ project: string; action: string; n: number }>()
    .catch(() => ({ results: [] as Array<{ project: string; action: string; n: number }> }));

  const gateEval = await deps.computeGateEval(env, { days, nowMs: opts.nowMs });
  const recommendations = deps.computeTuningRecommendations(gateEval);
  const parity = await deps.computeGateParity(env, { days, nowMs: opts.nowMs });

  const rows = decisionRows.results ?? [];
  const reversals = reversalRows.results ?? [];
  return {
    generatedAt: new Date(opts.nowMs).toISOString(),
    window: { fromIso, days, bucket },
    projects: [...new Set(rows.map((r) => r.project))].sort(),
    verdicts: [...new Set(rows.map((r) => r.verdict))].sort(),
    rows,
    reversals,
    gateActions: gateRows.results ?? [],
    gateEval,
    recommendations,
    gateParity: { ...parity, cutoverReady: parity.rows.map((r) => ({ project: r.project, ready: isParityCutoverReady(r) })) },
  };
}

/** GET /<slug>/internal/parity?days=90&shadow=gittensory — bearer-gated, CORS-open cross-system gate
 *  parity feed (the per-repo cutover gate). Scoped to the agent's own project. Mirrors handleStats. */
export async function handleParity(
  request: Request,
  env: Env,
  project: string,
  deps: StatsEvalDeps = defaultStatsEvalDeps,
): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  const expected = readSecret(env, STATS_TOKEN_SECRET);
  const provided = request.headers.get("authorization") ?? "";
  if (!expected || !timingSafeEqual(provided, `Bearer ${expected}`)) {
    return new Response("unauthorized", { status: 401, headers: CORS_HEADERS });
  }
  const params = new URL(request.url).searchParams;
  const authoritative = params.get("authoritative");
  const shadow = params.get("shadow");
  const parity = await deps.computeGateParity(env, {
    days: Number(params.get("days") ?? 90),
    nowMs: Date.now(),
    project,
    ...(authoritative !== null ? { authoritative } : {}),
    ...(shadow !== null ? { shadow } : {}),
  });
  const cutoverReady = parity.rows.map((r) => ({ project: r.project, ready: isParityCutoverReady(r) }));
  return Response.json({ ...parity, cutoverReady }, { headers: CORS_HEADERS });
}

/** GET /stats/data?days=90&bucket=day — bearer-gated, CORS-open aggregate feed for the local dashboard. */
export async function handleStats(request: Request, env: Env, deps: StatsEvalDeps = defaultStatsEvalDeps): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  // Uniform 401 whether the token is UNSET or WRONG — a 404-for-unset vs 401-for-wrong split was a config
  // oracle (it revealed whether the token is configured). An unset token means NO request can authenticate,
  // so the `!expected` short-circuit also prevents a `Bearer ` (empty-token) match.
  const expected = readSecret(env, STATS_TOKEN_SECRET);
  const provided = request.headers.get("authorization") ?? "";
  if (!expected || !timingSafeEqual(provided, `Bearer ${expected}`)) {
    return new Response("unauthorized", { status: 401, headers: CORS_HEADERS });
  }

  const params = new URL(request.url).searchParams;
  const payload = await computeStats(
    env,
    {
      days: Number(params.get("days") ?? 90),
      bucket: params.get("bucket") ?? "day",
      nowMs: Date.now(),
    },
    deps,
  );
  return Response.json(payload, { headers: CORS_HEADERS });
}
