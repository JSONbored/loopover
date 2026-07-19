/** Pre-execution feasibility check for a freeform Rent-a-Loop idea (#5671).
 *
 * Runs post-schema-validation and pre-compute-allocation on an idea submission (the intake shape defined in
 * #4779), so a customer can no longer burn paid or free-trial compute on an idea that was never going to
 * succeed. It is the freeform-text counterpart to the metadata `feasibility` CLI (`feasibility-cli.js`, #4270).
 *
 * REUSED from feasibility-cli.js AS-IS:
 *   - the engine's pure `buildFeasibilityVerdict` composer and its `avoid > raise > go` precedence — an idea
 *     inherits exactly the same verdict machinery a metadata-resolved issue does, so there is no second,
 *     divergent decision surface;
 *   - the injectable-verdict test seam (`options.buildFeasibilityVerdict`), matching the CLI's convention.
 *
 * NEW for freeform text (#5671, per the #4779 rubric):
 *   - `deriveIdeaIssueStatus`, which computes the `issueStatus` discriminant from the idea's OWN structure
 *     instead of a resolved GitHub issue. An idea with no objective success signal is `invalid` (impossible to
 *     evaluate objectively) and is rejected before compute; an unresolvable target repo is `missing` (out of the
 *     loop's scope) and is flagged.
 *
 * OUT OF SCOPE (stays with #5136): judging abusive/illegal or semantically off-topic intent from prose — that is
 * a content-moderation policy call, not this deterministic structural gate.
 */
import { buildFeasibilityVerdict } from "@loopover/engine";
/** Verdict → caller-facing disposition. `go` proceeds to compute; `raise`/`avoid` gate it. */
const DISPOSITION_BY_VERDICT = { go: "proceed", raise: "flag", avoid: "reject" };
/**
 * Derive the feasibility `issueStatus` for a freeform idea from objective, structural signals only — never from
 * a semantic read of the prose.
 */
export function deriveIdeaIssueStatus(idea, resolved) {
    // Out of the loop's scope: the idea does not resolve to a repo the loop can act on.
    if (!resolved.targetResolvable)
        return "missing";
    // Impossible to evaluate objectively: no declared success signal, so the loop could never test its own output.
    // Count CONTENT, not array length (#6766): a blank/whitespace-only hint declares nothing testable, so it must
    // not pass as an objective signal just by occupying a slot.
    const objectiveSignals = (idea.acceptanceHints ?? []).filter((hint) => typeof hint === "string" && hint.trim() !== "").length;
    if (objectiveSignals === 0)
        return "invalid";
    return "ready";
}
/**
 * Assess a schema-validated idea's feasibility before compute is allocated.
 */
export function assessIdeaFeasibility(idea, resolved, options = {}) {
    const buildVerdict = options.buildFeasibilityVerdict ?? buildFeasibilityVerdict;
    const issueStatus = deriveIdeaIssueStatus(idea, resolved);
    const verdict = buildVerdict({
        found: resolved.targetResolvable,
        claimStatus: resolved.claimStatus,
        duplicateClusterRisk: resolved.duplicateClusterRisk,
        issueStatus,
    });
    return {
        disposition: DISPOSITION_BY_VERDICT[verdict.verdict],
        verdict: verdict.verdict,
        issueStatus,
        reasons: [...verdict.avoidReasons, ...verdict.raiseReasons],
        summary: verdict.summary,
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaWRlYS1mZWFzaWJpbGl0eS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImlkZWEtZmVhc2liaWxpdHkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBb0JHO0FBQ0gsT0FBTyxFQUFFLHVCQUF1QixFQUFFLE1BQU0sa0JBQWtCLENBQUM7QUEwQzNELDhGQUE4RjtBQUM5RixNQUFNLHNCQUFzQixHQUEyRCxFQUFFLEVBQUUsRUFBRSxTQUFTLEVBQUUsS0FBSyxFQUFFLE1BQU0sRUFBRSxLQUFLLEVBQUUsUUFBUSxFQUFFLENBQUM7QUFFekk7OztHQUdHO0FBQ0gsTUFBTSxVQUFVLHFCQUFxQixDQUNuQyxJQUEwQixFQUMxQixRQUF1RDtJQUV2RCxvRkFBb0Y7SUFDcEYsSUFBSSxDQUFDLFFBQVEsQ0FBQyxnQkFBZ0I7UUFBRSxPQUFPLFNBQVMsQ0FBQztJQUNqRCwrR0FBK0c7SUFDL0csOEdBQThHO0lBQzlHLDREQUE0RDtJQUM1RCxNQUFNLGdCQUFnQixHQUFHLENBQUMsSUFBSSxDQUFDLGVBQWUsSUFBSSxFQUFFLENBQUMsQ0FBQyxNQUFNLENBQzFELENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxPQUFPLElBQUksS0FBSyxRQUFRLElBQUksSUFBSSxDQUFDLElBQUksRUFBRSxLQUFLLEVBQUUsQ0FDekQsQ0FBQyxNQUFNLENBQUM7SUFDVCxJQUFJLGdCQUFnQixLQUFLLENBQUM7UUFBRSxPQUFPLFNBQVMsQ0FBQztJQUM3QyxPQUFPLE9BQU8sQ0FBQztBQUNqQixDQUFDO0FBRUQ7O0dBRUc7QUFDSCxNQUFNLFVBQVUscUJBQXFCLENBQ25DLElBQTBCLEVBQzFCLFFBQTZCLEVBQzdCLFVBQXdDLEVBQUU7SUFFMUMsTUFBTSxZQUFZLEdBQUcsT0FBTyxDQUFDLHVCQUF1QixJQUFJLHVCQUF1QixDQUFDO0lBQ2hGLE1BQU0sV0FBVyxHQUFHLHFCQUFxQixDQUFDLElBQUksRUFBRSxRQUFRLENBQUMsQ0FBQztJQUMxRCxNQUFNLE9BQU8sR0FBRyxZQUFZLENBQUM7UUFDM0IsS0FBSyxFQUFFLFFBQVEsQ0FBQyxnQkFBZ0I7UUFDaEMsV0FBVyxFQUFFLFFBQVEsQ0FBQyxXQUFXO1FBQ2pDLG9CQUFvQixFQUFFLFFBQVEsQ0FBQyxvQkFBb0I7UUFDbkQsV0FBVztLQUNaLENBQUMsQ0FBQztJQUNILE9BQU87UUFDTCxXQUFXLEVBQUUsc0JBQXNCLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQztRQUNwRCxPQUFPLEVBQUUsT0FBTyxDQUFDLE9BQU87UUFDeEIsV0FBVztRQUNYLE9BQU8sRUFBRSxDQUFDLEdBQUcsT0FBTyxDQUFDLFlBQVksRUFBRSxHQUFHLE9BQU8sQ0FBQyxZQUFZLENBQUM7UUFDM0QsT0FBTyxFQUFFLE9BQU8sQ0FBQyxPQUFPO0tBQ3pCLENBQUM7QUFDSixDQUFDIn0=