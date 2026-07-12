// Public "proof of power" stats (#1059) — a small, public-safe aggregate of what gittensory's REVIEW SYSTEM has
// done, powering the above-the-fold homepage counter. Flag-gated by GITTENSORY_PUBLIC_STATS (default OFF): when
// off the public endpoint 404s, so the deploy is byte-identical to today until the flag is deliberately set.
//
// REALTIME: queries the live ledger directly (no rollup/cron) so a new review shows up within the 60s HTTP cache
// window. "reviewed" = a distinct PR for which the review system published a public review surface (audit_events
// `github_app.pr_public_surface_published`, scoped to the repos it handles: gittensory, awesome-claude,
// metagraphed); each PR's terminal DISPOSITION is read from the pull_requests cache. (The legacy review_targets
// ledger this used to read was orphaned by the convergence cutover — nothing writes it anymore.)
//
// DISPOSITIONS: merged (merged_at set) / closed (closed without a merge) = the review system auto-actioned;
// commented = still-open reviewed PRs (reviewed + advised, awaiting a maintainer / CI). Reviewed PRs that never
// got a published surface (skipped drafts/bots, errors) simply don't appear — there is no ignored/manual/error.
//   reviewed   = merged + closed + commented            (every distinct PR a review surface was published for)
//   filteredPct = (reviewed - merged) / reviewed         (share resolved WITHOUT a merge — noise kept off humans)
//   accuracyPct = 1 - reversed / (merged + closed)       (reversed = engine auto-actions a human overturned, live)
//   minutesSaved = SUM(per-PR COALESCE(reviewEffortMinutes, MINUTES_SAVED_PER_PR))  (estimated maintainer
//                                                          review time saved -- #1955/#2070: each distinct
//                                                          published PR contributes its persisted estimate,
//                                                          with MINUTES_SAVED_PER_PR only backstopping PRs
//                                                          that lack a stored estimate)
//
// PRIVACY: counts only — no PR content, authors, scores, or reward internals. Safe to serve publicly.
//
// GLOBAL: the homepage total folds in every REGISTERED Orb installation's outcomes (getOrbGlobalStats) on top of
// the own-ledger side, so the counter reflects the whole fleet, not just gittensory's own repos. The own-ledger
// side (audit_events) is a FROZEN snapshot as of the self-host cutover -- it stops growing the day each repo's
// live processing moved off this worker, and can never grow again now that the old App has been fully deleted --
// while orb_pr_outcomes keeps growing in realtime for any repo with the central Orb App installed (including
// JSONbored's own, which still runs the Orb App for telemetry alongside its self-hosted review engine). The two
// sources overlap by (repo, pr_number), not just by account: earlier reasoning here called that overlap "a small,
// bounded double-count," but it was measured directly (2026-07-12) at 243 PRs (173 merged + 70 closed, 96% in one
// repo) -- large enough to move accuracyPct and mislead visitors, not a rounding error. getOrbGlobalStats now
// excludes exactly those overlapping (repo, pr_number) pairs via a NOT EXISTS anti-join against the same
// `github_app.pr_public_surface_published` audit events this file's own disposition query reads, so the two sums
// are over disjoint PR sets and can be added directly.
import { getOrbGlobalStats } from "../orb/outcomes";

/** FALLBACK estimate of maintainer review/triage time saved per reviewed PR, used ONLY when the real per-PR
 *  average (`estimateReviewEffort`'s minutes, persisted at publish time — see `reviewEffortMinutes` in the
 *  `github_app.pr_public_surface_published` audit metadata) is unavailable: an empty allowlist, or a ledger whose
 *  published rows all predate this feature. (#1955 — previously the ONLY figure behind "time saved"; kept as the
 *  documented degrade rather than removed, since a historical ledger genuinely has no other number to report.) */
export const MINUTES_SAVED_PER_PR = 20;

/** Truthy-string flag check, matching ops-wire / selftune-wire. */
export function isPublicStatsEnabled(env: {
  GITTENSORY_PUBLIC_STATS?: string | undefined;
}): boolean {
  return /^(1|true|yes|on)$/i.test(env.GITTENSORY_PUBLIC_STATS ?? "");
}

/** Storage seam: gittensory's `Env` is a global ambient interface with `DB` (mirrors src/review/stats.ts). */
function storage(env: Env): D1Database {
  return env.DB;
}

/** Read-only helper that degrades a missing/empty table (or absent column in some envs) to []. */
export async function safeAll<T>(
  env: Env,
  sql: string,
  ...binds: unknown[]
): Promise<T[]> {
  try {
    const prepared = storage(env).prepare(sql);
    const stmt = binds.length > 0 ? prepared.bind(...binds) : prepared;
    const res = await stmt.all<T>();
    return res.results ?? [];
  } catch {
    return [];
  }
}

/** reviewed = the PRs gittensory actually reviewed (excludes ignored drafts/bots + errors). */
function reviewedOf(d: {
  merged: number;
  closed: number;
  commented: number;
  manual: number;
}): number {
  return d.merged + d.closed + d.commented + d.manual;
}

/** Share of reviewed PRs resolved WITHOUT a merge (closed/advised/escalated); null when nothing reviewed. */
function filteredPct(reviewed: number, merged: number): number | null {
  if (reviewed <= 0) return null;
  return Math.round(((reviewed - merged) / reviewed) * 1000) / 10;
}

/** Reversal-grounded accuracy over the irreversible auto-actions (merged + closed); null until there is signal. */
function accuracyPct(
  merged: number,
  closed: number,
  reversed: number,
): number | null {
  const decided = merged + closed;
  if (decided <= 0) return null;
  // `reversed` counts engine auto-actions regardless of a PR's CURRENT disposition, so a reopened
  // auto-close (now open, dropped from merged+closed) can push reversed above decided. Clamp the reversal
  // rate to 1 so the public accuracy percentage can never go negative / out of the [0,100] range.
  const reversalRate = Math.min(1, reversed / decided);
  return Math.round((1 - reversalRate) * 1000) / 10;
}

/** The own-ledger side of public stats is intentionally constrained to an explicit allowlist (privacy: publish
 *  only what's deliberately opted in). Deliberately reads GITTENSORY_PUBLIC_STATS_REPOS, NOT
 *  GITTENSORY_REVIEW_REPOS (the live per-PR-feature cutover allowlist) -- the two once held the same value, but
 *  diverged once gittensory/awesome-claude/metagraphed moved their LIVE processing to self-host: the cutover
 *  allowlist correctly went empty, while the historical rows this worker already wrote for them remain real and
 *  safe to publish. Empty allowlist => the own-ledger side reports zero (still fails safe), but does NOT
 *  suppress the separately-gated Orb cross-fleet aggregate (see getPublicStats below). */
export function publicStatsProjects(env: {
  GITTENSORY_PUBLIC_STATS_REPOS?: string | undefined;
}): string[] {
  const seen = new Set<string>();
  const projects: string[] = [];
  for (const entry of (env.GITTENSORY_PUBLIC_STATS_REPOS ?? "").split(",")) {
    const project = entry.trim().toLowerCase();
    if (!project || seen.has(project)) continue;
    seen.add(project);
    projects.push(project);
  }
  return projects;
}

interface DispositionRow {
  project: string;
  reviewed: number;
  merged: number;
  closed: number;
  inReview: number;
}

export interface PublicStatsPayload {
  generatedAt: string;
  updatedAt: string;
  totals: {
    handled: number;
    reviewed: number;
    merged: number;
    closed: number;
    commented: number;
    ignored: number;
    manual: number;
    error: number;
    reversed: number;
    filteredPct: number | null;
    accuracyPct: number | null;
    minutesSaved: number;
  };
  /** Trailing-7-day additions (by review time), for the "+N this week" hero delta. */
  weekly: { reviewed: number; merged: number };
  /** Per-repo split, busiest first. Public repo slugs only. */
  byProject: Array<{
    project: string;
    reviewed: number;
    merged: number;
    closed: number;
    accuracyPct: number | null;
  }>;
}

// Live "reviewed" = a distinct PR for which the bot published a review surface (audit_events
// `github_app.pr_public_surface_published`, target_key "owner/repo#number"). Its terminal DISPOSITION
// (merged / closed-without-merge / still-open-in-review) comes from the pull_requests cache. This replaces the
// legacy review_targets ledger, which the convergence cutover orphaned (nothing writes it anymore). `reversed`
// (the accuracy numerator) is computed LIVE from the same ledger: a terminal engine auto-action (close/merge)
// that a human later overturned (see the reversal query below). All reads are public-safe COUNTs, degrade to 0.
export const PUBLISHED_PR_KEYS = `
  SELECT
    substr(target_key, 1, instr(target_key, '#') - 1) AS repo,
    CAST(substr(target_key, instr(target_key, '#') + 1) AS INTEGER) AS number,
    created_at
  FROM audit_events
  WHERE event_type = 'github_app.pr_public_surface_published' AND instr(target_key, '#') > 0`;

/** Assemble the public-safe payload from the LIVE review ledger: distinct PRs the bot published a review for
 *  (audit_events) joined to their terminal disposition (pull_requests state). Realtime behind the 60s HTTP cache
 *  — a new review shows up within ~a minute; no rollup/cron. */
export async function getPublicStats(
  env: Env,
  nowMs: number = Date.now(),
): Promise<PublicStatsPayload> {
  const sinceIso = new Date(nowMs - 7 * 86_400_000).toISOString();
  const projects = publicStatsProjects(env);
  const generatedAt = new Date(nowMs).toISOString();
  // The own-ledger side needs at least one allowlisted project to query; an empty allowlist skips these three
  // queries entirely (own-ledger totals stay zero) but still lets the Orb aggregate below run.
  const inList = projects.map(() => "?").join(", ");
  const [dispositions, reversalRows, weeklyRows, effortRows] = projects.length === 0
    ? await Promise.all([
        Promise.resolve<DispositionRow[]>([]),
        Promise.resolve<{ project: string; reversed: number }[]>([]),
        Promise.resolve<{ reviewed: number; merged: number }[]>([]),
        Promise.resolve<{ totalMinutes: number | null }[]>([]),
      ])
    : await Promise.all([
    safeAll<DispositionRow>(
      env,
      `SELECT ev.repo AS project,
              COUNT(*) AS reviewed,
              SUM(CASE WHEN pr.merged_at IS NOT NULL THEN 1 ELSE 0 END) AS merged,
              SUM(CASE WHEN pr.state = 'closed' AND pr.merged_at IS NULL THEN 1 ELSE 0 END) AS closed,
              SUM(CASE WHEN pr.id IS NULL OR pr.state = 'open' THEN 1 ELSE 0 END) AS inReview
         FROM (SELECT DISTINCT repo, number FROM (${PUBLISHED_PR_KEYS})) ev
         LEFT JOIN pull_requests pr ON pr.repo_full_name = ev.repo AND pr.number = ev.number
        WHERE LOWER(ev.repo) IN (${inList})
        GROUP BY ev.repo`,
      ...projects,
    ),
    safeAll<{ project: string; reversed: number }>(
      env,
      // A "reversal" = a terminal engine auto-action (close/merge) a human later OVERTURNED, detected LIVE from the
      // PR's current state: an engine-closed PR now reopened/merged, or an engine-merged PR now reopened. Counts
      // the detectable subset — a merge undone via a SEPARATE revert PR isn't visible here yet (the revert detector
      // is the follow-up). Replaces the orphaned review_audit reversal events, frozen at the convergence cutover.
      `SELECT project, COUNT(DISTINCT pr_number) AS reversed FROM (
         SELECT substr(target_key, 1, instr(target_key, '#') - 1) AS project,
                CAST(substr(target_key, instr(target_key, '#') + 1) AS INTEGER) AS pr_number,
                event_type
           FROM audit_events
          WHERE event_type IN ('agent.action.close', 'agent.action.merge')
            AND outcome = 'completed' AND instr(target_key, '#') > 0
            AND COALESCE(json_extract(metadata_json, '$.mode'), 'live') <> 'dry_run'
       ) ev
       JOIN pull_requests pr ON pr.repo_full_name = ev.project AND pr.number = ev.pr_number
        WHERE LOWER(ev.project) IN (${inList})
          AND ( (ev.event_type = 'agent.action.close' AND (pr.state = 'open' OR pr.merged_at IS NOT NULL))
             OR (ev.event_type = 'agent.action.merge' AND pr.state = 'open') )
        GROUP BY project`,
      ...projects,
    ),
    safeAll<{ reviewed: number; merged: number }>(
      env,
      `SELECT
         SUM(CASE WHEN first_seen >= ? THEN 1 ELSE 0 END) AS reviewed,
         SUM(CASE WHEN merged_at IS NOT NULL AND merged_at >= ? THEN 1 ELSE 0 END) AS merged
       FROM (
         SELECT ev.repo, ev.number, MIN(ev.created_at) AS first_seen, MAX(pr.merged_at) AS merged_at
           FROM (${PUBLISHED_PR_KEYS}) ev
           LEFT JOIN pull_requests pr ON pr.repo_full_name = ev.repo AND pr.number = ev.number
          WHERE LOWER(ev.repo) IN (${inList})
          GROUP BY ev.repo, ev.number
       )`,
      sinceIso,
      sinceIso,
      ...projects,
    ),
    // review-effort minutes (#1955/#2070): sum each distinct published PR's persisted estimate, using
    // MINUTES_SAVED_PER_PR only for PRs whose metadata lacks reviewEffortMinutes (mixed-rollout safe).
    safeAll<{ totalMinutes: number | null }>(
      env,
      `SELECT SUM(COALESCE(minutes, ?)) AS totalMinutes
         FROM (
           SELECT repo, number, AVG(minutes) AS minutes
             FROM (
               SELECT LOWER(substr(target_key, 1, instr(target_key, '#') - 1)) AS repo,
                      CAST(substr(target_key, instr(target_key, '#') + 1) AS INTEGER) AS number,
                      json_extract(metadata_json, '$.reviewEffortMinutes') AS minutes
                 FROM audit_events
                WHERE event_type = 'github_app.pr_public_surface_published'
                  AND LOWER(substr(target_key, 1, instr(target_key, '#') - 1)) IN (${inList})
                  AND instr(target_key, '#') > 0
             )
            GROUP BY repo, number
         )`,
      MINUTES_SAVED_PER_PR,
      ...projects,
    ),
  ]);

  const reversedByProject = new Map(
    reversalRows.map((r) => [String(r.project).toLowerCase(), r.reversed ?? 0]),
  );
  const totals = {
    handled: 0,
    merged: 0,
    closed: 0,
    commented: 0,
    ignored: 0,
    manual: 0,
    error: 0,
    reversed: 0,
  };
  const byProject = dispositions
    .map((d) => {
      const merged = d.merged ?? 0;
      const closed = d.closed ?? 0;
      const inReview = d.inReview ?? 0;
      const reversed =
        reversedByProject.get(String(d.project).toLowerCase()) ?? 0;
      const reviewed = merged + closed + inReview;
      totals.handled += reviewed;
      totals.merged += merged;
      totals.closed += closed;
      // "commented" carries the still-open reviewed PRs (reviewed + advised, awaiting a maintainer / CI).
      totals.commented += inReview;
      totals.reversed += reversed;
      return {
        project: d.project,
        reviewed,
        merged,
        closed,
        accuracyPct: accuracyPct(merged, closed, reversed),
      };
    })
    .filter((r) => r.reviewed > 0)
    // Tie-break on project so repos with an equal reviewed count keep a stable,
    // deterministic published order instead of following arbitrary SQL row order,
    // matching the localeCompare tie-breaks used by the parity/auto-tune reports.
    .sort((a, b) => b.reviewed - a.reviewed || a.project.localeCompare(b.project));

  // Global counter: fold in every REGISTERED Orb install's outcomes on top of the own-ledger totals above, so the
  // homepage reflects the whole fleet. No excludeAccount here (see the file header) -- reversals/weekly stay
  // own-ledger-only (the Orb aggregate only captures merged/closed, not reversals or a trailing-7-day split). The
  // total grows automatically as more installations register, self-hosted or otherwise.
  // Snapshot before Orb merge: effort SQL only covers allowlisted own-ledger publishes, while `reviewed`
  // below includes Orb fleet outcomes folded into totals.merged/closed.
  const ownLedgerReviewed = reviewedOf(totals);
  const orb = await getOrbGlobalStats(env);
  totals.merged += orb.merged;
  totals.closed += orb.closed;
  totals.handled += orb.total;

  const reviewed = reviewedOf(totals);
  const w = weeklyRows[0] ?? { reviewed: 0, merged: 0 };
  // review-effort minutes (#1955/#2070): own-ledger publishes sum per-PR estimates (COALESCE fallback); Orb fleet
  // outcomes have no persisted effort metadata here, so they still credit the flat MINUTES_SAVED_PER_PR constant.
  const minutesSavedTotal = effortRows[0]?.totalMinutes;
  const ownLedgerMinutes =
    minutesSavedTotal != null ? minutesSavedTotal : ownLedgerReviewed * MINUTES_SAVED_PER_PR;
  const minutesSaved =
    reviewed === 0 ? 0 : Math.round(ownLedgerMinutes + orb.total * MINUTES_SAVED_PER_PR);
  return {
    generatedAt,
    updatedAt: generatedAt,
    totals: {
      ...totals,
      reviewed,
      filteredPct: filteredPct(reviewed, totals.merged),
      accuracyPct: accuracyPct(totals.merged, totals.closed, totals.reversed),
      minutesSaved,
    },
    weekly: { reviewed: w.reviewed ?? 0, merged: w.merged ?? 0 },
    byProject,
  };
}
