import { afterEach, describe, expect, it, vi } from "vitest";
import { clearInstallationTokenCacheForTest } from "../../src/github/app";
import { getPullRequestDetailSyncState, upsertInstallation, upsertPullRequestDetailSyncState, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub, upsertRepositorySettings } from "../../src/db/repositories";
import { processJob } from "../../src/queue/processors";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { generatePrivateKeyPem } from "../helpers/github-app-key";
import { createTestEnv } from "../helpers/d1";

// #9055: a contributor can retarget a PR's base branch AFTER CI is green, with the head SHA UNCHANGED. GitHub
// does not re-run pull_request workflows or emit a new head for this, so a stored PR whose "files up to date"
// check keys on head SHA alone (filesUpToDate) skips the files refetch entirely — the diff, review, and CI
// aggregate all keep describing the ABANDONED base. `pull_request.edited` with `changes.base` is GitHub's own
// signal that this specific mutation happened, and it is the one thing available to notice it.
describe("a base retarget forces a fresh sync even though the head has not changed (#9055)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearInstallationTokenCacheForTest();
  });

  async function seed(env: Env): Promise<void> {
    await upsertInstallation(env, {
      action: "created",
      installation: { id: 9200, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] },
    });
    await upsertRepositoryFromGitHub(env, { name: "retarget-repo", full_name: "owner/retarget-repo", private: false, owner: { login: "owner" } }, 9200);
    await upsertRepositorySettings(env, { repoFullName: "owner/retarget-repo" });
    await upsertRepoFocusManifest(env, "owner/retarget-repo", { settings: { checkRunMode: "off", commentMode: "off", publicSurface: "off" } });
    await upsertPullRequestFromGitHub(env, "owner/retarget-repo", { number: 21, title: "Retargeted PR", state: "open", user: { login: "contributor" }, head: { sha: "r21" }, base: { ref: "main" }, labels: [], body: "x" });
    // A prior, COMPLETE sync for the same head — this is exactly the state filesUpToDate would otherwise treat
    // as "nothing to do", which is the bug: the head really hasn't changed, only the base has.
    await upsertPullRequestDetailSyncState(env, { repoFullName: "owner/retarget-repo", pullNumber: 21, status: "complete", headSha: "r21", filesSyncedAt: "2026-01-01T00:00:00.000Z", reviewsSyncedAt: "2026-01-01T00:00:00.000Z", checksSyncedAt: "2026-01-01T00:00:00.000Z", lastSyncedAt: "2026-01-01T00:00:00.000Z" });
  }

  function stubGitHub(fileFetchCount: { n: number }): void {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/21/files")) {
        fileFetchCount.n += 1;
        return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      }
      if (/\/pulls\/21(?:\?|$)/.test(url)) return Response.json({ number: 21, title: "Retargeted PR", state: "open", user: { login: "contributor" }, head: { sha: "r21" }, base: { ref: "release" }, labels: [], body: "x" });
      if (url.includes("/commits/r21/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/r21/status")) return Response.json({ state: "success", statuses: [] });
      return new Response("not found", { status: 404 });
    });
  }

  it("re-fetches files on a base-changing edit, bypassing the head-keyed freshness check that would otherwise skip it", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seed(env);
    const fileFetchCount = { n: 0 };
    stubGitHub(fileFetchCount);

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "retarget-1",
      eventName: "pull_request",
      payload: {
        action: "edited",
        installation: { id: 9200 },
        repository: { name: "retarget-repo", full_name: "owner/retarget-repo", private: false, owner: { login: "owner" } },
        pull_request: { number: 21, title: "Retargeted PR", state: "open", user: { login: "contributor" }, head: { sha: "r21" }, base: { ref: "release" }, labels: [], body: "x" },
        changes: { base: { from: { ref: "main" } } },
      },
    });

    // The stale-complete sync state would otherwise have made this zero.
    expect(fileFetchCount.n).toBeGreaterThan(0);
  });

  it("does NOT force a refetch for an ordinary edit that does not touch the base", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seed(env);
    const fileFetchCount = { n: 0 };
    stubGitHub(fileFetchCount);

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "retarget-2",
      eventName: "pull_request",
      payload: {
        action: "edited",
        installation: { id: 9200 },
        repository: { name: "retarget-repo", full_name: "owner/retarget-repo", private: false, owner: { login: "owner" } },
        pull_request: { number: 21, title: "Retitled, not retargeted", state: "open", user: { login: "contributor" }, head: { sha: "r21" }, base: { ref: "main" }, labels: [], body: "x" },
        changes: {},
      },
    });

    expect(fileFetchCount.n).toBe(0);
  });

  it("invalidates the stored sync state, not just refetching files silently", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seed(env);
    stubGitHub({ n: 0 });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "retarget-3",
      eventName: "pull_request",
      payload: {
        action: "edited",
        installation: { id: 9200 },
        repository: { name: "retarget-repo", full_name: "owner/retarget-repo", private: false, owner: { login: "owner" } },
        pull_request: { number: 21, title: "Retargeted PR", state: "open", user: { login: "contributor" }, head: { sha: "r21" }, base: { ref: "release" }, labels: [], body: "x" },
        changes: { base: { from: { ref: "main" } } },
      },
    });

    const state = await getPullRequestDetailSyncState(env, "owner/retarget-repo", 21);
    // A fresh sync ran and re-recorded a timestamp — not the stale 2026-01-01 marker seeded above.
    expect(state?.lastSyncedAt).not.toBe("2026-01-01T00:00:00.000Z");
  });
});
