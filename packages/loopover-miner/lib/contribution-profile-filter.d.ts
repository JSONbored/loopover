import type { ContributionProfile } from "./contribution-profile.js";
/** Why a candidate was excluded. */
export declare const ELIGIBILITY_EXCLUSION_REASONS: Readonly<{
    /** The issue carries a label the profile identified as maintainer-only / off-limits. */
    EXCLUSION_LABEL: "exclusion_label";
    /** The repo has a trustworthy eligibility convention, and the issue carries none of its eligibility labels. */
    MISSING_ELIGIBILITY_LABEL: "missing_eligibility_label";
    /** The issue carries BOTH an eligibility and an exclusion label — conflicting signals; exclusion wins. */
    CONFLICTING_SIGNALS: "conflicting_signals";
    /** The issue is assigned to the repo's own owner login (#7040) — structural, not profile-derived. */
    EXCLUDED_ASSIGNEE: "excluded_assignee";
}>;
export type EligibilityExclusion<T> = {
    candidate: T;
    reason: "exclusion_label" | "missing_eligibility_label" | "conflicting_signals" | "excluded_assignee";
};
/**
 * Partition candidates into kept + excluded against per-repo ContributionProfiles.
 */
export declare function filterCandidatesByProfiles<T extends {
    repoFullName: string;
    owner?: string;
    labels?: string[];
    assignees?: string[];
}>(candidates: T[], profilesByRepo: Map<string, ContributionProfile>): {
    kept: T[];
    excluded: EligibilityExclusion<T>[];
};
