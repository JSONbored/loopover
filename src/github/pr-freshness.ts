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
  // #9055: the base the caller last computed the diff/review/CI against. Present only when the caller actually
  // tracked one (older stored PRs predate the column); absent preserves every existing caller's behavior exactly.
  expectedBaseRef?: string | null | undefined;
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
      // #9055: `base_changed` — a contributor can retarget a PR's base AFTER CI is green with no new commit,
      // so head/state/draft alone see nothing wrong. Everything downstream (diff, review, CI, guardrail path
      // matching, migration-collision detection) was computed against the ABANDONED base, and the divergence
      // was permanent for that head: nothing re-syncs on a base change alone. This is checked at the last
      // possible moment, immediately before a merge/approve mutation, using the SAME live fetch that already
      // proves the head — no extra GitHub call.
      reason: "unavailable" | "closed" | "head_unresolved" | "head_changed" | "no_longer_draft" | "base_changed";
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
  live: Pick<GitHubPullRequestPayload, "state" | "head" | "base" | "draft" | "labels"> | null | undefined,
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
  // #9055: the base can change with the head UNCHANGED, which is exactly the case the check above cannot see.
  // A repo whose per-repo settings pin a specific expected base (options?.expectedBaseRef) denies the mutation
  // rather than merging into a base the diff/review/CI were never computed against.
  if (options?.expectedBaseRef && live.base?.ref && live.base.ref !== options.expectedBaseRef) {
    return { status: "stale", reason: "base_changed", expectedHeadSha: expected, liveHeadSha, liveState };
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
    // #9055: see PullRequestFreshnessOptions' own doc comment.
    expectedBaseRef?: string | null | undefined;
  },
): Promise<PullRequestFreshness> {
  const options: PullRequestFreshnessOptions = {
    ...(args.requireDraft !== undefined ? { requireDraft: args.requireDraft } : {}),
    ...(args.expectedBaseRef ? { expectedBaseRef: args.expectedBaseRef } : {}),
  };
  let tokenError: unknown;
  const installationToken = await createInstallationToken(env, args.installationId).catch((error) => {
    tokenError = error;
    return undefined;
  });
  const token = installationToken ?? env.GITHUB_PUBLIC_TOKEN;
  if (!token) {
    return classifyPullRequestFreshness(undefined, args.expectedHeadSha, {
      ...options,
      unavailableSource: "token",
      unavailableDetail: strippedErrorMessage(tokenError, "no token available").slice(0, 240),
    });
  }
  const admissionKey = githubRateLimitAdmissionKeyForToken(env, token, args.installationId);
  // Route through the read helper's self-heal ONLY when we hold an installation token: a stale cached one then
  // re-mints once on a 401 (#6191) instead of failing the freshness check closed. A public-token fallback has no
  // installation to re-mint, so it fetches with the token as before.
  const live = await fetchLivePullRequestResult(
    env,
    args.repoFullName,
    args.pullNumber,
    token,
    admissionKey,
    installationToken !== undefined ? args.installationId : undefined,
  );
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
  if (result.reason === "base_changed") return "PR base branch changed since the diff/review/CI it will merge with were computed";
  return `PR head changed from ${result.expectedHeadSha ?? "unknown"} to ${result.liveHeadSha ?? "unknown"}`;
}
