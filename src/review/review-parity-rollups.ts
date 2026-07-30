// Re-evaluation counts and per-author-class review-parity rollups (#9743).
//
// Two questions this deployment should be able to answer with standing numbers rather than an ad-hoc query:
//
//   1. How often is a verdict re-evaluated, and why? (#9742 made every repeat verdict declare a reason; this
//      counts them by that reason, as a share of all verdicts.)
//   2. Does a PR face the same scrutiny regardless of who wrote it?
//
// PUBLISHED DEFINITIONS. Everything below is computed from `decision_records` -- the anchored ledger -- and
// nothing else, so an outsider holding the same export can recompute every figure here and get the same
// answer. That is the whole point of the exercise; a number nobody can check is not evidence of fairness.
//
//   verdicts            One row in `decision_records`. A repeat evaluation of the same head SHA is its own
//                       row (#9123), so this counts EVALUATIONS, not pull requests.
//   reevaluations       Verdicts carrying a `reevaluation_reason` -- i.e. every verdict past the first for
//                       a head SHA. A first evaluation has no reason by construction and is never counted.
//   reviewsPerPr        verdicts / distinct (repo, pull). >1 means heads were re-evaluated.
//   findingsPerPr       Mean `findings_count` over verdicts that RECORDED one. Verdicts with a null count
//                       (a policy close, an update_branch, or any row written before migration 0205) are
//                       excluded from both halves of the mean rather than counted as zero -- see
//                       `findingsBasis` for the coverage that mean was earned at.
//   closeRate           Share of verdicts whose action is `close`.
//   holdRate            Share of verdicts whose action is `hold`.
//
// AUTHOR CLASS is `pull_requests.author_association`, GitHub's own field, mapped by
// `classifyAuthorAssociation` (github/author-association.ts). Mechanical: no maintained list of people, and
// a permissions change upstream changes the class with no code change here. A PR whose association was
// never recorded is `unknown` and is reported as its own class rather than folded into either side -- the
// comparison is the entire product, so quietly bucketing unknowns would bias exactly the thing being
// measured.

import { classifyAuthorAssociation, type AuthorClass } from "../github/author-association";
import { safeAll } from "./public-stats";

/** Every author class, in report order. Exported so a caller cannot invent a fifth bucket. */
export const AUTHOR_CLASSES: readonly AuthorClass[] = ["maintainer", "contributor", "unknown"];

/** One verdict, reduced to just the fields the rollups read. */
export type ParityVerdictRow = {
  authorClass: AuthorClass;
  repoFullName: string;
  pullNumber: number;
  action: string;
  /** Null when this verdict recorded no finding count -- NOT the same as zero findings. */
  findingsCount: number | null;
  /** Null for a first evaluation of a head SHA. */
  reevaluationReason: string | null;
};

export type ParityRollup = {
  authorClass: AuthorClass;
  /** Evaluations, not pull requests. */
  verdicts: number;
  /** Distinct (repo, pull) behind those verdicts. */
  pullRequests: number;
  reviewsPerPr: number | null;
  findingsPerPr: number | null;
  /** How many verdicts actually carried a finding count -- the coverage `findingsPerPr` was earned at.
   *  A mean over 3 of 400 verdicts is not the same claim as a mean over 400, and publishing the two
   *  identically is how an honest-looking number misleads. */
  findingsBasis: number;
  closeRate: number | null;
  holdRate: number | null;
};

export type ReevaluationReasonCount = {
  reason: string;
  count: number;
  /** Share of ALL verdicts in the window, not of re-evaluations -- "3% of verdicts were re-run for a
   *  pipeline error" is the readable claim; a share of re-evaluations would always sum to 100% and say
   *  nothing about how often re-evaluation happens at all. */
  shareOfVerdictsPct: number | null;
};

export type ReviewParityRollups = {
  /** Inclusive-exclusive ISO bounds the whole payload was computed over. */
  windowStart: string;
  windowEnd: string;
  verdicts: number;
  reevaluations: number;
  /** Share of verdicts that were a re-evaluation. Null when the window holds no verdicts -- an undefined
   *  ratio, reported as such rather than as a reassuring 0%. */
  reevaluationRatePct: number | null;
  /** Descending by count, then reason for a stable order. Reasons with zero occurrences are omitted. */
  byReason: ReevaluationReasonCount[];
  /** One entry per class that has at least one verdict, in AUTHOR_CLASSES order. */
  byAuthorClass: ParityRollup[];
  /** Per-repo granularity, busiest first. Same shape, scoped to one repo. */
  byProject: Array<{ project: string; byAuthorClass: ParityRollup[] }>;
};

/** Percent to one decimal, or null when the denominator is zero. A rate with no denominator is unknown,
 *  never 0 -- the distinction is the difference between "nothing was held" and "nothing was measured". */
export function ratePct(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/** Mean to two decimals, or null when nothing contributed. */
function mean(total: number, count: number): number | null {
  if (count <= 0) return null;
  return Math.round((total / count) * 100) / 100;
}

/** Roll one class's verdicts into the published shape. PURE, so the definitions above are testable
 *  directly against a table of rows rather than only through a database. */
export function rollUpVerdicts(authorClass: AuthorClass, rows: readonly ParityVerdictRow[]): ParityRollup {
  const pulls = new Set<string>();
  let closes = 0;
  let holds = 0;
  let findingsTotal = 0;
  let findingsBasis = 0;
  for (const row of rows) {
    pulls.add(`${row.repoFullName}#${row.pullNumber}`);
    if (row.action === "close") closes += 1;
    if (row.action === "hold") holds += 1;
    if (row.findingsCount !== null) {
      findingsTotal += row.findingsCount;
      findingsBasis += 1;
    }
  }
  return {
    authorClass,
    verdicts: rows.length,
    pullRequests: pulls.size,
    reviewsPerPr: mean(rows.length, pulls.size),
    findingsPerPr: mean(findingsTotal, findingsBasis),
    findingsBasis,
    closeRate: ratePct(closes, rows.length),
    holdRate: ratePct(holds, rows.length),
  };
}

/** Group rows by author class, in report order, omitting classes with no verdicts. */
export function rollUpByAuthorClass(rows: readonly ParityVerdictRow[]): ParityRollup[] {
  return AUTHOR_CLASSES.map((authorClass) => rollUpVerdicts(authorClass, rows.filter((row) => row.authorClass === authorClass))).filter(
    (rollup) => rollup.verdicts > 0,
  );
}

/**
 * The whole published payload, from a window's verdict rows. PURE.
 *
 * Kept separate from the query so every definition above can be tested against a hand-written table --
 * which is also what lets an outsider check our arithmetic without reproducing our database.
 */
export function buildReviewParityRollups(input: {
  windowStart: string;
  windowEnd: string;
  rows: readonly ParityVerdictRow[];
}): ReviewParityRollups {
  const { rows } = input;
  // A type PREDICATE, not a plain filter: it narrows `reevaluationReason` to `string` for the tally below,
  // which is what removes the re-check the tally would otherwise need and could never fail.
  const reevaluated = rows.filter((row): row is ParityVerdictRow & { reevaluationReason: string } => row.reevaluationReason !== null);

  const counts = new Map<string, number>();
  for (const row of reevaluated) {
    counts.set(row.reevaluationReason, (counts.get(row.reevaluationReason) ?? 0) + 1);
  }

  const byProject = new Map<string, ParityVerdictRow[]>();
  for (const row of rows) {
    const bucket = byProject.get(row.repoFullName);
    if (bucket) bucket.push(row);
    else byProject.set(row.repoFullName, [row]);
  }

  return {
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    verdicts: rows.length,
    reevaluations: reevaluated.length,
    reevaluationRatePct: ratePct(reevaluated.length, rows.length),
    byReason: [...counts.entries()]
      .map(([reason, count]) => ({ reason, count, shareOfVerdictsPct: ratePct(count, rows.length) }))
      .sort((a, b) => (b.count === a.count ? a.reason.localeCompare(b.reason) : b.count - a.count)),
    byAuthorClass: rollUpByAuthorClass(rows),
    byProject: [...byProject.entries()]
      .map(([project, projectRows]) => ({ project, byAuthorClass: rollUpByAuthorClass(projectRows) }))
      .sort((a, b) => {
        const aVerdicts = a.byAuthorClass.reduce((sum, rollup) => sum + rollup.verdicts, 0);
        const bVerdicts = b.byAuthorClass.reduce((sum, rollup) => sum + rollup.verdicts, 0);
        return bVerdicts === aVerdicts ? a.project.localeCompare(b.project) : bVerdicts - aVerdicts;
      }),
  };
}

/**
 * Read one window's verdicts and roll them up (#9743).
 *
 * The join is `decision_records` LEFT JOIN `pull_requests` on (repo, number): LEFT so a verdict whose PR
 * row has since been pruned still counts toward the totals as `unknown` rather than vanishing -- dropping
 * it would quietly shrink the denominator of a fairness figure.
 */
export async function loadReviewParityRollups(
  env: unknown,
  options: {
    windowDays?: number | undefined;
    nowMs?: number | undefined;
    /** Injected so the whole path is testable without a database; defaults to the real read. */
    fetchRows?: ((sinceIso: string, untilIso: string) => Promise<readonly RawParityRow[]>) | undefined;
  } = {},
): Promise<ReviewParityRollups> {
  const nowMs = options.nowMs ?? Date.now();
  // Narrowed on the local rather than re-reading the option, so there is no `?? 0` arm that cannot fire
  // and no cast: a non-number, non-finite, or non-positive window all fall back to the 7-day default.
  const requested = options.windowDays;
  const windowDays = typeof requested === "number" && Number.isFinite(requested) && requested > 0 ? Math.trunc(requested) : 7;
  const windowEnd = new Date(nowMs).toISOString();
  const windowStart = new Date(nowMs - windowDays * 86_400_000).toISOString();

  const fetchRows = options.fetchRows ?? ((since: string, until: string) => queryParityRows(env, since, until));
  const raw = await fetchRows(windowStart, windowEnd).catch(() => [] as RawParityRow[]);

  return buildReviewParityRollups({
    windowStart,
    windowEnd,
    rows: raw.map((row) => ({
      authorClass: classifyAuthorAssociation(row.authorAssociation),
      repoFullName: row.repoFullName,
      pullNumber: row.pullNumber,
      action: row.action,
      findingsCount: typeof row.findingsCount === "number" ? row.findingsCount : null,
      reevaluationReason: typeof row.reevaluationReason === "string" && row.reevaluationReason !== "" ? row.reevaluationReason : null,
    })),
  });
}

/** The row shape the query returns, before classification. */
export type RawParityRow = {
  repoFullName: string;
  pullNumber: number;
  action: string;
  findingsCount: number | null;
  reevaluationReason: string | null;
  authorAssociation: string | null;
};

async function queryParityRows(env: unknown, sinceIso: string, untilIso: string): Promise<RawParityRow[]> {
  return safeAll<RawParityRow>(
    env as never,
    `SELECT dr.repo_full_name    AS repoFullName,
            dr.pull_number       AS pullNumber,
            dr.action            AS action,
            dr.findings_count    AS findingsCount,
            dr.reevaluation_reason AS reevaluationReason,
            pr.author_association  AS authorAssociation
       FROM decision_records dr
       LEFT JOIN pull_requests pr
         ON pr.repo_full_name = dr.repo_full_name AND pr.number = dr.pull_number
      WHERE dr.created_at >= ? AND dr.created_at < ?`,
    sinceIso,
    untilIso,
  );
}
