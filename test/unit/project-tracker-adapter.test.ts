import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  GitHubMilestonesAdapter,
  GitHubProjectsAdapter,
  GitHubCompositeProjectTrackerAdapter,
  createProjectTrackerAdapter,
  PROJECT_TRACKER_SUGGEST_COMMENT_MARKER,
  maybeSuggestMilestoneMatchForPr,
  maybeSuggestProjectOrMilestoneMatch,
  matchOpenTrackerItems,
  resolveProjectV2Fields,
  type ProjectTrackerRef,
} from "../../src/integrations/project-tracker-adapter";
import { LinearAdapter } from "../../src/integrations/linear-adapter";
import { upsertRepositoryLinearKey } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

function generateRsaPrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}

/** A GraphQL response reporting zero open projects (a User-owned repo, or an Organization with none) --
 *  the shape most milestone-focused tests below need so the parallel Projects v2 lookup never interferes. */
function noOpenProjectsGraphQlBody(): unknown {
  return { data: { repositoryOwner: { __typename: "User" } } };
}

const SECRET = "example-unit-test-encryption-secret-32-bytes-long";
const PR_URL = "https://github.com/JSONbored/gittensory/pull/4";

function suggestTestEnv() {
  return createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET, GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
}

describe("createProjectTrackerAdapter (#3186)", () => {
  it("returns a LinearAdapter for the linear backend", () => {
    const adapter = createProjectTrackerAdapter("linear");
    expect(adapter).toBeInstanceOf(LinearAdapter);
  });

  it("returns a GitHub composite adapter for the github backend and for null/undefined", () => {
    for (const backend of ["github", null, undefined] as const) {
      const adapter = createProjectTrackerAdapter(backend);
      expect(adapter).toBeInstanceOf(GitHubCompositeProjectTrackerAdapter);
    }
  });
});

describe("GitHubCompositeProjectTrackerAdapter (#3186)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delegates listOpenMilestones to GitHubMilestonesAdapter", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/milestones")) return Response.json([{ number: 14, title: "Self-host reliability roadmap" }]);
      return new Response("unexpected", { status: 500 });
    });
    const adapter = new GitHubCompositeProjectTrackerAdapter();
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    const result = await adapter.listOpenMilestones({ env, installationId: 123, repoFullName: "JSONbored/gittensory" });
    expect(result).toEqual([{ id: "14", title: "Self-host reliability roadmap" }]);
  });

  it("delegates listOpenProjects to GitHubProjectsAdapter", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/graphql")) {
        return Response.json({
          data: {
            repositoryOwner: {
              __typename: "Organization",
              projectsV2: { nodes: [{ id: "PVT_1", title: "Self-host reliability roadmap", closed: false, public: true }], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          },
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    const adapter = new GitHubCompositeProjectTrackerAdapter();
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    const result = await adapter.listOpenProjects({ env, installationId: 123, repoFullName: "some-org/gittensory" });
    expect(result).toEqual([{ id: "PVT_1", title: "Self-host reliability roadmap" }]);
  });

  it("delegates attachToProject and attachToMilestone to the underlying GitHub adapters", async () => {
    let patchedBody: unknown;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/4") && method === "GET") return Response.json({ number: 4, node_id: "PR_kwABC" });
      if (url.endsWith("/graphql")) return Response.json({ data: { addProjectV2ItemById: { item: { id: "PVTI_xyz" } } } });
      if (url.includes("/issues/4") && method === "PATCH") {
        patchedBody = JSON.parse(String(init?.body ?? "{}"));
        return Response.json({ number: 4, milestone: { number: 14 } });
      }
      return new Response("unexpected", { status: 500 });
    });
    const adapter = new GitHubCompositeProjectTrackerAdapter();
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    const ctx = { env, installationId: 123, repoFullName: "some-org/gittensory" };
    await expect(adapter.attachToProject(ctx, 4, "PVT_1")).resolves.toEqual({ attached: true });
    await expect(adapter.attachToMilestone(ctx, 4, "14")).resolves.toEqual({ attached: true });
    expect(patchedBody).toMatchObject({ milestone: 14 });
  });
});

describe("matchOpenTrackerItems (#3183/#3184)", () => {
  const milestones: ProjectTrackerRef[] = [{ id: "14", title: "Self-host reliability roadmap" }, { id: "9", title: "Bounty Wave 2" }];

  it("returns null when there are no open items", () => {
    expect(matchOpenTrackerItems("Fix self-host reliability roadmap flakiness", null, [])).toBeNull();
  });

  it("returns null when no item clears the match threshold", () => {
    expect(matchOpenTrackerItems("Fix a typo in the readme", "no relation to any tracked work", milestones)).toBeNull();
  });

  it("matches a PR whose title/body clearly overlaps one open item's title", () => {
    const match = matchOpenTrackerItems("Improve self-host reliability roadmap convergence", "Follow-up on the self-host reliability roadmap work", milestones);
    expect(match?.item.id).toBe("14");
    expect(match?.score).toBeGreaterThanOrEqual(0.65);
    expect(match?.shared).toBeGreaterThanOrEqual(3);
  });

  it("returns null on an ambiguous multi-match (more than one item clears the threshold) rather than guessing", () => {
    const tied: ProjectTrackerRef[] = [
      { id: "1", title: "self host reliability roadmap convergence work" },
      { id: "2", title: "self host reliability roadmap convergence effort" },
    ];
    expect(matchOpenTrackerItems("self host reliability roadmap convergence", null, tied)).toBeNull();
  });

  it("treats a missing PR body as empty text without throwing", () => {
    expect(() => matchOpenTrackerItems("just a title", undefined, milestones)).not.toThrow();
    expect(() => matchOpenTrackerItems("just a title", null, milestones)).not.toThrow();
  });
});

describe("GitHubMilestonesAdapter (#3183)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("listOpenProjects and attachToProject are inert placeholders (Projects v2 lives in GitHubProjectsAdapter)", async () => {
    const adapter = new GitHubMilestonesAdapter();
    await expect(adapter.listOpenProjects()).resolves.toEqual([]);
    await expect(adapter.attachToProject()).resolves.toEqual({ attached: false });
  });

  it("rejects an invalid repository full name before making any GitHub call", async () => {
    const adapter = new GitHubMilestonesAdapter();
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    await expect(adapter.listOpenMilestones({ env, installationId: 123, repoFullName: "invalid" })).rejects.toThrow(/Invalid repository full name/);
    await expect(adapter.attachToMilestone({ env, installationId: 123, repoFullName: "owner/repo/extra" }, 4, "14")).rejects.toThrow(/Invalid repository full name/);
  });

  it("listOpenMilestones fetches and maps open milestones from the REST API", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/milestones")) return Response.json([{ number: 14, title: "Self-host reliability roadmap" }]);
      return new Response("unexpected", { status: 500 });
    });
    const adapter = new GitHubMilestonesAdapter();
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    const result = await adapter.listOpenMilestones({ env, installationId: 123, repoFullName: "JSONbored/gittensory" });
    expect(result).toEqual([{ id: "14", title: "Self-host reliability roadmap" }]);
  });

  it("attachToMilestone PATCHes the issue with the milestone number", async () => {
    let patchedBody: unknown;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/issues/4") && method === "PATCH") {
        patchedBody = JSON.parse(String(init?.body ?? "{}"));
        return Response.json({ number: 4, milestone: { number: 14 } });
      }
      return new Response("unexpected", { status: 500 });
    });
    const adapter = new GitHubMilestonesAdapter();
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    const result = await adapter.attachToMilestone({ env, installationId: 123, repoFullName: "JSONbored/gittensory" }, 4, "14");
    expect(result).toEqual({ attached: true });
    expect(patchedBody).toMatchObject({ milestone: 14 });
  });

  it("attachToMilestone rejects a non-positive-integer milestoneId without calling GitHub", async () => {
    let patched = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if ((init?.method ?? "GET") === "PATCH") {
        patched = true;
        return Response.json({});
      }
      return new Response("unexpected", { status: 500 });
    });
    const adapter = new GitHubMilestonesAdapter();
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    for (const invalidId of ["not-a-number", "0", "-5", "3.5", ""]) {
      const result = await adapter.attachToMilestone({ env, installationId: 123, repoFullName: "JSONbored/gittensory" }, 4, invalidId);
      expect(result).toEqual({ attached: false });
    }
    expect(patched).toBe(false);
  });

  it("listOpenMilestones paginates past the first 100 results (regression: gate-flagged pagination gap)", async () => {
    const pageOne = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: `Milestone ${i + 1}` }));
    const pageTwoMatch = { number: 101, title: "Self-host reliability roadmap" };
    let requestedPages: number[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/milestones")) {
        const page = Number(new URL(url).searchParams.get("page") ?? "1");
        requestedPages.push(page);
        if (page === 1) return Response.json(pageOne);
        if (page === 2) return Response.json([pageTwoMatch]);
        return Response.json([]);
      }
      return new Response("unexpected", { status: 500 });
    });
    const adapter = new GitHubMilestonesAdapter();
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    const result = await adapter.listOpenMilestones({ env, installationId: 123, repoFullName: "JSONbored/gittensory" });
    expect(requestedPages).toEqual([1, 2]);
    expect(result).toHaveLength(101);
    expect(result).toContainEqual({ id: "101", title: "Self-host reliability roadmap" });
  });

  it("listOpenMilestones stops paginating at the configured page limit even if GitHub reports more", async () => {
    let requestedPages: number[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/milestones")) {
        const page = Number(new URL(url).searchParams.get("page") ?? "1");
        requestedPages.push(page);
        // Always a full page, so the loop would run forever without the hard page-limit cap.
        return Response.json(Array.from({ length: 100 }, (_, i) => ({ number: page * 1000 + i, title: "filler" })));
      }
      return new Response("unexpected", { status: 500 });
    });
    const adapter = new GitHubMilestonesAdapter();
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    await adapter.listOpenMilestones({ env, installationId: 123, repoFullName: "JSONbored/gittensory" });
    expect(requestedPages).toEqual([1, 2, 3]);
  });
});

describe("GitHubProjectsAdapter (#3184)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("listOpenMilestones and attachToMilestone are inert placeholders (Milestones live in GitHubMilestonesAdapter)", async () => {
    const adapter = new GitHubProjectsAdapter();
    await expect(adapter.listOpenMilestones()).resolves.toEqual([]);
    await expect(adapter.attachToMilestone()).resolves.toEqual({ attached: false });
  });

  it("listOpenProjects returns projectsV2 for an organization-owned repo", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/graphql")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { variables?: { login?: string } };
        expect(body.variables?.login).toBe("some-org");
        return Response.json({
          data: {
            repositoryOwner: {
              __typename: "Organization",
              projectsV2: { nodes: [{ id: "PVT_1", title: "Self-host reliability roadmap", closed: false, public: true }], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          },
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    const adapter = new GitHubProjectsAdapter();
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    const result = await adapter.listOpenProjects({ env, installationId: 123, repoFullName: "some-org/gittensory" });
    expect(result).toEqual([{ id: "PVT_1", title: "Self-host reliability roadmap" }]);
  });

  it("listOpenProjects excludes closed and private Projects v2 boards (regression: gate-flagged closed-board leak, #3184)", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/graphql")) {
        return Response.json({
          data: {
            repositoryOwner: {
              __typename: "Organization",
              projectsV2: {
                nodes: [
                  { id: "PVT_open", title: "Open roadmap", closed: false, public: true },
                  { id: "PVT_closed", title: "Closed roadmap", closed: true, public: true },
                  { id: "PVT_private", title: "Secret customer roadmap", closed: false, public: false },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    const adapter = new GitHubProjectsAdapter();
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    const result = await adapter.listOpenProjects({ env, installationId: 123, repoFullName: "some-org/gittensory" });
    expect(result).toEqual([{ id: "PVT_open", title: "Open roadmap" }]);
  });

  it("listOpenProjects returns an empty list for a USER-owned repo (confirmed GitHub App platform limitation, #3184) without erroring", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/graphql")) return Response.json(noOpenProjectsGraphQlBody());
      return new Response("unexpected", { status: 500 });
    });
    const adapter = new GitHubProjectsAdapter();
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    await expect(adapter.listOpenProjects({ env, installationId: 123, repoFullName: "JSONbored/gittensory" })).resolves.toEqual([]);
  });

  it("listOpenProjects follows GraphQL cursor pagination across multiple pages", async () => {
    let requestCount = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/graphql")) {
        requestCount += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as { variables?: { after?: string | null } };
        if (!body.variables?.after) {
          return Response.json({
            data: { repositoryOwner: { __typename: "Organization", projectsV2: { nodes: [{ id: "PVT_1", title: "Page one project", closed: false, public: true }], pageInfo: { hasNextPage: true, endCursor: "cursor-2" } } } },
          });
        }
        return Response.json({
          data: { repositoryOwner: { __typename: "Organization", projectsV2: { nodes: [{ id: "PVT_2", title: "Page two project", closed: false, public: true }], pageInfo: { hasNextPage: false, endCursor: null } } } },
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    const adapter = new GitHubProjectsAdapter();
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    const result = await adapter.listOpenProjects({ env, installationId: 123, repoFullName: "some-org/gittensory" });
    expect(requestCount).toBe(2);
    expect(result).toEqual([
      { id: "PVT_1", title: "Page one project" },
      { id: "PVT_2", title: "Page two project" },
    ]);
  });

  it("attachToProject resolves the PR's node_id then adds it as a project item via GraphQL", async () => {
    let mutationVariables: unknown;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/4") && method === "GET") return Response.json({ number: 4, node_id: "PR_kwABC" });
      if (url.endsWith("/graphql")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { variables?: unknown };
        mutationVariables = body.variables;
        return Response.json({ data: { addProjectV2ItemById: { item: { id: "PVTI_xyz" } } } });
      }
      return new Response("unexpected", { status: 500 });
    });
    const adapter = new GitHubProjectsAdapter();
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    const result = await adapter.attachToProject({ env, installationId: 123, repoFullName: "some-org/gittensory" }, 4, "PVT_1");
    expect(result).toEqual({ attached: true });
    expect(mutationVariables).toEqual({ projectId: "PVT_1", contentId: "PR_kwABC" });
  });

  it("attachToProject rejects a blank projectId without calling GitHub", async () => {
    let called = false;
    vi.stubGlobal("fetch", async () => {
      called = true;
      return new Response("unexpected", { status: 500 });
    });
    const adapter = new GitHubProjectsAdapter();
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    for (const projectId of ["", "   "]) {
      await expect(adapter.attachToProject({ env, installationId: 123, repoFullName: "some-org/gittensory" }, 4, projectId)).resolves.toEqual({ attached: false });
    }
    expect(called).toBe(false);
  });

  it("attachToProject reports not-attached when GitHub returns no item (e.g. a permission/visibility gap)", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/4") && method === "GET") return Response.json({ number: 4, node_id: "PR_kwABC" });
      if (url.endsWith("/graphql")) return Response.json({ data: { addProjectV2ItemById: { item: null } } });
      return new Response("unexpected", { status: 500 });
    });
    const adapter = new GitHubProjectsAdapter();
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    const result = await adapter.attachToProject({ env, installationId: 123, repoFullName: "some-org/gittensory" }, 4, "PVT_1");
    expect(result).toEqual({ attached: false });
  });

  it("rejects an invalid repository full name before making any GitHub call", async () => {
    const adapter = new GitHubProjectsAdapter();
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    await expect(adapter.listOpenProjects({ env, installationId: 123, repoFullName: "invalid" })).rejects.toThrow(/Invalid repository full name/);
    await expect(adapter.attachToProject({ env, installationId: 123, repoFullName: "owner/repo/extra" }, 4, "PVT_1")).rejects.toThrow(/Invalid repository full name/);
  });
});

describe("resolveProjectV2Fields (#3184)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves a project's fields and single-select options via GraphQL", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/graphql")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { variables?: { projectId?: string } };
        expect(body.variables?.projectId).toBe("PVT_1");
        return Response.json({
          data: {
            node: {
              fields: {
                nodes: [
                  { id: "F_1", name: "Title" },
                  { id: "F_2", name: "Status", options: [{ id: "O_1", name: "Todo" }, { id: "O_2", name: "Done" }] },
                ],
              },
            },
          },
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    const fields = await resolveProjectV2Fields({ env, installationId: 123, repoFullName: "some-org/gittensory" }, "PVT_1");
    expect(fields).toEqual([
      { id: "F_1", name: "Title" },
      { id: "F_2", name: "Status", options: [{ id: "O_1", name: "Todo" }, { id: "O_2", name: "Done" }] },
    ]);
  });

  it("returns an empty list when projectId is blank without calling GitHub", async () => {
    let called = false;
    vi.stubGlobal("fetch", async () => {
      called = true;
      return new Response("unexpected", { status: 500 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    for (const projectId of ["", "   "]) {
      await expect(resolveProjectV2Fields({ env, installationId: 123, repoFullName: "some-org/gittensory" }, projectId)).resolves.toEqual([]);
    }
    expect(called).toBe(false);
  });

  it("returns an empty list when the project node has no fields (e.g. not found / inaccessible)", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/graphql")) return Response.json({ data: { node: null } });
      return new Response("unexpected", { status: 500 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    const fields = await resolveProjectV2Fields({ env, installationId: 123, repoFullName: "some-org/gittensory" }, "PVT_missing");
    expect(fields).toEqual([]);
  });
});

describe("maybeSuggestProjectOrMilestoneMatch (#3183/#3184)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts a suggestion comment when a milestone matches and none has been posted yet", async () => {
    const posted: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/milestones")) return Response.json([{ number: 14, title: "Self-host reliability roadmap" }]);
      if (url.endsWith("/graphql")) return Response.json(noOpenProjectsGraphQlBody());
      if (url.includes("/issues/4/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/4/comments") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { body?: string };
        posted.push(body.body ?? "");
        return Response.json({ id: 1 });
      }
      return new Response("unexpected", { status: 500 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    const result = await maybeSuggestProjectOrMilestoneMatch(
      { env, installationId: 123, repoFullName: "JSONbored/gittensory" },
      4,
      "Improve self-host reliability roadmap convergence",
      "Follow-up on the self-host reliability roadmap work",
      "github",
      "https://github.com/JSONbored/gittensory/pull/4",
    );
    expect(result).toEqual({ suggested: true });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain(PROJECT_TRACKER_SUGGEST_COMMENT_MARKER);
    expect(posted[0]).toContain("Self-host reliability roadmap");
    expect(posted[0]).toContain("milestone");
    expect(posted[0]).not.toContain("project (");
  });

  it("posts a suggestion comment when a PROJECT matches (no milestone match) and mentions it as a project", async () => {
    const posted: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/milestones")) return Response.json([]);
      if (url.endsWith("/graphql")) {
        return Response.json({
          data: { repositoryOwner: { __typename: "Organization", projectsV2: { nodes: [{ id: "PVT_1", title: "Self-host reliability roadmap", closed: false, public: true }], pageInfo: { hasNextPage: false, endCursor: null } } } },
        });
      }
      if (url.includes("/issues/4/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/4/comments") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { body?: string };
        posted.push(body.body ?? "");
        return Response.json({ id: 1 });
      }
      return new Response("unexpected", { status: 500 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    const result = await maybeSuggestProjectOrMilestoneMatch(
      { env, installationId: 123, repoFullName: "some-org/gittensory" },
      4,
      "Improve self-host reliability roadmap convergence",
      "Follow-up on the self-host reliability roadmap work",
      "github",
      "https://github.com/JSONbored/gittensory/pull/4",
    );
    expect(result).toEqual({ suggested: true });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("project (");
    expect(posted[0]).not.toContain("milestone (");
  });

  it("mentions BOTH when a milestone AND a project independently match", async () => {
    const posted: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/milestones")) return Response.json([{ number: 14, title: "Self-host reliability roadmap" }]);
      if (url.endsWith("/graphql")) {
        return Response.json({
          data: { repositoryOwner: { __typename: "Organization", projectsV2: { nodes: [{ id: "PVT_1", title: "Self-host reliability roadmap", closed: false, public: true }], pageInfo: { hasNextPage: false, endCursor: null } } } },
        });
      }
      if (url.includes("/issues/4/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/4/comments") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { body?: string };
        posted.push(body.body ?? "");
        return Response.json({ id: 1 });
      }
      return new Response("unexpected", { status: 500 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    const result = await maybeSuggestProjectOrMilestoneMatch(
      { env, installationId: 123, repoFullName: "some-org/gittensory" },
      4,
      "Improve self-host reliability roadmap convergence",
      "Follow-up on the self-host reliability roadmap work",
      "github",
      "https://github.com/JSONbored/gittensory/pull/4",
    );
    expect(result).toEqual({ suggested: true });
    expect(posted[0]).toContain("milestone (");
    expect(posted[0]).toContain("project (");
  });

  it("still suggests the milestone match when the Projects v2 GraphQL lookup fails transiently (fail-open, independent-failure-isolation fix)", async () => {
    const posted: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/milestones")) return Response.json([{ number: 14, title: "Self-host reliability roadmap" }]);
      // Projects v2 GraphQL call throws a transient error -- must not suppress the valid milestone match below.
      if (url.endsWith("/graphql")) return new Response("boom", { status: 500 });
      if (url.includes("/issues/4/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/4/comments") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { body?: string };
        posted.push(body.body ?? "");
        return Response.json({ id: 1 });
      }
      return new Response("unexpected", { status: 500 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    const result = await maybeSuggestProjectOrMilestoneMatch(
      { env, installationId: 123, repoFullName: "some-org/gittensory" },
      4,
      "Improve self-host reliability roadmap convergence",
      "Follow-up on the self-host reliability roadmap work",
      "github",
      "https://github.com/some-org/gittensory/pull/4",
    );
    expect(result).toEqual({ suggested: true });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("milestone (");
    expect(posted[0]).not.toContain("project (");
  });

  it("still suggests the project match when the milestones REST lookup fails transiently (fail-open, independent-failure-isolation fix)", async () => {
    const posted: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      // Milestones REST call throws a transient error -- must not suppress the valid Projects v2 match below.
      if (url.includes("/milestones")) return new Response("boom", { status: 500 });
      if (url.endsWith("/graphql")) {
        return Response.json({
          data: { repositoryOwner: { __typename: "Organization", projectsV2: { nodes: [{ id: "PVT_1", title: "Self-host reliability roadmap", closed: false, public: true }], pageInfo: { hasNextPage: false, endCursor: null } } } },
        });
      }
      if (url.includes("/issues/4/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/4/comments") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { body?: string };
        posted.push(body.body ?? "");
        return Response.json({ id: 1 });
      }
      return new Response("unexpected", { status: 500 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    const result = await maybeSuggestProjectOrMilestoneMatch(
      { env, installationId: 123, repoFullName: "some-org/gittensory" },
      4,
      "Improve self-host reliability roadmap convergence",
      "Follow-up on the self-host reliability roadmap work",
      "github",
      "https://github.com/some-org/gittensory/pull/4",
    );
    expect(result).toEqual({ suggested: true });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("project (");
    expect(posted[0]).not.toContain("milestone (");
  });

  it("code-formats the milestone title and strips literal backticks, neutralizing markdown/mention injection", async () => {
    const posted: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/milestones")) return Response.json([{ number: 14, title: "self host reliability roadmap `@everyone` **pwned**" }]);
      if (url.endsWith("/graphql")) return Response.json(noOpenProjectsGraphQlBody());
      if (url.includes("/issues/4/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/4/comments") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { body?: string };
        posted.push(body.body ?? "");
        return Response.json({ id: 1 });
      }
      return new Response("unexpected", { status: 500 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await maybeSuggestProjectOrMilestoneMatch(
      { env, installationId: 123, repoFullName: "JSONbored/gittensory" },
      4,
      "self host reliability roadmap convergence",
      "self host reliability roadmap convergence work",
      "github",
      "https://github.com/JSONbored/gittensory/pull/4",
    );
    expect(posted).toHaveLength(1);
    // The rendered title is wrapped in a single code span with every literal backtick stripped -- no unescaped
    // backtick can break out of the span and re-enable the mention/emphasis markup it carries.
    expect(posted[0]).toContain("`self host reliability roadmap @everyone **pwned**`");
    expect(posted[0]).not.toMatch(/`[^`]*`[^`]*`/);
  });

  it("paginates the comment-marker search past the first 100 comments before deciding to post", async () => {
    const pageOneComments = Array.from({ length: 100 }, (_, i) => ({ body: `unrelated comment ${i}`, user: { type: "User", login: "someone" } }));
    let posted = false;
    let requestedPages: number[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/milestones")) return Response.json([{ number: 14, title: "Self-host reliability roadmap" }]);
      if (url.endsWith("/graphql")) return Response.json(noOpenProjectsGraphQlBody());
      if (url.includes("/issues/4/comments") && method === "GET") {
        const page = Number(new URL(url).searchParams.get("page") ?? "1");
        requestedPages.push(page);
        if (page === 1) return Response.json(pageOneComments);
        if (page === 2) return Response.json([{ body: PROJECT_TRACKER_SUGGEST_COMMENT_MARKER, user: { type: "Bot", login: "gittensory[bot]" } }]);
        return Response.json([]);
      }
      if (url.includes("/issues/4/comments") && method === "POST") {
        posted = true;
        return Response.json({ id: 1 });
      }
      return new Response("unexpected", { status: 500 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    const result = await maybeSuggestProjectOrMilestoneMatch(
      { env, installationId: 123, repoFullName: "JSONbored/gittensory" },
      4,
      "Improve self-host reliability roadmap convergence",
      "Follow-up on the self-host reliability roadmap work",
      "github",
      "https://github.com/JSONbored/gittensory/pull/4",
    );
    expect(requestedPages).toEqual([1, 2]);
    expect(result).toEqual({ suggested: false });
    expect(posted).toBe(false);
  });

  it("does nothing when neither a milestone nor a project matches (never calls the comment POST endpoint)", async () => {
    let posted = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/milestones")) return Response.json([{ number: 14, title: "Self-host reliability roadmap" }]);
      if (url.endsWith("/graphql")) return Response.json(noOpenProjectsGraphQlBody());
      if (url.includes("/comments") && method === "POST") {
        posted = true;
        return Response.json({ id: 1 });
      }
      return new Response("unexpected", { status: 500 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    const result = await maybeSuggestProjectOrMilestoneMatch({ env, installationId: 123, repoFullName: "JSONbored/gittensory" }, 4, "unrelated typo fix", null,
      "github",
      "https://github.com/JSONbored/gittensory/pull/4",
    );
    expect(result).toEqual({ suggested: false });
    expect(posted).toBe(false);
  });

  it("is idempotent — skips posting when the marker comment already exists from this bot", async () => {
    let posted = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/milestones")) return Response.json([{ number: 14, title: "Self-host reliability roadmap" }]);
      if (url.endsWith("/graphql")) return Response.json(noOpenProjectsGraphQlBody());
      if (url.includes("/issues/4/comments") && method === "GET") {
        return Response.json([{ body: PROJECT_TRACKER_SUGGEST_COMMENT_MARKER, user: { type: "Bot", login: "gittensory[bot]" } }]);
      }
      if (url.includes("/comments") && method === "POST") {
        posted = true;
        return Response.json({ id: 1 });
      }
      return new Response("unexpected", { status: 500 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    const result = await maybeSuggestProjectOrMilestoneMatch(
      { env, installationId: 123, repoFullName: "JSONbored/gittensory" },
      4,
      "Improve self-host reliability roadmap convergence",
      "Follow-up on the self-host reliability roadmap work",
      "github",
      "https://github.com/JSONbored/gittensory/pull/4",
    );
    expect(result).toEqual({ suggested: false });
    expect(posted).toBe(false);
  });

  it("ignores a marker-matching comment from a non-bot user (a human quoting the marker text)", async () => {
    let posted = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/milestones")) return Response.json([{ number: 14, title: "Self-host reliability roadmap" }]);
      if (url.endsWith("/graphql")) return Response.json(noOpenProjectsGraphQlBody());
      if (url.includes("/issues/4/comments") && method === "GET") {
        return Response.json([{ body: PROJECT_TRACKER_SUGGEST_COMMENT_MARKER, user: { type: "User", login: "alice" } }]);
      }
      if (url.includes("/issues/4/comments") && method === "POST") {
        posted = true;
        return Response.json({ id: 1 });
      }
      return new Response("unexpected", { status: 500 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    const result = await maybeSuggestProjectOrMilestoneMatch(
      { env, installationId: 123, repoFullName: "JSONbored/gittensory" },
      4,
      "Improve self-host reliability roadmap convergence",
      "Follow-up on the self-host reliability roadmap work",
      "github",
      "https://github.com/JSONbored/gittensory/pull/4",
    );
    expect(result).toEqual({ suggested: true });
    expect(posted).toBe(true);
  });
});

describe("maybeSuggestMilestoneMatchForPr (#3183 webhook-level gating)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function baseArgs(overrides: Partial<Parameters<typeof maybeSuggestMilestoneMatchForPr>[0]> = {}) {
    return {
      env: createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" }),
      installationId: 123,
      repoFullName: "JSONbored/gittensory",
      pullNumber: 4,
      prState: "open",
      prTitle: "Improve self-host reliability roadmap convergence",
      prBody: "Follow-up on the self-host reliability roadmap work",
      prUrl: "https://github.com/JSONbored/gittensory/pull/4",
      mode: "suggest" as const,
      backend: "github" as const,
      deliveryId: "test-delivery",
      eventName: "pull_request",
      action: "opened",
      ...overrides,
    };
  }

  it("does nothing for review webhooks with pull_request payloads", async () => {
    let called = false;
    vi.stubGlobal("fetch", async () => {
      called = true;
      return new Response("unexpected", { status: 500 });
    });
    await maybeSuggestMilestoneMatchForPr(baseArgs({ eventName: "pull_request_review", action: "submitted" }));
    expect(called).toBe(false);
  });

  it("does nothing for pull_request actions that do not change title/body matching inputs", async () => {
    let called = false;
    vi.stubGlobal("fetch", async () => {
      called = true;
      return new Response("unexpected", { status: 500 });
    });
    await maybeSuggestMilestoneMatchForPr(baseArgs({ action: "labeled" }));
    expect(called).toBe(false);
  });

  it("does nothing when installationId is falsy (never touches the network)", async () => {
    let called = false;
    vi.stubGlobal("fetch", async () => {
      called = true;
      return new Response("unexpected", { status: 500 });
    });
    await maybeSuggestMilestoneMatchForPr(baseArgs({ installationId: null }));
    expect(called).toBe(false);
  });

  it("does nothing when the PR is not open", async () => {
    let called = false;
    vi.stubGlobal("fetch", async () => {
      called = true;
      return new Response("unexpected", { status: 500 });
    });
    await maybeSuggestMilestoneMatchForPr(baseArgs({ prState: "closed" }));
    expect(called).toBe(false);
  });

  it("does nothing when mode is off", async () => {
    let called = false;
    vi.stubGlobal("fetch", async () => {
      called = true;
      return new Response("unexpected", { status: 500 });
    });
    await maybeSuggestMilestoneMatchForPr(baseArgs({ mode: "off" }));
    expect(called).toBe(false);
  });

  it("does nothing when mode is null/undefined (unconfigured repo, always populated by the DB layer in practice)", async () => {
    let called = false;
    vi.stubGlobal("fetch", async () => {
      called = true;
      return new Response("unexpected", { status: 500 });
    });
    await maybeSuggestMilestoneMatchForPr(baseArgs({ mode: null }));
    expect(called).toBe(false);
    called = false;
    await maybeSuggestMilestoneMatchForPr(baseArgs({ mode: undefined }));
    expect(called).toBe(false);
  });

  it("runs the match when mode is suggest and every gate passes", async () => {
    let milestonesFetched = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/milestones")) {
        milestonesFetched = true;
        return Response.json([]);
      }
      if (url.endsWith("/graphql")) return Response.json(noOpenProjectsGraphQlBody());
      if (url.includes("/comments") && method === "GET") return Response.json([]);
      return new Response("unexpected", { status: 500 });
    });
    await maybeSuggestMilestoneMatchForPr(baseArgs());
    expect(milestonesFetched).toBe(true);
  });

  it("coerces a missing prUrl to an empty string rather than passing null/undefined through", async () => {
    let milestonesFetched = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/milestones")) {
        milestonesFetched = true;
        return Response.json([]);
      }
      if (url.endsWith("/graphql")) return Response.json(noOpenProjectsGraphQlBody());
      if (url.includes("/comments") && method === "GET") return Response.json([]);
      return new Response("unexpected", { status: 500 });
    });
    await maybeSuggestMilestoneMatchForPr(baseArgs({ prUrl: null }));
    expect(milestonesFetched).toBe(true);
    milestonesFetched = false;
    await maybeSuggestMilestoneMatchForPr(baseArgs({ prUrl: undefined }));
    expect(milestonesFetched).toBe(true);
  });

  it("runs the match when mode is auto (identical to suggest until #3185)", async () => {
    let milestonesFetched = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/milestones")) {
        milestonesFetched = true;
        return Response.json([]);
      }
      if (url.endsWith("/graphql")) return Response.json(noOpenProjectsGraphQlBody());
      return new Response("unexpected", { status: 500 });
    });
    await maybeSuggestMilestoneMatchForPr(baseArgs({ mode: "auto" }));
    expect(milestonesFetched).toBe(true);
  });

  it("logs a failure instead of throwing", async () => {
    // The milestone/project lookups themselves are fail-open (#3183/#3184 fail-open fix) and can no longer
    // reach this outer catch -- so this test drives a real match (milestone lookup succeeds) and fails the
    // still-unprotected comment-marker search instead, to prove the outer best-effort catch is still live.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/milestones")) return Response.json([{ number: 14, title: "Self-host reliability roadmap" }]);
      if (url.endsWith("/graphql")) return Response.json(noOpenProjectsGraphQlBody());
      if (url.includes("/issues/4/comments")) return new Response("boom", { status: 500 });
      return new Response("unexpected", { status: 500 });
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(maybeSuggestMilestoneMatchForPr(baseArgs({ deliveryId: "delivery-42" }))).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(consoleError.mock.calls[0]?.[0]));
    expect(logged).toMatchObject({ event: "milestone_suggest_failed", deliveryId: "delivery-42", repoFullName: "JSONbored/gittensory", pullNumber: 4 });
    consoleError.mockRestore();
  });

  it("runs the linear backend path when configured, preferring native links over fuzzy project matching", async () => {
    const env = suggestTestEnv();
    await upsertRepositoryLinearKey(env, { repoFullName: "JSONbored/gittensory", key: "lin_api_test_key" });
    let projectsListed = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url === "https://api.linear.app/graphql") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { query: string };
        if (body.query.includes("attachmentsForURL")) {
          return Response.json({ data: { attachmentsForURL: { nodes: [{ issue: { project: { id: "proj-1", name: "Roadmap" }, projectMilestone: null } }] } } });
        }
        projectsListed = true;
        return Response.json({ data: { projects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
      }
      if (url.includes("/comments") && method === "GET") return Response.json([]);
      if (url.includes("/comments") && method === "POST") return Response.json({ id: 1 });
      return new Response("unexpected", { status: 500 });
    });
    await maybeSuggestMilestoneMatchForPr(baseArgs({ backend: "linear" }));
    expect(projectsListed).toBe(false);
  });

  it("does not throw for the linear backend when Linear is unreachable (fail-open miss)", async () => {
    const env = suggestTestEnv();
    await upsertRepositoryLinearKey(env, { repoFullName: "JSONbored/gittensory", key: "lin_api_test_key" });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      return new Response("Service Unavailable", { status: 503 });
    });
    await expect(maybeSuggestMilestoneMatchForPr(baseArgs({ backend: "linear", deliveryId: "linear-outage" }))).resolves.toBeUndefined();
  });
});
