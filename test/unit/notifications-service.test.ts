import { describe, expect, it } from "vitest";
import {
  buildNotificationEmailMessage,
  buildChangesRequestedNotification,
  buildNotificationContent,
  buildNotificationFeed,
  deliverNotification,
  evaluateNotificationEvent,
  NOTIFICATION_RATE_LIMIT,
  notificationEmailDeliveryEnabled,
  resolveNotificationChannels,
  resolveNotificationEmailDestinations,
} from "../../src/notifications/service";
import {
  getNotificationDeliveryById,
  MAX_NOTIFICATION_DELIVERY_ID_LENGTH,
  MAX_NOTIFICATION_MARK_READ_IDS,
  insertNotificationDeliveryIfAbsent,
  listDigestSubscriptionsForLogin,
  listNotificationDeliveriesForRecipient,
  listNotificationSubscriptionsForLogin,
  markNotificationDeliveriesRead,
  upsertDigestSubscription,
  upsertNotificationSubscription,
} from "../../src/db/repositories";
import { processJob } from "../../src/queue/processors";
import { createTestEnv } from "../helpers/d1";
import type { DetectedNotificationEvent, NotificationDeliveryRecord, NotificationSubscriptionRecord } from "../../src/types";

function event(overrides: Partial<DetectedNotificationEvent> = {}): DetectedNotificationEvent {
  return {
    eventType: "pull_request_changes_requested",
    recipientLogin: "miner",
    repoFullName: "owner/repo",
    pullNumber: 7,
    dedupKey: "changes_requested:owner/repo#7:reviewer:2026-05-28T12:00:00.000Z",
    deeplink: "https://github.com/owner/repo/pull/7",
    actorLogin: "reviewer",
    detectedAt: "2026-05-28T12:00:00.000Z",
    ...overrides,
  };
}

function subscription(overrides: Partial<NotificationSubscriptionRecord> = {}): NotificationSubscriptionRecord {
  return {
    id: "sub-1",
    login: "miner",
    channel: "badge",
    status: "active",
    destination: null,
    source: "app",
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z",
    ...overrides,
  };
}

function deliveryRecord(overrides: Partial<NotificationDeliveryRecord> = {}): NotificationDeliveryRecord {
  return {
    id: "d1",
    dedupKey: "k1",
    channel: "badge",
    recipientLogin: "miner",
    eventType: "pull_request_changes_requested",
    repoFullName: "owner/repo",
    pullNumber: 7,
    title: "t",
    body: "b",
    deeplink: "https://x",
    actorLogin: "reviewer",
    status: "delivered",
    createdAt: "2026-05-28T12:00:00.000Z",
    deliveredAt: "2026-05-28T12:00:00.000Z",
    readAt: null,
    ...overrides,
  };
}

describe("notification channel resolution + copy", () => {
  it("keeps badge on by default, derives email from digest opt-ins, and lets paused subscriptions mute channels", () => {
    const digestOptIn = [{ id: "digest-1", login: "miner", email: "miner@example.com", status: "active" as const, source: "app", createdAt: "2026-05-28T00:00:00.000Z", updatedAt: "2026-05-28T00:00:00.000Z" }];
    expect(resolveNotificationChannels([])).toEqual(["badge"]);
    expect(resolveNotificationChannels([], digestOptIn)).toEqual(["badge", "email"]);
    expect(resolveNotificationChannels([subscription({ status: "active" })], digestOptIn)).toEqual(["badge", "email"]);
    expect(resolveNotificationChannels([subscription({ channel: "email", status: "paused" })], digestOptIn)).toEqual(["badge"]);
    expect(resolveNotificationChannels([subscription({ status: "paused" })], digestOptIn)).toEqual(["email"]);
  });

  it("prefers explicit email destinations and falls back to active digest subscriptions", () => {
    const digestOptIns = [
      { id: "digest-1", login: "miner", email: "miner@example.com", status: "active" as const, source: "app", createdAt: "2026-05-28T00:00:00.000Z", updatedAt: "2026-05-28T00:00:00.000Z" },
      { id: "digest-2", login: "miner", email: "other@example.com", status: "paused" as const, source: "app", createdAt: "2026-05-28T00:00:00.000Z", updatedAt: "2026-05-28T00:00:00.000Z" },
    ];
    expect(resolveNotificationEmailDestinations([], digestOptIns)).toEqual(["miner@example.com"]);
    expect(resolveNotificationEmailDestinations([subscription({ channel: "email", destination: "custom@example.com" })], digestOptIns)).toEqual(["custom@example.com"]);
    expect(resolveNotificationEmailDestinations([subscription({ channel: "email", status: "paused" })], digestOptIns)).toEqual([]);
  });

  it("builds public-safe changes-requested copy and falls back when the reviewer is unknown", () => {
    const named = buildChangesRequestedNotification(event());
    expect(named.title).toContain("owner/repo#7");
    expect(named.body).toContain("@reviewer");

    const anon = buildChangesRequestedNotification(event({ actorLogin: "unknown" }));
    expect(anon.body).toContain("a reviewer");
    expect(anon.body).not.toContain("@unknown");
  });

  it("shows only delivered/read rows in the feed and counts only delivered as unread", () => {
    const feed = buildNotificationFeed("Miner", [
      deliveryRecord({ id: "a", status: "delivered" }),
      deliveryRecord({ id: "b", status: "read" }),
      deliveryRecord({ id: "c", status: "pending" }),
      deliveryRecord({ id: "d", status: "suppressed" }),
    ]);
    expect(feed.login).toBe("miner");
    expect(feed.unreadCount).toBe(1);
    expect(feed.notifications.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("builds a coalesced email body for pending notification bundles", () => {
    const message = buildNotificationEmailMessage([
      deliveryRecord({ title: "Changes requested on owner/repo#7", body: "@reviewer requested changes", deeplink: "https://github.com/owner/repo/pull/7" }),
      deliveryRecord({ id: "d2", title: "Merged: owner/repo#8", body: "Your pull request merged", deeplink: "https://github.com/owner/repo/pull/8" }),
    ]);
    expect(message.subject).toContain("[Gittensory]");
    expect(message.subject).toContain("2 updates");
    expect(message.text).toContain("Recent review activity was coalesced");
    expect(message.text).toContain("Changes requested on owner/repo#7");
    expect(message.text).toContain("Link: https://github.com/owner/repo/pull/8");
  });
});

describe("merged-PR outcome attribution (#702)", () => {
  it("builds public-safe merge attribution copy and routes by event type", () => {
    const merged = buildNotificationContent(event({ eventType: "pull_request_merged" }));
    expect(merged.title.toLowerCase()).toContain("merged");
    expect(merged.body.toLowerCase()).toContain("merged");
    expect(merged.body).toContain("owner/repo");
    expect(JSON.stringify(merged)).not.toMatch(/reward|payout|trust score|wallet|\$/i);
    // The dispatcher still routes changes_requested to the review copy.
    expect(buildNotificationContent(event()).title.toLowerCase()).toContain("changes requested");
  });

  it("persists a merged outcome as a retrievable, eventType-filtered delivery", async () => {
    const env = createTestEnv();
    await evaluateNotificationEvent(env, event({ eventType: "pull_request_merged", dedupKey: "pull_request_merged:owner/repo#7:m1" }));
    await evaluateNotificationEvent(env, event({ dedupKey: "changes_requested:owner/repo#7:r:t" }));
    const outcomes = await listNotificationDeliveriesForRecipient(env, "miner", { eventType: "pull_request_merged" });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ eventType: "pull_request_merged", repoFullName: "owner/repo", pullNumber: 7 });
  });
});

describe("evaluateNotificationEvent", () => {
  it("creates exactly one badge delivery and is idempotent on a duplicate event", async () => {
    const env = createTestEnv();
    const created = await evaluateNotificationEvent(env, event());
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ channel: "badge", recipientLogin: "miner", status: "pending" });

    const again = await evaluateNotificationEvent(env, event());
    expect(again).toEqual([]);

    const rows = await listNotificationDeliveriesForRecipient(env, "miner");
    expect(rows).toHaveLength(1);
  });

  it("returns nothing when the recipient has muted the badge channel", async () => {
    const env = createTestEnv();
    await upsertNotificationSubscription(env, { login: "miner", channel: "badge", status: "paused" });
    expect(await evaluateNotificationEvent(env, event())).toEqual([]);
    expect(await listNotificationDeliveriesForRecipient(env, "miner")).toHaveLength(0);
  });

  it("creates an email delivery when the recipient has an active digest opt-in", async () => {
    const env = createTestEnv();
    await upsertDigestSubscription(env, { login: "Miner", email: "miner@example.com" });
    const created = await evaluateNotificationEvent(env, event());
    expect(created.map((delivery) => delivery.channel)).toEqual(["badge", "email"]);
  });

  it("keeps digest subscriptions store-only when email delivery is not runtime-configured", async () => {
    const env = createTestEnv();
    delete env.EMAIL;
    await upsertDigestSubscription(env, { login: "Miner", email: "miner@example.com" });
    const created = await evaluateNotificationEvent(env, event());
    expect(created.map((delivery) => delivery.channel)).toEqual(["badge"]);
  });

  it("does not create email deliveries from explicit email subscriptions when email delivery is not runtime-configured", async () => {
    const env = createTestEnv();
    delete env.EMAIL;
    await upsertNotificationSubscription(env, {
      login: "miner",
      channel: "email",
      destination: "miner@example.com",
      status: "active",
    });
    const created = await evaluateNotificationEvent(env, event());
    expect(created.map((delivery) => delivery.channel)).toEqual(["badge"]);
  });

  it("suppresses deliveries beyond the per-recipient rate-limit window", async () => {
    const env = createTestEnv();
    for (let index = 0; index < NOTIFICATION_RATE_LIMIT.maxPerWindow; index += 1) {
      await insertNotificationDeliveryIfAbsent(env, {
        dedupKey: `prefill-${index}`,
        channel: "badge",
        recipientLogin: "miner",
        eventType: "pull_request_changes_requested",
        repoFullName: "owner/repo",
        pullNumber: index,
        title: "t",
        body: "b",
        deeplink: "https://x",
        actorLogin: "reviewer",
        status: "delivered",
      });
    }
    const created = await evaluateNotificationEvent(env, event({ dedupKey: "over-limit" }));
    expect(created).toEqual([]);
    const rows = await listNotificationDeliveriesForRecipient(env, "miner");
    expect(rows.find((row) => row.dedupKey === "over-limit")?.status).toBe("suppressed");
  });
});

describe("deliverNotification", () => {
  it("transitions a pending badge delivery to delivered and is a no-op otherwise", async () => {
    const env = createTestEnv();
    const [pending] = await evaluateNotificationEvent(env, event());
    await deliverNotification(env, pending!.id);
    expect((await getNotificationDeliveryById(env, pending!.id))?.status).toBe("delivered");

    // Re-delivering an already-delivered row and an unknown id are both no-ops.
    await deliverNotification(env, pending!.id);
    await deliverNotification(env, "does-not-exist");
    expect((await getNotificationDeliveryById(env, pending!.id))?.status).toBe("delivered");
  });

  it("coalesces pending email deliveries into one outbound send and marks the whole bundle delivered", async () => {
    const sent: Array<{ to: string; subject: string; text?: string }> = [];
    const env = createTestEnv({
      EMAIL: {
        async send(message: { to: string; subject: string; text?: string }) {
          sent.push(message);
          return { messageId: `msg-${sent.length}` };
        },
      } as unknown as SendEmail,
    });
    await upsertDigestSubscription(env, { login: "miner", email: "miner@example.com" });
    const [firstBadge, firstEmail] = await evaluateNotificationEvent(env, event({ dedupKey: "email-a" }));
    const [secondBadge, secondEmail] = await evaluateNotificationEvent(env, event({ dedupKey: "email-b", pullNumber: 8, deeplink: "https://github.com/owner/repo/pull/8" }));
    expect(firstBadge?.channel).toBe("badge");
    expect(secondBadge?.channel).toBe("badge");

    await deliverNotification(env, firstEmail!.id);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "miner@example.com" });
    expect(sent[0]?.subject).toContain("2 updates");
    expect(sent[0]?.text).toContain("owner/repo#7");
    expect(sent[0]?.text).toContain("owner/repo#8");
    expect((await getNotificationDeliveryById(env, firstEmail!.id))?.status).toBe("delivered");
    expect((await getNotificationDeliveryById(env, secondEmail!.id))?.status).toBe("delivered");
    expect((await getNotificationDeliveryById(env, firstBadge!.id))?.status).toBe("pending");
    expect((await getNotificationDeliveryById(env, secondBadge!.id))?.status).toBe("pending");

    await deliverNotification(env, secondEmail!.id);
    expect(sent).toHaveLength(1);
  });

  it("does not claim sibling pending email deliveries when the anchor no longer has a destination", async () => {
    const env = createTestEnv();
    await upsertDigestSubscription(env, { login: "miner", email: "miner@example.com" });
    const [, firstEmail] = await evaluateNotificationEvent(env, event({ dedupKey: "no-destination-a" }));
    const [, secondEmail] = await evaluateNotificationEvent(env, event({ dedupKey: "no-destination-b", pullNumber: 8, deeplink: "https://github.com/owner/repo/pull/8" }));
    await upsertNotificationSubscription(env, { login: "miner", channel: "email", status: "paused" });

    await deliverNotification(env, firstEmail!.id);

    expect((await getNotificationDeliveryById(env, firstEmail!.id))?.status).toBe("delivered");
    expect((await getNotificationDeliveryById(env, secondEmail!.id))?.status).toBe("pending");
  });

  it("reports whether email delivery is runtime-configured", () => {
    expect(notificationEmailDeliveryEnabled(createTestEnv())).toBe(true);
    const unconfigured = createTestEnv();
    delete unconfigured.EMAIL;
    delete unconfigured.NOTIFICATION_FROM_EMAIL;
    expect(notificationEmailDeliveryEnabled(unconfigured)).toBe(false);
  });

  it("fails closed with notification_email_unconfigured when a malformed email binding slips through", async () => {
    const env = createTestEnv({ EMAIL: {} as SendEmail });
    await upsertNotificationSubscription(env, {
      login: "miner",
      channel: "email",
      destination: "miner@example.com",
      status: "active",
    });
    const [, emailDelivery] = await evaluateNotificationEvent(env, event({ dedupKey: "explicit-email" }));
    expect(emailDelivery).toBeUndefined();

    const writableEnv = createTestEnv({ EMAIL: {} as SendEmail });
    await upsertNotificationSubscription(writableEnv, {
      login: "miner",
      channel: "email",
      destination: "miner@example.com",
      status: "active",
    });
    const pendingEmail = await insertNotificationDeliveryIfAbsent(writableEnv, {
      dedupKey: "manual-email",
      channel: "email",
      recipientLogin: "miner",
      eventType: "pull_request_changes_requested",
      repoFullName: "owner/repo",
      pullNumber: 7,
      title: "t",
      body: "b",
      deeplink: "https://x",
      actorLogin: "reviewer",
      status: "pending",
    });
    await expect(deliverNotification(writableEnv, pendingEmail.delivery.id)).rejects.toThrow("notification_email_unconfigured");
    expect((await getNotificationDeliveryById(writableEnv, pendingEmail.delivery.id))?.status).toBe("pending");
  });
});

describe("notification queue wiring", () => {
  it("runs evaluate -> deliver end-to-end through processJob and stays idempotent", async () => {
    const enqueued: Array<{ type: string; deliveryId?: string }> = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: { type: string; deliveryId?: string }) {
          enqueued.push(message);
        },
      } as unknown as Queue,
    });

    await processJob(env, { type: "notify-evaluate", requestedBy: "test", event: event() });
    const deliverJob = enqueued.find((message) => message.type === "notify-deliver");
    expect(deliverJob?.deliveryId).toBeTruthy();

    await processJob(env, { type: "notify-deliver", requestedBy: "test", deliveryId: deliverJob!.deliveryId! });
    const delivered = await listNotificationDeliveriesForRecipient(env, "miner", { unreadOnly: true });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.status).toBe("delivered");

    // A retried evaluate (same event) enqueues no further deliver jobs.
    const before = enqueued.length;
    await processJob(env, { type: "notify-evaluate", requestedBy: "test", event: event() });
    expect(enqueued.length).toBe(before);
  });
});

describe("notification repository helpers", () => {
  it("upserts a subscription, lists it, and updates on conflict", async () => {
    const env = createTestEnv();
    const first = await upsertNotificationSubscription(env, { login: "Miner", channel: "badge" });
    expect(first).toMatchObject({ login: "miner", channel: "badge", status: "active" });

    const paused = await upsertNotificationSubscription(env, { login: "Miner", channel: "badge", status: "paused" });
    expect(paused.status).toBe("paused");

    const subs = await listNotificationSubscriptionsForLogin(env, "miner");
    expect(subs).toHaveLength(1);
    expect(subs[0]?.status).toBe("paused");
  });

  it("normalizes digest subscriptions to lowercase login lookups", async () => {
    const env = createTestEnv();
    await upsertDigestSubscription(env, { login: "Miner", email: "Operator@Example.com" });
    const subs = await listDigestSubscriptionsForLogin(env, "miner");
    expect(subs).toMatchObject([{ login: "miner", email: "operator@example.com" }]);
  });

  it("marks a recipient's delivered notifications read, optionally by id, scoped to the recipient", async () => {
    const env = createTestEnv();
    const [first] = await evaluateNotificationEvent(env, event({ dedupKey: "a" }));
    const [second] = await evaluateNotificationEvent(env, event({ dedupKey: "b", pullNumber: 8 }));
    await deliverNotification(env, first!.id);
    await deliverNotification(env, second!.id);

    // Empty ids selects no specific notifications.
    expect(await markNotificationDeliveriesRead(env, "miner", [])).toBe(0);
    expect((await getNotificationDeliveryById(env, first!.id))?.status).toBe("delivered");
    expect((await getNotificationDeliveryById(env, second!.id))?.status).toBe("delivered");

    // Mark only the first by id.
    expect(await markNotificationDeliveriesRead(env, "miner", [first!.id])).toBe(1);
    expect((await getNotificationDeliveryById(env, first!.id))?.status).toBe("read");
    expect((await getNotificationDeliveryById(env, second!.id))?.status).toBe("delivered");

    // Mark the rest (no ids = all delivered).
    expect(await markNotificationDeliveriesRead(env, "miner")).toBe(1);
    expect(await markNotificationDeliveriesRead(env, "other-login")).toBe(0);

    const feed = buildNotificationFeed("miner", await listNotificationDeliveriesForRecipient(env, "miner"));
    expect(feed.unreadCount).toBe(0);
  });

  it("rejects oversized mark-read id filters before building SQL", async () => {
    const env = createTestEnv();
    await expect(
      markNotificationDeliveriesRead(
        env,
        "miner",
        Array.from({ length: MAX_NOTIFICATION_MARK_READ_IDS + 1 }, (_, index) => `id-${index}`),
      ),
    ).rejects.toThrow(/at most/);
    await expect(markNotificationDeliveriesRead(env, "miner", ["x".repeat(MAX_NOTIFICATION_DELIVERY_ID_LENGTH + 1)])).rejects.toThrow(
      /at most/,
    );
  });

  it("returns null for an unknown delivery id", async () => {
    const env = createTestEnv();
    expect(await getNotificationDeliveryById(env, "missing")).toBeNull();
  });
});
