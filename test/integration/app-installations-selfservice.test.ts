import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { upsertInstallation, upsertInstallationHealth } from "../../src/db/repositories";
import type { InstallationHealthRecord } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

// Tenant self-service for installation health/repair (#7661). These `/v1/app/installations*` routes are the
// tenant-scoped siblings of the operator-only `/v1/installations*` routes, reusing `/v1/app/maintainer-dashboard`'s
// exact `loadControlPanelAccessScope` scoping: an operator (or static api token) sees the whole fleet, while a
// non-operator session is limited to installations under their own account. These tests prove the scoping holds
// (tenant A can neither read nor repair tenant B's installation) and exercise every added branch/error path.

describe("tenant self-service installation health/repair (#7661)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function seedInstallation(env: Env, id: number, login: string): Promise<void> {
    await upsertInstallation(env, {
      installation: {
        id,
        account: { login, id, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", pull_requests: "read" },
        events: ["issues", "pull_request", "repository"],
      },
    });
  }

  async function seedHealth(env: Env, installationId: number, accountLogin: string): Promise<void> {
    const record: InstallationHealthRecord = {
      installationId,
      accountLogin,
      repositorySelection: "selected",
      installedReposCount: 1,
      registeredInstalledCount: 0,
      status: "needs_attention",
      missingPermissions: ["issues"],
      missingEvents: ["issue_comment"],
      permissions: { metadata: "read", pull_requests: "read" },
      events: ["issues", "pull_request", "repository"],
      checkedAt: "2026-05-28T00:00:00.000Z",
      authMode: "local",
    };
    await upsertInstallationHealth(env, record);
  }

  // tenant-a owns installation 500 (health 500); health 501 is a second telemetry row under tenant-a's account
  // with no installation row (a pruned/never-registered install) -- it exercises the account-login scope arm and
  // the refresh "installation_not_found" path. tenant-b owns installation 600. ADMIN_GITHUB_LOGINS is empty so no
  // session is an operator.
  async function seedFleet(env: Env): Promise<void> {
    await seedInstallation(env, 500, "tenant-a");
    await seedInstallation(env, 600, "tenant-b");
    await seedHealth(env, 500, "tenant-a");
    await seedHealth(env, 501, "tenant-a");
    await seedHealth(env, 600, "tenant-b");
  }

  function apiHeaders(env: Env): Record<string, string> {
    return { authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`, "content-type": "application/json" };
  }

  function cookie(token: string): Record<string, string> {
    return { cookie: `loopover_session=${token}` };
  }

  it("rejects unauthenticated callers on every tenant installation route", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
    await seedFleet(env);

    expect((await app.request("/v1/app/installations", {}, env)).status).toBe(401);
    expect((await app.request("/v1/app/installations/500/health", {}, env)).status).toBe(401);
    expect((await app.request("/v1/app/installations/500/repair", {}, env)).status).toBe(401);
    expect((await app.request("/v1/app/installations/500/repair/refresh", { method: "POST" }, env)).status).toBe(401);
  });

  it("rejects a session with no maintainer/owner/operator role", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
    await seedFleet(env);
    const { token } = await createSessionForGitHubUser(env, { login: "nobody", id: 9 });

    // Every route short-circuits on the shared role gate before doing any installation work.
    const list = await app.request("/v1/app/installations", { headers: cookie(token) }, env);
    expect(list.status).toBe(403);
    await expect(list.json()).resolves.toMatchObject({ error: "insufficient_role" });
    expect((await app.request("/v1/app/installations/500/health", { headers: cookie(token) }, env)).status).toBe(403);
    expect((await app.request("/v1/app/installations/500/repair", { headers: cookie(token) }, env)).status).toBe(403);
    expect((await app.request("/v1/app/installations/500/repair/refresh", { method: "POST", headers: cookie(token) }, env)).status).toBe(403);
  });

  it("lets an operator (static api token) see and read the whole fleet", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
    await seedFleet(env);

    const list = await app.request("/v1/app/installations", { headers: apiHeaders(env) }, env);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { installations: Array<{ id: number }>; health: Array<{ installationId: number }> };
    expect(listBody.installations.map((installation) => installation.id).sort((a, b) => a - b)).toEqual([500, 600]);
    expect(listBody.health.map((record) => record.installationId).sort((a, b) => a - b)).toEqual([500, 501, 600]);

    // Operator (scope === null) can read another account's installation health/repair directly.
    expect((await app.request("/v1/app/installations/600/health", { headers: apiHeaders(env) }, env)).status).toBe(200);
    expect((await app.request("/v1/app/installations/600/repair", { headers: apiHeaders(env) }, env)).status).toBe(200);
  });

  it("scopes the list to the tenant's own installations only", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
    await seedFleet(env);
    const { token: tokenA } = await createSessionForGitHubUser(env, { login: "tenant-a", id: 5001 });

    const list = await app.request("/v1/app/installations", { headers: cookie(tokenA) }, env);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { installations: Array<{ id: number; accountLogin: string }>; health: Array<{ installationId: number }> };
    // tenant-a sees only their own installation 500 -- never tenant-b's 600.
    expect(body.installations.map((installation) => installation.id)).toEqual([500]);
    // Both health rows under tenant-a's account are in scope (500 via installation id, 501 via account login);
    // tenant-b's 600 is filtered out.
    expect(body.health.map((record) => record.installationId).sort((a, b) => a - b)).toEqual([500, 501]);
    expect(JSON.stringify(body)).not.toContain("tenant-b");
  });

  it("scopes per-installation health reads and their error branches", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
    await seedFleet(env);
    const { token: tokenA } = await createSessionForGitHubUser(env, { login: "tenant-a", id: 5001 });

    // Own installation (installation-id scope arm) -> 200.
    const own = await app.request("/v1/app/installations/500/health", { headers: cookie(tokenA) }, env);
    expect(own.status).toBe(200);
    await expect(own.json()).resolves.toMatchObject({ installationId: 500, accountLogin: "tenant-a" });

    // Own telemetry row with no installation record (account-login scope arm) -> 200.
    const orphan = await app.request("/v1/app/installations/501/health", { headers: cookie(tokenA) }, env);
    expect(orphan.status).toBe(200);
    await expect(orphan.json()).resolves.toMatchObject({ installationId: 501, accountLogin: "tenant-a" });

    // Another tenant's installation -> 403, never leaking it.
    const foreign = await app.request("/v1/app/installations/600/health", { headers: cookie(tokenA) }, env);
    expect(foreign.status).toBe(403);
    await expect(foreign.json()).resolves.toMatchObject({ error: "forbidden_installation" });

    // Non-numeric id -> 400.
    const invalid = await app.request("/v1/app/installations/not-a-number/health", { headers: cookie(tokenA) }, env);
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: "invalid_installation_id" });

    // No health record at all -> 404.
    const missing = await app.request("/v1/app/installations/999/health", { headers: cookie(tokenA) }, env);
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ error: "installation_health_not_found" });
  });

  it("scopes per-installation repair diagnostics and their error branches", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
    await seedFleet(env);
    const { token: tokenA } = await createSessionForGitHubUser(env, { login: "tenant-a", id: 5001 });

    const own = await app.request("/v1/app/installations/500/repair", { headers: cookie(tokenA) }, env);
    expect(own.status).toBe(200);
    await expect(own.json()).resolves.toMatchObject({ installation: { status: expect.any(String) } });

    const foreign = await app.request("/v1/app/installations/600/repair", { headers: cookie(tokenA) }, env);
    expect(foreign.status).toBe(403);
    await expect(foreign.json()).resolves.toMatchObject({ error: "forbidden_installation" });

    const invalid = await app.request("/v1/app/installations/not-a-number/repair", { headers: cookie(tokenA) }, env);
    expect(invalid.status).toBe(400);

    const missing = await app.request("/v1/app/installations/999/repair", { headers: cookie(tokenA) }, env);
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ error: "installation_health_not_found" });
  });

  it("scopes repair/refresh and its error branches, and refreshes the tenant's own installation", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "", GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/app/installations/500")) {
        return Response.json({
          id: 500,
          account: { login: "tenant-a", id: 500, type: "User" },
          repository_selection: "selected",
          permissions: { metadata: "read", pull_requests: "read", issues: "write" },
          events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
        });
      }
      return new Response("not found", { status: 404 });
    });
    await seedFleet(env);
    const { token: tokenA } = await createSessionForGitHubUser(env, { login: "tenant-a", id: 5001 });

    // Another tenant's installation cannot be repaired -> 403 (enforced BEFORE any refresh side effect).
    const foreign = await app.request("/v1/app/installations/600/repair/refresh", { method: "POST", headers: cookie(tokenA) }, env);
    expect(foreign.status).toBe(403);
    await expect(foreign.json()).resolves.toMatchObject({ error: "forbidden_installation" });

    // Non-numeric id -> 400.
    const invalid = await app.request("/v1/app/installations/not-a-number/repair/refresh", { method: "POST", headers: cookie(tokenA) }, env);
    expect(invalid.status).toBe(400);

    // No health record at all -> 404.
    const missing = await app.request("/v1/app/installations/999/repair/refresh", { method: "POST", headers: cookie(tokenA) }, env);
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ error: "installation_health_not_found" });

    // In-scope telemetry row whose installation record no longer exists -> refresh yields installation_not_found.
    const gone = await app.request("/v1/app/installations/501/repair/refresh", { method: "POST", headers: cookie(tokenA) }, env);
    expect(gone.status).toBe(404);
    await expect(gone.json()).resolves.toMatchObject({ error: "installation_not_found" });

    // The tenant's own installation refreshes successfully.
    const refreshed = await app.request("/v1/app/installations/500/repair/refresh", { method: "POST", headers: cookie(tokenA) }, env);
    expect(refreshed.status).toBe(200);
    await expect(refreshed.json()).resolves.toMatchObject({ refreshed: true, installation: { status: expect.any(String) } });
  });
});

async function generatePrivateKeyPem(): Promise<string> {
  const key = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey("pkcs8", key.privateKey);
  const base64 = Buffer.from(exported as ArrayBuffer)
    .toString("base64")
    .replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`;
}
