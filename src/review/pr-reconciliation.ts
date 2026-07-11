// Self-heal (flag-gated by GITTENSORY_PR_RECONCILIATION). A "PR opened" webhook that silently vanishes (no
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
import { createInstallationToken } from "../github/app";
import { fetchLivePullRequest, reconcileOpenPullRequests } from "../github/backfill";
import { getRepository, listRepositories, upsertPullRequestFromGitHub } from "../db/repositories";
import { isAgentConfigured } from "../settings/autonomy";
import { resolveRepositorySettings } from "../settings/repository-settings";
import { incr } from "../selfhost/metrics";
import type { JobMessage } from "../types";
import { errorMessage } from "../utils/json";
import { isConvergenceRepoAllowed, listConvergenceRepos } from "./cutover-gate";

/** True when fast open-PR reconciliation is enabled. Flag-OFF (default) → the caller never invokes it, so the
 *  cron enqueues no reconciliation job and the queue processor no-ops on a stale in-flight one. */
export function isPrReconciliationEnabled(env: { GITTENSORY_PR_RECONCILIATION?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test(env.GITTENSORY_PR_RECONCILIATION ?? "");
}

/** The same acting-autonomy repo set fanOutAgentRegateSweepJobs sweeps (mirrors sweep-watchdog.ts's own copy of
 *  this selection) — this reconciliation only makes sense for repos gittensory is actually reviewing. */
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
      // #sweep-requires-installation: isAgentConfigured resolves the operator's global-default autonomy for
      // ANY repoFullName -- a repo that merely has a local row (no real GitHub App installation) would
      // otherwise inherit that default and look "agent-configured" purely by existing. Require a real
      // installation before the autonomy-based path counts; the explicit allowlist stays untouched.
      const hasInstallation = typeof repo.installationId === "number";
      if (isConvergenceRepoAllowed(env, repo.fullName) || (hasInstallation && isAgentConfigured(settings.autonomy))) configured.push(repo);
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
    const message: JobMessage = { type: "agent-regate-pr", deliveryId: `reconcile:${repoFullName}#${prNumber}`, repoFullName, prNumber, installationId };
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
        incr("gittensory_open_pr_reconciliation_missing_total", { repo: repo.fullName }, result.missingNumbers.length);
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
