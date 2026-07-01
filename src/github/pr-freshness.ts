import { createInstallationToken } from "./app";
import { fetchLivePullRequest } from "./backfill";
import { githubRateLimitAdmissionKeyForToken } from "./client";
import type { GitHubPullRequestPayload } from "../types";

export type PullRequestFreshness =
  | {
      status: "current";
      liveHeadSha: string | null;
      liveState: string | null;
    }
  | {
      status: "stale";
      reason: "unavailable" | "closed" | "head_unresolved" | "head_changed";
      expectedHeadSha: string | null;
      liveHeadSha: string | null;
      liveState: string | null;
    };

function normalizedHead(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function reviewedPullRequestHeadSha(
  pullRequestHeadSha: string | null | undefined,
  advisoryHeadSha: string | null | undefined,
): string | null {
  return normalizedHead(pullRequestHeadSha) ?? normalizedHead(advisoryHeadSha);
}

export function classifyPullRequestFreshness(
  live: Pick<GitHubPullRequestPayload, "state" | "head"> | null | undefined,
  expectedHeadSha: string | null | undefined,
): PullRequestFreshness {
  const expected = normalizedHead(expectedHeadSha);
  if (!live) {
    return { status: "stale", reason: "unavailable", expectedHeadSha: expected, liveHeadSha: null, liveState: null };
  }
  const liveState = typeof live.state === "string" ? live.state : null;
  const liveHeadSha = normalizedHead(live.head?.sha);
  if (!liveState) {
    return { status: "stale", reason: "unavailable", expectedHeadSha: expected, liveHeadSha, liveState: null };
  }
  if (liveState !== "open") {
    return { status: "stale", reason: "closed", expectedHeadSha: expected, liveHeadSha, liveState };
  }
  if (expected && !liveHeadSha) {
    return { status: "stale", reason: "head_unresolved", expectedHeadSha: expected, liveHeadSha: null, liveState };
  }
  if (expected && liveHeadSha !== expected) {
    return { status: "stale", reason: "head_changed", expectedHeadSha: expected, liveHeadSha, liveState };
  }
  return { status: "current", liveHeadSha, liveState };
}

export async function fetchPullRequestFreshness(
  env: Env,
  args: {
    installationId: number;
    repoFullName: string;
    pullNumber: number;
    expectedHeadSha?: string | null | undefined;
  },
): Promise<PullRequestFreshness> {
  const token =
    (await createInstallationToken(env, args.installationId).catch(() => undefined)) ??
    env.GITHUB_PUBLIC_TOKEN;
  if (!token) return classifyPullRequestFreshness(undefined, args.expectedHeadSha);
  const admissionKey = githubRateLimitAdmissionKeyForToken(env, token, args.installationId);
  const live = await fetchLivePullRequest(env, args.repoFullName, args.pullNumber, token, admissionKey);
  return classifyPullRequestFreshness(live, args.expectedHeadSha);
}

export function pullRequestFreshnessDetail(result: PullRequestFreshness): string {
  if (result.status === "current") return "PR is current";
  if (result.reason === "unavailable") return "live PR state could not be verified";
  if (result.reason === "closed") return `PR is no longer open (live state: ${result.liveState ?? "unknown"})`;
  if (result.reason === "head_unresolved") return "live PR head SHA could not be verified";
  return `PR head changed from ${result.expectedHeadSha ?? "unknown"} to ${result.liveHeadSha ?? "unknown"}`;
}
