// Orchestrator for the unlinked-issue guardrail (#unlinked-issue-guardrail, credibility-gate-farming
// defense). Combines the config gate, the cheap deterministic pre-filter (src/signals/unlinked-issue-
// candidates.ts), and the AI precision check (./unlinked-issue-match.ts) into a single per-PR decision: does
// this PR's diff appear to directly solve an EXISTING open issue it never linked? If so, HOLD it for manual
// review (never auto-close, never auto-merge past it) -- see src/settings/agent-actions.ts's
// `unlinkedIssueMatchHold`.
//
// Cost-bounded by construction: every short-circuit below runs BEFORE the DB read or any AI call, so a
// repo that hasn't opted in (the default) or a PR that already links an issue (the common case) pays
// nothing beyond two boolean checks.

import { listOpenIssues } from "../db/repositories";
import { findUnlinkedIssueCandidates, type CandidateOpenIssue } from "../signals/unlinked-issue-candidates";
import type { UnlinkedIssueGuardrailConfig } from "../types";
import { verifyUnlinkedIssueMatch } from "./unlinked-issue-match";

export type UnlinkedIssueMatchHold = { reason: string; comment: string };

export type ResolveUnlinkedIssueMatchHoldInput = {
  repoFullName: string;
  config: UnlinkedIssueGuardrailConfig;
  /** The PR's OWN linked-issue count (already extracted by the caller) -- the guardrail only ever runs
   *  against a PR that links NOTHING; a PR linking a different issue is out of scope for this check. */
  linkedIssueCount: number;
  prTitle: string;
  prBody: string | null | undefined;
  changedPaths: string[];
  diff: string;
};

/**
 * Resolve the unlinked-issue-match hold for one PR, or `undefined` when nothing should hold it. Checks
 * candidates in the pre-filter's ranked order and returns on the FIRST one that clears
 * `config.minConfidence`, so at most one issue is ever cited even if several loosely qualify.
 */
export async function resolveUnlinkedIssueMatchHold(env: Env, input: ResolveUnlinkedIssueMatchHoldInput): Promise<UnlinkedIssueMatchHold | undefined> {
  if (input.config.mode !== "hold") return undefined;
  if (input.linkedIssueCount > 0) return undefined;
  const openIssues = await listOpenIssues(env, input.repoFullName);
  const candidateIssues: CandidateOpenIssue[] = openIssues.map((issue) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body ?? null,
    labels: issue.labels,
  }));
  const candidates = findUnlinkedIssueCandidates({
    prTitle: input.prTitle,
    prBody: input.prBody,
    changedPaths: input.changedPaths,
    openIssues: candidateIssues,
  });
  if (candidates.length === 0) return undefined;
  for (const candidate of candidates) {
    const verdict = await verifyUnlinkedIssueMatch(env, {
      prTitle: input.prTitle,
      prBody: input.prBody,
      diff: input.diff,
      candidate: candidate.issue,
    });
    if (verdict.matched && verdict.confidence >= input.config.minConfidence) {
      const evidenceSuffix = verdict.evidence ? ` (${verdict.evidence})` : "";
      return {
        reason: `this PR links no issue, but appears to directly solve open issue #${candidate.issue.number} without linking it${evidenceSuffix}`,
        comment: `This PR doesn't link an issue, but its diff appears to directly solve #${candidate.issue.number}. If that's right, please add a linking reference (e.g. \`Closes #${candidate.issue.number}\`) so it's credited correctly; if this is a coincidence, a maintainer will clear this hold shortly.`,
      };
    }
  }
  return undefined;
}
