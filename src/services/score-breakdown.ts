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

// Sibling of densityBreakdown for the saturated base-score value (#808 / entrius/gittensor
// constants.py): `base_score = MERGED_PR_BASE_SCORE × (1 - exp(-src_tok / SRC_TOK_SATURATION_SCALE))
// + min(total_token_score / CONTRIBUTION_SCORE_FOR_FULL_BONUS, 1) × MAX_CONTRIBUTION_BONUS`.
// densityBreakdown surfaces the saturation ratio (densityMultiplier); this surfaces the
// actual base_score the contributor has earned — the foundation that flows into estimatedMergedScore
// before the multipliers apply — so a miner sees both the curve and the resulting cap contribution.
// Uses preview.scoreEstimate.baseScoreCap (carried from the scoring core, which has the snapshot
// constants) to compute a relative saturation ratio instead of a hardcoded threshold.
const BASE_SCORE_SATURATION_RATIO = 0.95;

function baseScoreBreakdown(preview: ScorePreviewResult): ScoreMultiplierBreakdown {
  const { baseScore, baseScoreCap, contributionBonus } = preview.scoreEstimate;
  const baseGatePassed = preview.gates.baseTokenGatePassed;
  if (!baseGatePassed) {
    return {
      component: "baseScore",
      band: "blocked",
      summary: `Base score is not yet in the score pipeline — the change does not meet the minimum meaningful source-change threshold (current base is ${roundBand(baseScore)}).`,
      lever: "Add more substantive source changes or tighten the diff before relying on this preview.",
      leverageScore: 75,
    };
  }
  const saturated = baseScoreCap !== undefined && baseScore / baseScoreCap >= BASE_SCORE_SATURATION_RATIO;
  const hasBonus = contributionBonus > 0;
  const bonusClause = hasBonus ? `; contribution bonus contributing at ${roundBand(contributionBonus)}` : "; contribution bonus not contributing";
  const summary = `Base score is ${saturated ? "saturated near the score cap" : "contributing toward the score cap"} (current base ${roundBand(baseScore)}${bonusClause}).`;
  return {
    component: "baseScore",
    band: saturated ? "full" : "neutral",
    summary,
    lever: saturated
      ? "Maintain source quality on subsequent contributions; the base-score pipeline is at saturation."
      : "Keep source changes substantive and proportional to supporting changes for the contribution bonus to continue earning.",
    leverageScore: saturated ? 3 : hasBonus ? 7 : 12,
  };
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

// Sibling of openPrBreakdown for the issue-discovery channel: the open-issue spam gate (#808) zeroes the
// score once a contributor's concurrent open-issue count exceeds their earned allowance. Explained here so a
// miner in the issue-discovery lane sees the same actionable breakdown the open-PR gate already provides.
function openIssueBreakdown(preview: ScorePreviewResult): ScoreMultiplierBreakdown {
  const { openIssueMultiplier } = preview.scoreEstimate;
  const { openIssueCount, openIssueThreshold } = preview.gates;
  const band = bandForMultiplier(openIssueMultiplier);
  return {
    component: "openIssueMultiplier",
    band,
    summary:
      openIssueMultiplier >= 1
        ? `Open issue count (${openIssueCount}) is within the current allowance (${openIssueThreshold}).`
        : `Open issue count (${openIssueCount}) exceeds the current allowance (${openIssueThreshold}), so the open-issue spam gate blocks scoring.`,
    lever:
      openIssueMultiplier >= 1
        ? "Keep concurrent open issues within the allowance to stay clear of the open-issue spam gate."
        : "Close or resolve excess open issues to drop back within the open-issue spam threshold.",
    leverageScore: openIssueMultiplier >= 1 ? 5 : 100,
  };
}

// Sibling of openIssueBreakdown/openPrBreakdown for the merged-PR history floor (upstream MIN_VALID_MERGED_PRS):
// a contributor whose observed merged-PR count on this repo is below the floor has the entire preview zeroed.
// Explained here so a miner sees the same actionable breakdown the open-PR / open-issue gates already provide.
function mergedHistoryBreakdown(preview: ScorePreviewResult): ScoreMultiplierBreakdown {
  const { mergedHistoryMultiplier } = preview.scoreEstimate;
  const { mergedPrFloor, mergedPullRequests } = preview.gates;
  // mergedPullRequests is optional: when unobserved the floor is not enforced (the multiplier stays 1).
  if (mergedPullRequests === undefined) {
    return {
      component: "mergedHistoryMultiplier",
      band: "neutral",
      summary: `Merged-PR history floor is not enforced for this preview (no contributor history observed; upstream floor is ${mergedPrFloor}).`,
      lever: "No action needed for this preview; the upstream merged-PR floor applies once contributor history is observed.",
      leverageScore: 0,
    };
  }
  const band = bandForMultiplier(mergedHistoryMultiplier);
  return {
    component: "mergedHistoryMultiplier",
    band,
    summary:
      mergedPullRequests >= mergedPrFloor
        ? `Merged PR history (${mergedPullRequests}) meets the upstream floor (${mergedPrFloor}).`
        : `Merged PR history (${mergedPullRequests}) is below the upstream floor (${mergedPrFloor}), so this preview is zeroed.`,
    lever:
      mergedPullRequests >= mergedPrFloor
        ? "Keep landing merged PRs in this repo to maintain contributor history."
        : "Land more merged PRs in this repo to clear the contributor-history floor before relying on this preview.",
    leverageScore: mergedPullRequests >= mergedPrFloor ? 5 : 100,
  };
}

// Upstream time-decay (#703), env-gated by SCORING_TIME_DECAY_ENABLED (default OFF) and opted into per-preview
// via input.applyTimeDecay. When the flag is off (the common case) or the PR is fresh, the multiplier is 1 and
// the breakdown reads as "not enabled" / "fresh" — surfacing the value is a no-op for those previews but
// surfaces the aged-PR decay lever cleanly when time-decay IS applied.
function timeDecayBreakdown(preview: ScorePreviewResult): ScoreMultiplierBreakdown {
  const { timeDecayMultiplier } = preview.scoreEstimate;
  if (timeDecayMultiplier >= 0.99) {
    return {
      component: "timeDecayMultiplier",
      band: "neutral",
      summary: "Score is not time-decayed for this preview (the PR is within the fresh-PR grace period, or upstream time-decay is disabled — env SCORING_TIME_DECAY_ENABLED).",
      lever: "No action needed; aged-PR projections automatically apply the upstream sigmoid decay when time-decay is enabled.",
      leverageScore: 0,
    };
  }
  const band = bandForMultiplier(timeDecayMultiplier, false);
  return {
    component: "timeDecayMultiplier",
    band,
    summary: `Score is time-decayed for this aged PR preview (multiplier ${timeDecayMultiplier.toFixed(2)} — upstream sigmoid curve; grace 12h, 50% loss at 10 days, 5% floor through the lookback window).`,
    lever: "Land the work while it is fresh, or extend the upstream time-decay curve in the repo's master_repositories.json override for this repo to slow the decay.",
    leverageScore: 20,
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

// Sibling of reviewPenaltyBreakdown: upstream models review churn twice — reviewPenaltyMultiplier shrinks the
// current preview while reviewCollateralMultiplier raises the open-PR collateral fraction
// (OPEN_PR_COLLATERAL_PERCENT × multiplier) reserved on concurrent PRs after CHANGES_REQUESTED reviews.
function reviewCollateralBreakdown(preview: ScorePreviewResult): ScoreMultiplierBreakdown {
  const { reviewCollateralMultiplier, collateralFraction } = preview.gates;
  const elevated = reviewCollateralMultiplier > 1.01;
  const band: ScoreMultiplierBand = elevated ? "reduced" : "neutral";
  return {
    component: "reviewCollateralMultiplier",
    band,
    summary: elevated
      ? `Open-PR review collateral is elevated (effective fraction ${roundBand(collateralFraction)}) because prior CHANGES_REQUESTED reviews on open PRs raised the collateral multiplier above baseline.`
      : `Open-PR review collateral is at the baseline fraction (${roundBand(collateralFraction)}); no CHANGES_REQUESTED review churn is inflating concurrent-PR collateral.`,
    lever: elevated
      ? "Resolve outstanding change requests on open PRs before opening more concurrent work, or expect tighter collateral on the open-PR allowance."
      : "Keep open PRs review-clean to avoid collateral inflation on concurrent work.",
    leverageScore: elevated ? Math.min(55, Math.round((reviewCollateralMultiplier - 1) * 40 + 20)) : 6,
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
    baseScoreBreakdown(preview),
    densityBreakdown(preview),
    contributionBonusBreakdown(preview),
    labelMultiplierBreakdown(preview),
    issueMultiplierBreakdown(preview),
    credibilityBreakdown(preview),
    reviewPenaltyBreakdown(preview),
    reviewCollateralBreakdown(preview),
    openPrBreakdown(preview),
    openIssueBreakdown(preview),
    mergedHistoryBreakdown(preview),
    timeDecayBreakdown(preview),
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
