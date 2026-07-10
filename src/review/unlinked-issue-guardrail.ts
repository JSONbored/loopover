// Orchestrator for the unlinked-issue guardrail (#unlinked-issue-guardrail, credibility-gate-farming
// defense). Combines the config gate, the cheap deterministic pre-filter (src/signals/unlinked-issue-
// candidates.ts), and the AI precision check (./unlinked-issue-match.ts) into a single per-PR decision: does
// this PR's diff appear to directly solve an EXISTING open issue it never linked? A FIRST confirmed match
// HOLDS the PR for manual review (never auto-closes, never auto-merges past it) -- see src/settings/
// agent-actions.ts's `unlinkedIssueMatchHold`. A CONFIRMED REPEAT by the SAME contributor (tracked via the
// existing `audit_events` ledger -- the same general-purpose actor/event-type ledger already used for the
// review-nag cooldown and decision-pack debounce, `hasRecentAuditEvent`/`recordAuditEvent` in
// db/repositories.ts) escalates to an actual CLOSE (`unlinkedIssueMatchClose`), since a second occurrence is
// no longer a coincidence worth a human's benefit of the doubt.
//
// Cost-bounded by construction: every short-circuit below runs BEFORE the DB read or any AI call, so a
// repo that hasn't opted in (the default) or a PR that already links an issue (the common case) pays
// nothing beyond two boolean checks.

import { getFreshOfficialMinerDetection, mostRecentAuditEventForOtherTarget, listOpenIssues, recordAuditEvent, upsertOfficialMinerDetection } from "../db/repositories";
import { fetchOfficialGittensorMiner } from "../gittensor/api";
import { findUnlinkedIssueCandidates, type CandidateOpenIssue } from "../signals/unlinked-issue-candidates";
import type { UnlinkedIssueGuardrailConfig } from "../types";
import { verifyUnlinkedIssueMatch } from "./unlinked-issue-match";

/** Shared with any future reader that wants to correlate these holds/closes across repos for one contributor. */
export const UNLINKED_ISSUE_MATCH_AUDIT_EVENT_TYPE = "github_app.unlinked_issue_match_hold";
// Same recency convention as submitter-reputation.ts's REPUTATION_WINDOW_DAYS -- a match from a year ago
// shouldn't silently escalate every fresh, unrelated match into an auto-close forever.
const UNLINKED_ISSUE_MATCH_REPEAT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
// #4512: a confirmed repeat inside this gap reads as "the same tooling bug firing again," not "a human
// deliberately farming the guardrail twice" -- no ordinary contributor realistically re-triggers the exact
// same unlinked-issue pattern this fast. Gated on CONFIRMED official-miner identity (below), not on speed
// alone, so this can't be used to launder genuine rapid-fire abuse from an unverified account: an unverified
// actor repeating this fast still escalates to close exactly as before.
const VELOCITY_EXCEPTION_MAX_GAP_MS = 60 * 60 * 1000;
// Mirrors processors.ts's own official-miner-detection cache TTLs (kept local -- importing them would create
// a circular dependency, since processors.ts is the one that imports FROM this module).
const OFFICIAL_MINER_DETECTION_TTL_MS = 5 * 60 * 1000;
const OFFICIAL_MINER_DETECTION_UNAVAILABLE_TTL_MS = 60 * 1000;

/** Minimal cached miner-identity check, deliberately independent of processors.ts's getCachedOfficialMinerDetection
 *  (same cache table and TTLs, no audit-log side effect -- this call site doesn't need one). Fail-safe: any
 *  lookup failure resolves to "not a confirmed miner," never the reverse. */
async function isConfirmedOfficialMiner(env: Env, login: string): Promise<boolean> {
  const cached = await getFreshOfficialMinerDetection(env, login).catch(() => null);
  if (cached) return cached.status === "confirmed";
  // fetchOfficialGittensorMiner already converts every failure into a returned {status: "unavailable"}
  // value rather than rejecting -- nothing to catch here.
  const detection = await fetchOfficialGittensorMiner(login);
  // A cache-write failure must never block the caller from using the freshly-fetched (just uncached)
  // detection -- worst case, the next call re-fetches instead of hitting the cache.
  const cacheable = await upsertOfficialMinerDetection(
    env,
    login,
    detection,
    detection.status === "unavailable" ? OFFICIAL_MINER_DETECTION_UNAVAILABLE_TTL_MS : OFFICIAL_MINER_DETECTION_TTL_MS,
  ).catch(() => detection);
  return cacheable.status === "confirmed";
}

export type UnlinkedIssueMatchDisposition = { kind: "hold"; reason: string; comment: string } | { kind: "close"; reason: string; comment: string };

export type ResolveUnlinkedIssueMatchDispositionInput = {
  repoFullName: string;
  config: UnlinkedIssueGuardrailConfig;
  /** The PR's OWN linked-issue count (already extracted by the caller) -- the guardrail only ever runs
   *  against a PR that links NOTHING; a PR linking a different issue is out of scope for this check. */
  linkedIssueCount: number;
  pullNumber: number;
  prTitle: string;
  prBody: string | null | undefined;
  changedPaths: string[];
  diff: string;
  /** Needed to detect a repeat by this SAME contributor. A missing/unknown author can never be reliably
   *  correlated across PRs, so repeat-detection is skipped entirely and a confirmed match always holds
   *  (fail-safe: never escalate to a close on an unidentifiable author). */
  prAuthorLogin: string | null | undefined;
};

function unlinkedIssueMatchTargetKey(repoFullName: string, pullNumber: number): string {
  return `${repoFullName}#${pullNumber}`;
}

/** Has this contributor triggered a confirmed unlinked-issue match on another PR (any repo) within the
 *  recency window, and if so when? Fail-safe: a read error resolves to "no prior match" (never wrongly
 *  escalates on a DB hiccup). Timestamp (not just a boolean) so the caller can apply the #4512 velocity
 *  exception. */
async function priorUnlinkedIssueMatchTimestamp(env: Env, authorLogin: string, currentTargetKey: string): Promise<string | null> {
  const sinceIso = new Date(Date.now() - UNLINKED_ISSUE_MATCH_REPEAT_WINDOW_MS).toISOString();
  return mostRecentAuditEventForOtherTarget(env, authorLogin, UNLINKED_ISSUE_MATCH_AUDIT_EVENT_TYPE, currentTargetKey, sinceIso).catch(() => null);
}

/** Record THIS occurrence so a later PR from the same contributor can be recognized as a repeat. Fire-and-
 *  forget: a write failure must never block the gate -- worst case, a future occurrence fails open to a hold
 *  instead of escalating, never the reverse. */
async function recordUnlinkedIssueMatchOccurrence(env: Env, repoFullName: string, pullNumber: number, authorLogin: string, issueNumber: number): Promise<void> {
  await recordAuditEvent(env, {
    eventType: UNLINKED_ISSUE_MATCH_AUDIT_EVENT_TYPE,
    actor: authorLogin,
    targetKey: unlinkedIssueMatchTargetKey(repoFullName, pullNumber),
    outcome: "completed",
    detail: `unlinked PR diff matched open issue #${issueNumber} without a linking reference`,
    metadata: { issueNumber },
  }).catch(() => undefined);
}

/**
 * Resolve the unlinked-issue-match disposition for one PR, or `undefined` when nothing should hold or close
 * it. Checks candidates in the pre-filter's ranked order and acts on the FIRST one that clears
 * `config.minConfidence`, so at most one issue is ever cited even if several loosely qualify.
 */
export async function resolveUnlinkedIssueMatchDisposition(env: Env, input: ResolveUnlinkedIssueMatchDispositionInput): Promise<UnlinkedIssueMatchDisposition | undefined> {
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
  const authorLogin = input.prAuthorLogin?.trim() || null;
  for (const candidate of candidates) {
    const verdict = await verifyUnlinkedIssueMatch(env, {
      prTitle: input.prTitle,
      prBody: input.prBody,
      diff: input.diff,
      candidate: candidate.issue,
    });
    if (!verdict.matched || verdict.confidence < input.config.minConfidence) continue;
    const evidenceSuffix = verdict.evidence ? ` (${verdict.evidence})` : "";
    if (!authorLogin) {
      return {
        kind: "hold",
        reason: `this PR links no issue, but appears to directly solve open issue #${candidate.issue.number} without linking it${evidenceSuffix}`,
        comment: `This PR doesn't link an issue, but its diff appears to directly solve #${candidate.issue.number}. If that's right, please add a linking reference (e.g. \`Closes #${candidate.issue.number}\`) so it's credited correctly; if this is a coincidence, a maintainer will clear this hold shortly.`,
      };
    }
    const currentTargetKey = unlinkedIssueMatchTargetKey(input.repoFullName, input.pullNumber);
    const priorMatchIso = await priorUnlinkedIssueMatchTimestamp(env, authorLogin, currentTargetKey);
    await recordUnlinkedIssueMatchOccurrence(env, input.repoFullName, input.pullNumber, authorLogin, candidate.issue.number);
    if (priorMatchIso) {
      const gapMs = Date.now() - new Date(priorMatchIso).getTime();
      // #4512 velocity exception: gated on CONFIRMED miner identity, not on speed alone -- an unverified
      // account repeating this fast is the MORE suspicious case, not less, and still escalates to close.
      const velocityExceptionApplies = gapMs >= 0 && gapMs < VELOCITY_EXCEPTION_MAX_GAP_MS && (await isConfirmedOfficialMiner(env, authorLogin).catch(() => false));
      if (!velocityExceptionApplies) {
        return {
          kind: "close",
          reason: `this PR appears to directly solve open issue #${candidate.issue.number} without linking it${evidenceSuffix} — a repeat of the same unlinked-issue pattern already flagged on an earlier PR from this contributor`,
          comment: `Closing: this PR doesn't link an issue, but its diff appears to directly solve #${candidate.issue.number} — the same unlinked-issue pattern already flagged on one of your earlier PRs. Please link the issue you're solving (e.g. \`Closes #N\`) going forward.`,
        };
      }
      return {
        kind: "hold",
        reason: `this PR appears to directly solve open issue #${candidate.issue.number} without linking it${evidenceSuffix} — a repeat of the same unlinked-issue pattern flagged on an earlier PR from this contributor within the last hour, held rather than closed pending confirmation this is a genuine tooling issue rather than deliberate repeat abuse`,
        comment: `This PR doesn't link an issue, but its diff appears to directly solve #${candidate.issue.number} — the same unlinked-issue pattern was flagged on one of your PRs within the last hour. Please link the issue you're solving (e.g. \`Closes #${candidate.issue.number}\`); repeated occurrences this close together will be reviewed manually rather than closed automatically.`,
      };
    }
    return {
      kind: "hold",
      reason: `this PR links no issue, but appears to directly solve open issue #${candidate.issue.number} without linking it${evidenceSuffix}`,
      comment: `This PR doesn't link an issue, but its diff appears to directly solve #${candidate.issue.number}. If that's right, please add a linking reference (e.g. \`Closes #${candidate.issue.number}\`) so it's credited correctly; if this is a coincidence, a maintainer will clear this hold shortly.`,
    };
  }
  return undefined;
}
