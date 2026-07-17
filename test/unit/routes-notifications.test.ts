import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { insertNotificationDeliveryIfAbsent, markNotificationDeliveryDelivered } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

function apiHeaders(env: Env): Record<string, string> {
  return { authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`, "content-type": "application/json" };
}

async function seedDelivered(env: Env, recipientLogin: string, dedupKey: string): Promise<string> {
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
  return delivery.id;
}

describe("contributor notifications routes (#6745)", () => {
  it("rejects unauthenticated access to both routes", async () => {
    const app = createApp();
    const env = createTestEnv();
    expect((await app.request("/v1/contributors/alice/notifications", {}, env)).status).toBe(401);
    expect((await app.request("/v1/contributors/alice/notifications/read", { method: "POST" }, env)).status).toBe(401);
  });

  it("lets a self-matching admin session read its own notifications and unread count", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "attacker" });
    const { token } = await createSessionForGitHubUser(env, { login: "attacker", id: 7 });
    const sessionHeaders = { authorization: `Bearer ${token}` };
    await seedDelivered(env, "attacker", "k1");

    const res = await app.request("/v1/contributors/attacker/notifications", { headers: sessionHeaders }, env);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ login: "attacker", unreadCount: 1 });
    // never leaks a wallet/hotkey/reward term regardless of notification content
    expect(JSON.stringify(body)).not.toMatch(/wallet|hotkey|coldkey|reward estimate|trust score/i);
  });

  it("forbids a session from reading another login's notifications", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "attacker" });
    const { token } = await createSessionForGitHubUser(env, { login: "attacker", id: 7 });
    const sessionHeaders = { authorization: `Bearer ${token}` };

    const res = await app.request("/v1/contributors/victim/notifications", { headers: sessionHeaders }, env);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "forbidden_contributor" });
  });

  it("lets a static api token read any login's notifications", async () => {
    const app = createApp();
    const env = createTestEnv();
    await seedDelivered(env, "victim", "k1");

    const res = await app.request("/v1/contributors/victim/notifications", { headers: apiHeaders(env) }, env);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ login: "victim", unreadCount: 1 });
  });

  it("marks all of a login's delivered notifications read when ids is omitted", async () => {
    const app = createApp();
    const env = createTestEnv();
    await seedDelivered(env, "victim", "k1");
    await seedDelivered(env, "victim", "k2");

    const res = await app.request(
      "/v1/contributors/victim/notifications/read",
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify({}) },
      env,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ login: "victim", marked: 2 });
    const after = await app.request("/v1/contributors/victim/notifications", { headers: apiHeaders(env) }, env);
    await expect(after.json()).resolves.toMatchObject({ unreadCount: 0 });
  });

  it("marks only the given ids read, leaving the rest delivered", async () => {
    const app = createApp();
    const env = createTestEnv();
    const firstId = await seedDelivered(env, "victim", "k1");
    await seedDelivered(env, "victim", "k2");

    const res = await app.request(
      "/v1/contributors/victim/notifications/read",
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ ids: [firstId] }) },
      env,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ login: "victim", marked: 1 });
    const after = await app.request("/v1/contributors/victim/notifications", { headers: apiHeaders(env) }, env);
    await expect(after.json()).resolves.toMatchObject({ unreadCount: 1 });
  });

  it("rejects an over-cap or oversized ids entry via schema validation before touching the store", async () => {
    const app = createApp();
    const env = createTestEnv();

    const tooLong = await app.request(
      "/v1/contributors/victim/notifications/read",
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ ids: ["x".repeat(200)] }) },
      env,
    );
    expect(tooLong.status).toBe(400);

    const tooMany = await app.request(
      "/v1/contributors/victim/notifications/read",
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ ids: Array.from({ length: 101 }, (_, i) => `id-${i}`) }) },
      env,
    );
    expect(tooMany.status).toBe(400);
  });

  it("treats a malformed JSON body the same as an empty body (marks all read)", async () => {
    const app = createApp();
    const env = createTestEnv();
    await seedDelivered(env, "victim", "k1");

    const res = await app.request(
      "/v1/contributors/victim/notifications/read",
      { method: "POST", headers: apiHeaders(env), body: "not-json" },
      env,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ login: "victim", marked: 1 });
  });
});
