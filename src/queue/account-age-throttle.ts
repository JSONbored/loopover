import { getGithubUserCreatedAt } from "../github/app";

/**
 * Fail-open account-age check shared by issue cap tightening and issue-open labeling (#2561).
 *
 * #9492: `nowMs` is a real seam, not a test convenience — this predicate HALVES a contributor cap
 * (`effectiveIssueCapForAccountAge`) and can therefore flip a cap close, which makes it a decision INPUT.
 * A caller inside a pass that captured a `decisionClock` must pass that instant so the decision stays
 * replayable; the three callers that are NOT part of the replayed maintenance decision (the PR-open cap
 * check, the issue cap check, and the issue webhook labeler — each its own pass with no recorded clock)
 * legitimately omit it and read the live clock, exactly as before.
 */
export async function isBelowAccountAgeThreshold(
  env: Env,
  installationId: number,
  authorLogin: string,
  accountAgeThresholdDays: number | null | undefined,
  nowMs?: number | undefined,
): Promise<boolean> {
  if (typeof accountAgeThresholdDays !== "number") return false;
  const createdAt = await getGithubUserCreatedAt(env, installationId, authorLogin);
  if (!createdAt) return false;
  const ageDays = ((nowMs ?? Date.now()) - Date.parse(createdAt)) / (24 * 60 * 60 * 1000);
  return ageDays < accountAgeThresholdDays;
}

export function repoOwnerLoginFromFullName(fullName: string): string {
  const slashIdx = fullName.indexOf("/");
  if (slashIdx === -1) return "";
  return fullName.slice(0, slashIdx);
}

export function effectiveIssueCapForAccountAge(cap: number, isNewAccount: boolean): number {
  if (isNewAccount) return Math.max(1, Math.ceil(cap / 2));
  return cap;
}
