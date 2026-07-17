import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { insertNotificationDeliveryIfAbsent, markNotificationDeliveryDelivered, markNotificationDeliveriesRead } from "../../src/db/repositories";
import { LoopoverMcp } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

// #6745: GET /v1/contributors/:login/notifications and POST /v1/contributors/:login/notifications/read — the REST
// mirrors of the loopover_list_notifications / loopover_mark_notifications_read MCP tools. Both gate on
// requireContributorAccess and reuse buildNotificationFeed / markNotificationDeliveriesRead, so these tests pin
// the ROUTE contract: the feed shape + unread count, the mark-all vs mark-by-id body, the guard, and parity with
// the MCP surface.
const apiHeaders = (env: Env) => ({ authorization: `Bearer ${env.LOOPOVER_API_TOKEN}` });
const jsonHeaders = (env: Env) => ({ authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`, "content-type": "application/json" });

async function connectMcp(env: Env) {
  const server = new LoopoverMcp(env).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "notifications-parity-test", version: "0.0.1" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

async function seedDelivered(env: Env, login: string, dedupKey: string, pullNumber: number) {
  const { delivery } = await insertNotificationDeliveryIfAbsent(env, {
    dedupKey,
    channel: "badge",
    recipientLogin: login,
    eventType: "pull_request_merged",
    repoFullName: "acme/widgets",
    pullNumber,
    title: `Merged acme/widgets#${pullNumber}`,
    body: `Your pull request acme/widgets#${pullNumber} was merged.`,
    deeplink: `https://github.com/acme/widgets/pull/${pullNumber}`,
    actorLogin: "maintainer",
  });
  await markNotificationDeliveryDelivered(env, delivery.id);
  return delivery;
}

describe("GET /v1/contributors/:login/notifications (#6745)", () => {
  it("returns the badge feed with an unread count, excluding still-pending (undelivered) rows", async () => {
    const app = createApp();
    const env = createTestEnv();
    const unread = await seedDelivered(env, "miner1", "d-1", 1);
    const readDelivery = await seedDelivered(env, "miner1", "d-2", 2);
    await markNotificationDeliveriesRead(env, "miner1", [readDelivery.id]);
    // A row that was inserted but never delivered stays pending and must not surface in the feed.
    await insertNotificationDeliveryIfAbsent(env, {
      dedupKey: "d-pending",
      channel: "badge",
      recipientLogin: "miner1",
      eventType: "pull_request_merged",
      repoFullName: "acme/widgets",
      pullNumber: 3,
      title: "Pending",
      body: "pending",
      deeplink: "https://github.com/acme/widgets/pull/3",
      actorLogin: "maintainer",
    });

    const response = await app.request("/v1/contributors/Miner1/notifications", { headers: apiHeaders(env) }, env);
    expect(response.status).toBe(200);
    const feed = (await response.json()) as { login: string; unreadCount: number; notifications: Array<Record<string, unknown>> };
    expect(feed.login).toBe("miner1");
    expect(feed.unreadCount).toBe(1);
    expect(feed.notifications).toHaveLength(2);
    expect(feed.notifications.map((n) => n.id).sort()).toEqual([unread.id, readDelivery.id].sort());
    expect(feed.notifications).toContainEqual({
      id: unread.id,
      eventType: "pull_request_merged",
      repoFullName: "acme/widgets",
      pullNumber: 1,
      title: unread.title,
      body: unread.body,
      deeplink: unread.deeplink,
      status: "delivered",
      createdAt: unread.createdAt,
    });
  });

  it("returns an empty feed for a contributor with no notifications", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request("/v1/contributors/miner1/notifications", { headers: apiHeaders(env) }, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ login: "miner1", unreadCount: 0, notifications: [] });
  });

  it("rejects an unauthenticated caller", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request("/v1/contributors/miner1/notifications", {}, env);
    expect(response.status).toBeGreaterThanOrEqual(401);
    expect(response.status).toBeLessThan(404);
  });

  it("403s the shared mcp token unless fully unscoped (#2455 parity with the MCP surface)", async () => {
    const app = createApp();
    const env = createTestEnv({ MCP_READ_REPO_ALLOWLIST: "acme/widgets" });
    const response = await app.request("/v1/contributors/miner1/notifications", { headers: { authorization: `Bearer ${env.LOOPOVER_MCP_TOKEN}` } }, env);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden_contributor" });
  });

  it("returns the same feed the loopover_list_notifications MCP tool returns (mirror parity)", async () => {
    const app = createApp();
    const env = createTestEnv();
    await seedDelivered(env, "miner1", "d-1", 1);
    await seedDelivered(env, "miner1", "d-2", 2);
    const restBody = await (await app.request("/v1/contributors/miner1/notifications", { headers: apiHeaders(env) }, env)).json();
    const client = await connectMcp(env);
    const viaTool = await client.callTool({ name: "loopover_list_notifications", arguments: { login: "miner1" } });
    expect((viaTool as { structuredContent?: unknown }).structuredContent).toEqual(restBody);
  });

  it("never leaks wallet/hotkey/trust-score terms in its payload", async () => {
    const app = createApp();
    const env = createTestEnv();
    await seedDelivered(env, "miner1", "d-1", 1);
    const response = await app.request("/v1/contributors/miner1/notifications", { headers: apiHeaders(env) }, env);
    expect(JSON.stringify(await response.json())).not.toMatch(/wallet|hotkey|coldkey|trust score|reward estimate/i);
  });
});

describe("POST /v1/contributors/:login/notifications/read (#6745)", () => {
  it("marks every delivered notification read when the body is absent, and reports the count", async () => {
    const app = createApp();
    const env = createTestEnv();
    await seedDelivered(env, "miner1", "d-1", 1);
    await seedDelivered(env, "miner1", "d-2", 2);

    const response = await app.request("/v1/contributors/Miner1/notifications/read", { method: "POST", headers: apiHeaders(env) }, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ login: "miner1", marked: 2 });
    // The feed's unread count drops to zero afterward.
    const feed = (await (await app.request("/v1/contributors/miner1/notifications", { headers: apiHeaders(env) }, env)).json()) as { unreadCount: number };
    expect(feed.unreadCount).toBe(0);
  });

  it("marks only the supplied ids when a body is given", async () => {
    const app = createApp();
    const env = createTestEnv();
    const first = await seedDelivered(env, "miner1", "d-1", 1);
    await seedDelivered(env, "miner1", "d-2", 2);

    const response = await app.request(
      "/v1/contributors/miner1/notifications/read",
      { method: "POST", headers: jsonHeaders(env), body: JSON.stringify({ ids: [first.id] }) },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ login: "miner1", marked: 1 });
  });

  it("rejects a malformed ids body with 400", async () => {
    const app = createApp();
    const env = createTestEnv();
    const bodies = [{ ids: [""] }, { ids: [123] }, { ids: Array.from({ length: 101 }, (_, i) => `id-${i}`) }];
    for (const body of bodies) {
      const response = await app.request(
        "/v1/contributors/miner1/notifications/read",
        { method: "POST", headers: jsonHeaders(env), body: JSON.stringify(body) },
        env,
      );
      expect(response.status, JSON.stringify(body)).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_mark_read" });
    }
  });

  it("rejects an unauthenticated caller", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request("/v1/contributors/miner1/notifications/read", { method: "POST" }, env);
    expect(response.status).toBeGreaterThanOrEqual(401);
    expect(response.status).toBeLessThan(404);
  });

  it("403s the shared mcp token unless fully unscoped (#2455 parity with the MCP surface)", async () => {
    const app = createApp();
    const env = createTestEnv({ MCP_READ_REPO_ALLOWLIST: "acme/widgets" });
    const response = await app.request(
      "/v1/contributors/miner1/notifications/read",
      { method: "POST", headers: { authorization: `Bearer ${env.LOOPOVER_MCP_TOKEN}` } },
      env,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden_contributor" });
  });

  it("returns the same {login,marked} the loopover_mark_notifications_read MCP tool returns (mirror parity)", async () => {
    const restEnv = createTestEnv();
    await seedDelivered(restEnv, "miner1", "d-1", 1);
    await seedDelivered(restEnv, "miner1", "d-2", 2);
    const app = createApp();
    const restBody = await (await app.request("/v1/contributors/miner1/notifications/read", { method: "POST", headers: apiHeaders(restEnv) }, restEnv)).json();

    const toolEnv = createTestEnv();
    await seedDelivered(toolEnv, "miner1", "d-1", 1);
    await seedDelivered(toolEnv, "miner1", "d-2", 2);
    const client = await connectMcp(toolEnv);
    const viaTool = await client.callTool({ name: "loopover_mark_notifications_read", arguments: { login: "miner1" } });
    expect((viaTool as { structuredContent?: unknown }).structuredContent).toEqual(restBody);
  });
});
