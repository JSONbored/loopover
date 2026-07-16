// Self-improvement "apply" surface (#273–#279, reviewbot→loopover convergence). The autonomous loop's
// (eval → advisor → apply) write side: a per-project store of runtime tunable overrides the loop raises
// (confidenceFloor / scopeCap) WITHOUT a human editing config + redeploying, plus the soak-gated promotion
// that flips a SHADOW-queued tightening to LIVE once it passes the gate. Everything here FAILS SAFE: a query
// error yields the base config (no override), never a blocked review.
//
// SELF-CONTAINED NATIVE PORT: every type + helper this module needs is defined HERE. ZERO imports from
// reviewbot. Storage is reached through an inline `storage(env) => env.DB` helper + a minimal D1-shaped
// interface (no Cloudflare-binding type dependency), matching the runtime's D1 calls byte-for-byte. The pure
// helpers (sanitize / merge / tightening / promotion gate) are ports of the reviewbot source
// (src/core/tunables.ts + src/core/auto-apply.ts); the only deltas are mechanical guards for loopover's
// stricter tsconfig (noUncheckedIndexedAccess, exactOptionalPropertyTypes), which do not change behavior.
//
// DEFERRED INFRA (out of scope here — this ports the pure logic + the D1-shaped store + tests):
//   • the `tunables_overrides`, `tunables_overrides_shadow`, and `override_audit` D1 TABLES (migrations).
//   • the cron-tick wiring that calls runAutoApplyRecommendations each scheduled run (per autoTune agent).
//   • the live eval data source (computeGateEval over review_audit) + the tuning advisor that feed it; the
//     caller passes the already-computed recommendations + eval row into runAutoApplyRecommendations here.
// The host wires those at cutover; the AutoApplyDeps interface below is the seam.

import { RISK_MERGE_PRECISION, type OverridePayload, type TuningRec } from "./auto-tune";

// ── Inline minimal D1 storage seam + helper (matches the runtime's env.DB calls, no CF type dependency) ──

/** The minimal prepared-statement surface this module uses (a structural subset of D1PreparedStatement). */
interface PreparedStatement {
  bind(...values: unknown[]): PreparedStatement;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
  all<T>(): Promise<{ results?: T[] }>;
}

/** The minimal storage surface this module uses (a structural subset of D1Database). */
export interface StorageLike {
  prepare(query: string): PreparedStatement;
}

/** The env shape this module needs: just the D1 binding. Structurally compatible with the host's Env. */
export interface StorageEnv {
  DB: StorageLike;
}

/** Inline storage accessor — the single seam to the D1 binding (mirrors the runtime's platform access layer). */
function storage(env: StorageEnv): StorageLike {
  return env.DB;
}

// ── Override model + validation (ported from reviewbot src/core/tunables.ts) ────────────────────────────

/** A per-project override of the safety tunables. Only ever applied if VALID (floor in [0,1], caps > 0); an
 *  unset field falls through to the config base. Extensible — add a field per future tunable. */
export interface TunableOverride {
  confidenceFloor?: number;
  scopeCap?: { files: number; lines: number };
}

interface OverrideRow {
  confidence_floor: number | null;
  scope_cap_files: number | null;
  scope_cap_lines: number | null;
  clear_at: string | null;
}

/** PURE: is a row's clear_at in the past relative to nowIso? (Skipped — not expired — when either is unset.)
 *  Extracted so writeLiveOverride's clear_at-preservation logic uses the exact same rule as rowToOverride. */
function clearAtIsExpired(clearAt: string | null, nowIso?: string): boolean {
  return !!(clearAt && nowIso && clearAt <= nowIso);
}

/** PURE: a D1 row → a validated TunableOverride (or null when empty/expired/invalid). Unit-testable. */
export function rowToOverride(row: OverrideRow | null, nowIso?: string): TunableOverride | null {
  if (!row) return null;
  if (clearAtIsExpired(row.clear_at, nowIso)) return null; // past clear_at → treated as cleared
  const o: TunableOverride = {};
  if (typeof row.confidence_floor === "number" && row.confidence_floor >= 0 && row.confidence_floor <= 1) {
    o.confidenceFloor = row.confidence_floor;
  }
  if (typeof row.scope_cap_files === "number" && row.scope_cap_files > 0 && typeof row.scope_cap_lines === "number" && row.scope_cap_lines > 0) {
    o.scopeCap = { files: row.scope_cap_files, lines: row.scope_cap_lines };
  }
  return Object.keys(o).length > 0 ? o : null;
}

/** A one-line description of an override for logs/audit. */
export function describeOverride(o: TunableOverride): string {
  const parts: string[] = [];
  if (o.confidenceFloor != null) parts.push(`floor=${o.confidenceFloor}`);
  if (o.scopeCap) parts.push(`cap=${o.scopeCap.files}f/${o.scopeCap.lines}l`);
  return parts.join(" ") || "(empty)";
}

/** PURE: validate + normalize an untrusted override payload. Returns null when there is no VALID tunable
 *  (out-of-range floor, non-positive/NaN caps, half a scopeCap, or an empty object). (#277) */
export function sanitizeOverridePayload(input: unknown): TunableOverride | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as { confidenceFloor?: unknown; scopeCap?: { files?: unknown; lines?: unknown } };
  const o: TunableOverride = {};
  if (raw.confidenceFloor != null) {
    const f = Number(raw.confidenceFloor);
    if (!Number.isFinite(f) || f < 0 || f > 1) return null;
    o.confidenceFloor = f;
  }
  if (raw.scopeCap != null) {
    const files = Number(raw.scopeCap.files);
    const lines = Number(raw.scopeCap.lines);
    if (!Number.isInteger(files) || !Number.isInteger(lines) || files <= 0 || lines <= 0) return null;
    o.scopeCap = { files, lines };
  }
  return Object.keys(o).length > 0 ? o : null;
}

/** PURE: merge a new override over an existing one — a field present in `next` wins; a field absent in `next`
 *  KEEPS the existing value. Without this, INSERT OR REPLACE writing a partial override (e.g. floor-only)
 *  would NULL the unmentioned columns and silently erase a prior scopeCap. (#partial-overwrite-fix) */
export function mergeOverride(base: TunableOverride | null, next: TunableOverride): TunableOverride {
  // Built field-by-field (not a literal with `undefined` values) for exactOptionalPropertyTypes; behavior is
  // identical to the reviewbot source — `next` wins, else the existing value is kept.
  const confidenceFloor = next.confidenceFloor ?? base?.confidenceFloor;
  const scopeCap = next.scopeCap ?? base?.scopeCap;
  const merged: TunableOverride = {};
  if (confidenceFloor !== undefined) merged.confidenceFloor = confidenceFloor;
  if (scopeCap !== undefined) merged.scopeCap = scopeCap;
  return merged;
}

/** PURE: is an override STRICTLY TIGHTENING vs the live config? A raise of the floor and/or a shrink of the
 *  cap. A field that loosens (lower floor / larger cap) — or that changes nothing — makes it non-tightening,
 *  so an autonomous loosening can never be promoted. (#276) */
export function isStrictlyTightening(o: TunableOverride, liveFloor?: number, liveScopeCap?: { files: number; lines: number }): boolean {
  let tightensSomething = false;
  if (o.confidenceFloor != null) {
    if (liveFloor != null && o.confidenceFloor < liveFloor) return false; // a floor DROP is loosening
    if (liveFloor == null || o.confidenceFloor > liveFloor) tightensSomething = true;
  }
  if (o.scopeCap) {
    if (liveScopeCap && (o.scopeCap.files > liveScopeCap.files || o.scopeCap.lines > liveScopeCap.lines)) return false; // a cap RAISE is loosening
    if (!liveScopeCap || o.scopeCap.files < liveScopeCap.files || o.scopeCap.lines < liveScopeCap.lines) tightensSomething = true;
  }
  return tightensSomething;
}

/** Minimum decided samples of evidence before any auto-promotion — the same bar the advisor uses. (#276) */
export const SHADOW_PROMOTION_MIN_DECIDED = 10;

/** How long a shadow override must SOAK before the cron may promote it to live (a transient-blip guard). (#276) */
export const SHADOW_SOAK_MS = 24 * 60 * 60 * 1000;

/** PURE promotion gate: promote a SHADOW override → LIVE only when it is (1) strictly tightening vs the live
 *  config, (2) backed by >= SHADOW_PROMOTION_MIN_DECIDED decided samples, (3) SOAKED past validated_until, and
 *  (4) the tightening is STILL warranted by the project's freshly-measured merge precision. Without (4) a
 *  24h-old snapshot's verdict is applied blind to what happened since — a transient bad batch of outcomes that
 *  has since fully recovered would still get permanently promoted, because (1)-(3) only compare against the
 *  UNCHANGED live config, never re-derive whether the tightening is still justified. (#stale-shadow-promotion-fix)
 *  Returns {promote, reason} so the cron can log why it did / didn't. (#276 evaluation-gated promotion) */
export function evaluateShadowPromotion(args: {
  override: TunableOverride;
  liveFloor?: number;
  liveScopeCap?: { files: number; lines: number };
  decided: number;
  validatedUntilIso: string | null;
  nowIso: string;
  /** The project's freshly-recomputed merge precision as of THIS tick (not the stale value the shadow rec was
   *  originally computed from). null/undefined when unavailable — the freshness check is then skipped rather
   *  than blocking promotion (fail toward the existing, already-verified soak+evidence gate). */
  currentMergePrecision?: number | null;
}): { promote: boolean; reason: string } {
  if (!isStrictlyTightening(args.override, args.liveFloor, args.liveScopeCap)) {
    return { promote: false, reason: "not strictly tightening vs live config" };
  }
  if (args.decided < SHADOW_PROMOTION_MIN_DECIDED) {
    return { promote: false, reason: `insufficient evidence (${args.decided} < ${SHADOW_PROMOTION_MIN_DECIDED} decided)` };
  }
  if (!args.validatedUntilIso || args.nowIso < args.validatedUntilIso) {
    return { promote: false, reason: `still soaking${args.validatedUntilIso ? ` until ${args.validatedUntilIso}` : ""}` };
  }
  if (args.currentMergePrecision != null && args.currentMergePrecision >= RISK_MERGE_PRECISION) {
    return {
      promote: false,
      reason: `underlying merge precision recovered (${args.currentMergePrecision} >= ${RISK_MERGE_PRECISION}) — tightening no longer warranted`,
    };
  }
  return { promote: true, reason: "tightening + evidence + soaked" };
}

// ── D1-backed override store (writes/reads; faithful to the reviewbot SQL) ───────────────────────────────
// A tiny id generator stands in for reviewbot's crypto.newId (the audit-row primary key); behavior-neutral.

function newAuditId(): string {
  return `ova_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Internal: raw row fetch shared by loadOverride + writeLiveOverride, so a write can preserve the existing
 *  clear_at column (loadOverride's public return, TunableOverride, doesn't carry clear_at). Fail-safe: null on
 *  a DB blip. */
async function loadOverrideRow(env: StorageEnv, project: string): Promise<OverrideRow | null> {
  try {
    return await storage(env)
      .prepare("SELECT confidence_floor, scope_cap_files, scope_cap_lines, clear_at FROM tunables_overrides WHERE project = ?")
      .bind(project)
      .first<OverrideRow>();
  } catch {
    return null; // fail-safe: no override on a DB blip
  }
}

/** Load the active LIVE override for a project (null if none / expired / DB error). clear_at in the past =
 *  cleared. Fail-safe: a DB blip yields no override, never a blocked review. */
export async function loadOverride(env: StorageEnv, project: string, nowIso?: string): Promise<TunableOverride | null> {
  return rowToOverride(await loadOverrideRow(env, project), nowIso);
}

/** Write the LIVE override for a project, MERGED over any existing row (partial writes are additive, never
 *  destructive). Used by the apply path (force) + shadow promotion. Preserves any existing clear_at (an
 *  operator's temporary-override expiration) rather than silently nulling it via INSERT OR REPLACE, UNLESS
 *  that clear_at has itself already lapsed, in which case it is dropped rather than resurrected — nowIso is
 *  passed into the internal re-read for exactly this reason (#stale-clear-at-fix). */
export async function writeLiveOverride(env: StorageEnv, project: string, o: TunableOverride, nowIso?: string): Promise<void> {
  const existingRow = await loadOverrideRow(env, project);
  const merged = mergeOverride(rowToOverride(existingRow, nowIso), o);
  const clearAt = existingRow && !clearAtIsExpired(existingRow.clear_at, nowIso) ? existingRow.clear_at : null;
  await storage(env)
    .prepare("INSERT OR REPLACE INTO tunables_overrides (project, confidence_floor, scope_cap_files, scope_cap_lines, applied_at, clear_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?)")
    .bind(project, merged.confidenceFloor ?? null, merged.scopeCap?.files ?? null, merged.scopeCap?.lines ?? null, clearAt)
    .run();
}

/** Delete the live override for a project (operator clear, #279). */
export async function deleteLiveOverride(env: StorageEnv, project: string): Promise<void> {
  await storage(env).prepare("DELETE FROM tunables_overrides WHERE project = ?").bind(project).run();
}

export interface ShadowOverride {
  override: TunableOverride;
  validatedUntil: string | null;
}

/** Field-limited AMS/MCP payload for live gate thresholds (#6486). Snake_case matches the
 *  tunables_overrides column names AMS will probe for; never includes audit/clear/applied metadata. */
export type LiveGateThresholdFields = {
  confidence_floor: number | null;
  scope_cap_files: number | null;
  scope_cap_lines: number | null;
};

/** Prefer the live override; if absent, fall through to a soaking shadow's queued override (#6486 / #6209). */
export function authoritativeGateOverride(live: TunableOverride | null, shadow: ShadowOverride | null): TunableOverride | null {
  return live ?? shadow?.override ?? null;
}

/** Project an authoritative TunableOverride into the exact snake_case allowlist, or null when none is active. */
export function toLiveGateThresholdFields(override: TunableOverride | null): LiveGateThresholdFields | null {
  if (!override) return null;
  if (override.confidenceFloor == null && !override.scopeCap) return null;
  return {
    confidence_floor: override.confidenceFloor ?? null,
    scope_cap_files: override.scopeCap?.files ?? null,
    scope_cap_lines: override.scopeCap?.lines ?? null,
  };
}

/** Internal: raw row fetch shared by loadShadowOverride + writeShadowOverride, so a write can preserve the
 *  existing clear_at column (ShadowOverride, loadShadowOverride's public return, doesn't carry clear_at).
 *  Fail-safe: null on a DB blip. */
async function loadShadowOverrideRow(env: StorageEnv, project: string): Promise<(OverrideRow & { validated_until: string | null }) | null> {
  try {
    return await storage(env)
      .prepare("SELECT confidence_floor, scope_cap_files, scope_cap_lines, validated_until, clear_at FROM tunables_overrides_shadow WHERE project = ?")
      .bind(project)
      .first<OverrideRow & { validated_until: string | null }>();
  } catch {
    return null;
  }
}

/** Write a recommended override to the SHADOW queue with a future validated_until (the soak deadline). MERGED
 *  over any existing shadow row so a partial write never erases a prior queued tunable. (#partial-overwrite-fix)
 *  Preserves any existing clear_at rather than silently nulling it via INSERT OR REPLACE (#stale-clear-at-fix). */
export async function writeShadowOverride(env: StorageEnv, project: string, o: TunableOverride, validatedUntilIso: string): Promise<void> {
  const existingRow = await loadShadowOverrideRow(env, project);
  const merged = mergeOverride(existingRow ? rowToOverride(existingRow) : null, o);
  const clearAt = existingRow?.clear_at ?? null;
  await storage(env)
    .prepare(
      "INSERT OR REPLACE INTO tunables_overrides_shadow (project, confidence_floor, scope_cap_files, scope_cap_lines, applied_at, validated_until, clear_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)",
    )
    .bind(project, merged.confidenceFloor ?? null, merged.scopeCap?.files ?? null, merged.scopeCap?.lines ?? null, validatedUntilIso, clearAt)
    .run();
}

/** Load the pending shadow override for a project (null if none / DB error). */
export async function loadShadowOverride(env: StorageEnv, project: string): Promise<ShadowOverride | null> {
  const row = await loadShadowOverrideRow(env, project);
  if (!row) return null;
  const override = rowToOverride(row);
  return override ? { override, validatedUntil: row.validated_until } : null;
}

/** Delete a project's shadow override (after promotion, or on clear). */
export async function deleteShadowOverride(env: StorageEnv, project: string): Promise<void> {
  await storage(env).prepare("DELETE FROM tunables_overrides_shadow WHERE project = ?").bind(project).run();
}

/** Record one override-lifecycle event to the dedicated (target-free) audit table. Fail-safe: a write error
 *  never breaks the apply path, but it IS surfaced at error level (this is the operator's ONLY visibility
 *  into an autonomous config change — a silently-dropped log line here defeats that entirely). */
export async function recordOverrideAudit(env: StorageEnv, project: string, eventType: string, detail: Record<string, unknown>): Promise<void> {
  try {
    await storage(env)
      .prepare("INSERT INTO override_audit (id, project, event_type, detail) VALUES (?, ?, ?, ?)")
      .bind(newAuditId(), project, eventType, JSON.stringify(detail))
      .run();
  } catch (error) {
    // telemetry must never break the apply path, but it must not be silent either.
    console.error(JSON.stringify({ level: "error", event: "override_audit_write_failed", project, eventType, message: String(error).slice(0, 160) }));
  }
}

/** Recent override-audit history for a project (newest first). Returns [] on any error. (#279) */
export async function listOverrideAudit(env: StorageEnv, project: string, limit = 50): Promise<Array<{ eventType: string; detail: string | null; createdAt: string }>> {
  try {
    const res = await storage(env)
      .prepare("SELECT event_type, detail, created_at FROM override_audit WHERE project = ? ORDER BY created_at DESC LIMIT ?")
      .bind(project, limit)
      .all<{ event_type: string; detail: string | null; created_at: string }>();
    return (res.results ?? []).map((r) => ({ eventType: r.event_type, detail: r.detail, createdAt: r.created_at }));
  } catch {
    return [];
  }
}

export interface ApplyResult {
  ok: true;
  applied: boolean;
  shadowed?: boolean;
  validatedUntil?: string;
  reason: string;
}

/** The shared apply core BOTH a manual endpoint (#277) and the cron (#278) call directly — no self-HTTP.
 *  force=true writes the override LIVE immediately (operator emergency tightening); force=false queues it to
 *  the SHADOW soak with a validated_until deadline (the cron promotes it once the gate passes). (#277) */
export async function applyOverrideRecommendation(
  env: StorageEnv,
  project: string,
  payload: TunableOverride,
  opts: { force: boolean; soakMs: number; nowMs: number },
): Promise<ApplyResult> {
  if (opts.force) {
    // Audit BEFORE the mutation: recordOverrideAudit is itself fail-safe (a swallowed D1 blip must never break
    // the apply path), so writing it first means the worst case is an audit row for a write that then fails —
    // never a live config change with zero audit trail. (#audit-before-write-fix)
    await recordOverrideAudit(env, project, "override_applied", { override: payload, force: true });
    await writeLiveOverride(env, project, payload, new Date(opts.nowMs).toISOString());
    return { ok: true, applied: true, reason: `force-applied ${describeOverride(payload)}` };
  }
  const validatedUntil = new Date(opts.nowMs + opts.soakMs).toISOString();
  await recordOverrideAudit(env, project, "override_shadowed", { override: payload, validatedUntil });
  await writeShadowOverride(env, project, payload, validatedUntil);
  return { ok: true, applied: false, shadowed: true, validatedUntil, reason: `shadow-queued ${describeOverride(payload)} until ${validatedUntil}` };
}

// ── Auto-apply cron core (ported from reviewbot src/core/auto-apply.ts) ─────────────────────────────────
// Closes the self-improvement loop end to end. Each tick (for autoTune agents only):
//   1) take the eval + tuning recs, and QUEUE any tightening recommendation to the shadow soak; then
//   2) PROMOTE a soaked shadow override to live once it passes the gate (tightening + evidence + soaked).
// Everything FAILS SAFE: a thrown error is logged and the run continues.
//
// The eval data source + advisor are DEFERRED infra: the host computes the eval row + tuning recs and passes
// them in via AutoApplyContext, so this module ports the apply ORCHESTRATION without importing the engine.

/** The per-project facts the host resolves before a tick: its config baseline + the freshly-computed eval +
 *  tuning recommendations. (The live eval source / advisor are deferred infra — the host supplies these.) */
export interface AutoApplyContext {
  /** Project slug. */
  project: string;
  /** Whether this project opts into auto-apply (config.features.autoTune). A non-opted project is a no-op. */
  autoTune: boolean;
  /** The project's base confidence floor (config.confidenceFloor) — the tightening direction is judged vs this. */
  baseConfidenceFloor: number;
  /** The project's base scope cap (config.nonContentGate?.scopeCap), if any. */
  baseScopeCap?: { files: number; lines: number };
  /** This project's decided-sample count from the gate eval (drives the promotion evidence gate). */
  decided: number;
  /** This project's freshly-computed merge precision from THIS tick's gate eval (the same field
   *  computeTuningRecommendations reads). Threaded into evaluateShadowPromotion so a shadow-queued tightening
   *  cannot be promoted once the precision that originally warranted it has since recovered. Optional/nullable
   *  because a project can have no would-merge samples yet (GateEvalRow.mergePrecision is null in that case). */
  mergePrecision?: number | null;
  /** The tuning advisor's recommendations for this project (only ones with an overridePayload are applied). */
  recs: TuningRec[];
  /** Current wall-clock (ms) — injected for determinism in tests. */
  nowMs: number;
}

/** Run one auto-apply tick for a project, using an injected store (the StorageEnv-backed functions above by
 *  default). FAILS SAFE: a thrown error is logged and swallowed. Faithful to reviewbot's
 *  runAutoApplyRecommendations, with the eval/advisor inputs injected via ctx (deferred infra). */
export async function runAutoApplyRecommendations(env: StorageEnv, ctx: AutoApplyContext): Promise<void> {
  if (!ctx.autoTune) return; // opt-in: only enabled agents auto-apply
  const nowIso = new Date(ctx.nowMs).toISOString();
  try {
    const recs = ctx.recs.filter((r): r is TuningRec & { overridePayload: OverridePayload } => r.overridePayload != null);

    const live = await loadOverride(env, ctx.project, nowIso);
    const liveFloor = live?.confidenceFloor ?? ctx.baseConfidenceFloor;
    const liveCap = live?.scopeCap ?? ctx.baseScopeCap;

    // 1) Queue a NEW tightening recommendation to the shadow soak (idempotent: only when nothing is already
    //    soaking, and only if it actually tightens vs the live/base config).
    const alreadyShadowed = await loadShadowOverride(env, ctx.project);
    if (!alreadyShadowed) {
      for (const rec of recs) {
        const payload = rec.overridePayload;
        if (!isStrictlyTightening(payload, liveFloor, liveCap)) continue;
        const res = await applyOverrideRecommendation(env, ctx.project, payload, { force: false, soakMs: SHADOW_SOAK_MS, nowMs: ctx.nowMs });
        console.log(JSON.stringify({ event: "auto_apply_shadowed", project: ctx.project, reason: res.reason }));
        break; // one pending soak at a time
      }
    }

    // 2) Promote a soaked shadow override to live once the gate passes.
    const shadow = alreadyShadowed ?? (await loadShadowOverride(env, ctx.project));
    if (shadow) {
      const gate = evaluateShadowPromotion({
        override: shadow.override,
        ...(liveFloor !== undefined ? { liveFloor } : {}),
        ...(liveCap !== undefined ? { liveScopeCap: liveCap } : {}),
        decided: ctx.decided,
        validatedUntilIso: shadow.validatedUntil,
        nowIso,
        ...(ctx.mergePrecision !== undefined ? { currentMergePrecision: ctx.mergePrecision } : {}),
      });
      if (gate.promote) {
        // Audit BEFORE the mutation — see applyOverrideRecommendation's force branch for why this ordering
        // matters. (#audit-before-write-fix)
        await recordOverrideAudit(env, ctx.project, "override_promoted", { override: shadow.override, reason: gate.reason });
        await writeLiveOverride(env, ctx.project, shadow.override, nowIso);
        await deleteShadowOverride(env, ctx.project);
        console.log(JSON.stringify({ event: "auto_apply_promoted", project: ctx.project, override: describeOverride(shadow.override) }));
      } else {
        console.log(JSON.stringify({ event: "auto_apply_hold", project: ctx.project, reason: gate.reason }));
      }
    }
  } catch (error) {
    console.log(JSON.stringify({ event: "auto_apply_error", project: ctx.project, message: String(error).slice(0, 160) }));
  }
}
