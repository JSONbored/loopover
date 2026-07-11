// Gate-outcome breakdown for the maintainer quality dashboard (#539 / #2203). Pure aggregation over
// repo-scoped `agent.action.{merge,close,hold}` audit rows — auto-merged, auto-closed, and held/manual
// terminal dispositions only. Public-safe: counts and rates, never reward/wallet/score fields.

export const GATE_OUTCOME_BREAKDOWN_WINDOW_DAYS = 30;

const TERMINAL_AUTO_OUTCOMES = new Set(["success", "completed"]);

export type GateOutcomeBreakdownCounts = {
  autoMerged: number;
  autoClosed: number;
  held: number;
};

export type GateOutcomeBreakdownRates = {
  autoMerged: number | null;
  autoClosed: number | null;
  held: number | null;
};

export type GateOutcomeBreakdown = {
  windowDays: number;
  generatedAt: string;
  counts: GateOutcomeBreakdownCounts;
  total: number;
  rates: GateOutcomeBreakdownRates;
  summary: string;
};

export type GateOutcomeAuditRollup = {
  eventType: string;
  outcome: string;
  count: number;
};

/** Map one grouped audit row into a breakdown bucket, or null when it is not a gate-outcome event. Pure. */
export function classifyGateOutcomeAuditBucket(event: Pick<GateOutcomeAuditRollup, "eventType" | "outcome">): keyof GateOutcomeBreakdownCounts | null {
  if (!TERMINAL_AUTO_OUTCOMES.has(event.outcome)) return null;
  if (event.eventType === "agent.action.merge") return "autoMerged";
  if (event.eventType === "agent.action.close") return "autoClosed";
  if (event.eventType === "agent.action.hold") return "held";
  return null;
}

function breakdownRate(count: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((count / total) * 1000) / 10;
}

/** Fold repo-scoped gate-outcome audit rollups into count + rate tiles for the maintainer dashboard. Pure. */
export function buildGateOutcomeBreakdown(args: {
  rollups: ReadonlyArray<GateOutcomeAuditRollup>;
  windowDays?: number | undefined;
  generatedAt: string;
}): GateOutcomeBreakdown {
  const counts: GateOutcomeBreakdownCounts = { autoMerged: 0, autoClosed: 0, held: 0 };
  for (const row of args.rollups) {
    const bucket = classifyGateOutcomeAuditBucket(row);
    if (bucket) counts[bucket] += row.count;
  }
  const windowDays = args.windowDays ?? GATE_OUTCOME_BREAKDOWN_WINDOW_DAYS;
  const total = counts.autoMerged + counts.autoClosed + counts.held;
  const rates: GateOutcomeBreakdownRates = {
    autoMerged: breakdownRate(counts.autoMerged, total),
    autoClosed: breakdownRate(counts.autoClosed, total),
    held: breakdownRate(counts.held, total),
  };
  const summary =
    total === 0
      ? `No gate-outcome audit events in the last ${windowDays} day(s) for the scoped repos.`
      : `${total} gate outcome(s) in the last ${windowDays} day(s): ${counts.autoMerged} auto-merged, ${counts.autoClosed} auto-closed, ${counts.held} held for manual review.`;
  return { windowDays, generatedAt: args.generatedAt, counts, total, rates, summary };
}
