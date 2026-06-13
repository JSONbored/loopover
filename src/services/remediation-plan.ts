import { sanitizePublicComment } from "../github/commands";

export type RemediationPlanSource = "account_state" | "branch_quality" | "score";

export type RemediationPlanItem = {
  rank: number;
  source: RemediationPlanSource;
  step: string;
  rerunCondition: string;
  impact: "high" | "medium";
};

export type RemediationPlan = {
  repoFullName: string;
  login: string;
  summary: string;
  recommendedRerunCondition: string;
  items: RemediationPlanItem[];
};

export type RemediationPlanInput = {
  login: string;
  repoFullName: string;
  branchQualityBlockers: string[];
  accountStateBlockers: string[];
  scoreBlockers: string[];
  recommendedRerunCondition: string;
  localFindings?: Array<{
    code: string;
    severity: "info" | "warning" | "critical";
    title: string;
    detail: string;
    action?: string | undefined;
  }>;
};

const FORBIDDEN_PATTERN =
  /\b(reward\w*|wallet|hotkey|coldkey|mnemonic|farming|payout|ranking|raw[-_\s]?trust|trust[-_\s]?score|private[-_\s]?reviewability|reviewability)\b|\/Users\/|\/home\/|\/tmp\/|[A-Z]:[\\/]Users[\\/]/i;

const SOURCE_PRIORITY: Record<RemediationPlanSource, number> = {
  account_state: 0,
  branch_quality: 1,
  score: 2,
};

function publicSafeText(value: string): string {
  const sanitized = sanitizePublicComment(value).trim();
  return sanitized && !FORBIDDEN_PATTERN.test(sanitized) ? sanitized : "";
}

function publicSafeRerunCondition(condition: string): string {
  const sanitized = publicSafeText(condition);
  if (!sanitized) return "Rerun after branch, base, or PR state changes before opening or submitting.";
  return /eligibility|multiplier|scoreability|score/i.test(sanitized)
    ? "Refresh linked issue and base branch metadata before submission."
    : sanitized;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function actionForFinding(findings: RemediationPlanInput["localFindings"], title: string): string | undefined {
  const match = findings?.find((finding) => normalizeKey(finding.title) === normalizeKey(title));
  return match?.action ? publicSafeText(match.action) : undefined;
}

function rerunForAccountBlocker(blocker: string, fallback: string): string {
  if (/open PR|concurrent|threshold/i.test(blocker)) {
    return publicSafeRerunCondition("Rerun after pending PRs merge/close or open PR count is within the allowance.");
  }
  if (/credibility|history|maturity/i.test(blocker)) {
    return publicSafeRerunCondition("Rerun after account/queue maturity blockers clear.");
  }
  return publicSafeRerunCondition(fallback);
}

function rerunForBranchBlocker(blocker: string, fallback: string): string {
  if (/stale|fetch origin|base/i.test(blocker)) {
    return publicSafeRerunCondition("Run `git fetch origin` and rerun branch analysis against the refreshed base.");
  }
  if (/validation|test|check/i.test(blocker)) {
    return publicSafeRerunCondition("Rerun after fixing branch-quality blockers or adding explicit validation evidence.");
  }
  if (/linked issue|duplicate|eligibility/i.test(blocker)) {
    return publicSafeRerunCondition("Refresh linked issue and base branch metadata before submission.");
  }
  return publicSafeRerunCondition(fallback);
}

function stepFromBlocker(source: RemediationPlanSource, blocker: string, findings: RemediationPlanInput["localFindings"]): string {
  const findingAction = actionForFinding(findings, blocker);
  if (findingAction) return findingAction;
  const sanitized = publicSafeText(blocker);
  if (sanitized) return sanitized;
  if (source === "account_state") return "Clear account or queue maturity blockers before opening more work.";
  if (source === "branch_quality") return "Resolve branch-quality findings before submission.";
  return "Resolve scoreability blockers before relying on this preview.";
}

function impactFor(source: RemediationPlanSource, blocker: string): "high" | "medium" {
  if (source === "account_state") return "high";
  if (/GitHub checks|validation failed|maintainer-blocked|duplicate|ineligible/i.test(blocker)) return "high";
  return source === "branch_quality" ? "high" : "medium";
}

function collectItems(input: RemediationPlanInput): Array<Omit<RemediationPlanItem, "rank">> {
  const seen = new Set<string>();
  const items: Array<Omit<RemediationPlanItem, "rank">> = [];
  const push = (source: RemediationPlanSource, blocker: string) => {
    const key = normalizeKey(blocker);
    if (!key || seen.has(key)) return;
    const step = stepFromBlocker(source, blocker, input.localFindings);
    if (!step) return;
    seen.add(key);
    const rerunCondition =
      source === "account_state"
        ? rerunForAccountBlocker(blocker, input.recommendedRerunCondition)
        : source === "branch_quality"
          ? rerunForBranchBlocker(blocker, input.recommendedRerunCondition)
          : publicSafeRerunCondition(input.recommendedRerunCondition);
    items.push({
      source,
      step,
      rerunCondition,
      impact: impactFor(source, blocker),
    });
  };

  for (const blocker of input.accountStateBlockers) push("account_state", blocker);
  for (const blocker of input.branchQualityBlockers) push("branch_quality", blocker);
  for (const blocker of input.scoreBlockers) push("score", blocker);

  items.sort(
    (left, right) =>
      SOURCE_PRIORITY[left.source] - SOURCE_PRIORITY[right.source] ||
      Number(right.impact === "high") - Number(left.impact === "high") ||
      left.step.localeCompare(right.step),
  );
  return items;
}

/**
 * Turn local branch blocker lists into an ordered, deduplicated remediation checklist.
 * Steps and rerun conditions are public-safe for PR-body reuse.
 */
export function buildRemediationPlan(input: RemediationPlanInput): RemediationPlan {
  const ordered = collectItems(input);
  const items = ordered.map((item, index) => ({ ...item, rank: index + 1 }));
  const summary =
    items.length === 0
      ? "No blockers detected; rerun after any branch, base, or PR state changes before opening or submitting."
      : `${items.length} remediation step(s) ordered by impact; start with ${items[0]?.step ?? "the first listed item"}.`;

  return {
    repoFullName: input.repoFullName,
    login: input.login,
    summary: publicSafeText(summary),
    recommendedRerunCondition: publicSafeRerunCondition(input.recommendedRerunCondition),
    items,
  };
}
