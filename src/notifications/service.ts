import { sanitizePublicComment } from "../github/commands";
import {
  countRecentNotificationDeliveries,
  getNotificationDeliveryById,
  insertNotificationDeliveryIfAbsent,
  listNotificationSubscriptionsForLogin,
  markNotificationDeliveryDelivered,
} from "../db/repositories";
import type { DetectedNotificationEvent, NotificationChannel, NotificationDeliveryRecord, NotificationSubscriptionRecord } from "../types";
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

  const { title, body } = buildChangesRequestedNotification(event);
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
