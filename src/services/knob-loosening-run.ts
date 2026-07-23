// Generic IO orchestration for LIVE registry knobs (#8176) — the satisfaction machinery
// (satisfaction-floor-loosening-run.ts, #8121/#8158/#8161) generalized over a LoosenableKnob entry instead
// of duplicated per knob. The satisfaction floor itself stays on its original module (its event/metadata
// field names — currentFloor/proposedFloor — are a load-bearing legacy shape its operator surfaces parse);
// every LATER live knob runs through here, and the generic status projector reads BOTH field spellings so
// one endpoint can render all live knobs' histories.
//
// Invariants carried over verbatim from the narrow start:
//   • double gating — the knob's own truthy-string wrangler var must be ON for the loop AND the override
//     read, so flipping the var off instantly restores the shipped default with no cleanup;
//   • the write path independently refuses anything that isn't a strict, bounded loosening;
//   • the override write is NOT best-effort (an unrecorded change is worse than none) — the audit trail is;
//   • one structured error-level alert per applied step, never re-alerting (the next run starts from the
//     already-loosened value and proposes nothing until the corpus justifies another step).
import {
  buildBacktestCorpus,
  computeReliabilityCurve,
  computeRepoCorpusDensity,
  deriveThresholdSuggestion,
  sliceCorpusByRepo,
  type ReliabilityCurve,
} from "@loopover/engine";
import { createSignalStore } from "../review/signal-tracking-wire";
import { recordAuditEvent } from "../db/repositories";
import { evaluateKnobDrift, evaluateKnobLoosening, LOOSENABLE_KNOBS, type KnobDriftReport, type KnobLooseningProposal, type LoosenableKnob } from "./loosening-knobs";

const CORPUS_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000; // mirrors threshold-backtest-run's 90-day window

/** Live knobs the GENERIC loop owns — the satisfaction floor is excluded because its own module
 *  (satisfaction-floor-loosening-run.ts) already runs it with its legacy event shape. Parameterized for
 *  tests; production callers use the frozen registry-derived constant below. */
export function genericLiveKnobs(knobs: readonly LoosenableKnob[] = Object.values(LOOSENABLE_KNOBS)): LoosenableKnob[] {
  return knobs.filter((knob) => knob.applyMode === "live" && knob.knobId !== "satisfaction_floor");
}
export const GENERIC_LIVE_KNOBS: readonly LoosenableKnob[] = Object.freeze(genericLiveKnobs());

/** Truthy-string env flag for `knob`, matching the repo's flag convention (mirrors outcomes-wire's flagTruthy). */
export function isKnobAutotuneEnabled(env: Env, knob: LoosenableKnob): boolean {
  const raw = (env as unknown as Record<string, unknown>)[knob.autotuneEnvVar];
  const value = (typeof raw === "string" ? raw : "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes";
}

/**
 * Read a knob's live override. Null (caller uses the shipped default) when: the knob's autotune flag is
 * off, no override row exists, or the stored value fails validation — an override may only ever sit BELOW
 * the shipped value and AT/ABOVE the hard minimum, so a corrupted/hand-edited row can never tighten the
 * knob or loosen it past safety. Fail-safe null on any DB error.
 */
export async function getKnobOverride(env: Env, knob: LoosenableKnob): Promise<number | null> {
  if (!isKnobAutotuneEnabled(env, knob)) return null;
  return readValidatedOverrideRow(env, knob, knob.overrideFlagKey);
}

/** Per-repo override storage (#8216): one system_flags key per (knob, repo) beside the global key. The
 *  repo rides inside the key — migration-free on the schemaless flag table, and trivially enumerable
 *  with one LIKE for the status surface. */
export function repoKnobOverrideFlagKey(knob: LoosenableKnob, repoFullName: string): string {
  return `${knob.overrideFlagKey}:repo:${repoFullName}`;
}

/**
 * The EARNED-override resolution seam (#8216) — one function, one precedence order:
 *   explicit per-repo `.loopover.yml` setting  (resolved upstream into settings; callers apply it FIRST
 *   via the `settings.x ?? override` chain in gateCheckPolicy — it never reaches this function)
 *   > per-repo earned override   (this function, when `repoFullName` is given and its row validates)
 *   > global earned override     (this function's fallback)
 *   > shipped default            (the caller's final ?? in the pure twins).
 * Validation is identical per scope (strictly below shipped, at/above the hard minimum), and the knob's
 * autotune flag gates EVERY scope — flipping it off restores shipped behavior everywhere instantly.
 */
export async function getKnobOverrideForRepo(env: Env, knob: LoosenableKnob, repoFullName: string | null): Promise<number | null> {
  if (!isKnobAutotuneEnabled(env, knob)) return null;
  if (repoFullName !== null) {
    const repoValue = await readValidatedOverrideRow(env, knob, repoKnobOverrideFlagKey(knob, repoFullName));
    if (repoValue !== null) return repoValue;
  }
  return readValidatedOverrideRow(env, knob, knob.overrideFlagKey);
}

async function readValidatedOverrideRow(env: Env, knob: LoosenableKnob, key: string): Promise<number | null> {
  try {
    const row = await env.DB.prepare("SELECT value FROM system_flags WHERE key = ?").bind(key).first<{ value: string }>();
    if (!row) return null;
    const parsed = Number(row.value);
    if (!Number.isFinite(parsed) || parsed >= knob.shippedValue || parsed < knob.hardMinimum) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** The #8176 consumption read: the validated default-override for the AI close-confidence floor.
 *  Threaded into gateCheckPolicy as its LAST-resort default — an explicit per-repo setting always wins.
 *  With a `repoFullName` (#8216) the repo's own earned override outranks the global one. */
export async function getAiReviewCloseConfidenceOverride(env: Env, repoFullName: string | null = null): Promise<number | null> {
  return getKnobOverrideForRepo(env, LOOSENABLE_KNOBS.ai_review_close_confidence!, repoFullName);
}

export type KnobLooseningRunResult =
  | { applied: false; reason: "flag_off" | "report_only" | "no_proposal" | "already_applied" }
  | { applied: true; proposal: KnobLooseningProposal };

/**
 * Evaluate and (when justified) apply a backtest-gated loosening of `knob` — the generic form of
 * runSatisfactionFloorLoosening, with one extra refusal: a report-only knob can NEVER write, whatever its
 * evidence says (#8159's applyMode contract). Persists the override plus the knob's own audit event type
 * carrying both split comparisons. Audit write is best-effort; the override write throws to the caller.
 */
export async function runKnobLoosening(env: Env, knob: LoosenableKnob, nowMs: number = Date.now()): Promise<KnobLooseningRunResult> {
  if (knob.applyMode !== "live") return { applied: false, reason: "report_only" };
  if (!isKnobAutotuneEnabled(env, knob)) return { applied: false, reason: "flag_off" };

  const currentValue = (await getKnobOverride(env, knob)) ?? knob.shippedValue;
  if (currentValue <= knob.hardMinimum) return { applied: false, reason: "already_applied" };

  const { fired, overrides } = await createSignalStore(env).queryRuleHistory(knob.ruleId, nowMs - CORPUS_LOOKBACK_MS);
  const proposal = evaluateKnobLoosening(knob, buildBacktestCorpus(knob.ruleId, fired, overrides), currentValue);
  if (!proposal) return { applied: false, reason: "no_proposal" };
  // Defense in depth: the write path independently refuses anything that isn't a strict, bounded loosening.
  if (proposal.proposedValue >= currentValue || proposal.proposedValue < knob.hardMinimum) {
    return { applied: false, reason: "no_proposal" };
  }

  await env.DB.prepare(
    "INSERT INTO system_flags (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  )
    .bind(knob.overrideFlagKey, String(proposal.proposedValue))
    .run();

  await recordAuditEvent(env, {
    eventType: knob.looseningEventType,
    actor: "loopover",
    targetKey: knob.ruleId,
    outcome: "completed",
    detail: `${knob.knobId} loosened ${proposal.currentValue} -> ${proposal.proposedValue} (backtest-gated, visible improved + held-out non-regressed)`,
    metadata: { proposal },
  }).catch(() => undefined);

  return { applied: true, proposal };
}

/** The cron-tick wrapper — one evaluation per knob, failing SAFE; an applied step emits ONE structured
 *  error-level alert on the same Workers-Logs + Sentry notify path the #8158 satisfaction wrapper uses. */
export async function runScheduledKnobLoosening(env: Env, knob: LoosenableKnob): Promise<KnobLooseningRunResult | null> {
  try {
    const result = await runKnobLoosening(env, knob);
    if (result.applied) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "calibration_knob_loosened",
          ev: knob.knobId,
          at: new Date().toISOString(),
          currentValue: result.proposal.currentValue,
          proposedValue: result.proposal.proposedValue,
          visibleCases: result.proposal.visibleCases,
          heldOutCases: result.proposal.heldOutCases,
        }),
      );
    }
    return result;
  } catch (error) {
    console.warn(
      JSON.stringify({ level: "warn", event: "knob_loosening_tick_failed", ev: knob.knobId, error: error instanceof Error ? error.message : "unknown error" }),
    );
    return null;
  }
}

// ── Per-repo loosening loop (#8217, epic #8211 track B capstone) ─────────────────────────────────────────

/** Repos evaluated per tick, hard-capped so a large-fleet future never turns the tick into a stampede.
 *  Deterministic order + a system_flags cursor make successive ticks cover the whole eligible set. */
export const PER_REPO_LOOSENING_MAX_REPOS_PER_TICK = 10;

const PER_REPO_CURSOR_FLAG_PREFIX = "per_repo_loosening_cursor:";

export type PerRepoLooseningResult = { repoFullName: string; applied: boolean; reason: string };

/**
 * Per-repo loosening evaluation (#8217): repos whose OWN labeled slice clears the knob's sample floors
 * (computeRepoCorpusDensity — the same split + minimums as every evaluator) earn their own loosening
 * step from their CURRENT resolved value; sparse repos keep inheriting the global value untouched.
 * Same discipline as the global loop verbatim: smallest candidate step, visible improved + held-out
 * non-regressed on the REPO slice, hard minimum, double flag gating, one error-level alert per applied
 * step (`ev` stays per-knob; the repo rides the alert body — the Sentry-fingerprint discipline).
 * Bounded work: at most {@link PER_REPO_LOOSENING_MAX_REPOS_PER_TICK} eligible repos per tick in
 * deterministic order, resuming from a per-knob cursor. Fail-safe per repo.
 */
export async function runPerRepoKnobLoosening(env: Env, knob: LoosenableKnob, nowMs: number = Date.now()): Promise<PerRepoLooseningResult[]> {
  if (knob.applyMode !== "live") return [];
  if (!isKnobAutotuneEnabled(env, knob)) return [];
  const results: PerRepoLooseningResult[] = [];
  try {
    const { fired, overrides } = await createSignalStore(env).queryRuleHistory(knob.ruleId, nowMs - CORPUS_LOOKBACK_MS);
    const cases = buildBacktestCorpus(knob.ruleId, fired, overrides);
    const density = computeRepoCorpusDensity(cases, knob.minVisibleCases, knob.minHeldOutCases, knob.heldOutFraction, knob.splitSeed);
    const eligible = [...density.entries()]
      .filter(([, stats]) => stats.eligible)
      .map(([repo]) => repo)
      .sort();
    if (eligible.length === 0) return results;

    const cursorKey = `${PER_REPO_CURSOR_FLAG_PREFIX}${knob.knobId}`;
    const cursorRow = await env.DB.prepare("SELECT value FROM system_flags WHERE key = ?").bind(cursorKey).first<{ value: string }>();
    const cursor = cursorRow?.value ?? "";
    // Rotate: start after the cursor, wrap around, cap the batch.
    const startIndex = eligible.findIndex((repo) => repo > cursor);
    const rotated = startIndex === -1 ? eligible : [...eligible.slice(startIndex), ...eligible.slice(0, startIndex)];
    const batch = rotated.slice(0, PER_REPO_LOOSENING_MAX_REPOS_PER_TICK);
    const slices = sliceCorpusByRepo(cases);

    for (const repoFullName of batch) {
      try {
        const currentValue = (await getKnobOverrideForRepo(env, knob, repoFullName)) ?? knob.shippedValue;
        if (currentValue <= knob.hardMinimum) {
          results.push({ repoFullName, applied: false, reason: "already_applied" });
          continue;
        }
        // Non-null by construction: eligibility derives from the same slicing, so every eligible repo has a slice.
        const proposal = evaluateKnobLoosening(knob, slices.get(repoFullName)!, currentValue);
        if (!proposal || proposal.proposedValue >= currentValue || proposal.proposedValue < knob.hardMinimum) {
          results.push({ repoFullName, applied: false, reason: "no_proposal" });
          continue;
        }
        await env.DB.prepare(
          "INSERT INTO system_flags (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        )
          .bind(repoKnobOverrideFlagKey(knob, repoFullName), String(proposal.proposedValue))
          .run();
        await recordAuditEvent(env, {
          eventType: knob.looseningEventType,
          actor: "loopover",
          targetKey: knob.ruleId,
          outcome: "completed",
          detail: `${knob.knobId} loosened for ${repoFullName}: ${proposal.currentValue} -> ${proposal.proposedValue} (repo-slice backtest-gated)`,
          metadata: { proposal, repoFullName, scope: "repo" },
        }).catch(() => undefined);
        console.error(
          JSON.stringify({
            level: "error",
            event: "calibration_knob_loosened",
            ev: knob.knobId,
            at: new Date().toISOString(),
            scope: "repo",
            repoFullName,
            currentValue: proposal.currentValue,
            proposedValue: proposal.proposedValue,
            visibleCases: proposal.visibleCases,
            heldOutCases: proposal.heldOutCases,
          }),
        );
        results.push({ repoFullName, applied: true, reason: "applied" });
      } catch (error) {
        console.warn(
          JSON.stringify({ level: "warn", event: "per_repo_loosening_failed", ev: knob.knobId, repoFullName, error: error instanceof Error ? error.message : "unknown error" }),
        );
        results.push({ repoFullName, applied: false, reason: "error" });
      }
    }
    const lastProcessed = batch[batch.length - 1]!;
    await env.DB.prepare(
      "INSERT INTO system_flags (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
      .bind(cursorKey, lastProcessed)
      .run();
  } catch (error) {
    console.warn(
      JSON.stringify({ level: "warn", event: "per_repo_loosening_tick_failed", ev: knob.knobId, error: error instanceof Error ? error.message : "unknown error" }),
    );
  }
  return results;
}

// ── Config-drift sentinel (#8213, epic #8211 track A) ────────────────────────────────────────────────────

/** Truthy-string flag for the drift sentinel — default off, so a deploy is byte-identical until opted in. */
export function isConfigDriftSentinelEnabled(env: Env): boolean {
  const value = ((env as unknown as Record<string, unknown>).CONFIG_DRIFT_SENTINEL_ENABLED as string | undefined ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes";
}

const DRIFT_FINGERPRINT_FLAG_PREFIX = "config_drift_fingerprint:";

export type ConfigDriftTickResult = { knobId: string; state: "alerted" | "standing" | "suppressed_looser" | "clean" };

/**
 * One sentinel pass over every live knob (#8213): replay the CURRENT live value against the knob's
 * trailing corpus and alert when a TIGHTER (or shipped-revert) alternative Pareto-dominates it — the
 * stale-config signal the #8170 retro analysis proved is the operator's largest wrongness source. A
 * LOOSER winner is suppressed (the loosening loop's own surfacing owns that direction). Episode dedup:
 * the last-alerted fingerprint (knob + direction + dominating value) persists in system_flags; a standing
 * unchanged drift never re-alerts, a CHANGED drift does, and a cleared drift clears the fingerprint.
 * ALERT-ONLY authority — the sentinel never writes a knob value. Fail-safe per knob.
 */
export async function runConfigDriftSentinel(env: Env, knobs: readonly LoosenableKnob[] = Object.values(LOOSENABLE_KNOBS)): Promise<ConfigDriftTickResult[]> {
  const results: ConfigDriftTickResult[] = [];
  for (const knob of knobs) {
    if (knob.applyMode !== "live") continue;
    try {
      const liveValue = (await getKnobOverride(env, knob)) ?? knob.shippedValue;
      const { fired, overrides } = await createSignalStore(env).queryRuleHistory(knob.ruleId, Date.now() - CORPUS_LOOKBACK_MS);
      const report = evaluateKnobDrift(knob, buildBacktestCorpus(knob.ruleId, fired, overrides), liveValue);
      const fingerprintKey = `${DRIFT_FINGERPRINT_FLAG_PREFIX}${knob.knobId}`;
      const stored = await env.DB.prepare("SELECT value FROM system_flags WHERE key = ?").bind(fingerprintKey).first<{ value: string }>();

      if (!report || report.direction === "looser") {
        if (stored) {
          await env.DB.prepare("DELETE FROM system_flags WHERE key = ?").bind(fingerprintKey).run();
        }
        results.push({ knobId: knob.knobId, state: report ? "suppressed_looser" : "clean" });
        continue;
      }

      const fingerprint = `${knob.knobId}:${report.direction}:${report.dominatingValue}`;
      if (stored?.value === fingerprint) {
        results.push({ knobId: knob.knobId, state: "standing" });
        continue;
      }
      await env.DB.prepare(
        "INSERT INTO system_flags (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
        .bind(fingerprintKey, fingerprint)
        .run();
      // Same Workers-Logs + Sentry notify path as the loosening alert; `ev` keeps knobs distinct.
      console.error(
        JSON.stringify({
          level: "error",
          event: "config_drift_detected",
          ev: knob.knobId,
          at: new Date().toISOString(),
          direction: report.direction,
          liveValue: report.liveValue,
          dominatingValue: report.dominatingValue,
          visibleCases: report.visibleCases,
          heldOutCases: report.heldOutCases,
        }),
      );
      results.push({ knobId: knob.knobId, state: "alerted" });
    } catch (error) {
      console.warn(
        JSON.stringify({ level: "warn", event: "config_drift_tick_failed", ev: knob.knobId, error: error instanceof Error ? error.message : "unknown error" }),
      );
      results.push({ knobId: knob.knobId, state: "clean" });
    }
  }
  return results;
}

// ── Operator status (the #8161 surface generalized across live knobs) ────────────────────────────────────

export type KnobAppliedEntry = {
  at: string;
  currentValue: number | null;
  proposedValue: number | null;
  visibleCases: number | null;
  heldOutCases: number | null;
  visibleVerdict: string | null;
  heldOutVerdict: string | null;
};

export type KnobRepoOverride = { repoFullName: string; value: number };

export type KnobStatus = {
  knobId: string;
  flagEnabled: boolean;
  shippedValue: number;
  /** The value the live consumption actually uses right now: the validated override when the flag is on,
   *  else the shipped constant. */
  liveValue: number;
  /** The RAW stored override row (validated), reported even when the flag is off — an operator needs to
   *  see a lingering row that would take effect the moment the flag flips. */
  storedOverride: number | null;
  /** Per-repo earned overrides (#8216), validated rows only, sorted by repo — an operator must see every
   *  scope that would take effect the moment the flag is on. */
  repoOverrides: KnobRepoOverride[];
  /** The CURRENT drift report at the live value (#8213) — computed on read, deliberately NOT flag-gated
   *  (an operator must see a standing drift even while the sentinel is off); null when clean/insufficient. */
  drift: KnobDriftReport | null;
  /** Reliability view (#8227): the rule's claimed-confidence curve over the trailing corpus plus the
   *  DERIVED floor suggestion at {@link KNOB_SUGGESTION_TARGET_PRECISION} — surfaced NEXT TO the
   *  ladder-based machinery, never replacing it (the ladder-replacement decision is #8227's recorded
   *  soak, not this field). Null when the corpus read fails or is empty. */
  reliability: { curve: ReliabilityCurve; suggestion: number | null } | null;
  applied: KnobAppliedEntry[];
};

/** The precision bar a derived-floor suggestion must clear (#8227): 0.9 — the floors exist so the
 *  at-or-above class is trustworthy enough for autonomous disposition, and nine-in-ten human-confirmed
 *  is the same order the close-confidence knob's own tight ladder implies. Surfacing-only: no evaluator
 *  consumes this constant. */
export const KNOB_SUGGESTION_TARGET_PRECISION = 0.9;

const KNOB_STATUS_HISTORY_LIMIT = 25;

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function verdictOrNull(value: unknown): string | null {
  const verdict = (value as { verdict?: unknown } | undefined)?.verdict;
  return typeof verdict === "string" ? verdict : null;
}

/**
 * One live knob's operator status: flag state, shipped vs live value, the stored override row (validated,
 * shown regardless of flag state), and the applied history projected from the knob's own audit events,
 * newest first. Reads BOTH proposal field spellings (currentValue/proposedValue and the satisfaction
 * floor's legacy currentFloor/proposedFloor) so every live knob renders through one projector. Aggregate
 * numbers and verdicts only — no corpus content. Fail-safe: a read error degrades the affected section.
 */
export async function loadKnobStatus(env: Env, knob: LoosenableKnob): Promise<KnobStatus> {
  const flagEnabled = isKnobAutotuneEnabled(env, knob);

  let storedOverride: number | null = null;
  try {
    const row = await env.DB.prepare("SELECT value FROM system_flags WHERE key = ?").bind(knob.overrideFlagKey).first<{ value: string }>();
    if (row) {
      const parsed = Number(row.value);
      if (Number.isFinite(parsed) && parsed < knob.shippedValue && parsed >= knob.hardMinimum) storedOverride = parsed;
    }
  } catch {
    storedOverride = null;
  }

  const repoOverrides: KnobRepoOverride[] = [];
  try {
    const prefix = `${knob.overrideFlagKey}:repo:`;
    const rows = await env.DB.prepare("SELECT key, value FROM system_flags WHERE key LIKE ?")
      .bind(`${prefix}%`)
      .all<{ key: string; value: string }>();
    /* v8 ignore next -- same defined-results note as the applied-history read below. */
    for (const row of rows.results ?? []) {
      const parsed = Number(row.value);
      if (!Number.isFinite(parsed) || parsed >= knob.shippedValue || parsed < knob.hardMinimum) continue;
      repoOverrides.push({ repoFullName: row.key.slice(prefix.length), value: parsed });
    }
    repoOverrides.sort((a, b) => a.repoFullName.localeCompare(b.repoFullName));
  } catch {
    /* degrade to an empty listing -- the endpoint must not throw on a read blip */
  }

  let drift: KnobDriftReport | null = null;
  try {
    const liveValue = flagEnabled && storedOverride !== null ? storedOverride : knob.shippedValue;
    const { fired, overrides } = await createSignalStore(env).queryRuleHistory(knob.ruleId, Date.now() - CORPUS_LOOKBACK_MS);
    drift = evaluateKnobDrift(knob, buildBacktestCorpus(knob.ruleId, fired, overrides), liveValue);
  } catch {
    drift = null; // degrade -- the endpoint must not throw on a read blip
  }

  let reliability: KnobStatus["reliability"] = null;
  try {
    const { fired, overrides } = await createSignalStore(env).queryRuleHistory(knob.ruleId, Date.now() - CORPUS_LOOKBACK_MS);
    const cases = buildBacktestCorpus(knob.ruleId, fired, overrides);
    if (cases.length > 0) {
      const curve = computeReliabilityCurve(cases);
      reliability = { curve, suggestion: deriveThresholdSuggestion(curve, KNOB_SUGGESTION_TARGET_PRECISION, knob.hardMinimum) };
    }
  } catch {
    reliability = null; // degrade -- the endpoint must not throw on a read blip
  }

  const applied: KnobAppliedEntry[] = [];
  try {
    const rows = await env.DB.prepare("SELECT created_at, metadata_json FROM audit_events WHERE event_type = ? ORDER BY created_at DESC LIMIT ?")
      .bind(knob.looseningEventType, KNOB_STATUS_HISTORY_LIMIT)
      .all<{ created_at: string; metadata_json: string }>();
    /* v8 ignore next -- .all() over a live D1/TestD1 always yields a defined results array; the ?? [] guards
     * a future driver-shape change, mirroring loadSatisfactionFloorStatus's identical note. */
    for (const row of rows.results ?? []) {
      let proposal: Record<string, unknown> = {};
      try {
        const metadata = JSON.parse(row.metadata_json) as { proposal?: Record<string, unknown> };
        proposal = metadata.proposal && typeof metadata.proposal === "object" ? metadata.proposal : {};
      } catch {
        /* corrupt row -- keep the entry with nulls rather than hiding that an apply happened */
      }
      applied.push({
        at: row.created_at,
        currentValue: numberOrNull(proposal.currentValue) ?? numberOrNull(proposal.currentFloor),
        proposedValue: numberOrNull(proposal.proposedValue) ?? numberOrNull(proposal.proposedFloor),
        visibleCases: numberOrNull(proposal.visibleCases),
        heldOutCases: numberOrNull(proposal.heldOutCases),
        visibleVerdict: verdictOrNull(proposal.visible),
        heldOutVerdict: verdictOrNull(proposal.heldOut),
      });
    }
  } catch {
    /* degrade to an empty history -- the endpoint must not throw on a read blip */
  }

  return {
    knobId: knob.knobId,
    flagEnabled,
    shippedValue: knob.shippedValue,
    liveValue: flagEnabled && storedOverride !== null ? storedOverride : knob.shippedValue,
    storedOverride,
    repoOverrides,
    drift,
    reliability,
    applied,
  };
}

/** Every live knob's status (satisfaction floor included — the generic projector reads its legacy
 *  proposal spelling), for GET /v1/internal/calibration/knobs. */
export async function loadLiveKnobStatuses(env: Env, knobs: readonly LoosenableKnob[] = Object.values(LOOSENABLE_KNOBS)): Promise<KnobStatus[]> {
  const statuses: KnobStatus[] = [];
  for (const knob of knobs) {
    if (knob.applyMode !== "live") continue;
    statuses.push(await loadKnobStatus(env, knob));
  }
  return statuses;
}
