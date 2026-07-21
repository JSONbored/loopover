// Self-heal (flag-gated by LOOPOVER_ACTIVE_REVIEW_RECONCILIATION). An active_review_tracking row can be left
// stuck in `status: "active"` forever when a delayed webhook job (queue backpressure) restarts tracking for a
// PR that has, in the interim, actually already closed/merged on GitHub -- upsertPullRequestFromGitHub's
// out-of-order-webhook guard (#webhook-reorder-clobber, src/db/repositories.ts) closes the WRITE-side half of
// this race, but cannot help a row that got orphaned before that guard existed, or by some other race this
// guard doesn't cover. This module is the READ-side self-heal: periodically re-check every stale `active` row
// against LIVE (non-cached) GitHub state and terminalize the ones GitHub confirms are actually closed.
//
// Default OFF (like every other convergence capability) -- flag-OFF this module is never invoked and the cron
// enqueues no reconciliation job, byte-identical to today.

import { githubRateLimitAdmissionKeyForToken } from "../github/client";
import { createInstallationToken } from "../github/app";
import { fetchLivePullRequestState } from "../github/backfill";
import { getRepository, listStaleActiveReviewTracking, terminalizeActiveReviewTracking } from "../db/repositories";
import { loadRepoFocusManifest } from "../signals/focus-manifest-loader";
import { resolveLoopOverSelfRepoFullName } from "../config/loopover-repo-focus-manifest";
import { incr } from "../selfhost/metrics";
import { errorMessage } from "../utils/json";

/** How old an `active` row must be before this sweep will even consider it. A review that's merely slow (a big
 *  diff, a loaded AI backend) is not a bug -- only a row active far longer than any real review pass takes is
 *  worth spending a live GitHub call to check. */
export const STALE_ACTIVE_REVIEW_MIN_AGE_MS = 15 * 60_000;

/** A manifest-sourced enable override (#webhook-reorder-clobber) -- the top-level `activeReviewReconciliation`
 *  block of the loopover self-repo's `.loopover.yml` (see FocusManifestActiveReviewReconciliationConfig).
 *  `present: false` means "no override configured", not "disabled" -- the caller falls through to the env var.
 *  Mirrors PrReconciliationManifestOverride exactly. */
export type ActiveReviewReconciliationManifestOverride = { present: boolean; enabled: boolean };

/** True when the active-review-tracking reconciliation sweep is enabled. Config-as-code (#webhook-reorder-
 *  clobber): a present top-level `activeReviewReconciliation` manifest block on the loopover self-repo wins
 *  outright; otherwise falls back to the LOOPOVER_ACTIVE_REVIEW_RECONCILIATION env flag (default OFF).
 *  Flag-OFF (default) → the caller never invokes the sweep, so the cron enqueues no reconciliation job and the
 *  queue processor no-ops on a stale in-flight one. */
export function isActiveReviewReconciliationEnabled(
  env: { LOOPOVER_ACTIVE_REVIEW_RECONCILIATION?: string | undefined },
  manifestOverride?: ActiveReviewReconciliationManifestOverride | undefined,
): boolean {
  if (manifestOverride?.present) return manifestOverride.enabled;
  return /^(1|true|yes|on)$/i.test((env.LOOPOVER_ACTIVE_REVIEW_RECONCILIATION ?? "").trim());
}

// Short in-isolate TTL cache for resolveActiveReviewReconciliationManifestOverride, mirroring
// pr-reconciliation.ts / ops-wire.ts / sweep-watchdog.ts: fleet-wide self-repo override, single slot, 60s TTL.
const ACTIVE_REVIEW_RECONCILIATION_MANIFEST_OVERRIDE_CACHE_TTL_MS = 60_000;
let activeReviewReconciliationManifestOverrideCache: { override: ActiveReviewReconciliationManifestOverride; at: number } | null = null;

/**
 * Config-as-code override lookup (#webhook-reorder-clobber): read the top-level `activeReviewReconciliation`
 * block off the loopover self-repo's `.loopover.yml`. A manifest load failure degrades to `{ present: false }`
 * so a hiccup can never accidentally enable or disable the sweep.
 */
export async function resolveActiveReviewReconciliationManifestOverride(env: Env, nowMs: number = Date.now()): Promise<ActiveReviewReconciliationManifestOverride> {
  const hit = activeReviewReconciliationManifestOverrideCache;
  if (hit && nowMs - hit.at < ACTIVE_REVIEW_RECONCILIATION_MANIFEST_OVERRIDE_CACHE_TTL_MS) return hit.override;
  try {
    const manifest = await loadRepoFocusManifest(env, resolveLoopOverSelfRepoFullName(env));
    const config = manifest.activeReviewReconciliation;
    const override = { present: config.present, enabled: config.enabled };
    activeReviewReconciliationManifestOverrideCache = { override, at: nowMs };
    return override;
  } catch (error) {
    console.warn(JSON.stringify({ event: "active_review_reconciliation_manifest_override_error", message: errorMessage(error).slice(0, 200) }));
    const override = { present: false, enabled: false };
    activeReviewReconciliationManifestOverrideCache = { override, at: nowMs };
    return override;
  }
}

/** Test-only: clears the cached override, mirroring clearPrReconciliationManifestOverrideCacheForTest. */
export function clearActiveReviewReconciliationManifestOverrideCacheForTest(): void {
  activeReviewReconciliationManifestOverrideCache = null;
}

export interface ReconciledActiveReview {
  repoFullName: string;
  pullNumber: number;
}

/**
 * The reconciliation scan, run on the cron tick. FAILS SAFE: a per-row error is logged and the scan continues;
 * a top-level error is swallowed (this is best-effort self-heal, never a reason to fail the queue). Only
 * terminalizes a row when a LIVE (non-cached) GitHub read confirms the PR is no longer open -- never on age
 * alone, so a genuinely slow review is never force-closed; a repo with no installation, or a live check that
 * itself fails, leaves the row untouched for the next tick to retry.
 *
 * Caller MUST gate this on {@link isActiveReviewReconciliationEnabled} -- it is invoked only from the flag-ON
 * cron path, so flag-OFF this function is never reached and the cron does zero new work.
 */
export async function runActiveReviewReconciliation(env: Env, nowMs: number = Date.now()): Promise<ReconciledActiveReview[]> {
  const reconciled: ReconciledActiveReview[] = [];
  try {
    const cutoff = new Date(nowMs - STALE_ACTIVE_REVIEW_MIN_AGE_MS).toISOString();
    const staleRows = await listStaleActiveReviewTracking(env, cutoff);
    for (const row of staleRows) {
      try {
        const repo = await getRepository(env, row.repoFullName);
        if (!repo || typeof repo.installationId !== "number") continue;
        // Per-repo opt-out (#webhook-reorder-clobber): mirrors pr-reconciliation.ts's watchedRepos() FORCE-OFF
        // exactly -- an explicit per-repo `review.activeReviewReconciliation: false` excludes just this repo's
        // rows from the sweep even though the fleet-wide gate is on. A manifest-load error fails OPEN (the
        // row stays eligible), matching the surrounding scan's own settings-blip fail-safe.
        const manifest = await loadRepoFocusManifest(env, row.repoFullName).catch(() => null);
        if (manifest?.review.activeReviewReconciliation === false) continue;
        const token = (await createInstallationToken(env, repo.installationId).catch(() => undefined)) ?? env.GITHUB_PUBLIC_TOKEN;
        const admissionKey = githubRateLimitAdmissionKeyForToken(env, token, repo.installationId);
        const liveState = await fetchLivePullRequestState(env, row.repoFullName, row.pullNumber, token, admissionKey);
        if (liveState !== "closed") continue; // still open, or the live check itself failed -- leave it for the next tick
        const changed = await terminalizeActiveReviewTracking(env, row.repoFullName, row.pullNumber);
        if (!changed) continue; // a concurrent pass already terminalized (or restarted) this row first
        reconciled.push({ repoFullName: row.repoFullName, pullNumber: row.pullNumber });
        incr("loopover_active_review_reconciliation_terminalized_total", { repo: row.repoFullName });
        console.error(
          JSON.stringify({
            level: "error",
            event: "active_review_reconciliation_orphan_terminalized",
            repository: row.repoFullName,
            pullNumber: row.pullNumber,
            startedAt: row.startedAt,
          }),
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "active_review_reconciliation_row_error",
            repository: row.repoFullName,
            pullNumber: row.pullNumber,
            message: errorMessage(error).slice(0, 200),
          }),
        );
      }
    }
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "active_review_reconciliation_error", message: errorMessage(error).slice(0, 200) }));
  }
  return reconciled;
}
