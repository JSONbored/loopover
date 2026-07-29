import { describe, expect, it } from "vitest";
import {
  AMS_PR_OUTCOME_DEDUP_KEY_PATTERN,
  buildAmsAttemptFailedEvent,
  buildAmsAttemptStartedEvent,
  buildAmsGovernorPausedEvent,
  buildAmsPrOutcomeEvent,
  isAmsNotificationEventType,
  normalizeAmsNotificationEventInput,
  parseAmsPrOutcomeDecision,
} from "../../src/notifications/ams-events";

describe("AMS notification event builders (#7657)", () => {
  it("builds attempt start/fail events with issue-number pullNumber overload", () => {
    const started = buildAmsAttemptStartedEvent({
      recipientLogin: "Miner",
      repoFullName: "acme/widgets",
      issueNumber: 42,
      attemptId: "a1",
      detectedAt: "2026-07-21T00:00:00.000Z",
    });
    expect(started).toMatchObject({
      eventType: "ams_attempt_started",
      recipientLogin: "miner",
      pullNumber: 42,
      dedupKey: "ams_attempt_started:acme/widgets#42:a1",
      deeplink: "https://github.com/acme/widgets/issues/42",
    });

    const failed = buildAmsAttemptFailedEvent({
      recipientLogin: "miner",
      repoFullName: "acme/widgets",
      issueNumber: 42,
      attemptId: "a1",
      reason: "abandon",
      detectedAt: "2026-07-21T00:00:00.000Z",
    });
    expect(failed.eventType).toBe("ams_attempt_failed");
    expect(failed.dedupKey).toContain(":abandon");
  });

  it("defaults detectedAt/reason/pausedAt when omitted (branch coverage)", () => {
    const started = buildAmsAttemptStartedEvent({
      recipientLogin: "miner",
      repoFullName: "acme/widgets",
      issueNumber: 1,
      attemptId: "a1",
    });
    expect(started.detectedAt).toEqual(expect.any(String));

    const failedNoReason = buildAmsAttemptFailedEvent({
      recipientLogin: "miner",
      repoFullName: "acme/widgets",
      issueNumber: 1,
      attemptId: "a1",
    });
    expect(failedNoReason.dedupKey).toBe("ams_attempt_failed:acme/widgets#1:a1");
    expect(failedNoReason.detectedAt).toEqual(expect.any(String));

    const pausedNoReasonOrPausedAt = buildAmsGovernorPausedEvent({ recipientLogin: "miner" });
    expect(pausedNoReasonOrPausedAt.dedupKey).toBe(`ams_governor_paused:miner:${pausedNoReasonOrPausedAt.detectedAt}`);

    const outcomeNoDetectedAt = buildAmsPrOutcomeEvent({
      recipientLogin: "miner",
      repoFullName: "acme/widgets",
      pullNumber: 9,
      decision: "merged",
    });
    expect(outcomeNoDetectedAt.detectedAt).toEqual(expect.any(String));
  });

  it("builds governor pause and pr-outcome events", () => {
    const paused = buildAmsGovernorPausedEvent({
      recipientLogin: "miner",
      reason: "ops",
      pausedAt: "2026-07-21T00:00:00.000Z",
    });
    expect(paused).toMatchObject({
      eventType: "ams_governor_paused",
      repoFullName: "ams/governor",
      pullNumber: 0,
    });

    const merged = buildAmsPrOutcomeEvent({
      recipientLogin: "miner",
      repoFullName: "acme/widgets",
      pullNumber: 9,
      decision: "merged",
      closedAt: "2026-07-21T01:00:00.000Z",
    });
    expect(merged.dedupKey).toContain(":merged:");
    expect(merged.deeplink).toContain("/pull/9");

    const closed = buildAmsPrOutcomeEvent({
      recipientLogin: "miner",
      repoFullName: "acme/widgets",
      pullNumber: 9,
      decision: "closed",
      closedAt: null,
      detectedAt: "2026-07-21T02:00:00.000Z",
    });
    expect(closed.dedupKey).toContain(":closed:");
  });

  it("#9703: parseAmsPrOutcomeDecision reads the decision from a well-formed dedupKey and null otherwise", () => {
    // The builder's own key round-trips through the parser for both decisions.
    const merged = buildAmsPrOutcomeEvent({ recipientLogin: "miner", repoFullName: "acme/widgets", pullNumber: 7, decision: "merged" });
    const closed = buildAmsPrOutcomeEvent({ recipientLogin: "miner", repoFullName: "acme/widgets", pullNumber: 7, decision: "closed" });
    expect(parseAmsPrOutcomeDecision(merged.dedupKey)).toBe("merged");
    expect(parseAmsPrOutcomeDecision(closed.dedupKey)).toBe("closed");
    expect(AMS_PR_OUTCOME_DEDUP_KEY_PATTERN.test(merged.dedupKey)).toBe(true);

    // Malformed keys: wrong prefix, no decision segment, an unknown decision, and the loose-substring trap where
    // ":merged:" appears somewhere other than the decision segment. All must parse to null, never a false merge.
    for (const bad of [
      "k",
      "ams_pr_outcome:acme/widgets#7", // truncated, no decision/closedAt
      "ams_pr_outcome:acme/widgets#7:reopened:2026-07-21T00:00:00.000Z", // unknown decision
      "other:acme/widgets#7:merged:2026-07-21T00:00:00.000Z", // wrong prefix
      "ams_pr_outcome:acme/widgets:merged:#7:2026", // no #<pullNumber> before the decision
    ]) {
      expect(parseAmsPrOutcomeDecision(bad)).toBeNull();
    }
  });

  it("#9703: normalizeAmsNotificationEventInput rejects an ams_pr_outcome whose dedupKey has no valid decision", () => {
    const base = {
      repoFullName: "acme/widgets",
      pullNumber: 7,
      deeplink: "https://example.com",
      actorLogin: "miner",
      detectedAt: "2026-07-21T00:00:00.000Z",
    };
    // A malformed ams_pr_outcome key would silently render as "closed without merge" -- rejected at ingest.
    expect(normalizeAmsNotificationEventInput({ ...base, eventType: "ams_pr_outcome", dedupKey: "ams_pr_outcome:no-decision" }, "miner")).toBeNull();
    // A well-formed one is accepted.
    const good = normalizeAmsNotificationEventInput(
      { ...base, eventType: "ams_pr_outcome", dedupKey: "ams_pr_outcome:acme/widgets#7:merged:2026-07-21T00:00:00.000Z" },
      "miner",
    );
    expect(good).not.toBeNull();
    // The ams_pr_outcome-only rule does not touch other AMS kinds: a loose dedupKey still passes for them.
    expect(normalizeAmsNotificationEventInput({ ...base, eventType: "ams_attempt_started", dedupKey: "k" }, "miner")).not.toBeNull();
  });

  it("normalizes ingest payloads and rejects non-AMS kinds", () => {
    expect(isAmsNotificationEventType("ams_attempt_started")).toBe(true);
    expect(isAmsNotificationEventType("pull_request_merged")).toBe(false);

    const ok = normalizeAmsNotificationEventInput(
      {
        eventType: "ams_attempt_started",
        repoFullName: "acme/widgets",
        pullNumber: 1,
        dedupKey: "k",
        deeplink: "https://example.com",
        actorLogin: "miner",
        detectedAt: "2026-07-21T00:00:00.000Z",
      },
      "Miner",
    );
    expect(ok?.recipientLogin).toBe("miner");

    expect(normalizeAmsNotificationEventInput(null, "miner")).toBeNull();
    expect(
      normalizeAmsNotificationEventInput(
        {
          eventType: "pull_request_merged",
          repoFullName: "acme/widgets",
          pullNumber: 1,
          dedupKey: "k",
          deeplink: "https://example.com",
          actorLogin: "miner",
          detectedAt: "2026-07-21T00:00:00.000Z",
        },
        "miner",
      ),
    ).toBeNull();
    expect(
      normalizeAmsNotificationEventInput(
        {
          eventType: "ams_attempt_started",
          repoFullName: "",
          pullNumber: 1,
          dedupKey: "k",
          deeplink: "https://example.com",
          actorLogin: "miner",
          detectedAt: "2026-07-21T00:00:00.000Z",
        },
        "miner",
      ),
    ).toBeNull();
    expect(
      normalizeAmsNotificationEventInput(
        {
          eventType: "ams_attempt_started",
          repoFullName: "acme/widgets",
          pullNumber: -1,
          dedupKey: "k",
          deeplink: "https://example.com",
          actorLogin: "miner",
          detectedAt: "2026-07-21T00:00:00.000Z",
        },
        "miner",
      ),
    ).toBeNull();
  });

  it("rejects each remaining malformed field independently (branch coverage)", () => {
    const valid = {
      eventType: "ams_attempt_started" as const,
      repoFullName: "acme/widgets",
      pullNumber: 1,
      dedupKey: "k",
      deeplink: "https://example.com",
      actorLogin: "miner",
      detectedAt: "2026-07-21T00:00:00.000Z",
    };
    expect(normalizeAmsNotificationEventInput([], "miner")).toBeNull(); // array, not an object
    expect(normalizeAmsNotificationEventInput({ ...valid, dedupKey: "" }, "miner")).toBeNull();
    expect(normalizeAmsNotificationEventInput({ ...valid, dedupKey: 1 }, "miner")).toBeNull();
    expect(normalizeAmsNotificationEventInput({ ...valid, deeplink: "" }, "miner")).toBeNull();
    expect(normalizeAmsNotificationEventInput({ ...valid, deeplink: 1 }, "miner")).toBeNull();
    expect(normalizeAmsNotificationEventInput({ ...valid, actorLogin: "" }, "miner")).toBeNull();
    expect(normalizeAmsNotificationEventInput({ ...valid, actorLogin: 1 }, "miner")).toBeNull();
    expect(normalizeAmsNotificationEventInput({ ...valid, detectedAt: "" }, "miner")).toBeNull();
    expect(normalizeAmsNotificationEventInput({ ...valid, detectedAt: 1 }, "miner")).toBeNull();
    expect(normalizeAmsNotificationEventInput({ ...valid, pullNumber: 1.5 }, "miner")).toBeNull(); // not an integer
    expect(normalizeAmsNotificationEventInput({ ...valid, repoFullName: 1 }, "miner")).toBeNull(); // not a string
  });
});
