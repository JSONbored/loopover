// Shared "refresh one repo's docs" runner (#3003, part of the repo-doc generation roadmap #2993) -- used by
// BOTH the scheduled sweep (src/queue/processors.ts) and the on-demand MCP trigger (src/mcp/server.ts), so
// there is exactly ONE code path deciding mode/eligibility/diffing (all of which already live inside
// openRepoDocPullRequest itself, per #3000/#3002/#3004/#3001) rather than two diverging ones.
//
// This module also owns the "last attempted at" marker the scheduled sweep uses to rate-limit re-checks
// (src/review/repo-doc-refresh-schedule.ts's isRepoDocRefreshDue), reusing the EXISTING generic signal-snapshot
// table (persistSignalSnapshot/listSignalSnapshots) rather than a new migration -- there is no DB column for
// this, matching #3002's own "manifest-only, no DB layer" precedent for this whole feature. The marker is
// recorded here (not in the sweep itself) so a MANUAL trigger also resets that clock, keeping the sweep from
// immediately re-checking a repo an operator just refreshed by hand.
import { getRepository, getRepositorySettings, listLatestSignalSnapshotsForTargets, listSignalSnapshots, persistSignalSnapshot } from "../db/repositories";
import { resolveRepoActionMode } from "./client";
import { openRepoDocPullRequest, type RepoDocPullRequestResult } from "./repo-doc-pr";
import { nowIso } from "../utils/json";
import type { SignalSnapshotRecord } from "../types";

const REPO_DOC_REFRESH_ATTEMPT_SIGNAL_TYPE = "repo-doc-refresh-attempt";

/** When repo-doc generation was last ATTEMPTED for this repo (scheduled or manual), or `null` if never. Fed
 *  into isRepoDocRefreshDue by the scheduled sweep's fan-out to decide whether to even enqueue a per-repo job. */
export async function getLastRepoDocRefreshAttemptedAt(env: Env, repoFullName: string): Promise<string | null> {
  const snapshots = await listSignalSnapshots(env, REPO_DOC_REFRESH_ATTEMPT_SIGNAL_TYPE, repoFullName);
  return snapshots[0]?.generatedAt ?? null;
}

/** Bulk variant for the sweep's fan-out (#3202 review finding): one round trip for every candidate repo
 *  instead of one `getLastRepoDocRefreshAttemptedAt` call per repo. Keyed by the exact `repoFullName` string
 *  passed in, same casing convention as the single-repo lookup above. A repo absent from the returned map has
 *  never been attempted -- callers should read `.get(repoFullName)?.generatedAt ?? null`, same pattern as the
 *  single-repo lookup above. */
export async function getLastRepoDocRefreshAttemptedAtBulk(env: Env, repoFullNames: readonly string[]): Promise<Map<string, SignalSnapshotRecord>> {
  return listLatestSignalSnapshotsForTargets(env, REPO_DOC_REFRESH_ATTEMPT_SIGNAL_TYPE, repoFullNames);
}

async function recordRepoDocRefreshAttempt(env: Env, repoFullName: string): Promise<void> {
  await persistSignalSnapshot(env, {
    id: crypto.randomUUID(),
    signalType: REPO_DOC_REFRESH_ATTEMPT_SIGNAL_TYPE,
    targetKey: repoFullName,
    repoFullName,
    payload: {},
    generatedAt: nowIso(),
  });
}

/**
 * Refresh one repo's AGENTS.md/CLAUDE.md (and skill file, when applicable) -- resolves the repo's action mode
 * the same way other scheduled writers do (resolveRepoActionMode), calls openRepoDocPullRequest (the single
 * source of truth for enable/scope/eligibility/diffing), and records that a refresh was ATTEMPTED regardless
 * of outcome (opened, skipped, or an internal failure -- openRepoDocPullRequest never throws), so the
 * scheduled sweep doesn't re-check this repo again until its own configured interval elapses.
 */
export async function performRepoDocRefresh(env: Env, repoFullName: string): Promise<RepoDocPullRequestResult> {
  const repository = await getRepository(env, repoFullName);
  const canonicalRepoFullName = repository?.fullName ?? repoFullName;
  const settings = await getRepositorySettings(env, canonicalRepoFullName);
  const mode = await resolveRepoActionMode(env, settings);
  const result = await openRepoDocPullRequest(env, canonicalRepoFullName, mode);
  await recordRepoDocRefreshAttempt(env, canonicalRepoFullName);
  return result;
}
