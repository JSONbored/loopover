import { LOOPOVER_SITE_URL } from "../github/footer";

// Author-based eligibility for the priority label (#9737).
//
// `gittensor:priority` carries the highest scoring multiplier, which makes it the one label whose
// application must be constrained by rule rather than by judgment. The rule is mechanical: priority marks
// work the MAINTAINER has originated and triaged as most valuable, so the label is only valid on an issue
// the maintainer authored. Applied by anyone (including a maintainer) to a contributor-authored issue, it
// is stripped and the reason is stated once.
//
// Maintainer-of-record is derived from the repo's own permissions, never a hardcoded login, so the rule
// generalizes to any repo ORB manages.
//
// This module is the DECISION only. It takes facts and returns a verdict, so every branch is unit-testable
// without a webhook, a GitHub token, or a clock; the caller performs the strip, the comment and the ledger
// write. Same split as the linked-issue hard rules and the priority eligibility WINDOW (#9738), which is
// this rule's sibling: that one governs WHEN work on a priority issue may start, this one governs WHICH
// issues may carry the label at all.

/** The rule's stable identifier, written to the ledger with every enforcement decision. */
export const PRIORITY_LABEL_AUTHOR_RULE_ID = "priority-label-author-eligibility";

/**
 * Repo permissions that make someone a maintainer OF RECORD for this rule.
 *
 * `admin` and `maintain` only. `write` is deliberately excluded: a contributor granted push access to a
 * fork-free workflow is not thereby entitled to mint the highest-multiplier label, and the rule would be
 * trivially widened by handing out write. GitHub's own permission vocabulary is the source -- see
 * `getRepositoryCollaboratorPermission`.
 */
export const MAINTAINER_OF_RECORD_PERMISSIONS: readonly string[] = ["admin", "maintain"];

export function isMaintainerOfRecord(permission: string | null | undefined): boolean {
  return typeof permission === "string" && MAINTAINER_OF_RECORD_PERMISSIONS.includes(permission.toLowerCase());
}

export type PriorityLabelVerdict =
  | { strip: false; reason: null }
  | { strip: true; reason: string; comment: string };

const KEEP: PriorityLabelVerdict = { strip: false, reason: null };

export type PriorityLabelEligibilityInput = {
  /** The label whose application is being judged, as the repo names it. */
  priorityLabel: string;
  /** Labels currently on the issue. */
  labels: readonly string[];
  /** The issue's AUTHOR -- not the actor who applied the label. */
  authorLogin: string | null | undefined;
  /** The author's permission on this repo, from GitHub. `null` when it could not be read. */
  authorPermission: string | null | undefined;
  /** True when the issue is a pull request. PRs carry the same label name for a different purpose. */
  isPullRequest: boolean;
  /** Where the policy is written down, linked from the comment so the rule is never just an assertion. */
  policyUrl: string;
};

/**
 * PURE evaluator. Returns `strip: true` only when every fact needed to justify removing the label is known
 * and the author is provably not a maintainer of record.
 *
 * FAILS OPEN on every uncertainty -- an unreadable permission, an unknown author, a label that is not
 * present. Stripping the highest-value label off a maintainer's own issue because we could not read a
 * permission would be a worse error than leaving one wrongly applied, and the periodic sweep will re-judge
 * it once the read succeeds.
 *
 * A PULL REQUEST is never touched. `gittensor:priority` is also the PR TYPE label for a content submission
 * (see settings/pr-type-label.ts), which ORB applies itself -- this rule is about issues, and conflating
 * the two would have it fighting the labeller.
 */
export function evaluatePriorityLabelEligibility(input: PriorityLabelEligibilityInput): PriorityLabelVerdict {
  if (input.isPullRequest) return KEEP;

  const wanted = input.priorityLabel.trim().toLowerCase();
  if (!wanted) return KEEP;
  if (!input.labels.some((label) => label.trim().toLowerCase() === wanted)) return KEEP;

  const author = (input.authorLogin ?? "").trim();
  if (!author) return KEEP;
  // An unreadable permission is not evidence of anything.
  if (input.authorPermission === null || input.authorPermission === undefined) return KEEP;
  if (isMaintainerOfRecord(input.authorPermission)) return KEEP;

  return {
    strip: true,
    reason: `${PRIORITY_LABEL_AUTHOR_RULE_ID}: issue authored by @${author} (repo permission "${input.authorPermission}"), which is not a maintainer of record`,
    comment: [
      `\`${input.priorityLabel}\` marks work a maintainer originated and triaged as highest-value, so it only applies to maintainer-authored issues — it has been removed from this one automatically.`,
      "",
      "This is not a judgement about the issue: it stays open and contributions to it are still welcome under its other labels. The policy, and which labels carry scoring weight, are documented here:",
      "",
      input.policyUrl,
    ].join("\n"),
  };
}

/** Where the policy lives, built from the canonical site URL rather than a second hardcoded origin --
 *  linked from the comment so the rule is never a bare assertion, with one place to change it. */
export const PRIORITY_LABEL_POLICY_URL = `${LOOPOVER_SITE_URL}/docs/label-policy`;

/** Where the enforcement decision is written, so a strip can be audited without reading GitHub. */
export const PRIORITY_LABEL_ENFORCEMENT_EVENT = "labels.priority_author_ineligible";

/** The marker that makes the comment IDEMPOTENT: found on an existing comment, that comment is updated
 *  rather than a second one posted. Re-labelling therefore re-strips without ever spamming the thread. */
export const PRIORITY_LABEL_COMMENT_MARKER = "<!-- loopover:priority-label-policy -->";

export type PriorityLabelEnforcement = {
  verdict: PriorityLabelVerdict;
  /** The comment body to post or update, marker included. Null when nothing is to be said. */
  commentBody: string | null;
};

/**
 * The full enforcement shape for one issue: the verdict plus the exact comment body to write.
 *
 * Kept beside the evaluator (and equally pure) so the caller's only remaining job is I/O -- strip the
 * label, upsert the marked comment, record the event. That split is what lets the whole rule be tested
 * without a webhook or a token.
 */
export function resolvePriorityLabelEnforcement(input: PriorityLabelEligibilityInput): PriorityLabelEnforcement {
  const verdict = evaluatePriorityLabelEligibility(input);
  if (!verdict.strip) return { verdict, commentBody: null };
  return { verdict, commentBody: `${PRIORITY_LABEL_COMMENT_MARKER}\n\n${verdict.comment}` };
}
