// #9541 (deliverable 2) / #9491: the ONE precondition check every paid per-PR advisory shares.
//
// Three features each make a paid LLM call per PR head — `ai_slop` (slop-detection.ts), `ai_review`
// (ai-review-orchestration.ts) and the linked-issue satisfaction advisory (processors.ts). Each grew its own
// hand-written guard line, and they drifted: #9491 found the linked-issue advisory was the one member of the
// family with NO per-PR commit cap at all, so a long-lived PR kept paying for a fresh assessment on every
// push long after its two siblings had stopped. That is not a coding mistake anyone could have caught by
// reading one function — the guards live in three files, and the missing one looked complete on its own.
//
// This module owns the stops that are UNIVERSAL, so a fourth advisory cannot be written without them.
//
// WHAT IS DELIBERATELY *NOT* HERE: the eligible-author rule. It looks shared (`!confirmedContributor` appears
// in two of the three) but genuinely is not — `ai_review` reviews some UNCONFIRMED authors on purpose, via
// `resolveAiReviewableAuthor`'s `aiReviewAllAuthors` / gate-pack policy. Folding that into a common predicate
// would either silently narrow `ai_review`'s audience or silently widen the other two's, and a "shared" rule
// that is wrong for one caller is how the next #9491 gets written. Each feature keeps its own author gate;
// only the stops that are true for every paid advisory live here.
import type { AgentActionMode } from "../settings/agent-execution";

/** Why a paid advisory must not spend, or `null` when it may proceed. A NAMED reason rather than a boolean,
 *  mirroring `resolvePublicAiReviewGateSkipReason`'s own shape — the caller usually wants to audit or log
 *  which stop fired, and a bare `false` forces every call site to re-derive that. */
export type AdvisorySpendStopReason = "paused" | "no_head_sha" | "commit_threshold_reached";

export type AdvisorySpendPreconditions = {
  /** A paused repo must never reach a paid LLM call, independent of the feature's own mode setting. */
  mode: AgentActionMode;
  /** The advisory's resolved head SHA. Absent ⇒ there is no specific head to attribute the spend to. */
  headSha: string | null | undefined;
  /** The per-PR reviewed-commit cap the whole family honors (#9491). */
  commitThresholdReached: boolean;
};

/**
 * The universal spend stops, in the order the existing hand-written guards applied them — so adopting this
 * function is behaviour-preserving for every current caller, not a re-ordering that changes which audit
 * event a given PR emits.
 *
 * PURE: no IO, no clock. The caller decides what to do with a non-null reason (return silently, record an
 * audit event, log) — those responses legitimately differ per feature and are not unified here.
 */
export function advisorySpendStopReason(preconditions: AdvisorySpendPreconditions): AdvisorySpendStopReason | null {
  if (preconditions.mode === "paused") return "paused";
  if (!preconditions.headSha) return "no_head_sha";
  if (preconditions.commitThresholdReached) return "commit_threshold_reached";
  return null;
}
