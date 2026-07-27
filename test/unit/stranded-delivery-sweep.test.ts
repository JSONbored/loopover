import { describe, expect, it, vi } from "vitest";
import {
  STRANDED_NOTIFICATION_GRACE_MS,
  STRANDED_NOTIFICATION_LOOKBACK_MS,
  STRANDED_NOTIFICATION_REQUEUE_INTERVAL_MS,
  sweepStrandedNotificationDeliveries,
} from "../../src/notifications/stranded-delivery-sweep";
import { createTestEnv } from "../helpers/d1";

function envWithQueue(): { env: Env; sent: unknown[] } {
  const sent: unknown[] = [];
  const env = createTestEnv();
  (env as unknown as { JOBS: { send: (msg: unknown) => Promise<void> } }).JOBS = {
    send: async (msg: unknown) => void sent.push(msg),
  };
  return { env, sent };
}

// Seeds a notification_deliveries row directly so its created_at (and status) can be chosen freely -- the
// repository insert always stamps created_at with the current wall clock, which the grace/lookback windows need
// to be controllable around.
async function seedDelivery(env: Env, opts: { id?: string; status?: string; createdAtMs: number }): Promise<string> {
  const id = opts.id ?? crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO notification_deliveries (id, dedup_key, channel, recipient_login, event_type, repo_full_name, pull_number, title, body, deeplink, actor_login, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      `dedup:${id}`,
      "badge",
      "miner",
      "pull_request_changes_requested",
      "owner/repo",
      7,
      "Changes requested on owner/repo#7",
      "A reviewer requested changes.",
      "https://github.com/owner/repo/pull/7",
      "reviewer",
      opts.status ?? "pending",
      new Date(opts.createdAtMs).toISOString(),
    )
    .run();
  return id;
}

// #9320: a notification_deliveries row committed BEFORE its notify-deliver enqueue is stranded at `pending`
// when that enqueue is lost (queue backpressure / a transient JOBS.send error). A client retry finds the row
// already exists (idempotent) and omits it, so no deliver job is ever re-sent and the notification is invisible
// to the recipient until the 90-day retention sweep silently deletes it. This sweep rescues it.
describe("sweepStrandedNotificationDeliveries (#9320)", () => {
  const PAST_GRACE = (now: number) => now - STRANDED_NOTIFICATION_GRACE_MS - 60_000;

  it("re-enqueues notify-deliver for a pending row older than the grace period", async () => {
    const { env, sent } = envWithQueue();
    const now = Date.now();
    const id = await seedDelivery(env, { createdAtMs: PAST_GRACE(now) });

    expect(await sweepStrandedNotificationDeliveries(env, now)).toEqual({ scanned: 1, requeued: 1 });
    expect(sent).toEqual([{ type: "notify-deliver", requestedBy: "notify-evaluate", deliveryId: id }]);
  });

  it("leaves a pending row still inside the grace period alone", async () => {
    const { env, sent } = envWithQueue();
    const now = Date.now();
    await seedDelivery(env, { createdAtMs: now - 1_000 });

    expect(await sweepStrandedNotificationDeliveries(env, now)).toEqual({ scanned: 0, requeued: 0 });
    expect(sent).toEqual([]);
  });

  it("does not re-enqueue a row that is no longer pending (already delivered in the interim)", async () => {
    const { env, sent } = envWithQueue();
    const now = Date.now();
    await seedDelivery(env, { status: "delivered", createdAtMs: PAST_GRACE(now) });

    expect(await sweepStrandedNotificationDeliveries(env, now)).toEqual({ scanned: 0, requeued: 0 });
    expect(sent).toEqual([]);
  });

  it("ignores rows older than the lookback window (already past rescuing by re-enqueue)", async () => {
    const { env, sent } = envWithQueue();
    const now = Date.now();
    await seedDelivery(env, { createdAtMs: now - STRANDED_NOTIFICATION_LOOKBACK_MS - 60_000 });

    expect(await sweepStrandedNotificationDeliveries(env, now)).toEqual({ scanned: 0, requeued: 0 });
    expect(sent).toEqual([]);
  });

  it("fails open on a DB read error, returning a zero result rather than throwing", async () => {
    const { env, sent } = envWithQueue();
    const repositories = await import("../../src/db/repositories");
    vi.spyOn(repositories, "listStrandedPendingNotificationDeliveries").mockRejectedValue(new Error("db down"));

    expect(await sweepStrandedNotificationDeliveries(env)).toEqual({ scanned: 0, requeued: 0 });
    expect(sent).toEqual([]);
    vi.restoreAllMocks();
  });

  it("does not rescue the same delivery every tick — a row stuck for another reason is retried periodically", async () => {
    const { env, sent } = envWithQueue();
    const now = Date.now();
    await seedDelivery(env, { createdAtMs: PAST_GRACE(now) });

    expect((await sweepStrandedNotificationDeliveries(env, now)).requeued).toBe(1);
    expect((await sweepStrandedNotificationDeliveries(env, now + 60_000)).requeued).toBe(0);
    // Past the interval it tries again, rather than giving up on a row that is genuinely still stranded.
    expect((await sweepStrandedNotificationDeliveries(env, now + STRANDED_NOTIFICATION_REQUEUE_INTERVAL_MS + 1_000)).requeued).toBe(1);
    expect(sent).toHaveLength(2);
  });

  it("does not count a rescue whose enqueue failed, and re-scans it on the next tick", async () => {
    const { env } = envWithQueue();
    const now = Date.now();
    await seedDelivery(env, { createdAtMs: PAST_GRACE(now) });
    (env as unknown as { JOBS: { send: () => Promise<void> } }).JOBS = { send: async () => Promise.reject(new Error("queue down")) };

    expect(await sweepStrandedNotificationDeliveries(env, now)).toEqual({ scanned: 1, requeued: 0 });
    // Nothing was recorded, so the next tick still sees it as un-rescued rather than believing it handled it.
    expect((await sweepStrandedNotificationDeliveries(env, now + 1_000)).scanned).toBe(1);
  });

  it("treats an unreadable rescue history as 'already rescued', so a broken ledger cannot cause a flood", async () => {
    const { env, sent } = envWithQueue();
    const now = Date.now();
    await seedDelivery(env, { createdAtMs: PAST_GRACE(now) });
    const repositories = await import("../../src/db/repositories");
    vi.spyOn(repositories, "countRecentAuditEventsForActorAndTarget").mockRejectedValue(new Error("audit read down"));

    expect(await sweepStrandedNotificationDeliveries(env, now)).toEqual({ scanned: 1, requeued: 0 });
    expect(sent).toEqual([]);
    vi.restoreAllMocks();
  });

  it("counts the rescue even when the follow-up audit write fails", async () => {
    const { env, sent } = envWithQueue();
    const now = Date.now();
    await seedDelivery(env, { createdAtMs: PAST_GRACE(now) });
    const repositories = await import("../../src/db/repositories");
    vi.spyOn(repositories, "recordAuditEvent").mockRejectedValue(new Error("audit write down"));

    // The job WAS enqueued, which is the part that rescues the delivery; losing the bookkeeping row must not undo it.
    expect((await sweepStrandedNotificationDeliveries(env, now)).requeued).toBe(1);
    expect(sent).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it("defaults nowMs to the current wall clock when the caller omits it", async () => {
    const { env, sent } = envWithQueue();
    await seedDelivery(env, { createdAtMs: PAST_GRACE(Date.now()) });

    expect((await sweepStrandedNotificationDeliveries(env)).requeued).toBe(1);
    expect(sent).toHaveLength(1);
  });
});
