import { afterEach, describe, expect, it, vi } from "vitest";
import { detectNotificationEvents } from "../../src/notifications/events";
import { NOTIFY_DELIVER_SEND_CONCURRENCY, processJob } from "../../src/queue/job-dispatch";
import { createTestEnv } from "../helpers/d1";
import type { DetectedNotificationEvent, GitHubWebhookPayload } from "../../src/types";

const basePayload: GitHubWebhookPayload = {
  action: "submitted",
  repository: { name: "loopover", full_name: "JSONbored/loopover", owner: { login: "JSONbored" } },
  pull_request: {
    number: 42,
    title: "Add feature",
    state: "open",
    user: { login: "contributor", type: "User" },
    html_url: "https://github.com/JSONbored/loopover/pull/42",
  },
  review: {
    state: "changes_requested",
    user: { login: "maintainer", type: "User" },
    submitted_at: "2026-05-28T12:00:00.000Z",
    html_url: "https://github.com/JSONbored/loopover/pull/42#pullrequestreview-1",
  },
  sender: { login: "maintainer", type: "User" },
};

describe("detectNotificationEvents", () => {
  it("emits one changes-requested event for the PR author", () => {
    const events = detectNotificationEvents("pull_request_review", basePayload, "2026-05-28T12:00:01.000Z");

    expect(events).toEqual([
      {
        eventType: "pull_request_changes_requested",
        recipientLogin: "contributor",
        repoFullName: "JSONbored/loopover",
        pullNumber: 42,
        dedupKey: "changes_requested:JSONbored/loopover#42:maintainer:2026-05-28T12:00:00.000Z",
        deeplink: "https://github.com/JSONbored/loopover/pull/42#pullrequestreview-1",
        actorLogin: "maintainer",
        detectedAt: "2026-05-28T12:00:01.000Z",
      },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/trust score|wallet|hotkey|reward estimate|reviewability/i);
  });

  it("accepts edited review actions and ignores non-changes-requested states", () => {
    expect(detectNotificationEvents("pull_request_review", { ...basePayload, action: "edited" }, "2026-05-28T12:00:01.000Z")).toHaveLength(1);
    expect(
      detectNotificationEvents(
        "pull_request_review",
        { ...basePayload, review: { ...basePayload.review, state: "approved" } },
        "2026-05-28T12:00:01.000Z",
      ),
    ).toEqual([]);
    expect(detectNotificationEvents("pull_request_review", { ...basePayload, action: "dismissed" }, "2026-05-28T12:00:01.000Z")).toEqual([]);
  });

  it("ignores unrelated webhook events and incomplete payloads", () => {
    expect(detectNotificationEvents("pull_request", basePayload)).toEqual([]);
    expect(detectNotificationEvents("pull_request_review", { ...basePayload, pull_request: undefined as never })).toEqual([]);
    expect(detectNotificationEvents("pull_request_review", { ...basePayload, review: undefined as never })).toEqual([]);
  });

  it("suppresses self-notifications and bot-authored reviews", () => {
    expect(
      detectNotificationEvents("pull_request_review", {
        ...basePayload,
        review: { ...basePayload.review, user: { login: "contributor", type: "User" } },
        sender: { login: "contributor", type: "User" },
      }),
    ).toEqual([]);
    expect(
      detectNotificationEvents("pull_request_review", {
        ...basePayload,
        review: { ...basePayload.review, user: { login: "Contributor", type: "User" } },
        sender: { login: " CONTRIBUTOR ", type: "User" },
      }),
    ).toEqual([]);
    expect(
      detectNotificationEvents("pull_request_review", {
        ...basePayload,
        review: { ...basePayload.review, user: { login: "dependabot[bot]", type: "Bot" } },
        sender: { login: "dependabot[bot]", type: "Bot" },
      }),
    ).toEqual([]);
    expect(
      detectNotificationEvents("pull_request_review", {
        ...basePayload,
        pull_request: { ...basePayload.pull_request!, user: { login: "dependabot[bot]", type: "Bot" } },
      }),
    ).toEqual([]);
    expect(
      detectNotificationEvents("pull_request_review", {
        ...basePayload,
        review: undefined as never,
        sender: { login: "github-actions[bot]", type: "Bot" },
      }),
    ).toEqual([]);
  });

  it("falls back to sender login, generated deeplink, and detectedAt when review metadata is sparse", () => {
    const events = detectNotificationEvents(
      "pull_request_review",
      {
        action: "submitted",
        repository: { name: "loopover", full_name: "JSONbored/loopover", owner: { login: "JSONbored" } },
        pull_request: {
          number: 7,
          title: "Sparse review",
          state: "open",
          user: { login: "contributor", type: "User" },
        },
        review: {
          state: "changes_requested",
        },
      },
      "2026-05-28T13:00:00.000Z",
    );

    expect(events).toEqual([
      {
        eventType: "pull_request_changes_requested",
        recipientLogin: "contributor",
        repoFullName: "JSONbored/loopover",
        pullNumber: 7,
        dedupKey: "changes_requested:JSONbored/loopover#7:unknown:2026-05-28T13:00:00.000Z",
        deeplink: "https://github.com/JSONbored/loopover/pull/7",
        actorLogin: "unknown",
        detectedAt: "2026-05-28T13:00:00.000Z",
      },
    ]);
  });

  it("uses sender login when review.user is absent", () => {
    const events = detectNotificationEvents(
      "pull_request_review",
      {
        ...basePayload,
        review: {
          state: "changes_requested",
          submitted_at: "2026-05-28T12:00:00.000Z",
        },
        sender: { login: "maintainer", type: "User" },
      },
      "2026-05-28T12:00:01.000Z",
    );

    expect(events[0]?.actorLogin).toBe("maintainer");
    expect(events[0]?.dedupKey).toContain(":maintainer:");
  });

  it("returns no events when repository or author metadata is missing", () => {
    expect(
      detectNotificationEvents("pull_request_review", {
        ...basePayload,
        repository: undefined as never,
      }),
    ).toEqual([]);
    expect(
      detectNotificationEvents("pull_request_review", {
        ...basePayload,
        pull_request: { ...basePayload.pull_request!, user: undefined as never },
      }),
    ).toEqual([]);
  });
});

describe("detectNotificationEvents — merged PR (#702)", () => {
  const mergedPayload: GitHubWebhookPayload = {
    action: "closed",
    repository: { name: "loopover", full_name: "JSONbored/loopover", owner: { login: "JSONbored" } },
    pull_request: {
      number: 42,
      title: "Add feature",
      state: "closed",
      user: { login: "contributor", type: "User" },
      html_url: "https://github.com/JSONbored/loopover/pull/42",
      merged_at: "2026-05-29T00:00:00.000Z",
    },
  };

  it("emits one self-attributed merged event for the PR author", () => {
    const events = detectNotificationEvents("pull_request", mergedPayload, "2026-05-29T00:00:01.000Z");
    expect(events).toEqual([
      {
        eventType: "pull_request_merged",
        recipientLogin: "contributor",
        repoFullName: "JSONbored/loopover",
        pullNumber: 42,
        dedupKey: "pull_request_merged:JSONbored/loopover#42:2026-05-29T00:00:00.000Z",
        deeplink: "https://github.com/JSONbored/loopover/pull/42",
        actorLogin: "contributor",
        detectedAt: "2026-05-29T00:00:01.000Z",
      },
    ]);
  });

  it("ignores a close-without-merge, a bot author, and missing author metadata", () => {
    expect(detectNotificationEvents("pull_request", { ...mergedPayload, pull_request: { ...mergedPayload.pull_request!, merged_at: null } })).toEqual([]);
    expect(detectNotificationEvents("pull_request", { ...mergedPayload, action: "opened" })).toEqual([]);
    expect(detectNotificationEvents("pull_request", { ...mergedPayload, pull_request: { ...mergedPayload.pull_request!, user: { login: "bot", type: "Bot" } } })).toEqual([]);
    expect(detectNotificationEvents("pull_request", { ...mergedPayload, pull_request: { ...mergedPayload.pull_request!, user: undefined as never } })).toEqual([]);
  });

  it("falls back to the canonical PR URL when html_url is absent", () => {
    const events = detectNotificationEvents("pull_request", { ...mergedPayload, pull_request: { ...mergedPayload.pull_request!, html_url: undefined as never } }, "2026-05-29T00:00:01.000Z");
    expect(events[0]?.deeplink).toBe("https://github.com/JSONbored/loopover/pull/42");
  });
});

function detectedEvent(overrides: Partial<DetectedNotificationEvent> = {}): DetectedNotificationEvent {
  const login = overrides.recipientLogin ?? "miner-1";
  return {
    eventType: "pull_request_changes_requested",
    recipientLogin: login,
    repoFullName: "owner/repo",
    pullNumber: 7,
    dedupKey: `changes_requested:owner/repo#7:reviewer:${login}`,
    deeplink: "https://github.com/owner/repo/pull/7",
    actorLogin: "reviewer",
    detectedAt: "2026-05-28T12:00:00.000Z",
    ...overrides,
  };
}

describe("processJob notify-evaluate deliver fan-out (#10022)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("attempts every OTHER delivery's send even when one rejects, and throws once naming it", async () => {
    let callIndex = 0;
    let failedDeliveryId: string | undefined;
    const sentDeliveryIds: string[] = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: unknown) {
          const deliveryId = (message as { deliveryId?: string }).deliveryId;
          const isSecondCall = callIndex === 1;
          callIndex += 1;
          if (deliveryId) sentDeliveryIds.push(deliveryId);
          if (isSecondCall) {
            failedDeliveryId = deliveryId;
            throw new Error("simulated transient queue-send failure");
          }
          return undefined;
        },
      } as unknown as Queue,
    });

    const errorLogs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errorLogs.push(String(args[0]));
    });

    const events = ["miner-1", "miner-2", "miner-3"].map((login) => detectedEvent({ recipientLogin: login }));
    let thrown: unknown;
    try {
      await processJob(env, { type: "notify-evaluate", requestedBy: "webhook", events });
    } catch (error) {
      thrown = error;
    }

    // Every delivery's send was attempted exactly once, regardless of the middle one's rejection.
    expect(sentDeliveryIds).toHaveLength(3);
    expect(failedDeliveryId).toBeDefined();
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/notify-evaluate deliver fan-out: 1\/3 delivery send\(s\) failed:/);
    expect((thrown as Error).message).toContain(failedDeliveryId);

    const failureLog = errorLogs.map((line) => JSON.parse(line) as Record<string, unknown>).find((log) => log.event === "notify_deliver_fanout_send_failed");
    expect(failureLog).toMatchObject({ level: "error", event: "notify_deliver_fanout_send_failed", deliveryId: failedDeliveryId });
  });

  it("never issues more concurrent sends than NOTIFY_DELIVER_SEND_CONCURRENCY", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const env = createTestEnv({
      JOBS: {
        async send() {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return undefined;
        },
      } as unknown as Queue,
    });

    const events = Array.from({ length: 12 }, (_, index) => detectedEvent({ recipientLogin: `miner-${index}` }));
    await expect(processJob(env, { type: "notify-evaluate", requestedBy: "webhook", events })).resolves.toBeUndefined();

    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(NOTIFY_DELIVER_SEND_CONCURRENCY);
  });

  it("does not throw and sends exactly one notify-deliver message per delivery when every send succeeds", async () => {
    const sent: Array<{ type: string; requestedBy: string; deliveryId: string }> = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: unknown) {
          sent.push(message as { type: string; requestedBy: string; deliveryId: string });
          return undefined;
        },
      } as unknown as Queue,
    });

    const errorLogs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errorLogs.push(String(args[0]));
    });

    const events = ["miner-1", "miner-2", "miner-3"].map((login) => detectedEvent({ recipientLogin: login }));
    await expect(processJob(env, { type: "notify-evaluate", requestedBy: "webhook", events })).resolves.toBeUndefined();

    expect(sent).toHaveLength(3);
    for (const message of sent) {
      expect(message).toMatchObject({ type: "notify-deliver", requestedBy: "notify-evaluate" });
      expect(typeof message.deliveryId).toBe("string");
    }
    expect(errorLogs.some((line) => line.includes("notify_deliver_fanout_send_failed"))).toBe(false);
  });

  it("does not throw when the batch resolves to zero deliveries", async () => {
    const sent: unknown[] = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: unknown) {
          sent.push(message);
          return undefined;
        },
      } as unknown as Queue,
    });

    await expect(processJob(env, { type: "notify-evaluate", requestedBy: "webhook", events: [] })).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
  });
});
