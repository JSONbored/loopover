import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { getDb } from "../../src/db/client";
import { repositoryLinearKeys } from "../../src/db/schema";
import {
  deleteRepositoryLinearKey,
  getDecryptedRepositoryLinearKey,
  getRepositoryLinearKeyStatus,
  upsertRepositoryLinearKey,
  upsertInstallation,
  upsertPullRequestFromGitHub,
  upsertRepositoryFromGitHub,
} from "../../src/db/repositories";
import { getRepositoryCollaboratorPermission } from "../../src/github/app";
import { createTestEnv } from "../helpers/d1";

// The route's write-access gate (requireRepoWriteAccess) resolves real GitHub push permission via the
// installation; mock just that call (mirrors test/unit/routes-ai-byok.test.ts) so the per-repo write check is
// deterministic here without a real GitHub round-trip.
vi.mock("../../src/github/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/github/app")>()),
  getRepositoryCollaboratorPermission: vi.fn(),
}));
const mockedPermission = vi.mocked(getRepositoryCollaboratorPermission);

const SECRET = "example-unit-test-encryption-secret-32-bytes-long";

async function seedRepo(env: Env, owner: string, name: string, installationId: number): Promise<void> {
  await upsertInstallation(env, {
    installation: { id: installationId, account: { login: owner, id: installationId, type: "User" }, repository_selection: "selected", permissions: { metadata: "read" }, events: ["repository"] },
  });
  await upsertRepositoryFromGitHub(env, { name, full_name: `${owner}/${name}`, private: false, owner: { login: owner } }, installationId);
  await env.DB.prepare("UPDATE repositories SET is_registered = 1 WHERE full_name = ?").bind(`${owner}/${name}`).run();
}

describe("repository Linear key storage (#3186)", () => {
  it("stores an encrypted key, exposes only secret-free status, and decrypts at call time", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await expect(getRepositoryLinearKeyStatus(env, "acme/widgets")).resolves.toEqual({ configured: false });

    const status = await upsertRepositoryLinearKey(env, { repoFullName: "acme/widgets", key: "lin_api_abc123XYZ7890", createdBy: "maintainer" });
    expect(status).toMatchObject({ configured: true, last4: "7890", createdBy: "maintainer" });
    expect(status.configured && status.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Status surface never includes the key or ciphertext, but does surface who set it + when.
    const fetched = await getRepositoryLinearKeyStatus(env, "acme/widgets");
    expect(JSON.stringify(fetched)).not.toContain("lin_api");
    expect(fetched).toMatchObject({ configured: true, last4: "7890", createdBy: "maintainer" });

    // Decrypt only happens at call time.
    await expect(getDecryptedRepositoryLinearKey(env, "acme/widgets")).resolves.toBe("lin_api_abc123XYZ7890");

    // The persisted row stores ciphertext, never the plaintext key.
    const row = await env.DB.prepare("select ciphertext, iv, last4 from repository_linear_keys where repo_full_name = ?").bind("acme/widgets").first<{ ciphertext: string; iv: string; last4: string }>();
    expect(row?.ciphertext).not.toContain("lin_api");
    expect(row?.last4).toBe("7890");
  });

  it("replaces a key on re-set and removes it on delete", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await upsertRepositoryLinearKey(env, { repoFullName: "acme/widgets", key: "lin_api_first0000" });
    await upsertRepositoryLinearKey(env, { repoFullName: "acme/widgets", key: "lin_api_second1111" });
    await expect(getRepositoryLinearKeyStatus(env, "acme/widgets")).resolves.toMatchObject({ configured: true, last4: "1111" });
    await deleteRepositoryLinearKey(env, "acme/widgets");
    await expect(getRepositoryLinearKeyStatus(env, "acme/widgets")).resolves.toEqual({ configured: false });
    await expect(getDecryptedRepositoryLinearKey(env, "acme/widgets")).resolves.toBeNull();
  });

  it("audits the key lifecycle (set → replace → delete) without ever recording key material", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await upsertRepositoryLinearKey(env, { repoFullName: "acme/widgets", key: "lin_api_first_key_0000", createdBy: "alice" });
    await upsertRepositoryLinearKey(env, { repoFullName: "acme/widgets", key: "lin_api_second_key_1111", createdBy: "bob" });
    await deleteRepositoryLinearKey(env, "acme/widgets", "carol");

    const events = await env.DB.prepare("select actor, detail, metadata_json from audit_events where event_type = ? order by rowid asc").bind("linear_key_change").all<{ actor: string; detail: string; metadata_json: string }>();
    expect(events.results.map((e) => JSON.parse(e.metadata_json).action)).toEqual(["set", "replace", "delete"]);
    expect(events.results.map((e) => e.actor)).toEqual(["alice", "bob", "carol"]);
    // Audit rows never contain key material — only the display-only last4.
    const blob = JSON.stringify(events.results);
    expect(blob).not.toContain("lin_api");

    // A delete with no key present records nothing.
    await deleteRepositoryLinearKey(env, "acme/widgets", "carol");
    const after = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("linear_key_change").first<{ n: number }>();
    expect(after?.n).toBe(3);
  });

  it("stores real ISO timestamps when created_at/updated_at are omitted (no literal default)", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const db = getDb(env.DB);
    await db.insert(repositoryLinearKeys).values({ repoFullName: "acme/widgets", ciphertext: "ct", iv: "iv", last4: "7890" });
    const [row] = await db.select().from(repositoryLinearKeys).where(eq(repositoryLinearKeys.repoFullName, "acme/widgets")).limit(1);
    expect(row?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(row?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(row?.createdAt).not.toBe("CURRENT_TIMESTAMP");
  });

  it("refuses to store a key and cannot decrypt without the encryption secret", async () => {
    const noSecret = createTestEnv({});
    await expect(upsertRepositoryLinearKey(noSecret, { repoFullName: "acme/widgets", key: "lin_api_xyz1234567" })).rejects.toThrow("missing_encryption_secret");
    const withSecret = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await upsertRepositoryLinearKey(withSecret, { repoFullName: "acme/widgets", key: "lin_api_abc1234567" });
    const sameDbNoSecret = { ...withSecret, TOKEN_ENCRYPTION_SECRET: undefined } as unknown as Env;
    await expect(getDecryptedRepositoryLinearKey(sameDbNoSecret, "acme/widgets")).resolves.toBeNull();
    const wrongSecret = { ...withSecret, TOKEN_ENCRYPTION_SECRET: "totally-different-example-secret-32-bytes-min" } as unknown as Env;
    await expect(getDecryptedRepositoryLinearKey(wrongSecret, "acme/widgets")).resolves.toBeNull();
  });
});

describe("Linear key internal API routes (#3186)", () => {
  function authHeaders(env: Env) {
    return { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}`, "content-type": "application/json" };
  }

  it("POST stores, GET returns secret-free status, DELETE removes — key never echoed", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });

    const post = await app.request(
      "/v1/internal/repos/acme/widgets/linear-key",
      { method: "POST", headers: authHeaders(env), body: JSON.stringify({ key: "lin_api_route-key-7777" }) },
      env,
    );
    expect(post.status).toBe(200);
    const postBody = await post.json();
    expect(postBody).toMatchObject({ configured: true, last4: "7777" });
    expect(JSON.stringify(postBody)).not.toContain("lin_api");

    const get = await app.request("/v1/internal/repos/acme/widgets/linear-key", { headers: authHeaders(env) }, env);
    expect(await get.json()).toMatchObject({ configured: true, last4: "7777" });

    const del = await app.request("/v1/internal/repos/acme/widgets/linear-key", { method: "DELETE", headers: authHeaders(env) }, env);
    expect(await del.json()).toEqual({ configured: false });
    const getAfter = await app.request("/v1/internal/repos/acme/widgets/linear-key", { headers: authHeaders(env) }, env);
    expect(await getAfter.json()).toEqual({ configured: false });
  });

  it("rejects an invalid key payload and reports when encryption is unavailable", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const bad = await app.request("/v1/internal/repos/acme/widgets/linear-key", { method: "POST", headers: authHeaders(env), body: JSON.stringify({ key: "short" }) }, env);
    expect(bad.status).toBe(400);

    const noSecretEnv = createTestEnv({});
    const unavailable = await app.request(
      "/v1/internal/repos/acme/widgets/linear-key",
      { method: "POST", headers: authHeaders(noSecretEnv), body: JSON.stringify({ key: "lin_api_valid-key-123456" }) },
      noSecretEnv,
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ error: "encryption_unavailable" });
  });

  it("re-throws a non-encryption error instead of swallowing it (e.g. a genuine DB failure)", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await env.DB.prepare("DROP TABLE repository_linear_keys").run();
    const res = await app.request("/v1/internal/repos/acme/widgets/linear-key", { method: "POST", headers: authHeaders(env), body: JSON.stringify({ key: "lin_api_valid-key-123456" }) }, env);
    expect(res.status).toBe(500);
  });
});

describe("maintainer Linear key route (session/API-token scoped, #3186)", () => {
  const REPO = "acme/widgets";

  afterEach(() => vi.unstubAllGlobals());

  function apiHeaders(env: Env): Record<string, string> {
    return { authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`, "content-type": "application/json" };
  }

  it("POST stores, GET returns secret-free status, DELETE removes — key never echoed", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const post = await app.request(`/v1/repos/${REPO}/linear-key`, { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ key: "lin_api_route-key-7777" }) }, env);
    expect(post.status).toBe(200);
    const body = await post.json();
    expect(body).toMatchObject({ configured: true, last4: "7777" });
    expect(JSON.stringify(body)).not.toContain("lin_api");

    const get = await app.request(`/v1/repos/${REPO}/linear-key`, { headers: apiHeaders(env) }, env);
    expect(await get.json()).toMatchObject({ configured: true, last4: "7777" });

    const del = await app.request(`/v1/repos/${REPO}/linear-key`, { method: "DELETE", headers: apiHeaders(env) }, env);
    expect(await del.json()).toEqual({ configured: false });
    expect(await (await app.request(`/v1/repos/${REPO}/linear-key`, { headers: apiHeaders(env) }, env)).json()).toEqual({ configured: false });
  });

  it("rejects an invalid key payload (400)", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const res = await app.request(`/v1/repos/${REPO}/linear-key`, { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ key: "short" }) }, env);
    expect(res.status).toBe(400);
  });

  it("re-throws a non-encryption error instead of swallowing it (e.g. a genuine DB failure)", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    // Drop the table so the real INSERT throws a genuine SQL error -- NOT "missing_encryption_secret" -- to
    // exercise the route's re-throw branch authentically rather than mocking the repository function. Hono's
    // default error boundary turns an uncaught throw into a 500, rather than propagating a rejection.
    await env.DB.prepare("DROP TABLE repository_linear_keys").run();
    const res = await app.request(`/v1/repos/${REPO}/linear-key`, { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ key: "lin_api_valid-key-123456" }) }, env);
    expect(res.status).toBe(500);
  });

  it("reports 503 when key storage (encryption secret) is unavailable", async () => {
    const app = createApp();
    const env = createTestEnv({});
    const res = await app.request(`/v1/repos/${REPO}/linear-key`, { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ key: "lin_api_valid-key-123456" }) }, env);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "encryption_unavailable" });
  });

  it("rejects unauthenticated access on every method", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const get = await app.request(`/v1/repos/${REPO}/linear-key`, {}, env);
    expect(get.status).toBe(401);
    const post = await app.request(`/v1/repos/${REPO}/linear-key`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "lin_api_x" }) }, env);
    expect(post.status).toBe(401);
    const del = await app.request(`/v1/repos/${REPO}/linear-key`, { method: "DELETE" }, env);
    expect(del.status).toBe(401);
  });

  it("allows the repo owner (admin permission) via session to set and delete a Linear key, recording the actor", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input.toString().includes("gittensor.io")) return Response.json([]);
      return new Response("not found", { status: 404 });
    });
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET, ADMIN_GITHUB_LOGINS: "" });
    await seedRepo(env, "repo-owner", "owned-repo", 201);
    mockedPermission.mockResolvedValue("admin"); // real GitHub write access
    const { token } = await createSessionForGitHubUser(env, { login: "repo-owner", id: 201 });
    const owned = "/v1/repos/repo-owner/owned-repo/linear-key";
    const cookie = { cookie: `gittensory_session=${token}` };
    const res = await app.request(owned, { method: "POST", headers: { ...cookie, "content-type": "application/json" }, body: JSON.stringify({ key: "lin_api_owner-key-4242" }) }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ configured: true, last4: "4242", createdBy: "repo-owner" });

    const del = await app.request(owned, { method: "DELETE", headers: cookie }, env);
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ configured: false });
  });

  it("forbids a read-only collaborator (real GitHub session, insufficient repo permission) on every method", async () => {
    mockedPermission.mockReset();
    // Role resolution (loadControlPanelRoleSummary) makes a miner-detection fetch; stub it so session role
    // derivation is deterministic (mirrors test/unit/routes-ai-byok.test.ts's stubMinerFetch).
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input.toString().includes("gittensor.io")) return Response.json([]);
      return new Response("not found", { status: 404 });
    });
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET, ADMIN_GITHUB_LOGINS: "" });
    await seedRepo(env, "repo-owner", "owned-repo", 201);
    // "reader" authored a PR as COLLABORATOR -> in maintainer scope, but only has read GitHub permission
    // (mirrors test/unit/routes-ai-byok.test.ts's equivalent authz test for the ai-key routes).
    await upsertPullRequestFromGitHub(env, "repo-owner/owned-repo", { number: 5, title: "tweak", state: "open", user: { login: "reader" }, author_association: "COLLABORATOR", head: { sha: "a1", ref: "f" }, base: { ref: "main" }, labels: [] });
    mockedPermission.mockResolvedValue("read"); // real GitHub access, but not write/admin
    const { token } = await createSessionForGitHubUser(env, { login: "reader", id: 777 });
    const json = { cookie: `gittensory_session=${token}`, "content-type": "application/json" };
    const owned = "/v1/repos/repo-owner/owned-repo/linear-key";

    const get = await app.request(owned, { headers: { cookie: `gittensory_session=${token}` } }, env);
    expect(get.status).toBe(403);
    expect(await get.json()).toMatchObject({ error: "insufficient_repo_permission" });

    const post = await app.request(owned, { method: "POST", headers: json, body: JSON.stringify({ key: "lin_api_reader-key-9999" }) }, env);
    expect(post.status).toBe(403);
    expect(await post.json()).toMatchObject({ error: "insufficient_repo_permission" });

    const del = await app.request(owned, { method: "DELETE", headers: { cookie: `gittensory_session=${token}` } }, env);
    expect(del.status).toBe(403);
    expect(await del.json()).toMatchObject({ error: "insufficient_repo_permission" });
  });
});
