import { describe, expect, it } from "vitest";
import { detectNotificationEvents } from "../../src/notifications/events";
import type { GitHubWebhookPayload } from "../../src/types";

const basePayload: GitHubWebhookPayload = {
  action: "submitted",
  repository: { name: "gittensory", full_name: "JSONbored/gittensory", owner: { login: "JSONbored" } },
  pull_request: {
    number: 42,
    title: "Add feature",
    state: "open",
    user: { login: "contributor", type: "User" },
    html_url: "https://github.com/JSONbored/gittensory/pull/42",
  },
  review: {
    state: "changes_requested",
    user: { login: "maintainer", type: "User" },
    submitted_at: "2026-05-28T12:00:00.000Z",
    html_url: "https://github.com/JSONbored/gittensory/pull/42#pullrequestreview-1",
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
        repoFullName: "JSONbored/gittensory",
        pullNumber: 42,
        dedupKey: "changes_requested:JSONbored/gittensory#42:maintainer:2026-05-28T12:00:00.000Z",
        deeplink: "https://github.com/JSONbored/gittensory/pull/42#pullrequestreview-1",
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
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", owner: { login: "JSONbored" } },
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
        repoFullName: "JSONbored/gittensory",
        pullNumber: 7,
        dedupKey: "changes_requested:JSONbored/gittensory#7:unknown:2026-05-28T13:00:00.000Z",
        deeplink: "https://github.com/JSONbored/gittensory/pull/7",
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
