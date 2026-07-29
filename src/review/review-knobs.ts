// The effective AI-review knobs for one PR — provider, model, reasoning effort, self-consistency runs
// (#9808/#9821).
//
// (Named "knobs", not "effort", because src/review/review-effort.ts already owns a different meaning of that
// word: the deterministic estimate of how many MINUTES a HUMAN should budget. The `effort` field here is the
// model's own reasoning effort — `claude --effort` / Codex `model_reasoning_effort`.)
//
// WHY THIS EXISTS: a `hardGuardrailGlobs` hit used to change exactly one thing — it suppressed auto-merge and
// held the PR for a human. It bought no extra analysis whatsoever: a PR touching `.github/workflows/**` got the
// same single-pass, same-model, same-effort review as a README typo. Measured on the production ORB that was 74
// distinct PRs held in 14 days, on repos whose guardrail lists had already been narrowed twice. Automation was
// being replaced by a maintainer queue without the scrutiny actually going up.
//
// A guardrail hit can now ESCALATE instead: higher reasoning effort, more independent runs, optionally a
// different model or provider. Manual review remains the fallback for genuine uncertainty — the disposition
// still holds when the escalated review is not clean — but it is no longer the automatic price of touching a
// protected path.
//
// PRECEDENCE, most specific wins:
//   guardrail escalation (ONLY when the PR hits a guarded path)
//     -> per-repo `gate.aiReview.*` (.loopover.yml)
//       -> global env (CLAUDE_AI_EFFORT / AI_REVIEW_SELF_CONSISTENCY_RUNS / CLAUDE_AI_MODEL / AI_PROVIDER)
//
// Each field resolves INDEPENDENTLY: an escalation block that sets only `effort` still inherits the repo's
// model and the global provider. That matters because the common request is "same model, think harder" — a
// maintainer raising scrutiny usually does not want to change which model reviews their code.

/** The four knobs a maintainer can choose at any layer. `null`/absent ⇒ inherit the next layer down. */
export type ReviewKnobs = {
  provider: string | null;
  model: string | null;
  effort: string | null;
  selfConsistencyRuns: number | null;
};

export type ResolvedReviewKnobs = ReviewKnobs & {
  /** True when the escalation layer supplied at least one value — i.e. this PR is reviewed MORE heavily
   *  because it touches a protected path. Surfaced so the panel and the decision record can say so:
   *  "escalated review on a guarded path: effort=high, 3 runs" is what makes the gate legible to a
   *  contributor, and what makes an auto-merge on a guarded path defensible in the audit trail. */
  escalated: boolean;
  /** Exactly which fields the escalation layer changed, for that same surfacing. Empty when not escalated. */
  escalatedFields: string[];
};

const KNOB_ORDER = ["provider", "model", "effort", "selfConsistencyRuns"] as const;

/**
 * PURE: resolve the effective knobs for one review.
 *
 * `guardrailHit` is the caller's own `isGuardrailHit(changedPaths, hardGuardrailGlobs)` result. This module
 * deliberately does NOT re-derive it, so there is exactly one definition of "does this PR touch a guarded
 * path" (src/signals/change-guardrail.ts, shared with the engine) rather than a second one free to drift.
 */
export function resolveReviewKnobs(args: {
  guardrailHit: boolean;
  escalation?: Partial<ReviewKnobs> | undefined;
  repo?: Partial<ReviewKnobs> | undefined;
  global?: Partial<ReviewKnobs> | undefined;
}): ResolvedReviewKnobs {
  const escalatedFields: string[] = [];
  const resolved: ReviewKnobs = { provider: null, model: null, effort: null, selfConsistencyRuns: null };

  // Fixed order so escalatedFields reads in a stable, reportable sequence rather than in whatever order a
  // consumer happens to destructure.
  for (const field of KNOB_ORDER) {
    const escalated = args.guardrailHit ? args.escalation?.[field] : null;
    if (escalated !== null && escalated !== undefined) {
      escalatedFields.push(field);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- one assignment across a union of field types
      (resolved as any)[field] = escalated;
      continue;
    }
    const repo = args.repo?.[field];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
    (resolved as any)[field] = repo !== null && repo !== undefined ? repo : (args.global?.[field] ?? null);
  }

  return { ...resolved, escalated: escalatedFields.length > 0, escalatedFields };
}

/** Human-readable summary of an escalation for the panel and the decision record. Null when not escalated, so
 *  a caller can fold it into a surface without a branch of its own. */
export function describeReviewEscalation(resolved: ResolvedReviewKnobs): string | null {
  const parts: string[] = [];
  if (resolved.escalatedFields.includes("provider") && resolved.provider) parts.push(`provider=${resolved.provider}`);
  if (resolved.escalatedFields.includes("model") && resolved.model) parts.push(`model=${resolved.model}`);
  if (resolved.escalatedFields.includes("effort") && resolved.effort) parts.push(`effort=${resolved.effort}`);
  if (resolved.escalatedFields.includes("selfConsistencyRuns") && resolved.selfConsistencyRuns !== null) {
    parts.push(`${resolved.selfConsistencyRuns} runs`);
  }
  return parts.length > 0 ? `escalated review on a guarded path: ${parts.join(", ")}` : null;
}
