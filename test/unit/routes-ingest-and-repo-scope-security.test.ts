import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { upsertInstallation, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

function stubMinerDetection(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    if (input.toString().includes("gittensor.io")) return Response.json([]);
    return new Response("not found", { status: 404 });
  });
}

async function seedRepoWithPr(env: Env, owner: string, name: string, installationId: number): Promise<void> {
  await upsertInstallation(env, {
    installation: {
      id: installationId,
      account: { login: owner, id: installationId, type: "User" },
      repository_selection: "selected",
      permissions: { metadata: "read" },
      events: ["repository"],
    },
  });
  await upsertRepositoryFromGitHub(env, { name, full_name: `${owner}/${name}`, private: false, owner: { login: owner } }, installationId);
  await upsertPullRequestFromGitHub(env, `${owner}/${name}`, {
    number: 1,
    title: "PR",
    state: "open",
    user: { login: "contributor" },
    head: { sha: "h1" },
    labels: [],
    body: "x",
  });
}

// #9045: the maintainer-packet route gated only on `requireStaticProtectedApiToken`, which admits ANY static
// identity including the shared, end-user-obtainable `mcp` token, and never checked the read allowlist. Its
// three sibling repo-scoped routes did. Since MCP_READ_REPO_ALLOWLIST is fail-closed by default (unset ⇒ deny
// all), the intended posture was "deny everything" while this route returned the FULL packet — every issue,
// PR, file, review, and check summary — for any repo. The MCP tool it mirrors already denied exactly this.
describe("repo-scoped static-token routes honor MCP_READ_REPO_ALLOWLIST (#9045)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const ROUTES = [
    "/v1/repos/alice/repo-a/pulls/1/maintainer-packet",
    "/v1/repos/alice/repo-a/pulls/1/reviewability",
    "/v1/repos/alice/repo-a/gate-config/effective",
    "/v1/repos/alice/repo-a/live-gate-thresholds",
  ];

  it("denies the shared mcp token on every repo-scoped route when the repo is not allowlisted", async () => {
    const app = createApp();
    const env = createTestEnv({ MCP_READ_REPO_ALLOWLIST: "", LOOPOVER_MCP_TOKEN: "test-mcp-token" });
    await seedRepoWithPr(env, "alice", "repo-a", 101);
    stubMinerDetection();

    for (const route of ROUTES) {
      const res = await app.request(route, { headers: { authorization: "Bearer test-mcp-token" } }, env);
      expect({ route, status: res.status }).toEqual({ route, status: 403 });
      expect(await res.json()).toMatchObject({ error: "forbidden_repo" });
    }
  });

  it("admits the mcp token on those same routes once the repo IS allowlisted (the guard scopes, it does not blanket-deny)", async () => {
    const app = createApp();
    const env = createTestEnv({ MCP_READ_REPO_ALLOWLIST: "alice/repo-a", LOOPOVER_MCP_TOKEN: "test-mcp-token" });
    await seedRepoWithPr(env, "alice", "repo-a", 101);
    stubMinerDetection();

    for (const route of ROUTES) {
      const res = await app.request(route, { headers: { authorization: "Bearer test-mcp-token" } }, env);
      expect({ route, forbidden: res.status === 403 }).toEqual({ route, forbidden: false });
    }
  });

  it("keeps operator-only tokens unscoped — the allowlist narrows the shared mcp token only", async () => {
    const app = createApp();
    const env = createTestEnv({ MCP_READ_REPO_ALLOWLIST: "", LOOPOVER_API_TOKEN: "test-api-token" });
    await seedRepoWithPr(env, "alice", "repo-a", 101);
    stubMinerDetection();

    const res = await app.request(ROUTES[0]!, { headers: { authorization: "Bearer test-api-token" } }, env);
    expect(res.status).not.toBe(403);
  });
});

// #9046: both collector endpoints returned `true` for an UNSET token — the shipped default — so anyone with
// network access could POST batches, and Orb's batches feed the published accuracy numbers. They were separate
// near-identical copies, which is how AMS ended up both fail-open and (separately) missing from the strict
// rate class; they are now one shared helper.
describe("telemetry ingest endpoints fail closed when their token is unset (#9046)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const BODY = JSON.stringify({ instance_id: "i1", batch: [] });

  it("rejects Orb ingest when ORB_INGEST_TOKEN is unset, instead of accepting anonymous writes", async () => {
    const app = createApp();
    const env = createTestEnv();
    delete (env as { ORB_INGEST_TOKEN?: string }).ORB_INGEST_TOKEN;
    const res = await app.request("/v1/orb/ingest", { method: "POST", body: BODY, headers: { "content-type": "application/json" } }, env);
    expect(res.status).toBe(401);
  });

  it("rejects AMS ingest when AMS_INGEST_TOKEN is unset (the copy that had drifted)", async () => {
    const app = createApp();
    const env = createTestEnv();
    delete (env as { AMS_INGEST_TOKEN?: string }).AMS_INGEST_TOKEN;
    const res = await app.request("/v1/ams/ingest", { method: "POST", body: BODY, headers: { "content-type": "application/json" } }, env);
    expect(res.status).toBe(401);
  });

  it("still rejects a WRONG bearer when the token IS configured, and stops rejecting once it matches", async () => {
    const app = createApp();
    for (const [path, key] of [["/v1/orb/ingest", "ORB_INGEST_TOKEN"], ["/v1/ams/ingest", "AMS_INGEST_TOKEN"]] as const) {
      const env = createTestEnv({ [key]: "s3cret" } as Partial<Env>);
      const wrong = await app.request(path, { method: "POST", body: BODY, headers: { authorization: "Bearer nope", "content-type": "application/json" } }, env);
      expect({ path, status: wrong.status }).toEqual({ path, status: 401 });
      const right = await app.request(path, { method: "POST", body: BODY, headers: { authorization: "Bearer s3cret", "content-type": "application/json" } }, env);
      expect({ path, unauthorized: right.status === 401 }).toEqual({ path, unauthorized: false });
    }
  });
});
