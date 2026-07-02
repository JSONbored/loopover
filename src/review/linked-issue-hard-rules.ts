import { fetchLinkedIssueFacts } from "../github/backfill";
import { githubRateLimitAdmissionKeyForToken } from "../github/client";
import { extractLinkedIssueNumbersWithOverflow } from "../db/repositories";

// Linked-issue HARD-RULE auto-close (#linked-issue-hard-rules). A DETERMINISTIC rule about the issue(s) a
// contributor PR links — not an AI verdict. When a contributor links an issue that violates one of the
// operator's hard rules, the PR is one-shot CLOSED with the SPECIFIC rule cited, so the contributor knows
// exactly why (and which issue). The three rules (close when ANY linked OPEN issue trips one):
//   1. owner-assigned    — the issue is assigned to the repo owner (reserved for the maintainer).
//   2. missing-point     — a default-label repo AND the issue carries NONE of the point-bearing labels
//                          (gittensor:bug / gittensor:feature / gittensor:priority) → not a scored contribution.
//   3. maintainer-only   — the issue is labeled `maintainer-only` → not open for community PRs.
//
// Each rule is independently `"block"` (enforce) or `"off"` (ignore). Because this is deterministic (no
// hallucination risk), the close fires REGARDLESS of a hard-guardrail path hit — but NEVER for the owner or
// an automation bot (the planner's `isContributor` guard owns that exemption).

export type LinkedIssueHardRulesMode = "block" | "off";

export type LinkedIssueHardRulesConfig = {
  ownerAssignedClose: LinkedIssueHardRulesMode;
  missingPointLabelClose: LinkedIssueHardRulesMode;
  maintainerOnlyLabelClose: LinkedIssueHardRulesMode;
  // The point-bearing labels that make an issue eligible for a scored contribution.
  pointBearingLabels: string[];
  // The labels that mark an issue as maintainer-only (not open for community PRs).
  maintainerOnlyLabels: string[];
  // True when the repo uses the default gittensor labels, which is the precondition for the missing-point rule
  // (a repo that does NOT use point labels must never auto-close for "missing point label").
  defaultLabelRepo: boolean;
  // Flag-then-close double-check (#linked-issue-verify-before-close). When TRUE (default), a hard-rule
  // violation does NOT close on first detection: the planner FLAGS the PR (adds the pending-closure label + a
  // warning comment) and only CLOSES on the NEXT gate evaluation if the violation STILL holds AND the label is
  // already present (a label-based two-pass state machine — the second pass is the verification). When FALSE,
  // the close fires immediately on first detection (the original GAP-5 behavior).
  verifyBeforeClose: boolean;
  // How long (seconds) until the verification pass — surfaced in the flag comment, and used to delay the
  // optional re-review re-enqueue so Pass 2 doesn't wait for the slow sweep. Clamped to [0, 300].
  closeDelaySeconds: number;
};

// Fail-SAFE default: every mode OFF, empty label lists, NOT a default-label repo. With hosted reviews retired,
// this loader no longer reads external policy storage; deterministic linked-issue auto-closes stay off
// unless/until they are wired through self-host repo config.

// The namespaced label that marks a PR as flagged-for-closure by the linked-issue hard rule (Pass 1). Its
// presence + a persisting violation on the next evaluation is the verification trigger (Pass 2 → close). Cleared
// when the violation resolves. Namespaced so it never collides with project labels (mirrors AGENT_LABEL_*).
export const AGENT_LABEL_PENDING_CLOSURE = "gittensory:pending-closure";

// Default verification delay (seconds) — how long until the second-pass close. Clamped to this range on load.
const DEFAULT_CLOSE_DELAY_SECONDS = 30;

export const DEFAULT_LINKED_ISSUE_HARD_RULES: LinkedIssueHardRulesConfig = {
  ownerAssignedClose: "off",
  missingPointLabelClose: "off",
  maintainerOnlyLabelClose: "off",
  pointBearingLabels: [],
  maintainerOnlyLabels: [],
  defaultLabelRepo: false,
  // Default ON: a hard-rule violation flags first, then closes on re-verification (the operator's double-check).
  verifyBeforeClose: true,
  closeDelaySeconds: DEFAULT_CLOSE_DELAY_SECONDS,
};

/**
 * Resolve a repo's linked-issue hard-rule config. Kept async to avoid touching the processor call graph, but this
 * no longer reads external policy storage; the fail-safe all-off default ensures deterministic linked-issue closes
 * cannot fire from stale hosted-review configuration.
 */
export async function loadLinkedIssueHardRules(_env: Env, _repoFullName: string): Promise<LinkedIssueHardRulesConfig> {
  return DEFAULT_LINKED_ISSUE_HARD_RULES;
}

export type LinkedIssueFacts = {
  number: number;
  labels: string[];
  assignees: string[];
  state: string;
};

export type LinkedIssueHardRuleResult = {
  violated: boolean;
  reason: string | null;
};

const NO_VIOLATION: LinkedIssueHardRuleResult = { violated: false, reason: null };

function labelMatches(labels: string[], candidates: string[]): boolean {
  const wanted = new Set(candidates.map((c) => c.toLowerCase()));
  return labels.some((label) => wanted.has(label.toLowerCase()));
}

/**
 * PURE evaluator. Walks the linked OPEN issues (closed issues are ignored — a stale close-link never blocks a
 * PR) and returns on the FIRST hard-rule violation with a specific, cited reason naming the offending issue.
 * Only rules in `"block"` mode are evaluated; the missing-point-label rule additionally requires the repo to be
 * a default-label repo. Returns `{ violated: false, reason: null }` when nothing trips.
 */
export function evaluateLinkedIssueHardRules(input: {
  issues: LinkedIssueFacts[];
  config: LinkedIssueHardRulesConfig;
  repoOwner: string;
}): LinkedIssueHardRuleResult {
  const { config, repoOwner } = input;
  const ownerLower = repoOwner.toLowerCase();
  const anyRuleOn = config.ownerAssignedClose === "block" || config.missingPointLabelClose === "block" || config.maintainerOnlyLabelClose === "block";
  if (!anyRuleOn) return NO_VIOLATION;

  for (const issue of input.issues) {
    if (issue.state !== "open") continue;

    // Rule 1 — owner-assigned. The maintainer reserved this issue; a contributor PR for it can't be auto-accepted.
    if (config.ownerAssignedClose === "block" && ownerLower.length > 0 && issue.assignees.some((assignee) => assignee.toLowerCase() === ownerLower)) {
      return {
        violated: true,
        reason: `Linked issue #${issue.number} is assigned to the maintainer (@${repoOwner}) — that work is reserved for the maintainer, so this PR cannot be auto-accepted.`,
      };
    }

    // Rule 3 — maintainer-only label. Not open for community PRs.
    if (config.maintainerOnlyLabelClose === "block" && labelMatches(issue.labels, config.maintainerOnlyLabels)) {
      return {
        violated: true,
        reason: `Linked issue #${issue.number} is labeled \`maintainer-only\` — it is not open for community PRs.`,
      };
    }

    // Rule 2 — missing point-bearing label (default-label repos only). Not eligible for a scored contribution.
    if (config.missingPointLabelClose === "block" && config.defaultLabelRepo && !labelMatches(issue.labels, config.pointBearingLabels)) {
      return {
        violated: true,
        reason: `Linked issue #${issue.number} has no point-bearing label (needs one of gittensor:bug, gittensor:feature, gittensor:priority) — it is not eligible for a scored contribution.`,
      };
    }
  }

  return NO_VIOLATION;
}

/**
 * Orchestrate the per-PR linked-issue hard-rule decision (the testable core of maybeRunAgentMaintenance's
 * linked-issue block). Returns the hard-rule result, or undefined when no rule applies. Takes the raw PR body +
 * CI token so the overflow check and per-issue fact fetch happen here (the call-site stays branch-free):
 *   - no rule in "block" mode → undefined (skip entirely, no fetch).
 *   - the PR body links MORE closing references than the cap (overflow) → a violation: too many to verify safely.
 *   - otherwise fetch each linked issue's facts (fail-open per issue) and run the deterministic evaluator.
 */
export async function resolveLinkedIssueHardRule(args: {
  env: Env;
  repoFullName: string;
  repoOwner: string;
  config: LinkedIssueHardRulesConfig;
  body: string | null | undefined;
  linkedIssues: number[];
  ciToken: string | undefined;
  // The installation id for `ciToken` (undefined for public-token reads). The admission key is DERIVED from the
  // token + this id via the one shared resolver, so an installation-token read attributes to its installation bucket
  // (not "unknown") and the key can never be passed out of sync with the token it belongs to.
  installationId?: number | null | undefined;
}): Promise<LinkedIssueHardRuleResult | undefined> {
  const anyRuleOn =
    args.config.ownerAssignedClose === "block" ||
    args.config.missingPointLabelClose === "block" ||
    args.config.maintainerOnlyLabelClose === "block";
  if (!anyRuleOn) return undefined;
  if (extractLinkedIssueNumbersWithOverflow(args.body ?? "").overflow) {
    return {
      violated: true,
      reason: "PR body links more issues than Gittensory can safely verify automatically; please reduce linked closing references or request maintainer review.",
    };
  }
  if (args.linkedIssues.length === 0) return undefined;
  const token = args.ciToken ?? args.env.GITHUB_PUBLIC_TOKEN;
  const admissionKey = githubRateLimitAdmissionKeyForToken(args.env, token, args.installationId);
  const fetchResults = await Promise.all(args.linkedIssues.map((issueNumber) => fetchLinkedIssueFacts(args.env, args.repoFullName, issueNumber, token, admissionKey)));
  const issueFacts = fetchResults.flatMap((result) => (result.status === "found" ? [result.facts] : []));
  if (issueFacts.length === 0) {
    // Every reference resolved to a CONFIRMED 404 — never a transient fetch_error (#2136). Mirrors the overflow
    // treatment above: a contributor citing a fabricated issue number must not silently satisfy the hard rule
    // the same way a genuinely-linked-but-unfetchable issue fails open. A single fetch_error in the mix still
    // fails open (we cannot rule out a real, rule-violating issue behind that failure).
    const allConfirmedNotFound = fetchResults.every((result) => result.status === "not_found");
    if (allConfirmedNotFound) {
      return {
        violated: true,
        reason: "The linked issue reference could not be found — please link a real, open issue or request maintainer review.",
      };
    }
    return undefined;
  }
  return evaluateLinkedIssueHardRules({ issues: issueFacts, config: args.config, repoOwner: args.repoOwner });
}
