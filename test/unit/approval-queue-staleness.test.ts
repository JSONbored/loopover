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
