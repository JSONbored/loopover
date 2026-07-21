import { buildClaimPlan, buildTaskGraph, existingTargetRepo, validateIdeaSubmission, } from "@loopover/engine";
/** Pure stdio/REST parity handler for loopover_plan_idea_claims (#6756, #7635). */
export function planIdeaClaimsPayload(input) {
    const validated = validateIdeaSubmission(input);
    if (!validated.ok)
        return { ok: false, errors: validated.errors };
    const graph = buildTaskGraph(validated.idea, input.decomposition);
    const repo = existingTargetRepo(validated.idea.targetRepo);
    if (repo === null)
        return { ok: false, errors: ["target_repo_required"] };
    const claimPlan = buildClaimPlan(graph, repo);
    return { ok: true, verdict: claimPlan.graphVerdict, claimPlan };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicGxhbi1pZGVhLWNsYWltcy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInBsYW4taWRlYS1jbGFpbXMudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUNMLGNBQWMsRUFDZCxjQUFjLEVBQ2Qsa0JBQWtCLEVBQ2xCLHNCQUFzQixHQUl2QixNQUFNLGtCQUFrQixDQUFDO0FBaUIxQixtRkFBbUY7QUFDbkYsTUFBTSxVQUFVLHFCQUFxQixDQUFDLEtBQTBCO0lBQzlELE1BQU0sU0FBUyxHQUFHLHNCQUFzQixDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQ2hELElBQUksQ0FBQyxTQUFTLENBQUMsRUFBRTtRQUFFLE9BQU8sRUFBRSxFQUFFLEVBQUUsS0FBSyxFQUFFLE1BQU0sRUFBRSxTQUFTLENBQUMsTUFBTSxFQUFFLENBQUM7SUFDbEUsTUFBTSxLQUFLLEdBQUcsY0FBYyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsS0FBSyxDQUFDLGFBQWEsQ0FBQyxDQUFDO0lBQ2xFLE1BQU0sSUFBSSxHQUFHLGtCQUFrQixDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDLENBQUM7SUFDM0QsSUFBSSxJQUFJLEtBQUssSUFBSTtRQUFFLE9BQU8sRUFBRSxFQUFFLEVBQUUsS0FBSyxFQUFFLE1BQU0sRUFBRSxDQUFDLHNCQUFzQixDQUFDLEVBQUUsQ0FBQztJQUMxRSxNQUFNLFNBQVMsR0FBRyxjQUFjLENBQUMsS0FBSyxFQUFFLElBQUksQ0FBQyxDQUFDO0lBQzlDLE9BQU8sRUFBRSxFQUFFLEVBQUUsSUFBSSxFQUFFLE9BQU8sRUFBRSxTQUFTLENBQUMsWUFBWSxFQUFFLFNBQVMsRUFBRSxDQUFDO0FBQ2xFLENBQUMifQ==