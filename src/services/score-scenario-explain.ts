import { sanitizePublicComment } from "../github/commands";
import type { ScoreGateDelta, ScorePreviewResult, ScoreScenarioPreview } from "../scoring/preview";

export type ScenarioScoreabilityBand = "blocked" | "conditionally_scoreable" | "scoreable" | "hold";

export type ScenarioCard = {
  name: ScoreScenarioPreview["name"];
  source: ScoreScenarioPreview["source"];
  band: ScenarioScoreabilityBand;
  rank: number;
  summary: string;
  lever: string;
  assumptions: string[];
  unlockDelta: string;
  leverageScore: number;
};

export type GateDeltaNarrative = {
  gate: ScoreGateDelta["gate"];
  narrative: string;
  lever: string;
};

export type ScoreScenarioExplanation = {
  repoFullName: string;
  scoreabilityStatus: ScorePreviewResult["scoreabilityStatus"];
  effectiveEstimatedScore: number;
  headline: string;
  scenarios: ScenarioCard[];
  gateDeltaNarratives: GateDeltaNarrative[];
  recommendedPath: {
    scenario: string;
    lever: string;
    reason: string;
    orderedLevers: string[];
  };
};

const SCENARIO_LABELS: Record<ScoreScenarioPreview["name"], string> = {
  current: "Current state",
  cleanGates: "Gates cleared",
  afterPendingMerges: "After pending merges land",
  afterApprovedPrsMerge: "After approved PRs merge",
  afterStalePrsClose: "After stale PRs close",
  linkedIssueFixed: "Linked issue validated",
  bestReasonableCase: "Best reasonable case",
};

const SCENARIO_LEVERS: Record<ScoreScenarioPreview["name"], string> = {
  current: "Review current blockers before opening more work.",
  cleanGates: "Clear open-PR, open-issue, credibility, and history gates before relying on full-strength previews.",
  afterPendingMerges: "Land or close pending merged/closed PRs to relieve open-PR pressure.",
  afterApprovedPrsMerge: "Merge approved open PRs already observed in cached GitHub state.",
  afterStalePrsClose: "Close stale open PRs before opening more concurrent contributions.",
  linkedIssueFixed: "Validate linked issue context with solved-by-PR evidence or refresh mirror metadata.",
  bestReasonableCase: "Combine the most plausible gate cleanups that remain achievable without speculative assumptions.",
};

const GATE_DELTA_LEVERS: Record<ScoreGateDelta["gate"], string> = {
  open_pr_threshold: "Land, merge, or close excess open PRs to move this gate.",
  open_issue_threshold: "Close excess open issues to drop back within the spam threshold.",
  merged_pr_history_floor: "Build more merged PR history in this repo.",
  issue_discovery_validity_floor: "Improve valid solved-issue history or issue credibility.",
  credibility_floor: "Build cleaner merged history before relying on full-strength previews.",
  linked_issue_multiplier: "Validate linked issue eligibility or remove invalid assumptions.",
};

function bandForScenario(scenario: ScoreScenarioPreview, currentScore: number): ScenarioScoreabilityBand {
  if (scenario.blockedBy.some((blocker) => blocker.code === "inactive_allocation")) return "hold";
  const hasBlocker = scenario.blockedBy.some((blocker) => blocker.severity === "blocker");
  if (scenario.effectiveEstimatedScore > 0 && !hasBlocker) return "scoreable";
  if (scenario.name !== "current" && scenario.effectiveEstimatedScore > currentScore) return "conditionally_scoreable";
  return "blocked";
}

function leverageScoreForScenario(scenario: ScoreScenarioPreview, currentScore: number): number {
  if (scenario.name === "current") return 0;
  const delta = scenario.effectiveEstimatedScore - currentScore;
  if (delta <= 0) return 0;
  const band = bandForScenario(scenario, currentScore);
  let score = Math.round(delta * 10);
  if (band === "scoreable") score += 100;
  else if (band === "conditionally_scoreable") score += 50;
  if (scenario.source === "github_observed") score += 25;
  else if (scenario.source === "user_supplied") score += 15;
  return score;
}

function unlockDeltaText(scenario: ScoreScenarioPreview, currentScore: number): string {
  const delta = scenario.effectiveEstimatedScore - currentScore;
  if (scenario.name === "current" || delta === 0) {
    return "No projected change versus the current preview.";
  }
  if (delta > 0) {
    return "Projected preview strength improves versus current (higher effective estimate).";
  }
  return "Projected preview strength does not improve versus current.";
}

function scenarioSummary(scenario: ScoreScenarioPreview, band: ScenarioScoreabilityBand): string {
  const label = SCENARIO_LABELS[scenario.name];
  if (band === "scoreable") {
    return `${label} clears blocking gates and reaches a scoreable preview under stated assumptions.`;
  }
  if (band === "conditionally_scoreable") {
    return `${label} improves the preview versus current state but may still leave reducers or context blockers.`;
  }
  if (band === "hold") {
    return `${label} cannot be evaluated while repo allocation or registration is inactive.`;
  }
  const blockerCodes = scenario.blockedBy.filter((blocker) => blocker.severity === "blocker").map((blocker) => blocker.code);
  return blockerCodes.length > 0
    ? `${label} remains blocked by ${blockerCodes.join(", ")} under stated assumptions.`
    : `${label} remains blocked or reduced under stated assumptions.`;
}

function buildScenarioCards(preview: ScorePreviewResult): ScenarioCard[] {
  const currentScore = preview.effectiveEstimatedScore;
  const ranked = preview.scenarioPreviews
    .filter((scenario) => scenario.name !== "current")
    .map((scenario) => {
      const band = bandForScenario(scenario, currentScore);
      const leverageScore = leverageScoreForScenario(scenario, currentScore);
      return {
        name: scenario.name,
        source: scenario.source,
        band,
        rank: 0,
        summary: scenarioSummary(scenario, band),
        lever: SCENARIO_LEVERS[scenario.name],
        assumptions: scenario.assumptions,
        unlockDelta: unlockDeltaText(scenario, currentScore),
        leverageScore,
      };
    })
    .sort((left, right) => right.leverageScore - left.leverageScore || left.name.localeCompare(right.name))
    .map((card, index) => ({ ...card, rank: index + 1 }));

  return ranked.map((card) => ({
    ...card,
    summary: sanitizePublicComment(card.summary),
    lever: sanitizePublicComment(card.lever),
    assumptions: card.assumptions.map((assumption) => sanitizePublicComment(assumption)),
    unlockDelta: sanitizePublicComment(card.unlockDelta),
  }));
}

function gateDeltaNarrativesFor(preview: ScorePreviewResult): GateDeltaNarrative[] {
  return preview.gateDeltas.map((delta) => ({
    gate: delta.gate,
    narrative: sanitizePublicComment(`${delta.explanation} Current: ${delta.current}. Projected: ${delta.projected}.`),
    lever: sanitizePublicComment(GATE_DELTA_LEVERS[delta.gate] ?? "Review this gate before proceeding."),
  }));
}

function headlineFor(preview: ScorePreviewResult, scenarios: ScenarioCard[]): string {
  if (preview.scoreabilityStatus === "scoreable") {
    return sanitizePublicComment("Current preview is scoreable; scenario cards show optional cleanup paths if concurrent pressure rises.");
  }
  if (preview.scoreabilityStatus === "hold") {
    return sanitizePublicComment("Preview is on hold until repo registration or allocation is active.");
  }
  const hasUnlock = scenarios.some((card) => card.leverageScore > 0);
  if (!hasUnlock) {
    return sanitizePublicComment("No scenario path improves the current preview; address current blockers directly.");
  }
  if (preview.scoreabilityStatus === "conditionally_scoreable") {
    return sanitizePublicComment("Current preview is conditionally scoreable; ranked scenarios show which cleanup path unlocks the most headroom.");
  }
  return sanitizePublicComment("Current preview is blocked; ranked scenarios show the highest-leverage cleanup sequence.");
}

function recommendedPathFor(preview: ScorePreviewResult, scenarios: ScenarioCard[]): ScoreScenarioExplanation["recommendedPath"] {
  const top = scenarios.find((card) => card.leverageScore > 0);
  if (!top) {
    return {
      scenario: "current",
      lever: sanitizePublicComment(SCENARIO_LEVERS.current),
      reason: sanitizePublicComment("No non-current scenario improves the current preview under supplied assumptions."),
      orderedLevers: [sanitizePublicComment(SCENARIO_LEVERS.current)],
    };
  }
  const orderedLevers = scenarios.filter((card) => card.leverageScore > 0).map((card) => card.lever);
  const reason =
    top.band === "scoreable"
      ? `${top.name} is the strongest unlock path because it clears blocking gates under ${top.source.replace(/_/g, " ")} assumptions.`
      : top.band === "conditionally_scoreable"
        ? `${top.name} is the largest improvement lever even though reducers or context blockers may remain.`
        : `${top.name} is the best ranked scenario, but blocking gates may still apply after this cleanup.`;
  return {
    scenario: top.name,
    lever: top.lever,
    reason: sanitizePublicComment(reason),
    orderedLevers,
  };
}

/**
 * Pure projection over a {@link ScorePreviewResult} that explains what-if scenario previews
 * and gate deltas in plain language and ranks the highest-leverage cleanup path.
 */
export function explainScoreScenarios(preview: ScorePreviewResult): ScoreScenarioExplanation {
  const scenarios = buildScenarioCards(preview);
  return {
    repoFullName: preview.repoFullName,
    scoreabilityStatus: preview.scoreabilityStatus,
    effectiveEstimatedScore: preview.effectiveEstimatedScore,
    headline: headlineFor(preview, scenarios),
    scenarios,
    gateDeltaNarratives: gateDeltaNarrativesFor(preview),
    recommendedPath: recommendedPathFor(preview, scenarios),
  };
}
