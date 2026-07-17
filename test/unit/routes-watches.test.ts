import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { listIssueWatchSubscriptionsForLogin, upsertIssueWatchSubscription, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { LoopoverMcp } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

// #6746: GET/POST/DELETE /v1/contributors/:login/watches — the REST mirror of the loopover_watch_issues MCP tool.
// All three gate on requireContributorAccess; POST/DELETE additionally gate the repo via requireWatchableRepo
// (session-only, canWatchRepo) mirroring the tool. These tests pin the route contract: the watch-list shape, the
// watch/unwatch `changed` messages, the guards, and REST↔MCP parity for the list surface.
const apiHeaders = (env: Env) => ({ authorization: `Bearer ${env.LOOPOVER_API_TOKEN}` });
const apiJsonHeaders = (env: Env) => ({ authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`, "content-type": "application/json" });

async function connectMcp(env: Env) {
  const server = new LoopoverMcp(env).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "watches-parity-test", version: "0.0.1" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

async function seedPublicRepo(env: Env, owner: string, name: string) {
  await upsertRepositoryFromGitHub(env, { name, full_name: `${owner}/${name}`, private: false, owner: { login: owner } });
}

async function sessionCookie(env: Env, login: string, id: number) {
  const { token } = await createSessionForGitHubUser(env, { login, id });
  return `loopover_session=${token}`;
}

describe("GET /v1/contributors/:login/watches (#6746)", () => {
  it("returns the contributor's watch list, shaped { watching: [{ repoFullName, labels }] }", async () => {
    const app = createApp();
    const env = createTestEnv();
    await upsertIssueWatchSubscription(env, { login: "miner1", repoFullName: "acme/widgets", labels: ["Bug", "good first issue"] });
    await upsertIssueWatchSubscription(env, { login: "miner1", repoFullName: "acme/gadgets", labels: [] });

    const response = await app.request("/v1/contributors/Miner1/watches", { headers: apiHeaders(env) }, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { watching: Array<{ repoFullName: string; labels: string[] }> };
    expect(body).not.toHaveProperty("changed");
    expect(body.watching).toContainEqual({ repoFullName: "acme/widgets", labels: ["bug", "good first issue"] });
    expect(body.watching).toContainEqual({ repoFullName: "acme/gadgets", labels: [] });
    expect(body.watching).toHaveLength(2);
  });

  it("returns an empty watch list for a contributor with no subscriptions", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request("/v1/contributors/miner1/watches", { headers: apiHeaders(env) }, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ watching: [] });
  });

  it("rejects an unauthenticated caller", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request("/v1/contributors/miner1/watches", {}, env);
    expect(response.status).toBeGreaterThanOrEqual(401);
    expect(response.status).toBeLessThan(404);
  });

  it("403s the shared mcp token unless fully unscoped (#2455 parity with the MCP surface)", async () => {
    const app = createApp();
    const env = createTestEnv({ MCP_READ_REPO_ALLOWLIST: "acme/widgets" });
    const response = await app.request("/v1/contributors/miner1/watches", { headers: { authorization: `Bearer ${env.LOOPOVER_MCP_TOKEN}` } }, env);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden_contributor" });
  });

  it("returns the same watch list the loopover_watch_issues MCP tool returns (mirror parity)", async () => {
    const app = createApp();
    const env = createTestEnv();
    await upsertIssueWatchSubscription(env, { login: "miner1", repoFullName: "acme/widgets", labels: ["bug"] });
    await upsertIssueWatchSubscription(env, { login: "miner1", repoFullName: "acme/gadgets", labels: [] });
    const restBody = await (await app.request("/v1/contributors/miner1/watches", { headers: apiHeaders(env) }, env)).json();
    const client = await connectMcp(env);
    const viaTool = await client.callTool({ name: "loopover_watch_issues", arguments: { login: "miner1", action: "list" } });
    expect((viaTool as { structuredContent?: unknown }).structuredContent).toEqual(restBody);
  });

  it("never leaks wallet/hotkey/trust-score terms in its payload", async () => {
    const app = createApp();
    const env = createTestEnv();
    await upsertIssueWatchSubscription(env, { login: "miner1", repoFullName: "acme/widgets", labels: ["bug"] });
    const response = await app.request("/v1/contributors/miner1/watches", { headers: apiHeaders(env) }, env);
    expect(JSON.stringify(await response.json())).not.toMatch(/wallet|hotkey|coldkey|trust score|reward estimate/i);
  });
});

describe("POST /v1/contributors/:login/watches (#6746)", () => {
  it("subscribes a repo with a label filter and returns the updated list plus a `changed` message", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request(
      "/v1/contributors/miner1/watches",
      { method: "POST", headers: apiJsonHeaders(env), body: JSON.stringify({ repoFullName: "acme/widgets", labels: ["Bug", "docs"] }) },
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { watching: Array<{ repoFullName: string; labels: string[] }>; changed: string };
    expect(body.changed).toBe("watching acme/widgets (labels: Bug, docs)");
    expect(body.watching).toContainEqual({ repoFullName: "acme/widgets", labels: ["bug", "docs"] });
    // Persisted.
    expect(await listIssueWatchSubscriptionsForLogin(env, "miner1")).toHaveLength(1);
  });

  it("subscribes a repo with no labels and omits the label suffix from `changed`", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request(
      "/v1/contributors/miner1/watches",
      { method: "POST", headers: apiJsonHeaders(env), body: JSON.stringify({ repoFullName: "acme/widgets" }) },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ watching: [{ repoFullName: "acme/widgets", labels: [] }], changed: "watching acme/widgets" });
  });

  it("lets a session watch a repo it can see (canWatchRepo), returning 200", async () => {
    const app = createApp();
    // ADMIN_GITHUB_LOGINS grants "miner1" a control-panel role so the session clears the broad contributor-route
    // guard and actually reaches requireWatchableRepo — the branch under test.
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "miner1" });
    await seedPublicRepo(env, "acme", "widgets");
    const cookie = await sessionCookie(env, "miner1", 4242);
    const response = await app.request(
      "/v1/contributors/miner1/watches",
      { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ repoFullName: "acme/widgets" }) },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ changed: "watching acme/widgets" });
  });

  it("403s a session that cannot watch the repo (unknown/inaccessible), mirroring requireWatchableRepo", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "miner1" });
    const cookie = await sessionCookie(env, "miner1", 4242);
    const response = await app.request(
      "/v1/contributors/miner1/watches",
      { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ repoFullName: "acme/ghost" }) },
      env,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden_watch_repo" });
  });

  it("rejects a malformed body (missing repoFullName) with 400", async () => {
    const app = createApp();
    const env = createTestEnv();
    for (const body of [{}, { repoFullName: "x" }, { repoFullName: "acme/widgets", labels: [""] }]) {
      const response = await app.request(
        "/v1/contributors/miner1/watches",
        { method: "POST", headers: apiJsonHeaders(env), body: JSON.stringify(body) },
        env,
      );
      expect(response.status, JSON.stringify(body)).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_watch" });
    }
    // A body that isn't valid JSON at all: c.req.json() throws, the route falls back to {} and 400s.
    const invalid = await app.request("/v1/contributors/miner1/watches", { method: "POST", headers: apiJsonHeaders(env), body: "{not json" }, env);
    expect(invalid.status).toBe(400);
  });

  it("rejects an unauthenticated caller", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request("/v1/contributors/miner1/watches", { method: "POST" }, env);
    expect(response.status).toBeGreaterThanOrEqual(401);
    expect(response.status).toBeLessThan(404);
  });

  it("403s the shared mcp token unless fully unscoped (#2455 parity with the MCP surface)", async () => {
    const app = createApp();
    const env = createTestEnv({ MCP_READ_REPO_ALLOWLIST: "acme/widgets" });
    const response = await app.request(
      "/v1/contributors/miner1/watches",
      { method: "POST", headers: { authorization: `Bearer ${env.LOOPOVER_MCP_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ repoFullName: "acme/widgets" }) },
      env,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden_contributor" });
  });
});

describe("DELETE /v1/contributors/:login/watches (#6746)", () => {
  it("unwatches a subscribed repo and reports it", async () => {
    const app = createApp();
    const env = createTestEnv();
    await upsertIssueWatchSubscription(env, { login: "miner1", repoFullName: "acme/widgets", labels: [] });
    const response = await app.request(
      "/v1/contributors/miner1/watches",
      { method: "DELETE", headers: apiJsonHeaders(env), body: JSON.stringify({ repoFullName: "acme/widgets" }) },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ watching: [], changed: "unwatched acme/widgets" });
  });

  it("reports `was not watching` when the repo had no subscription", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request(
      "/v1/contributors/miner1/watches",
      { method: "DELETE", headers: apiJsonHeaders(env), body: JSON.stringify({ repoFullName: "acme/widgets" }) },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ watching: [], changed: "was not watching acme/widgets" });
  });

  it("403s a session that cannot watch the repo, mirroring requireWatchableRepo", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "miner1" });
    const cookie = await sessionCookie(env, "miner1", 4242);
    const response = await app.request(
      "/v1/contributors/miner1/watches",
      { method: "DELETE", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ repoFullName: "acme/ghost" }) },
      env,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden_watch_repo" });
  });

  it("rejects a malformed body with 400 (invalid JSON falls back to {} then fails validation)", async () => {
    const app = createApp();
    const env = createTestEnv();
    for (const body of [JSON.stringify({}), "{not json"]) {
      const response = await app.request("/v1/contributors/miner1/watches", { method: "DELETE", headers: apiJsonHeaders(env), body }, env);
      expect(response.status, body).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_watch" });
    }
  });

  it("rejects an unauthenticated caller", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request("/v1/contributors/miner1/watches", { method: "DELETE" }, env);
    expect(response.status).toBeGreaterThanOrEqual(401);
    expect(response.status).toBeLessThan(404);
  });

  it("403s the shared mcp token unless fully unscoped (#2455 parity with the MCP surface)", async () => {
    const app = createApp();
    const env = createTestEnv({ MCP_READ_REPO_ALLOWLIST: "acme/widgets" });
    const response = await app.request(
      "/v1/contributors/miner1/watches",
      { method: "DELETE", headers: { authorization: `Bearer ${env.LOOPOVER_MCP_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ repoFullName: "acme/widgets" }) },
      env,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden_contributor" });
  });
});
