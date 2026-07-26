// Convergence (ops / observability) — wires the ported alerts + stats observability into loopover, behind
// the default-OFF `LOOPOVER_REVIEW_OPS` flag. Flag-OFF every export here is a no-op / 404, so the worker is
// byte-identical to today (the cron enqueues no ops job; the endpoint short-circuits).
//
// ADAPTED TO LOOPOVER'S OWN OUTCOME DATA — NOT reviewbot's `review_targets`/`review_audit` (those tables are
// not populated here). The ported reviewbot modules (src/review/alerts.ts, src/review/stats.ts) are built
// around `review_targets` + a Discord webhook; loopover's review-outcome ledger is different, so this module
// derives the equivalent health/anomaly signals from loopover's native sources via the EXISTING aggregation
// services (no new queries, no schema change):
//   • gate_outcomes (#554) — the gate-block ledger; blocked-then-merged = a gate FALSE POSITIVE, plus the
//     maintainer-OVERRIDE count. Aggregated by services/gate-precision.ts (buildGatePrecisionReport).
//   • agent_recommendation_outcomes (#543) — recommendation positive/negative/pending split, and the
//     persisted slop band on resolved PRs (slop score discrimination). Aggregated by
//     services/outcome-calibration.ts (buildRepoOutcomeCalibration).
//
// NOTIFY PATH: loopover has NO Discord / operator webhook (notifications/service.ts is a per-recipient,
// pull-based BADGE feed — the wrong channel for an operator anomaly). So an anomaly emits a structured
// `console.error` log line with an `event` field (#orb-ci-stuck-repeat: this was previously `console.warn` with
// an `ev` field — forwardStructuredLogToSentry, src/selfhost/sentry.ts, only wraps console.log/console.error
// -- never console.warn -- and keys the Sentry issue off a field literally named `event`, not `ev`. Under the
// old shape, every anomaly this module ever found was invisible to Sentry regardless of whether Sentry was
// active; it only ever reached Workers Logs, which is why a 20+-hour token-usage bleed went unnoticed until a
// human queried the database directly. `console.error` + `event` is the same convention every other Sentry-
// visible anomaly signal in this codebase already uses (selfhost_ai_provider_failed, regate_repair_exhausted,
// ci_stuck_review_repeat_suppressed).
//
// DEFERRED (NOT implemented here): the auto-tune / auto-apply config-mutation self-improve loop. The ported
// pure logic + D1 store already exist in src/review/auto-apply.ts, and so do the `tunables_overrides` /
// `_shadow` / `override_audit` tables it reads and writes (#4879's migration 0047_self_improve_tunables.sql).
// The schema is NOT the remaining blocker: actually CLOSING the loop (mutating a live gate's tunables from the
// cron) is sensitive and still needs the careful soak/promote design — the shadow-soak-then-promote lifecycle
// auto-apply.ts's own isStrictlyTightening / evaluateShadowPromotion anticipate. This module is READ-ONLY
// observability: it reports drift; it never changes what blocks a live PR.

import { findHottestInconclusiveReviewTargetForRepo, findHottestReviewTargetForRepo, listRepositories, sumByokAiUsageForRepoSince } from "../db/repositories";
import { incr } from "../selfhost/metrics";
import { isAgentConfigured } from "../settings/autonomy";
import { resolveRepositorySettings } from "../settings/repository-settings";
import { loadGatePrecisionReport, type GatePrecisionReport } from "../services/gate-precision";
import { buildRepoOutcomeCalibration, type OutcomeCalibration } from "../services/outcome-calibration";
import { triggerPagerDutyIncident, type PagerDutySeverity } from "../services/notify-pagerduty";
import { loadRepoFocusManifest } from "../signals/focus-manifest-loader";
import { resolveLoopOverSelfRepoFullName } from "../config/loopover-repo-focus-manifest";
import { errorMessage, nowIso } from "../utils/json";

/** A manifest-sourced enable override (#6275) -- the `ops` block of the loopover self-repo's `.loopover.yml`
 *  (see FocusManifestOpsConfig). `present: false` (no block, or the repo has no manifest at all) means "no
 *  override configured", not "disabled" -- the caller falls through to the env var in that case, exactly as
 *  if this parameter were omitted. Mirrors MaintainerRecapManifestOverride (maintainer-recap-wire.ts). */
export type OpsManifestOverride = { present: boolean; enabled: boolean };

/** True when the ops observability surface is enabled. Config-as-code (#6275): a present `ops` manifest
 *  block on the loopover self-repo wins outright; otherwise falls back to the LOOPOVER_REVIEW_OPS env flag
 *  (default OFF -- every export below is a no-op / 404). Truthy env convention matches isSafetyEnabled. */
export function isOpsEnabled(
  env: { LOOPOVER_REVIEW_OPS?: string | undefined },
  manifestOverride?: OpsManifestOverride | undefined,
): boolean {
  if (manifestOverride?.present) return manifestOverride.enabled;
  return /^(1|true|yes|on)$/i.test((env.LOOPOVER_REVIEW_OPS ?? "").trim());
}

// Short in-isolate TTL cache for resolveOpsManifestOverride, mirroring public-stats.ts's identical cache
// (itself mirroring review-memory-wire.ts's reviewSuppressionCache): the override always resolves to the SAME
// repo (resolveLoopOverSelfRepoFullName is fleet-wide, not per-caller), so a single slot suffices. Called from
// the internal ops dashboard route, the scheduled cron tick, AND the queue's ops-alerts job -- without this,
// every one of those triggers loadRepoFocusManifest's own persisted-snapshot read (a D1 query even on a cache
// hit). The operator's `.loopover.yml ops:` block changes rarely, so the same 60s window public-stats uses is
// a reasonable staleness bound here too.
const OPS_MANIFEST_OVERRIDE_CACHE_TTL_MS = 60_000;
let opsManifestOverrideCache: { override: OpsManifestOverride; at: number } | null = null;

/**
 * Config-as-code override lookup (#6275): read the `ops` block off the loopover self-repo's
 * `.loopover.yml` (resolveLoopOverSelfRepoFullName) -- ops-alert scanning is a fleet-wide, operator-level
 * setting, not a per-repo one (there is no repo context at either call site's activation check), so ONE
 * designated repo's manifest stands in for "the operator's own config", the same way maintainerRecap
 * (#2250) already does for the cross-repo recap digest. A manifest load failure (network blip, malformed
 * YAML) degrades to `{ present: false }` -- the caller then falls through to the env var, exactly as if no
 * override existed, so a manifest hiccup can never accidentally enable or disable the scan. `nowMs` defaults
 * to `Date.now()` (mirrors public-stats.ts's resolvePublicStatsManifestOverride) so callers need no change,
 * while tests can pass a deterministic value to exercise the TTL precisely.
 */
export async function resolveOpsManifestOverride(env: Env, nowMs: number = Date.now()): Promise<OpsManifestOverride> {
  const hit = opsManifestOverrideCache;
  if (hit && nowMs - hit.at < OPS_MANIFEST_OVERRIDE_CACHE_TTL_MS) return hit.override;
  try {
    const manifest = await loadRepoFocusManifest(env, resolveLoopOverSelfRepoFullName(env));
    const config = manifest.ops;
    const override = { present: config.present, enabled: config.enabled };
    opsManifestOverrideCache = { override, at: nowMs };
    return override;
  } catch (error) {
    console.warn(JSON.stringify({ event: "ops_manifest_override_error", message: errorMessage(error).slice(0, 200) }));
    const override = { present: false, enabled: false };
    opsManifestOverrideCache = { override, at: nowMs };
    return override;
  }
}

/** Test-only: clears the cached override, mirroring clearPublicStatsManifestOverrideCacheForTest /
 *  clearReviewSuppressionCacheForTest. Without this, a test suite running many cases would leak one test's
 *  cached override into the next under fake/fixed timers. */
export function clearOpsManifestOverrideCacheForTest(): void {
  opsManifestOverrideCache = null;
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
/** #orb-ci-stuck-repeat / #orb-retry-storm: more than this many published review surfaces for the SAME PR within
 *  REVIEW_BURST_WINDOW_HOURS is not normal iteration (a human pushing a few follow-up commits tops out well
 *  below this) -- it is the signature of a stuck-CI finalize loop or a sweep retry storm. Conservative on
 *  purpose: an actively-iterated PR with several quick pushes should never trip this. */
const REVIEW_BURST_THRESHOLD = 6;
/** Rolling window the review-burst count is computed over. Short enough that the hourly ops-alerts cron catches
 *  a live bleed within one or two ticks, not the 20+ hours it took a human to notice the incident this exists
 *  to prevent from recurring. */
const REVIEW_BURST_WINDOW_HOURS = 2;

/** #review-burst-blind-spot: reviewBurst (above) only sees SUCCESSFUL publishes, so a repeat-failure retry
 *  storm (every attempt inconclusive, never publishing) sails under it indefinitely -- the exact incident
 *  c7073949 (#3747) fixed. Lower than REVIEW_BURST_THRESHOLD on purpose: a failure burst is inherently rarer
 *  and more anomalous than a publish burst (normal iteration never produces repeated INCONCLUSIVE calls). */
const REVIEW_FAILURE_BURST_THRESHOLD = 3;

/** #hosted-ai-usage-observability: the trailing window computeOpsStats' byokUsage rollup covers. Wider than the
 *  burst windows above on purpose -- this is a spend-visibility figure an operator checks periodically, not a
 *  same-tick anomaly to alert on. */
const BYOK_USAGE_WINDOW_HOURS = 24;

// ── Previous-tick anomaly state (#8903) — so a cleared anomaly can auto-resolve its PagerDuty incident ──────

/** system_flags (migration 0054) key for "did `repoFullName` have anomalies on the PREVIOUS runOpsAlerts
 *  tick?" -- reuses the SAME generic key/value table outcomes-wire.ts's readUntrustworthyRuleCodes /
 *  writeUntrustworthyRuleCodes already do for an identical "cheap cron-tick state, no new migration" shape,
 *  and the SAME `<family>:<scope>` key convention as that table's holdonly:/closehold: families. */
function opsAnomalyActiveFlagKey(repoFullName: string): string {
  return `ops_anomaly_active:${repoFullName}`;
}

/** Did `repoFullName` have anomalies on the PREVIOUS tick? FAIL-SAFE: a read error or missing row degrades
 *  to `false` ("not previously active") so a D1 blip can never spuriously fire a PagerDuty resolve for an
 *  incident that was never actually triggered. */
async function readOpsAnomalyWasActive(env: Env, repoFullName: string): Promise<boolean> {
  try {
    const row = await env.DB.prepare("SELECT value FROM system_flags WHERE key = ?").bind(opsAnomalyActiveFlagKey(repoFullName)).first<{ value: string }>();
    return row?.value === "1";
  } catch {
    return false;
  }
}

/** Persist whether `repoFullName` has anomalies on THIS tick, read back by {@link readOpsAnomalyWasActive} on
 *  the next one. Best-effort (mirrors writeUntrustworthyRuleCodes): a write failure is swallowed -- the next
 *  tick's read simply serves the last successfully-written value, and this tick's write is retried then. */
async function writeOpsAnomalyActive(env: Env, repoFullName: string, active: boolean): Promise<void> {
  const key = opsAnomalyActiveFlagKey(repoFullName);
  if (active) {
    await env.DB.prepare("INSERT OR REPLACE INTO system_flags (key, value, updated_at) VALUES (?, '1', CURRENT_TIMESTAMP)")
      .bind(key)
      .run()
      .catch(() => undefined);
  } else {
    await env.DB.prepare("DELETE FROM system_flags WHERE key = ?")
      .bind(key)
      .run()
      .catch(() => undefined);
  }
}

/** One repo's outcome reports + the repo it covers — the input to the pure anomaly detector. `reviewBurst` and
 *  `reviewFailureBurst` are optional so existing snapshot-fixture tests need not be touched; absent/null means
 *  "not computed", not "healthy" -- the caller (runOpsAlerts/computeOpsStats) always populates both today. */
export interface RepoOutcomeSnapshot {
  repoFullName: string;
  gatePrecision: GatePrecisionReport;
  calibration: OutcomeCalibration;
  reviewBurst?: { targetKey: string; count: number } | null | undefined;
  reviewFailureBurst?: { targetKey: string; count: number } | null | undefined;
}

/**
 * PURE: human-readable anomalies in one repo's outcome snapshot (empty = healthy). Mirrors the SHAPE of the
 * ported alerts.ts `detectAnomalies` (a list of actionable lines), but over LOOPOVER'S signals:
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

  // REVIEW BURST (#orb-ci-stuck-repeat / #orb-retry-storm): the same PR published far more review surfaces than
  // normal iteration ever produces within a short window -- catch a stuck-CI finalize loop or sweep retry storm
  // within this scan's own next tick instead of requiring a human to notice hours later.
  if (snapshot.reviewBurst && snapshot.reviewBurst.count >= REVIEW_BURST_THRESHOLD) {
    out.push(
      `review burst: ${snapshot.reviewBurst.targetKey} published ${snapshot.reviewBurst.count} review surfaces in the last ${REVIEW_BURST_WINDOW_HOURS}h — likely a stuck-CI finalize loop or retry storm, not normal iteration. Investigate why this PR keeps re-triggering a fresh review.`,
    );
  }

  // REVIEW FAILURE BURST (#review-burst-blind-spot): the publish-burst check above cannot see a repeat-failure
  // retry storm -- every attempt produced no usable output and never reached a publish. Catch that shape too.
  if (snapshot.reviewFailureBurst && snapshot.reviewFailureBurst.count >= REVIEW_FAILURE_BURST_THRESHOLD) {
    out.push(
      `review failure burst: ${snapshot.reviewFailureBurst.targetKey} produced ${snapshot.reviewFailureBurst.count} inconclusive (zero-output) AI review calls in the last ${REVIEW_BURST_WINDOW_HOURS}h with no successful publish — likely a stuck-CI finalize loop or retry storm burning tokens for no result. Investigate why this PR's reviews keep failing.`,
    );
  }

  return out;
}

/** Classify one {@link detectOutcomeAnomalies} line by how urgently it needs a human, for PagerDuty's
 *  {@link resolvePagerDutyMinSeverity} gate. The three calibration-style anomalies (gate/slop/recommendation)
 *  are "worth recalibrating sometime" signals; the two burst anomalies are active-incident signals — the
 *  #ops-anomaly-metric Prometheus counter below already draws this same line. Matches on each anomaly's own
 *  fixed message prefix (see {@link detectOutcomeAnomalies}), so this never needs the detector's return type
 *  (`string[]`) to change and stays decoupled from its already-tested, OpenAPI-exposed shape. */
export function classifyAnomalySeverity(line: string): PagerDutySeverity {
  return line.startsWith("review burst:") || line.startsWith("review failure burst:") ? "error" : "warning";
}

/** The worst (highest-severity) anomaly in a non-empty list, for the PagerDuty summary + severity — so a
 *  repo with both a routine calibration nudge and an active-incident burst pages (if at all) at the burst's
 *  urgency, not whichever anomaly happened to sort first. */
export function worstAnomaly(anomalies: string[]): { line: string; severity: PagerDutySeverity } {
  const severityRank: Record<PagerDutySeverity, number> = { info: 0, warning: 1, error: 2, critical: 3 };
  let best = { line: anomalies[0] ?? "ops anomaly detected", severity: classifyAnomalySeverity(anomalies[0] ?? "") };
  for (const line of anomalies) {
    const severity = classifyAnomalySeverity(line);
    if (severityRank[severity] > severityRank[best.severity]) best = { line, severity };
  }
  return best;
}

// ── Cron alerts: scan loopover's outcome data, emit a structured log on drift (flag-gated by the caller) ──

/** The installed repos to scan. Mirrors fanOutAgentRegateSweepJobs's own repo population (#5016): outcome
 *  telemetry (gate precision, slop calibration, review-burst detection) is core review-quality monitoring for
 *  any repo the review agent actually runs on, unrelated to gittensor-subnet registry membership -- NOT
 *  `isRegistered`, which this used to (wrongly) match, despite this doc comment's own inner installationId
 *  guard below already assuming installation, not registration, is what matters. */
async function opsScanRepos(env: Env): Promise<string[]> {
  const repos = (await listRepositories(env)).filter((repo) => repo.isInstalled);
  // Prefer agent-configured repos when any opted in (the acting-autonomy surface, like the regate sweep); fall
  // back to every installed repo so outcome telemetry is still scanned before the agent is enabled anywhere.
  const configured: string[] = [];
  for (const repo of repos) {
    try {
      // #sweep-requires-installation: a repo with no real GitHub App installation must never be treated as
      // agent-configured purely because it resolves the operator's global-default autonomy by merely having
      // a local row -- mirrors fanOutAgentRegateSweepJobs's own guard.
      if (typeof repo.installationId !== "number") continue;
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
  const reviewBurstSinceIso = new Date(Date.now() - REVIEW_BURST_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  try {
    const repos = await opsScanRepos(env);
    for (const repoFullName of repos) {
      try {
        const [gatePrecision, calibration, reviewBurst, reviewFailureBurst] = await Promise.all([
          loadGatePrecisionReport(env, repoFullName),
          // #orb-anomaly-slop-false-positive: exclude maintainer-authored PRs from the slop half -- they merge
          // by human judgment regardless of score, so pooling them with contributor PRs can invert the
          // merge-rate-by-band comparison detectOutcomeAnomalies reads below, in any repo the maintainer is
          // heavily active in, without the deterministic score itself being wrong.
          buildRepoOutcomeCalibration(env, repoFullName, undefined, { excludeMaintainerAuthors: true }),
          findHottestReviewTargetForRepo(env, repoFullName, reviewBurstSinceIso),
          findHottestInconclusiveReviewTargetForRepo(env, repoFullName, reviewBurstSinceIso),
        ]);
        const anomalies = detectOutcomeAnomalies({ repoFullName, gatePrecision, calibration, reviewBurst, reviewFailureBurst });
        if (anomalies.length === 0) {
          // #8903: the repo is healthy THIS tick -- if it had anomalies LAST tick, close the loop by sending a
          // matching PagerDuty resolve for the same dedupKey (triggerPagerDutyIncident itself is the no-op
          // when PagerDuty isn't configured, exactly like the trigger call below). State tracking runs
          // unconditionally (not gated on the PagerDuty flag) so enabling/disabling PagerDuty mid-incident can
          // never desync from the actual anomaly history.
          if (await readOpsAnomalyWasActive(env, repoFullName)) {
            await writeOpsAnomalyActive(env, repoFullName, false);
            await triggerPagerDutyIncident(env, { repoFullName, dedupKey: `ops_anomaly:${repoFullName}`, eventAction: "resolve" });
          }
          continue;
        }
        found[repoFullName] = anomalies;
        // Structured log = loopover's notify path (no Discord/operator webhook exists) AND the Sentry path
        // (level:"error" + an `event` field reaches forwardStructuredLogToSentry). One line per repo.
        // `ev: repoFullName` (GITTENSORY-1D/1W): forwardStructuredLogToSentry only fingerprints on the top-level
        // `event` field unless an `ev` sub-field is present -- without it, every repo's anomalies collapse into
        // ONE Sentry issue. Confirmed live: one "ops_anomaly" issue mixed a JSONbored/gittensory anomaly with an
        // unrelated JSONbored/metagraphed review-burst, making both un-triageable from the issue alone.
        console.error(JSON.stringify({ level: "error", event: "ops_anomaly", ev: repoFullName, repo: repoFullName, at: nowIso(), anomalies }));
        // Experimental PagerDuty paging (#4937): no-op unless LOOPOVER_ENABLE_PAGERDUTY is set AND a routing
        // key resolves for this repo (resolvePagerDutyRoutingKey). ops_anomaly is this codebase's own existing
        // "something needs a human" judgment call -- reusing it here (rather than paging on every
        // captureError/captureReviewFailure call, which would need its own frequency/threshold policy first)
        // keeps this narrow and low-risk. Pages at the WORST anomaly's severity; triggerPagerDutyIncident itself
        // applies the min-severity floor (routine calibration nudges never page by default) and a cooldown (a
        // still-ongoing anomaly across consecutive cron ticks does not re-page every tick) -- see its own
        // comment for why alert fatigue needed both controls, not just PagerDuty's own dedup_key. Awaited (not
        // fire-and-forget) so a page failure is captured within THIS tick's own error handling, not orphaned
        // after runOpsAlerts has already returned -- triggerPagerDutyIncident itself never throws and bounds
        // its own HTTP call to a 5s timeout, so this cannot hang the scan. #8903: a matching "resolve" event
        // fires automatically on whichever future tick finds this repo healthy again -- see the
        // readOpsAnomalyWasActive branch above -- so an operator no longer resolves the incident by hand.
        const worst = worstAnomaly(anomalies);
        await triggerPagerDutyIncident(env, {
          repoFullName,
          summary: worst.line,
          severity: worst.severity,
          dedupKey: `ops_anomaly:${repoFullName}`,
          customDetails: { anomalies },
        });
        await writeOpsAnomalyActive(env, repoFullName, true);
        // #ops-anomaly-metric: Prometheus counterpart to the log line above so a self-host operator can alert on
        // /metrics instead of grepping Workers Logs. Scoped to reviewBurst/reviewFailureBurst -- the two anomalies
        // this module exists to catch fast (#orb-ci-stuck-repeat / #review-burst-blind-spot) -- rather than every
        // anomaly kind, so the counter stays a precise "stuck-CI/retry-storm" signal, not a catch-all.
        if (reviewBurst && reviewBurst.count >= REVIEW_BURST_THRESHOLD) {
          incr("loopover_ops_anomaly_total", { repo: repoFullName, kind: "review_burst" });
        }
        if (reviewFailureBurst && reviewFailureBurst.count >= REVIEW_FAILURE_BURST_THRESHOLD) {
          incr("loopover_ops_anomaly_total", { repo: repoFullName, kind: "review_failure_burst" });
        }
      } catch (error) {
        // ev: repoFullName -- same fingerprint-collapse reasoning as the ops_anomaly log above.
        console.error(JSON.stringify({ level: "error", event: "ops_anomaly_repo_error", ev: repoFullName, repo: repoFullName, message: errorMessage(error).slice(0, 200) }));
      }
    }
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "ops_anomaly_error", message: errorMessage(error).slice(0, 200) }));
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
  /** #hosted-ai-usage-observability: real (not estimated) BYOK token/cost usage over the trailing
   *  BYOK_USAGE_WINDOW_HOURS -- the only AI activity the hosted Worker can ever have (the legacy Workers-AI
   *  binding path is retired). Previously nothing exposed this for the hosted deployment at all. */
  byokUsage: { calls: number; inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number };
}

export interface OpsStatsPayload {
  generatedAt: string;
  repos: OpsStatsRepoRow[];
}

/**
 * Aggregate loopover's outcome data across the scanned repos into the stats payload. Read-only (D1 only via
 * the existing aggregation services); never any GitHub I/O. Aggregate counts only — never PR content.
 */
export async function computeOpsStats(env: Env): Promise<OpsStatsPayload> {
  const repos = await opsScanRepos(env);
  const rows: OpsStatsRepoRow[] = [];
  const reviewBurstSinceIso = new Date(Date.now() - REVIEW_BURST_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const byokUsageSinceIso = new Date(Date.now() - BYOK_USAGE_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  for (const repoFullName of repos) {
    try {
      const [gatePrecision, calibration, reviewBurst, reviewFailureBurst, byokUsage] = await Promise.all([
        loadGatePrecisionReport(env, repoFullName),
        // #orb-anomaly-slop-false-positive: same maintainer exclusion as runOpsAlerts above, so this row's
        // `slop`/`anomalies` fields stay consistent with each other and with the cron alert.
        buildRepoOutcomeCalibration(env, repoFullName, undefined, { excludeMaintainerAuthors: true }),
        findHottestReviewTargetForRepo(env, repoFullName, reviewBurstSinceIso),
        findHottestInconclusiveReviewTargetForRepo(env, repoFullName, reviewBurstSinceIso),
        sumByokAiUsageForRepoSince(env, repoFullName, byokUsageSinceIso),
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
        anomalies: detectOutcomeAnomalies({ repoFullName, gatePrecision, calibration, reviewBurst, reviewFailureBurst }),
        byokUsage,
      });
    } catch {
      /* a per-repo failure must not blank the whole feed */
    }
  }
  return { generatedAt: nowIso(), repos: rows };
}
