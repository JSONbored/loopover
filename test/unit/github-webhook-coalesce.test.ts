import { describe, expect, it } from "vitest";
import { githubWebhookCoalesceKey } from "../../src/github/webhook-coalesce";
import type { GitHubWebhookPayload } from "../../src/types";

describe("githubWebhookCoalesceKey", () => {
  it("coalesces CI completions by repo, head sha, and sorted pull numbers", () => {
    expect(
      githubWebhookCoalesceKey("check_suite", {
        action: "completed",
        repository: { full_name: "JSONbored/Gittensory" },
        check_suite: {
          head_sha: "ABC1234",
          pull_requests: [{ number: 12 }, { number: 3 }, { number: 7 }],
        },
      } as never),
    ).toBe("github-webhook:ci-completed:jsonbored/gittensory@abc1234#3,7,12");

    expect(
      githubWebhookCoalesceKey("check_run", {
        action: "completed",
        repository: { full_name: "JSONbored/Gittensory" },
        check_run: { check_suite: { head_sha: "DEF5678" }, pull_requests: [] },
      } as never),
    ).toBe("github-webhook:ci-completed:jsonbored/gittensory@def5678");
  });

  it("coalesces gate-triggering pull request events and ignores non-actionable or terminal actions", () => {
    expect(
      githubWebhookCoalesceKey("pull_request", {
        action: "synchronize",
        repository: { full_name: "JSONbored/Gittensory" },
        number: 99,
        pull_request: {},
      } as never),
    ).toBe("github-webhook:pr-refresh:jsonbored/gittensory#99");
    expect(
      githubWebhookCoalesceKey("pull_request", {
        action: "opened",
        repository: { full_name: "JSONbored/Gittensory" },
        pull_request: { number: 100, head: { sha: "BEEF123" } },
      } as GitHubWebhookPayload),
    ).toBe("github-webhook:pr-refresh:jsonbored/gittensory#100@beef123");
    // "closed" is a terminal action -- merge/close has its own non-coalesced handling and must never collapse
    // with anything else. "labeled"/"unlabeled" now coalesce too (see the dedicated pr-label tests below) --
    // they are no longer in this "returns null" list.
    expect(
      githubWebhookCoalesceKey("pull_request", {
        action: "closed",
        repository: { full_name: "JSONbored/Gittensory" },
        pull_request: { number: 100, head: { sha: "BEEF123" } },
      } as GitHubWebhookPayload),
    ).toBeNull();
  });

  it("coalesces a burst of reopened + synchronize + ready_for_review events for the same PR head into one key (regression for #audit-rate-headroom)", () => {
    // "reopened" triggers the same file-refresh path as "opened"/"synchronize" (PR_PUBLIC_SURFACE_ACTIONS in
    // src/queue/processors.ts) but was missing from the coalescable set — a burst of reopen-adjacent events for
    // the same PR+head fanned out one `/pulls/{n}/files` fetch per delivery instead of coalescing into one job.
    const burstKeys = (["reopened", "synchronize", "ready_for_review"] as const).map((action) =>
      githubWebhookCoalesceKey("pull_request", {
        action,
        repository: { full_name: "JSONbored/Gittensory" },
        pull_request: { number: 100, head: { sha: "BEEF123" } },
      } as GitHubWebhookPayload),
    );
    expect(new Set(burstKeys).size).toBe(1);
    expect(burstKeys[0]).toBe("github-webhook:pr-refresh:jsonbored/gittensory#100@beef123");
  });

  it("returns null for malformed or non-coalescible webhook shapes", () => {
    expect(githubWebhookCoalesceKey("issues", { action: "closed", repository: { full_name: "JSONbored/Gittensory" } } as never)).toBeNull();
    expect(githubWebhookCoalesceKey("check_suite", { action: "requested", repository: { full_name: "JSONbored/Gittensory" } } as never)).toBeNull();
    expect(
      githubWebhookCoalesceKey("check_suite", {
        action: "completed",
        repository: { full_name: "JSONbored/Gittensory" },
        check_suite: { pull_requests: [{ number: 7 }] },
      } as never),
    ).toBeNull();
    expect(
      githubWebhookCoalesceKey("pull_request", {
        action: "edited",
        repository: { full_name: "JSONbored/Gittensory" },
        pull_request: { head: { sha: "BEEF123" } },
      } as GitHubWebhookPayload),
    ).toBeNull();
    expect(githubWebhookCoalesceKey("pull_request", { action: "edited" } as GitHubWebhookPayload)).toBeNull();
  });

  it("coalesces PR label churn (labeled/unlabeled) into one job per PR (#selfhost-backlog-convergence)", () => {
    for (const action of ["labeled", "unlabeled"]) {
      expect(
        githubWebhookCoalesceKey("pull_request", {
          action,
          repository: { full_name: "JSONbored/Gittensory" },
          pull_request: { number: 42, head: { sha: "BEEF123" } },
        } as GitHubWebhookPayload),
      ).toBe("github-webhook:pr-label:jsonbored/gittensory#42");
    }
    // A burst of add/remove churn on the same PR collapses to the identical key regardless of which label
    // action fired -- the handler re-syncs generically and doesn't act on the specific label.
    const burstKeys = ["labeled", "unlabeled", "labeled"].map((action) =>
      githubWebhookCoalesceKey("pull_request", {
        action,
        repository: { full_name: "JSONbored/Gittensory" },
        pull_request: { number: 42 },
      } as GitHubWebhookPayload),
    );
    expect(new Set(burstKeys).size).toBe(1);
  });

  it("falls back to the top-level number field for a label event missing pull_request.number", () => {
    expect(
      githubWebhookCoalesceKey("pull_request", {
        action: "labeled",
        repository: { full_name: "JSONbored/Gittensory" },
        pull_request: {},
        number: 55,
      } as unknown as GitHubWebhookPayload),
    ).toBe("github-webhook:pr-label:jsonbored/gittensory#55");
  });

  it("returns null for a label event with no resolvable PR number", () => {
    expect(
      githubWebhookCoalesceKey("pull_request", {
        action: "labeled",
        repository: { full_name: "JSONbored/Gittensory" },
      } as GitHubWebhookPayload),
    ).toBeNull();
  });

  it("does not coalesce pull_request_review events because their payloads drive invalidation and notifications", () => {
    for (const action of ["submitted", "edited", "dismissed"]) {
      expect(
        githubWebhookCoalesceKey("pull_request_review", {
          action,
          repository: { full_name: "JSONbored/Gittensory" },
          pull_request: { number: 12, head: { sha: "CAFE123" } },
        } as GitHubWebhookPayload),
      ).toBeNull();
    }
  });

  it("coalesces review-surface bursts (pull_request_review_comment) into one job per PR+head", () => {
    for (const action of ["created", "edited", "deleted"]) {
      expect(
        githubWebhookCoalesceKey("pull_request_review_comment", {
          action,
          repository: { full_name: "JSONbored/Gittensory" },
          pull_request: { number: 12, head: { sha: "CAFE123" } },
        } as GitHubWebhookPayload),
      ).toBe("github-webhook:pull_request_review_comment:jsonbored/gittensory#12@cafe123");
    }
  });

  it("coalesces review-surface bursts (pull_request_review_thread) into one job per PR+head", () => {
    for (const action of ["resolved", "unresolved"]) {
      expect(
        githubWebhookCoalesceKey("pull_request_review_thread", {
          action,
          repository: { full_name: "JSONbored/Gittensory" },
          pull_request: { number: 12, head: { sha: "CAFE123" } },
        } as GitHubWebhookPayload),
      ).toBe("github-webhook:pull_request_review_thread:jsonbored/gittensory#12@cafe123");
    }
  });

  it("keeps distinct review-surface event families separate so coalescing cannot drop review-only side effects", () => {
    const reviewKey = githubWebhookCoalesceKey("pull_request_review", {
      action: "submitted",
      repository: { full_name: "JSONbored/Gittensory" },
      pull_request: { number: 12, head: { sha: "CAFE123" } },
    } as GitHubWebhookPayload);
    const commentKey = githubWebhookCoalesceKey("pull_request_review_comment", {
      action: "created",
      repository: { full_name: "JSONbored/Gittensory" },
      pull_request: { number: 12, head: { sha: "CAFE123" } },
    } as GitHubWebhookPayload);
    const threadKey = githubWebhookCoalesceKey("pull_request_review_thread", {
      action: "resolved",
      repository: { full_name: "JSONbored/Gittensory" },
      pull_request: { number: 12, head: { sha: "CAFE123" } },
    } as GitHubWebhookPayload);

    expect(reviewKey).toBeNull();
    expect(commentKey).not.toBe(threadKey);
  });

  it("omits the head sha suffix for a review-surface event with no resolvable head", () => {
    expect(
      githubWebhookCoalesceKey("pull_request_review_comment", {
        action: "created",
        repository: { full_name: "JSONbored/Gittensory" },
        pull_request: { number: 12 },
      } as GitHubWebhookPayload),
    ).toBe("github-webhook:pull_request_review_comment:jsonbored/gittensory#12");
  });

  it("returns null for a review-surface event with no resolvable PR number", () => {
    expect(
      githubWebhookCoalesceKey("pull_request_review_comment", {
        action: "created",
        repository: { full_name: "JSONbored/Gittensory" },
      } as GitHubWebhookPayload),
    ).toBeNull();
  });

  it("returns null for a non-actionable action on a review-surface event type", () => {
    expect(
      githubWebhookCoalesceKey("pull_request_review", {
        action: "requested_changes_dismissed",
        repository: { full_name: "JSONbored/Gittensory" },
        pull_request: { number: 12, head: { sha: "CAFE123" } },
      } as GitHubWebhookPayload),
    ).toBeNull();
    expect(
      githubWebhookCoalesceKey("pull_request_review_comment", {
        action: "resolved",
        repository: { full_name: "JSONbored/Gittensory" },
        pull_request: { number: 12, head: { sha: "CAFE123" } },
      } as GitHubWebhookPayload),
    ).toBeNull();
    expect(
      githubWebhookCoalesceKey("pull_request_review_thread", {
        action: "created",
        repository: { full_name: "JSONbored/Gittensory" },
        pull_request: { number: 12, head: { sha: "CAFE123" } },
      } as GitHubWebhookPayload),
    ).toBeNull();
  });

  it("returns null for a review-surface event type with no matching entry (e.g. an unrelated event)", () => {
    expect(
      githubWebhookCoalesceKey("issue_comment", {
        action: "created",
        repository: { full_name: "JSONbored/Gittensory" },
        pull_request: { number: 12, head: { sha: "CAFE123" } },
      } as unknown as GitHubWebhookPayload),
    ).toBeNull();
  });
});
