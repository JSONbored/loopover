// Gittensory Orb central GitHub App (#1255) — terminal PR-outcome capture + the global aggregate.
//
// recordOrbPrOutcome runs synchronously from the verified webhook receiver: a `pull_request` `closed` event
// records whether the PR was merged or closed (no merge) into orb_pr_outcomes, keyed on (repo, pr_number) so a
// redelivery or reopen→close cycle overwrites the latest terminal state. getOrbGlobalStats sums it across only
// REGISTERED installations — the das-github-mirror-style "total merged / closed" feeding the homepage counter.
import type { GitHubWebhookPayload } from "../types";

export async function recordOrbPrOutcome(env: Env, eventName: string, payload: GitHubWebhookPayload): Promise<void> {
  if (eventName !== "pull_request" || payload.action !== "closed") return; // only a terminal close carries an outcome
  const pr = payload.pull_request;
  const repo = payload.repository?.full_name;
  if (!pr?.number || !repo) return;
  // merged_at is set iff the PR was merged; a close without it is a plain close (rejected / abandoned).
  const merged = Boolean(pr.merged_at);
  // A PR author closing their OWN unmerged PR is not authoritative ground truth and must not feed the public
  // homepage counter (mirrors the cloud recordPrOutcome anti-poisoning guard). Merges stay trusted (GitHub enforces
  // merge permission); a maintainer/bot close is not a self-close. The early-return leaves any prior row untouched.
  const senderLogin = (payload.sender?.login ?? "").toLowerCase();
  const authorLogin = (pr.user?.login ?? "").toLowerCase();
  const botWasActor = payload.sender?.type === "Bot";
  if (!merged && !botWasActor && senderLogin && authorLogin && senderLogin === authorLogin) return;
  const outcome = merged ? "merged" : "closed";
  await env.DB.prepare(
    `INSERT INTO orb_pr_outcomes (repository_full_name, pr_number, installation_id, outcome, occurred_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(repository_full_name, pr_number) DO UPDATE SET
       installation_id = excluded.installation_id, outcome = excluded.outcome, occurred_at = CURRENT_TIMESTAMP`,
  )
    .bind(repo, pr.number, payload.installation?.id ?? null, outcome)
    .run();
}

export interface OrbGlobalStats {
  merged: number;
  closed: number;
  total: number;
}

/**
 * The public global aggregate: merged / closed / total terminal PR outcomes across REGISTERED installations
 * only (registered = 1) — an install that hasn't been opted in never contributes to the public counter. SUM over
 * no matching rows is NULL, so each total is nullish-guarded to 0 (fail-safe on an empty/cold table).
 *
 * The LEFT JOIN ... WHERE ae.id IS NULL anti-join skips any (repo, pr_number) that already has a
 * `github_app.pr_public_surface_published` audit event — i.e. a PR the own-ledger disposition query in
 * public-stats.ts already counted. Without it, a PR reviewed before the self-host cutover (own-ledger) that
 * also has a terminal outcome recorded here (Orb) gets counted twice. Quantified 2026-07-12: 243 PRs (173
 * merged + 70 closed), 96% in one repo, inflating the public "PRs reviewed" counter. That event_type's
 * target_key only ever references the own-ledger's own repos, so this is a no-op for every other registered
 * installation's outcomes.
 *
 * PERFORMANCE (2026-07-12 incident): the first version of this used a correlated `NOT EXISTS` subquery with
 * `LOWER(ae.target_key) = ...` — wrapping the indexed `target_key` column in a function defeats the index,
 * forcing a full scan of `audit_events` (100K+ rows) for every one of `orb_pr_outcomes`' rows. That took
 * `/v1/public/stats` down in production (D1 "exceeded its CPU time limit and was reset", 503s) within minutes
 * of deploying. The LEFT JOIN below compares `target_key` directly (no function wrapping), so D1 can use the
 * index for the join — verified live: ~60ms / ~31K rows read, vs. a timeout before. Both sides of the compared
 * repo#pr key come from real GitHub API `full_name`/`target_key` values (same canonical casing), so no LOWER()
 * is needed here for correctness — do not reintroduce a function-wrapped comparison on `target_key` without
 * re-verifying the query plan against production-scale data first.
 */
export async function getOrbGlobalStats(env: Env, opts: { excludeAccount?: string } = {}): Promise<OrbGlobalStats> {
  // excludeAccount de-dups an account already counted by another source. "" = include all.
  const exclude = (opts.excludeAccount ?? "").toLowerCase();
  const row = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN o.outcome = 'merged' THEN 1 ELSE 0 END) AS merged,
       SUM(CASE WHEN o.outcome = 'closed' THEN 1 ELSE 0 END) AS closed,
       COUNT(*) AS total
     FROM orb_pr_outcomes o
     JOIN orb_github_installations i ON i.installation_id = o.installation_id AND i.registered = 1
     LEFT JOIN audit_events ae
       ON ae.target_key = o.repository_full_name || '#' || o.pr_number
       AND ae.event_type = 'github_app.pr_public_surface_published'
     WHERE (? = '' OR LOWER(COALESCE(i.account_login, '')) <> ?)
       AND ae.id IS NULL`,
  )
    .bind(exclude, exclude)
    .first<{ merged: number | null; closed: number | null; total: number | null }>();
  /* v8 ignore next -- an aggregate query always returns exactly one row; this guards the nullable .first() type only */
  if (!row) return { merged: 0, closed: 0, total: 0 };
  return { merged: row.merged ?? 0, closed: row.closed ?? 0, total: row.total ?? 0 };
}
