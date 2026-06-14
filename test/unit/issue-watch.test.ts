import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { GittensoryMcp } from "../../src/mcp/server";
import { createSessionForGitHubUser, type AuthIdentity } from "../../src/auth/security";
import {
  deleteIssueWatchSubscription,
  listIssueWatchSubscriptionsForLogin,
  listIssueWatchersForRepo,
  upsertIssueWatchSubscription,
  upsertRepositoryFromGitHub,
} from "../../src/db/repositories";
import { isGrabbableHighMultiplierIssue } from "../../src/signals/engine";
import { buildIssueWatchNotification, buildNotificationContent, detectIssueWatchEvents } from "../../src/notifications/service";
import type { IssueRecord } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

function issue(over: Partial<IssueRecord> = {}): IssueRecord {
  return { repoFullName: "owner/repo", number: 5, title: "Add retry to sync", state: "open", authorAssociation: "OWNER", authorLogin: "maintainer", labels: [], linkedPrs: [], ...over };
}

describe("isGrabbableHighMultiplierIssue (#699)", () => {
  it("is true only for an open, maintainer-created, non-WIP issue", () => {
    expect(isGrabbableHighMultiplierIssue(issue())).toBe(true);
    expect(isGrabbableHighMultiplierIssue(issue({ state: "closed" }))).toBe(false);
    expect(isGrabbableHighMultiplierIssue(issue({ authorAssociation: "NONE" }))).toBe(false); // community-authored
    expect(isGrabbableHighMultiplierIssue(issue({ labels: ["WIP"] }))).toBe(false); // maintainer WIP
  });
});

describe("issue-watch subscriptions (CRUD)", () => {
  it("subscribes idempotently, lists, normalizes labels, and unwatches", async () => {
    const env = createTestEnv();
    await upsertIssueWatchSubscription(env, { login: "Miner", repoFullName: "owner/repo", labels: ["Bug", " good first issue "] });
    let mine = await listIssueWatchSubscriptionsForLogin(env, "miner");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ repoFullName: "owner/repo", labels: ["bug", "good first issue"] }); // lowercased + trimmed

    // Re-subscribe (idempotent on login+repo) updates the label filter, not a duplicate row.
    await upsertIssueWatchSubscription(env, { login: "miner", repoFullName: "owner/repo", labels: [] });
    mine = await listIssueWatchSubscriptionsForLogin(env, "miner");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.labels).toEqual([]);

    // Watchers-for-repo lists across logins.
    await upsertIssueWatchSubscription(env, { login: "other", repoFullName: "owner/repo" });
    expect(await listIssueWatchersForRepo(env, "owner/repo")).toHaveLength(2);

    expect(await deleteIssueWatchSubscription(env, "miner", "owner/repo")).toBe(true);
    expect(await deleteIssueWatchSubscription(env, "miner", "owner/repo")).toBe(false); // already gone
    expect(await listIssueWatchSubscriptionsForLogin(env, "miner")).toHaveLength(0);
  });
});

describe("detectIssueWatchEvents", () => {
  it("fans out one event per matching watcher, skips the author, honours the label filter", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "alice bob maintainer" });
    await upsertIssueWatchSubscription(env, { login: "alice", repoFullName: "owner/repo" }); // any label
    await upsertIssueWatchSubscription(env, { login: "bob", repoFullName: "owner/repo", labels: ["bug"] }); // bug only
    await upsertIssueWatchSubscription(env, { login: "maintainer", repoFullName: "owner/repo" }); // the issue's author

    const events = await detectIssueWatchEvents(env, "owner/repo", issue({ number: 9, labels: ["enhancement"], authorLogin: "maintainer" }));
    // alice matches (any label); bob filtered out (no "bug"); maintainer skipped (own issue).
    expect(events.map((e) => e.recipientLogin).sort()).toEqual(["alice"]);
    expect(events[0]).toMatchObject({
      eventType: "issue_watch_match",
      repoFullName: "owner/repo",
      pullNumber: 9, // carries the issue number
      deeplink: "https://github.com/owner/repo/issues/9",
    });
    expect(events[0]!.dedupKey).toBe("issue_watch_match:owner/repo#9:alice");
  });

  it("returns nothing for a non-grabbable issue or when there are no watchers", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "alice" });
    await upsertIssueWatchSubscription(env, { login: "alice", repoFullName: "owner/repo" });
    expect(await detectIssueWatchEvents(env, "owner/repo", issue({ authorAssociation: "NONE" }))).toEqual([]); // community-authored
    expect(await detectIssueWatchEvents(env, "owner/repo", issue({ labels: ["wip"] }))).toEqual([]); // maintainer WIP
    expect(await detectIssueWatchEvents(env, "unwatched/repo", issue())).toEqual([]); // no watchers
  });


  it("filters legacy watchers that no longer have repository access", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "private", full_name: "victim/private", private: true, owner: { login: "victim" }, default_branch: "main" }, 123);
    await upsertIssueWatchSubscription(env, { login: "attacker", repoFullName: "victim/private" });

    await expect(detectIssueWatchEvents(env, "victim/private", issue({ repoFullName: "victim/private", number: 77 }))).resolves.toEqual([]);
  });

  it("handles an issue with no recorded author (actor falls back to 'unknown', no one is skipped)", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "alice" });
    await upsertIssueWatchSubscription(env, { login: "alice", repoFullName: "owner/repo" });
    const events = await detectIssueWatchEvents(env, "owner/repo", issue({ number: 12, authorLogin: undefined, authorAssociation: "MEMBER" }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ recipientLogin: "alice", actorLogin: "unknown", pullNumber: 12 });
  });
});

describe("buildIssueWatchNotification", () => {
  it("is public-safe (no reward/score/farming language)", () => {
    const { title, body } = buildIssueWatchNotification({
      eventType: "issue_watch_match",
      recipientLogin: "alice",
      repoFullName: "owner/repo",
      pullNumber: 9,
      dedupKey: "k",
      deeplink: "https://github.com/owner/repo/issues/9",
      actorLogin: "maintainer",
      detectedAt: "2026-06-14T00:00:00.000Z",
    });
    expect(title).toContain("owner/repo#9");
    expect(`${title} ${body}`).not.toMatch(/reward|payout|trust score|scoreability|farming|wallet|hotkey|multiplier/i);
  });

  it("buildNotificationContent routes the issue_watch_match eventType to the issue-watch copy", () => {
    const event = { eventType: "issue_watch_match" as const, recipientLogin: "alice", repoFullName: "owner/repo", pullNumber: 9, dedupKey: "k", deeplink: "https://github.com/owner/repo/issues/9", actorLogin: "maintainer", detectedAt: "2026-06-14T00:00:00.000Z" };
    expect(buildNotificationContent(event).title).toContain("New issue to grab on owner/repo#9");
  });
});

async function connect(env: Env, identity?: AuthIdentity) {
  const server = (identity ? new GittensoryMcp(env, identity) : new GittensoryMcp(env)).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "issue-watch-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("MCP gittensory_watch_issues", () => {
  it("watches, lists, and unwatches a repo for the authenticated login", async () => {
    const env = createTestEnv();
    const client = await connect(env);

    const watched = await client.callTool({ name: "gittensory_watch_issues", arguments: { login: "miner", action: "watch", repoFullName: "owner/repo", labels: ["bug"] } });
    expect(watched.isError).toBeFalsy();
    expect((watched.structuredContent as { watching: Array<{ repoFullName: string }> }).watching).toEqual([{ repoFullName: "owner/repo", labels: ["bug"] }]);

    const listed = await client.callTool({ name: "gittensory_watch_issues", arguments: { login: "miner", action: "list" } });
    expect((listed.structuredContent as { watching: unknown[] }).watching).toHaveLength(1);

    const unwatched = await client.callTool({ name: "gittensory_watch_issues", arguments: { login: "miner", action: "unwatch", repoFullName: "owner/repo" } });
    expect((unwatched.structuredContent as { watching: unknown[] }).watching).toHaveLength(0);
  });


  it("blocks session actors from watching inaccessible repositories", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "private", full_name: "victim/private", private: true, owner: { login: "victim" }, default_branch: "main" }, 321);
    const { session } = await createSessionForGitHubUser(env, { login: "miner", id: 1 });
    const client = await connect(env, { kind: "session", actor: "miner", session });

    const result = await client.callTool({ name: "gittensory_watch_issues", arguments: { login: "miner", action: "watch", repoFullName: "victim/private" } });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("session cannot access this repository");
    await expect(listIssueWatchSubscriptionsForLogin(env, "miner")).resolves.toEqual([]);
  });

  it("is self-scoped: a session cannot manage another login's watches", async () => {
    const env = createTestEnv();
    const { session } = await createSessionForGitHubUser(env, { login: "miner", id: 1 });
    const client = await connect(env, { kind: "session", actor: "miner", session });
    const result = await client.callTool({ name: "gittensory_watch_issues", arguments: { login: "other", action: "list" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("authenticated GitHub login");
  });
});
