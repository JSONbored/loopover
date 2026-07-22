// AMS → badge notification bridge (#7657). Pure builders for DetectedNotificationEvent rows that the miner
// (and the session-authenticated ingest route) feed into evaluateNotificationEvent → notify-deliver — the same
// path job-dispatch.ts uses for webhook-detected kinds. No parallel delivery store.

import type { DetectedNotificationEvent, NotificationEventType } from "../types";
import { nowIso } from "../utils/json";

export const AMS_NOTIFICATION_EVENT_TYPES = [
  "ams_attempt_started",
  "ams_attempt_failed",
  "ams_governor_paused",
  "ams_pr_outcome",
] as const satisfies readonly NotificationEventType[];

export type AmsNotificationEventType = (typeof AMS_NOTIFICATION_EVENT_TYPES)[number];

const AMS_EVENT_TYPE_SET = new Set<string>(AMS_NOTIFICATION_EVENT_TYPES);

export function isAmsNotificationEventType(value: unknown): value is AmsNotificationEventType {
  return typeof value === "string" && AMS_EVENT_TYPE_SET.has(value);
}

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

function githubIssueDeeplink(repoFullName: string, issueNumber: number): string {
  return `https://github.com/${repoFullName}/issues/${issueNumber}`;
}

function githubPullDeeplink(repoFullName: string, pullNumber: number): string {
  return `https://github.com/${repoFullName}/pull/${pullNumber}`;
}

/** Attempt start — `pullNumber` carries the ISSUE number (same overload issue_watch_match uses). */
export function buildAmsAttemptStartedEvent(input: {
  recipientLogin: string;
  repoFullName: string;
  issueNumber: number;
  attemptId: string;
  detectedAt?: string;
}): DetectedNotificationEvent {
  const recipientLogin = normalizeLogin(input.recipientLogin);
  const detectedAt = input.detectedAt ?? nowIso();
  return {
    eventType: "ams_attempt_started",
    recipientLogin,
    repoFullName: input.repoFullName,
    pullNumber: input.issueNumber,
    dedupKey: `ams_attempt_started:${input.repoFullName}#${input.issueNumber}:${input.attemptId}`,
    deeplink: githubIssueDeeplink(input.repoFullName, input.issueNumber),
    actorLogin: recipientLogin,
    detectedAt,
  };
}

/** Attempt fail — same issue-number overload as start. */
export function buildAmsAttemptFailedEvent(input: {
  recipientLogin: string;
  repoFullName: string;
  issueNumber: number;
  attemptId: string;
  reason?: string | null;
  detectedAt?: string;
}): DetectedNotificationEvent {
  const recipientLogin = normalizeLogin(input.recipientLogin);
  const detectedAt = input.detectedAt ?? nowIso();
  const reasonKey = input.reason?.trim() ? `:${input.reason.trim().slice(0, 80)}` : "";
  return {
    eventType: "ams_attempt_failed",
    recipientLogin,
    repoFullName: input.repoFullName,
    pullNumber: input.issueNumber,
    dedupKey: `ams_attempt_failed:${input.repoFullName}#${input.issueNumber}:${input.attemptId}${reasonKey}`,
    deeplink: githubIssueDeeplink(input.repoFullName, input.issueNumber),
    actorLogin: recipientLogin,
    detectedAt,
  };
}

/**
 * Governor pause — not PR-scoped. `repoFullName` is a stable synthetic scope (`ams/governor`); `pullNumber` is 0.
 */
export function buildAmsGovernorPausedEvent(input: {
  recipientLogin: string;
  reason?: string | null;
  pausedAt?: string;
  detectedAt?: string;
}): DetectedNotificationEvent {
  const recipientLogin = normalizeLogin(input.recipientLogin);
  const detectedAt = input.detectedAt ?? nowIso();
  const pausedAt = input.pausedAt ?? detectedAt;
  const reasonKey = input.reason?.trim() ? `:${input.reason.trim().slice(0, 80)}` : "";
  return {
    eventType: "ams_governor_paused",
    recipientLogin,
    repoFullName: "ams/governor",
    pullNumber: 0,
    dedupKey: `ams_governor_paused:${recipientLogin}:${pausedAt}${reasonKey}`,
    deeplink: "https://github.com/JSONbored/loopover",
    actorLogin: recipientLogin,
    detectedAt,
  };
}

/** Miner-local PR outcome change (merged or closed). */
export function buildAmsPrOutcomeEvent(input: {
  recipientLogin: string;
  repoFullName: string;
  pullNumber: number;
  decision: "merged" | "closed";
  closedAt?: string | null;
  detectedAt?: string;
}): DetectedNotificationEvent {
  const recipientLogin = normalizeLogin(input.recipientLogin);
  const detectedAt = input.detectedAt ?? nowIso();
  const closedAt = input.closedAt?.trim() || detectedAt;
  return {
    eventType: "ams_pr_outcome",
    recipientLogin,
    repoFullName: input.repoFullName,
    pullNumber: input.pullNumber,
    dedupKey: `ams_pr_outcome:${input.repoFullName}#${input.pullNumber}:${input.decision}:${closedAt}`,
    deeplink: githubPullDeeplink(input.repoFullName, input.pullNumber),
    actorLogin: recipientLogin,
    detectedAt,
  };
}

/**
 * Validate a miner-posted AMS event payload and stamp the authenticated recipient. Rejects non-AMS kinds so
 * this ingest cannot forge webhook notification types.
 */
export function normalizeAmsNotificationEventInput(
  raw: unknown,
  recipientLogin: string,
): DetectedNotificationEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!isAmsNotificationEventType(record.eventType)) return null;
  if (typeof record.repoFullName !== "string" || !record.repoFullName.trim()) return null;
  if (typeof record.dedupKey !== "string" || !record.dedupKey.trim()) return null;
  if (typeof record.deeplink !== "string" || !record.deeplink.trim()) return null;
  if (typeof record.actorLogin !== "string" || !record.actorLogin.trim()) return null;
  if (typeof record.detectedAt !== "string" || !record.detectedAt.trim()) return null;
  if (!Number.isInteger(record.pullNumber) || (record.pullNumber as number) < 0) return null;
  return {
    eventType: record.eventType,
    recipientLogin: normalizeLogin(recipientLogin),
    repoFullName: record.repoFullName.trim(),
    pullNumber: record.pullNumber as number,
    dedupKey: record.dedupKey.trim(),
    deeplink: record.deeplink.trim(),
    actorLogin: record.actorLogin.trim(),
    detectedAt: record.detectedAt.trim(),
  };
}
