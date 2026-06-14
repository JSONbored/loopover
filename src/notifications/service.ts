import { sanitizePublicComment } from "../github/commands";
import {
  countRecentNotificationDeliveries,
  getNotificationDeliveryById,
  insertNotificationDeliveryIfAbsent,
  listIssueWatchersForRepo,
  listNotificationSubscriptionsForLogin,
  markNotificationDeliveryDelivered,
} from "../db/repositories";
import { isGrabbableHighMultiplierIssue } from "../signals/engine";
import type { DetectedNotificationEvent, IssueRecord, NotificationChannel, NotificationDeliveryRecord, NotificationSubscriptionRecord } from "../types";
import { nowIso } from "../utils/json";

// Per-recipient, per-channel safety cap. The killer event (changes_requested) delivers immediately, but a
// burst of reviews must not flood a miner's badge — beyond the cap inside the window, deliveries are still
// recorded (idempotent) but marked `suppressed` so they neither notify nor count toward the next window.
export const NOTIFICATION_RATE_LIMIT = { windowMinutes: 60, maxPerWindow: 10 } as const;

// `badge` is the channel shipped first (pull-based extension + harness feed). It is on by default; a miner
// opts OUT by pausing the badge subscription. `email` (#570) is a later opt-in channel — not resolved yet.
export function resolveNotificationChannels(subscriptions: NotificationSubscriptionRecord[]): NotificationChannel[] {
  const badgePaused = subscriptions.some((subscription) => subscription.channel === "badge" && subscription.status === "paused");
  return badgePaused ? [] : ["badge"];
}

export function buildChangesRequestedNotification(event: DetectedNotificationEvent): { title: string; body: string } {
  const ref = `${event.repoFullName}#${event.pullNumber}`;
  const reviewer = event.actorLogin && event.actorLogin !== "unknown" ? `@${event.actorLogin}` : "a reviewer";
  return {
    title: sanitizePublicComment(`Changes requested on ${ref}`),
    body: sanitizePublicComment(`${reviewer} requested changes on your pull request ${ref}. Address the review feedback to keep it on track to merge.`),
  };
}

// Post-merge self-attribution (#702): the miner's OWN outcome record for a merged PR. Public-safe — frames
// what merged work does for the contributor's standing, never raw reward $/trust/score.
export function buildMergedOutcomeNotification(event: DetectedNotificationEvent): { title: string; body: string } {
  const ref = `${event.repoFullName}#${event.pullNumber}`;
  return {
    title: sanitizePublicComment(`Merged: ${ref}`),
    body: sanitizePublicComment(`Your pull request ${ref} merged. Merged contributions like this strengthen your standing and lane signals on ${event.repoFullName} — check your decision pack for the next high-fit issue to keep your momentum.`),
  };
}

// #699 path B: a repo a miner watches opened a NEW grabbable, high-multiplier issue. For this eventType the
// `pullNumber` field carries the ISSUE number. Public-safe — "open to grab" framing, never raw reward/score.
export function buildIssueWatchNotification(event: DetectedNotificationEvent): { title: string; body: string } {
  const ref = `${event.repoFullName}#${event.pullNumber}`;
  return {
    title: sanitizePublicComment(`New issue to grab on ${ref}`),
    body: sanitizePublicComment(`A new maintainer-created issue opened on ${ref} that is open for you to grab. Maintainer-created issues are strong early targets on ${event.repoFullName} — claim it to line up your next contribution.`),
  };
}

// Maps a detected event to its public-safe notification content.
export function buildNotificationContent(event: DetectedNotificationEvent): { title: string; body: string } {
  switch (event.eventType) {
    case "pull_request_merged":
      return buildMergedOutcomeNotification(event);
    case "issue_watch_match":
      return buildIssueWatchNotification(event);
    default:
      return buildChangesRequestedNotification(event);
  }
}

/**
 * #699 path B: when a webhook opens a NEW grabbable, high-multiplier issue, fan out one notification event
 * per watching miner (matching their optional label filter), skipping the issue's own author. DB-backed
 * (reads the repo's watchers), so it lives here rather than in the pure payload-only detectNotificationEvents.
 */
export async function detectIssueWatchEvents(env: Env, repoFullName: string, issue: IssueRecord): Promise<DetectedNotificationEvent[]> {
  if (!isGrabbableHighMultiplierIssue(issue)) return [];
  const watchers = await listIssueWatchersForRepo(env, repoFullName);
  if (watchers.length === 0) return [];
  const detectedAt = nowIso();
  const issueLabels = new Set(issue.labels.map((label) => label.toLowerCase().trim()));
  const authorLogin = issue.authorLogin?.toLowerCase();
  return watchers
    // An empty label filter matches any issue; otherwise at least one watched label must be present.
    .filter((watcher) => watcher.labels.length === 0 || watcher.labels.some((label) => issueLabels.has(label)))
    // Don't ping the maintainer who opened the issue about their own issue.
    .filter((watcher) => watcher.login.toLowerCase() !== authorLogin)
    .map((watcher) => ({
      eventType: "issue_watch_match" as const,
      recipientLogin: watcher.login,
      repoFullName,
      pullNumber: issue.number, // carries the ISSUE number for this eventType
      dedupKey: `issue_watch_match:${repoFullName}#${issue.number}:${watcher.login.toLowerCase()}`,
      deeplink: `https://github.com/${repoFullName}/issues/${issue.number}`,
      actorLogin: issue.authorLogin ?? "unknown",
      detectedAt,
    }));
}

function rateLimitWindowStart(now: string): string {
  return new Date(Date.parse(now) - NOTIFICATION_RATE_LIMIT.windowMinutes * 60_000).toISOString();
}

// Resolves the recipient's enabled channels and writes one idempotent delivery row per channel. Returns the
// rows that were freshly created with status `pending` (the caller enqueues a deliver job for each). Rows
// that already existed (duplicate webhook/retry) or were rate-limited/suppressed are NOT returned.
export async function evaluateNotificationEvent(env: Env, event: DetectedNotificationEvent): Promise<NotificationDeliveryRecord[]> {
  const subscriptions = await listNotificationSubscriptionsForLogin(env, event.recipientLogin);
  const channels = resolveNotificationChannels(subscriptions);
  if (channels.length === 0) return [];

  const { title, body } = buildNotificationContent(event);
  const now = nowIso();
  const windowStart = rateLimitWindowStart(now);
  const pending: NotificationDeliveryRecord[] = [];

  for (const channel of channels) {
    const recent = await countRecentNotificationDeliveries(env, event.recipientLogin, channel, windowStart);
    const status = recent >= NOTIFICATION_RATE_LIMIT.maxPerWindow ? "suppressed" : "pending";
    const { delivery, created } = await insertNotificationDeliveryIfAbsent(env, {
      dedupKey: event.dedupKey,
      channel,
      recipientLogin: event.recipientLogin,
      eventType: event.eventType,
      repoFullName: event.repoFullName,
      pullNumber: event.pullNumber,
      title,
      body,
      deeplink: event.deeplink,
      actorLogin: event.actorLogin,
      status,
    });
    if (created && delivery.status === "pending") pending.push(delivery);
  }
  return pending;
}

export type NotificationFeedItem = {
  id: string;
  eventType: string;
  repoFullName: string;
  pullNumber: number | null;
  title: string;
  body: string;
  deeplink: string;
  status: NotificationDeliveryRecord["status"];
  createdAt: string;
};

export type NotificationFeed = {
  login: string;
  unreadCount: number;
  notifications: NotificationFeedItem[];
};

// Shapes the recipient's badge feed: the unread count (the badge number) plus recent items. Only rows that
// reached `delivered` (or already `read`) are shown — `pending`/`suppressed` never surface to the user.
export function buildNotificationFeed(login: string, deliveries: NotificationDeliveryRecord[]): NotificationFeed {
  const visible = deliveries.filter((delivery) => delivery.status === "delivered" || delivery.status === "read");
  return {
    login: login.toLowerCase(),
    unreadCount: visible.filter((delivery) => delivery.status === "delivered").length,
    notifications: visible.map((delivery) => ({
      id: delivery.id,
      eventType: delivery.eventType,
      repoFullName: delivery.repoFullName,
      pullNumber: delivery.pullNumber,
      title: delivery.title,
      body: delivery.body,
      deeplink: delivery.deeplink,
      status: delivery.status,
      createdAt: delivery.createdAt,
    })),
  };
}

// Badge delivery is pull-based: "delivering" just makes the row visible to the recipient's feed (status
// pending -> delivered). Email/web-push (#570) would perform an outbound send here for their channel.
export async function deliverNotification(env: Env, deliveryId: string): Promise<void> {
  const delivery = await getNotificationDeliveryById(env, deliveryId);
  /* v8 ignore next -- deliver is only enqueued for a row that was just created; the guard protects retries after deletion. */
  if (!delivery || delivery.status !== "pending") return;
  // Only the badge channel is resolved today (resolveNotificationChannels), so every delivery is a badge
  // delivery — making the row visible to the recipient's feed. Email/web-push (#570) will branch by channel here.
  await markNotificationDeliveryDelivered(env, deliveryId);
}
