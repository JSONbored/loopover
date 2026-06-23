import { sanitizePublicComment } from "../github/commands";
import {
  claimPendingNotificationDeliveries,
  countRecentNotificationDeliveries,
  getNotificationDeliveryById,
  getRepository,
  insertNotificationDeliveryIfAbsent,
  listIssueWatchersForRepo,
  listDigestSubscriptionsForLogin,
  listNotificationDeliveriesByIds,
  listPendingNotificationDeliveriesForRecipient,
  listNotificationSubscriptionsForLogin,
  markNotificationDeliveriesDelivered,
  markNotificationDeliveriesPending,
  markNotificationDeliveryDelivered,
} from "../db/repositories";
import { isGrabbableHighMultiplierIssue } from "../signals/engine";
import { canLoginAccessRepo } from "../services/control-panel-roles";
import type {
  DetectedNotificationEvent,
  DigestSubscriptionRecord,
  IssueRecord,
  NotificationChannel,
  NotificationDeliveryRecord,
  NotificationSubscriptionRecord,
} from "../types";
import { nowIso } from "../utils/json";

// Per-recipient, per-channel safety cap. The killer event (changes_requested) delivers immediately, but a
// burst of reviews must not flood a miner's badge — beyond the cap inside the window, deliveries are still
// recorded (idempotent) but marked `suppressed` so they neither notify nor count toward the next window.
export const NOTIFICATION_RATE_LIMIT = { windowMinutes: 60, maxPerWindow: 10 } as const;
export const EMAIL_NOTIFICATION_MAX_ITEMS = 10;
const DEFAULT_NOTIFICATION_FROM_EMAIL = "notifications@gittensory.aethereal.dev";
const EMAIL_SUBJECT_PREFIX = "[Gittensory]";

// `badge` is the channel shipped first (pull-based extension + harness feed). It is on by default; a miner
// opts OUT by pausing the badge subscription. `email` is opt-in and reuses active digest subscriptions as the
// destination list; a paused email notification subscription mutes outbound sends without deleting the stored
// digest opt-in rows.
export function resolveNotificationChannels(
  subscriptions: NotificationSubscriptionRecord[],
  digestSubscriptions: DigestSubscriptionRecord[] = [],
): NotificationChannel[] {
  const badgePaused = subscriptions.some((subscription) => subscription.channel === "badge" && subscription.status === "paused");
  const channels: NotificationChannel[] = badgePaused ? [] : ["badge"];
  if (resolveNotificationEmailDestinations(subscriptions, digestSubscriptions).length > 0) channels.push("email");
  return channels;
}

export function resolveNotificationEmailDestinations(
  subscriptions: NotificationSubscriptionRecord[],
  digestSubscriptions: DigestSubscriptionRecord[],
): string[] {
  const emailPaused = subscriptions.some((subscription) => subscription.channel === "email" && subscription.status === "paused");
  if (emailPaused) return [];
  const explicitDestinations = subscriptions
    .filter((subscription) => subscription.channel === "email" && subscription.status === "active")
    .map((subscription) => subscription.destination?.trim().toLowerCase() ?? "")
    .filter(Boolean);
  if (explicitDestinations.length > 0) return [...new Set(explicitDestinations)];
  return [
    ...new Set(
      digestSubscriptions
        .filter((subscription) => subscription.status === "active")
        .map((subscription) => subscription.email.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
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
  const matching = watchers
    // An empty label filter matches any issue; otherwise at least one watched label must be present.
    .filter((watcher) => watcher.labels.length === 0 || watcher.labels.some((label) => issueLabels.has(label)))
    // Don't ping the maintainer who opened the issue about their own issue.
    .filter((watcher) => watcher.login.toLowerCase() !== authorLogin);

  // Access gate: a gittensory-tracked PUBLIC repo fans out to every matching watcher (the miner use case);
  // a PRIVATE — or untracked/unknown — repo only to watchers who can access it, so private-repo issues never
  // reach a non-collaborator. The repo is the same for all watchers, so resolve it once and only pay the
  // per-watcher access check on the private path.
  const repo = await getRepository(env, repoFullName);
  const authorizedWatchers =
    repo && !repo.isPrivate
      ? matching
      : (await Promise.all(matching.map(async (watcher) => ((repo && (await canLoginAccessRepo(env, watcher.login, repoFullName))) ? watcher : null)))).filter(
          (watcher) => watcher !== null,
        );

  return authorizedWatchers.map((watcher) => ({
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
  const [subscriptions, digestSubscriptions] = await Promise.all([
    listNotificationSubscriptionsForLogin(env, event.recipientLogin),
    listDigestSubscriptionsForLogin(env, event.recipientLogin),
  ]);
  const emailDeliveryEnabled = notificationEmailDeliveryEnabled(env);
  const emailCapableSubscriptions = emailDeliveryEnabled ? subscriptions : subscriptions.filter((subscription) => subscription.channel !== "email");
  const emailCapableDigestSubscriptions = emailDeliveryEnabled ? digestSubscriptions : [];
  const channels = resolveNotificationChannels(emailCapableSubscriptions, emailCapableDigestSubscriptions);
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
  const notifications: NotificationFeedItem[] = [];
  let unreadCount = 0;
  for (const delivery of deliveries) {
    if (delivery.status !== "delivered" && delivery.status !== "read") continue;
    if (delivery.status === "delivered") unreadCount += 1;
    notifications.push({
      id: delivery.id,
      eventType: delivery.eventType,
      repoFullName: delivery.repoFullName,
      pullNumber: delivery.pullNumber,
      title: delivery.title,
      body: delivery.body,
      deeplink: delivery.deeplink,
      status: delivery.status,
      createdAt: delivery.createdAt,
    });
  }
  return { login: login.toLowerCase(), unreadCount, notifications };
}

export async function deliverNotification(env: Env, deliveryId: string): Promise<void> {
  const delivery = await getNotificationDeliveryById(env, deliveryId);
  /* v8 ignore next -- deliver is only enqueued for a row that was just created; the guard protects retries after deletion. */
  if (!delivery || delivery.status !== "pending") return;
  if (delivery.channel === "badge") {
    await markNotificationDeliveryDelivered(env, deliveryId);
    return;
  }
  await deliverEmailNotification(env, delivery);
}

function notificationFromAddress(env: Env): string {
  return env.NOTIFICATION_FROM_EMAIL?.trim() || DEFAULT_NOTIFICATION_FROM_EMAIL;
}

export function notificationEmailDeliveryEnabled(env: Env): boolean {
  return typeof env.EMAIL?.send === "function" && Boolean(notificationFromAddress(env));
}

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

export function buildNotificationEmailMessage(deliveries: NotificationDeliveryRecord[]): { subject: string; text: string } {
  const items = deliveries.slice(0, EMAIL_NOTIFICATION_MAX_ITEMS);
  const repoCount = new Set(items.map((delivery) => delivery.repoFullName.toLowerCase())).size;
  const subject =
    items.length === 1
      ? `${EMAIL_SUBJECT_PREFIX} ${items[0]!.title}`
      : `${EMAIL_SUBJECT_PREFIX} ${items.length} updates across ${repoCount} ${pluralize(repoCount, "repo", "repos")}`;
  const intro =
    items.length === 1
      ? "You have a new Gittensory update."
      : `You have ${items.length} new Gittensory updates. Recent review activity was coalesced into this one email.`;
  const lines = [
    intro,
    "",
    ...items.flatMap((delivery, index) => [
      `${index + 1}. ${delivery.title}`,
      delivery.body,
      `Link: ${delivery.deeplink}`,
      "",
    ]),
    "You received this because you opted into Gittensory email notifications via the digest panel.",
  ];
  return { subject, text: lines.join("\n").trim() };
}

async function deliverEmailNotification(env: Env, anchorDelivery: NotificationDeliveryRecord): Promise<void> {
  const emailSend = env.EMAIL?.send;
  if (!notificationEmailDeliveryEnabled(env) || typeof emailSend !== "function") {
    throw new Error("notification_email_unconfigured");
  }
  const [subscriptions, digestSubscriptions] = await Promise.all([
    listNotificationSubscriptionsForLogin(env, anchorDelivery.recipientLogin),
    listDigestSubscriptionsForLogin(env, anchorDelivery.recipientLogin),
  ]);
  const destinations = resolveNotificationEmailDestinations(subscriptions, digestSubscriptions);
  if (destinations.length === 0) {
    // Without a resolved destination, do not claim sibling email rows into `sending`; only finalize the
    // anchor row so a store-only/muted state cannot strand pending deliveries.
    await markNotificationDeliveryDelivered(env, anchorDelivery.id);
    return;
  }

  const pending = await listPendingNotificationDeliveriesForRecipient(env, anchorDelivery.recipientLogin, "email", EMAIL_NOTIFICATION_MAX_ITEMS);
  const candidateIds = pending.map((delivery) => delivery.id);
  const claimedIds = await claimPendingNotificationDeliveries(env, candidateIds);
  if (!claimedIds.includes(anchorDelivery.id)) return;

  const claimed = await listNotificationDeliveriesByIds(env, claimedIds);
  const bundle = claimed
    .filter((delivery) => delivery.channel === "email")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(0, EMAIL_NOTIFICATION_MAX_ITEMS);
  if (bundle.length === 0) return;

  const { subject, text } = buildNotificationEmailMessage(bundle);
  try {
    await Promise.all(
      destinations.map((to) =>
        emailSend({
          to,
          from: notificationFromAddress(env),
          subject,
          text,
          headers: { "X-Gittensory-Recipient": anchorDelivery.recipientLogin },
        }),
      ),
    );
    await markNotificationDeliveriesDelivered(env, bundle.map((delivery) => delivery.id));
  } catch (error) {
    await markNotificationDeliveriesPending(env, bundle.map((delivery) => delivery.id));
    throw error;
  }
}
