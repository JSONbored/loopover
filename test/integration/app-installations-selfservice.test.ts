import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { getRepositorySettings, upsertInstallation, upsertInstallationHealth, upsertRepositoryFromGitHub, upsertRepositorySettings } from "../../src/db/repositories";
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
  // the refresh "installation_not_found" path. tenant-b owns installation 600.
  async function seedFleet(env: Env): Promise<void> {
    await seedInstallation(env, 500, "tenant-a");
    await seedInstallation(env, 600, "tenant-b");
    await seedHealth(env, 500, "tenant-a");
    await seedHealth(env, 501, "tenant-a");
    await seedHealth(env, 600, "tenant-b");
  }

  function cookie(token: string): Record<string, string> {
    return { cookie: `loopover_session=${token}` };
  }

  function apiHeaders(env: Env): Record<string, string> {
    return { authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`, "content-type": "application/json" };
  }

  it("rejects unauthenticated callers on every route", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
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
    expect(
      (await app.request("/v1/app/installations/500/repair/refresh", { method: "POST", headers: cookie(token) }, env))
        .status,
    ).toBe(403);
  });

  it("lets an operator (static api token) see and read the whole fleet", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
    await seedFleet(env);

    const list = await app.request("/v1/app/installations", { headers: apiHeaders(env) }, env);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      installations: Array<{ id: number }>;
      health: Array<{ installationId: number }>;
    };
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
    const body = (await list.json()) as {
      installations: Array<{ id: number; accountLogin: string }>;
      health: Array<{ installationId: number }>;
    };
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

  it("#9716: rejects a fractional/exponent/zero/negative installation id with 400 on every id route (Number.isFinite let those through)", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedFleet(env);

    // A GitHub installation id is always a positive integer. Number.isFinite accepted "1.5"->1.5 (fractional) and
    // "0"/"-1" (non-positive), binding them straight into the D1 lookup; each must now be a 400. ("1e3"->1000 is a
    // genuine integer and is deliberately NOT rejected -- it is exponent notation for a valid id, asserted below.)
    const badIds = ["1.5", "0", "-1"];
    const routes: Array<{ path: (id: string) => string; method: "GET" | "POST" | "PUT"; body?: string }> = [
      { path: (id) => `/v1/installations/${id}/health`, method: "GET" },
      { path: (id) => `/v1/installations/${id}/repair`, method: "GET" },
      { path: (id) => `/v1/installations/${id}/repair/refresh`, method: "POST" },
      { path: (id) => `/v1/app/installations/${id}/health`, method: "GET" },
      { path: (id) => `/v1/app/installations/${id}/repair`, method: "GET" },
      { path: (id) => `/v1/app/installations/${id}/repair/refresh`, method: "POST" },
      { path: (id) => `/v1/app/installations/${id}/agent/bulk-settings`, method: "PUT", body: JSON.stringify({ autonomy: {} }) },
    ];
    for (const route of routes) {
      for (const badId of badIds) {
        const res = await app.request(
          route.path(badId),
          { method: route.method, headers: apiHeaders(env), ...(route.body !== undefined ? { body: route.body } : {}) },
          env,
        );
        expect(res.status, `${route.method} ${route.path(badId)}`).toBe(400);
        await expect(res.json()).resolves.toMatchObject({ error: "invalid_installation_id" });
      }
    }

    // A valid positive integer id still passes the guard and reaches the handler (200 for the owned installation).
    expect((await app.request("/v1/app/installations/600/health", { headers: apiHeaders(env) }, env)).status).toBe(200);
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
    // Use node:crypto export so the test SOURCE never contains a PEM header literal — that literal is what
    // closed #8006 as a false-positive secret scan on an otherwise CI-green PR.
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "", GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
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
    const foreign = await app.request(
      "/v1/app/installations/600/repair/refresh",
      { method: "POST", headers: cookie(tokenA) },
      env,
    );
    expect(foreign.status).toBe(403);
    await expect(foreign.json()).resolves.toMatchObject({ error: "forbidden_installation" });

    // Non-numeric id -> 400.
    const invalid = await app.request(
      "/v1/app/installations/not-a-number/repair/refresh",
      { method: "POST", headers: cookie(tokenA) },
      env,
    );
    expect(invalid.status).toBe(400);

    // No health record at all -> 404.
    const missing = await app.request(
      "/v1/app/installations/999/repair/refresh",
      { method: "POST", headers: cookie(tokenA) },
      env,
    );
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ error: "installation_health_not_found" });

    // In-scope telemetry row whose installation record no longer exists -> refresh yields installation_not_found.
    const gone = await app.request(
      "/v1/app/installations/501/repair/refresh",
      { method: "POST", headers: cookie(tokenA) },
      env,
    );
    expect(gone.status).toBe(404);
    await expect(gone.json()).resolves.toMatchObject({ error: "installation_not_found" });

    // The tenant's own installation refreshes successfully.
    const refreshed = await app.request(
      "/v1/app/installations/500/repair/refresh",
      { method: "POST", headers: cookie(tokenA) },
      env,
    );
    expect(refreshed.status).toBe(200);
    await expect(refreshed.json()).resolves.toMatchObject({
      refreshed: true,
      installation: { status: expect.any(String) },
    });
  });
});

// #7676: installation-scoped bulk pause/dry-run. Same tenant-vs-tenant isolation as the health/repair siblings
// above (resolveAppInstallationScope / installationRecordInScope), layered on top of the existing strictly-
// per-repo PUT /v1/repos/:owner/:repo/settings.
describe("installation-scoped bulk agent pause/dry-run (#7676)", () => {
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

  async function seedInstalledRepo(env: Env, installationId: number, owner: string, name: string): Promise<void> {
    await upsertRepositoryFromGitHub(env, { name, full_name: `${owner}/${name}`, private: false, owner: { login: owner } }, installationId);
  }

  function cookie(token: string): Record<string, string> {
    return { cookie: `loopover_session=${token}` };
  }

  function apiHeaders(env: Env): Record<string, string> {
    return { authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`, "content-type": "application/json" };
  }

  async function bulkRequest(app: ReturnType<typeof createApp>, env: Env, installationId: number | string, headers: Record<string, string>, body: unknown) {
    return app.request(
      `/v1/app/installations/${installationId}/agent/bulk-settings`,
      { method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) },
      env,
    );
  }

  it("rejects an unauthenticated caller and a session with no maintainer/owner/operator role", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
    await seedInstallation(env, 700, "tenant-a");

    expect((await bulkRequest(app, env, 700, {}, { agentPaused: true })).status).toBe(401);

    const { token } = await createSessionForGitHubUser(env, { login: "nobody", id: 71 });
    const forbidden = await bulkRequest(app, env, 700, cookie(token), { agentPaused: true });
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toMatchObject({ error: "insufficient_role" });
  });

  it("rejects a non-numeric installation id, an unknown installation, and a malformed body", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
    await seedInstallation(env, 700, "tenant-a");
    const { token } = await createSessionForGitHubUser(env, { login: "tenant-a", id: 5701 });

    const invalidId = await bulkRequest(app, env, "not-a-number", cookie(token), { agentPaused: true });
    expect(invalidId.status).toBe(400);
    await expect(invalidId.json()).resolves.toMatchObject({ error: "invalid_installation_id" });

    const missing = await bulkRequest(app, env, 999, cookie(token), { agentPaused: true });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ error: "installation_not_found" });

    const malformed = await bulkRequest(app, env, 700, cookie(token), { agentPaused: "not-a-boolean" });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({ error: "invalid_bulk_agent_settings" });

    // An unrecognized field is rejected outright (.strict()), not silently dropped.
    const extraField = await bulkRequest(app, env, 700, cookie(token), { agentPaused: true, gatePack: "oss-anti-slop" });
    expect(extraField.status).toBe(400);

    // Genuinely unparseable JSON (not just schema-invalid) -- the .catch(() => null) arm.
    const unparseable = await app.request(
      "/v1/app/installations/700/agent/bulk-settings",
      { method: "PUT", headers: { "content-type": "application/json", ...cookie(token) }, body: "{not valid json" },
      env,
    );
    expect(unparseable.status).toBe(400);
    await expect(unparseable.json()).resolves.toMatchObject({ error: "invalid_bulk_agent_settings" });
  });

  it("never lets tenant A bulk-pause tenant B's installation", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
    await seedInstallation(env, 700, "tenant-a");
    await seedInstallation(env, 800, "tenant-b");
    await seedInstalledRepo(env, 800, "tenant-b", "repo-1");
    const { token: tokenA } = await createSessionForGitHubUser(env, { login: "tenant-a", id: 5701 });

    const foreign = await bulkRequest(app, env, 800, cookie(tokenA), { agentPaused: true });
    expect(foreign.status).toBe(403);
    await expect(foreign.json()).resolves.toMatchObject({ error: "forbidden_installation" });

    // Confirms the 403 is enforced BEFORE any write: tenant-b's repo settings are completely untouched.
    expect((await getRepositorySettings(env, "tenant-b/repo-1")).agentPaused).toBe(false);
  });

  it("applies agentPaused/agentDryRun across every installed repo in the tenant's own installation, and only those repos", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
    await seedInstallation(env, 700, "tenant-a");
    await seedInstalledRepo(env, 700, "tenant-a", "repo-1");
    await seedInstalledRepo(env, 700, "tenant-a", "repo-2");
    // A second, unrelated installation -- proves the bulk write is scoped to installation 700 only.
    await seedInstallation(env, 800, "tenant-b");
    await seedInstalledRepo(env, 800, "tenant-b", "repo-3");
    const { token: tokenA } = await createSessionForGitHubUser(env, { login: "tenant-a", id: 5701 });

    const res = await bulkRequest(app, env, 700, cookie(tokenA), { agentPaused: true, agentDryRun: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; installationId: number; repoCount: number; repoFullNames: string[]; applied: object };
    expect(body).toMatchObject({ ok: true, installationId: 700, repoCount: 2, applied: { agentPaused: true, agentDryRun: true } });
    expect(body.repoFullNames.sort()).toEqual(["tenant-a/repo-1", "tenant-a/repo-2"]);

    expect((await getRepositorySettings(env, "tenant-a/repo-1")).agentPaused).toBe(true);
    expect((await getRepositorySettings(env, "tenant-a/repo-1")).agentDryRun).toBe(true);
    expect((await getRepositorySettings(env, "tenant-a/repo-2")).agentPaused).toBe(true);
    // The unrelated installation's repo is completely untouched.
    expect((await getRepositorySettings(env, "tenant-b/repo-3")).agentPaused).toBe(false);
  });

  it("supports setting only one of the two flags, preserving the other's existing value", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
    await seedInstallation(env, 700, "tenant-a");
    await seedInstalledRepo(env, 700, "tenant-a", "repo-1");
    // repo-1 already has agentDryRun on from an earlier per-repo edit, before any bulk call.
    const current = await getRepositorySettings(env, "tenant-a/repo-1");
    await upsertRepositorySettings(env, { ...current, agentDryRun: true, repoFullName: "tenant-a/repo-1" });
    const { token: tokenA } = await createSessionForGitHubUser(env, { login: "tenant-a", id: 5701 });

    const res = await bulkRequest(app, env, 700, cookie(tokenA), { agentPaused: true });
    expect(res.status).toBe(200);

    const updated = await getRepositorySettings(env, "tenant-a/repo-1");
    expect(updated.agentPaused).toBe(true);
    expect(updated.agentDryRun).toBe(true); // untouched -- the omitted field was never overwritten to false
  });

  it("succeeds as a no-op for an installation with zero currently-installed repos", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
    await seedInstallation(env, 700, "tenant-a");
    const { token: tokenA } = await createSessionForGitHubUser(env, { login: "tenant-a", id: 5701 });

    const res = await bulkRequest(app, env, 700, cookie(tokenA), { agentPaused: true });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, repoCount: 0, repoFullNames: [] });
  });

  it("lets an operator (static api token) bulk-pause any tenant's installation, with a distinct audit event", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
    await seedInstallation(env, 800, "tenant-b");
    await seedInstalledRepo(env, 800, "tenant-b", "repo-3");

    const res = await bulkRequest(app, env, 800, apiHeaders(env), { agentDryRun: true });
    expect(res.status).toBe(200);
    expect((await getRepositorySettings(env, "tenant-b/repo-3")).agentDryRun).toBe(true);

    const events = await env.DB.prepare("SELECT event_type, target_key, actor FROM audit_events WHERE event_type = ?")
      .bind("installation.agent_bulk_settings_updated")
      .all<{ event_type: string; target_key: string; actor: string }>();
    expect(events.results).toHaveLength(1);
    expect(events.results[0]).toMatchObject({ target_key: "installation#800", actor: "api" });
  });
});

function generateRsaPrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}
