// #554 gate false-positive telemetry: is the gate PRECISE? This is the evidence a maintainer needs before
// promoting a gate from advisory to block.
//
// MEASUREMENT only — like the #543 outcome-calibration service it NEVER auto-adjusts a gate or score (that
// would change what blocks live PRs; an owner-review decision). It only records + aggregates.
//
// A gate-block is a FALSE POSITIVE when the gate blocked a PR that turned out to be mergeable: the PR was
// blocked and later MERGED anyway. Per gate type (each blocker `code` that fired) we report blocked count,
// blocked-then-merged count, the count maintainers OVERRODE (the strongest false-positive signal — a human
// explicitly judged the block wrong), and a false-positive rate (blocked-then-merged / blocked), null below a
// min sample so a noisy rate is never reported. Inputs already exist: the gate_outcomes ledger (#554, this
// PR) records each block, and closed/merged PRs are retained on the PR row, so terminalOutcome resolves the
// same way outcome-calibration's does.
//
// Privacy: the report carries repo full name + PR-derived counts + gate-type codes ONLY — no actor logins, no
// trust/reward/credibility numbers. Internal/maintainer-authenticated; never publicly exposed.
import { listGateOutcomes, listPullRequests } from "../db/repositories";
import { fetchOfficialGittensorMinerLogins } from "../gittensor/api";
import type { GateOutcomeRecord, PullRequestRecord } from "../types";
import { nowIso } from "../utils/json";

// Below this per-gate-type blocked sample the false-positive rate is too noisy to judge.
const MIN_SAMPLE = 5;

export type GatePrecisionPerType = {
  gateType: string;
  blocked: number;
  blockedThenMerged: number;
  overridden: number;
  falsePositiveRate: number | null;
};

/** #4520: one cohort's fold result -- the SAME shape the blended report already carries, so a dashboard can
 *  render miner/human side by side with the identical component it already uses for the blended totals. */
export type GatePrecisionCohortReport = {
  perGateType: GatePrecisionPerType[];
  overall: { blocked: number; blockedThenMerged: number; falsePositiveRate: number | null };
};

export type GatePrecisionReport = {
  repoFullName: string;
  generatedAt: string;
  windowDays: number | null;
  perGateType: GatePrecisionPerType[];
  overall: { blocked: number; blockedThenMerged: number; falsePositiveRate: number | null };
  signals: string[];
  /** #4520: miner-vs-human split, present only when the caller supplied minerLogins (loadGatePrecisionReport's
   *  includeCohorts option). Purely additive -- never replaces the blended perGateType/overall above, and
   *  every existing caller that doesn't ask for it sees byte-identical output. An outcome whose PR author is
   *  unresolvable or not a confirmed miner falls into `human` (fail-safe: never over-classify as miner). */
  cohorts?: { miner: GatePrecisionCohortReport; human: GatePrecisionCohortReport } | undefined;
};

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// A PR's terminal outcome: merged if it has a merge timestamp; closed (unmerged) if its state is closed
// without one; otherwise still open (no outcome yet). Same logic as outcome-calibration.
function terminalOutcome(pr: PullRequestRecord): "merged" | "closed" | null {
  if (pr.mergedAt) return "merged";
  if (pr.state === "closed") return "closed";
  return null;
}

function sameRepo(a: string | null | undefined, b: string): boolean {
  return (a ?? "").toLowerCase() === b.toLowerCase();
}

/** #4520: the fold core, extracted so buildGatePrecisionReport can run it up to three times (blended, miner,
 *  human) over disjoint outcome subsets without duplicating the accumulation logic. Pure -- the same
 *  MIN_SAMPLE floor is applied independently per call, so a small cohort correctly reads null rather than a
 *  noisy rate. */
function foldGateOutcomes(outcomes: GateOutcomeRecord[], prByNumber: Map<number, PullRequestRecord>): GatePrecisionCohortReport {
  const perType = new Map<string, { blocked: number; blockedThenMerged: number; overridden: number }>();
  let overallBlocked = 0;
  let overallMerged = 0;
  for (const outcome of outcomes) {
    const pr = prByNumber.get(outcome.pullNumber);
    // A blocked PR that later MERGED is a false positive; closed/open are not (the block held or is unresolved).
    const merged = pr ? terminalOutcome(pr) === "merged" : false;
    overallBlocked += 1;
    if (merged) overallMerged += 1;
    for (const code of outcome.blockerCodes) {
      const entry = perType.get(code) ?? { blocked: 0, blockedThenMerged: 0, overridden: 0 };
      entry.blocked += 1;
      if (merged) entry.blockedThenMerged += 1;
      if (outcome.overridden) entry.overridden += 1;
      perType.set(code, entry);
    }
  }

  const perGateType: GatePrecisionPerType[] = [...perType.entries()]
    .map(([gateType, entry]) => ({
      gateType,
      blocked: entry.blocked,
      blockedThenMerged: entry.blockedThenMerged,
      overridden: entry.overridden,
      // Null below the min sample — a 1-of-1 "false positive" is noise, not a precision signal.
      falsePositiveRate: entry.blocked >= MIN_SAMPLE ? round(entry.blockedThenMerged / entry.blocked) : null,
    }))
    .sort((a, b) => b.blocked - a.blocked || a.gateType.localeCompare(b.gateType));

  return {
    perGateType,
    overall: {
      blocked: overallBlocked,
      blockedThenMerged: overallMerged,
      falsePositiveRate: overallBlocked >= MIN_SAMPLE ? round(overallMerged / overallBlocked) : null,
    },
  };
}

/** #4520: true when the outcome's PR author (looked up via prByNumber) is a confirmed miner login. Fail-safe
 *  on every unresolvable path (no PR record, no author) -- defaults to NOT a miner, never the reverse,
 *  matching this codebase's "unconfirmed defaults to human/non-miner" convention throughout. */
function isMinerAuthoredOutcome(outcome: GateOutcomeRecord, prByNumber: Map<number, PullRequestRecord>, minerLogins: ReadonlySet<string>): boolean {
  const authorLogin = prByNumber.get(outcome.pullNumber)?.authorLogin;
  return authorLogin ? minerLogins.has(authorLogin.toLowerCase()) : false;
}

/**
 * Per-gate-type false-positive measurement over recorded gate blocks. Pure. For each block row we look up the
 * PR's terminal outcome; a blocked PR that later MERGED is a false positive. Each blocker `code` on the row
 * contributes to that code's bucket (a block citing two codes counts toward both). Overridden-then-merged is
 * the strongest signal — `overridden` is counted separately per type. When `options.repoFullName` is given,
 * only blocks for that repo are counted. The rate is null below MIN_SAMPLE. When `options.minerLogins` is
 * given (#4520), an additive miner-vs-human `cohorts` split is computed on top of the SAME blended fold;
 * omitting it keeps every existing caller byte-identical.
 */
export function buildGatePrecisionReport(
  outcomes: GateOutcomeRecord[],
  pullRequests: PullRequestRecord[],
  options: { repoFullName?: string; minerLogins?: ReadonlySet<string> } = {},
): Omit<GatePrecisionReport, "repoFullName" | "generatedAt" | "windowDays"> {
  const repoFullName = options.repoFullName;
  // Index PRs by number for an O(1) terminal-outcome lookup, scoped to the repo when one is given.
  const prByNumber = new Map<number, PullRequestRecord>();
  for (const pr of pullRequests) {
    if (repoFullName && !sameRepo(pr.repoFullName, repoFullName)) continue;
    prByNumber.set(pr.number, pr);
  }
  const scoped = repoFullName ? outcomes.filter((o) => sameRepo(o.repoFullName, repoFullName)) : outcomes;

  const { perGateType, overall } = foldGateOutcomes(scoped, prByNumber);

  let cohorts: GatePrecisionReport["cohorts"];
  if (options.minerLogins) {
    const minerLogins = options.minerLogins;
    const minerOutcomes: GateOutcomeRecord[] = [];
    const humanOutcomes: GateOutcomeRecord[] = [];
    for (const outcome of scoped) {
      (isMinerAuthoredOutcome(outcome, prByNumber, minerLogins) ? minerOutcomes : humanOutcomes).push(outcome);
    }
    cohorts = { miner: foldGateOutcomes(minerOutcomes, prByNumber), human: foldGateOutcomes(humanOutcomes, prByNumber) };
  }

  return {
    perGateType,
    overall,
    signals: buildGatePrecisionSignals(perGateType, overall.blocked, overall.blockedThenMerged),
    ...(cohorts ? { cohorts } : {}),
  };
}

export function buildGatePrecisionSignals(perGateType: GatePrecisionPerType[], overallBlocked: number, overallMerged: number): string[] {
  const signals: string[] = [];
  if (overallBlocked < MIN_SAMPLE) {
    signals.push(`Not enough recorded gate blocks to judge precision yet (${overallBlocked} blocked).`);
    return signals;
  }
  signals.push(`${overallMerged} of ${overallBlocked} blocked PRs later merged (${Math.round((overallMerged / overallBlocked) * 100)}% overall false-positive rate).`);
  // Surface the worst per-type rate that cleared the sample bar — the gate a maintainer should hesitate to promote to block.
  const judged = perGateType.filter((type) => type.falsePositiveRate !== null);
  const worst = judged.reduce<GatePrecisionPerType | null>((acc, type) => (acc === null || type.falsePositiveRate! > acc.falsePositiveRate! ? type : acc), null);
  if (worst && worst.falsePositiveRate! > 0) {
    signals.push(`Highest false-positive gate: \`${worst.gateType}\` — ${Math.round(worst.falsePositiveRate! * 100)}% of its ${worst.blocked} blocks merged anyway (${worst.overridden} overridden). Keep it advisory until this drops.`);
  } else {
    signals.push(`No gate type with enough sample is producing false positives — blocked PRs are staying blocked.`);
  }
  return signals;
}

/** Load a repo's gate-block ledger + PRs and assemble the precision report. `includeCohorts` (#4520) fetches
 *  the full confirmed-miner login set ONCE and threads it into buildGatePrecisionReport for the additive
 *  miner-vs-human split; omitted (default) keeps this byte-identical to before the split existed. */
export async function loadGatePrecisionReport(
  env: Env,
  repoFullName: string,
  options: { windowDays?: number; includeCohorts?: boolean } = {},
): Promise<GatePrecisionReport> {
  const [pullRequests, outcomes, minerLogins] = await Promise.all([
    listPullRequests(env, repoFullName),
    listGateOutcomes(env, { repoFullName, ...(options.windowDays !== undefined ? { windowDays: options.windowDays } : {}) }),
    options.includeCohorts ? fetchOfficialGittensorMinerLogins() : Promise.resolve(undefined),
  ]);
  const report = buildGatePrecisionReport(outcomes, pullRequests, { repoFullName, ...(minerLogins ? { minerLogins } : {}) });
  return { repoFullName, generatedAt: nowIso(), windowDays: options.windowDays ?? null, ...report };
}
