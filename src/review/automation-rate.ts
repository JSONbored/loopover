// Weekly automation-rate series (#9727).
//
// "How much of this is actually automated?" is the question every claim about the gate rests on, and it was
// only answerable by ad-hoc query. This publishes it as a standing series, computed from `decision_records`
// -- the anchored ledger -- and nothing else, so an outsider holding the export recomputes the same numbers.
//
// PUBLISHED DEFINITION. A pull request is counted once per week, by the week of its FIRST verdict.
//
//   manual     ANY verdict for that PR shows a human in the decision path:
//                - `action = 'hold'`      -- the gate declined to decide and handed it to a person
//                - `reevaluation_actor`   -- a named person caused a re-evaluation (#9742)
//                - `reevaluation_reason = 'maintainer_request'` -- a human asked for the re-run
//   automated  Every verdict was a merge or close with none of the above: opened, decided, enacted, with
//              no human action in between.
//
// A PR that was held and LATER merged is manual, not automated. The question is whether a human had to act,
// not what the end state was -- counting the final disposition would let the rate be inflated by holding
// everything and then merging it by hand.
//
// BACKFILL HORIZON. The two re-evaluation fields arrived with migration 0204. Before that, only `hold` is
// observable, so a week earlier than the horizon can only UNDER-count manual work. Those weeks are published
// with `basis: "holds_only"` rather than silently mixed in with complete ones -- a series whose definition
// quietly changes partway along is worse than one that says where it changes.

import { safeAll } from "./public-stats";

/**
 * When the re-evaluation provenance fields (`reevaluation_reason`, `reevaluation_actor`) began being
 * written -- migration 0204's ship date. Weeks starting before this can only detect manual work via `hold`.
 *
 * A single dated constant rather than something inferred: "the column did not exist yet" and "this was a
 * first evaluation" both read as NULL, so the data genuinely cannot tell them apart. Stating the date is the
 * honest option; guessing it from the rows would be a fabrication dressed as a derivation.
 */
export const AUTOMATION_RATE_PROVENANCE_HORIZON_ISO = "2026-07-29T00:00:00.000Z";

/** How completely a week could be measured. `full` weeks see every manual signal; `holds_only` weeks predate
 *  the provenance fields and can only under-count manual work. */
export type AutomationWeekBasis = "full" | "holds_only";

export type AutomationRateWeek = {
  /** ISO date of the week's Monday, UTC. */
  weekStart: string;
  /** Distinct pull requests with at least one verdict that week. */
  decided: number;
  automated: number;
  manual: number;
  /** Null when the week decided nothing -- an undefined ratio, not a reassuring 100%. */
  automationRatePct: number | null;
  basis: AutomationWeekBasis;
};

export type AutomationRateSeries = {
  weeks: AutomationRateWeek[];
  /** Totals over every week in the series, on the same definitions. */
  decided: number;
  automated: number;
  automationRatePct: number | null;
  /** Published so a reader can see which weeks are `holds_only` without inspecting each. */
  provenanceHorizon: string;
};

/** One verdict, reduced to the fields the series reads. */
export type AutomationVerdictRow = {
  repoFullName: string;
  pullNumber: number;
  action: string;
  createdAt: string;
  reevaluationReason: string | null;
  reevaluationActor: string | null;
};

/** The UTC Monday of the week containing `iso`, as an ISO date-time. Null when unparseable. */
export function weekStartIso(iso: string): string | null {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  const date = new Date(parsed);
  // getUTCDay: 0=Sunday. Shift so Monday starts the week, matching the other published weekly series.
  const dayOffset = (date.getUTCDay() + 6) % 7;
  const monday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - dayOffset);
  return new Date(monday).toISOString();
}

/** Percent to one decimal, or null when nothing was decided. */
function ratePct(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/** True when this verdict shows a human in the decision path. See the published definition above. */
export function verdictShowsHumanAction(row: Pick<AutomationVerdictRow, "action" | "reevaluationReason" | "reevaluationActor">): boolean {
  if (row.action === "hold") return true;
  if (typeof row.reevaluationActor === "string" && row.reevaluationActor.trim() !== "") return true;
  return row.reevaluationReason === "maintainer_request";
}

/**
 * Build the weekly series from a window's verdict rows. PURE, so every definition above is testable against
 * a hand-written table -- which is also what lets an outsider check the arithmetic without our database.
 */
export function buildAutomationRateSeries(rows: readonly AutomationVerdictRow[]): AutomationRateSeries {
  // Fold verdicts to PULL REQUESTS first: the unit of the question is "did a human have to act on this PR",
  // and a PR with five verdicts is still one PR. Its week is the week of its FIRST verdict, so a PR does not
  // migrate between weeks as it accrues re-evaluations.
  const byPull = new Map<string, { firstSeen: string; human: boolean }>();
  for (const row of rows) {
    const key = `${row.repoFullName}#${row.pullNumber}`;
    const existing = byPull.get(key);
    const human = verdictShowsHumanAction(row);
    if (!existing) {
      byPull.set(key, { firstSeen: row.createdAt, human });
      continue;
    }
    existing.human = existing.human || human;
    if (Date.parse(row.createdAt) < Date.parse(existing.firstSeen)) existing.firstSeen = row.createdAt;
  }

  const horizon = Date.parse(AUTOMATION_RATE_PROVENANCE_HORIZON_ISO);
  const weeks = new Map<string, { decided: number; automated: number; manual: number }>();
  for (const entry of byPull.values()) {
    const week = weekStartIso(entry.firstSeen);
    if (week === null) continue;
    const bucket = weeks.get(week) ?? { decided: 0, automated: 0, manual: 0 };
    bucket.decided += 1;
    if (entry.human) bucket.manual += 1;
    else bucket.automated += 1;
    weeks.set(week, bucket);
  }

  const ordered = [...weeks.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, bucket]) => ({
      weekStart,
      decided: bucket.decided,
      automated: bucket.automated,
      manual: bucket.manual,
      automationRatePct: ratePct(bucket.automated, bucket.decided),
      basis: (Date.parse(weekStart) >= horizon ? "full" : "holds_only") as AutomationWeekBasis,
    }));

  const decided = ordered.reduce((sum, week) => sum + week.decided, 0);
  const automated = ordered.reduce((sum, week) => sum + week.automated, 0);
  return {
    weeks: ordered,
    decided,
    automated,
    automationRatePct: ratePct(automated, decided),
    provenanceHorizon: AUTOMATION_RATE_PROVENANCE_HORIZON_ISO,
  };
}

/** Trailing weeks the series covers, per #9727's "at least the trailing 12 weeks where data permits". */
const AUTOMATION_RATE_WEEKS = 12;

/**
 * Read the trailing window's verdicts and build the series (#9727).
 *
 * `fetchRows` is overridable so the whole path is testable without a database; it defaults to the real read,
 * so the production caller passes only `env` and cannot forget to wire it.
 */
export async function loadAutomationRateSeries(
  env: unknown,
  options: {
    weeks?: number | undefined;
    nowMs?: number | undefined;
    fetchRows?: ((sinceIso: string) => Promise<readonly AutomationVerdictRow[]>) | undefined;
  } = {},
): Promise<AutomationRateSeries> {
  const nowMs = options.nowMs ?? Date.now();
  const requested = options.weeks;
  const weeks = typeof requested === "number" && Number.isFinite(requested) && requested > 0 ? Math.trunc(requested) : AUTOMATION_RATE_WEEKS;
  const sinceIso = new Date(nowMs - weeks * 7 * 86_400_000).toISOString();
  const fetchRows = options.fetchRows ?? ((since: string) => queryAutomationRows(env, since));
  const rows = await fetchRows(sinceIso).catch(() => [] as AutomationVerdictRow[]);
  return buildAutomationRateSeries(rows);
}

async function queryAutomationRows(env: unknown, sinceIso: string): Promise<AutomationVerdictRow[]> {
  return safeAll<AutomationVerdictRow>(
    env as never,
    `SELECT repo_full_name      AS repoFullName,
            pull_number         AS pullNumber,
            action              AS action,
            created_at          AS createdAt,
            reevaluation_reason AS reevaluationReason,
            reevaluation_actor  AS reevaluationActor
       FROM decision_records
      WHERE created_at >= ?`,
    sinceIso,
  );
}
