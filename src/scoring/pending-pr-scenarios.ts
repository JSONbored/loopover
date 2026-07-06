import { listCheckSummaries, listPullRequestReviews } from "../db/repositories";
import type { CheckSummaryRecord, PullRequestRecord, PullRequestReviewRecord } from "../types";

// Deterministic open-PR classification/detection, extracted to `@jsonbored/gittensory-engine` (#2282) so
// the miner can run the same pending-PR-scenario logic locally. Re-exported here (via relative source path
// — see src/scoring/preview.ts's shim comment for why) so every existing import of this module keeps
// working unchanged. The two D1-fetching loaders below cannot move into the engine package, so they stay
// here, importing the pure classifier back from the engine.
export * from "../../packages/gittensory-engine/src/scoring/pending-pr-scenarios";
import type { ContributorRepoOpenPrSignals } from "../../packages/gittensory-engine/src/scoring/pending-pr-scenarios";

export async function loadContributorRepoOpenPrSignalRecords(
  env: Env,
  repoFullName: string,
  login: string,
  pullRequests: PullRequestRecord[],
): Promise<{ pullRequestReviews: PullRequestReviewRecord[]; pullRequestChecks: CheckSummaryRecord[] }> {
  const open = pullRequests.filter(
    (pr) => sameRepoFullName(pr.repoFullName, repoFullName) && pr.state === "open" && sameLogin(pr.authorLogin, login),
  );
  const signals = await loadContributorRepoOpenPrSignals(env, repoFullName, open);
  return {
    pullRequestReviews: [...signals.reviewsByPullNumber.values()].flat(),
    pullRequestChecks: [...signals.checksByPullNumber.values()].flat(),
  };
}

export async function loadContributorRepoOpenPrSignals(
  env: Env,
  repoFullName: string,
  pullRequests: PullRequestRecord[],
): Promise<ContributorRepoOpenPrSignals> {
  const open = pullRequests.filter((pr) => sameRepoFullName(pr.repoFullName, repoFullName) && pr.state === "open");
  const reviewsByPullNumber = new Map<number, PullRequestReviewRecord[]>();
  const checksByPullNumber = new Map<number, CheckSummaryRecord[]>();
  await Promise.all(
    open.map(async (pr) => {
      const [reviews, checks] = await Promise.all([
        listPullRequestReviews(env, pr.repoFullName, pr.number),
        listCheckSummaries(env, pr.repoFullName, pr.number),
      ]);
      reviewsByPullNumber.set(pr.number, reviews);
      checksByPullNumber.set(pr.number, checks);
    }),
  );
  return { reviewsByPullNumber, checksByPullNumber };
}

function sameRepoFullName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameLogin(value: string | null | undefined, login: string): boolean {
  return Boolean(value && value.toLowerCase() === login.toLowerCase());
}
