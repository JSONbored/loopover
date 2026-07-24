// #repo-rename-migration: GitHub identifies a repository by a stable numeric id, but this schema keys
// almost everything off the full_name STRING (repositories.full_name is itself the primary key, and
// most other tables carry a plain repo_full_name column with no foreign-key cascade). A GitHub repo
// rename webhook carries the SAME installation and the new current full_name, but nothing here
// recognizes it as the same repo -- upsertRepositoryFromGitHub's onConflictDoUpdate keys on full_name,
// so the very next webhook after a rename creates a second, disconnected row instead of updating the
// existing one, silently orphaning every PR/issue/audit-trail row already recorded under the old name.
//
// This module is the fix: renameRepositoryIdentity walks every repo-identity-bearing table and moves
// the old name's rows forward to the new name, so a rename preserves history instead of forking it.
// Idempotent (safe to re-run for a redelivered webhook -- every step only touches rows still under
// oldFullName) and collision-safe (where a unique constraint exists, a row that already exists under
// newFullName -- e.g. from a webhook that slipped in under the new name before this ran -- is folded
// away in favor of the pre-existing oldFullName row, never the reverse, so history is never dropped).
//
// Deliberately narrow in scope: only structural identity columns (the ones that determine which repo a
// row belongs to, or serve as part of a primary/unique key) are touched. Free-text content (titles,
// summaries, audit detail), *_json snapshots, and URL columns are left as an accurate historical record
// of what was true when they were captured -- GitHub's own redirect keeps old html_url values working,
// and rewriting historical text/audit content is not what this fix is for.
//
// One explicit block per table, deliberately not a generic cross-table helper: Drizzle's table/column
// types don't generalize cleanly across tables with different secondary keys, and this codebase's own
// convention (repositories.ts) is explicit per-table queries throughout, not a shared query abstraction.
// New tables extend this function directly, following the same shape.
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "./client";
import {
  activeReviewTracking,
  advisories,
  agentPendingActions,
  auditEvents,
  bounties,
  burdenForecasts,
  checkSummaries,
  collisionEdges,
  contributorRepoStats,
  gateOutcomes,
  githubAgentCommandAnswers,
  githubAgentCommandFeedback,
  githubRateLimitObservations,
  issues,
  issueWatchSubscriptions,
  notificationDeliveries,
  productUsageEvents,
  pullRequestDetailSyncState,
  pullRequestFiles,
  pullRequestReviews,
  pullRequests,
  recentMergedPullRequests,
  repoGithubTotalsSnapshots,
  repoLabels,
  repoQueueTrendSnapshots,
  repositories,
  repositoryAiKeys,
  repositoryLinearKeys,
  repositorySettings,
  repoSnapshots,
  reviewSuppression,
  repoSyncSegments,
  repoSyncState,
  signalSnapshots,
} from "./schema";

function repoParts(fullName: string): { owner: string; name: string } {
  const slash = fullName.indexOf("/");
  return slash === -1 ? { owner: fullName, name: fullName } : { owner: fullName.slice(0, slash), name: fullName.slice(slash + 1) };
}

/**
 * Renames a repository's identity across every structural repo-identity column this module covers so
 * far. Call this BEFORE the normal upsertRepositoryFromGitHub(env, payload.repository, ...) call that
 * every webhook triggers -- once the anchor `repositories` row is renamed, that upsert correctly UPDATEs
 * it instead of inserting a fresh duplicate. A no-op when oldFullName === newFullName.
 */
export async function renameRepositoryIdentity(env: Env, oldFullName: string, newFullName: string): Promise<void> {
  if (oldFullName === newFullName) return;
  const db = getDb(env.DB);
  const { owner, name } = repoParts(newFullName);

  // repositories (PK: full_name alone) -- fold a stray new-name row first, then rename the anchor row.
  await db.delete(repositories).where(eq(repositories.fullName, newFullName));
  await db
    .update(repositories)
    .set({
      fullName: newFullName,
      owner,
      name,
      htmlUrl: sql`replace(${repositories.htmlUrl}, ${oldFullName}, ${newFullName})`,
    })
    .where(eq(repositories.fullName, oldFullName));

  // repositorySettings (PK: repo_full_name alone) -- same fold-then-rename shape.
  await db.delete(repositorySettings).where(eq(repositorySettings.repoFullName, newFullName));
  await db.update(repositorySettings).set({ repoFullName: newFullName }).where(eq(repositorySettings.repoFullName, oldFullName));

  // pullRequests: unique (repo_full_name, number) -- fold any new-name row whose number already exists
  // under the old name, favoring the pre-existing (oldFullName) row's history.
  const collidingPullNumbers = (
    await db.select({ number: pullRequests.number }).from(pullRequests).where(eq(pullRequests.repoFullName, oldFullName))
  ).map((row) => row.number);
  if (collidingPullNumbers.length > 0) {
    await db.delete(pullRequests).where(and(eq(pullRequests.repoFullName, newFullName), inArray(pullRequests.number, collidingPullNumbers)));
  }
  await db
    .update(pullRequests)
    .set({
      repoFullName: newFullName,
      id: sql`replace(${pullRequests.id}, ${oldFullName}, ${newFullName})`,
      htmlUrl: sql`replace(${pullRequests.htmlUrl}, ${oldFullName}, ${newFullName})`,
    })
    .where(eq(pullRequests.repoFullName, oldFullName));

  // issues: same shape as pullRequests -- unique (repo_full_name, number).
  const collidingIssueNumbers = (
    await db.select({ number: issues.number }).from(issues).where(eq(issues.repoFullName, oldFullName))
  ).map((row) => row.number);
  if (collidingIssueNumbers.length > 0) {
    await db.delete(issues).where(and(eq(issues.repoFullName, newFullName), inArray(issues.number, collidingIssueNumbers)));
  }
  await db
    .update(issues)
    .set({
      repoFullName: newFullName,
      id: sql`replace(${issues.id}, ${oldFullName}, ${newFullName})`,
      htmlUrl: sql`replace(${issues.htmlUrl}, ${oldFullName}, ${newFullName})`,
    })
    .where(eq(issues.repoFullName, oldFullName));

  // gateOutcomes: unique (repo_full_name, pull_number) -- same fold-then-rename shape as pullRequests/issues.
  const collidingGateOutcomePulls = (
    await db.select({ pullNumber: gateOutcomes.pullNumber }).from(gateOutcomes).where(eq(gateOutcomes.repoFullName, oldFullName))
  ).map((row) => row.pullNumber);
  if (collidingGateOutcomePulls.length > 0) {
    await db.delete(gateOutcomes).where(and(eq(gateOutcomes.repoFullName, newFullName), inArray(gateOutcomes.pullNumber, collidingGateOutcomePulls)));
  }
  await db
    .update(gateOutcomes)
    .set({ repoFullName: newFullName, id: sql`replace(${gateOutcomes.id}, ${oldFullName}, ${newFullName})` })
    .where(eq(gateOutcomes.repoFullName, oldFullName));

  // activeReviewTracking: unique (repo_full_name, pull_number) -- same shape.
  const collidingActiveReviewPulls = (
    await db.select({ pullNumber: activeReviewTracking.pullNumber }).from(activeReviewTracking).where(eq(activeReviewTracking.repoFullName, oldFullName))
  ).map((row) => row.pullNumber);
  if (collidingActiveReviewPulls.length > 0) {
    await db
      .delete(activeReviewTracking)
      .where(and(eq(activeReviewTracking.repoFullName, newFullName), inArray(activeReviewTracking.pullNumber, collidingActiveReviewPulls)));
  }
  await db
    .update(activeReviewTracking)
    .set({ repoFullName: newFullName, id: sql`replace(${activeReviewTracking.id}, ${oldFullName}, ${newFullName})` })
    .where(eq(activeReviewTracking.repoFullName, oldFullName));

  // pullRequestDetailSyncState: unique (repo_full_name, pull_number) -- same shape.
  const collidingSyncStatePulls = (
    await db
      .select({ pullNumber: pullRequestDetailSyncState.pullNumber })
      .from(pullRequestDetailSyncState)
      .where(eq(pullRequestDetailSyncState.repoFullName, oldFullName))
  ).map((row) => row.pullNumber);
  if (collidingSyncStatePulls.length > 0) {
    await db
      .delete(pullRequestDetailSyncState)
      .where(and(eq(pullRequestDetailSyncState.repoFullName, newFullName), inArray(pullRequestDetailSyncState.pullNumber, collidingSyncStatePulls)));
  }
  await db
    .update(pullRequestDetailSyncState)
    .set({ repoFullName: newFullName, id: sql`replace(${pullRequestDetailSyncState.id}, ${oldFullName}, ${newFullName})` })
    .where(eq(pullRequestDetailSyncState.repoFullName, oldFullName));

  // recentMergedPullRequests: unique (repo_full_name, number) -- same shape as pullRequests.
  const collidingRecentMergedNumbers = (
    await db.select({ number: recentMergedPullRequests.number }).from(recentMergedPullRequests).where(eq(recentMergedPullRequests.repoFullName, oldFullName))
  ).map((row) => row.number);
  if (collidingRecentMergedNumbers.length > 0) {
    await db
      .delete(recentMergedPullRequests)
      .where(and(eq(recentMergedPullRequests.repoFullName, newFullName), inArray(recentMergedPullRequests.number, collidingRecentMergedNumbers)));
  }
  await db
    .update(recentMergedPullRequests)
    .set({
      repoFullName: newFullName,
      id: sql`replace(${recentMergedPullRequests.id}, ${oldFullName}, ${newFullName})`,
      htmlUrl: sql`replace(${recentMergedPullRequests.htmlUrl}, ${oldFullName}, ${newFullName})`,
    })
    .where(eq(recentMergedPullRequests.repoFullName, oldFullName));

  // pullRequestFiles: unique (repo_full_name, pull_number, path) -- a 3-column key, so the collision check
  // is per-(pullNumber, path) PAIR rather than a single-column inArray. Row counts here are small (a
  // rename is a rare, one-time event; a PR's file list is bounded), so one scoped delete per pair is simple
  // and dialect-portable rather than reaching for a raw composite-tuple IN clause.
  const collidingFileKeys = await db
    .select({ pullNumber: pullRequestFiles.pullNumber, path: pullRequestFiles.path })
    .from(pullRequestFiles)
    .where(eq(pullRequestFiles.repoFullName, oldFullName));
  for (const key of collidingFileKeys) {
    await db
      .delete(pullRequestFiles)
      .where(and(eq(pullRequestFiles.repoFullName, newFullName), eq(pullRequestFiles.pullNumber, key.pullNumber), eq(pullRequestFiles.path, key.path)));
  }
  await db
    .update(pullRequestFiles)
    .set({ repoFullName: newFullName, id: sql`replace(${pullRequestFiles.id}, ${oldFullName}, ${newFullName})` })
    .where(eq(pullRequestFiles.repoFullName, oldFullName));

  // checkSummaries: unique (repo_full_name, head_sha, name) -- same per-pair fold as pullRequestFiles above,
  // but head_sha is nullable, so the collision lookup branches on isNull vs eq per row instead of a single
  // eq() (SQL NULL never equals NULL via `=`).
  const collidingCheckKeys = await db
    .select({ headSha: checkSummaries.headSha, name: checkSummaries.name })
    .from(checkSummaries)
    .where(eq(checkSummaries.repoFullName, oldFullName));
  for (const key of collidingCheckKeys) {
    await db
      .delete(checkSummaries)
      .where(
        and(
          eq(checkSummaries.repoFullName, newFullName),
          key.headSha === null ? isNull(checkSummaries.headSha) : eq(checkSummaries.headSha, key.headSha),
          eq(checkSummaries.name, key.name),
        ),
      );
  }
  await db
    .update(checkSummaries)
    .set({ repoFullName: newFullName, id: sql`replace(${checkSummaries.id}, ${oldFullName}, ${newFullName})` })
    .where(eq(checkSummaries.repoFullName, oldFullName));

  // pullRequestReviews: no separate unique index (PK `id` alone) -- id is `${repoFullName}#${pullNumber}#
  // ${githubReviewId}` (github/backfill.ts), so the fold checks for a PK collision on the id the rename
  // would PRODUCE rather than a business-key tuple. GitHub review ids are globally unique, so this never
  // fires in practice; kept for defensive correctness rather than assuming that invariant holds forever.
  const oldReviewIds = (
    await db.select({ id: pullRequestReviews.id }).from(pullRequestReviews).where(eq(pullRequestReviews.repoFullName, oldFullName))
  ).map((row) => row.id);
  const renamedReviewIds = oldReviewIds.map((id) => id.split(oldFullName).join(newFullName));
  if (renamedReviewIds.length > 0) {
    await db.delete(pullRequestReviews).where(inArray(pullRequestReviews.id, renamedReviewIds));
  }
  await db
    .update(pullRequestReviews)
    .set({ repoFullName: newFullName, id: sql`replace(${pullRequestReviews.id}, ${oldFullName}, ${newFullName})` })
    .where(eq(pullRequestReviews.repoFullName, oldFullName));

  // advisories: `id` is a random UUID (never repo-derived) and there is no unique constraint on repo
  // columns, so this is a plain rename -- repoFullName plus the `targetKey` business identifier
  // (`${repoFullName}#${pullNumber|issueNumber|"unknown"}`, src/rules/advisory.ts), same LIKE+replace
  // shape as auditEvents.target_key below.
  await db
    .update(advisories)
    .set({ repoFullName: newFullName, targetKey: sql`replace(${advisories.targetKey}, ${oldFullName}, ${newFullName})` })
    .where(eq(advisories.repoFullName, oldFullName));

  // burdenForecasts: repo_full_name IS the primary key (single row per repo, upsert semantics) -- same
  // fold-then-rename shape as the repositories/repositorySettings anchor tables above.
  await db.delete(burdenForecasts).where(eq(burdenForecasts.repoFullName, newFullName));
  await db.update(burdenForecasts).set({ repoFullName: newFullName }).where(eq(burdenForecasts.repoFullName, oldFullName));

  // repoQueueTrendSnapshots: repo_full_name IS the primary key -- same shape. (Despite the "Snapshots" name
  // this is a single-row-per-repo upsert table, not an append-only log -- each upsert overwrites the prior row.)
  await db.delete(repoQueueTrendSnapshots).where(eq(repoQueueTrendSnapshots.repoFullName, newFullName));
  await db.update(repoQueueTrendSnapshots).set({ repoFullName: newFullName }).where(eq(repoQueueTrendSnapshots.repoFullName, oldFullName));

  // repoSyncState: repo_full_name IS the primary key -- same shape.
  await db.delete(repoSyncState).where(eq(repoSyncState.repoFullName, newFullName));
  await db.update(repoSyncState).set({ repoFullName: newFullName }).where(eq(repoSyncState.repoFullName, oldFullName));

  // repoSyncSegments: unique (repo_full_name, segment), id embeds the repo name (`${repoFullName}#${segment}`)
  // -- fold on the single `segment` column, same inArray shape as pullRequests/gateOutcomes above.
  const collidingSegments = (
    await db.select({ segment: repoSyncSegments.segment }).from(repoSyncSegments).where(eq(repoSyncSegments.repoFullName, oldFullName))
  ).map((row) => row.segment);
  if (collidingSegments.length > 0) {
    await db.delete(repoSyncSegments).where(and(eq(repoSyncSegments.repoFullName, newFullName), inArray(repoSyncSegments.segment, collidingSegments)));
  }
  await db
    .update(repoSyncSegments)
    .set({ repoFullName: newFullName, id: sql`replace(${repoSyncSegments.id}, ${oldFullName}, ${newFullName})` })
    .where(eq(repoSyncSegments.repoFullName, oldFullName));

  // contributorRepoStats: unique (login, repo_full_name), id embeds both (`${login}#${repoFullName}`) --
  // fold on the single `login` column (the OTHER half of the unique key besides repoFullName itself).
  const collidingLogins = (
    await db.select({ login: contributorRepoStats.login }).from(contributorRepoStats).where(eq(contributorRepoStats.repoFullName, oldFullName))
  ).map((row) => row.login);
  if (collidingLogins.length > 0) {
    await db.delete(contributorRepoStats).where(and(eq(contributorRepoStats.repoFullName, newFullName), inArray(contributorRepoStats.login, collidingLogins)));
  }
  await db
    .update(contributorRepoStats)
    .set({ repoFullName: newFullName, id: sql`replace(${contributorRepoStats.id}, ${oldFullName}, ${newFullName})` })
    .where(eq(contributorRepoStats.repoFullName, oldFullName));

  // repoLabels: unique (repo_full_name, name), id embeds the repo name (`${repoFullName}#${name.toLowerCase()}`)
  // -- fold on the single `name` column.
  const collidingLabelNames = (
    await db.select({ name: repoLabels.name }).from(repoLabels).where(eq(repoLabels.repoFullName, oldFullName))
  ).map((row) => row.name);
  if (collidingLabelNames.length > 0) {
    await db.delete(repoLabels).where(and(eq(repoLabels.repoFullName, newFullName), inArray(repoLabels.name, collidingLabelNames)));
  }
  await db
    .update(repoLabels)
    .set({ repoFullName: newFullName, id: sql`replace(${repoLabels.id}, ${oldFullName}, ${newFullName})` })
    .where(eq(repoLabels.repoFullName, oldFullName));

  // collisionEdges: id embeds the repo name (`${repoFullName}#${cluster.id}`) but is built in
  // packages/loopover-engine (buildCollisionEdges) and passed through verbatim by replaceCollisionEdges'
  // delete-then-insert -- no unique index exists here, so (like pullRequestReviews above) the fold checks
  // for a PK collision on the id the rename would PRODUCE rather than a business-key tuple.
  const oldCollisionEdgeIds = (
    await db.select({ id: collisionEdges.id }).from(collisionEdges).where(eq(collisionEdges.repoFullName, oldFullName))
  ).map((row) => row.id);
  const renamedCollisionEdgeIds = oldCollisionEdgeIds.map((id) => id.split(oldFullName).join(newFullName));
  if (renamedCollisionEdgeIds.length > 0) {
    await db.delete(collisionEdges).where(inArray(collisionEdges.id, renamedCollisionEdgeIds));
  }
  await db
    .update(collisionEdges)
    .set({ repoFullName: newFullName, id: sql`replace(${collisionEdges.id}, ${oldFullName}, ${newFullName})` })
    .where(eq(collisionEdges.repoFullName, oldFullName));

  // notificationDeliveries: id is a random UUID (never repo-derived); the only unique constraint is
  // (dedup_key, channel), columns entirely unrelated to repo_full_name, so renaming repo_full_name alone can
  // never produce a collision here -- a plain rename. deeplink is this row's own canonical "go look at this"
  // GitHub URL (github.com/{repoFullName}/...), the same kind of entity-owned link the anchor tables' own
  // html_url gets rewritten for above -- unlike a *_json snapshot or free-text body, it is structurally the
  // row's own address, not incidental content.
  await db
    .update(notificationDeliveries)
    .set({ repoFullName: newFullName, deeplink: sql`replace(${notificationDeliveries.deeplink}, ${oldFullName}, ${newFullName})` })
    .where(eq(notificationDeliveries.repoFullName, oldFullName));

  // githubAgentCommandAnswers: id is a random UUID; both indexes are non-unique, so a plain rename is safe.
  // responseUrl mirrors deeplink above -- the posted response comment's own GitHub html_url, nullable
  // (unset until a response comment is actually posted); replace() on a NULL column is a no-op NULL, not an
  // error, on both SQLite and Postgres.
  await db
    .update(githubAgentCommandAnswers)
    .set({ repoFullName: newFullName, responseUrl: sql`replace(${githubAgentCommandAnswers.responseUrl}, ${oldFullName}, ${newFullName})` })
    .where(eq(githubAgentCommandAnswers.repoFullName, oldFullName));

  // repoSnapshots: id is a random UUID; no index at all (not even non-unique) -- an append-only history
  // table where multiple rows legitimately share one repoFullName over time. Plain rename.
  await db.update(repoSnapshots).set({ repoFullName: newFullName }).where(eq(repoSnapshots.repoFullName, oldFullName));

  // repoGithubTotalsSnapshots: id is a random UUID; only a non-unique index exists. Plain rename.
  await db.update(repoGithubTotalsSnapshots).set({ repoFullName: newFullName }).where(eq(repoGithubTotalsSnapshots.repoFullName, oldFullName));

  // githubRateLimitObservations: id is a random UUID; repo_full_name is NULLABLE (null for app/installation-
  // level observations not scoped to any repo) and only non-unique indexes exist. Plain rename, scoped to
  // rows that actually carry the old name (a null column never matches the WHERE below).
  await db.update(githubRateLimitObservations).set({ repoFullName: newFullName }).where(eq(githubRateLimitObservations.repoFullName, oldFullName));

  // productUsageEvents: id is a random UUID; repo_full_name is NULLABLE (many product-usage events, e.g.
  // MCP-surface or generic UI actions, have no associated repo) and only non-unique indexes exist. Plain rename.
  await db.update(productUsageEvents).set({ repoFullName: newFullName }).where(eq(productUsageEvents.repoFullName, oldFullName));

  // signalSnapshots: id is a random UUID; repo_full_name is NULLABLE (contributor/global-scoped signals
  // carry no repo at all) and there is no index of any kind on this table. Plain rename.
  await db.update(signalSnapshots).set({ repoFullName: newFullName }).where(eq(signalSnapshots.repoFullName, oldFullName));

  // Seven more Drizzle-schema tables carrying a repo_full_name identity column with live writers (#8379),
  // each folded by its REAL constraint (verified in schema.ts), following the shapes already used above:

  // repositoryAiKeys / repositoryLinearKeys: `repo_full_name` is itself the PRIMARY KEY -- same
  // fold-then-rename anchor shape as repositories/repositorySettings above. Only the identity column moves;
  // the encrypted key material rides along untouched.
  await db.delete(repositoryAiKeys).where(eq(repositoryAiKeys.repoFullName, newFullName));
  await db.update(repositoryAiKeys).set({ repoFullName: newFullName }).where(eq(repositoryAiKeys.repoFullName, oldFullName));

  await db.delete(repositoryLinearKeys).where(eq(repositoryLinearKeys.repoFullName, newFullName));
  await db.update(repositoryLinearKeys).set({ repoFullName: newFullName }).where(eq(repositoryLinearKeys.repoFullName, oldFullName));

  // bounties: unique (repo_full_name, issue_number) -- fold on the other half, issue_number. `id` is an
  // EXTERNAL bounty id (String(issue.id) from the Gitt snapshot, src/bounties/ingest.ts), never derived from
  // the repo name, so unlike pullRequests/issues there is no id substring to rewrite.
  const collidingBountyIssues = (
    await db.select({ issueNumber: bounties.issueNumber }).from(bounties).where(eq(bounties.repoFullName, oldFullName))
  ).map((row) => row.issueNumber);
  if (collidingBountyIssues.length > 0) {
    await db.delete(bounties).where(and(eq(bounties.repoFullName, newFullName), inArray(bounties.issueNumber, collidingBountyIssues)));
  }
  await db.update(bounties).set({ repoFullName: newFullName }).where(eq(bounties.repoFullName, oldFullName));

  // reviewSuppression: unique (repo_full_name, category, path_glob, pattern_hash) -- per-tuple fold like
  // checkSummaries above, but every fold column is NOT NULL (schema.ts), so a plain eq() per column suffices
  // with no isNull branching.
  const collidingSuppressionKeys = await db
    .select({ category: reviewSuppression.category, pathGlob: reviewSuppression.pathGlob, patternHash: reviewSuppression.patternHash })
    .from(reviewSuppression)
    .where(eq(reviewSuppression.repoFullName, oldFullName));
  for (const key of collidingSuppressionKeys) {
    await db
      .delete(reviewSuppression)
      .where(
        and(
          eq(reviewSuppression.repoFullName, newFullName),
          eq(reviewSuppression.category, key.category),
          eq(reviewSuppression.pathGlob, key.pathGlob),
          eq(reviewSuppression.patternHash, key.patternHash),
        ),
      );
  }
  await db.update(reviewSuppression).set({ repoFullName: newFullName }).where(eq(reviewSuppression.repoFullName, oldFullName));

  // agentPendingActions: unique (repo_full_name, pull_number, action_class) -- same per-tuple fold, both
  // fold columns NOT NULL. A decided row is sticky, so folding in favor of the pre-existing oldFullName row
  // preserves the maintainer's actual accept/reject decision rather than a fresh post-rename `pending`.
  const collidingPendingActionKeys = await db
    .select({ pullNumber: agentPendingActions.pullNumber, actionClass: agentPendingActions.actionClass })
    .from(agentPendingActions)
    .where(eq(agentPendingActions.repoFullName, oldFullName));
  for (const key of collidingPendingActionKeys) {
    await db
      .delete(agentPendingActions)
      .where(
        and(
          eq(agentPendingActions.repoFullName, newFullName),
          eq(agentPendingActions.pullNumber, key.pullNumber),
          eq(agentPendingActions.actionClass, key.actionClass),
        ),
      );
  }
  await db.update(agentPendingActions).set({ repoFullName: newFullName }).where(eq(agentPendingActions.repoFullName, oldFullName));

  // issueWatchSubscriptions: unique (login, repo_full_name) -- fold on the single `login` column, the same
  // shape as contributorRepoStats above. `id` is a random UUID, so no id rewrite.
  const collidingWatchLogins = (
    await db.select({ login: issueWatchSubscriptions.login }).from(issueWatchSubscriptions).where(eq(issueWatchSubscriptions.repoFullName, oldFullName))
  ).map((row) => row.login);
  if (collidingWatchLogins.length > 0) {
    await db
      .delete(issueWatchSubscriptions)
      .where(and(eq(issueWatchSubscriptions.repoFullName, newFullName), inArray(issueWatchSubscriptions.login, collidingWatchLogins)));
  }
  await db.update(issueWatchSubscriptions).set({ repoFullName: newFullName }).where(eq(issueWatchSubscriptions.repoFullName, oldFullName));

  // githubAgentCommandFeedback: its only unique index is (answer_id, actor_hash) -- repo_full_name appears
  // solely in a NON-unique index, so nothing can collide. Plain rename, same as repoSnapshots above.
  await db.update(githubAgentCommandFeedback).set({ repoFullName: newFullName }).where(eq(githubAgentCommandFeedback.repoFullName, oldFullName));

  // REES/parity tables below (review_audit, contributor_gate_history, submitter_stats) are raw-SQL-only --
  // deliberately NOT added to the Drizzle schema (see each table's own migration header) -- so these three
  // blocks use env.DB.prepare() directly instead of the query builder, matching how every other writer of
  // these tables (parity-wire.ts, outcomes-wire.ts, contributor-calibration.ts, submitter-reputation.ts)
  // already accesses them.

  // reviewAudit: PK `id` alone (migrations/0049_review_audit_parity.sql), no separate unique index. `project`
  // IS the repo full name (verified live at both writers: parity-wire.ts's recordNativeGateDecision and
  // outcomes-wire.ts's appendReviewAudit); `target_id` is `${project}#${pullNumber}`, and `id` embeds
  // `target_id` (hence project) as a substring in every writer's own id-construction scheme. Same
  // PK-collision-only fold shape as pullRequestReviews/collisionEdges above -- no business-key unique index
  // exists to fold on instead.
  const oldReviewAuditIds = (
    await env.DB.prepare("SELECT id FROM review_audit WHERE project = ?").bind(oldFullName).all<{ id: string }>()
  ).results.map((row) => row.id);
  const renamedReviewAuditIds = oldReviewAuditIds.map((id) => id.split(oldFullName).join(newFullName));
  if (renamedReviewAuditIds.length > 0) {
    const placeholders = renamedReviewAuditIds.map(() => "?").join(",");
    await env.DB.prepare(`DELETE FROM review_audit WHERE id IN (${placeholders})`)
      .bind(...renamedReviewAuditIds)
      .run();
  }
  await env.DB.prepare("UPDATE review_audit SET id = replace(id, ?, ?), project = ?, target_id = replace(target_id, ?, ?) WHERE project = ?")
    .bind(oldFullName, newFullName, newFullName, oldFullName, newFullName, oldFullName)
    .run();

  // contributorGateHistory: same shape as reviewAudit -- PK `id` alone (migrations/0126_contributor_gate_
  // history.sql), `project` is the repo full name (verified live at its sole writer, contributor-
  // calibration.ts's recordContributorGateDecision), `target_id` and `id` both embed it the same way.
  const oldContributorGateHistoryIds = (
    await env.DB.prepare("SELECT id FROM contributor_gate_history WHERE project = ?").bind(oldFullName).all<{ id: string }>()
  ).results.map((row) => row.id);
  const renamedContributorGateHistoryIds = oldContributorGateHistoryIds.map((id) => id.split(oldFullName).join(newFullName));
  if (renamedContributorGateHistoryIds.length > 0) {
    const placeholders = renamedContributorGateHistoryIds.map(() => "?").join(",");
    await env.DB.prepare(`DELETE FROM contributor_gate_history WHERE id IN (${placeholders})`)
      .bind(...renamedContributorGateHistoryIds)
      .run();
  }
  await env.DB.prepare("UPDATE contributor_gate_history SET id = replace(id, ?, ?), project = ?, target_id = replace(target_id, ?, ?) WHERE project = ?")
    .bind(oldFullName, newFullName, newFullName, oldFullName, newFullName, oldFullName)
    .run();

  // submitterStats: no `id` column at all -- PRIMARY KEY (project, submitter) directly (migrations/0046_
  // submitter_stats.sql). `project` is the repo full name (verified live at its sole writer, submitter-
  // reputation.ts's recordSubmissionOutcome). Fold on the OTHER half of the composite key, `submitter`,
  // same single-column inArray shape used for repoSyncSegments/repoLabels above.
  const collidingSubmitters = (
    await env.DB.prepare("SELECT submitter FROM submitter_stats WHERE project = ?").bind(oldFullName).all<{ submitter: string }>()
  ).results.map((row) => row.submitter);
  if (collidingSubmitters.length > 0) {
    const placeholders = collidingSubmitters.map(() => "?").join(",");
    await env.DB.prepare(`DELETE FROM submitter_stats WHERE project = ? AND submitter IN (${placeholders})`)
      .bind(newFullName, ...collidingSubmitters)
      .run();
  }
  await env.DB.prepare("UPDATE submitter_stats SET project = ? WHERE project = ?").bind(newFullName, oldFullName).run();

  // Seven more raw-SQL-only identity-bearing tables (#8380), each with a confirmed live writer. Same three
  // fold shapes already used above, chosen per table by its REAL constraint (verified against each table's
  // own migration), not by column name:

  // orbPrOutcomes: PRIMARY KEY (repository_full_name, pr_number) (src/orb/outcomes.ts's recordOrbPrOutcome
  // upserts on exactly that). Fold on the OTHER half of the composite key, pr_number -- same shape as
  // submitterStats above.
  const collidingOrbPrNumbers = (
    await env.DB.prepare("SELECT pr_number FROM orb_pr_outcomes WHERE repository_full_name = ?").bind(oldFullName).all<{ pr_number: number }>()
  ).results.map((row) => row.pr_number);
  if (collidingOrbPrNumbers.length > 0) {
    const placeholders = collidingOrbPrNumbers.map(() => "?").join(",");
    await env.DB.prepare(`DELETE FROM orb_pr_outcomes WHERE repository_full_name = ? AND pr_number IN (${placeholders})`)
      .bind(newFullName, ...collidingOrbPrNumbers)
      .run();
  }
  await env.DB.prepare("UPDATE orb_pr_outcomes SET repository_full_name = ? WHERE repository_full_name = ?")
    .bind(newFullName, oldFullName)
    .run();

  // orbWebhookEvents: PK is delivery_id; repository_full_name is NULLABLE with no unique constraint on it
  // (src/orb/webhook.ts). Nothing can collide -- plain rename, same as signalSnapshots above.
  await env.DB.prepare("UPDATE orb_webhook_events SET repository_full_name = ? WHERE repository_full_name = ?")
    .bind(newFullName, oldFullName)
    .run();

  // overrideAudit: PK `id` is a random, NON-project-derived string (`ova_<ts36>_<random>`, newAuditId() in
  // src/review/auto-apply.ts), and the only index on `project` is non-unique. Unlike reviewAudit's id, it
  // never embeds the project, so no substring rewrite and no collision fold -- plain rename.
  await env.DB.prepare("UPDATE override_audit SET project = ? WHERE project = ?").bind(newFullName, oldFullName).run();

  // tunablesOverrides / tunablesOverridesShadow: `project` is itself the PRIMARY KEY (src/review/
  // auto-apply.ts's writeLiveOverride). The new name's own row is the collision -- delete it first, then
  // rename, the same anchor-row fold shape used for repositories/burdenForecasts above.
  for (const table of ["tunables_overrides", "tunables_overrides_shadow"] as const) {
    await env.DB.prepare(`DELETE FROM ${table} WHERE project = ?`).bind(newFullName).run();
    await env.DB.prepare(`UPDATE ${table} SET project = ? WHERE project = ?`).bind(newFullName, oldFullName).run();
  }

  // predictedGateCalibrationLedger / predictedGateCalls: the sharpest instance of this module's own dominant
  // shape -- `project` plus an `id` (and, for the ledger, a `target_id`) that embed the project as a
  // substring, exactly like reviewAudit/contributorGateHistory above. Identical substring-replace + PK-
  // collision fold. The ledger's id is `calibration:${login}:${project}:${pull}@${sha}` and its target_id is
  // `${project}#${pull}`; predicted_gate_calls' id is `predicted:${login}:${project}:${ts}:${random}` and it
  // has NO target_id column, so only id/project are rewritten there.
  const oldCalibrationLedgerIds = (
    await env.DB.prepare("SELECT id FROM predicted_gate_calibration_ledger WHERE project = ?").bind(oldFullName).all<{ id: string }>()
  ).results.map((row) => row.id);
  const renamedCalibrationLedgerIds = oldCalibrationLedgerIds.map((id) => id.split(oldFullName).join(newFullName));
  if (renamedCalibrationLedgerIds.length > 0) {
    const placeholders = renamedCalibrationLedgerIds.map(() => "?").join(",");
    await env.DB.prepare(`DELETE FROM predicted_gate_calibration_ledger WHERE id IN (${placeholders})`)
      .bind(...renamedCalibrationLedgerIds)
      .run();
  }
  await env.DB.prepare(
    "UPDATE predicted_gate_calibration_ledger SET id = replace(id, ?, ?), project = ?, target_id = replace(target_id, ?, ?) WHERE project = ?",
  )
    .bind(oldFullName, newFullName, newFullName, oldFullName, newFullName, oldFullName)
    .run();

  const oldPredictedGateCallIds = (
    await env.DB.prepare("SELECT id FROM predicted_gate_calls WHERE project = ?").bind(oldFullName).all<{ id: string }>()
  ).results.map((row) => row.id);
  const renamedPredictedGateCallIds = oldPredictedGateCallIds.map((id) => id.split(oldFullName).join(newFullName));
  if (renamedPredictedGateCallIds.length > 0) {
    const placeholders = renamedPredictedGateCallIds.map(() => "?").join(",");
    await env.DB.prepare(`DELETE FROM predicted_gate_calls WHERE id IN (${placeholders})`)
      .bind(...renamedPredictedGateCallIds)
      .run();
  }
  await env.DB.prepare("UPDATE predicted_gate_calls SET id = replace(id, ?, ?), project = ? WHERE project = ?")
    .bind(oldFullName, newFullName, newFullName, oldFullName)
    .run();

  // Deliberately OUT OF SCOPE:
  //   - The request-scoped AI/LLM result caches (ai_review_cache, ai_slop_cache,
  //     linked_issue_satisfaction_cache, grounding_file_content_cache). Every one of these is a rebuildable
  //     CACHE, not identity data: a miss after a rename just re-runs one LLM call at the new name --
  //     graceful, self-healing, and cheap, unlike an orphaned PR/issue/audit row a contributor or maintainer
  //     would otherwise need a full GitHub API backfill to recover.
  //   - review_targets (migrations/0050_review_targets.sql, raw-SQL-only): has NO live writer anywhere in
  //     this codebase -- src/review/public-stats.ts's own comment confirms "the legacy review_targets
  //     ledger, which the convergence cutover orphaned (nothing writes it anymore)". Its data is a one-time
  //     historical bulk copy from reviewbot's original schema, and the table carries TWO different
  //     repo-identity-shaped columns (`project`, an agent/install-level slug that must NEVER be renamed --
  //     it is not a per-repo value at all; and `repo`, which current read-side code validates as full
  //     owner/repo format) whose actual on-disk semantics for that historical data can't be independently
  //     verified from this codebase. Mutating identity columns on an orphaned table we can't fully verify
  //     carries real risk of silently corrupting data no writer would ever repair.
  //   - repo_chunks (migrations/0051_repo_chunks.sql, raw-SQL-only): a rebuildable RAG chunk/embedding
  //     cache, not identity data -- a miss after a rename just re-indexes at the new name (self-healing,
  //     same reasoning as the AI/LLM caches above). Its `project`/`repo` columns ALSO don't hold a single
  //     owner/repo string the way every table above does -- `project` is the bare OWNER only and `repo` is
  //     the bare REPO NAME only (src/queue/processors.ts's splitRepoForRag / src/review/rag-index.ts's
  //     splitRepo each independently strip the other half at the write path), and its `id` is a
  //     LOWERCASED, TRUNCATED-TO-64-CHARS hash of `${project}:${repo}` -- a safe in-place string rename
  //     isn't mechanically available without risking a silently-corrupted truncated id.

  // auditEvents.target_key: an append-only log with no uniqueness on target_key (many rows legitimately
  // share one), so a plain substring rename with no dedupe step is correct and sufficient.
  await db
    .update(auditEvents)
    .set({ targetKey: sql`replace(${auditEvents.targetKey}, ${oldFullName}, ${newFullName})` })
    .where(sql`${auditEvents.targetKey} like ${`%${oldFullName}%`}`);
}
