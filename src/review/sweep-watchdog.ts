// Self-heal (flag-gated by LOOPOVER_SWEEP_WATCHDOG). The scheduled regate sweep (fanOutAgentRegateSweepJobs /
// sweepRepoRegate, src/queue/processors.ts) advances every acting-autonomy repo's `last_regated_at` marker on
// every successful sweep tick. When the sweep stops advancing that marker for a repo — a stalled cron, a wedged
// per-repo failure that keeps recurring, a rate-limit floor that never clears — nothing in the system previously
// noticed on its own; the 2026-07-06 incident stayed silent for hours until a human queried the database. This
// watchdog closes that gap: it runs the SAME repo-selection the sweep itself uses, and for any repo with open
// PRs whose sweep marker hasn't advanced within the staleness window, it (a) emits a structured Sentry-visible
// log, and (b) re-enqueues a single targeted `agent-regate-sweep` for just that repo — the same message shape
// the normal fan-out sends, so this is a pure "nudge," never a bypass of the sweep's own gating/dedup logic.
//
// Default OFF (like every other *-wire-adjacent convergence capability) — flag-OFF this module is never invoked
// and the cron enqueues no watchdog job, byte-identical to today.

import { countOpenPullRequests, getLatestRegatedAt } from "../db/repositories";
import { resolveConfiguredRepoCandidates } from "./configured-repo-set";
import { isAgentConfigured } from "../settings/autonomy";
import { resolveRepositorySettings } from "../settings/repository-settings";
import { loadRepoFocusManifest } from "../signals/focus-manifest-loader";
import { resolveLoopOverSelfRepoFullName } from "../config/loopover-repo-focus-manifest";
import type { JobMessage } from "../types";
import { errorMessage, nowIso } from "../utils/json";
import { isConvergenceRepoAllowed } from "./cutover-gate";

/** A manifest-sourced enable/threshold override (#6558 / #6275 / #6594) -- the top-level `sweepWatchdog`
 *  block of the loopover self-repo's `.loopover.yml` (see FocusManifestSweepWatchdogConfig). Distinct from the
 *  per-repo FORCE-OFF under `review.sweepWatchdog`. `present: false` means "no override configured",
 *  not "disabled" -- the caller falls through to the env var in that case. `staleAfterMinutes: null` means
 *  keep the hardcoded {@link SWEEP_STALENESS_THRESHOLD_MS} default. Mirrors OpsManifestOverride. */
export type SweepWatchdogManifestOverride = {
  present: boolean;
  enabled: boolean;
  staleAfterMinutes: number | null;
};

/** True when the sweep-liveness watchdog is enabled. Config-as-code (#6558 / #6275): a present top-level
 *  `sweepWatchdog` manifest block on the loopover self-repo wins outright; otherwise falls back to the
 *  LOOPOVER_SWEEP_WATCHDOG env flag (default OFF). Flag-OFF (default) → the caller never invokes it, so the
 *  cron enqueues no watchdog job and the queue processor no-ops on a stale in-flight one (defense-in-depth,
 *  mirrors isOpsEnabled). */
export function isSweepWatchdogEnabled(
  env: { LOOPOVER_SWEEP_WATCHDOG?: string | undefined },
  manifestOverride?: SweepWatchdogManifestOverride | undefined,
): boolean {
  if (manifestOverride?.present) return manifestOverride.enabled;
  return /^(1|true|yes|on)$/i.test(env.LOOPOVER_SWEEP_WATCHDOG ?? "");
}

// Short in-isolate TTL cache for resolveSweepWatchdogManifestOverride, mirroring ops-wire.ts /
// public-stats.ts: the override always resolves to the SAME repo (resolveLoopOverSelfRepoFullName is
// fleet-wide), so a single slot suffices. Called from the scheduled cron tick AND the queue's
// sweep-liveness-watchdog job -- without this, every trigger re-reads the persisted snapshot.
const SWEEP_WATCHDOG_MANIFEST_OVERRIDE_CACHE_TTL_MS = 60_000;
let sweepWatchdogManifestOverrideCache: { override: SweepWatchdogManifestOverride; at: number } | null = null;

/**
 * Config-as-code override lookup (#6558 / #6275): read the top-level `sweepWatchdog` block off the
 * loopover self-repo's `.loopover.yml`. A manifest load failure degrades to `{ present: false }` so a
 * hiccup can never accidentally enable or disable the watchdog. `nowMs` defaults to `Date.now()` so
 * callers need no change, while tests can pass a deterministic value to exercise the TTL precisely.
 */
export async function resolveSweepWatchdogManifestOverride(env: Env, nowMs: number = Date.now()): Promise<SweepWatchdogManifestOverride> {
  const hit = sweepWatchdogManifestOverrideCache;
  if (hit && nowMs - hit.at < SWEEP_WATCHDOG_MANIFEST_OVERRIDE_CACHE_TTL_MS) return hit.override;
  try {
    const manifest = await loadRepoFocusManifest(env, resolveLoopOverSelfRepoFullName(env));
    const config = manifest.sweepWatchdog;
    const override: SweepWatchdogManifestOverride = {
      present: config.present,
      enabled: config.enabled,
      staleAfterMinutes: config.staleAfterMinutes,
    };
    sweepWatchdogManifestOverrideCache = { override, at: nowMs };
    return override;
  } catch (error) {
    console.warn(JSON.stringify({ event: "sweep_watchdog_manifest_override_error", message: errorMessage(error).slice(0, 200) }));
    const override: SweepWatchdogManifestOverride = { present: false, enabled: false, staleAfterMinutes: null };
    sweepWatchdogManifestOverrideCache = { override, at: nowMs };
    return override;
  }
}

/** Test-only: clears the cached override, mirroring clearOpsManifestOverrideCacheForTest. */
export function clearSweepWatchdogManifestOverrideCacheForTest(): void {
  sweepWatchdogManifestOverrideCache = null;
}

/** A repo's sweep is stale when it has open PRs to regate but its last-regated marker either never advanced or
 *  hasn't advanced within the staleness window. A repo with NO open PRs is never stale — there is nothing for
 *  the sweep to do, so a `null` marker there means "nothing to regate," not "the sweep stopped working." */
export const SWEEP_STALENESS_THRESHOLD_MS = 45 * 60 * 1000;

/** Resolve the effective staleness threshold in ms from a manifest override (#6594). Absent / null minutes
 *  keep {@link SWEEP_STALENESS_THRESHOLD_MS}; never returns zero/negative/NaN. */
export function resolveSweepStalenessThresholdMs(
  manifestOverride?: SweepWatchdogManifestOverride | undefined,
): number {
  const minutes = manifestOverride?.present ? manifestOverride.staleAfterMinutes : null;
  if (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0) return minutes * 60_000;
  return SWEEP_STALENESS_THRESHOLD_MS;
}

export function isSweepStale(input: {
  openPullRequestCount: number;
  lastRegatedAt: string | null;
  nowMs: number;
  /** Optional override in milliseconds (#6594); omitted ⇒ {@link SWEEP_STALENESS_THRESHOLD_MS}. */
  staleAfterMs?: number;
}): boolean {
  if (input.openPullRequestCount === 0) return false;
  const lastMs = input.lastRegatedAt ? Date.parse(input.lastRegatedAt) : NaN;
  if (!Number.isFinite(lastMs)) return true;
  const thresholdMs =
    typeof input.staleAfterMs === "number" && Number.isFinite(input.staleAfterMs) && input.staleAfterMs > 0
      ? input.staleAfterMs
      : SWEEP_STALENESS_THRESHOLD_MS;
  return input.nowMs - lastMs > thresholdMs;
}

/** The same acting-autonomy repo set fanOutAgentRegateSweepJobs sweeps: the convergence allowlist
 *  (LOOPOVER_REVIEW_REPOS) union the webhook-registered repos with acting autonomy, deduped case-insensitively.
 *  Deliberately mirrors that function's own selection so the watchdog can never watch a DIFFERENT set of repos
 *  than the sweep actually covers.
 *
 *  Per-repo opt-out (#6275): mirrors `selftune-wire.ts`'s `selfTuneRepos` FORCE-OFF-ONLY shape exactly -- an
 *  explicit per-repo `.loopover.yml` `review.sweepWatchdog: false` excludes that one repo from the watchdog
 *  scan even though it's otherwise watched. There is no `true` override: forcing a repo the scan wouldn't
 *  otherwise watch INTO it would bypass the separate convergence-allowlist / acting-autonomy consent boundary
 *  above, which this key must not touch. Unset (the default) changes nothing. A manifest-load error fails OPEN
 *  (the repo stays watched), matching the surrounding settings-blip fail-safe below -- a config-read failure
 *  must never silently exclude a repo from monitoring. */
async function watchedRepos(env: Env): Promise<Array<{ fullName: string; installationId?: number }>> {
  // #10170: the repo-set assembly was duplicated five times; callers keep their own eligibility rules.
  const repoCandidates = await resolveConfiguredRepoCandidates(env);
  const configured: Array<{ fullName: string; installationId?: number }> = [];
  for (const repo of repoCandidates) {
    try {
      const settings = await resolveRepositorySettings(env, repo.fullName);
      // #sweep-requires-installation: mirrors fanOutAgentRegateSweepJobs's own guard -- a repo with no real
      // GitHub App installation must never be treated as agent-configured purely because it resolves the
      // operator's global-default autonomy by merely having a local row.
      const hasInstallation = typeof repo.installationId === "number";
      const watched = isConvergenceRepoAllowed(env, repo.fullName) || (hasInstallation && isAgentConfigured(settings.autonomy));
      if (!watched) continue;
      const manifest = await loadRepoFocusManifest(env, repo.fullName).catch(() => null);
      if (manifest?.review.sweepWatchdog === false) continue; // explicit per-repo opt-out (#6275)
      configured.push(repo);
    } catch {
      /* a settings blip on one repo must not abort the whole watchdog scan */
    }
  }
  return configured;
}

export interface StaleSweepRepo {
  repoFullName: string;
  installationId?: number | undefined;
  openPullRequestCount: number;
  lastRegatedAt: string | null;
  ageMs: number;
}

/**
 * The watchdog scan, run on the cron tick. FAILS SAFE: a per-repo error is logged and the scan continues; a
 * top-level error is swallowed (this is best-effort self-heal, never a reason to fail the queue). Only an
 * INSTALLED repo (installationId present) gets a self-heal re-enqueue — a registered-but-uninstalled repo never
 * gets a per-PR fan-out regardless (#sweep-uninstalled-budget-waste), so re-enqueuing its sweep would just spend
 * the shared GITHUB_PUBLIC_TOKEN budget on a sweep that can never act. Returns the stale repos found (for tests /
 * a caller that wants to act further).
 *
 * Caller MUST gate this on {@link isSweepWatchdogEnabled} — it is invoked only from the flag-ON cron path, so
 * flag-OFF this function is never reached and the cron does zero new work.
 */
export async function runSweepLivenessWatchdog(
  env: Env,
  /** Optional pre-resolved override (#6594); when omitted, looks up the self-repo manifest (cached). */
  manifestOverride?: SweepWatchdogManifestOverride,
): Promise<StaleSweepRepo[]> {
  const found: StaleSweepRepo[] = [];
  const nowMs = Date.parse(nowIso());
  const override = manifestOverride ?? (await resolveSweepWatchdogManifestOverride(env, nowMs));
  const staleAfterMs = resolveSweepStalenessThresholdMs(override);
  try {
    const repos = await watchedRepos(env);
    for (const repo of repos) {
      try {
        if (typeof repo.installationId !== "number") continue;
        const [openPullRequestCount, lastRegatedAt] = await Promise.all([countOpenPullRequests(env, repo.fullName), getLatestRegatedAt(env, repo.fullName)]);
        if (!isSweepStale({ openPullRequestCount, lastRegatedAt, nowMs, staleAfterMs })) continue;
        const lastMs = lastRegatedAt ? Date.parse(lastRegatedAt) : NaN;
        const ageMs = Number.isFinite(lastMs) ? nowMs - lastMs : Number.POSITIVE_INFINITY;
        found.push({ repoFullName: repo.fullName, installationId: repo.installationId, openPullRequestCount, lastRegatedAt, ageMs });
        console.error(
          JSON.stringify({
            level: "error",
            event: "sweep_liveness_stale",
            repository: repo.fullName,
            openPullRequestCount,
            lastRegatedAt,
            ageMs: Number.isFinite(ageMs) ? ageMs : null,
          }),
        );
        const message: JobMessage = { type: "agent-regate-sweep", requestedBy: "schedule", repoFullName: repo.fullName, installationId: repo.installationId };
        await env.JOBS.send(message).catch((error) => {
          console.error(JSON.stringify({ level: "error", event: "sweep_liveness_reenqueue_failed", repository: repo.fullName, error: errorMessage(error) }));
        });
      } catch (error) {
        console.error(JSON.stringify({ level: "error", event: "sweep_liveness_repo_error", repository: repo.fullName, message: errorMessage(error).slice(0, 200) }));
      }
    }
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "sweep_liveness_error", message: errorMessage(error).slice(0, 200) }));
  }
  return found;
}
