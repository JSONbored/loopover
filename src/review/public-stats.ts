// Public "proof of power" stats (#1059) — a small, public-safe aggregate of what gittensory's REVIEW SYSTEM has
// done, powering the above-the-fold homepage counter. Flag-gated by GITTENSORY_PUBLIC_STATS (default OFF): when
// off the public endpoint 404s, so the deploy is byte-identical to today until the flag is deliberately set.
//
// REALTIME: queries the live tables directly (no rollup/cron) so a new review shows up within the 60s HTTP cache
// window — single source of truth, always current. The source is review_targets (one row per PR, scoped to the
// repos the review system handles: gittensory, awesome-claude, metagraphed) with the terminal review DISPOSITION
// in `status`. This is NOT the broader pull_requests / recent_merged_pull_requests mining caches.
//
// DISPOSITIONS (terminal): merged / closed = gittensory auto-actioned; commented = reviewed + advised, deferred
// to a maintainer; manual = escalated to a maintainer; ignored = skipped (drafts/bots/excluded); error = failed.
//   reviewed   = merged + closed + commented + manual   (PRs it actually reviewed; excludes ignored + error)
//   filteredPct = (reviewed - merged) / reviewed         (share resolved WITHOUT a merge — noise kept off humans)
//   accuracyPct = 1 - reversed / (merged + closed)       (reversal-grounded; reversed from review_audit)
//   minutesSaved = reviewed * MINUTES_SAVED_PER_PR        (estimated maintainer review time saved)
//
// PRIVACY: counts only — no PR content, authors, scores, or reward internals. Safe to serve publicly.

/** Estimate of maintainer review/triage time saved per reviewed PR. Dial this to taste — it is the single knob
 *  behind the "time saved" stat (at current volume: 20 min ≈ 38 days saved; 15 min ≈ 28 days). */
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
async function safeAll<T>(
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
  return Math.round((1 - reversed / decided) * 1000) / 10;
}

/** Public stats are intentionally constrained to the reviewed-repo allowlist. Empty allowlist => publish nothing. */
function publicStatsProjects(env: {
  GITTENSORY_REVIEW_REPOS?: string | undefined;
}): string[] {
  const seen = new Set<string>();
  const projects: string[] = [];
  for (const entry of (env.GITTENSORY_REVIEW_REPOS ?? "").split(",")) {
    const project = entry.trim().toLowerCase();
    if (!project || seen.has(project)) continue;
    seen.add(project);
    projects.push(project);
  }
  return projects;
}

interface DispositionRow {
  project: string;
  handled: number;
  merged: number;
  closed: number;
  commented: number;
  ignored: number;
  manual: number;
  error: number;
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

const DISPOSITION_SELECT = `
  SUM(CASE WHEN status = 'merged' THEN 1 ELSE 0 END) AS merged,
  SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed,
  SUM(CASE WHEN status = 'commented' THEN 1 ELSE 0 END) AS commented,
  SUM(CASE WHEN status = 'ignored' THEN 1 ELSE 0 END) AS ignored,
  SUM(CASE WHEN status = 'manual' THEN 1 ELSE 0 END) AS manual,
  SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error`;

/** Assemble the public-safe payload from the LIVE review ledger (cheap: review_targets is one row per PR). */
export async function getPublicStats(
  env: Env,
  nowMs: number = Date.now(),
): Promise<PublicStatsPayload> {
  const sinceIso = new Date(nowMs - 7 * 86_400_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  const projects = publicStatsProjects(env);
  const generatedAt = new Date(nowMs).toISOString();
  const empty = (): PublicStatsPayload => ({
    generatedAt,
    updatedAt: generatedAt,
    totals: {
      handled: 0,
      reviewed: 0,
      merged: 0,
      closed: 0,
      commented: 0,
      ignored: 0,
      manual: 0,
      error: 0,
      reversed: 0,
      filteredPct: null,
      accuracyPct: null,
      minutesSaved: 0,
    },
    weekly: { reviewed: 0, merged: 0 },
    byProject: [],
  });
  if (projects.length === 0) return empty();

  const projectFilter = `LOWER(project) IN (${projects.map(() => "?").join(", ")})`;
  const [dispositions, reversalRows, weekly] = await Promise.all([
    safeAll<DispositionRow>(
      env,
      `SELECT project, COUNT(*) AS handled,${DISPOSITION_SELECT} FROM review_targets WHERE ${projectFilter} GROUP BY project`,
      ...projects,
    ),
    safeAll<{ project: string; reversed: number }>(
      env,
      `SELECT project, COUNT(*) AS reversed FROM review_audit
       WHERE event_type IN ('reversal_reverted', 'reversal_reopened') AND ${projectFilter} GROUP BY project`,
      ...projects,
    ),
    safeAll<{
      merged: number;
      closed: number;
      commented: number;
      manual: number;
    }>(
      env,
      `SELECT${DISPOSITION_SELECT.replace(/, $/, "")} FROM review_targets WHERE created_at >= ? AND ${projectFilter}`,
      sinceIso,
      ...projects,
    ),
  ]);

  const reversedByProject = new Map(
    reversalRows.map((r) => [r.project, r.reversed ?? 0]),
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
      const commented = d.commented ?? 0;
      const manual = d.manual ?? 0;
      const ignored = d.ignored ?? 0;
      const error = d.error ?? 0;
      const reversed = reversedByProject.get(d.project) ?? 0;
      totals.handled += d.handled ?? 0;
      totals.merged += merged;
      totals.closed += closed;
      totals.commented += commented;
      totals.ignored += ignored;
      totals.manual += manual;
      totals.error += error;
      totals.reversed += reversed;
      const reviewed = reviewedOf({ merged, closed, commented, manual });
      return {
        project: d.project,
        reviewed,
        merged,
        closed,
        accuracyPct: accuracyPct(merged, closed, reversed),
      };
    })
    .filter((r) => r.reviewed > 0)
    .sort((a, b) => b.reviewed - a.reviewed);

  const reviewed = reviewedOf(totals);
  const w = weekly[0] ?? { merged: 0, closed: 0, commented: 0, manual: 0 };
  return {
    generatedAt,
    updatedAt: generatedAt,
    totals: {
      ...totals,
      reviewed,
      filteredPct: filteredPct(reviewed, totals.merged),
      accuracyPct: accuracyPct(totals.merged, totals.closed, totals.reversed),
      minutesSaved: reviewed * MINUTES_SAVED_PER_PR,
    },
    weekly: { reviewed: reviewedOf(w), merged: w.merged ?? 0 },
    byProject,
  };
}
