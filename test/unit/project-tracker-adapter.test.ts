import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { GitHubMilestonesAdapter, MILESTONE_SUGGEST_COMMENT_MARKER, maybeSuggestMilestoneMatch, maybeSuggestMilestoneMatchForPr, matchOpenMilestones, type ProjectTrackerRef } from "../../src/integrations/project-tracker-adapter";
import { createTestEnv } from "../helpers/d1";

function generateRsaPrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}

describe("matchOpenMilestones (#3183)", () => {
  const milestones: ProjectTrackerRef[] = [{ id: "14", title: "Self-host reliability roadmap" }, { id: "9", title: "Bounty Wave 2" }];

  it("returns null when there are no open milestones", () => {
    expect(matchOpenMilestones("Fix self-host reliability roadmap flakiness", null, [])).toBeNull();
  });

  it("returns null when no milestone clears the match threshold", () => {
    expect(matchOpenMilestones("Fix a typo in the readme", "no relation to any tracked work", milestones)).toBeNull();
  });

  it("matches a PR whose title/body clearly overlaps one open milestone's title", () => {
    const match = matchOpenMilestones("Improve self-host reliability roadmap convergence", "Follow-up on the self-host reliability roadmap work", milestones);
    expect(match?.milestone.id).toBe("14");
    expect(match?.score).toBeGreaterThanOrEqual(0.65);
    expect(match?.shared).toBeGreaterThanOrEqual(3);
  });

  it("returns null on an ambiguous multi-match (more than one milestone clears the threshold) rather than guessing", () => {
    const tied: ProjectTrackerRef[] = [
      { id: "1", title: "self host reliability roadmap convergence work" },
      { id: "2", title: "self host reliability roadmap convergence effort" },
    ];
    expect(matchOpenMilestones("self host reliability roadmap convergence", null, tied)).toBeNull();
  });

  it("treats a missing PR body as empty text without throwing", () => {
    expect(() => matchOpenMilestones("just a title", undefined, milestones)).not.toThrow();
    expect(() => matchOpenMilestones("just a title", null, milestones)).not.toThrow();
  });
});

describe("GitHubMilestonesAdapter (#3183)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("listOpenProjects and attachToProject are inert placeholders until #3184", async () => {
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

describe("maybeSuggestMilestoneMatch (#3183)", () => {
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
      if (url.includes("/issues/4/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/4/comments") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { body?: string };
        posted.push(body.body ?? "");
        return Response.json({ id: 1 });
      }
      return new Response("unexpected", { status: 500 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    const result = await maybeSuggestMilestoneMatch(
      { env, installationId: 123, repoFullName: "JSONbored/gittensory" },
      4,
      "Improve self-host reliability roadmap convergence",
      "Follow-up on the self-host reliability roadmap work",
    );
    expect(result).toEqual({ suggested: true });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain(MILESTONE_SUGGEST_COMMENT_MARKER);
    expect(posted[0]).toContain("Self-host reliability roadmap");
  });

  it("code-formats the milestone title and strips literal backticks, neutralizing markdown/mention injection", async () => {
    const posted: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/milestones")) return Response.json([{ number: 14, title: "self host reliability roadmap `@everyone` **pwned**" }]);
      if (url.includes("/issues/4/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/4/comments") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { body?: string };
        posted.push(body.body ?? "");
        return Response.json({ id: 1 });
      }
      return new Response("unexpected", { status: 500 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await maybeSuggestMilestoneMatch(
      { env, installationId: 123, repoFullName: "JSONbored/gittensory" },
      4,
      "self host reliability roadmap convergence",
      "self host reliability roadmap convergence work",
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
      if (url.includes("/issues/4/comments") && method === "GET") {
        const page = Number(new URL(url).searchParams.get("page") ?? "1");
        requestedPages.push(page);
        if (page === 1) return Response.json(pageOneComments);
        if (page === 2) return Response.json([{ body: MILESTONE_SUGGEST_COMMENT_MARKER, user: { type: "Bot", login: "gittensory[bot]" } }]);
        return Response.json([]);
      }
      if (url.includes("/issues/4/comments") && method === "POST") {
        posted = true;
        return Response.json({ id: 1 });
      }
      return new Response("unexpected", { status: 500 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    const result = await maybeSuggestMilestoneMatch(
      { env, installationId: 123, repoFullName: "JSONbored/gittensory" },
      4,
      "Improve self-host reliability roadmap convergence",
      "Follow-up on the self-host reliability roadmap work",
    );
    expect(requestedPages).toEqual([1, 2]);
    expect(result).toEqual({ suggested: false });
    expect(posted).toBe(false);
  });

  it("does nothing when no milestone matches (never calls the comment POST endpoint)", async () => {
    let posted = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/milestones")) return Response.json([{ number: 14, title: "Self-host reliability roadmap" }]);
      if (url.includes("/comments") && method === "POST") {
        posted = true;
        return Response.json({ id: 1 });
      }
      return new Response("unexpected", { status: 500 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    const result = await maybeSuggestMilestoneMatch({ env, installationId: 123, repoFullName: "JSONbored/gittensory" }, 4, "unrelated typo fix", null);
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
      if (url.includes("/issues/4/comments") && method === "GET") {
        return Response.json([{ body: MILESTONE_SUGGEST_COMMENT_MARKER, user: { type: "Bot", login: "gittensory[bot]" } }]);
      }
      if (url.includes("/comments") && method === "POST") {
        posted = true;
        return Response.json({ id: 1 });
      }
      return new Response("unexpected", { status: 500 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    const result = await maybeSuggestMilestoneMatch(
      { env, installationId: 123, repoFullName: "JSONbored/gittensory" },
      4,
      "Improve self-host reliability roadmap convergence",
      "Follow-up on the self-host reliability roadmap work",
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
      if (url.includes("/issues/4/comments") && method === "GET") {
        return Response.json([{ body: MILESTONE_SUGGEST_COMMENT_MARKER, user: { type: "User", login: "alice" } }]);
      }
      if (url.includes("/issues/4/comments") && method === "POST") {
        posted = true;
        return Response.json({ id: 1 });
      }
      return new Response("unexpected", { status: 500 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    const result = await maybeSuggestMilestoneMatch(
      { env, installationId: 123, repoFullName: "JSONbored/gittensory" },
      4,
      "Improve self-host reliability roadmap convergence",
      "Follow-up on the self-host reliability roadmap work",
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
      mode: "suggest" as const,
      deliveryId: "test-delivery",
      ...overrides,
    };
  }

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
      if (url.includes("/comments") && method === "GET") return Response.json([]);
      return new Response("unexpected", { status: 500 });
    });
    await maybeSuggestMilestoneMatchForPr(baseArgs());
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
      return new Response("unexpected", { status: 500 });
    });
    await maybeSuggestMilestoneMatchForPr(baseArgs({ mode: "auto" }));
    expect(milestonesFetched).toBe(true);
  });

  it("logs a failure instead of throwing", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/milestones")) return new Response("boom", { status: 500 });
      return new Response("unexpected", { status: 500 });
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(maybeSuggestMilestoneMatchForPr(baseArgs({ deliveryId: "delivery-42" }))).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(consoleError.mock.calls[0]?.[0]));
    expect(logged).toMatchObject({ event: "milestone_suggest_failed", deliveryId: "delivery-42", repoFullName: "JSONbored/gittensory", pullNumber: 4 });
    consoleError.mockRestore();
  });
});
