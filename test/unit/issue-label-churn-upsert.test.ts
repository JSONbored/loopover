import { afterEach, describe, expect, it, vi } from "vitest";
import { clearInstallationTokenCacheForTest } from "../../src/github/app";
import { getIssue, upsertInstallation, upsertIssueFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { processJob } from "../../src/queue/processors";
import { generatePrivateKeyPem } from "../helpers/github-app-key";
import { createTestEnv } from "../helpers/d1";

// #9059(a): maybeReReviewOnLinkedIssueChange returns `true` unconditionally once repo + installation + issue
// are present, and the caller short-circuits on that BEFORE handleIssueWebhookEvent — the only place
// upsertIssueFromGitHub is otherwise called for an `issues` event. So `issues.labels_json` and assignees only
// advanced on opened/edited/closed/reopened, or when the (up to 6-hourly) backfill reached the repo. Label
// churn is the single most common issue mutation, so the row most likely to be read (by issue-side advisories,
// slop triage, enrichment, and the MCP/API issue surfaces) was the row most likely to be stale.
describe("relabelling an issue updates its stored row immediately (#9059)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearInstallationTokenCacheForTest();
  });

  it("advances issues.labels_json on a labeled event instead of leaving it stale", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      action: "created",
      installation: { id: 9400, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] },
    });
    await upsertRepositoryFromGitHub(env, { name: "issue-repo", full_name: "owner/issue-repo", private: false, owner: { login: "owner" } }, 9400);
    await upsertIssueFromGitHub(env, "owner/issue-repo", { number: 5, title: "Bug report", state: "open", labels: [], body: "x" });

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      // No open PRs link this issue — the wake fan-out itself has nothing to do, which is exactly the case
      // that used to make the return-true short-circuit a pure loss with no compensating benefit.
      if (url.includes("/search/issues")) return Response.json({ items: [] });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "issue-labeled-1",
      eventName: "issues",
      payload: {
        action: "labeled",
        installation: { id: 9400 },
        repository: { name: "issue-repo", full_name: "owner/issue-repo", private: false, owner: { login: "owner" } },
        issue: { number: 5, title: "Bug report", state: "open", labels: [{ name: "priority:high" }], body: "x" },
        label: { name: "priority:high" },
      },
    });

    const issue = await getIssue(env, "owner/issue-repo", 5);
    expect(issue?.labels).toEqual(["priority:high"]);
  });

  it("advances the row's title/state on an assignment-change event too, not just labeled", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      action: "created",
      installation: { id: 9401, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] },
    });
    await upsertRepositoryFromGitHub(env, { name: "assign-issue-repo", full_name: "owner/assign-issue-repo", private: false, owner: { login: "owner" } }, 9401);
    await upsertIssueFromGitHub(env, "owner/assign-issue-repo", { number: 6, title: "Stale title", state: "open", labels: [], body: "x" });

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/search/issues")) return Response.json({ items: [] });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "issue-assigned-1",
      eventName: "issues",
      payload: {
        action: "assigned",
        installation: { id: 9401 },
        repository: { name: "assign-issue-repo", full_name: "owner/assign-issue-repo", private: false, owner: { login: "owner" } },
        // The title changed too — this is what the row upsert running is what actually proves: BEFORE the fix,
        // an assignment event never reached upsertIssueFromGitHub at all, so this rename would stay invisible.
        issue: { number: 6, title: "Renamed while assigning", state: "open", labels: [], body: "x" },
      },
    });

    const issue = await getIssue(env, "owner/assign-issue-repo", 6);
    expect(issue?.title).toBe("Renamed while assigning");
  });
});
