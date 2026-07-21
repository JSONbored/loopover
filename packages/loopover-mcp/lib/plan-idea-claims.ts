import {
  buildClaimPlan,
  buildTaskGraph,
  existingTargetRepo,
  validateIdeaSubmission,
  type ClaimPlan,
  type ConstituentIssueDraft,
  type FeasibilityVerdict,
} from "@loopover/engine";

export type PlanIdeaClaimsInput = {
  id?: string | undefined;
  title?: string | undefined;
  body?: string | undefined;
  targetRepo?: unknown;
  constraints?: string[] | undefined;
  acceptanceHints?: string[] | undefined;
  priority?: string | undefined;
  decomposition?: ConstituentIssueDraft[] | undefined;
};

export type PlanIdeaClaimsPayload =
  | { ok: true; verdict: FeasibilityVerdict; claimPlan: ClaimPlan }
  | { ok: false; errors: string[] };

/** Pure stdio/REST parity handler for loopover_plan_idea_claims (#6756, #7635). */
export function planIdeaClaimsPayload(input: PlanIdeaClaimsInput): PlanIdeaClaimsPayload {
  const validated = validateIdeaSubmission(input);
  if (!validated.ok) return { ok: false, errors: validated.errors };
  const graph = buildTaskGraph(validated.idea, input.decomposition);
  const repo = existingTargetRepo(validated.idea.targetRepo);
  if (repo === null) return { ok: false, errors: ["target_repo_required"] };
  const claimPlan = buildClaimPlan(graph, repo);
  return { ok: true, verdict: claimPlan.graphVerdict, claimPlan };
}
