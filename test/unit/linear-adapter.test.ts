import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { findLinearNativeLink, LinearAdapter } from "../../src/integrations/linear-adapter";
import { maybeSuggestProjectOrMilestoneMatch } from "../../src/integrations/project-tracker-adapter";
import { upsertRepositoryLinearKey } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

const SECRET = "example-unit-test-encryption-secret-32-bytes-long";
const PR_URL = "https://github.com/JSONbored/gittensory/pull/4";

function generateRsaPrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}

function suggestTestEnv() {
  return createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET, GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
}

describe("LinearAdapter (#3186)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("listOpenProjects returns an empty list when no Linear key is configured, without making a network call", async () => {
    let called = false;
    vi.stubGlobal("fetch", async () => {
      called = true;
      return new Response("unexpected", { status: 500 });
    });
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const adapter = new LinearAdapter();
    await expect(adapter.listOpenProjects({ env, installationId: 123, repoFullName: "acme/widgets" })).resolves.toEqual([]);
    expect(called).toBe(false);
  });

  it("listOpenProjects sends the raw key (no Bearer prefix) and maps open projects", async () => {
    let authHeader: string | null = null;
    let requestBody: unknown;
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await upsertRepositoryLinearKey(env, { repoFullName: "acme/widgets", key: "lin_api_test_key" });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      expect(url).toBe("https://api.linear.app/graphql");
      authHeader = (init?.headers as Record<string, string>)?.Authorization ?? null;
      requestBody = JSON.parse(String(init?.body ?? "{}"));
      return Response.json({ data: { projects: { nodes: [{ id: "proj-1", name: "Self-host reliability roadmap" }], pageInfo: { hasNextPage: false, endCursor: null } } } });
    });
    const adapter = new LinearAdapter();
    const result = await adapter.listOpenProjects({ env, installationId: 123, repoFullName: "acme/widgets" });
    expect(authHeader).toBe("lin_api_test_key");
    expect(requestBody).toMatchObject({ variables: { statusTypes: ["backlog", "planned", "started", "paused"] } });
    expect(result).toEqual([{ id: "proj-1", title: "Self-host reliability roadmap" }]);
  });

  it("listOpenProjects follows cursor pagination across multiple pages", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await upsertRepositoryLinearKey(env, { repoFullName: "acme/widgets", key: "lin_api_test_key" });
    let requestCount = 0;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestCount += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as { variables?: { after?: string | null } };
      if (!body.variables?.after) {
        return Response.json({ data: { projects: { nodes: [{ id: "proj-1", name: "Page one" }], pageInfo: { hasNextPage: true, endCursor: "cursor-2" } } } });
      }
      return Response.json({ data: { projects: { nodes: [{ id: "proj-2", name: "Page two" }], pageInfo: { hasNextPage: false, endCursor: null } } } });
    });
    const adapter = new LinearAdapter();
    const result = await adapter.listOpenProjects({ env, installationId: 123, repoFullName: "acme/widgets" });
    expect(requestCount).toBe(2);
    expect(result).toEqual([
      { id: "proj-1", title: "Page one" },
      { id: "proj-2", title: "Page two" },
    ]);
  });

  it("listOpenProjects throws on a Linear API error (propagated for the caller's best-effort handling)", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await upsertRepositoryLinearKey(env, { repoFullName: "acme/widgets", key: "lin_api_test_key" });
    vi.stubGlobal("fetch", async () => Response.json({ errors: [{ message: "invalid API key" }] }));
    const adapter = new LinearAdapter();
    await expect(adapter.listOpenProjects({ env, installationId: 123, repoFullName: "acme/widgets" })).rejects.toThrow(/invalid API key/);
  });

  it("listOpenProjects throws on an HTTP-level failure", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await upsertRepositoryLinearKey(env, { repoFullName: "acme/widgets", key: "lin_api_test_key" });
    vi.stubGlobal("fetch", async () => new Response("Service Unavailable", { status: 503 }));
    const adapter = new LinearAdapter();
    await expect(adapter.listOpenProjects({ env, installationId: 123, repoFullName: "acme/widgets" })).rejects.toThrow(/Linear API HTTP 503/);
  });

  it("listOpenProjects throws when the response has no errors but also no data (malformed response)", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await upsertRepositoryLinearKey(env, { repoFullName: "acme/widgets", key: "lin_api_test_key" });
    vi.stubGlobal("fetch", async () => Response.json({}));
    const adapter = new LinearAdapter();
    await expect(adapter.listOpenProjects({ env, installationId: 123, repoFullName: "acme/widgets" })).rejects.toThrow(/Linear API returned no data/);
  });

  it("listOpenMilestones, attachToProject, and attachToMilestone are inert placeholders", async () => {
    const adapter = new LinearAdapter();
    await expect(adapter.listOpenMilestones()).resolves.toEqual([]);
    await expect(adapter.attachToProject()).resolves.toEqual({ attached: false });
    await expect(adapter.attachToMilestone()).resolves.toEqual({ attached: false });
  });
});

describe("findLinearNativeLink (#3186)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns nulls when no Linear key is configured", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const result = await findLinearNativeLink({ env, installationId: 123, repoFullName: "acme/widgets" }, PR_URL);
    expect(result).toEqual({ project: null, milestone: null });
  });

  it("finds a native-linked issue's project and milestone via attachmentsForURL", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await upsertRepositoryLinearKey(env, { repoFullName: "acme/widgets", key: "lin_api_test_key" });
    let queriedUrl: string | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { variables?: { url?: string } };
      queriedUrl = body.variables?.url;
      return Response.json({
        data: {
          attachmentsForURL: {
            nodes: [{ issue: { project: { id: "proj-1", name: "Self-host reliability roadmap" }, projectMilestone: { id: "mile-1", name: "M3" } } }],
          },
        },
      });
    });
    const result = await findLinearNativeLink({ env, installationId: 123, repoFullName: "acme/widgets" }, PR_URL);
    expect(queriedUrl).toBe(PR_URL);
    expect(result).toEqual({
      project: { item: { id: "proj-1", title: "Self-host reliability roadmap" }, source: "native", score: 1, shared: 0 },
      milestone: { item: { id: "mile-1", title: "M3" }, source: "native", score: 1, shared: 0 },
    });
  });

  it("returns nulls when the linked issue has no project or milestone", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await upsertRepositoryLinearKey(env, { repoFullName: "acme/widgets", key: "lin_api_test_key" });
    vi.stubGlobal("fetch", async () => Response.json({ data: { attachmentsForURL: { nodes: [{ issue: { project: null, projectMilestone: null } }] } } }));
    const result = await findLinearNativeLink({ env, installationId: 123, repoFullName: "acme/widgets" }, PR_URL);
    expect(result).toEqual({ project: null, milestone: null });
  });

  it("returns nulls when no attachment matches this PR URL", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await upsertRepositoryLinearKey(env, { repoFullName: "acme/widgets", key: "lin_api_test_key" });
    vi.stubGlobal("fetch", async () => Response.json({ data: { attachmentsForURL: { nodes: [] } } }));
    const result = await findLinearNativeLink({ env, installationId: 123, repoFullName: "acme/widgets" }, PR_URL);
    expect(result).toEqual({ project: null, milestone: null });
  });

  it("degrades to nulls (never throws) on a Linear API error -- best-effort", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await upsertRepositoryLinearKey(env, { repoFullName: "acme/widgets", key: "lin_api_test_key" });
    vi.stubGlobal("fetch", async () => new Response("Service Unavailable", { status: 503 }));
    await expect(findLinearNativeLink({ env, installationId: 123, repoFullName: "acme/widgets" }, PR_URL)).resolves.toEqual({ project: null, milestone: null });
  });
});

describe("maybeSuggestProjectOrMilestoneMatch with backend: linear (#3186)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("native-link-present path: prefers the confirmed Linear link and never calls listOpenProjects at all", async () => {
    const env = suggestTestEnv();
    await upsertRepositoryLinearKey(env, { repoFullName: "JSONbored/gittensory", key: "lin_api_test_key" });
    let projectsListed = false;
    const posted: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url === "https://api.linear.app/graphql") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { query: string };
        if (body.query.includes("attachmentsForURL")) {
          return Response.json({ data: { attachmentsForURL: { nodes: [{ issue: { project: { id: "proj-1", name: "Self-host reliability roadmap" }, projectMilestone: null } }] } } });
        }
        projectsListed = true;
        return Response.json({ data: { projects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
      }
      if (url.includes("/issues/4/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/4/comments") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { body?: string };
        posted.push(body.body ?? "");
        return Response.json({ id: 1 });
      }
      return new Response("unexpected", { status: 500 });
    });
    const result = await maybeSuggestProjectOrMilestoneMatch(
      { env, installationId: 123, repoFullName: "JSONbored/gittensory" },
      4,
      "any title at all -- irrelevant, the native link bypasses fuzzy matching entirely",
      null,
      "linear",
      PR_URL,
    );
    expect(result).toEqual({ suggested: true });
    expect(projectsListed).toBe(false);
    expect(posted[0]).toContain("linked to");
    expect(posted[0]).toContain("Self-host reliability roadmap");
    expect(posted[0]).not.toContain("term overlap");
  });

  it("fallback-matching path: no native link found -- fuzzy-matches against Linear's open projects", async () => {
    const env = suggestTestEnv();
    await upsertRepositoryLinearKey(env, { repoFullName: "JSONbored/gittensory", key: "lin_api_test_key" });
    const posted: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url === "https://api.linear.app/graphql") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { query: string };
        if (body.query.includes("attachmentsForURL")) return Response.json({ data: { attachmentsForURL: { nodes: [] } } });
        return Response.json({ data: { projects: { nodes: [{ id: "proj-1", name: "Self-host reliability roadmap" }], pageInfo: { hasNextPage: false, endCursor: null } } } });
      }
      if (url.includes("/issues/4/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/4/comments") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { body?: string };
        posted.push(body.body ?? "");
        return Response.json({ id: 1 });
      }
      return new Response("unexpected", { status: 500 });
    });
    const result = await maybeSuggestProjectOrMilestoneMatch(
      { env, installationId: 123, repoFullName: "JSONbored/gittensory" },
      4,
      "Improve self-host reliability roadmap convergence",
      "Follow-up on the self-host reliability roadmap work",
      "linear",
      PR_URL,
    );
    expect(result).toEqual({ suggested: true });
    expect(posted[0]).toContain("term overlap");
    expect(posted[0]).toContain("Self-host reliability roadmap");
  });

  it("API-error best-effort path: a Linear outage propagates to the caller instead of silently mismatching", async () => {
    const env = suggestTestEnv();
    await upsertRepositoryLinearKey(env, { repoFullName: "JSONbored/gittensory", key: "lin_api_test_key" });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      // attachmentsForURL degrades gracefully (findLinearNativeLink's own .catch), but the FALLBACK
      // listOpenProjects call has no such guard -- it throws, and the caller (maybeSuggestMilestoneMatchForPr)
      // is responsible for the outer best-effort catch, exactly like a GitHub API outage would.
      return new Response("Service Unavailable", { status: 503 });
    });
    await expect(
      maybeSuggestProjectOrMilestoneMatch(
        { env, installationId: 123, repoFullName: "JSONbored/gittensory" },
        4,
        "Improve self-host reliability roadmap convergence",
        null,
        "linear",
        PR_URL,
      ),
    ).rejects.toThrow(/Linear API HTTP 503/);
  });
});
