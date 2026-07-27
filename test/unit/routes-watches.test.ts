import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { LoopoverMcp } from "../../src/mcp/server";
import { upsertInstallation, upsertIssueWatchSubscription, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

// #6746: GET/POST/DELETE /v1/contributors/:login/watches — the REST mirror of the loopover_watch_issues MCP tool.
// The tool's action enum splits across the verbs (GET=list, POST=watch, DELETE=unwatch); every verb self-scopes
// via requireContributorAccess and the mutating verbs reuse canWatchRepo. These pin the ROUTE contract + parity.
const apiHeaders = (env: Env) => ({ authorization: `Bearer ${env.LOOPOVER_API_TOKEN}` });
const jsonHeaders = (env: Env) => ({ authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`, "content-type": "application/json" });

async function connectMcp(env: Env) {
  const server = new LoopoverMcp(env).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "watches-parity-test", version: "0.0.1" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

async function seedPublicRepo(env: ReturnType<typeof createTestEnv>, fullName: string): Promise<void> {
  const [owner, name] = fullName.split("/");
  await upsertRepositoryFromGitHub(env, { name: name!, full_name: fullName, private: false, owner: { login: owner! } }, 555);
}

async function seedPrivateRepo(env: ReturnType<typeof createTestEnv>, fullName: string): Promise<void> {
  const [owner, name] = fullName.split("/");
  await upsertRepositoryFromGitHub(env, { name: name!, full_name: fullName, private: true, owner: { login: owner! } }, 555);
}

// Mirrors access-boundary.test.ts's seedOwnedRepo: an installed (not merely upserted) repo, so
// buildControlPanelAccessScope's ownedInstalledRepos/accountLogins actually grant the owning login access.
async function seedInstalledPrivateRepo(env: ReturnType<typeof createTestEnv>, owner: string, name: string, installationId: number): Promise<void> {
  await upsertInstallation(env, {
    installation: { id: installationId, account: { login: owner, id: installationId, type: "User" }, repository_selection: "selected", permissions: { metadata: "read" }, events: ["repository"] },
  });
  await upsertRepositoryFromGitHub(env, { name, full_name: `${owner}/${name}`, private: true, owner: { login: owner } }, installationId);
}

describe("GET /v1/contributors/:login/watches (#6746)", () => {
  it("returns the contributor's watch subscriptions", async () => {
    const app = createApp();
    const env = createTestEnv();
    await upsertIssueWatchSubscription(env, { login: "miner1", repoFullName: "acme/widgets", labels: ["bug", "feature"] });
    await upsertIssueWatchSubscription(env, { login: "miner1", repoFullName: "acme/gadgets" });

    const response = await app.request("/v1/contributors/Miner1/watches", { headers: apiHeaders(env) }, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { watching: Array<{ repoFullName: string; labels: string[] }> };
    expect(body.watching).toContainEqual({ repoFullName: "acme/widgets", labels: ["bug", "feature"] });
    expect(body.watching).toContainEqual({ repoFullName: "acme/gadgets", labels: [] });
  });

  it("returns an empty list for a contributor watching nothing", async () => {
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
});

describe("POST /v1/contributors/:login/watches (#6746)", () => {
  it("watches a public tracked repo and returns the updated list + changed line", async () => {
    const app = createApp();
    const env = createTestEnv();
    await seedPublicRepo(env, "acme/widgets");
    const response = await app.request(
      "/v1/contributors/miner1/watches",
      { method: "POST", headers: jsonHeaders(env), body: JSON.stringify({ repoFullName: "acme/widgets", labels: ["bug"] }) },
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { watching: Array<{ repoFullName: string; labels: string[] }>; changed: string };
    expect(body.watching).toEqual([{ repoFullName: "acme/widgets", labels: ["bug"] }]);
    expect(body.changed).toBe("watching acme/widgets (labels: bug)");
  });

  it("omits the label suffix when no labels are given", async () => {
    const app = createApp();
    const env = createTestEnv();
    await seedPublicRepo(env, "acme/widgets");
    const response = await app.request(
      "/v1/contributors/miner1/watches",
      { method: "POST", headers: jsonHeaders(env), body: JSON.stringify({ repoFullName: "acme/widgets" }) },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ changed: "watching acme/widgets" });
  });

  it("403s a repo the contributor cannot watch (untracked → fail-closed)", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request(
      "/v1/contributors/miner1/watches",
      { method: "POST", headers: jsonHeaders(env), body: JSON.stringify({ repoFullName: "acme/unknown" }) },
      env,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden_repo" });
  });

  it("403s a PRIVATE repo the login has no maintainer/owner/operator scope over", async () => {
    const app = createApp();
    const env = createTestEnv();
    await seedPrivateRepo(env, "acme/secrets");
    const response = await app.request(
      "/v1/contributors/miner1/watches",
      { method: "POST", headers: jsonHeaders(env), body: JSON.stringify({ repoFullName: "acme/secrets" }) },
      env,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden_repo" });
  });

  it("watches a PRIVATE repo the login owns via an installed account (accountLogins match grants canLoginAccessRepo)", async () => {
    const app = createApp();
    const env = createTestEnv();
    await seedInstalledPrivateRepo(env, "acme", "secrets", 555);
    const response = await app.request(
      "/v1/contributors/acme/watches",
      { method: "POST", headers: jsonHeaders(env), body: JSON.stringify({ repoFullName: "acme/secrets" }) },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ changed: "watching acme/secrets" });
  });

  it("rejects a malformed or non-JSON body with 400", async () => {
    const app = createApp();
    const env = createTestEnv();
    // The trailing raw string is not valid JSON, so `c.req.json()` rejects and the `.catch(() => null)` arm
    // yields a null the schema then rejects — the same 400, exercised through the parse-failure path.
    for (const body of [JSON.stringify({}), JSON.stringify({ repoFullName: "x" }), JSON.stringify({ repoFullName: "acme/widgets", labels: [""] }), "not json{"]) {
      const response = await app.request(
        "/v1/contributors/miner1/watches",
        { method: "POST", headers: jsonHeaders(env), body },
        env,
      );
      expect(response.status, body).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_watch_request" });
    }
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
  it("unwatches a repo and reports it was removed", async () => {
    const app = createApp();
    const env = createTestEnv();
    await seedPublicRepo(env, "acme/widgets");
    await upsertIssueWatchSubscription(env, { login: "miner1", repoFullName: "acme/widgets", labels: ["bug"] });
    const response = await app.request(
      "/v1/contributors/miner1/watches",
      { method: "DELETE", headers: jsonHeaders(env), body: JSON.stringify({ repoFullName: "acme/widgets" }) },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ watching: [], changed: "unwatched acme/widgets" });
  });

  it("reports 'was not watching' when there was no subscription", async () => {
    const app = createApp();
    const env = createTestEnv();
    await seedPublicRepo(env, "acme/widgets");
    const response = await app.request(
      "/v1/contributors/miner1/watches",
      { method: "DELETE", headers: jsonHeaders(env), body: JSON.stringify({ repoFullName: "acme/widgets" }) },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ watching: [], changed: "was not watching acme/widgets" });
  });

  it("403s a repo the contributor cannot watch (untracked → fail-closed)", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request(
      "/v1/contributors/miner1/watches",
      { method: "DELETE", headers: jsonHeaders(env), body: JSON.stringify({ repoFullName: "acme/unknown" }) },
      env,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden_repo" });
  });

  it("rejects a malformed or non-JSON body with 400", async () => {
    const app = createApp();
    const env = createTestEnv();
    for (const body of [JSON.stringify({}), "not json{"]) {
      const response = await app.request(
        "/v1/contributors/miner1/watches",
        { method: "DELETE", headers: jsonHeaders(env), body },
        env,
      );
      expect(response.status, body).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_watch_request" });
    }
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

describe("watches REST/MCP surface parity (#6746)", () => {
  it("GET returns the same {watching} the loopover_watch_issues list action returns", async () => {
    const env = createTestEnv();
    await upsertIssueWatchSubscription(env, { login: "miner1", repoFullName: "acme/widgets", labels: ["bug"] });
    const app = createApp();
    const restBody = await (await app.request("/v1/contributors/miner1/watches", { headers: apiHeaders(env) }, env)).json();
    const client = await connectMcp(env);
    const viaTool = await client.callTool({ name: "loopover_watch_issues", arguments: { login: "miner1", action: "list" } });
    expect((viaTool as { structuredContent?: unknown }).structuredContent).toEqual(restBody);
  });

  it("POST returns the same {watching,changed} the watch action returns", async () => {
    const restEnv = createTestEnv();
    await seedPublicRepo(restEnv, "acme/widgets");
    const app = createApp();
    const restBody = await (
      await app.request(
        "/v1/contributors/miner1/watches",
        { method: "POST", headers: jsonHeaders(restEnv), body: JSON.stringify({ repoFullName: "acme/widgets", labels: ["bug"] }) },
        restEnv,
      )
    ).json();

    const toolEnv = createTestEnv();
    await seedPublicRepo(toolEnv, "acme/widgets");
    const client = await connectMcp(toolEnv);
    const viaTool = await client.callTool({ name: "loopover_watch_issues", arguments: { login: "miner1", action: "watch", repoFullName: "acme/widgets", labels: ["bug"] } });
    expect((viaTool as { structuredContent?: unknown }).structuredContent).toEqual(restBody);
  });
});
