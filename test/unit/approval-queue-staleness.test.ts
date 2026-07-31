import { describe, expect, it, vi } from "vitest";
import {
  createPendingAgentActionIfAbsent,
  getPendingAgentAction,
  listAuditEventsForTarget,
  listNotificationDeliveriesForRecipient,
  listPendingAgentActions,
  setPendingAgentActionStatus,
} from "../../src/db/repositories";
import { sweepStaleApprovalQueue } from "../../src/services/agent-approval-queue";
import { APPROVAL_EXPIRY_MS, APPROVAL_REMINDER_INTERVAL_MS, planApprovalQueueMaintenance } from "../../src/services/agent-approval-staleness";
import { createTestEnv } from "../helpers/d1";

const DAY = 24 * 60 * 60 * 1000;

// #9032: stageForApproval returns early on `!created` and its badge dedup key is per (PR, actionClass) with no
// time component, so the maintainer was notified exactly ONCE, ever. A missed badge meant the staged action
// waited indefinitely with nothing anywhere saying so — the same absorbing-state shape as #9012's permanently
// merge-blocked PR. The decision half is pure and lives here.
describe("planApprovalQueueMaintenance (#9032)", () => {
  const staged = "2026-07-01T00:00:00.000Z";
  const stagedMs = Date.parse(staged);

  it("leaves a freshly staged row alone — the staging notification is still the only one needed", () => {
    expect(planApprovalQueueMaintenance(staged, stagedMs)).toEqual({ kind: "none" });
    expect(planApprovalQueueMaintenance(staged, stagedMs + APPROVAL_REMINDER_INTERVAL_MS - 1)).toEqual({ kind: "none" });
  });

  it("buckets reminders by interval, so the ~2-minute sweep collapses to one badge per interval", () => {
    expect(planApprovalQueueMaintenance(staged, stagedMs + APPROVAL_REMINDER_INTERVAL_MS)).toEqual({ kind: "remind", bucket: 1 });
    // Anywhere inside the same interval derives the SAME bucket → the same dedup key → one delivery.
    expect(planApprovalQueueMaintenance(staged, stagedMs + APPROVAL_REMINDER_INTERVAL_MS + 1000)).toEqual({ kind: "remind", bucket: 1 });
    expect(planApprovalQueueMaintenance(staged, stagedMs + 3 * APPROVAL_REMINDER_INTERVAL_MS)).toEqual({ kind: "remind", bucket: 3 });
  });

  it("expires rather than nagging forever once reminders have plainly not worked", () => {
    expect(planApprovalQueueMaintenance(staged, stagedMs + APPROVAL_EXPIRY_MS - 1)).toEqual({ kind: "remind", bucket: 6 });
    expect(planApprovalQueueMaintenance(staged, stagedMs + APPROVAL_EXPIRY_MS)).toEqual({ kind: "expire" });
    expect(planApprovalQueueMaintenance(staged, stagedMs + 90 * DAY)).toEqual({ kind: "expire" });
  });

  it("does nothing on an unparseable or future timestamp — a clock artifact must not destroy a real staged action", () => {
    expect(planApprovalQueueMaintenance("not-a-date", stagedMs)).toEqual({ kind: "none" });
    expect(planApprovalQueueMaintenance(staged, stagedMs - DAY)).toEqual({ kind: "none" });
  });

  it("orders the two thresholds so at least one reminder always precedes an expiry", () => {
    expect(APPROVAL_EXPIRY_MS).toBeGreaterThan(APPROVAL_REMINDER_INTERVAL_MS);
  });
});

describe("sweepStaleApprovalQueue (#9032)", () => {
  async function stage(env: Env, pullNumber: number): Promise<string> {
    const { action } = await createPendingAgentActionIfAbsent(env, {
      repoFullName: "alice/repo",
      pullNumber,
      installationId: 42,
      actionClass: "merge",
      autonomyLevel: "auto_with_approval",
      params: { mergeMethod: "squash" },
      reason: "clean and approved",
    });
    return action.id;
  }

  it("does nothing while every pending row is fresh", async () => {
    const env = createTestEnv();
    await stage(env, 1);
    expect(await sweepStaleApprovalQueue(env)).toEqual({ reminded: 0, expired: 0 });
    expect(await listNotificationDeliveriesForRecipient(env, "alice", { limit: 50 })).toHaveLength(0);
  });

  it("re-notifies a row the maintainer has left waiting, and only once per interval", async () => {
    const env = createTestEnv();
    const id = await stage(env, 2);
    const stagedAt = Date.parse((await getPendingAgentAction(env, id))!.createdAt);

    expect(await sweepStaleApprovalQueue(env, stagedAt + APPROVAL_REMINDER_INTERVAL_MS)).toEqual({ reminded: 1, expired: 0 });
    // The sweep runs every couple of minutes; a second pass inside the same interval must not re-badge.
    expect(await sweepStaleApprovalQueue(env, stagedAt + APPROVAL_REMINDER_INTERVAL_MS + 60_000)).toEqual({ reminded: 0, expired: 0 });
    // The next interval is a new bucket → a new badge, which is the point: one prompt was never enough.
    expect(await sweepStaleApprovalQueue(env, stagedAt + 2 * APPROVAL_REMINDER_INTERVAL_MS)).toEqual({ reminded: 1, expired: 0 });

    const deliveries = await listNotificationDeliveriesForRecipient(env, "alice", { limit: 50 });
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]?.title).toContain("Still waiting");
    expect(deliveries.every((delivery) => delivery.recipientLogin === "alice")).toBe(true);
  });

  it("#10025: a row aged past the reminder interval enqueues exactly one notify-deliver; a second sweep in the same bucket enqueues none", async () => {
    const env = createTestEnv();
    const sent: Array<{ type: string; deliveryId?: string }> = [];
    (env as unknown as { JOBS: { send: (msg: unknown) => Promise<void> } }).JOBS = { send: async (msg) => void sent.push(msg as { type: string; deliveryId?: string }) };
    const id = await stage(env, 3);
    const stagedAt = Date.parse((await getPendingAgentAction(env, id))!.createdAt);

    await sweepStaleApprovalQueue(env, stagedAt + APPROVAL_REMINDER_INTERVAL_MS);
    const notifyJobs = sent.filter((m) => m.type === "notify-deliver");
    expect(notifyJobs).toHaveLength(1);
    const reminder = (await listNotificationDeliveriesForRecipient(env, "alice", { limit: 50 })).find((d) => d.title.includes("Still waiting"));
    expect(notifyJobs[0]?.deliveryId).toBe(reminder?.id);

    // A second sweep inside the SAME reminder bucket hits the dedup (created:false) → no further enqueue.
    await sweepStaleApprovalQueue(env, stagedAt + APPROVAL_REMINDER_INTERVAL_MS + 60_000);
    expect(sent.filter((m) => m.type === "notify-deliver")).toHaveLength(1);
  });

  it("#10025: a rejected notify-deliver send is caught, warns, and the sweep still counts the reminder", async () => {
    const env = createTestEnv();
    (env as unknown as { JOBS: { send: (msg: unknown) => Promise<void> } }).JOBS = { send: async () => { throw new Error("queue down"); } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = await stage(env, 4);
    const stagedAt = Date.parse((await getPendingAgentAction(env, id))!.createdAt);
    expect(await sweepStaleApprovalQueue(env, stagedAt + APPROVAL_REMINDER_INTERVAL_MS)).toEqual({ reminded: 1, expired: 0 });
    expect(warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes("approval_notification_enqueue_failed"))).toBe(true);
    warn.mockRestore();
  });

  it("still writes a readable reminder for a row staged without a reason", async () => {
    const env = createTestEnv();
    const { action } = await createPendingAgentActionIfAbsent(env, {
      repoFullName: "alice/repo",
      pullNumber: 20,
      installationId: 42,
      actionClass: "close",
      autonomyLevel: "auto_with_approval",
      params: {},
      reason: null,
    });
    const stagedAt = Date.parse(action.createdAt);

    expect(await sweepStaleApprovalQueue(env, stagedAt + APPROVAL_REMINDER_INTERVAL_MS)).toEqual({ reminded: 1, expired: 0 });
    const [delivery] = await listNotificationDeliveriesForRecipient(env, "alice", { limit: 5 });
    expect(delivery?.body).toContain("A staged action");
    expect(delivery?.title).toContain("1 day ago");
  });

  it("records the audit trail even when the audit write itself fails", async () => {
    const env = createTestEnv();
    const id = await stage(env, 21);
    const stagedAt = Date.parse((await getPendingAgentAction(env, id))!.createdAt);
    const original = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((query: string) => {
      if (query.includes("audit_events")) throw new Error("audit write failed");
      return original(query);
    });

    // The expiry itself must still stand — the audit row is a record of it, not a precondition for it.
    expect(await sweepStaleApprovalQueue(env, stagedAt + APPROVAL_EXPIRY_MS)).toEqual({ reminded: 0, expired: 1 });
    vi.restoreAllMocks();
    expect((await getPendingAgentAction(env, id))?.status).toBe("expired");
  });

  it("expires a row nobody ever decided, records it, and executes nothing", async () => {
    const env = createTestEnv();
    const id = await stage(env, 3);
    const stagedAt = Date.parse((await getPendingAgentAction(env, id))!.createdAt);

    expect(await sweepStaleApprovalQueue(env, stagedAt + APPROVAL_EXPIRY_MS)).toEqual({ reminded: 0, expired: 1 });

    const row = await getPendingAgentAction(env, id);
    // Expiry is NOT a rejection: a rejection is a maintainer's judgment and feeds the trust loop as such.
    expect({ status: row?.status, decidedBy: row?.decidedBy }).toEqual({ status: "expired", decidedBy: "loopover" });
    const audits = await listAuditEventsForTarget(env, { repoFullName: "alice/repo", pullNumber: 3, limit: 50 });
    expect(audits.some((event) => event.eventType === "agent.pending_action.expired")).toBe(true);
  });

  it("is idempotent — an already-expired row is not swept again", async () => {
    const env = createTestEnv();
    const id = await stage(env, 4);
    const stagedAt = Date.parse((await getPendingAgentAction(env, id))!.createdAt);
    await sweepStaleApprovalQueue(env, stagedAt + APPROVAL_EXPIRY_MS);
    expect(await sweepStaleApprovalQueue(env, stagedAt + APPROVAL_EXPIRY_MS + DAY)).toEqual({ reminded: 0, expired: 0 });
  });

  it("never touches a row a maintainer already decided", async () => {
    const env = createTestEnv();
    const id = await stage(env, 5);
    await setPendingAgentActionStatus(env, id, { status: "accepted", decidedBy: "alice" });
    expect(await sweepStaleApprovalQueue(env, Date.now() + 90 * DAY)).toEqual({ reminded: 0, expired: 0 });
    expect((await getPendingAgentAction(env, id))?.status).toBe("accepted");
  });

  it("keeps going when one row's notification write fails — one repo must not stall the queue", async () => {
    const env = createTestEnv();
    await stage(env, 6);
    await stage(env, 7);
    const stagedAt = Date.parse((await listPendingAgentActions(env, { status: "pending" }))[0]!.createdAt);
    const original = env.DB.prepare.bind(env.DB);
    let failuresLeft = 1;
    vi.spyOn(env.DB, "prepare").mockImplementation((query: string) => {
      if (failuresLeft > 0 && query.includes("notification_deliveries")) {
        failuresLeft -= 1;
        throw new Error("write failed");
      }
      return original(query);
    });

    expect(await sweepStaleApprovalQueue(env, stagedAt + APPROVAL_REMINDER_INTERVAL_MS)).toEqual({ reminded: 1, expired: 0 });
    vi.restoreAllMocks();
  });

  it("survives a failed expiry claim without counting it", async () => {
    const env = createTestEnv();
    const id = await stage(env, 8);
    const stagedAt = Date.parse((await getPendingAgentAction(env, id))!.createdAt);
    const original = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((query: string) => {
      if (query.startsWith("update") && query.includes("agent_pending_actions")) throw new Error("claim failed");
      return original(query);
    });

    expect(await sweepStaleApprovalQueue(env, stagedAt + APPROVAL_EXPIRY_MS)).toEqual({ reminded: 0, expired: 0 });
    vi.restoreAllMocks();
    expect((await getPendingAgentAction(env, id))?.status).toBe("pending");
  });
});

// #9481 regression: the unique index on (repo_full_name, pull_number, action_class) has NO status predicate,
// and createPendingAgentActionIfAbsent used onConflictDoNothing against it. So once #9032's sweep expired a
// row, every later re-plan conflicted with it permanently -- `created: false`, so stageForApproval returned
// before notifying and decidePendingAgentAction reported already_decided. Nothing anywhere deleted or reopened
// an expired row, which made an auto_with_approval merge/close whose maintainer was away for the expiry window
// PERMANENTLY unexecutable via the queue for that PR + action class. That is strictly worse than the
// pre-#9032 behaviour (rows waited forever but stayed acceptable), and the sweep's own doc promises the
// opposite: "a later pass that re-plans the same action stages a fresh row with a fresh notification".
describe("re-staging after expiry (#9481)", () => {
  const stage = (env: Env, reason: string) =>
    createPendingAgentActionIfAbsent(env, {
      repoFullName: "acme/widgets",
      pullNumber: 42,
      installationId: 5,
      actionClass: "merge",
      autonomyLevel: "auto_with_approval",
      params: {},
      reason,
    });

  it("reopens an EXPIRED row so the action can be staged again", async () => {
    const env = createTestEnv();
    const first = await stage(env, "original reason");
    expect(first.created).toBe(true);

    await setPendingAgentActionStatus(env, first.action.id, { status: "expired", decidedBy: "system" });
    expect((await getPendingAgentAction(env, first.action.id))?.status).toBe("expired");

    const restaged = await stage(env, "re-planned reason");
    // `created: true` is what makes the caller notify -- without it the maintainer is never told.
    expect(restaged.created).toBe(true);
    expect(restaged.action.status).toBe("pending");
    expect(restaged.action.reason).toBe("re-planned reason");
    // Reopened in place, so the unique index is still satisfied and there is exactly one row for the target.
    expect(restaged.action.id).toBe(first.action.id);
    expect((await listPendingAgentActions(env, { repoFullName: "acme/widgets" })).length).toBe(1);
  });

  it("clears the prior decision metadata when reopening, so the row does not look already-decided", async () => {
    const env = createTestEnv();
    const first = await stage(env, "original");
    await setPendingAgentActionStatus(env, first.action.id, { status: "expired", decidedBy: "sweeper" });

    const restaged = await stage(env, "re-planned");
    expect(restaged.action.decidedBy).toBeNull();
    expect(restaged.action.decidedAt).toBeNull();
  });

  it("INVARIANT: a PENDING row stays sticky — a re-plan must not reset a decision that is still outstanding", async () => {
    const env = createTestEnv();
    const first = await stage(env, "original");
    const second = await stage(env, "should not overwrite");

    expect(second.created).toBe(false);
    expect(second.action.id).toBe(first.action.id);
    expect(second.action.reason).toBe("original");
  });

  it.each([["accepted"], ["rejected"]] as const)(
    "INVARIANT: a %s row stays terminal — only expiry reopens",
    async (status) => {
      const env = createTestEnv();
      const first = await stage(env, "original");
      await setPendingAgentActionStatus(env, first.action.id, { status, decidedBy: "maintainer" });

      const restaged = await stage(env, "re-planned");
      expect(restaged.created).toBe(false);
      expect(restaged.action.status).toBe(status);
      expect(restaged.action.reason).toBe("original");
    },
  );

  it("reopens with a null reason when the re-plan supplies none", async () => {
    const env = createTestEnv();
    const first = await stage(env, "original");
    await setPendingAgentActionStatus(env, first.action.id, { status: "expired", decidedBy: "system" });
    const restaged = await createPendingAgentActionIfAbsent(env, {
      repoFullName: "acme/widgets",
      pullNumber: 42,
      installationId: 5,
      actionClass: "merge",
      autonomyLevel: "auto_with_approval",
      params: {},
    });
    expect(restaged.created).toBe(true);
    expect(restaged.action.reason).toBeNull();
  });

  it("a reopened row can be expired and reopened again (no one-shot recovery)", async () => {
    const env = createTestEnv();
    const first = await stage(env, "one");
    await setPendingAgentActionStatus(env, first.action.id, { status: "expired", decidedBy: "system" });
    expect((await stage(env, "two")).created).toBe(true);
    await setPendingAgentActionStatus(env, first.action.id, { status: "expired", decidedBy: "system" });
    expect((await stage(env, "three")).created).toBe(true);
  });
});
