import { sanitizePublicComment } from "../github/commands";
import type { ScoreGateBlocker, ScorePreviewResult, ScoreScenarioPreview } from "../scoring/preview";

/**
 * Renders scenario-simulator output ({@link ScorePreviewResult}) into concise summaries
 * for humans and MCP/API/control-panel clients.
 *
 * Two visibilities are produced from the same input:
 * - `public_safe`: safe for GitHub-facing and unauthenticated surfaces. Never exposes
 *   reward estimates, public score prediction, wallet, hotkey, raw trust, private
 *   reviewability, or private scoreability. Blocker and reason text use generic,
 *   code-keyed phrasing so no scores or private counts leak.
 * - `private`: for authenticated planning surfaces. May include scenario score deltas
 *   and exact blocker detail, but still scrubs wallet/hotkey/raw-trust language.
 *
 * Summaries are advisory only — they never file issues, open PRs, comment, label,
 * close, or merge.
 */
export type ScenarioSummaryVisibility = "public_safe" | "private";

export type RenderedScenario = {
  name: ScoreScenarioPreview["name"];
  label: string;
  source: ScoreScenarioPreview["source"];
  reasons: string[];
  assumptions: string[];
  blockers: string[];
};

export type ScenarioSummary = {
  visibility: ScenarioSummaryVisibility;
  repoFullName: string;
  generatedAt: string;
  rankedScenarios: RenderedScenario[];
  nextSafeAction: string;
  summary: string;
};

/** Structural subset of {@link ScorePreviewResult} the renderer consumes. */
export type ScenarioSummaryScenario = Pick<
  ScoreScenarioPreview,
  "name" | "source" | "assumptions" | "blockedBy" | "effectiveEstimatedScore" | "deltaExplanation"
>;

export type ScenarioSummarySource = Pick<ScorePreviewResult, "repoFullName" | "generatedAt" | "scoreabilityStatus" | "recommendation"> & {
  scenarioPreviews: ScenarioSummaryScenario[];
};

const SCENARIO_LABELS: Record<ScoreScenarioPreview["name"], string> = {
  current: "Current state",
  cleanGates: "If open-PR and credibility gates clear",
  afterPendingMerges: "After pending PRs merge or close",
  afterApprovedPrsMerge: "After approved PRs merge",
  afterStalePrsClose: "After stale PRs close",
  linkedIssueFixed: "With a validated linked issue",
  bestReasonableCase: "Best reasonable near-term case",
};

const SCENARIO_PUBLIC_REASON: Record<ScoreScenarioPreview["name"], string> = {
  current: "Baseline from current cached repo and contributor state.",
  cleanGates: "Assumes open-PR pressure and credibility gates are cleared.",
  afterPendingMerges: "Assumes pending PRs reach a terminal state, easing open-PR pressure.",
  afterApprovedPrsMerge: "Assumes approved PRs land, reducing concurrent open work.",
  afterStalePrsClose: "Assumes stale PRs are closed, reducing queue pressure.",
  linkedIssueFixed: "Assumes the linked issue is validated with solved-by-PR evidence.",
  bestReasonableCase: "Combines plausible near-term cleanup of the noted conditions.",
};

const PUBLIC_BLOCKER_TEXT: Record<ScoreGateBlocker["code"], string> = {
  repo_not_registered: "Repository is not registered yet.",
  inactive_allocation: "Repository has no active allocation in the current registry.",
  base_token_gate: "The change may be too small or unclear to qualify yet.",
  open_pr_threshold: "Too many open PRs; land or close some before opening more.",
  credibility_floor: "Contributor track-record evidence is still building.",
  review_penalty: "Review churn is reducing readiness.",
  metadata_only: "Preview used metadata-only inputs, so estimates are rough.",
  linked_issue_invalid: "Linked issue context could not be validated.",
  linked_issue_unvalidated: "Linked issue context is not yet validated.",
  branch_ineligible: "Branch is not eligible for linked-issue assumptions.",
  branch_eligibility_missing: "Branch eligibility metadata needs a refresh.",
  duplicate_risk: "Potential duplicate work detected; verify there is no conflicting issue or PR before proceeding.",
  stale_work: "Stale open work detected; consider closing stale PRs before opening new contributions.",
};

const PUBLIC_STATUS_SUMMARY: Record<ScorePreviewResult["scoreabilityStatus"], string> = {
  blocked: "This work is currently blocked from contributing; resolve the blockers first.",
  hold: "Hold this work until the noted conditions change.",
  conditionally_scoreable: "This work can move forward once the noted conditions are met.",
  scoreable: "This work looks ready to pursue.",
};

const PRIVATE_STATUS_SUMMARY: Record<ScorePreviewResult["scoreabilityStatus"], string> = {
  blocked: "Scoreability is blocked; clear the listed blockers before relying on any projection.",
  hold: "Scoreability is on hold pending the noted conditions.",
  conditionally_scoreable: "Conditionally scoreable once the noted conditions are met.",
  scoreable: "Scoreable from the current cached planning context.",
};

const DEFAULT_NEXT_SAFE_ACTION = "No blocking action required; keep validating locally before opening a PR.";

/**
 * Private-surface scrubber. Authenticated planning surfaces may keep score-planning
 * language and exact blocker detail, but must never carry secret/financial material.
 */
function scrubPrivateSecrets(text: string): string {
  return text.replace(/\b(wallet|hotkey|coldkey|mnemonic|seed phrase|private key|raw trust|trust score)\b/gi, "[redacted]");
}

function rankScenarios(scenarios: ScenarioSummaryScenario[]): ScenarioSummaryScenario[] {
  const order: ScoreScenarioPreview["name"][] = [
    "bestReasonableCase",
    "linkedIssueFixed",
    "afterApprovedPrsMerge",
    "afterPendingMerges",
    "afterStalePrsClose",
    "cleanGates",
    "current",
  ];
  return [...scenarios].sort(
    (left, right) =>
      right.effectiveEstimatedScore - left.effectiveEstimatedScore || order.indexOf(left.name) - order.indexOf(right.name) || left.name.localeCompare(right.name),
  );
}

function publicBlockers(blockedBy: ScoreGateBlocker[]): string[] {
  // Public surface: generic, code-keyed phrasing only. No counts, scores, or thresholds.
  return [...new Set(blockedBy.filter((blocker) => blocker.severity !== "context").map((blocker) => PUBLIC_BLOCKER_TEXT[blocker.code]))];
}

function privateBlockers(blockedBy: ScoreGateBlocker[]): string[] {
  // Private surface: exact detail, still scrubbed of wallet/hotkey/raw-trust language.
  return blockedBy.map((blocker) => scrubPrivateSecrets(blocker.detail));
}

function renderScenario(scenario: ScenarioSummaryScenario, visibility: ScenarioSummaryVisibility): RenderedScenario {
  const isPublic = visibility === "public_safe";
  const reasons = isPublic
    ? [SCENARIO_PUBLIC_REASON[scenario.name]]
    : [scrubPrivateSecrets(scenario.deltaExplanation)].filter((line) => line.length > 0);
  return {
    name: scenario.name,
    label: SCENARIO_LABELS[scenario.name],
    source: scenario.source,
    reasons,
    assumptions: scenario.assumptions.map((line) => (isPublic ? sanitizePublicComment(line) : scrubPrivateSecrets(line))),
    blockers: isPublic ? publicBlockers(scenario.blockedBy) : privateBlockers(scenario.blockedBy),
  };
}

function nextSafeActionFrom(actions: string[]): string {
  const first = actions.find((action) => action.trim().length > 0);
  // The next safe action is always sanitized; it never includes publication or write steps.
  return first ? sanitizePublicComment(first) : DEFAULT_NEXT_SAFE_ACTION;
}

export function renderScenarioSummary(source: ScenarioSummarySource, options: { visibility: ScenarioSummaryVisibility }): ScenarioSummary {
  const { visibility } = options;
  const rankedScenarios = rankScenarios(source.scenarioPreviews).map((scenario) => renderScenario(scenario, visibility));
  const statusSummary = visibility === "public_safe" ? PUBLIC_STATUS_SUMMARY[source.scoreabilityStatus] : PRIVATE_STATUS_SUMMARY[source.scoreabilityStatus];
  return {
    visibility,
    repoFullName: source.repoFullName,
    generatedAt: source.generatedAt,
    rankedScenarios,
    nextSafeAction: nextSafeActionFrom(source.recommendation.actions),
    summary: statusSummary,
  };
}
