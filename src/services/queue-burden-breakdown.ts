import { sanitizePublicComment } from "../github/commands";
import type { QueueHealth } from "../signals/engine";

// ─── Queue burden breakdown (explanation family) ─────────────────────────────────────────────────
// A pure projection over a computed {@link QueueHealth} that decomposes the otherwise-opaque
// `burdenScore` into its weighted, observable contributors and names the single highest-leverage lever
// a maintainer can pull to bring queue pressure down fastest. Sibling of `score-breakdown.ts`,
// `miner-dashboard-recommendations.ts`, and `agent-action-explanation-card.ts`: deterministic, no I/O,
// no GitHub fetch. Public-safe by construction — it reports observable counts, relative shares, and
// bands only, and routes every rendered string through `sanitizePublicComment`.

export type QueueBurdenBand = "credit" | "none" | "low" | "moderate" | "high";

export type QueueBurdenComponent = {
  /** The QueueHealth signal this contribution is derived from. */
  component: string;
  /** Observable signal count (open PRs, unlinked PRs, collision clusters, …). */
  count: number;
  /** Signed per-unit weight this signal carries in the burden formula (the reviewable credit is negative). */
  weightPerUnit: number;
  /** `count * weightPerUnit` — positive for a penalty, negative for the reviewable credit. */
  contribution: number;
  /** Share of total positive penalty (0–100). For the credit it is the percentage of penalty it offsets. */
  sharePercent: number;
  band: QueueBurdenBand;
  summary: string;
  lever: string;
  /** 0–100 ranking weight used to pick the single highest-leverage improvement lever. */
  leverageScore: number;
};

export type QueueBurdenBreakdown = {
  repoFullName: string;
  generatedAt: string;
  /** The authoritative (already clamped) burden score carried on the QueueHealth. */
  burdenScore: number;
  level: QueueHealth["level"];
  /** Pre-clamp signed sum of every contribution (penalties minus the reviewable credit). */
  rawBurden: number;
  /** True when the raw sum fell outside the 0–100 band and the engine clamped it. */
  clamped: boolean;
  /** Sum of the positive penalty contributions. */
  totalPenalty: number;
  /** Absolute size of the reviewable credit that offsets the penalties. */
  totalCredit: number;
  components: QueueBurdenComponent[];
  highestLeverageLever: { component: string; lever: string; reason: string };
  summary: string;
};

// These per-unit weights MIRROR buildQueueHealth() in src/signals/engine.ts. A drift-guard test rebuilds a
// QueueHealth through buildQueueHealth and asserts this module recomposes the same burdenScore, so any change
// to the engine weights fails the suite instead of silently producing a wrong breakdown.
const PENALTY_DESCRIPTORS: ReadonlyArray<{
  component: string;
  weightPerUnit: number;
  count: (health: QueueHealth) => number;
  describe: (count: number) => { summary: string; lever: string };
}> = [
  {
    component: "unlinkedPullRequests",
    weightPerUnit: 8,
    count: (health) => health.signals.unlinkedPullRequests,
    describe: (count) =>
      count > 0
        ? {
            summary: `${count} open pull request(s) lack a linked issue, the heaviest per-PR burden factor.`,
            lever: "Ask contributors to link a closing issue or state explicit no-issue intent so unlinked PRs stop driving burden.",
          }
        : {
            summary: "Every open pull request carries linked-issue context, so this factor adds no burden.",
            lever: "Keep requiring a linked issue or a clear no-issue rationale so this factor stays at zero.",
          },
  },
  {
    component: "collisionClusters",
    weightPerUnit: 10,
    count: (health) => health.signals.collisionClusters,
    describe: (count) =>
      count > 0
        ? {
            summary: `${count} duplicate or overlapping work cluster(s) carry the highest per-unit burden weight.`,
            lever: "Resolve overlapping submissions before spending detailed review time to cut collision burden fastest.",
          }
        : {
            summary: "No duplicate or overlapping work clusters were detected, so this factor adds no burden.",
            lever: "Keep deduplicating incoming work early so collision burden stays at zero.",
          },
  },
  {
    component: "openPullRequests",
    weightPerUnit: 6,
    count: (health) => health.signals.openPullRequests,
    describe: (count) =>
      count > 0
        ? {
            summary: `${count} open pull request(s) contribute baseline review load.`,
            lever: "Land or close open pull requests to reduce the baseline queue load.",
          }
        : {
            summary: "There are no open pull requests adding baseline load.",
            lever: "No action needed; baseline pull-request load is already at zero.",
          },
  },
  {
    component: "stalePullRequests",
    weightPerUnit: 6,
    count: (health) => health.signals.stalePullRequests,
    describe: (count) =>
      count > 0
        ? {
            summary: `${count} open pull request(s) have stalled without an update for at least 14 days.`,
            lever: "Review, nudge, or close stale pull requests so they stop accruing burden.",
          }
        : {
            summary: "No open pull requests have stalled past the 14-day staleness threshold.",
            lever: "Keep pull requests moving so none cross the staleness threshold.",
          },
  },
  {
    component: "over30DayPullRequests",
    weightPerUnit: 4,
    count: (health) => health.signals.ageBuckets.over30Days,
    describe: (count) =>
      count > 0
        ? {
            summary: `${count} open pull request(s) have aged past 30 days.`,
            lever: "Resolve the long-aged pull requests to clear the oldest backlog in the queue.",
          }
        : {
            summary: "No open pull requests have aged past 30 days.",
            lever: "Keep clearing aged work so none crosses the 30-day mark.",
          },
  },
  {
    component: "openIssues",
    weightPerUnit: 1,
    count: (health) => health.signals.openIssues,
    describe: (count) =>
      count > 0
        ? {
            summary: `${count} open issue(s) add minor triage load.`,
            lever: "Triage or close resolved open issues to trim residual queue load.",
          }
        : {
            summary: "There are no open issues adding triage load.",
            lever: "No action needed; open-issue triage load is already at zero.",
          },
  },
];

const REVIEWABLE_CREDIT_PER_UNIT = -2;

function penaltyBand(count: number, sharePercent: number): QueueBurdenBand {
  if (count <= 0) return "none";
  if (sharePercent >= 40) return "high";
  if (sharePercent >= 15) return "moderate";
  return "low";
}

function shareOf(contribution: number, totalPenalty: number): number {
  if (totalPenalty <= 0) return 0;
  return Math.round((Math.abs(contribution) / totalPenalty) * 100);
}

function creditComponent(health: QueueHealth, totalPenalty: number): QueueBurdenComponent {
  const count = health.signals.likelyReviewablePullRequests;
  const contribution = count * REVIEWABLE_CREDIT_PER_UNIT;
  const sharePercent = shareOf(contribution, totalPenalty);
  return {
    component: "likelyReviewablePullRequests",
    count,
    weightPerUnit: REVIEWABLE_CREDIT_PER_UNIT,
    contribution,
    sharePercent,
    band: "credit",
    summary:
      count > 0
        ? `${count} open pull request(s) look readily reviewable and reduce net queue burden.`
        : "No open pull requests are currently counted as readily reviewable, so nothing is offsetting burden.",
    lever:
      count > 0
        ? "Keep pull requests linked and fresh so they stay readily reviewable and keep offsetting burden."
        : "Help open pull requests become linked and fresh so they start offsetting queue burden.",
    // The credit is already helping; it is never the lever a maintainer pulls to REDUCE burden, so it stays
    // out of the highest-leverage ranking.
    leverageScore: 0,
  };
}

function pickHighestLeverage(components: QueueBurdenComponent[]): QueueBurdenBreakdown["highestLeverageLever"] {
  // Rank by share of burden, then break ties toward the heavier per-unit weight (reducing one high-weight item
  // removes more burden per action, so it is the better lever), and finally by name purely for determinism.
  const ranked = [...components].sort(
    (left, right) =>
      right.leverageScore - left.leverageScore ||
      right.weightPerUnit - left.weightPerUnit ||
      left.component.localeCompare(right.component),
  );
  const top = ranked[0]!;
  // When no penalty is active (every leverageScore is 0), the sort tie-break would otherwise surface an
  // arbitrary alphabetically-first component as "the lever" — which is misleading because there is nothing to
  // reduce. Return an explicit no-op lever instead so the breakdown stays honest for a healthy queue.
  if (top.leverageScore <= 0) {
    return {
      component: "none",
      lever: sanitizePublicComment("No queue-burden lever needs attention; there are no active contributors to reduce."),
      reason: sanitizePublicComment("Queue burden has no active penalty contributors right now, so there is no pressing lever to pull."),
    };
  }
  const reason =
    top.band === "high"
      ? `${top.component} is the dominant queue-burden contributor right now.`
      : `${top.component} is the largest remaining queue-burden contributor.`;
  return {
    component: top.component,
    lever: top.lever,
    reason: sanitizePublicComment(reason),
  };
}

/**
 * Pure projection over a {@link QueueHealth} that explains how the queue `burdenScore` breaks down into its
 * weighted, observable contributors and names the single highest-leverage lever to reduce queue pressure.
 */
export function explainQueueBurden(health: QueueHealth): QueueBurdenBreakdown {
  const penalties = PENALTY_DESCRIPTORS.map((descriptor) => {
    const count = descriptor.count(health);
    const contribution = count * descriptor.weightPerUnit;
    return { descriptor, count, contribution };
  });
  const totalPenalty = penalties.reduce((sum, entry) => sum + entry.contribution, 0);

  const penaltyComponents: QueueBurdenComponent[] = penalties.map(({ descriptor, count, contribution }) => {
    const sharePercent = shareOf(contribution, totalPenalty);
    const copy = descriptor.describe(count);
    return {
      component: descriptor.component,
      count,
      weightPerUnit: descriptor.weightPerUnit,
      contribution,
      sharePercent,
      band: penaltyBand(count, sharePercent),
      summary: copy.summary,
      lever: copy.lever,
      // A penalty's leverage is exactly its share of the burden — the biggest contributor is the best lever.
      leverageScore: sharePercent,
    };
  });

  const credit = creditComponent(health, totalPenalty);
  const totalCredit = Math.abs(credit.contribution);
  const rawBurden = totalPenalty + credit.contribution;
  // The engine clamps burden to 0–100. The lower bound is unreachable in practice: every open PR adds 6 to the
  // penalty while its reviewable credit only subtracts 2 (and reviewable PRs never exceed open PRs), so the
  // penalties always dominate the credit. Only the upper clamp is observable here.
  const clamped = rawBurden > 100;

  const components = [...penaltyComponents, credit].map((entry) => ({
    ...entry,
    summary: sanitizePublicComment(entry.summary),
    lever: sanitizePublicComment(entry.lever),
  }));

  const highestLeverageLever = pickHighestLeverage(components);
  const summary =
    highestLeverageLever.component === "none"
      ? `Queue burden is ${health.level} with no active contributors to address.`
      : `Queue burden is ${health.level}; ${highestLeverageLever.component} is the leading factor to address.`;

  return {
    repoFullName: health.repoFullName,
    generatedAt: health.generatedAt,
    burdenScore: health.burdenScore,
    level: health.level,
    rawBurden,
    clamped,
    totalPenalty,
    totalCredit,
    components,
    highestLeverageLever,
    summary: sanitizePublicComment(summary),
  };
}
