import { describe, expect, it } from "vitest";
import { githubWebhookCoalesceDelaySeconds, githubWebhookCoalesceKey, PUSH_COALESCE_QUIET_WINDOW_SECONDS } from "../../src/github/webhook-coalesce";
import type { GitHubWebhookPayload } from "../../src/types";

describe("githubWebhookCoalesceKey", () => {
  it("coalesces CI completions by repo, head sha, and sorted pull numbers", () => {
    expect(
      githubWebhookCoalesceKey("check_suite", {
        action: "completed",
        repository: { full_name: "JSONbored/Loopover" },
        check_suite: {
          head_sha: "ABC1234",
          pull_requests: [{ number: 12 }, { number: 3 }, { number: 7 }],
        },
      } as never),
    ).toBe("github-webhook:ci-completed:jsonbored/loopover@abc1234#3,7,12");

    expect(
      githubWebhookCoalesceKey("check_run", {
        action: "completed",
        repository: { full_name: "JSONbored/Loopover" },
        check_run: { check_suite: { head_sha: "DEF5678" }, pull_requests: [] },
      } as never),
    ).toBe("github-webhook:ci-completed:jsonbored/loopover@def5678");
  });

  it("coalesces gate-triggering pull request events and ignores non-actionable or terminal actions", () => {
    // #9479: a push gets its OWN PR-scoped key, so consecutive pushes coalesce with each other rather than each
    // minting a distinct head-SHA key. See the dedicated pr-push tests below.
    expect(
      githubWebhookCoalesceKey("pull_request", {
        action: "synchronize",
        repository: { full_name: "JSONbored/Loopover" },
        number: 99,
        pull_request: {},
      } as never),
    ).toBe("github-webhook:pr-push:jsonbored/loopover#99");
    expect(
      githubWebhookCoalesceKey("pull_request", {
        action: "opened",
        repository: { full_name: "JSONbored/Loopover" },
        pull_request: { number: 100, head: { sha: "BEEF123" } },
      } as GitHubWebhookPayload),
    ).toBe("github-webhook:pr-refresh:jsonbored/loopover#100@beef123");
    // "closed" is a terminal action -- merge/close has its own non-coalesced handling and must never collapse
    // with anything else. "labeled"/"unlabeled" now coalesce too (see the dedicated pr-label tests below) --
    // they are no longer in this "returns null" list.
    expect(
      githubWebhookCoalesceKey("pull_request", {
        action: "closed",
        repository: { full_name: "JSONbored/Loopover" },
        pull_request: { number: 100, head: { sha: "BEEF123" } },
      } as GitHubWebhookPayload),
    ).toBeNull();
  });

  it("coalesces a burst of reopened + synchronize + ready_for_review events for the same PR head into one key (regression for #audit-rate-headroom)", () => {
    // "reopened" triggers the same file-refresh path as "opened"/"synchronize" (PR_PUBLIC_SURFACE_ACTIONS in
    // src/queue/processors.ts) but was missing from the coalescable set — a burst of reopen-adjacent events for
    // the same PR+head fanned out one `/pulls/{n}/files` fetch per delivery instead of coalescing into one job.
    //
    // #9479 narrowed this: "synchronize" now keys separately, deliberately. A push and a lifecycle event
    // sharing one key meant a push could overwrite a still-pending "opened"/"ready_for_review" payload (the
    // queue's coalesce keeps only the newest), losing that transition entirely -- so the push debounce is kept
    // strictly to pushes, and the non-push burst still collapses exactly as it did.
    const burstKeys = (["reopened", "ready_for_review"] as const).map((action) =>
      githubWebhookCoalesceKey("pull_request", {
        action,
        repository: { full_name: "JSONbored/Loopover" },
        pull_request: { number: 100, head: { sha: "BEEF123" } },
      } as GitHubWebhookPayload),
    );
    expect(new Set(burstKeys).size).toBe(1);
    expect(burstKeys[0]).toBe("github-webhook:pr-refresh:jsonbored/loopover#100@beef123");
    expect(
      githubWebhookCoalesceKey("pull_request", {
        action: "synchronize",
        repository: { full_name: "JSONbored/Loopover" },
        pull_request: { number: 100, head: { sha: "BEEF123" } },
      } as GitHubWebhookPayload),
    ).not.toBe(burstKeys[0]);
  });

  it("returns null for malformed or non-coalescible webhook shapes", () => {
    expect(githubWebhookCoalesceKey("issues", { action: "closed", repository: { full_name: "JSONbored/Loopover" } } as never)).toBeNull();
    expect(githubWebhookCoalesceKey("check_suite", { action: "requested", repository: { full_name: "JSONbored/Loopover" } } as never)).toBeNull();
    expect(
      githubWebhookCoalesceKey("check_suite", {
        action: "completed",
        repository: { full_name: "JSONbored/Loopover" },
        check_suite: { pull_requests: [{ number: 7 }] },
      } as never),
    ).toBeNull();
    expect(
      githubWebhookCoalesceKey("pull_request", {
        action: "edited",
        repository: { full_name: "JSONbored/Loopover" },
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
          repository: { full_name: "JSONbored/Loopover" },
          pull_request: { number: 42, head: { sha: "BEEF123" } },
        } as GitHubWebhookPayload),
      ).toBe("github-webhook:pr-label:jsonbored/loopover#42");
    }
    // A burst of add/remove churn on the same PR collapses to the identical key regardless of which label
    // action fired -- the handler re-syncs generically and doesn't act on the specific label.
    const burstKeys = ["labeled", "unlabeled", "labeled"].map((action) =>
      githubWebhookCoalesceKey("pull_request", {
        action,
        repository: { full_name: "JSONbored/Loopover" },
        pull_request: { number: 42 },
      } as GitHubWebhookPayload),
    );
    expect(new Set(burstKeys).size).toBe(1);
  });

  it("falls back to the top-level number field for a label event missing pull_request.number", () => {
    expect(
      githubWebhookCoalesceKey("pull_request", {
        action: "labeled",
        repository: { full_name: "JSONbored/Loopover" },
        pull_request: {},
        number: 55,
      } as unknown as GitHubWebhookPayload),
    ).toBe("github-webhook:pr-label:jsonbored/loopover#55");
  });

  it("returns null for a label event with no resolvable PR number", () => {
    expect(
      githubWebhookCoalesceKey("pull_request", {
        action: "labeled",
        repository: { full_name: "JSONbored/Loopover" },
      } as GitHubWebhookPayload),
    ).toBeNull();
  });

  it("does not coalesce pull_request_review events because their payloads drive invalidation and notifications", () => {
    for (const action of ["submitted", "edited", "dismissed"]) {
      expect(
        githubWebhookCoalesceKey("pull_request_review", {
          action,
          repository: { full_name: "JSONbored/Loopover" },
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
          repository: { full_name: "JSONbored/Loopover" },
          pull_request: { number: 12, head: { sha: "CAFE123" } },
        } as GitHubWebhookPayload),
      ).toBe("github-webhook:pull_request_review_comment:jsonbored/loopover#12@cafe123");
    }
  });

  it("coalesces review-surface bursts (pull_request_review_thread) into one job per PR+head", () => {
    for (const action of ["resolved", "unresolved"]) {
      expect(
        githubWebhookCoalesceKey("pull_request_review_thread", {
          action,
          repository: { full_name: "JSONbored/Loopover" },
          pull_request: { number: 12, head: { sha: "CAFE123" } },
        } as GitHubWebhookPayload),
      ).toBe("github-webhook:pull_request_review_thread:jsonbored/loopover#12@cafe123");
    }
  });

  it("keeps distinct review-surface event families separate so coalescing cannot drop review-only side effects", () => {
    const reviewKey = githubWebhookCoalesceKey("pull_request_review", {
      action: "submitted",
      repository: { full_name: "JSONbored/Loopover" },
      pull_request: { number: 12, head: { sha: "CAFE123" } },
    } as GitHubWebhookPayload);
    const commentKey = githubWebhookCoalesceKey("pull_request_review_comment", {
      action: "created",
      repository: { full_name: "JSONbored/Loopover" },
      pull_request: { number: 12, head: { sha: "CAFE123" } },
    } as GitHubWebhookPayload);
    const threadKey = githubWebhookCoalesceKey("pull_request_review_thread", {
      action: "resolved",
      repository: { full_name: "JSONbored/Loopover" },
      pull_request: { number: 12, head: { sha: "CAFE123" } },
    } as GitHubWebhookPayload);

    expect(reviewKey).toBeNull();
    expect(commentKey).not.toBe(threadKey);
  });

  it("omits the head sha suffix for a review-surface event with no resolvable head", () => {
    expect(
      githubWebhookCoalesceKey("pull_request_review_comment", {
        action: "created",
        repository: { full_name: "JSONbored/Loopover" },
        pull_request: { number: 12 },
      } as GitHubWebhookPayload),
    ).toBe("github-webhook:pull_request_review_comment:jsonbored/loopover#12");
  });

  it("returns null for a review-surface event with no resolvable PR number", () => {
    expect(
      githubWebhookCoalesceKey("pull_request_review_comment", {
        action: "created",
        repository: { full_name: "JSONbored/Loopover" },
      } as GitHubWebhookPayload),
    ).toBeNull();
  });

  it("returns null for a non-actionable action on a review-surface event type", () => {
    expect(
      githubWebhookCoalesceKey("pull_request_review", {
        action: "requested_changes_dismissed",
        repository: { full_name: "JSONbored/Loopover" },
        pull_request: { number: 12, head: { sha: "CAFE123" } },
      } as GitHubWebhookPayload),
    ).toBeNull();
    expect(
      githubWebhookCoalesceKey("pull_request_review_comment", {
        action: "resolved",
        repository: { full_name: "JSONbored/Loopover" },
        pull_request: { number: 12, head: { sha: "CAFE123" } },
      } as GitHubWebhookPayload),
    ).toBeNull();
    expect(
      githubWebhookCoalesceKey("pull_request_review_thread", {
        action: "created",
        repository: { full_name: "JSONbored/Loopover" },
        pull_request: { number: 12, head: { sha: "CAFE123" } },
      } as GitHubWebhookPayload),
    ).toBeNull();
  });

  it("returns null for a review-surface event type with no matching entry (e.g. an unrelated event)", () => {
    expect(
      githubWebhookCoalesceKey("issue_comment", {
        action: "created",
        repository: { full_name: "JSONbored/Loopover" },
        pull_request: { number: 12, head: { sha: "CAFE123" } },
      } as unknown as GitHubWebhookPayload),
    ).toBeNull();
  });
});

// #9479: every dedup layer in the pipeline was keyed on the head SHA -- this key, and the AI-review lock's
// `...@${headSha}:${mode}` -- which is precisely the wrong key for a force-push storm, because each push MINTS a
// new SHA. Five amend-and-repush cycles inside a minute therefore looked like five unrelated events and bought
// five full prologues (file list, up to 96k chars of grounding fetch, RAG + impact-map embeddings, an enrichment
// POST) plus five LLM calls, for four heads that no longer exist by the time their reviews land.
describe("force-push debounce (#9479)", () => {
  const push = (pr: number, sha: string) =>
    ({
      action: "synchronize",
      repository: { full_name: "JSONbored/Loopover" },
      pull_request: { number: pr, head: { sha } },
    }) as unknown as GitHubWebhookPayload;

  it("REGRESSION: consecutive pushes to the SAME PR share one coalesce key despite different head SHAs", () => {
    const keys = ["a".repeat(40), "b".repeat(40), "c".repeat(40), "d".repeat(40), "e".repeat(40)].map((sha) =>
      githubWebhookCoalesceKey("pull_request", push(7, sha)),
    );

    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe("github-webhook:pr-push:jsonbored/loopover#7");
  });

  it("INVARIANT: a non-push action with no head SHA still keys, just without the @sha suffix", () => {
    // The lifecycle branch keeps its head-SHA scoping, but a payload that omits the head (some "edited"
    // deliveries) must still produce a usable key rather than dropping out of coalescing entirely.
    expect(
      githubWebhookCoalesceKey("pull_request", {
        action: "edited",
        repository: { full_name: "JSONbored/Loopover" },
        pull_request: { number: 7 },
      } as GitHubWebhookPayload),
    ).toBe("github-webhook:pr-refresh:jsonbored/loopover#7");
  });

  it("INVARIANT: pushes to DIFFERENT PRs never coalesce with each other", () => {
    expect(githubWebhookCoalesceKey("pull_request", push(7, "a".repeat(40)))).not.toBe(
      githubWebhookCoalesceKey("pull_request", push(8, "a".repeat(40))),
    );
  });

  it("INVARIANT: a push never shares a key with a lifecycle event on the same PR, so it cannot overwrite a pending 'opened'", () => {
    // The queue's coalesce keeps only the NEWEST payload, so a shared key would let a push inside the window
    // discard an "opened"/"ready_for_review" transition entirely -- trading a spend bug for a lost-event bug.
    const pushKey = githubWebhookCoalesceKey("pull_request", push(7, "a".repeat(40)));
    for (const action of ["opened", "reopened", "edited", "ready_for_review"] as const) {
      expect(
        githubWebhookCoalesceKey("pull_request", {
          action,
          repository: { full_name: "JSONbored/Loopover" },
          pull_request: { number: 7, head: { sha: "a".repeat(40) } },
        } as GitHubWebhookPayload),
      ).not.toBe(pushKey);
    }
  });

  it("REGRESSION: only a push carries the trailing quiet window; every other delivery is enqueued immediately", () => {
    expect(githubWebhookCoalesceDelaySeconds("pull_request", push(7, "a".repeat(40)))).toBe(PUSH_COALESCE_QUIET_WINDOW_SECONDS);
    expect(PUSH_COALESCE_QUIET_WINDOW_SECONDS).toBeGreaterThan(0);

    for (const action of ["opened", "reopened", "edited", "ready_for_review", "closed", "labeled"] as const) {
      expect(
        githubWebhookCoalesceDelaySeconds("pull_request", {
          action,
          repository: { full_name: "JSONbored/Loopover" },
          pull_request: { number: 7, head: { sha: "a".repeat(40) } },
        } as GitHubWebhookPayload),
      ).toBe(0);
    }
    // A same-named action on an unrelated event family must not pick up the delay either.
    expect(githubWebhookCoalesceDelaySeconds("check_suite", { action: "synchronize", repository: { full_name: "JSONbored/Loopover" } } as unknown as GitHubWebhookPayload)).toBe(0);
  });
});
