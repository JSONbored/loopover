// Self-heal (flag-gated by GITTENSORY_SWEEP_WATCHDOG). The scheduled regate sweep (fanOutAgentRegateSweepJobs /
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

import { countOpenPullRequests, getLatestRegatedAt, listRepositories } from "../db/repositories";
import { isAgentConfigured } from "../settings/autonomy";
import { resolveRepositorySettings } from "../settings/repository-settings";
import type { JobMessage } from "../types";
import { errorMessage, nowIso } from "../utils/json";
import { isConvergenceRepoAllowed, listConvergenceRepos } from "./cutover-gate";

/** True when the sweep-liveness watchdog is enabled. Flag-OFF (default) → the caller never invokes it, so the
 *  cron enqueues no watchdog job and the queue processor no-ops on a stale in-flight one (defense-in-depth,
 *  mirrors isOpsEnabled). */
export function isSweepWatchdogEnabled(env: { GITTENSORY_SWEEP_WATCHDOG?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test(env.GITTENSORY_SWEEP_WATCHDOG ?? "");
}

/** A repo's sweep is stale when it has open PRs to regate but its last-regated marker either never advanced or
 *  hasn't advanced within the staleness window. A repo with NO open PRs is never stale — there is nothing for
 *  the sweep to do, so a `null` marker there means "nothing to regate," not "the sweep stopped working." */
export const SWEEP_STALENESS_THRESHOLD_MS = 45 * 60 * 1000;

export function isSweepStale(input: { openPullRequestCount: number; lastRegatedAt: string | null; nowMs: number }): boolean {
  if (input.openPullRequestCount === 0) return false;
  const lastMs = input.lastRegatedAt ? Date.parse(input.lastRegatedAt) : NaN;
  if (!Number.isFinite(lastMs)) return true;
  return input.nowMs - lastMs > SWEEP_STALENESS_THRESHOLD_MS;
}

/** The same acting-autonomy repo set fanOutAgentRegateSweepJobs sweeps: the convergence allowlist
 *  (LOOPOVER_REVIEW_REPOS) union the webhook-registered repos with acting autonomy, deduped case-insensitively.
 *  Deliberately mirrors that function's own selection so the watchdog can never watch a DIFFERENT set of repos
 *  than the sweep actually covers. */
async function watchedRepos(env: Env): Promise<Array<{ fullName: string; installationId?: number }>> {
  const repositoriesByKey = new Map((await listRepositories(env)).map((repo) => [repo.fullName.toLowerCase(), repo]));
  const byKey = new Map<string, { fullName: string; installationId?: number }>();
  for (const repo of repositoriesByKey.values())
    byKey.set(repo.fullName.toLowerCase(), { fullName: repo.fullName, ...(typeof repo.installationId === "number" ? { installationId: repo.installationId } : {}) });
  for (const fullName of listConvergenceRepos(env)) {
    const repo = repositoriesByKey.get(fullName.toLowerCase());
    byKey.set(fullName.toLowerCase(), {
      fullName,
      ...(typeof repo?.installationId === "number" ? { installationId: repo.installationId } : {}),
    });
  }
  const configured: Array<{ fullName: string; installationId?: number }> = [];
  for (const repo of byKey.values()) {
    try {
      const settings = await resolveRepositorySettings(env, repo.fullName);
      // #sweep-requires-installation: mirrors fanOutAgentRegateSweepJobs's own guard -- a repo with no real
      // GitHub App installation must never be treated as agent-configured purely because it resolves the
      // operator's global-default autonomy by merely having a local row.
      const hasInstallation = typeof repo.installationId === "number";
      if (isConvergenceRepoAllowed(env, repo.fullName) || (hasInstallation && isAgentConfigured(settings.autonomy))) configured.push(repo);
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
export async function runSweepLivenessWatchdog(env: Env): Promise<StaleSweepRepo[]> {
  const found: StaleSweepRepo[] = [];
  const nowMs = Date.parse(nowIso());
  try {
    const repos = await watchedRepos(env);
    for (const repo of repos) {
      try {
        if (typeof repo.installationId !== "number") continue;
        const [openPullRequestCount, lastRegatedAt] = await Promise.all([countOpenPullRequests(env, repo.fullName), getLatestRegatedAt(env, repo.fullName)]);
        if (!isSweepStale({ openPullRequestCount, lastRegatedAt, nowMs })) continue;
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
