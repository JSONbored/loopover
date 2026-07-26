import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ciCompletionHeadSha, processJob, resolveCiCompletionPrNumbers } from "../../src/queue/processors";
import { getPullRequestDetailSyncState, upsertPullRequestDetailSyncState, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub, upsertRepositorySettings } from "../../src/db/repositories";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { createTestEnv } from "../helpers/d1";
import type { GitHubWebhookPayload, JobMessage } from "../../src/types";

// The CI-completion re-review trigger (maybeReReviewOnCiCompletion) strands FORK PRs forever: GitHub leaves
// check_suite/check_run `pull_requests[]` EMPTY for cross-repo PRs, so the only resolution that works is by the
// CI head SHA. These tests pin the head-SHA resolver (the fix) + its fork-resume audit on the dispatch path.

const FORK_SHA = "deadbeefcafe1234deadbeefcafe1234deadbeef";

class MemoryTransientCache {
  readonly values = new Map<string, string>();
  getCalls = 0;
  setCalls = 0;

  async get(key: string): Promise<string | null> {
    this.getCalls += 1;
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.setCalls += 1;
    this.values.set(key, value);
  }
}

function checkSuitePayload(opts: { repo: string; installationId: number; headSha?: string; prNumbers?: number[] }): GitHubWebhookPayload {
  const [owner, name] = opts.repo.split("/");
  return {
    action: "completed",
    installation: { id: opts.installationId },
    repository: { name: name ?? "", full_name: opts.repo, owner: { login: owner } },
    // The payload type doesn't model check_suite; the dispatcher narrows it off Record<string, unknown>.
    ...({
      check_suite: {
        head_sha: opts.headSha,
        pull_requests: (opts.prNumbers ?? []).map((number) => ({ number })),
      },
    } as unknown as Partial<GitHubWebhookPayload>),
  } as GitHubWebhookPayload;
}

async function seedForkResumeRepo(env: ReturnType<typeof createTestEnv>, repo: string, prNumber: number, headSha: string): Promise<void> {
  const [owner] = repo.split("/");
  await upsertRepositoryFromGitHub(env, { name: repo.split("/")[1] ?? "repo", full_name: repo, private: false, owner: { login: owner ?? "owner" } }, 5001);
  // publicSurface/check/gate all OFF + no autonomy → reReviewStoredPullRequest is a clean no-op (no network),
  // so the test isolates resolution + coalesce + audit, exactly the head-SHA fix surface.
  await upsertRepositorySettings(env, { repoFullName: repo, autonomy: {} });
  await upsertRepoFocusManifest(env, repo, { settings: { publicSurface: "off", checkRunMode: "off" } });
  await upsertPullRequestFromGitHub(env, repo, { number: prNumber, title: "Fork PR", state: "open", user: { login: "outside-contributor" }, head: { sha: headSha }, labels: [], body: "fork change" });
}

describe("CI-completion fork PR resume (head-SHA fallback)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-28T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("ciCompletionHeadSha reads head_sha from check_suite and the nested check_run.check_suite", () => {
    expect(ciCompletionHeadSha("check_suite", { check_suite: { head_sha: " abc " } } as unknown as GitHubWebhookPayload)).toBe("abc");
    expect(ciCompletionHeadSha("check_run", { check_run: { head_sha: "xyz" } } as unknown as GitHubWebhookPayload)).toBe("xyz");
    expect(ciCompletionHeadSha("check_run", { check_run: { check_suite: { head_sha: "nested" } } } as unknown as GitHubWebhookPayload)).toBe("nested");
    expect(ciCompletionHeadSha("check_suite", {} as GitHubWebhookPayload)).toBe("");
  });

  it("(a) same-repo: populated pull_requests[] is returned verbatim, no head-SHA fallback", async () => {
    const env = createTestEnv();
    // A throwing fetch proves the populated path never touches GitHub.
    vi.stubGlobal("fetch", async () => {
      throw new Error("fetch must not be called for the same-repo populated path");
    });
    // The dispatcher de-dups before calling; the resolver returns the already-deduped same-repo set verbatim.
    const result = await resolveCiCompletionPrNumbers(env, 5001, "JSONbored/gittensory", [42, 7], FORK_SHA);
    expect(result).toEqual({ numbers: [42, 7], viaHeadShaFallback: false });
  });

  it("(b) fork: empty pull_requests[] → a stored open PR matching the head SHA is resolved (DB fast path)", async () => {
    const env = createTestEnv();
    await seedForkResumeRepo(env, "JSONbored/gittensory", 99, FORK_SHA);
    // A throwing fetch proves the DB fast path resolves without the live commits/pulls call.
    vi.stubGlobal("fetch", async () => {
      throw new Error("fetch must not be called when the stored DB row matches");
    });
    const result = await resolveCiCompletionPrNumbers(env, 5001, "JSONbored/gittensory", [], FORK_SHA);
    expect(result).toEqual({ numbers: [99], viaHeadShaFallback: true });
  });

  it("(b2) fork: no stored row → falls back to GET /commits/{sha}/pulls (open only)", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      calls.push(url);
      if (url.includes(`/commits/${FORK_SHA}/pulls`)) {
        return Response.json([
          { number: 12, state: "open" },
          { number: 13, state: "closed" },
        ]);
      }
      return new Response("not found", { status: 404 });
    });
    const result = await resolveCiCompletionPrNumbers(env, 5001, "JSONbored/gittensory", [], FORK_SHA);
    // Only the OPEN PR resolves; the closed one is dropped.
    expect(result).toEqual({ numbers: [12], viaHeadShaFallback: true });
    expect(calls.some((url) => url.includes(`/commits/${FORK_SHA}/pulls`))).toBe(true);
  });

  it("(c) no head-SHA match anywhere → empty, no throw", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    vi.stubGlobal("fetch", async () => Response.json([])); // commits/pulls returns nothing
    const result = await resolveCiCompletionPrNumbers(env, 5001, "JSONbored/gittensory", [], FORK_SHA);
    expect(result).toEqual({ numbers: [], viaHeadShaFallback: false });
  });

  it("(c2) empty head SHA short-circuits to empty without any lookup", async () => {
    const env = createTestEnv();
    vi.stubGlobal("fetch", async () => {
      throw new Error("fetch must not be called for an empty head SHA");
    });
    const result = await resolveCiCompletionPrNumbers(env, 5001, "JSONbored/gittensory", [], "");
    expect(result).toEqual({ numbers: [], viaHeadShaFallback: false });
  });

  it("dispatch: a FORK check_suite (empty pull_requests[], matching head SHA) resumes the PR + audits the fallback", async () => {
    const sent: JobMessage[] = [];
    const env = createTestEnv({
      JOBS: { async send(message: JobMessage) { sent.push(message); } } as unknown as Queue,
    });
    await seedForkResumeRepo(env, "JSONbored/gittensory", 99, FORK_SHA);
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "fork-delivery-1",
      eventName: "check_suite",
      payload: checkSuitePayload({ repo: "JSONbored/gittensory", installationId: 5001, headSha: FORK_SHA, prNumbers: [] }),
    });

    const audit = await env.DB.prepare("select outcome, detail, target_key, metadata_json from audit_events where event_type = ?")
      .bind("github_app.ci_completion_fork_resume")
      .first<{ outcome: string; detail: string; target_key: string; metadata_json: string }>();
    expect(audit?.outcome).toBe("queued");
    expect(audit?.detail).toMatch(/resumed fork PR via head-SHA fallback/i);
    expect(audit?.target_key).toBe("JSONbored/gittensory#99");
    expect(JSON.parse(audit?.metadata_json ?? "{}")).toMatchObject({ prNumbers: [99], eventName: "check_suite" });
    // The CI-completion handler always records the webhook event as processed.
    const webhook = await env.DB.prepare("select status from webhook_events where delivery_id = ?").bind("fork-delivery-1").first<{ status: string }>();
    expect(webhook?.status).toBe("processed");
  });

  it("dispatch: duplicate empty-pull_requests fork completions coalesce before head-SHA resolution", async () => {
    const cache = new MemoryTransientCache();
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token", SELFHOST_TRANSIENT_CACHE: cache });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 5001);

    let commitPullsCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input.toString().includes(`/commits/${FORK_SHA}/pulls`)) commitPullsCalls += 1;
      return Response.json([{ number: 99, state: "open" }]);
    });

    for (let i = 0; i < 3; i += 1) {
      await processJob(env, {
        type: "github-webhook",
        deliveryId: `fork-storm-${i}`,
        eventName: "check_suite",
        payload: checkSuitePayload({ repo: "JSONbored/gittensory", installationId: 5001, headSha: FORK_SHA, prNumbers: [] }),
      });
    }

    expect(commitPullsCalls).toBe(1);
    expect(cache.values.has(`ci-head-sha-resolve:jsonbored/gittensory@${FORK_SHA}`)).toBe(true);
    expect(cache.setCalls).toBe(2); // one head-SHA resolution claim + one per-PR re-review claim

    const audits = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?")
      .bind("github_app.ci_completion_fork_resume")
      .first<{ n: number }>();
    expect(audits?.n).toBe(1);
  });

  it("dispatch: a SAME-REPO check_suite (populated pull_requests[]) re-reviews WITHOUT the fork-resume audit", async () => {
    const env = createTestEnv();
    await seedForkResumeRepo(env, "JSONbored/gittensory", 99, FORK_SHA);
    vi.stubGlobal("fetch", async () => {
      throw new Error("fetch must not be called for the populated same-repo path");
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "same-repo-delivery-1",
      eventName: "check_suite",
      payload: checkSuitePayload({ repo: "JSONbored/gittensory", installationId: 5001, headSha: FORK_SHA, prNumbers: [99] }),
    });

    const forkAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?")
      .bind("github_app.ci_completion_fork_resume")
      .first<{ n: number }>();
    expect(forkAudit?.n).toBe(0);
    const webhook = await env.DB.prepare("select status from webhook_events where delivery_id = ?").bind("same-repo-delivery-1").first<{ status: string }>();
    expect(webhook?.status).toBe("processed");
  });

  it("invalidation: a COALESCED fork completion still invalidates the durable CI-state cache (on BOTH events)", async () => {
    const cache = new MemoryTransientCache();
    const env = createTestEnv({ SELFHOST_TRANSIENT_CACHE: cache });
    await seedForkResumeRepo(env, "JSONbored/gittensory", 99, FORK_SHA);
    // A second open PR on a DIFFERENT head SHA must be skipped by the invalidation loop's head-SHA filter.
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 98, title: "Other fork PR", state: "open", user: { login: "someone-else" }, head: { sha: "feedface0000feedface0000feedface0000feed" }, labels: [], body: "unrelated" });
    // A throwing fetch proves both events resolve/invalidate off the stored DB row, never the live commits/pulls call.
    vi.stubGlobal("fetch", async () => {
      throw new Error("fetch must not be called: the stored fork PR row matches the head SHA");
    });

    // Seed a STALE, pre-completion CI aggregate a reader could observe, keyed to the completing head SHA.
    const seedStaleCiState = async (pullNumber: number, ciState: "failed" | "passed") =>
      upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber, status: "complete", ciHeadSha: FORK_SHA, ciState, ciStateFetchedAt: new Date().toISOString() });

    // Event 1 (NOT coalesced): claims the head-SHA window, invalidates via the re-review loop.
    await seedStaleCiState(99, "failed");
    await seedStaleCiState(98, "failed");
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "fork-invalidate-1",
      eventName: "check_suite",
      payload: checkSuitePayload({ repo: "JSONbored/gittensory", installationId: 5001, headSha: FORK_SHA, prNumbers: [] }),
    });
    expect((await getPullRequestDetailSyncState(env, "JSONbored/gittensory", 99))?.ciState).toBeNull();

    // A reader repopulates the durable cache with the burst's NEXT, DIFFERING settled CI state before the second event.
    await seedStaleCiState(99, "passed");

    // Event 2 (COALESCED within the same window): the re-review dispatch is suppressed, but the fix guarantees the
    // durable-cache invalidation still runs -- otherwise a reader would observe the stale "passed" snapshot until TTL.
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "fork-invalidate-2",
      eventName: "check_suite",
      payload: checkSuitePayload({ repo: "JSONbored/gittensory", installationId: 5001, headSha: FORK_SHA, prNumbers: [] }),
    });
    expect((await getPullRequestDetailSyncState(env, "JSONbored/gittensory", 99))?.ciState).toBeNull();
    // PR 98 (mismatched head SHA) is never touched by the invalidation loop -- its stale state stays put.
    expect((await getPullRequestDetailSyncState(env, "JSONbored/gittensory", 98))?.ciState).toBe("failed");
  });

  it("regression: the COALESCED second fork completion suppresses the duplicate re-review dispatch", async () => {
    const cache = new MemoryTransientCache();
    const env = createTestEnv({ SELFHOST_TRANSIENT_CACHE: cache });
    await seedForkResumeRepo(env, "JSONbored/gittensory", 99, FORK_SHA);
    vi.stubGlobal("fetch", async () => {
      throw new Error("fetch must not be called: the stored fork PR row matches the head SHA");
    });

    for (const deliveryId of ["fork-dispatch-1", "fork-dispatch-2"]) {
      await processJob(env, {
        type: "github-webhook",
        deliveryId,
        eventName: "check_suite",
        payload: checkSuitePayload({ repo: "JSONbored/gittensory", installationId: 5001, headSha: FORK_SHA, prNumbers: [] }),
      });
    }

    // The fork-resume audit is written on the dispatch path only (AFTER the coalescing early-return), so exactly one
    // audit across two same-window events proves the second event's re-review dispatch was coalesced away, not re-run.
    const audits = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?")
      .bind("github_app.ci_completion_fork_resume")
      .first<{ n: number }>();
    expect(audits?.n).toBe(1);
    // Both events are still recorded as processed regardless of coalescing.
    const processed = await env.DB.prepare("select count(*) as n from webhook_events where status = 'processed' and delivery_id in (?, ?)")
      .bind("fork-dispatch-1", "fork-dispatch-2")
      .first<{ n: number }>();
    expect(processed?.n).toBe(2);
  });

  it("dispatch: a head SHA that matches nothing is a no-op (no fork audit, no throw, webhook recorded)", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 5001);
    vi.stubGlobal("fetch", async () => Response.json([])); // commits/pulls finds nothing

    await expect(
      processJob(env, {
        type: "github-webhook",
        deliveryId: "no-match-delivery-1",
        eventName: "check_suite",
        payload: checkSuitePayload({ repo: "JSONbored/gittensory", installationId: 5001, headSha: "0000000000000000000000000000000000000000", prNumbers: [] }),
      }),
    ).resolves.toBeUndefined();

    const forkAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?")
      .bind("github_app.ci_completion_fork_resume")
      .first<{ n: number }>();
    expect(forkAudit?.n).toBe(0);
    const webhook = await env.DB.prepare("select status from webhook_events where delivery_id = ?").bind("no-match-delivery-1").first<{ status: string }>();
    expect(webhook?.status).toBe("processed");
  });
});
