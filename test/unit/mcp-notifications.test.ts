import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { GittensoryMcp } from "../../src/mcp/server";
import { createSessionForGitHubUser, type AuthIdentity } from "../../src/auth/security";
import { insertNotificationDeliveryIfAbsent, markNotificationDeliveryDelivered } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

async function connect(env: Env, identity?: AuthIdentity) {
  const server = (identity ? new GittensoryMcp(env, identity) : new GittensoryMcp(env)).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gittensory-notifications-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

async function seedDelivered(env: Env, recipientLogin: string, dedupKey: string): Promise<void> {
  const { delivery } = await insertNotificationDeliveryIfAbsent(env, {
    dedupKey,
    channel: "badge",
    recipientLogin,
    eventType: "pull_request_changes_requested",
    repoFullName: "owner/repo",
    pullNumber: 7,
    title: "Changes requested on owner/repo#7",
    body: "A reviewer requested changes on your pull request owner/repo#7.",
    deeplink: "https://github.com/owner/repo/pull/7",
    actorLogin: "reviewer",
  });
  await markNotificationDeliveryDelivered(env, delivery.id);
}

describe("MCP notification tools", () => {
  it("lists and clears a contributor's own notifications", async () => {
    const env = createTestEnv();
    await seedDelivered(env, "miner", "k1");
    const client = await connect(env);

    const list = await client.callTool({ name: "gittensory_list_notifications", arguments: { login: "miner" } });
    expect(list.isError).toBeFalsy();
    expect((list.structuredContent as { unreadCount: number }).unreadCount).toBe(1);
    expect(JSON.stringify(list.structuredContent)).not.toMatch(/wallet|hotkey|reward estimate|trust score/i);

    const read = await client.callTool({ name: "gittensory_mark_notifications_read", arguments: { login: "miner" } });
    expect(read.isError).toBeFalsy();
    expect((read.structuredContent as { marked: number }).marked).toBe(1);

    const after = await client.callTool({ name: "gittensory_list_notifications", arguments: { login: "miner" } });
    expect((after.structuredContent as { unreadCount: number }).unreadCount).toBe(0);
  });

  it("returns a contributor's own post-merge outcomes via gittensory_pr_outcome (#702)", async () => {
    const env = createTestEnv();
    // Seed a merged-PR outcome + a changes-requested delivery; only the merge should surface as an outcome.
    await insertNotificationDeliveryIfAbsent(env, {
      dedupKey: "pull_request_merged:owner/repo#7:m1",
      channel: "badge",
      recipientLogin: "miner",
      eventType: "pull_request_merged",
      repoFullName: "owner/repo",
      pullNumber: 7,
      title: "Merged: owner/repo#7",
      body: "Your pull request owner/repo#7 merged. Merged contributions strengthen your standing on owner/repo.",
      deeplink: "https://github.com/owner/repo/pull/7",
      actorLogin: "miner",
    });
    await seedDelivered(env, "miner", "changes-requested-1");
    const client = await connect(env);

    const result = await client.callTool({ name: "gittensory_pr_outcome", arguments: { login: "miner" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { count: number; outcomes: Array<{ repoFullName: string; pullNumber: number; outcome: string }> };
    expect(data.count).toBe(1);
    expect(data.outcomes[0]).toMatchObject({ repoFullName: "owner/repo", pullNumber: 7, outcome: "merged" });
    expect(JSON.stringify(data)).not.toMatch(/reward|payout|trust score|wallet|\$/i);
  });

  it("is self-scoped: a session cannot read another login's outcomes", async () => {
    const env = createTestEnv();
    const { session } = await createSessionForGitHubUser(env, { login: "miner", id: 1 });
    const client = await connect(env, { kind: "session", actor: "miner", session });
    const result = await client.callTool({ name: "gittensory_pr_outcome", arguments: { login: "other" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("authenticated GitHub login");
  });

  it("forbids reading or clearing another login's notifications from a scoped session", async () => {
    const env = createTestEnv();
    const { session } = await createSessionForGitHubUser(env, { login: "miner", id: 1 });
    const identity: AuthIdentity = { kind: "session", actor: "miner", session };
    const client = await connect(env, identity);

    const list = await client.callTool({ name: "gittensory_list_notifications", arguments: { login: "other" } });
    expect(list.isError).toBe(true);
    expect(JSON.stringify(list.content)).toContain("authenticated GitHub login");

    const read = await client.callTool({ name: "gittensory_mark_notifications_read", arguments: { login: "other" } });
    expect(read.isError).toBe(true);
  });
});
