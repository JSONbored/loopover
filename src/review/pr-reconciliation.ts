// Self-heal (flag-gated by LOOPOVER_PR_RECONCILIATION). A "PR opened" webhook that silently vanishes (no
// error, no audit event, no trace anywhere — see reconcileOpenPullRequests's doc comment for the 2026-07-06
// incident that motivated this) previously wasn't caught until backfillRegisteredRepositories's opportunistic
// resync, which skips any repo whose sync is "fresh" (up to 6 hours). This module runs a much tighter, dedicated
// reconciliation on its own short cron cadence: list-diff GitHub's open PR numbers against the local table for
// every acting-autonomy repo, and for any number GitHub has that the local table doesn't, immediately catch it
// up (fetch full details, upsert, and enqueue a normal regate — the SAME pipeline a real webhook would have fed).
//
// Default OFF (like every other convergence capability) — flag-OFF this module is never invoked and the cron
// enqueues no reconciliation job, byte-identical to today.

import { githubRateLimitAdmissionKeyForToken } from "../github/client";
import { resolveConfiguredRepoCandidates } from "./configured-repo-set";
import { createInstallationToken } from "../github/app";
import { fetchLivePullRequest, reconcileOpenPullRequests } from "../github/backfill";
import { upsertPullRequestFromGitHub } from "../db/repositories";
import { isAgentConfigured } from "../settings/autonomy";
import { resolveRepositorySettings } from "../settings/repository-settings";
import { loadRepoFocusManifest } from "../signals/focus-manifest-loader";
import { resolveLoopOverSelfRepoFullName } from "../config/loopover-repo-focus-manifest";
import { incr } from "../selfhost/metrics";
import type { JobMessage } from "../types";
import { errorMessage } from "../utils/json";
import { isConvergenceRepoAllowed } from "./cutover-gate";
import { deliveryIdFor } from "../queue/delivery-id";

/** A manifest-sourced enable override (#6558 / #6275) -- the top-level `prReconciliation` block of the
 *  loopover self-repo's `.loopover.yml` (see FocusManifestPrReconciliationConfig). Distinct from the
 *  per-repo FORCE-OFF under `review.prReconciliation`. `present: false` means "no override configured",
 *  not "disabled" -- the caller falls through to the env var. Mirrors OpsManifestOverride. */
export type PrReconciliationManifestOverride = { present: boolean; enabled: boolean };

/** True when fast open-PR reconciliation is enabled. Config-as-code (#6558 / #6275): a present top-level
 *  `prReconciliation` manifest block on the loopover self-repo wins outright; otherwise falls back to the
 *  LOOPOVER_PR_RECONCILIATION env flag (default OFF). Flag-OFF (default) → the caller never invokes it, so
 *  the cron enqueues no reconciliation job and the queue processor no-ops on a stale in-flight one. */
export function isPrReconciliationEnabled(
  env: { LOOPOVER_PR_RECONCILIATION?: string | undefined },
  manifestOverride?: PrReconciliationManifestOverride | undefined,
): boolean {
  if (manifestOverride?.present) return manifestOverride.enabled;
  return /^(1|true|yes|on)$/i.test((env.LOOPOVER_PR_RECONCILIATION ?? "").trim());
}

// Short in-isolate TTL cache for resolvePrReconciliationManifestOverride, mirroring ops-wire.ts /
// sweep-watchdog.ts: fleet-wide self-repo override, single slot, 60s TTL.
const PR_RECONCILIATION_MANIFEST_OVERRIDE_CACHE_TTL_MS = 60_000;
let prReconciliationManifestOverrideCache: { override: PrReconciliationManifestOverride; at: number } | null = null;

/**
 * Config-as-code override lookup (#6558 / #6275): read the top-level `prReconciliation` block off the
 * loopover self-repo's `.loopover.yml`. A manifest load failure degrades to `{ present: false }` so a
 * hiccup can never accidentally enable or disable reconciliation.
 */
export async function resolvePrReconciliationManifestOverride(env: Env, nowMs: number = Date.now()): Promise<PrReconciliationManifestOverride> {
  const hit = prReconciliationManifestOverrideCache;
  if (hit && nowMs - hit.at < PR_RECONCILIATION_MANIFEST_OVERRIDE_CACHE_TTL_MS) return hit.override;
  try {
    const manifest = await loadRepoFocusManifest(env, resolveLoopOverSelfRepoFullName(env));
    const config = manifest.prReconciliation;
    const override = { present: config.present, enabled: config.enabled };
    prReconciliationManifestOverrideCache = { override, at: nowMs };
    return override;
  } catch (error) {
    console.warn(JSON.stringify({ event: "pr_reconciliation_manifest_override_error", message: errorMessage(error).slice(0, 200) }));
    const override = { present: false, enabled: false };
    prReconciliationManifestOverrideCache = { override, at: nowMs };
    return override;
  }
}

/** Test-only: clears the cached override, mirroring clearOpsManifestOverrideCacheForTest. */
export function clearPrReconciliationManifestOverrideCacheForTest(): void {
  prReconciliationManifestOverrideCache = null;
}

/** The same acting-autonomy repo set fanOutAgentRegateSweepJobs sweeps (mirrors sweep-watchdog.ts's own copy of
 *  this selection) — this reconciliation only makes sense for repos loopover is actually reviewing.
 *
 *  Per-repo opt-out (#6275): mirrors `selftune-wire.ts`'s `selfTuneRepos` FORCE-OFF-ONLY shape exactly -- an
 *  explicit per-repo `.loopover.yml` `review.prReconciliation: false` excludes that one repo from the
 *  reconciliation scan even though it's otherwise watched. There is no `true` override: forcing a repo the
 *  scan wouldn't otherwise watch INTO it would bypass the separate convergence-allowlist / acting-autonomy
 *  consent boundary above, which this key must not touch. Unset (the default) changes nothing. A
 *  manifest-load error fails OPEN (the repo stays watched), matching the surrounding settings-blip fail-safe
 *  below -- a config-read failure must never silently exclude a repo from monitoring. */
async function watchedRepos(env: Env): Promise<Array<{ fullName: string; installationId?: number }>> {
  // #10170: the repo-set assembly was duplicated five times; callers keep their own eligibility rules.
  const repoCandidates = await resolveConfiguredRepoCandidates(env);
  const configured: Array<{ fullName: string; installationId?: number }> = [];
  for (const repo of repoCandidates) {
    try {
      const settings = await resolveRepositorySettings(env, repo.fullName);
      // #sweep-requires-installation: isAgentConfigured resolves the operator's global-default autonomy for
      // ANY repoFullName -- a repo that merely has a local row (no real GitHub App installation) would
      // otherwise inherit that default and look "agent-configured" purely by existing. Require a real
      // installation before the autonomy-based path counts; the explicit allowlist stays untouched.
      const hasInstallation = typeof repo.installationId === "number";
      const watched = isConvergenceRepoAllowed(env, repo.fullName) || (hasInstallation && isAgentConfigured(settings.autonomy));
      if (!watched) continue;
      const manifest = await loadRepoFocusManifest(env, repo.fullName).catch(() => null);
      if (manifest?.review.prReconciliation === false) continue; // explicit per-repo opt-out (#6275)
      configured.push(repo);
    } catch {
      /* a settings blip on one repo must not abort the whole reconciliation scan */
    }
  }
  return configured;
}

/** Catch up ONE missing PR number: fetch its full live payload, upsert it into the local table, and enqueue a
 *  normal regate — the exact pipeline a real "PR opened" webhook would have fed it into, so it gets reviewed,
 *  labeled, and gated exactly like any other PR. Best-effort: a fetch/upsert failure is logged and skipped (the
 *  next reconciliation tick retries it; it is not lost by this catch-up failing). */
async function catchUpMissingPullRequest(env: Env, repoFullName: string, installationId: number, prNumber: number): Promise<void> {
  try {
    const token = (await createInstallationToken(env, installationId).catch(() => undefined)) ?? env.GITHUB_PUBLIC_TOKEN;
    const admissionKey = githubRateLimitAdmissionKeyForToken(env, token, installationId);
    const live = await fetchLivePullRequest(env, repoFullName, prNumber, token, admissionKey);
    if (!live) {
      console.error(JSON.stringify({ level: "error", event: "open_pr_reconciliation_catch_up_fetch_failed", repository: repoFullName, prNumber }));
      return;
    }
    await upsertPullRequestFromGitHub(env, repoFullName, live);
    // #9499: prCreatedAt is what jobClaimSortKey uses to drain contributor work oldest-first. Omitting it
    // falls back to LEGACY_AGENT_REGATE_SORT_BASE_MS + prNumber (~9.5e11), which sorts AHEAD of every real
    // 2026 PR (~1.78e12) -- so a reconciliation job silently jumped the whole queue.
    const message: JobMessage = { type: "agent-regate-pr", deliveryId: deliveryIdFor("reconcile", `${repoFullName}#${prNumber}`), repoFullName, prNumber, installationId, prCreatedAt: live.created_at };
    await env.JOBS.send(message);
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "open_pr_reconciliation_catch_up_failed", repository: repoFullName, prNumber, message: errorMessage(error).slice(0, 200) }));
  }
}

export interface OpenPrDivergence {
  repoFullName: string;
  remoteOpenCount: number;
  localOpenCount: number;
  missingNumbers: number[];
}

/**
 * The reconciliation scan, run on the cron tick. FAILS SAFE: a per-repo error is logged and the scan continues;
 * a top-level error is swallowed (this is best-effort self-heal, never a reason to fail the queue). Only an
 * INSTALLED repo (installationId present) is reconciled — a registered-but-uninstalled repo never gets a per-PR
 * fan-out regardless (#sweep-uninstalled-budget-waste), so reconciling it would just spend the shared
 * GITHUB_PUBLIC_TOKEN budget with no actionable outcome. Returns the divergences found (for tests / a caller
 * that wants to inspect them further).
 *
 * Caller MUST gate this on {@link isPrReconciliationEnabled} — it is invoked only from the flag-ON cron path, so
 * flag-OFF this function is never reached and the cron does zero new work.
 */
export async function runOpenPrReconciliation(env: Env): Promise<OpenPrDivergence[]> {
  const found: OpenPrDivergence[] = [];
  try {
    const repos = await watchedRepos(env);
    for (const repo of repos) {
      try {
        if (typeof repo.installationId !== "number") continue;
        const result = await reconcileOpenPullRequests(env, repo.fullName);
        if (result.missingNumbers.length === 0) continue;
        found.push({ repoFullName: repo.fullName, remoteOpenCount: result.remoteOpenCount, localOpenCount: result.localOpenCount, missingNumbers: result.missingNumbers });
        incr("loopover_open_pr_reconciliation_missing_total", { repo: repo.fullName }, result.missingNumbers.length);
        console.error(
          JSON.stringify({
            level: "error",
            event: "open_pr_reconciliation_divergence",
            repository: repo.fullName,
            remoteOpenCount: result.remoteOpenCount,
            localOpenCount: result.localOpenCount,
            missingNumbers: result.missingNumbers,
          }),
        );
        for (const prNumber of result.missingNumbers) await catchUpMissingPullRequest(env, repo.fullName, repo.installationId, prNumber);
      } catch (error) {
        console.error(JSON.stringify({ level: "error", event: "open_pr_reconciliation_repo_error", repository: repo.fullName, message: errorMessage(error).slice(0, 200) }));
      }
    }
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "open_pr_reconciliation_error", message: errorMessage(error).slice(0, 200) }));
  }
  return found;
}
