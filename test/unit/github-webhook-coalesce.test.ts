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
    for (const action of ["labeled", "unlabeled", "closed"]) {
      expect(
        githubWebhookCoalesceKey("pull_request", {
          action,
          repository: { full_name: "JSONbored/Gittensory" },
          pull_request: { number: 100, head: { sha: "BEEF123" } },
        } as GitHubWebhookPayload),
      ).toBeNull();
    }
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
});
