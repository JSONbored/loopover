import { sanitizePublicComment } from "../github/commands";
import type { QueueHealth, RoleContext } from "../signals/engine";

/**
 * Models how opening another PR affects repo queue pressure and contributor strategy.
 *
 * Compares three strategy options — opening new work, waiting, or cleaning up existing
 * work first — using repo queue and maintainer-lane signals. Each option separates known
 * facts from assumptions and explains likely blockers and tradeoffs WITHOUT any payout,
 * reward, or private-scoreability claims.
 *
 * Scoped to open-PR pressure only: linked-issue eligibility and duplicate/stale blockers
 * are handled by separate services. Advisory only — never opens PRs or takes GitHub action.
 */
export type OpenPrStrategyOption = "open_new_work" | "wait" | "cleanup_first";

export type OpenPrQueuePressure = "low" | "medium" | "high" | "critical" | "unknown";

export type OpenPrStrategyScenario = {
  option: OpenPrStrategyOption;
  label: string;
  rank: number;
  recommended: boolean;
  facts: string[];
  assumptions: string[];
  tradeoffs: string[];
  blockers: string[];
};

export type OpenPrPressureSimulation = {
  repoFullName: string;
  generatedAt: string;
  lane: "contributor" | "maintainer";
  queuePressure: OpenPrQueuePressure;
  recommendedOption: OpenPrStrategyOption;
  scenarios: OpenPrStrategyScenario[];
  summary: string;
};

export type OpenPrPressureInput = {
  repoFullName: string;
  generatedAt: string;
  queueHealth: QueueHealth | null;
  roleContext: RoleContext;
  contributorOpenPrCount?: number | undefined;
};

const OPTION_LABELS: Record<OpenPrStrategyOption, string> = {
  open_new_work: "Open another PR now",
  wait: "Wait before opening more",
  cleanup_first: "Clean up existing work first",
};

const PRESSURE_WEIGHT: Record<OpenPrQueuePressure, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
  unknown: 2,
};

function pressureFor(queueHealth: QueueHealth | null): OpenPrQueuePressure {
  return queueHealth ? queueHealth.level : "unknown";
}

function queueFacts(queueHealth: QueueHealth | null, ownOpenPrs: number): string[] {
  if (!queueHealth) {
    return [`You have ${ownOpenPrs} open PR(s) on this repo.`];
  }
  const { signals } = queueHealth;
  return [
    `Repo queue pressure is ${queueHealth.level}.`,
    `${signals.openPullRequests} open PR(s) and ${signals.openIssues} open issue(s) in the repo queue.`,
    ...(signals.stalePullRequests > 0 ? [`${signals.stalePullRequests} stale PR(s) in the queue.`] : []),
    `You have ${ownOpenPrs} open PR(s) on this repo.`,
  ];
}

// ── Contributor-lane ranking ───────────────────────────────────────────────

function rankContributorOptions(pressure: OpenPrQueuePressure, ownOpenPrs: number): OpenPrStrategyOption[] {
  const hasOwnWork = ownOpenPrs > 0;
  const heavy = PRESSURE_WEIGHT[pressure] >= 2; // high, critical, or unknown
  if (hasOwnWork && heavy) return ["cleanup_first", "wait", "open_new_work"];
  if (hasOwnWork) return ["cleanup_first", "open_new_work", "wait"];
  if (heavy) return ["wait", "open_new_work", "cleanup_first"];
  return ["open_new_work", "wait", "cleanup_first"];
}

function contributorScenario(
  option: OpenPrStrategyOption,
  pressure: OpenPrQueuePressure,
  ownOpenPrs: number,
  queueHealth: QueueHealth | null,
): Pick<OpenPrStrategyScenario, "facts" | "assumptions" | "tradeoffs" | "blockers"> {
  const hasOwnWork = ownOpenPrs > 0;
  const facts = queueFacts(queueHealth, ownOpenPrs);
  if (option === "open_new_work") {
    return {
      facts,
      assumptions: [
        `Opening another PR would add to the current ${pressure} repo queue pressure.`,
        ...(pressure === "unknown" ? ["Queue signals are unavailable, so the pressure impact is an estimate."] : []),
      ],
      tradeoffs: ["Starts new work immediately, but increases concurrent review load on maintainers."],
      blockers: hasOwnWork ? ["You already have open PR(s); landing or closing them first usually clears review faster."] : [],
    };
  }
  if (option === "wait") {
    return {
      facts,
      assumptions: ["Waiting assumes the queue will drain as maintainers review existing work."],
      tradeoffs: ["Avoids adding queue pressure, but delays starting your next contribution."],
      blockers: [],
    };
  }
  // cleanup_first
  return {
    facts,
    assumptions: ["Cleaning up assumes your existing open PR(s) can be advanced, merged, or closed."],
    tradeoffs: ["Reduces your own queue footprint first, but defers new work until existing PR(s) resolve."],
    blockers: hasOwnWork ? [] : ["You have no open PR(s) on this repo, so there is nothing to clean up first."],
  };
}

// ── Maintainer-lane ranking ────────────────────────────────────────────────

function rankMaintainerOptions(pressure: OpenPrQueuePressure): OpenPrStrategyOption[] {
  // Maintainers are not penalized for their own concurrent PRs; the strategy is about repo
  // health. Under critical pressure, triaging the queue first is the priority.
  if (pressure === "critical") return ["cleanup_first", "open_new_work", "wait"];
  return ["open_new_work", "cleanup_first", "wait"];
}

function maintainerScenario(
  option: OpenPrStrategyOption,
  pressure: OpenPrQueuePressure,
  queueHealth: QueueHealth | null,
  ownOpenPrs: number,
): Pick<OpenPrStrategyScenario, "facts" | "assumptions" | "tradeoffs" | "blockers"> {
  const facts = queueFacts(queueHealth, ownOpenPrs);
  if (option === "open_new_work") {
    return {
      facts,
      assumptions: ["As a maintainer-lane author, opening a PR is repo-health work and is not treated as outside-contributor queue load."],
      tradeoffs: ["Keeps repo work moving, but a large maintainer PR can still compete for review attention."],
      blockers: [],
    };
  }
  if (option === "cleanup_first") {
    return {
      facts,
      assumptions: [`Triaging the queue first assumes the ${pressure} pressure can be reduced by reviewing or closing existing PR(s).`],
      tradeoffs: ["Improves overall repo health, but defers your own new work."],
      blockers: [],
    };
  }
  return {
    facts,
    assumptions: ["Waiting is rarely needed in the maintainer lane; repo-health work can usually proceed."],
    tradeoffs: ["Avoids any added load, but maintainer work generally should not be blocked on queue pressure."],
    blockers: [],
  };
}

function sanitizeScenario(scenario: OpenPrStrategyScenario): OpenPrStrategyScenario {
  return {
    ...scenario,
    label: sanitizePublicComment(scenario.label),
    facts: scenario.facts.map((line) => sanitizePublicComment(line)),
    assumptions: scenario.assumptions.map((line) => sanitizePublicComment(line)),
    tradeoffs: scenario.tradeoffs.map((line) => sanitizePublicComment(line)),
    blockers: scenario.blockers.map((line) => sanitizePublicComment(line)),
  };
}

function summarize(lane: "contributor" | "maintainer", recommended: OpenPrStrategyOption, pressure: OpenPrQueuePressure): string {
  const action =
    recommended === "open_new_work" ? "opening another PR is reasonable" : recommended === "wait" ? "waiting before opening more is the safer move" : "clearing existing work first is the better move";
  if (pressure === "unknown") {
    return sanitizePublicComment(`Queue signals are unavailable; ${action} as a conservative default until repo data is refreshed.`);
  }
  return sanitizePublicComment(`With ${pressure} repo queue pressure in the ${lane} lane, ${action}.`);
}

/**
 * Simulate open-PR pressure strategy options. Pure and read-only; no network or state access.
 * Maintainer-lane authors are ranked separately from outside-contributor lanes.
 */
export function simulateOpenPrPressure(input: OpenPrPressureInput): OpenPrPressureSimulation {
  const pressure = pressureFor(input.queueHealth);
  const ownOpenPrs = Math.max(0, input.contributorOpenPrCount ?? 0);
  const lane: "contributor" | "maintainer" = input.roleContext.maintainerLane ? "maintainer" : "contributor";

  const orderedOptions = lane === "maintainer" ? rankMaintainerOptions(pressure) : rankContributorOptions(pressure, ownOpenPrs);

  const scenarios = orderedOptions.map((option, index) => {
    const detail =
      lane === "maintainer"
        ? maintainerScenario(option, pressure, input.queueHealth, ownOpenPrs)
        : contributorScenario(option, pressure, ownOpenPrs, input.queueHealth);
    return sanitizeScenario({
      option,
      label: OPTION_LABELS[option],
      rank: index + 1,
      recommended: index === 0,
      ...detail,
    });
  });

  const recommendedOption = orderedOptions[0]!;
  return {
    repoFullName: input.repoFullName,
    generatedAt: input.generatedAt,
    lane,
    queuePressure: pressure,
    recommendedOption,
    scenarios,
    summary: summarize(lane, recommendedOption, pressure),
  };
}
