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

import {
  countRecentAuditEventsForActor,
  getFreshOfficialMinerDetection,
  mostRecentAuditEventForOtherTarget,
  listOpenIssues,
  recordAiUsageEvent,
  recordAuditEvent,
  sumAiEstimatedNeuronsSince,
  upsertOfficialMinerDetection,
} from "../db/repositories";
import { fetchOfficialGittensorMiner } from "../gittensor/api";
import { BEST_REVIEW_MODELS, RELIABLE_FALLBACK_MODELS, clampNumber, estimateNeurons, utcDayStartIso } from "../services/ai-review";
import { findUnlinkedIssueCandidates, MAX_CANDIDATES, type CandidateOpenIssue } from "../signals/unlinked-issue-candidates";
import type { UnlinkedIssueGuardrailConfig } from "../types";
import { DIFF_CHAR_BUDGET, MAX_TOKENS, verifyUnlinkedIssueMatch } from "./unlinked-issue-match";

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

// #4515: every candidate below costs one real (if small) AI call, so two cost-control gates run ahead of the
// loop -- a per-actor RATE ceiling, and a check against the shared daily neuron budget every other free-tier
// AI feature draws from (sumAiEstimatedNeuronsSince/AI_DAILY_NEURON_BUDGET, mirroring ai-slop.ts's own
// pre-call budget check). Both are cost controls, not correctness gates: on any read failure they fail
// toward "proceed as if this layer didn't exist" (full verification runs), never toward silently disabling
// the guardrail they sit in front of by skipping straight to `undefined`.
export const UNLINKED_ISSUE_VERIFY_ATTEMPT_AUDIT_EVENT_TYPE = "github_app.unlinked_issue_verify_attempt";
// Generous by design: a legitimate contributor never approaches this in an hour even opening several PRs
// back-to-back. Sized to catch a scripted/abusive burst hammering the AI verifier, not ordinary human cadence.
const VERIFY_RATE_CEILING_MAX_ATTEMPTS = 15;
const VERIFY_RATE_CEILING_WINDOW_MS = 60 * 60 * 1000;
// Flat overhead for the parts of the verifier's prompt that aren't the (already-bounded) diff -- the system
// prompt, PR title/body, and candidate issue title/body. None of these are cheaply boundable per candidate
// ahead of time, so this deliberately over-, never under-, estimates: a budget check must never undercount.
const VERIFY_PROMPT_OVERHEAD_CHAR_ESTIMATE = 2_000;
// verifyUnlinkedIssueMatch tries a primary model and, ONLY on a thrown error, a fallback -- two calls is the
// real worst case per candidate, not the common case, but this budget check must size for the worst case.
const VERIFY_MAX_MODEL_ATTEMPTS_PER_CANDIDATE = 2;
// Review feedback on #4551: the budget check above reads sumAiEstimatedNeuronsSince, but without a writer
// this feature's own real AI spend never contributed to that counter -- a free rider that respects every
// OTHER feature's usage but never counts its own, so the true aggregate spend could silently exceed
// AI_DAILY_NEURON_BUDGET by however much this feature actually used. recordUnlinkedIssueVerifyUsage (below)
// closes that gap by recording into the SAME shared ai_usage_events table this check reads from.
const UNLINKED_ISSUE_VERIFY_USAGE_FEATURE = "unlinked_issue_verify";

function unlinkedIssueVerifyCapacityHold(reason: "rate" | "budget"): UnlinkedIssueMatchDisposition {
  const detail = reason === "rate" ? "the per-contributor verifier rate ceiling has been reached" : "the shared verifier budget is exhausted";
  return {
    kind: "hold",
    reason: `unlinked-issue-match verification was deferred because ${detail}; holding for manual review instead of treating capacity exhaustion as a clean pass`,
    comment:
      "This PR does not link an issue and matched the unlinked-issue prefilter, but the final verifier is temporarily capacity-limited. A maintainer should manually confirm whether it directly solves an open issue before this PR proceeds.",
  };
}

function hasUnlinkedIssueVerifyAiBinding(env: Env): boolean {
  const ai = env.AI as unknown as { run?: unknown } | undefined;
  return typeof ai?.run === "function";
}

/** Has this actor already run the AI verifier at or beyond the rate ceiling in the last window, across every
 *  repo/PR? Fail-safe: a read error resolves to "not rate-limited," so the pre-#4515 unconditional-
 *  verification behavior takes over rather than a DB hiccup silently disabling this guardrail. */
async function isOverUnlinkedIssueVerifyRateCeiling(env: Env, authorLogin: string): Promise<boolean> {
  const sinceIso = new Date(Date.now() - VERIFY_RATE_CEILING_WINDOW_MS).toISOString();
  const count = await countRecentAuditEventsForActor(env, authorLogin, UNLINKED_ISSUE_VERIFY_ATTEMPT_AUDIT_EVENT_TYPE, sinceIso).catch(() => 0);
  return count >= VERIFY_RATE_CEILING_MAX_ATTEMPTS;
}

/** Would verifying `candidateCount` candidates (each up to {@link VERIFY_MAX_MODEL_ATTEMPTS_PER_CANDIDATE}
 *  model calls) risk exceeding the shared daily AI neuron budget -- the same counter/env var every other
 *  free-tier AI feature draws from? `candidateCount` is defensively re-clamped to {@link MAX_CANDIDATES}: the
 *  caller already bounds it there, but this estimate must never balloon even if that invariant ever slips.
 *  Fail-safe for the same reason as the rate ceiling above: a read error resolves to "budget available." */
async function isUnlinkedIssueVerifyBudgetExceeded(env: Env, candidateCount: number): Promise<boolean> {
  const worstCaseCandidateCount = Math.min(candidateCount, MAX_CANDIDATES);
  const estimatedNeurons = estimateNeurons(
    DIFF_CHAR_BUDGET + VERIFY_PROMPT_OVERHEAD_CHAR_ESTIMATE,
    MAX_TOKENS,
    worstCaseCandidateCount * VERIFY_MAX_MODEL_ATTEMPTS_PER_CANDIDATE,
  );
  // Resolved IDENTICALLY to ai-slop.ts's own pre-call check -- both features sum into the same
  // sumAiEstimatedNeuronsSince counter, so a divergent default/ceiling here would under- or over-count
  // against the one real shared budget.
  const rawNeuronBudget = Number(env.AI_DAILY_NEURON_BUDGET);
  const budget = clampNumber(env.AI_DAILY_NEURON_BUDGET && Number.isFinite(rawNeuronBudget) ? rawNeuronBudget : 10_000_000, 0, 10_000_000);
  const used = await sumAiEstimatedNeuronsSince(env, utcDayStartIso()).catch(() => 0);
  const remainingBudget = Math.max(0, budget - used);
  return estimatedNeurons > remainingBudget;
}

/** Record ONE candidate's actual AI spend into the shared `ai_usage_events` ledger -- the SAME table
 *  {@link isUnlinkedIssueVerifyBudgetExceeded} sums from, so this feature's own usage counts against the
 *  budget it itself enforces on others (see the module-level comment on {@link UNLINKED_ISSUE_VERIFY_USAGE_FEATURE}).
 *  Records the same worst-case per-candidate estimate the budget check itself uses -- a deliberate over-count
 *  (verifyUnlinkedIssueMatch's common case is ONE model call, not the two this sizes for), not a precise
 *  post-hoc token read, mirroring ai-slop.ts's own pre-computed-estimate recording convention. Best-effort: a
 *  write failure is swallowed (telemetry must never block the gate). */
async function recordUnlinkedIssueVerifyUsage(env: Env, repoFullName: string, pullNumber: number): Promise<void> {
  const estimatedNeurons = estimateNeurons(DIFF_CHAR_BUDGET + VERIFY_PROMPT_OVERHEAD_CHAR_ESTIMATE, MAX_TOKENS, VERIFY_MAX_MODEL_ATTEMPTS_PER_CANDIDATE);
  await recordAiUsageEvent(env, {
    feature: UNLINKED_ISSUE_VERIFY_USAGE_FEATURE,
    route: "github_app.unlinked_issue_verify",
    model: [BEST_REVIEW_MODELS[0], RELIABLE_FALLBACK_MODELS[0]].join("+"),
    status: "ok",
    estimatedNeurons,
    detail: `unlinked-issue-match verification for ${repoFullName}#${pullNumber}`,
  }).catch(() => undefined);
}

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

/** Record that the AI verifier actually ran against one candidate, so {@link isOverUnlinkedIssueVerifyRateCeiling}
 *  accumulates this actor's volume correctly across every repo/PR they touch, not just this thread. Fire-and-
 *  forget, same rationale as {@link recordUnlinkedIssueMatchOccurrence}: a write failure must never block the gate. */
async function recordUnlinkedIssueVerifyAttempt(env: Env, repoFullName: string, pullNumber: number, authorLogin: string): Promise<void> {
  await recordAuditEvent(env, {
    eventType: UNLINKED_ISSUE_VERIFY_ATTEMPT_AUDIT_EVENT_TYPE,
    actor: authorLogin,
    targetKey: unlinkedIssueMatchTargetKey(repoFullName, pullNumber),
    outcome: "completed",
    detail: "unlinked-issue-match AI verifier invoked",
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
  // #4515: cost-control gates ahead of the AI loop below. An unidentifiable author can't be rate-limited
  // individually (nothing to key the ceiling on), so only the shared budget check applies to them.
  if (authorLogin && (await isOverUnlinkedIssueVerifyRateCeiling(env, authorLogin))) return unlinkedIssueVerifyCapacityHold("rate");
  if (await isUnlinkedIssueVerifyBudgetExceeded(env, candidates.length)) return unlinkedIssueVerifyCapacityHold("budget");
  for (const candidate of candidates) {
    if (authorLogin) await recordUnlinkedIssueVerifyAttempt(env, input.repoFullName, input.pullNumber, authorLogin);
    const hadAiBinding = hasUnlinkedIssueVerifyAiBinding(env);
    const verdict = await verifyUnlinkedIssueMatch(env, {
      prTitle: input.prTitle,
      prBody: input.prBody,
      diff: input.diff,
      candidate: candidate.issue,
    });
    // Record spend only after an actual verifier invocation was possible. Missing/no-op AI bindings should
    // fail closed to NO_MATCH without burning the shared budget ledger as if an ok call occurred.
    if (hadAiBinding) await recordUnlinkedIssueVerifyUsage(env, input.repoFullName, input.pullNumber);
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
