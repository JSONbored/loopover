import { createInstallationToken } from "./app";
import { fetchLivePullRequestResult } from "./backfill";
import { githubRateLimitAdmissionKeyForToken } from "./client";
import type { GitHubPullRequestPayload } from "../types";
import { strippedErrorMessage } from "../utils/json";

export type PullRequestUnavailableSource = "token" | "pull_request_fetch" | "live_payload";

type PullRequestFreshnessOptions = {
  requireDraft?: boolean;
  unavailableSource?: PullRequestUnavailableSource;
  unavailableDetail?: string;
};

export type PullRequestFreshness =
  | {
      status: "current";
      liveHeadSha: string | null;
      liveState: string | null;
      // Live label names off the SAME fetch that proved this head is current — lets a caller re-check a
      // disposition label (e.g. a manual-review hold) against ground truth immediately before a mutation,
      // without a second GitHub call (#3472 split-brain).
      liveLabels: string[];
    }
  | {
      status: "stale";
      reason: "unavailable" | "closed" | "head_unresolved" | "head_changed" | "no_longer_draft";
      expectedHeadSha: string | null;
      liveHeadSha: string | null;
      liveState: string | null;
      unavailableSource?: PullRequestUnavailableSource;
      unavailableDetail?: string;
    };

function normalizedHead(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

export function reviewedPullRequestHeadSha(
  pullRequestHeadSha: string | null | undefined,
  advisoryHeadSha: string | null | undefined,
): string | null {
  return normalizedHead(pullRequestHeadSha) ?? normalizedHead(advisoryHeadSha);
}

export function classifyPullRequestFreshness(
  live: Pick<GitHubPullRequestPayload, "state" | "head" | "draft" | "labels"> | null | undefined,
  expectedHeadSha: string | null | undefined,
  options?: PullRequestFreshnessOptions,
): PullRequestFreshness {
  const expected = normalizedHead(expectedHeadSha);
  if (!live) {
    return {
      status: "stale",
      reason: "unavailable",
      expectedHeadSha: expected,
      liveHeadSha: null,
      liveState: null,
      ...(options?.unavailableSource ? { unavailableSource: options.unavailableSource } : {}),
      ...(options?.unavailableDetail ? { unavailableDetail: options.unavailableDetail } : {}),
    };
  }
  const liveState = typeof live.state === "string" ? live.state : null;
  const liveHeadSha = normalizedHead(live.head?.sha);
  if (!liveState) {
    return {
      status: "stale",
      reason: "unavailable",
      expectedHeadSha: expected,
      liveHeadSha,
      liveState: null,
      unavailableSource: options?.unavailableSource ?? "live_payload",
      ...(options?.unavailableDetail ? { unavailableDetail: options.unavailableDetail } : {}),
    };
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
  // The draft-dodge close is only justified while the PR is STILL a draft -- a same-head, still-open PR
  // that was converted back to ready_for_review before the close fires has cleared its own justification
  // (#2130 follow-up: head/state alone can't see this transition).
  if (options?.requireDraft && live.draft !== true) {
    return { status: "stale", reason: "no_longer_draft", expectedHeadSha: expected, liveHeadSha, liveState };
  }
  const liveLabels = (live.labels ?? []).map((label) => label.name).filter((name): name is string => Boolean(name));
  return { status: "current", liveHeadSha, liveState, liveLabels };
}

export async function fetchPullRequestFreshness(
  env: Env,
  args: {
    installationId: number;
    repoFullName: string;
    pullNumber: number;
    expectedHeadSha?: string | null | undefined;
    // Require the LIVE PR to still be a draft (the draft-dodge close's own justification). Absent/false
    // preserves every other caller's existing head/state-only behavior exactly.
    requireDraft?: boolean;
  },
): Promise<PullRequestFreshness> {
  const options: PullRequestFreshnessOptions =
    args.requireDraft !== undefined ? { requireDraft: args.requireDraft } : {};
  let tokenError: unknown;
  const token =
    (await createInstallationToken(env, args.installationId).catch((error) => {
      tokenError = error;
      return undefined;
    })) ?? env.GITHUB_PUBLIC_TOKEN;
  if (!token) {
    return classifyPullRequestFreshness(undefined, args.expectedHeadSha, {
      ...options,
      unavailableSource: "token",
      unavailableDetail: strippedErrorMessage(tokenError, "no token available").slice(0, 240),
    });
  }
  const admissionKey = githubRateLimitAdmissionKeyForToken(env, token, args.installationId);
  const live = await fetchLivePullRequestResult(env, args.repoFullName, args.pullNumber, token, admissionKey);
  if (live.status === "error") {
    return classifyPullRequestFreshness(undefined, args.expectedHeadSha, {
      ...options,
      unavailableSource: "pull_request_fetch",
      unavailableDetail: live.error,
    });
  }
  return classifyPullRequestFreshness(live.data, args.expectedHeadSha, options);
}

export function pullRequestFreshnessDetail(result: PullRequestFreshness): string {
  if (result.status === "current") return "PR is current";
  if (result.reason === "unavailable") return "live PR state could not be verified";
  if (result.reason === "closed") return `PR is no longer open (live state: ${result.liveState ?? "unknown"})`;
  if (result.reason === "head_unresolved") return "live PR head SHA could not be verified";
  if (result.reason === "no_longer_draft") return "PR is no longer a draft";
  return `PR head changed from ${result.expectedHeadSha ?? "unknown"} to ${result.liveHeadSha ?? "unknown"}`;
}
