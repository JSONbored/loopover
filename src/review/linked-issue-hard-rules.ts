import { fetchLinkedIssueFacts, type LinkedIssueFactsFetch } from "../github/backfill";
import { githubRateLimitAdmissionKeyForToken } from "../github/client";
import { createInstallationToken } from "../github/app";
import { extractLinkedIssueNumbersWithOverflow, MAX_LINKED_ISSUE_NUMBERS } from "../db/repositories";
import { resolveRepositorySettings } from "../settings/repository-settings";
import { DEFAULT_LINKED_ISSUE_HARD_RULES } from "./linked-issue-hard-rules-config";
import type { LinkedIssueHardRulesConfig } from "../types";
export { DEFAULT_LINKED_ISSUE_HARD_RULES } from "./linked-issue-hard-rules-config";
export type { LinkedIssueHardRulesConfig, LinkedIssueHardRulesMode } from "../types";

// Linked-issue HARD-RULE auto-close (#linked-issue-hard-rules). A DETERMINISTIC rule about the issue(s) a
// contributor PR links — not an AI verdict. When a contributor links an issue that violates one of the
// operator's hard rules, the PR is one-shot CLOSED with the SPECIFIC rule cited, so the contributor knows
// exactly why (and which issue). The three rules (close when ANY linked OPEN issue trips one):
//   1. owner-assigned    — the issue is assigned to the repo owner (reserved for the maintainer).
//   2. assigned-issue    — the issue is assigned to someone other than the PR author.
//   3. missing-point     — a default-label repo AND the issue carries NONE of the point-bearing labels
//                          (gittensor:bug / gittensor:feature / gittensor:priority) → not a scored contribution.
//   4. maintainer-only   — the issue is labeled `maintainer-only` → not open for community PRs.
//
// Each rule is independently `"block"` (enforce) or `"off"` (ignore). Because this is deterministic (no
// hallucination risk), the close fires REGARDLESS of a hard-guardrail path hit — but NEVER for the owner or
// an automation bot (the planner's `isContributor` guard owns that exemption).

// Fallback label that marks a PR as flagged-for-closure by the linked-issue hard rule (Pass 1). Its presence + a
// persisting violation on the next evaluation is the verification trigger (Pass 2 → close). Operators can rename
// or disable it with `settings.pendingClosureLabel`; the fallback intentionally avoids project-specific labels.
export const AGENT_LABEL_PENDING_CLOSURE = "pending-closure";

/**
 * Resolve a repo's linked-issue hard-rule config through the same private/global config-as-code resolver the
 * rest of the action engine uses. Fail safe: if settings cannot be resolved, rules stay all-off.
 */
export async function loadLinkedIssueHardRules(env: Env, repoFullName: string): Promise<LinkedIssueHardRulesConfig> {
  return (await resolveRepositorySettings(env, repoFullName).catch(() => undefined))?.linkedIssueHardRules ?? DEFAULT_LINKED_ISSUE_HARD_RULES;
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

function findMatchingLabel(labels: string[], candidates: string[]): string | null {
  const wanted = new Set(candidates.map((c) => c.toLowerCase()));
  return labels.find((label) => wanted.has(label.toLowerCase())) ?? null;
}

function labelMatches(labels: string[], candidates: string[]): boolean {
  return findMatchingLabel(labels, candidates) !== null;
}

function issueIsAssignedToAuthor(issue: LinkedIssueFacts, prAuthorLogin: string | null | undefined): boolean {
  const author = prAuthorLogin?.trim().toLowerCase();
  return !!author && issue.assignees.some((assignee) => assignee.toLowerCase() === author);
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
  prAuthorLogin?: string | null | undefined;
}): LinkedIssueHardRuleResult {
  const { config, repoOwner } = input;
  const ownerLower = repoOwner.toLowerCase();
  const anyRuleOn =
    config.ownerAssignedClose === "block" ||
    config.assignedIssueClose === "block" ||
    config.missingPointLabelClose === "block" ||
    config.maintainerOnlyLabelClose === "block";
  if (!anyRuleOn) return NO_VIOLATION;

  for (const issue of input.issues) {
    if (issue.state !== "open") continue;
    const assignedToPrAuthor = issueIsAssignedToAuthor(issue, input.prAuthorLogin);

    // Rule 1 — owner-assigned. The maintainer reserved this issue; a contributor PR for it can't be auto-accepted.
    if (
      config.ownerAssignedClose === "block" &&
      ownerLower.length > 0 &&
      !assignedToPrAuthor &&
      issue.assignees.some((assignee) => assignee.toLowerCase() === ownerLower)
    ) {
      return {
        violated: true,
        reason: `Linked issue #${issue.number} is assigned to the maintainer (@${repoOwner}) — that work is reserved for the maintainer, so this PR cannot be auto-accepted.`,
      };
    }

    // Rule 2 — assigned to someone else. Prevents contributors from racing or taking already-claimed issues.
    if (config.assignedIssueClose === "block" && issue.assignees.length > 0 && !assignedToPrAuthor) {
      return {
        violated: true,
        reason: `Linked issue #${issue.number} is already assigned to @${issue.assignees[0]} — only the assignee or a maintainer can submit that work.`,
      };
    }

    // Rule 3 — maintainer-only label. Not open for community PRs.
    const maintainerOnlyLabel = findMatchingLabel(issue.labels, config.maintainerOnlyLabels);
    if (config.maintainerOnlyLabelClose === "block" && maintainerOnlyLabel !== null && !assignedToPrAuthor) {
      return {
        violated: true,
        reason: `Linked issue #${issue.number} is labeled \`${maintainerOnlyLabel}\` — it is not open for community PRs unless assigned by a maintainer.`,
      };
    }

    // Rule 4 — missing point-bearing label (default-label repos only). Not eligible for a scored contribution.
    if (config.missingPointLabelClose === "block" && config.defaultLabelRepo && !labelMatches(issue.labels, config.pointBearingLabels)) {
      return {
        violated: true,
        reason: `Linked issue #${issue.number} has no point-bearing label (needs one of ${config.pointBearingLabels.join(", ") || "the configured point labels"}) — it is not eligible for a scored contribution.`,
      };
    }
  }

  return NO_VIOLATION;
}

/**
 * PURE merge of a freshly-recomputed (live) hard-rule result with a PR's persisted violation memory
 * (#linked-issue-hard-rule-persistence). resolveLinkedIssueHardRule is fully re-evaluated from scratch every
 * pass — it re-parses linked issues from the CURRENT PR body via regex and reads each linked issue's CURRENT
 * live state, with no memory of a prior pass's finding. During the flag-then-close verification window
 * (settings.linkedIssueHardRules.closeDelaySeconds), that statelessness lets a confirmed violation dodge the
 * close two ways: (1) editing the PR body during the grace window to strip the closing reference, so the next
 * pass sees zero linked issues and the live result is `undefined`; (2) the linked issue's live state changing
 * between the violating pass and the verification pass (e.g. the assignee is removed), so the SAME issue
 * number re-evaluates clean. Either way, `agent-actions.ts`'s `clearLinkedIssueFlag` would then remove the
 * pending-closure label as if the violation never happened.
 *
 * `violatedAt` is the PR's persisted first-violation marker (`pullRequests.linkedIssueHardRuleViolatedAt`) —
 * present (non-null) once ANY pass has ever confirmed a violation for this PR, and NEVER cleared. When present,
 * the merged result is forced to `violated: true` regardless of what the live pass found THIS time, falling
 * back to the persisted `reason` only when the live pass didn't also (re-)confirm one this pass. A live
 * violation always wins for the `reason` text (freshest, most specific), so a persisted memory never masks new
 * information — it only ever ADDS enforcement the live-only path would have missed.
 */
export function mergeLinkedIssueHardRuleWithPersistedViolation(
  live: LinkedIssueHardRuleResult | undefined,
  persisted: { violatedAt: string | null | undefined; reason: string | null | undefined },
): LinkedIssueHardRuleResult | undefined {
  if (live?.violated === true) return live;
  if (persisted.violatedAt == null) return live;
  return { violated: true, reason: persisted.reason ?? "the linked issue is not eligible for a community PR" };
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
  prAuthorLogin?: string | null | undefined;
  // The installation id for `ciToken` (undefined for public-token reads). The admission key is DERIVED from the
  // token + this id via the one shared resolver, so an installation-token read attributes to its installation bucket
  // (not "unknown") and the key can never be passed out of sync with the token it belongs to.
  installationId?: number | null | undefined;
}): Promise<LinkedIssueHardRuleResult | undefined> {
  const anyRuleOn =
    args.config.ownerAssignedClose === "block" ||
    args.config.assignedIssueClose === "block" ||
    args.config.missingPointLabelClose === "block" ||
    args.config.maintainerOnlyLabelClose === "block";
  if (!anyRuleOn) return undefined;
  if (extractLinkedIssueNumbersWithOverflow(args.body ?? "", args.repoFullName).overflow) {
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
  return evaluateLinkedIssueHardRules({ issues: issueFacts, config: args.config, repoOwner: args.repoOwner, prAuthorLogin: args.prAuthorLogin });
}

// ── Stale/fabricated-link countermeasure for the "must link an issue" HARD gate (#unlinked-issue-guardrail-
// followup) ──────────────────────────────────────────────────────────────────────────────────────────────
//
// `pr.linkedIssues` (extractLinkedIssueNumbersWithOverflow) is a pure body-text regex match — it never checks
// whether the cited issue is actually OPEN. So a repo running `linkedIssueGateMode: "block"` (requires a
// linked issue to merge) can be satisfied by a contributor citing an already-CLOSED or fabricated issue
// number, which defeats the whole point of requiring a link. This pair of functions gives the gate a
// verified, fail-open "is at least one citation a real, currently open issue" signal to use INSTEAD of bare
// presence, without changing what `pr.linkedIssues` itself means anywhere else it's used (duplicate-winner
// overlap, label propagation, scoring, etc. all keep reading raw presence).

/**
 * PURE evaluator. `true` means "treat the presence check as satisfied" — either a linked issue is CONFIRMED
 * open, or at least one fetch was ambiguous (`fetch_error`) and we can't rule out a real open issue behind
 * it. `false` — the only case this whole mechanism exists to catch — means EVERY fetched result conclusively
 * resolved to NOT an open issue (found-but-closed, or a confirmed 404), with zero ambiguity. An empty input
 * (nothing was fetched, e.g. the caller didn't need to check) fails open to `true` — the caller is
 * responsible for handling "no linked issues at all" separately (that's the existing bare-presence check).
 */
export function hasVerifiableOpenLinkedIssueReference(fetchResults: LinkedIssueFactsFetch[]): boolean {
  if (fetchResults.length === 0) return true;
  if (fetchResults.some((result) => result.status === "found" && result.facts.state === "open")) return true;
  return fetchResults.some((result) => result.status === "fetch_error");
}

/**
 * Orchestrate the live per-issue fetch for {@link hasVerifiableOpenLinkedIssueReference}. Mints its own
 * installation token (falling back to the public token, exactly like fetchLinkedIssueFacts's own
 * hasProvenAccess discipline degrades a public-token 404 to `fetch_error` rather than a confirmed miss) so
 * callers only need an `installationId`, mirroring `resolveLinkedIssueAuthorLogins`'s lazy-token pattern.
 * Fail-safe: a token-mint failure still proceeds on the public token rather than skipping the check.
 */
export async function resolveLinkedIssueHasOpenReference(args: {
  env: Env;
  repoFullName: string;
  linkedIssues: number[];
  installationId?: number | null | undefined;
}): Promise<boolean> {
  if (args.linkedIssues.length === 0) return true;
  // Fail open (mirrors hasVerifiableOpenLinkedIssueReference's own ambiguity philosophy above) rather than
  // firing an unbounded per-issue fan-out for a body citing more references than can be safely verified in
  // one pass -- the same cap resolveLinkedIssueHardRule's own extractLinkedIssueNumbersWithOverflow enforces
  // on the sibling gate, reused here instead of a second bound so a noisy body can't create surprise API
  // pressure on this path.
  if (args.linkedIssues.length > MAX_LINKED_ISSUE_NUMBERS) return true;
  const ciToken = args.installationId ? await createInstallationToken(args.env, args.installationId).catch(() => undefined) : undefined;
  const token = ciToken ?? args.env.GITHUB_PUBLIC_TOKEN;
  const admissionKey = githubRateLimitAdmissionKeyForToken(args.env, token, args.installationId);
  const fetchResults = await Promise.all(args.linkedIssues.map((issueNumber) => fetchLinkedIssueFacts(args.env, args.repoFullName, issueNumber, token, admissionKey)));
  return hasVerifiableOpenLinkedIssueReference(fetchResults);
}
