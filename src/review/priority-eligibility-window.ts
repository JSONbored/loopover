// Priority-issue eligibility window (#9738).
//
// `gittensor:priority` carries the highest payout, so assignment fairness matters most there. First-come
// pickup is only fair if everyone can SEE the issue before anyone can act on it: a PR opened moments after
// the label lands means the window between "issue becomes valuable" and "issue is claimed" was effectively
// zero for everyone else watching the repo.
//
// The rule: a PR closing a priority-labeled issue is gate-eligible only once the label has been publicly
// present for the configured window (default 30 minutes, per repo). A PR that arrives inside the window is
// NOT rejected -- it is HELD, with a neutral comment stating the moment it becomes eligible, and proceeds
// normally once the window elapses. No penalty beyond waiting; the contributor keeps their work.
//
// Deliberately measured from the EARLIEST labeling event, not the most recent. The spec requires that
// re-applying the label "does not reset the clock for already-open PRs", and an earliest-event anchor gives
// that for free and for everyone: the moment a priority issue opens for work is a single knowable instant
// that nothing later can move. A label removed and re-added much later therefore reopens work immediately,
// which is the honest reading -- the issue was already public for that whole time.

/** The window's default. Contributor pickup runs to minutes, so this only needs to exceed the visibility gap. */
export const DEFAULT_PRIORITY_ELIGIBILITY_WINDOW_MINUTES = 30;

/** Bounds, so a manifest cannot set a window that never opens or one that is not a window at all. */
export const MIN_PRIORITY_ELIGIBILITY_WINDOW_MINUTES = 0;
export const MAX_PRIORITY_ELIGIBILITY_WINDOW_MINUTES = 24 * 60;

/** The rule's stable identifier, written to the ledger with every enforcement decision. */
export const PRIORITY_ELIGIBILITY_RULE_ID = "priority-eligibility-window";

export type PriorityEligibilityInput = {
  /** Minutes the label must have been present. `0` disables the rule. */
  windowMinutes: number;
  /** When the priority label FIRST landed on the linked issue, ISO-8601. Null when unknown. */
  labeledAt: string | null;
  /** When the PR was opened, ISO-8601. */
  prCreatedAt: string | null;
};

export type PriorityEligibilityResult =
  | { eligible: true; reason: null; eligibleAt: null }
  | { eligible: false; reason: string; eligibleAt: string };

const ELIGIBLE: PriorityEligibilityResult = { eligible: true, reason: null, eligibleAt: null };

function parsedTime(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * PURE evaluator. Returns `eligible: false` only when every fact needed to justify a hold is known and the
 * PR genuinely arrived inside the window.
 *
 * FAIL-OPEN on every uncertainty -- an unparseable or missing timestamp, or a non-positive window -- because
 * holding a contributor's PR on a fact we could not read is a penalty for our own gap. The three inputs are
 * passed in rather than fetched here so this is unit-testable without a network or a clock.
 */
export function evaluatePriorityEligibilityWindow(input: PriorityEligibilityInput): PriorityEligibilityResult {
  const windowMinutes = Number.isFinite(input.windowMinutes) ? Math.max(0, Math.trunc(input.windowMinutes)) : 0;
  if (windowMinutes <= 0) return ELIGIBLE;

  const labeledAt = parsedTime(input.labeledAt);
  const prCreatedAt = parsedTime(input.prCreatedAt);
  if (labeledAt === null || prCreatedAt === null) return ELIGIBLE;

  const eligibleAtMs = labeledAt + windowMinutes * 60_000;
  if (prCreatedAt >= eligibleAtMs) return ELIGIBLE;

  const eligibleAt = new Date(eligibleAtMs).toISOString();
  return {
    eligible: false,
    eligibleAt,
    reason: `This issue's \`gittensor:priority\` label was applied at ${new Date(labeledAt).toISOString()}, and priority issues open for work ${windowMinutes} minutes later so everyone watching the repo gets the same chance to see them. This PR is held until ${eligibleAt}, then continues normally — nothing else about it is affected and no action is needed from you.`,
  };
}

/**
 * The moment a priority issue opens for work, for surfaces that want to state it up front rather than
 * explain a hold after the fact. Null when the window is off or the label time is unknown.
 */
export function priorityEligibleAt(labeledAt: string | null, windowMinutes: number): string | null {
  const labeled = parsedTime(labeledAt);
  if (labeled === null || !Number.isFinite(windowMinutes) || windowMinutes <= 0) return null;
  return new Date(labeled + Math.trunc(windowMinutes) * 60_000).toISOString();
}

/**
 * Resolve the hold for a PR, or undefined when it may proceed (#9738).
 *
 * The only impure part of the rule: it reads WHEN the priority label first landed on each linked issue. The
 * decision itself is `evaluatePriorityEligibilityWindow` above, which is why that function takes timestamps
 * rather than a repo.
 *
 * Walks every linked issue and holds on the FIRST one still inside its window, so a PR linking two priority
 * issues waits for the later of them -- linking a second issue can never be a way to skip the first's window.
 */
export async function resolvePriorityEligibilityHold(input: {
  env: unknown;
  repoFullName: string;
  linkedIssues: readonly number[] | null | undefined;
  prCreatedAt: string | null;
  windowMinutes: number;
  priorityLabel: string | undefined;
  token: string | undefined;
  /** Injected so this is testable without a network; defaults to the real GraphQL read. */
  fetchLabeledAt?: (repoFullName: string, issueNumber: number, label: string) => Promise<string | null>;
  /** The linked issues' labels, when the caller already has them -- saves a read for the common case where
   *  no linked issue carries the priority label at all. */
  issueLabels?: ReadonlyMap<number, readonly string[]>;
}): Promise<{ reason: string; comment: string } | undefined> {
  const windowMinutes = input.windowMinutes;
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) return undefined;
  const issues = input.linkedIssues ?? [];
  if (issues.length === 0 || !input.prCreatedAt || !input.token) return undefined;

  const priorityLabel = input.priorityLabel;
  if (!priorityLabel) return undefined;
  const wanted = priorityLabel.toLowerCase();
  const fetchLabeledAt = input.fetchLabeledAt;
  if (!fetchLabeledAt) return undefined;

  for (const issueNumber of issues) {
    const known = input.issueLabels?.get(issueNumber);
    // When the caller told us this issue's labels and priority is not among them, no read is needed.
    if (known && !known.some((label) => label.toLowerCase() === wanted)) continue;
    const labeledAt = await fetchLabeledAt(input.repoFullName, issueNumber, priorityLabel).catch(() => null);
    if (labeledAt === null) continue;
    const verdict = evaluatePriorityEligibilityWindow({ windowMinutes, labeledAt, prCreatedAt: input.prCreatedAt });
    if (verdict.eligible) continue;
    return {
      reason: `${PRIORITY_ELIGIBILITY_RULE_ID}: issue #${issueNumber} opens for work at ${verdict.eligibleAt}`,
      comment: verdict.reason,
    };
  }
  return undefined;
}
