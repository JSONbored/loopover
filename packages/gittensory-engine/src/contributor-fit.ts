// Contributor fit sub-check (#2312): pure classifier over an already-computed contributor profile
// that answers whether THIS contributor's own track record fits a target repo. No IO, no fetching.

export type ContributorFit = "strong" | "neutral" | "weak";

export type ContributorFitCheck = {
  fit: ContributorFit;
  reasons: string[];
};

export type ContributorFitProfile = {
  login: string;
  registeredRepoActivity: {
    pullRequests: number;
    mergedPullRequests: number;
    reposTouched: readonly string[];
  };
  trustSignals: {
    level: "new" | "emerging" | "established";
    unlinkedOpenPullRequests: number;
  };
};

/**
 * A profile with no prior activity on the target repo is `neutral` (a first attempt is not evidence
 * of poor fit). With prior activity, a personal burden signal (unlinked open PRs, or a `new` profile
 * with a low merge ratio) reads `weak`; established trust with a clean queue and a high merge ratio
 * reads `strong`; anything between reads `neutral`.
 */
export function classifyContributorFit(
  profile: ContributorFitProfile,
  targetRepoFullName: string,
): ContributorFitCheck {
  const { reposTouched, pullRequests, mergedPullRequests } = profile.registeredRepoActivity;
  const target = targetRepoFullName.toLowerCase();
  if (!reposTouched.some((repo) => repo.toLowerCase() === target)) {
    return {
      fit: "neutral",
      reasons: [`No prior activity on ${targetRepoFullName}; a first attempt is not evidence of poor fit.`],
    };
  }

  const reasons: string[] = [];
  const mergeRatio = pullRequests > 0 ? mergedPullRequests / pullRequests : 1;
  const unlinked = profile.trustSignals.unlinkedOpenPullRequests;
  const level = profile.trustSignals.level;

  const hasUnlinkedBurden = unlinked > 0;
  const hasNewProfileBurden = level === "new" && pullRequests > 0 && mergeRatio < 0.5;
  if (hasUnlinkedBurden) reasons.push(`${unlinked} unlinked open pull request(s)`);
  if (hasNewProfileBurden) {
    reasons.push(`new profile with low merge ratio (${mergedPullRequests}/${pullRequests})`);
  }

  const cleanQueue = unlinked === 0;
  const strongMerge = pullRequests > 0 && mergeRatio >= 0.8;
  if (level === "established") reasons.push("trust level is 'established'");
  if (cleanQueue) reasons.push("no unlinked open pull requests");
  if (strongMerge) reasons.push(`strong merge ratio (${mergedPullRequests}/${pullRequests})`);

  const burdened = hasUnlinkedBurden || hasNewProfileBurden;
  const proven = level === "established" && cleanQueue && strongMerge;

  let fit: ContributorFit;
  if (burdened) {
    fit = "weak";
  } else if (proven) {
    fit = "strong";
  } else {
    fit = "neutral";
  }
  return { fit, reasons };
}
