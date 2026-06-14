import type { DetectedNotificationEvent, GitHubWebhookPayload } from "../types";
import { nowIso } from "../utils/json";

export type { DetectedNotificationEvent, NotificationEventType } from "../types";

function isBotUser(user: { login?: string; type?: string } | undefined): boolean {
  return user?.type === "Bot";
}

function normalizeLogin(login: string | undefined): string | undefined {
  return login?.trim().toLowerCase() || undefined;
}

export function detectNotificationEvents(
  eventName: string,
  payload: GitHubWebhookPayload,
  detectedAt: string = nowIso(),
): DetectedNotificationEvent[] {
  if (eventName !== "pull_request_review") return [];
  if (payload.action !== "submitted" && payload.action !== "edited") return [];

  const repoFullName = payload.repository?.full_name;
  const pullRequest = payload.pull_request;
  const pullNumber = pullRequest?.number;
  const authorLogin = pullRequest?.user?.login;
  if (!repoFullName || !pullNumber || !authorLogin) return [];

  const reviewState = payload.review?.state?.toLowerCase();
  if (reviewState !== "changes_requested") return [];

  const reviewerLogin = payload.review?.user?.login ?? payload.sender?.login;
  if (isBotUser(payload.review?.user) || isBotUser(payload.sender) || isBotUser(pullRequest?.user)) return [];
  if (reviewerLogin && normalizeLogin(reviewerLogin) === normalizeLogin(authorLogin)) return [];

  const submittedAt = payload.review?.submitted_at ?? detectedAt;
  const dedupKey = `changes_requested:${repoFullName}#${pullNumber}:${normalizeLogin(reviewerLogin) ?? "unknown"}:${submittedAt}`;

  return [
    {
      eventType: "pull_request_changes_requested",
      recipientLogin: authorLogin,
      repoFullName,
      pullNumber,
      dedupKey,
      deeplink: payload.review?.html_url ?? pullRequest.html_url ?? `https://github.com/${repoFullName}/pull/${pullNumber}`,
      actorLogin: reviewerLogin ?? "unknown",
      detectedAt,
    },
  ];
}
