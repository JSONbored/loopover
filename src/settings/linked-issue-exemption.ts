// Maintainer exemption from the missing-linked-issue penalty (#10158).
//
// `gate.linkedIssue: block` exists to stop unlinked CONTRIBUTOR work. Applied to a maintainer's own PR it
// asks them to file an issue against their own repo before touching it, and then fails or holds the PR when
// they don't -- on JSONbored/loopover that was the second-largest hold bucket on the Orb.
//
// ── WHY ONE CLAMP IS THE WHOLE FEATURE ────────────────────────────────────────────────────────────────────
// Producing the finding and blocking on it are already separate decisions:
//
//   • `missing_linked_issue` is PRODUCED whenever `requireLinkedIssue` holds, which is true for any mode
//     other than "off" (processors.ts: `settings.requireLinkedIssue || linkedIssueGateMode !== "off"`).
//   • it BLOCKS only when resolveConfiguredGateMode (rules/advisory.ts) resolves "block".
//
// So clamping "block" -> "advisory" keeps the finding visible in the review comment and strips exactly its
// power to fail the gate, hold the PR, or close it. Nothing has to be suppressed, and nothing goes silent --
// which is the point: the maintainer still sees "No linked issue detected", it just is not a verdict.
//
// ── WHAT IT DELIBERATELY DOES NOT TOUCH ───────────────────────────────────────────────────────────────────
// Only the MISSING case. Every analysis of an issue that IS linked -- linkedIssueSatisfactionGateMode, the
// linkedIssueHardRules eligibility rules, linkedIssueLabelPropagation -- keys on a cited issue, so a
// maintainer who links one is scrutinised exactly like anyone else. That is why this is a clamp on one mode
// rather than a bypass flag threaded through the linked-issue paths: a bypass would have had to be excluded
// from each of them by hand, and the next such path would have been added without the exclusion.

import type { GateRuleMode, RepositorySettings } from "../types";

/** The author-role facts this exemption reads: exactly the codebase's existing PROTECTED AUTHOR set
 *  (`authorIsAutomationBot || authorIsOwner || authorIsAdmin` -- processors.ts's `protectedAuthor`, mirrored
 *  by the planner's own close-eligibility check in agent-actions.ts). Reused rather than redefined, so
 *  "maintainer" cannot come to mean one thing here and another on the close path.
 *
 *  Automation bots are included deliberately. They are already protected from auto-close for the same
 *  reason -- their PRs are the repo's own machinery, not drive-by contributions -- and in practice they open
 *  unlinked PRs routinely (release-please, dependency bumps, generated-doc refreshes), which is precisely the
 *  case this knob exists to stop treating as a violation. */
export type LinkedIssueExemptionAuthor = { authorIsOwner: boolean; authorIsAdmin: boolean; authorIsAutomationBot: boolean };

/** True when this author is one the exemption can apply to. Module-local: the only consumer is the resolver
 *  below, and exporting a second entry point would invite a caller to test the role without applying the
 *  clamp -- two ways to ask the same question, which is how the modes and the finding drift apart. */
function isExemptibleMaintainerAuthor(author: LinkedIssueExemptionAuthor): boolean {
  return author.authorIsOwner || author.authorIsAdmin || author.authorIsAutomationBot;
}

/**
 * PURE. The linked-issue gate mode that actually applies to this PR.
 *
 * Returns `mode` unchanged in every case except the one the knob names: exemption enabled, author is a
 * maintainer, and the configured mode is `block`. `advisory` and `off` are already non-blocking, so there is
 * nothing to clamp and they pass through -- which matters because clamping them would silently *raise*
 * `off` to `advisory` and start producing a finding a repo had switched off.
 */
export function effectiveLinkedIssueGateMode(
  mode: GateRuleMode,
  exemptMaintainers: boolean | null | undefined,
  author: LinkedIssueExemptionAuthor,
): GateRuleMode {
  if (exemptMaintainers !== true) return mode;
  if (!isExemptibleMaintainerAuthor(author)) return mode;
  return mode === "block" ? "advisory" : mode;
}

/**
 * The settings a gate evaluation should actually run under for THIS PR's author.
 *
 * Applied to the `settings` object before it reaches `gateCheckPolicy`, rather than by adding an author
 * parameter to that function: it already takes seven positional arguments, and both things that need to agree
 * -- `requireLinkedIssue` (which decides whether the finding is produced) and `linkedIssueGateMode` (which
 * decides whether it blocks) -- read this same object. Clamping here means they cannot disagree, and every
 * call site is corrected by construction instead of each one remembering to pass an extra argument.
 *
 * Returns the SAME object reference when nothing changes, so the overwhelmingly common path (no exemption
 * configured, or a contributor's PR) allocates nothing and stays referentially identical for any caller that
 * digests or compares it -- `configDigest` in decision-record.ts digests the resolved policy, so a gratuitous
 * copy would be harmless but a gratuitous CHANGE would not.
 */
export function withLinkedIssueMaintainerExemption(
  settings: RepositorySettings,
  author: LinkedIssueExemptionAuthor,
): RepositorySettings {
  const effective = effectiveLinkedIssueGateMode(settings.linkedIssueGateMode, settings.linkedIssueMaintainerExempt, author);
  return effective === settings.linkedIssueGateMode ? settings : { ...settings, linkedIssueGateMode: effective };
}
