// Convergence (ops / observability) — wires the ported alerts + stats observability into gittensory, behind
// the default-OFF `REVIEWBOT_OPS` flag. Flag-OFF every export here is a no-op / 404, so the worker is
// byte-identical to today (the cron enqueues no ops job; the endpoint short-circuits).
//
// ADAPTED TO GITTENSORY'S OWN OUTCOME DATA — NOT reviewbot's `review_targets`/`review_audit` (those tables are
// not populated here). The ported reviewbot modules (src/review/alerts.ts, src/review/stats.ts) are built
// around `review_targets` + a Discord webhook; gittensory's review-outcome ledger is different, so this module
// derives the equivalent health/anomaly signals from gittensory's native sources via the EXISTING aggregation
// services (no new queries, no schema change):
//   • gate_outcomes (#554) — the gate-block ledger; blocked-then-merged = a gate FALSE POSITIVE, plus the
//     maintainer-OVERRIDE count. Aggregated by services/gate-precision.ts (buildGatePrecisionReport).
//   • agent_recommendation_outcomes (#543) — recommendation positive/negative/pending split, and the
//     persisted slop band on resolved PRs (slop score discrimination). Aggregated by
//     services/outcome-calibration.ts (buildRepoOutcomeCalibration).
//
// NOTIFY PATH: gittensory has NO Discord / operator webhook (notifications/service.ts is a per-recipient,
// pull-based BADGE feed — the wrong channel for an operator anomaly). So, per the task ("Discord/webhook if
// present, else a structured log"), an anomaly emits a structured `console.warn` log line (the house
// `JSON.stringify({ ev: ... })` convention used across the worker) that Workers Logs/Observability surfaces.
//
// DEFERRED (NOT implemented here): the auto-tune / auto-apply config-mutation self-improve loop. The ported
// pure logic + D1 store already exist in src/review/auto-apply.ts, but actually CLOSING the loop (mutating a
// live gate's tunables from the cron) is sensitive — it needs the `tunables_overrides` / `_shadow` /
// `override_audit` D1 tables (none of which exist in gittensory's migrations yet) plus a careful soak/promote
// design. This module is READ-ONLY observability: it reports drift; it never changes what blocks a live PR.

import { listRepositories } from "../db/repositories";
import { isAgentConfigured } from "../settings/autonomy";
import { resolveRepositorySettings } from "../settings/repository-settings";
import { loadGatePrecisionReport, type GatePrecisionReport } from "../services/gate-precision";
import { buildRepoOutcomeCalibration, type OutcomeCalibration } from "../services/outcome-calibration";
import { errorMessage, nowIso } from "../utils/json";

/** True when the ops observability surface is enabled. Flag-OFF (default) → every export below is a no-op /
 *  404. Truthy follows the codebase convention (`/^(1|true|yes|on)$/i`, same as isSafetyEnabled). */
export function isOpsEnabled(env: { REVIEWBOT_OPS?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test(env.REVIEWBOT_OPS ?? "");
}

// ── Anomaly thresholds (gittensory-native; conservative so a handful of samples never cries wolf) ──────────

/** A gate type's false-positive rate (blocked-then-merged / blocked) above this is a "too-loose gate" signal.
 *  The precision report already nulls the rate below its MIN_SAMPLE, so only judged gates reach here. */
const GATE_FALSE_POSITIVE_THRESHOLD = 0.3;
/** A recommendation NEGATIVE rate (1 - positiveRate) above this is a "recommendations aren't panning out"
 *  signal — but only once there is enough resolved evidence to judge. */
const RECOMMENDATION_NEGATIVE_THRESHOLD = 0.5;
/** Don't judge the recommendation negative-rate off a trickle of resolved outcomes. */
const MIN_RECOMMENDATION_RESOLVED = 5;

/** One repo's outcome reports + the repo it covers — the input to the pure anomaly detector. */
export interface RepoOutcomeSnapshot {
  repoFullName: string;
  gatePrecision: GatePrecisionReport;
  calibration: OutcomeCalibration;
}

/**
 * PURE: human-readable anomalies in one repo's outcome snapshot (empty = healthy). Mirrors the SHAPE of the
 * ported alerts.ts `detectAnomalies` (a list of actionable lines), but over GITTENSORY'S signals:
 *   • a gate type whose blocked-then-merged rate is high (the gate is blocking mergeable PRs);
 *   • the slop score INVERTING (a higher-severity band merging more than a lower one — score not predictive);
 *   • recommendations not panning out (a high negative outcome rate over enough resolved evidence).
 * Unit-testable with no I/O.
 */
export function detectOutcomeAnomalies(snapshot: RepoOutcomeSnapshot): string[] {
  const out: string[] = [];

  // GATE FALSE-POSITIVE SPIKE: a gate type with a meaningful blocked sample whose blocks keep merging anyway.
  // Surface the worst offender (the precision report already sorts + nulls noisy rates).
  for (const type of snapshot.gatePrecision.perGateType) {
    if (type.falsePositiveRate != null && type.falsePositiveRate >= GATE_FALSE_POSITIVE_THRESHOLD) {
      out.push(
        `gate false-positive spike: \`${type.gateType}\` blocked ${type.blocked} PR(s), ${type.blockedThenMerged} merged anyway (${Math.round(type.falsePositiveRate * 100)}% false-positive, ${type.overridden} overridden) — the gate is holding mergeable PRs. Keep it advisory / loosen it.`,
      );
    }
  }

  // SLOP SCORE INVERTING: the deterministic slop band is no longer predictive (a higher band merged MORE
  // than a lower one). discriminates===false is the ground-truth "recalibrate" signal; null = not enough data.
  if (snapshot.calibration.slop.discriminates === false) {
    out.push(
      `slop score NOT discriminating (${snapshot.calibration.slop.totalResolved} resolved PRs): a higher-severity band merged more often than a lower one. Consider recalibrating the slop score.`,
    );
  }

  // RECOMMENDATIONS NOT PANNING OUT: a high negative outcome rate over enough resolved evidence.
  const rec = snapshot.calibration.recommendations;
  const resolved = rec.positive + rec.negative;
  if (rec.positiveRate != null && resolved >= MIN_RECOMMENDATION_RESOLVED && 1 - rec.positiveRate >= RECOMMENDATION_NEGATIVE_THRESHOLD) {
    out.push(
      `recommendations not panning out: ${rec.negative}/${resolved} resolved outcomes were negative (${Math.round((1 - rec.positiveRate) * 100)}% negative). Review the recommendation logic.`,
    );
  }

  return out;
}

// ── Cron alerts: scan gittensory's outcome data, emit a structured log on drift (flag-gated by the caller) ──

/** The registered repos to scan. Scoped to REGISTERED repos (the ones gittensory actually tracks outcomes
 *  for) — same `isRegistered` filter the other scheduled fan-outs use. */
async function opsScanRepos(env: Env): Promise<string[]> {
  const repos = (await listRepositories(env)).filter((repo) => repo.isRegistered);
  // Prefer agent-configured repos when any opted in (the acting-autonomy surface, like the regate sweep); fall
  // back to every registered repo so outcome telemetry is still scanned before the agent is enabled anywhere.
  const configured: string[] = [];
  for (const repo of repos) {
    try {
      const settings = await resolveRepositorySettings(env, repo.fullName);
      if (isAgentConfigured(settings.autonomy)) configured.push(repo.fullName);
    } catch {
      /* a settings blip on one repo must not abort the whole scan */
    }
  }
  return configured.length > 0 ? configured : repos.map((repo) => repo.fullName);
}

/**
 * The ops anomaly scan, run on the cron tick. FAILS SAFE: a per-repo error is logged and the scan continues;
 * a top-level error is swallowed (telemetry must never break the cron). When a repo has anomalies it emits ONE
 * structured `ops_anomaly` warn log naming the repo + the drift lines so an operator hears about it via Workers
 * Logs. Returns the per-repo anomaly map (for tests / a caller that wants to act on it).
 *
 * Caller MUST gate this on {@link isOpsEnabled} — it is invoked only from the flag-ON cron path, so flag-OFF
 * this function is never reached and the cron does zero new work.
 */
export async function runOpsAlerts(env: Env): Promise<Record<string, string[]>> {
  const found: Record<string, string[]> = {};
  try {
    const repos = await opsScanRepos(env);
    for (const repoFullName of repos) {
      try {
        const [gatePrecision, calibration] = await Promise.all([
          loadGatePrecisionReport(env, repoFullName),
          buildRepoOutcomeCalibration(env, repoFullName),
        ]);
        const anomalies = detectOutcomeAnomalies({ repoFullName, gatePrecision, calibration });
        if (anomalies.length === 0) continue;
        found[repoFullName] = anomalies;
        // Structured log = gittensory's notify path (no Discord/operator webhook exists). One line per repo.
        console.warn(JSON.stringify({ ev: "ops_anomaly", repo: repoFullName, at: nowIso(), anomalies }));
      } catch (error) {
        console.warn(JSON.stringify({ ev: "ops_anomaly_repo_error", repo: repoFullName, message: errorMessage(error).slice(0, 200) }));
      }
    }
  } catch (error) {
    console.warn(JSON.stringify({ ev: "ops_anomaly_error", message: errorMessage(error).slice(0, 200) }));
  }
  return found;
}

// ── Stats: cross-repo outcome aggregate, bearer-gated endpoint (flag-gated by the caller) ──────────────────

/** Per-repo outcome rollup the stats feed returns (aggregate counts only — no PR content / actor logins). */
export interface OpsStatsRepoRow {
  repoFullName: string;
  /** Gate-block ledger: total blocks, blocked-then-merged (false positives), overall false-positive rate. */
  gate: { blocked: number; blockedThenMerged: number; falsePositiveRate: number | null };
  /** Slop-score calibration: resolved PRs, overall merge rate, and whether the band is still predictive. */
  slop: { totalResolved: number; overallMergeRate: number | null; discriminates: boolean | null };
  /** Recommendation outcome split. */
  recommendations: { total: number; positive: number; negative: number; pending: number; positiveRate: number | null };
  /** The active anomaly lines for this repo (same as the cron alert), so the dashboard can flag drift. */
  anomalies: string[];
}

export interface OpsStatsPayload {
  generatedAt: string;
  repos: OpsStatsRepoRow[];
}

/**
 * Aggregate gittensory's outcome data across the scanned repos into the stats payload. Read-only (D1 only via
 * the existing aggregation services); never any GitHub I/O. Aggregate counts only — never PR content.
 */
export async function computeOpsStats(env: Env): Promise<OpsStatsPayload> {
  const repos = await opsScanRepos(env);
  const rows: OpsStatsRepoRow[] = [];
  for (const repoFullName of repos) {
    try {
      const [gatePrecision, calibration] = await Promise.all([
        loadGatePrecisionReport(env, repoFullName),
        buildRepoOutcomeCalibration(env, repoFullName),
      ]);
      rows.push({
        repoFullName,
        gate: {
          blocked: gatePrecision.overall.blocked,
          blockedThenMerged: gatePrecision.overall.blockedThenMerged,
          falsePositiveRate: gatePrecision.overall.falsePositiveRate,
        },
        slop: {
          totalResolved: calibration.slop.totalResolved,
          overallMergeRate: calibration.slop.overallMergeRate,
          discriminates: calibration.slop.discriminates,
        },
        recommendations: calibration.recommendations,
        anomalies: detectOutcomeAnomalies({ repoFullName, gatePrecision, calibration }),
      });
    } catch {
      /* a per-repo failure must not blank the whole feed */
    }
  }
  return { generatedAt: nowIso(), repos: rows };
}
