import { afterEach, describe, expect, it, vi } from "vitest";
import { clearInstallationTokenCacheForTest } from "../../src/github/app";
import { getPullRequestDetailSyncState, upsertInstallation, upsertPullRequestDetailSyncState, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub, upsertRepositorySettings } from "../../src/db/repositories";
import { processJob } from "../../src/queue/processors";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { generatePrivateKeyPem } from "../helpers/github-app-key";
import { createTestEnv } from "../helpers/d1";

// #9059(c): pull_request.labeled/unlabeled did a row re-sync but were never in PR_PUBLIC_SURFACE_ACTIONS, so a
// maintainer adding or removing the manual-review hold label was only picked up by the ~2-minute sweep — which,
// combined with the sticky-label issue elsewhere in this audit, meant manually unblocking a PR had up to that
// lag before it took effect. labeled/unlabeled are disposition INPUTS (the hold reads straight off the PR's
// labels), not mere metadata, so they belong in the same set as edited/synchronize.
describe("a label change runs the public-surface pipeline immediately (#9059)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearInstallationTokenCacheForTest();
  });

  async function seed(env: Env, repo: string, installationId: number, number: number, head: string): Promise<void> {
    await upsertInstallation(env, {
      action: "created",
      installation: { id: installationId, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] },
    });
    await upsertRepositoryFromGitHub(env, { name: repo, full_name: `owner/${repo}`, private: false, owner: { login: "owner" } }, installationId);
    // slopGateMode !== "off" is what makes maybePublishPrPublicSurface's file-refresh branch fire — the same
    // gate the pre-existing "#review-pre-merge-checks" recapture-preview test uses for the same reason.
    await upsertRepositorySettings(env, { repoFullName: `owner/${repo}`, slopGateMode: "advisory" });
    await upsertRepoFocusManifest(env, `owner/${repo}`, { settings: { checkRunMode: "off", commentMode: "off", publicSurface: "off" } });
    await upsertPullRequestFromGitHub(env, `owner/${repo}`, { number, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: head }, labels: [], body: "x" });
    await upsertPullRequestDetailSyncState(env, { repoFullName: `owner/${repo}`, pullNumber: number, status: "complete", headSha: head, filesSyncedAt: "2020-01-01T00:00:00.000Z", reviewsSyncedAt: "2020-01-01T00:00:00.000Z", checksSyncedAt: "2020-01-01T00:00:00.000Z", lastSyncedAt: "2020-01-01T00:00:00.000Z" });
  }

  function stubGitHub(repo: string, number: number, head: string): void {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes(`/pulls/${number}/files`)) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (new RegExp(`/pulls/${number}(?:\\?|$)`).test(url)) return Response.json({ number, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: head }, labels: [{ name: "manual-review" }], body: "x" });
      if (url.includes(`/commits/${head}/check-runs`)) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes(`/commits/${head}/status`)) return Response.json({ state: "success", statuses: [] });
      return new Response("not found", { status: 404 });
    });
  }

  it("re-syncs immediately when a label is added, instead of waiting for the sweep", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seed(env, "label-repo", 9300, 31, "lh31");
    stubGitHub("label-repo", 31, "lh31");

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "labeled-1",
      eventName: "pull_request",
      payload: {
        action: "labeled",
        installation: { id: 9300 },
        repository: { name: "label-repo", full_name: "owner/label-repo", private: false, owner: { login: "owner" } },
        pull_request: { number: 31, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "lh31" }, labels: [{ name: "manual-review" }], body: "x" },
        label: { name: "manual-review" },
      },
    });

    const state = await getPullRequestDetailSyncState(env, "owner/label-repo", 31);
    expect(state?.lastSyncedAt).not.toBe("2020-01-01T00:00:00.000Z");
  });

  it("re-syncs immediately when a label is removed", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seed(env, "unlabel-repo", 9301, 32, "lh32");
    stubGitHub("unlabel-repo", 32, "lh32");

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "unlabeled-1",
      eventName: "pull_request",
      payload: {
        action: "unlabeled",
        installation: { id: 9301 },
        repository: { name: "unlabel-repo", full_name: "owner/unlabel-repo", private: false, owner: { login: "owner" } },
        pull_request: { number: 32, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "lh32" }, labels: [], body: "x" },
        label: { name: "manual-review" },
      },
    });

    const state = await getPullRequestDetailSyncState(env, "owner/unlabel-repo", 32);
    expect(state?.lastSyncedAt).not.toBe("2020-01-01T00:00:00.000Z");
  });

  it("does not run the public-surface pipeline for an action outside its scope (contrast case)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seed(env, "assign-repo", 9302, 33, "lh33");
    stubGitHub("assign-repo", 33, "lh33");

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "assigned-1",
      eventName: "pull_request",
      payload: {
        action: "assigned",
        installation: { id: 9302 },
        repository: { name: "assign-repo", full_name: "owner/assign-repo", private: false, owner: { login: "owner" } },
        pull_request: { number: 33, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "lh33" }, labels: [], body: "x" },
      },
    });

    const state = await getPullRequestDetailSyncState(env, "owner/assign-repo", 33);
    expect(state?.lastSyncedAt).toBe("2020-01-01T00:00:00.000Z");
  });
});
