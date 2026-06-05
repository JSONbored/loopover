import { sanitizePublicComment } from "../github/commands";
import type { LinkedIssueMultiplierStatus, ScorePreviewResult, ScoreScenarioPreview } from "../scoring/preview";

/**
 * Structured eligibility plan derived from a {@link ScorePreviewResult}. Explains whether
 * a candidate branch or PR is eligible to pursue based on linked issue state and branch
 * signals, with public-safe summaries for contributor-facing surfaces and exact detail for
 * authenticated planning surfaces.
 *
 * Advisory only — never files issues, opens PRs, comments, labels, closes, or merges.
 * Local source content is not included; fail-closed on all source-upload paths.
 */
export type EligibilityPlan = {
  /**
   * Whether the branch/PR is fully eligible right now (branch eligible AND linked issue
   * validated when standard mode is requested).
   */
  eligible: boolean;
  /** Linked-issue multiplier status from the score preview. */
  linkedIssueStatus: LinkedIssueMultiplierStatus | "not_required";
  /** Branch eligibility status. */
  branchEligibilityStatus: "eligible" | "ineligible" | "unknown" | "not_required";
  /**
   * Public-safe blocker descriptions (generic language, no scores or private counts).
   * Drawn from the subset of `ScorePreviewResult.blockedBy` codes that relate to linked
   * issues and branch eligibility.
   */
  blockers: string[];
  /**
   * Concrete steps to reach eligibility. Safe for contributor-facing display.
   * Derived from recommendation actions and eligibility-related blocker codes.
   */
  cleanupPaths: string[];
  /**
   * Public-safe projection of what changes when the linked issue is validated, or null
   * if the linkedIssueFixed scenario is not present or not relevant.
   */
  linkedIssueProjection: string | null;
  /** One-sentence public-safe summary. */
  publicSummary: string;
};

const ELIGIBILITY_BLOCKER_PUBLIC_TEXT: Record<string, string> = {
  branch_ineligible: "Branch is not eligible for linked-issue assumptions; switch to an eligible branch.",
  branch_eligibility_missing: "Branch eligibility metadata is missing; refresh branch/base metadata.",
  linked_issue_invalid: "Linked issue context is invalid; verify the issue is open and not already solved by another PR.",
  linked_issue_unvalidated: "Linked issue context is not yet validated; provide solved-by-PR evidence or wait for mirror sync.",
};

const ELIGIBILITY_BLOCKER_CODES = new Set(Object.keys(ELIGIBILITY_BLOCKER_PUBLIC_TEXT));

const ELIGIBILITY_STATUS_SUMMARY: Record<string, string> = {
  eligible: "This branch is eligible to pursue based on current linked issue and branch signals.",
  ineligible_branch: "This branch is not eligible; resolve the branch blocker before opening a PR.",
  invalid_link: "The linked issue is invalid or no longer open; verify issue state before proceeding.",
  unvalidated_link: "Linked issue context is present but not yet validated; validation is needed before the multiplier applies.",
  not_required: "Branch and linked issue eligibility are not required for this contribution type.",
};

function eligibilityStatusKey(plan: Pick<EligibilityPlan, "eligible" | "linkedIssueStatus" | "branchEligibilityStatus">): string {
  if (plan.branchEligibilityStatus === "ineligible") return "ineligible_branch";
  if (plan.linkedIssueStatus === "invalid") return "invalid_link";
  if (plan.linkedIssueStatus === "raw" || plan.linkedIssueStatus === "plausible" || plan.linkedIssueStatus === "unavailable") return "unvalidated_link";
  if (plan.linkedIssueStatus === "not_required" && plan.branchEligibilityStatus === "not_required") return "not_required";
  if (plan.eligible) return "eligible";
  // Reached when a linked issue is requested but eligibility is not yet confirmed
  // (e.g. validated link with unknown/missing branch metadata).
  return "unvalidated_link";
}

function linkedIssueProjectionFrom(scenarios: ScoreScenarioPreview[]): string | null {
  const fixed = scenarios.find((s) => s.name === "linkedIssueFixed");
  /* v8 ignore next -- buildScenarioPreviews always emits a linkedIssueFixed scenario. */
  if (!fixed) return null;
  const current = scenarios.find((s) => s.name === "current");
  /* v8 ignore next -- buildScenarioPreviews always emits a current scenario. */
  if (!current) return null;
  if (fixed.linkedIssueMultiplier.eligible && !current.linkedIssueMultiplier.eligible) {
    return "Validating the linked issue would enable the standard linked-issue contribution consideration.";
  }
  return null;
}

function eligibilityCleanupPaths(result: ScorePreviewResult): string[] {
  const paths: string[] = [];
  for (const blocker of result.blockedBy) {
    if (!ELIGIBILITY_BLOCKER_CODES.has(blocker.code)) continue;
    if (blocker.code === "branch_ineligible") {
      paths.push("Switch to an eligible branch or remove linked-issue assumptions before proceeding.");
    } else if (blocker.code === "branch_eligibility_missing") {
      paths.push("Refresh branch/base eligibility metadata (e.g. run a local preflight) before relying on linked-issue projections.");
    } else if (blocker.code === "linked_issue_invalid") {
      paths.push("Check that the linked issue is still open and not already closed by another merged PR.");
    } else if (blocker.code === "linked_issue_unvalidated") {
      paths.push("Provide solved-by-PR evidence in the linked issue context, or wait for the official mirror to sync.");
    }
  }
  return [...new Set(paths)].map((path) => sanitizePublicComment(path));
}

/**
 * Derive a structured {@link EligibilityPlan} from a {@link ScorePreviewResult}.
 *
 * The function is pure and read-only. It does not upload source content, access the
 * network, or modify any state. All public-facing fields are scrubbed through
 * `sanitizePublicComment` so reward, score, wallet, hotkey, and trust language
 * cannot reach contributor-facing surfaces.
 */
export function deriveEligibilityPlan(result: ScorePreviewResult): EligibilityPlan {
  const linkedIssueStatus = result.linkedIssueMultiplier.status;
  const branchEligibilityStatus = result.branchEligibility.status;
  // Only affirm eligibility when the branch is positively confirmed (eligible or not required);
  // "unknown" / missing metadata is treated as not-yet-eligible so the plan never overpromises.
  const branchConfirmed = branchEligibilityStatus === "eligible" || branchEligibilityStatus === "not_required";
  const eligible = result.linkedIssueMultiplier.eligible && branchConfirmed;

  const blockers = result.blockedBy
    .filter((b) => ELIGIBILITY_BLOCKER_CODES.has(b.code))
    .map((b) => {
      /* v8 ignore next -- the filter guarantees b.code is a known eligibility blocker key with public text. */
      return ELIGIBILITY_BLOCKER_PUBLIC_TEXT[b.code] ?? sanitizePublicComment(b.detail);
    });

  const cleanupPaths = eligibilityCleanupPaths(result);
  // A linked-issue projection only makes sense when a linked issue is actually requested.
  const linkedIssueProjection = linkedIssueStatus === "not_required" ? null : linkedIssueProjectionFrom(result.scenarioPreviews);

  const statusKey = eligibilityStatusKey({ eligible, linkedIssueStatus, branchEligibilityStatus });
  /* v8 ignore next -- eligibilityStatusKey always returns one of the mapped ELIGIBILITY_STATUS_SUMMARY keys. */
  const publicSummary = ELIGIBILITY_STATUS_SUMMARY[statusKey] ?? "Eligibility status could not be determined from available signals.";

  return {
    eligible,
    linkedIssueStatus,
    branchEligibilityStatus,
    blockers,
    cleanupPaths,
    linkedIssueProjection,
    publicSummary,
  };
}
