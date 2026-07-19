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

import type { ContributionProfile } from "./contribution-profile.js";

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
} as const);

export type EligibilityExclusion<T> = {
  candidate: T;
  reason:
    | "exclusion_label"
    | "missing_eligibility_label"
    | "conflicting_signals"
    | "excluded_assignee";
};

/** True when the candidate is assigned to its own repo's owner login (case-insensitive). Always-on: unlike the
 *  label rules below, this never depends on the profile's confidence — see the header comment. */
function isAssignedToRepoOwner(candidate: {
  owner?: string | undefined;
  assignees?: readonly unknown[] | undefined;
}): boolean {
  const owner = typeof candidate?.owner === "string" ? candidate.owner.toLowerCase() : "";
  if (!owner) return false;
  for (const login of candidate?.assignees ?? []) {
    if (typeof login === "string" && login.toLowerCase() === owner) return true;
  }
  return false;
}

/** The actual repo label names a signal rule was derived from (its provenance details), lowercased for match. */
function labelNamesFromRule(
  rule: { provenance?: ReadonlyArray<{ detail?: unknown }> | undefined } | null | undefined,
): Set<string> {
  const names = new Set<string>();
  for (const entry of rule?.provenance ?? []) {
    if (typeof entry?.detail === "string")
      names.add(entry.detail.toLowerCase());
  }
  return names;
}

/** Does the candidate carry any label whose name is in `names`? Case-insensitive. */
function candidateHasAnyLabel(
  candidate: { labels?: readonly unknown[] | undefined },
  names: Set<string>,
): boolean {
  if (names.size === 0) return false;
  for (const label of candidate?.labels ?? []) {
    if (typeof label === "string" && names.has(label.toLowerCase()))
      return true;
  }
  return false;
}

/**
 * Partition candidates into kept + excluded against per-repo ContributionProfiles.
 */
export function filterCandidatesByProfiles<
  T extends { repoFullName: string; owner?: string; labels?: string[]; assignees?: string[] },
>(
  candidates: T[],
  profilesByRepo: Map<string, ContributionProfile>,
): { kept: T[]; excluded: EligibilityExclusion<T>[] } {
  const kept: T[] = [];
  const excluded: EligibilityExclusion<T>[] = [];
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
