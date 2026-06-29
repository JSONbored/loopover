import { describe, expect, it, vi } from "vitest";
import {
  githubRateLimitRetryDelayMs,
  jobCoalesceKey,
  jobPriority,
  nonConsumingRetryDelayMs,
} from "../../src/selfhost/queue-common";
import { RetryableJobError } from "../../src/queue/retryable";

const payload = (value: unknown): string => JSON.stringify(value);

describe("self-host queue common helpers", () => {
  it("classifies job priority by job type and webhook sender", () => {
    expect(jobPriority(payload({ type: "github-webhook" }))).toBe(10);
    expect(jobPriority(payload({ type: "agent-regate-pr" }))).toBe(9);
    expect(jobPriority(payload({ type: "recapture-preview" }))).toBe(9);
    expect(jobPriority(payload({ type: "agent-regate-sweep" }))).toBe(8);
    expect(jobPriority(payload({ type: "rag-index-repo" }))).toBe(0);
    expect(jobPriority("{}")).toBe(0);
    expect(jobPriority("not-json")).toBe(0);
  });

  it("demotes bot-authored issue-comment edit webhooks without demoting human reruns", () => {
    const issueCommentEdit = (sender: { login?: string; type?: string }) =>
      payload({
        type: "github-webhook",
        eventName: "issue_comment",
        payload: { action: "edited", sender },
      });
    expect(
      jobPriority(issueCommentEdit({ login: "gittensory-orb[bot]", type: "Bot" })),
    ).toBe(0);
    expect(
      jobPriority(issueCommentEdit({ login: "codecov[bot]", type: "User" })),
    ).toBe(0);
    expect(
      jobPriority(issueCommentEdit({ login: "jsonbored", type: "User" })),
    ).toBe(10);
    expect(
      jobPriority(
        payload({
          type: "github-webhook",
          eventName: "issue_comment",
          payload: { action: "created", sender: { login: "codecov[bot]" } },
        }),
      ),
    ).toBe(10);
  });

  it("fails closed when a malformed webhook payload reaches priority parsing", () => {
    const raw = payload({ type: "github-webhook" });
    const parse = vi.spyOn(JSON, "parse");
    parse
      .mockImplementationOnce(() => ({ type: "github-webhook" }))
      .mockImplementationOnce(() => {
        throw new Error("malformed webhook payload");
      });

    expect(jobPriority(raw)).toBe(0);
    parse.mockRestore();
  });

  it("coalesces CI-completion webhooks with sorted pull numbers", () => {
    expect(
      jobCoalesceKey(
        payload({
          type: "github-webhook",
          eventName: "check_suite",
          payload: {
            action: "completed",
            repository: { full_name: "JSONbored/Gittensory" },
            check_suite: {
              head_sha: "abc1234",
              pull_requests: [{ number: 12 }, { number: 3 }, { number: 7 }],
            },
          },
        }),
      ),
    ).toBe("github-webhook:ci-completed:jsonbored/gittensory@abc1234#3,7,12");
  });

  it("returns no coalesce key for malformed payloads", () => {
    expect(jobCoalesceKey("not-json")).toBeNull();
  });

  it("extracts retry delays from GitHub rate-limit errors", () => {
    expect(githubRateLimitRetryDelayMs(null)).toBeNull();
    expect(githubRateLimitRetryDelayMs({ status: 403, message: "Forbidden" })).toBeNull();

    expect(
      githubRateLimitRetryDelayMs({
        status: 403,
        message: "secondary rate limit",
      }),
    ).toBe(300_000);
    expect(
      githubRateLimitRetryDelayMs({
        status: 429,
        response: { headers: new Headers({ "retry-after": "2" }) },
      }),
    ).toBe(2_000);
    expect(
      githubRateLimitRetryDelayMs(
        {
          status: 403,
          response: {
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": "1003",
            },
          },
        },
        1_000_000,
      ),
    ).toBe(8_000);
  });

  it("extracts non-consuming retry delays from retryable job errors", () => {
    expect(nonConsumingRetryDelayMs(new Error("boom"))).toBeNull();
    expect(
      nonConsumingRetryDelayMs(
        new RetryableJobError("AI review pending", {
          retryAfterMs: 1234,
          retryKind: "ai_review_public_summary_missing",
        }),
      ),
    ).toBe(1234);
  });
});
