import { sanitizePublicComment } from "../github/commands";
import type { EligibilityPlan } from "../services/eligibility-plan";
import type { OpenPrPressureSimulation, OpenPrStrategyOption } from "../services/open-pr-pressure-scenarios";
import type { ScoreGateBlocker } from "../scoring/preview";
import type { PendingPrScenarioDetection } from "../scoring/pending-pr-scenarios";
import type { AgentScenarioInput } from "./input-model";
import { serializeScenarioInputPublic } from "./input-model";

/**
 * Public-safe rendering of scenario simulator outputs for MCP/API clients and
 * control-panel UIs. Ranked options, rationales, obstacles, assumptions, and
 * next steps are included; all reward, score, wallet, hotkey, trust-score,
 * and private-scoreability data is excluded.
 *
 * Advisory only — never files issues, opens PRs, comments, labels, closes, or merges.
 */

export type RenderedScenarioOption = {
  rank: number;
  label: string;
  rationale: string;
  obstacles: string[];
  assumptions: string[];
  nextStep: string;
  recommended: boolean;
};

export type PublicScenarioSummary = {
  repoFullName: string;
  generatedAt: string;
  advisoryOnly: true;
  notAutonomousPrBot: true;
  notPublicScoring: true;
  headline: string;
  options: RenderedScenarioOption[];
  eligibilityNotes: string[];
  blockerNotes: string[];
  dataClassification: {
    facts: string[];
    assumptions: string[];
    unavailableSignals: string[];
  };
};

export type ScenarioSummaryInput = {
  repoFullName: string;
  generatedAt: string;
  pressureSimulation?: OpenPrPressureSimulation | undefined;
  eligibilityPlan?: EligibilityPlan | undefined;
  pendingDetection?: PendingPrScenarioDetection | undefined;
  publicBlockers?: ScoreGateBlocker[] | undefined;
  scenarioInput?: AgentScenarioInput | undefined;
};

const OPTION_NEXT_STEPS: Record<OpenPrStrategyOption, string> = {
  open_new_work: "Verify linked issue eligibility and branch signals before opening the new PR.",
  wait: "Monitor the repo queue and re-evaluate when pressure drops or existing work lands.",
  cleanup_first: "Review your open PR(s): advance, rebase, or close stale work before opening more.",
};

const PUBLIC_BLOCKER_TEXT: Partial<Record<ScoreGateBlocker["code"], string>> = {
  base_token_gate: "The change size may be too small to meet the contribution threshold.",
  open_pr_threshold: "Too many concurrent open PRs exist; landing or closing some would help.",
  credibility_floor: "Contributor credibility evidence is below the expected floor.",
  review_penalty: "Review churn history may reduce the contribution quality signal.",
  metadata_only: "Only metadata signals are available; detailed analysis requires full context.",
  linked_issue_invalid: "The linked issue is invalid or no longer open.",
  linked_issue_unvalidated: "The linked issue context is present but not yet validated.",
  branch_ineligible: "The branch is not eligible for linked-issue assumptions.",
  branch_eligibility_missing: "Branch eligibility metadata is missing; refresh before proceeding.",
  duplicate_risk: "Potential duplicate or conflicting open work was detected.",
  stale_work: "Stale open PR(s) detected; consider closing stale work before opening more.",
};

const FORBIDDEN_PUBLIC_LANGUAGE =
  /wallet|hotkey|coldkey|mnemonic|seed phrase|payout|reward[-\s]?estimate|farming|raw trust|trust[-\s]?score|scoreability|private[-\s]?reviewability|public[-\s]?score[-\s]?(?:estimate|prediction)/i;

function renderOptions(simulation: OpenPrPressureSimulation): RenderedScenarioOption[] {
  return simulation.scenarios.map((s) => {
    const rationaleParts = [...s.facts.slice(0, 1), ...s.tradeoffs.slice(0, 1)];
    return {
      rank: s.rank,
      label: sanitizePublicComment(s.label),
      rationale: sanitizePublicComment(rationaleParts.join(" ")),
      obstacles: s.blockers.map((b) => sanitizePublicComment(b)),
      assumptions: s.assumptions.map((a) => sanitizePublicComment(a)),
      nextStep: sanitizePublicComment(OPTION_NEXT_STEPS[s.option] ?? "Review available signals before acting."),
      recommended: s.recommended,
    };
  });
}

function renderHeadline(
  pressureSimulation: OpenPrPressureSimulation | undefined,
  eligibilityPlan: EligibilityPlan | undefined,
): string {
  if (pressureSimulation) {
    return sanitizePublicComment(pressureSimulation.summary);
  }
  if (eligibilityPlan) {
    return sanitizePublicComment(eligibilityPlan.publicSummary);
  }
  return "Advisory scenario summary generated from available repo signals.";
}

function extractEligibilityNotes(plan: EligibilityPlan): string[] {
  return [
    sanitizePublicComment(plan.publicSummary),
    ...plan.blockers.map((b) => sanitizePublicComment(b)),
    ...plan.cleanupPaths.map((p) => sanitizePublicComment(p)),
    ...(plan.linkedIssueProjection ? [sanitizePublicComment(plan.linkedIssueProjection)] : []),
  ].filter(Boolean);
}

function extractBlockerNotes(blockers: ScoreGateBlocker[]): string[] {
  return blockers
    .filter((b) => b.code !== "repo_not_registered" && b.code !== "inactive_allocation")
    .map((b) => sanitizePublicComment(PUBLIC_BLOCKER_TEXT[b.code] ?? b.detail))
    .filter(Boolean);
}

function extractDataClassification(scenarioInput: AgentScenarioInput | undefined): PublicScenarioSummary["dataClassification"] {
  if (!scenarioInput) {
    return { facts: [], assumptions: [], unavailableSignals: [] };
  }
  const pub = serializeScenarioInputPublic(scenarioInput);
  return {
    facts: pub.facts.map((e) => sanitizePublicComment(e.label)),
    assumptions: pub.assumptions.map((e) => sanitizePublicComment(e.label)),
    unavailableSignals: pub.unavailableSignals.map((e) => sanitizePublicComment(e.label)),
  };
}

function assertPublicSummaryClean(summary: PublicScenarioSummary): void {
  const serialized = JSON.stringify(summary);
  /* v8 ignore start -- All text fields are sanitized before this guard; defensive check for future fields. */
  if (FORBIDDEN_PUBLIC_LANGUAGE.test(serialized)) {
    throw new Error("Public scenario summary still contains forbidden language.");
  }
  /* v8 ignore end */
}

/**
 * Render a public-safe scenario summary from simulator outputs.
 *
 * Pure and read-only; no network or state access. All text fields pass through
 * `sanitizePublicComment` before output, and a final defensive guard rejects any
 * serialization that still contains forbidden language.
 */
export function renderPublicScenarioSummary(input: ScenarioSummaryInput): PublicScenarioSummary {
  const summary: PublicScenarioSummary = {
    repoFullName: input.repoFullName,
    generatedAt: input.generatedAt,
    advisoryOnly: true,
    notAutonomousPrBot: true,
    notPublicScoring: true,
    headline: renderHeadline(input.pressureSimulation, input.eligibilityPlan),
    options: input.pressureSimulation ? renderOptions(input.pressureSimulation) : [],
    eligibilityNotes: input.eligibilityPlan ? extractEligibilityNotes(input.eligibilityPlan) : [],
    blockerNotes: input.publicBlockers ? extractBlockerNotes(input.publicBlockers) : [],
    dataClassification: extractDataClassification(input.scenarioInput),
  };
  assertPublicSummaryClean(summary);
  return summary;
}
