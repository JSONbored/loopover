// Eligibility filtering of discover candidates against a ContributionProfile (#6798). Pure: given the candidate
// list and a per-repo profile map, it partitions candidates into kept + excluded-with-reason. No fetching, no
// side effects — discover-cli.js resolves the profiles and renders the result; this owns only the decision.
//
// SAFE-DEFAULT POSTURE (the load-bearing requirement) applies to the three LABEL-based rules only: filtering on
// them activates ONLY when a repo's profile has a trustworthy eligibility signal
// (eligibilityLabels.confidence === "explicit"). A repo with no profile, or a low-confidence/empty one — a repo
// whose conventions AMS simply couldn't read — has every candidate kept via those rules, so a weak profile can
// never cause AMS to silently skip real, eligible work.
//
// ASSIGNEE-EXCLUSION IS DIFFERENT (#7040): per the schema (ContributionAssigneeRuntimeCheck,
// contribution-profile.d.ts), it is deliberately NOT a profile field — it's a structural fact derivable from the
// issue's own assignees at query time, not something extraction infers with variable confidence. It therefore
// applies to EVERY candidate unconditionally, independent of the repo's ContributionProfile (or lack of one).
/** Why a candidate was excluded. */
export const ELIGIBILITY_EXCLUSION_REASONS = Object.freeze({
    /** The issue carries a label the profile identified as maintainer-only / off-limits. */
    EXCLUSION_LABEL: "exclusion_label",
    /** The repo has a trustworthy eligibility convention, and the issue carries none of its eligibility labels. */
    MISSING_ELIGIBILITY_LABEL: "missing_eligibility_label",
    /** The issue carries BOTH an eligibility and an exclusion label — conflicting signals; exclusion wins. */
    CONFLICTING_SIGNALS: "conflicting_signals",
    /** The issue is assigned to the repo's own owner login (#7040) — structural, not profile-derived. */
    EXCLUDED_ASSIGNEE: "excluded_assignee",
});
/** True when the candidate is assigned to its own repo's owner login (case-insensitive). Always-on: unlike the
 *  label rules below, this never depends on the profile's confidence — see the header comment. */
function isAssignedToRepoOwner(candidate) {
    const owner = typeof candidate?.owner === "string" ? candidate.owner.toLowerCase() : "";
    if (!owner)
        return false;
    for (const login of candidate?.assignees ?? []) {
        if (typeof login === "string" && login.toLowerCase() === owner)
            return true;
    }
    return false;
}
/** The actual repo label names a signal rule was derived from (its provenance details), lowercased for match. */
function labelNamesFromRule(rule) {
    const names = new Set();
    for (const entry of rule?.provenance ?? []) {
        if (typeof entry?.detail === "string")
            names.add(entry.detail.toLowerCase());
    }
    return names;
}
/** Does the candidate carry any label whose name is in `names`? Case-insensitive. */
function candidateHasAnyLabel(candidate, names) {
    if (names.size === 0)
        return false;
    for (const label of candidate?.labels ?? []) {
        if (typeof label === "string" && names.has(label.toLowerCase()))
            return true;
    }
    return false;
}
/**
 * Partition candidates into kept + excluded against per-repo ContributionProfiles.
 */
export function filterCandidatesByProfiles(candidates, profilesByRepo) {
    const kept = [];
    const excluded = [];
    for (const candidate of candidates) {
        // Always-on, ahead of the label rules' safe-default gate (#7040) — see the header comment.
        if (isAssignedToRepoOwner(candidate)) {
            excluded.push({
                candidate,
                reason: ELIGIBILITY_EXCLUSION_REASONS.EXCLUDED_ASSIGNEE,
            });
            continue;
        }
        const profile = profilesByRepo?.get(candidate.repoFullName);
        // Trust gate: only an EXPLICIT eligibility signal is trustworthy enough to filter on. Anything weaker
        // (absent/inferred/unknown, or no profile at all) keeps every candidate — the safe default.
        if (profile?.eligibilityLabels?.confidence !== "explicit") {
            kept.push(candidate);
            continue;
        }
        const eligibilityNames = labelNamesFromRule(profile.eligibilityLabels);
        const exclusionNames = labelNamesFromRule(profile.exclusionLabels);
        const hasEligibility = candidateHasAnyLabel(candidate, eligibilityNames);
        const hasExclusion = candidateHasAnyLabel(candidate, exclusionNames);
        if (hasExclusion && hasEligibility) {
            // Conservative resolution for conflicting signals: exclusion wins. A maintainer marking an issue
            // off-limits outranks its also carrying an eligibility label — better to skip than to attempt work the
            // repo's own gate would reject.
            excluded.push({
                candidate,
                reason: ELIGIBILITY_EXCLUSION_REASONS.CONFLICTING_SIGNALS,
            });
            continue;
        }
        if (hasExclusion) {
            excluded.push({
                candidate,
                reason: ELIGIBILITY_EXCLUSION_REASONS.EXCLUSION_LABEL,
            });
            continue;
        }
        if (!hasEligibility) {
            excluded.push({
                candidate,
                reason: ELIGIBILITY_EXCLUSION_REASONS.MISSING_ELIGIBILITY_LABEL,
            });
            continue;
        }
        kept.push(candidate);
    }
    return { kept, excluded };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29udHJpYnV0aW9uLXByb2ZpbGUtZmlsdGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiY29udHJpYnV0aW9uLXByb2ZpbGUtZmlsdGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLGdIQUFnSDtBQUNoSCw4R0FBOEc7QUFDOUcsNEdBQTRHO0FBQzVHLEVBQUU7QUFDRixnSEFBZ0g7QUFDaEgsaUZBQWlGO0FBQ2pGLGdIQUFnSDtBQUNoSCwrR0FBK0c7QUFDL0csd0RBQXdEO0FBQ3hELEVBQUU7QUFDRiw2RkFBNkY7QUFDN0YsaUhBQWlIO0FBQ2pILDhHQUE4RztBQUM5Ryw4R0FBOEc7QUFJOUcsb0NBQW9DO0FBQ3BDLE1BQU0sQ0FBQyxNQUFNLDZCQUE2QixHQUFHLE1BQU0sQ0FBQyxNQUFNLENBQUM7SUFDekQsd0ZBQXdGO0lBQ3hGLGVBQWUsRUFBRSxpQkFBaUI7SUFDbEMsK0dBQStHO0lBQy9HLHlCQUF5QixFQUFFLDJCQUEyQjtJQUN0RCwwR0FBMEc7SUFDMUcsbUJBQW1CLEVBQUUscUJBQXFCO0lBQzFDLHFHQUFxRztJQUNyRyxpQkFBaUIsRUFBRSxtQkFBbUI7Q0FDOUIsQ0FBQyxDQUFDO0FBV1o7a0dBQ2tHO0FBQ2xHLFNBQVMscUJBQXFCLENBQUMsU0FHOUI7SUFDQyxNQUFNLEtBQUssR0FBRyxPQUFPLFNBQVMsRUFBRSxLQUFLLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLFdBQVcsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7SUFDeEYsSUFBSSxDQUFDLEtBQUs7UUFBRSxPQUFPLEtBQUssQ0FBQztJQUN6QixLQUFLLE1BQU0sS0FBSyxJQUFJLFNBQVMsRUFBRSxTQUFTLElBQUksRUFBRSxFQUFFLENBQUM7UUFDL0MsSUFBSSxPQUFPLEtBQUssS0FBSyxRQUFRLElBQUksS0FBSyxDQUFDLFdBQVcsRUFBRSxLQUFLLEtBQUs7WUFBRSxPQUFPLElBQUksQ0FBQztJQUM5RSxD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