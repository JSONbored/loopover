import { sanitizePublicComment } from "../github/commands";
import type { ScoreGateDelta, ScorePreviewResult } from "../scoring/preview";

export type ScoreMultiplierBand = "full" | "reduced" | "neutral" | "blocked";

export type ScoreMultiplierBreakdown = {
  component: string;
  band: ScoreMultiplierBand;
  summary: string;
  lever: string;
  leverageScore: number;
};

export type ScoreBreakdownExplanation = {
  repoFullName: string;
  scoreabilityStatus: ScorePreviewResult["scoreabilityStatus"];
  effectiveEstimatedScore: number;
  components: ScoreMultiplierBreakdown[];
  gateHighlights: Array<{ gate: ScoreGateDelta["gate"]; explanation: string }>;
  highestLeverageLever: {
    component: string;
    lever: string;
    reason: string;
  };
};

function bandForMultiplier(value: number, blockedAtZero = true): ScoreMultiplierBand {
  if (blockedAtZero && value <= 0) return "blocked";
  if (value >= 0.99) return "full";
  if (value <= 0.01) return "blocked";
  return "reduced";
}

function densityBreakdown(preview: ScorePreviewResult): ScoreMultiplierBreakdown {
  const { densityMultiplier, contributionBonus } = preview.scoreEstimate;
  const baseGatePassed = preview.gates.baseTokenGatePassed;
  const band = baseGatePassed ? bandForMultiplier(densityMultiplier, false) : "blocked";
  const summary = baseGatePassed
    ? densityMultiplier >= 0.99
      ? "Code density is in a healthy range for the current change size."
      : "Code density is below the typical full-strength range for this change size."
    : "The change does not yet meet the minimum meaningful source-change threshold.";
  const lever = baseGatePassed
    ? densityMultiplier >= 0.99
      ? "Keep the diff focused on substantive source changes with clear scope."
      : "Increase meaningful source changes or clarify scope so density is easier to review."
    : "Add more substantive source changes or tighten the diff before relying on this preview.";
  const leverageScore = baseGatePassed ? Math.round((1 - Math.min(densityMultiplier, 1)) * 50) : 75;
  if (contributionBonus > 0 && leverageScore < 40) {
    return {
      component: "densityMultiplier",
      band,
      summary: `${summary} Contribution bonus is already contributing.`,
      lever,
      leverageScore,
    };
  }
  return { component: "densityMultiplier", band, summary, lever, leverageScore };
}

function openPrBreakdown(preview: ScorePreviewResult): ScoreMultiplierBreakdown {
  const { openPrMultiplier } = preview.scoreEstimate;
  const { openPrCount, openPrThreshold } = preview.gates;
  const band = bandForMultiplier(openPrMultiplier);
  return {
    component: "openPrMultiplier",
    band,
    summary:
      openPrMultiplier >= 1
        ? `Open PR count (${openPrCount}) is within the current allowance (${openPrThreshold}).`
        : `Open PR count (${openPrCount}) exceeds the current allowance (${openPrThreshold}), so concurrent work is blocked.`,
    lever:
      openPrMultiplier >= 1
        ? "Keep concurrent open PRs within the allowance before starting more work."
        : "Land, merge, or close existing open PRs before opening another concurrent contribution.",
    leverageScore: openPrMultiplier >= 1 ? 5 : 100,
  };
}

function credibilityBreakdown(preview: ScorePreviewResult): ScoreMultiplierBreakdown {
  const { credibilityMultiplier } = preview.scoreEstimate;
  const { credibilityObserved, credibilityFloor } = preview.gates;
  const band = bandForMultiplier(credibilityMultiplier);
  return {
    component: "credibilityMultiplier",
    band,
    summary:
      credibilityMultiplier >= 1
        ? "Contributor credibility evidence meets the current floor."
        : `Contributor credibility (${roundBand(credibilityObserved)}) is below the floor (${roundBand(credibilityFloor)}), so the preview is reduced.`,
    lever:
      credibilityMultiplier >= 1
        ? "Continue building clean merged history and consistent review outcomes."
        : "Build more merged, review-clean history in registered repos before relying on full-strength previews.",
    leverageScore: credibilityMultiplier >= 1 ? 10 : 85,
  };
}

function issueMultiplierBreakdown(preview: ScorePreviewResult): ScoreMultiplierBreakdown {
  const { issueMultiplier } = preview.scoreEstimate;
  const linked = preview.linkedIssueMultiplier;
  const band = linked.eligible && issueMultiplier > 1 ? "full" : issueMultiplier >= 1 ? "neutral" : "reduced";
  const summary =
    linked.mode === "none"
      ? "No linked-issue multiplier was requested for this preview."
      : linked.eligible
        ? "Linked issue context is eligible for the configured issue multiplier."
        : `Linked issue context is present but not fully eligible (${linked.status}).`;
  const lever =
    linked.mode === "none"
      ? "Link a validated open issue with solved-by-PR evidence if this contribution closes scoped work."
      : linked.eligible
        ? "Keep the linked issue open, valid, and clearly solved by this PR."
        : linked.status === "invalid"
          ? "Fix linked issue state: confirm the issue is open and not already solved elsewhere."
          : "Validate linked issue context with solved-by-PR evidence or refresh mirror metadata.";
  const leverageScore = linked.eligible ? 15 : linked.mode === "none" ? 20 : 70;
  return { component: "issueMultiplier", band, summary, lever, leverageScore };
}

function reviewPenaltyBreakdown(preview: ScorePreviewResult): ScoreMultiplierBreakdown {
  const { reviewPenaltyMultiplier } = preview.scoreEstimate;
  const band = bandForMultiplier(reviewPenaltyMultiplier, false);
  return {
    component: "reviewPenaltyMultiplier",
    band,
    summary:
      reviewPenaltyMultiplier >= 0.99
        ? "Review churn penalty is not materially reducing this preview."
        : "Prior review churn is reducing the preview through the review penalty multiplier.",
    lever:
      reviewPenaltyMultiplier >= 0.99
        ? "Keep tests, evidence, and PR scope tight to avoid future review churn."
        : "Reduce review churn with clearer tests, smaller diffs, and explicit validation evidence.",
    leverageScore: reviewPenaltyMultiplier >= 0.99 ? 8 : 60,
  };
}

function labelMultiplierBreakdown(preview: ScorePreviewResult): ScoreMultiplierBreakdown {
  const { labelMultiplier } = preview.scoreEstimate;
  const band: ScoreMultiplierBand = labelMultiplier > 1 ? "full" : labelMultiplier < 1 ? "reduced" : "neutral";
  return {
    component: "labelMultiplier",
    band,
    summary:
      labelMultiplier > 1
        ? "A configured trusted label multiplier is applied."
        : labelMultiplier < 1
          ? "A configured penalty label multiplier is reducing the preview."
          : "No trusted label multiplier is applied beyond the default.",
    lever:
      labelMultiplier > 1
        ? "Ensure the label match is legitimate and documented for maintainers."
        : labelMultiplier < 1
          ? "Confirm the penalty label is accurate; substantive changes may warrant a different label."
          : "Check whether the change legitimately matches a configured trusted label before submission.",
    leverageScore: labelMultiplier > 1 ? 12 : labelMultiplier < 1 ? 40 : 25,
  };
}

function contributionBonusBreakdown(preview: ScorePreviewResult): ScoreMultiplierBreakdown {
  const { contributionBonus } = preview.scoreEstimate;
  const band = contributionBonus > 0 ? "full" : "neutral";
  return {
    component: "contributionBonus",
    band,
    summary:
      contributionBonus > 0
        ? "Total change size is large enough to add a contribution bonus on top of the base score."
        : "Total change size has not yet reached the contribution bonus ramp.",
    lever:
      contributionBonus > 0
        ? "Keep meaningful tests and docs aligned with the source change."
        : "Add substantive tests or supporting changes if they genuinely improve maintainability.",
    leverageScore: contributionBonus > 0 ? 6 : 30,
  };
}

function roundBand(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, "");
}

function gateHighlightsFor(preview: ScorePreviewResult): ScoreBreakdownExplanation["gateHighlights"] {
  return preview.gateDeltas.map((delta) => ({
    gate: delta.gate,
    explanation: sanitizePublicComment(delta.explanation),
  }));
}

function pickHighestLeverage(components: ScoreMultiplierBreakdown[]): ScoreBreakdownExplanation["highestLeverageLever"] {
  const ranked = [...components].sort((left, right) => right.leverageScore - left.leverageScore || left.component.localeCompare(right.component));
  const top = ranked[0]!;
  const reason =
    top.band === "blocked"
      ? `${top.component} is fully blocking or zeroing part of the preview right now.`
      : top.band === "reduced"
        ? `${top.component} is the largest remaining reducer in the multiplier stack.`
        : `${top.component} is the best next optimization lever among non-blocking multipliers.`;
  return {
    component: top.component,
    lever: top.lever,
    reason: sanitizePublicComment(reason),
  };
}

/**
 * Pure projection over a {@link ScorePreviewResult} that explains each score multiplier
 * in plain language and identifies the single highest-leverage improvement lever.
 */
export function explainScoreBreakdown(preview: ScorePreviewResult): ScoreBreakdownExplanation {
  const components = [
    densityBreakdown(preview),
    contributionBonusBreakdown(preview),
    labelMultiplierBreakdown(preview),
    issueMultiplierBreakdown(preview),
    credibilityBreakdown(preview),
    reviewPenaltyBreakdown(preview),
    openPrBreakdown(preview),
  ].map((entry) => ({
    ...entry,
    summary: sanitizePublicComment(entry.summary),
    lever: sanitizePublicComment(entry.lever),
  }));

  return {
    repoFullName: preview.repoFullName,
    scoreabilityStatus: preview.scoreabilityStatus,
    effectiveEstimatedScore: preview.effectiveEstimatedScore,
    components,
    gateHighlights: gateHighlightsFor(preview),
    highestLeverageLever: pickHighestLeverage(components),
  };
}
