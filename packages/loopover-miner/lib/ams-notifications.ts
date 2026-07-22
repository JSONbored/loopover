// AMS → hosted badge notifications (#7657). Builds DetectedNotificationEvent-shaped AMS kinds and POSTs them
// to the contributor ams-notifications ingest, which evaluates through evaluateNotificationEvent →
// notify-deliver (same handoff as src/queue/job-dispatch.ts). Fail-soft: a missing session or network blip
// never breaks the miner's real work. No parallel local notification store.

import { resolveLoopoverBackendSession } from "./github-token-resolution.js";

export type AmsNotificationEventPayload = {
  eventType: "ams_attempt_started" | "ams_attempt_failed" | "ams_governor_paused" | "ams_pr_outcome";
  recipientLogin: string;
  repoFullName: string;
  pullNumber: number;
  dedupKey: string;
  deeplink: string;
  actorLogin: string;
  detectedAt: string;
};

export type AmsNotificationPublishResult = { sent: number; error?: string };

export type AmsNotificationFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<Response>;

export type PublishAmsNotificationEventsOptions = {
  env?: Record<string, string | undefined>;
  fetchFn?: AmsNotificationFetch;
  timeoutMs?: number;
  /** Test/self-host inject: mirrors job-dispatch evaluate → notify-deliver without HTTP. */
  dispatch?: (events: AmsNotificationEventPayload[]) => Promise<void>;
};

export const DEFAULT_AMS_NOTIFICATION_TIMEOUT_MS = 10_000;

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

function nowIso(): string {
  return new Date().toISOString();
}

function githubIssueDeeplink(repoFullName: string, issueNumber: number): string {
  return `https://github.com/${repoFullName}/issues/${issueNumber}`;
}

function githubPullDeeplink(repoFullName: string, pullNumber: number): string {
  return `https://github.com/${repoFullName}/pull/${pullNumber}`;
}

export function buildAmsAttemptStartedPayload(input: {
  recipientLogin: string;
  repoFullName: string;
  issueNumber: number;
  attemptId: string;
  detectedAt?: string;
}): AmsNotificationEventPayload {
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

export function buildAmsAttemptFailedPayload(input: {
  recipientLogin: string;
  repoFullName: string;
  issueNumber: number;
  attemptId: string;
  reason?: string | null;
  detectedAt?: string;
}): AmsNotificationEventPayload {
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

export function buildAmsGovernorPausedPayload(input: {
  recipientLogin: string;
  reason?: string | null;
  pausedAt?: string;
  detectedAt?: string;
}): AmsNotificationEventPayload {
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

export function buildAmsPrOutcomePayload(input: {
  recipientLogin: string;
  repoFullName: string;
  pullNumber: number;
  decision: "merged" | "closed";
  closedAt?: string | null;
  detectedAt?: string;
}): AmsNotificationEventPayload {
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
 * Publish AMS notification events through the hosted evaluate → notify-deliver path. Prefer an injected
 * `dispatch` (tests / in-process self-host). Otherwise POST to `/v1/contributors/:login/ams-notifications`
 * when a loopover-mcp session is on disk. Never throws.
 */
export async function publishAmsNotificationEvents(
  events: AmsNotificationEventPayload[],
  options: PublishAmsNotificationEventsOptions = {},
): Promise<AmsNotificationPublishResult> {
  if (!Array.isArray(events) || events.length === 0) return { sent: 0 };
  if (options.dispatch) {
    try {
      await options.dispatch(events);
      return { sent: events.length };
    } catch (error) {
      return { sent: 0, error: error instanceof Error ? error.message.slice(0, 160) : "dispatch_failed" };
    }
  }

  const env = options.env ?? process.env;
  const session = resolveLoopoverBackendSession(env as NodeJS.ProcessEnv);
  if (!session) return { sent: 0, error: "no_session" };

  const recipientLogin = normalizeLogin(events[0]!.recipientLogin);
  if (!recipientLogin) return { sent: 0, error: "missing_recipient" };
  if (events.some((event) => normalizeLogin(event.recipientLogin) !== recipientLogin)) {
    return { sent: 0, error: "mixed_recipients" };
  }

  const fetchFn = options.fetchFn ?? (fetch as AmsNotificationFetch);
  const timeoutMs = options.timeoutMs ?? DEFAULT_AMS_NOTIFICATION_TIMEOUT_MS;
  const url = `${session.apiUrl}/v1/contributors/${encodeURIComponent(recipientLogin)}/ams-notifications`;
  const body = JSON.stringify({
    events: events.map(({ eventType, repoFullName, pullNumber, dedupKey, deeplink, actorLogin, detectedAt }) => ({
      eventType,
      repoFullName,
      pullNumber,
      dedupKey,
      deeplink,
      actorLogin,
      detectedAt,
    })),
  });

  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.sessionToken}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { sent: 0, error: `http_${response.status}` };
    }
    return { sent: events.length };
  } catch (error) {
    return { sent: 0, error: error instanceof Error ? error.message.slice(0, 160) : "network_failed" };
  }
}

/** Fire-and-forget wrapper for sync call sites (never awaits into the caller's critical path). */
export function scheduleAmsNotificationEvents(
  events: AmsNotificationEventPayload[],
  options: PublishAmsNotificationEventsOptions = {},
): void {
  void publishAmsNotificationEvents(events, options).catch(() => {
    // publishAmsNotificationEvents is already fail-soft; this only guards a rejected promise from an inject.
  });
}
