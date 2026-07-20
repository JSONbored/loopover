import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createTestEnv } from "../helpers/d1";
import { clearInstallationTokenCacheForTest } from "../../src/github/app";
import * as repositories from "../../src/db/repositories";
import type { IssueRecord, RepositoryRecord } from "../../src/types";
import {
  findDeclinedIssuePlanDraft,
  findDuplicateIssuePlanDraft,
  generateIssuePlanDrafts,
  issuePlanDraftFingerprint,
  issuePlanDraftMarker,
} from "../../src/services/issue-plan-draft";

const FORBIDDEN = /wallet|hotkey|raw trust score|payout|reward estimate|farming|private reviewability|public score estimate/i;

function openIssue(number: number, title: string, body?: string): IssueRecord {
  return { repoFullName: "acme/widgets", number, title, state: "open", labels: [], linkedPrs: [], body: body ?? null };
}

function installedRepo(fullName: string): RepositoryRecord {
  const [owner = "", name = ""] = fullName.split("/");
  return { fullName, owner, name, installationId: 123, isInstalled: true, isRegistered: true, isPrivate: false };
}

function generateRsaPrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}

function issuesResponse(issues: Array<Record<string, unknown>>): { response: string } {
  return { response: JSON.stringify({ issues }) };
}

const AI_ENABLED_ENV = { AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true" };

function baseEnv(overrides: Partial<Env> = {}) {
  return createTestEnv({ ...AI_ENABLED_ENV, ...overrides });
}

describe("generateIssuePlanDrafts (#7426)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearInstallationTokenCacheForTest();
  });

  it("is disabled when either AI_SUMMARIES_ENABLED or AI_PUBLIC_COMMENTS_ENABLED is off", async () => {
    const run = vi.fn(async () => issuesResponse([{ title: "T", body: "B" }]));
    const summariesOff = createTestEnv({ AI_PUBLIC_COMMENTS_ENABLED: "true", AI: { run } as unknown as Ai });
    expect((await generateIssuePlanDrafts(summariesOff, "acme/widgets", "goal")).status).toBe("disabled");
    const commentsOff = createTestEnv({ AI_SUMMARIES_ENABLED: "true", AI: { run } as unknown as Ai });
    expect((await generateIssuePlanDrafts(commentsOff, "acme/widgets", "goal")).status).toBe("disabled");
    expect(run).not.toHaveBeenCalled();
  });

  it("is unavailable when no AI binding is configured", async () => {
    const result = await generateIssuePlanDrafts(baseEnv(), "acme/widgets", "goal");
    expect(result.status).toBe("unavailable");
  });

  it("returns no_output when env.AI is truthy but lacks a run() function", async () => {
    const env = baseEnv({ AI: {} as unknown as Ai });
    const result = await generateIssuePlanDrafts(env, "acme/widgets", "goal");
    expect(result.status).toBe("no_output");
  });

  it("returns no_output for an empty or whitespace-only goal without calling the model", async () => {
    const run = vi.fn(async () => issuesResponse([{ title: "T", body: "B" }]));
    const env = baseEnv({ AI: { run } as unknown as Ai });
    expect((await generateIssuePlanDrafts(env, "acme/widgets", "")).status).toBe("no_output");
    expect((await generateIssuePlanDrafts(env, "acme/widgets", "   ")).status).toBe("no_output");
    expect(run).not.toHaveBeenCalled();
  });

  it("does not call the model when the shared daily neuron budget is exhausted", async () => {
    const run = vi.fn(async () => issuesResponse([{ title: "T", body: "B" }]));
    const env = baseEnv({ AI: { run } as unknown as Ai, AI_DAILY_NEURON_BUDGET: "0" });
    const result = await generateIssuePlanDrafts(env, "acme/widgets", "plan the migration");
    expect(result.status).toBe("quota_exceeded");
    expect(run).not.toHaveBeenCalled();
    const usage = await env.DB.prepare("select feature, status, estimated_neurons from ai_usage_events where feature = ?").bind("issue_plan_drafts").first<{ feature: string; status: string; estimated_neurons: number }>();
    expect(usage).toMatchObject({ feature: "issue_plan_drafts", status: "quota_exceeded", estimated_neurons: 0 });
  });

  it("returns no_output when the model returns nothing usable (empty/unparseable/thrown)", async () => {
    const empty = vi.fn(async () => ({ response: "   " }));
    expect((await generateIssuePlanDrafts(baseEnv({ AI: { run: empty } as unknown as Ai }), "acme/widgets", "goal")).status).toBe("no_output");

    const malformed = vi.fn(async () => ({ response: "not json at all" }));
    expect((await generateIssuePlanDrafts(baseEnv({ AI: { run: malformed } as unknown as Ai }), "acme/widgets", "goal")).status).toBe("no_output");

    // Brace-balanced (so extractLastJsonObject extracts it) but not valid JSON syntax (single-quoted key) --
    // exercises parseIssuePlanModelOutput's JSON.parse catch branch specifically, distinct from `malformed` above
    // which has no braces at all and never reaches JSON.parse.
    const invalidJsonSyntax = vi.fn(async () => ({ response: "{'issues': []}" }));
    expect((await generateIssuePlanDrafts(baseEnv({ AI: { run: invalidJsonSyntax } as unknown as Ai }), "acme/widgets", "goal")).status).toBe("no_output");

    const emptyArray = vi.fn(async () => issuesResponse([]));
    expect((await generateIssuePlanDrafts(baseEnv({ AI: { run: emptyArray } as unknown as Ai }), "acme/widgets", "goal")).status).toBe("no_output");

    // A valid JSON object whose `issues` field isn't an array at all -- distinct from an empty array above.
    const nonArrayIssues = vi.fn(async () => ({ response: JSON.stringify({ issues: "not-an-array" }) }));
    expect((await generateIssuePlanDrafts(baseEnv({ AI: { run: nonArrayIssues } as unknown as Ai }), "acme/widgets", "goal")).status).toBe("no_output");

    const throwing = vi.fn(async () => {
      throw new Error("ai down");
    });
    expect((await generateIssuePlanDrafts(baseEnv({ AI: { run: throwing } as unknown as Ai }), "acme/widgets", "goal")).status).toBe("no_output");
    expect(throwing).toHaveBeenCalledTimes(4); // 2 models x 2 attempts each -- a non-429 error burns the full budget
  });

  it("REGRESSION: stops retrying a model after one 429 rate-limit error instead of burning its full attempt budget", async () => {
    const throwing = vi.fn(async () => {
      throw new Error("claude_code_error_429");
    });
    await generateIssuePlanDrafts(baseEnv({ AI: { run: throwing } as unknown as Ai }), "acme/widgets", "goal");
    expect(throwing).toHaveBeenCalledTimes(2); // 1 attempt per model (2 models), not the full 4-call budget
  });

  it("routes through the AI Gateway when AI_GATEWAY_ID is configured", async () => {
    const run = vi.fn(async () => issuesResponse([{ title: "Improve caching", body: "Do the caching work." }]));
    const env = baseEnv({ AI: { run } as unknown as Ai, AI_GATEWAY_ID: "gw-1" });
    await generateIssuePlanDrafts(env, "acme/widgets", "improve performance");
    expect((run.mock.calls[0] as unknown as unknown[])[2]).toEqual({ gateway: { id: "gw-1" } });
  });

  it("generates, proposes (dry-run default), and dedupes drafts by marker and by title", async () => {
    const run = vi.fn(async () =>
      issuesResponse([
        { title: "Add retry to the sync job", body: "Retries transient failures with backoff.", labels: ["enhancement", "enhancement", "  ", 42, "bug"] },
      ]),
    );
    const env = baseEnv({ AI: { run } as unknown as Ai });
    vi.spyOn(repositories, "getRepository").mockResolvedValue(installedRepo("acme/widgets"));
    vi.spyOn(repositories, "listOpenIssues").mockResolvedValue([]);
    vi.spyOn(repositories, "listRepoLabels").mockResolvedValue([{ name: "enhancement", color: "x", description: null }, { name: "bug", color: "x", description: null }] as never);

    const result = await generateIssuePlanDrafts(env, "acme/widgets", "improve sync reliability");
    expect(result.status).toBe("ok");
    expect(result.dryRun).toBe(true);
    expect(result.proposed).toBe(1);
    expect(result.drafts).toHaveLength(1);
    const draft = result.drafts[0]!;
    expect(draft.status).toBe("proposed");
    expect(draft.title).toBe("Add retry to the sync job");
    expect(draft.labels).toEqual(["enhancement", "bug"]); // dedup, trimmed, non-strings/blank dropped
    expect(draft.body).toContain(issuePlanDraftMarker(draft.fingerprint));
    expect(draft.body).not.toMatch(FORBIDDEN);
  });

  it("skips a malformed individual candidate without failing the whole batch", async () => {
    const run = vi.fn(async () =>
      issuesResponse([
        { title: "", body: "no title" },
        { title: "Valid issue", body: "" },
        { title: 42, body: "title is not a string" },
        { title: "body is not a string", body: null },
        { title: "Real issue", body: "Has both fields." },
      ]),
    );
    const env = baseEnv({ AI: { run } as unknown as Ai });
    vi.spyOn(repositories, "listOpenIssues").mockResolvedValue([]);
    const result = await generateIssuePlanDrafts(env, "acme/widgets", "goal");
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]?.title).toBe("Real issue");
  });

  it("still fingerprints a title that normalizes to an empty key (symbols only)", async () => {
    const run = vi.fn(async () => issuesResponse([{ title: "###", body: "A title made only of symbols." }]));
    const env = baseEnv({ AI: { run } as unknown as Ai });
    vi.spyOn(repositories, "listOpenIssues").mockResolvedValue([]);
    const result = await generateIssuePlanDrafts(env, "acme/widgets", "goal");
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]?.title).toBe("###");
  });

  it("clamps the requested limit to at least one and to MAX_LIMIT", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ title: `Issue ${i}`, body: `Body ${i}` }));
    const run = vi.fn(async () => issuesResponse(many));
    const env = baseEnv({ AI: { run } as unknown as Ai });
    vi.spyOn(repositories, "listOpenIssues").mockResolvedValue([]);
    const low = await generateIssuePlanDrafts(env, "acme/widgets", "goal", { limit: 0 });
    expect(low.drafts.length).toBeLessThanOrEqual(1);
    const high = await generateIssuePlanDrafts(env, "acme/widgets", "goal", { limit: 100 });
    expect(high.drafts.length).toBeLessThanOrEqual(10);
  });

  it("skips unsafe drafts (public/private boundary)", async () => {
    const run = vi.fn(async () => issuesResponse([{ title: "estimate your reward payout", body: "wallet details inside" }]));
    const env = baseEnv({ AI: { run } as unknown as Ai });
    vi.spyOn(repositories, "listOpenIssues").mockResolvedValue([]);
    const result = await generateIssuePlanDrafts(env, "acme/widgets", "goal");
    expect(result.skippedUnsafe).toBe(1);
    expect(result.drafts[0]?.status).toBe("skipped_unsafe");
  });

  it("skips a draft that duplicates an already-open issue by marker", async () => {
    const title = "Add retry to the sync job";
    const fingerprint = await issuePlanDraftFingerprint("acme/widgets", "add retry to the sync job");
    const run = vi.fn(async () => issuesResponse([{ title, body: "Retries transient failures." }]));
    const env = baseEnv({ AI: { run } as unknown as Ai });
    vi.spyOn(repositories, "listOpenIssues").mockResolvedValue([openIssue(5, "unrelated title", issuePlanDraftMarker(fingerprint))]);
    const result = await generateIssuePlanDrafts(env, "acme/widgets", "goal");
    expect(result.skippedDuplicate).toBe(1);
    expect(result.drafts[0]?.duplicateOf).toMatchObject({ number: 5, reason: "marker" });
  });

  it("skips a draft that duplicates an already-open issue by normalized title", async () => {
    const run = vi.fn(async () => issuesResponse([{ title: "Feat(Issues): Address Validation!", body: "Body" }]));
    const env = baseEnv({ AI: { run } as unknown as Ai });
    vi.spyOn(repositories, "listOpenIssues").mockResolvedValue([openIssue(9, "feat issues address validation")]);
    const result = await generateIssuePlanDrafts(env, "acme/widgets", "goal");
    expect(result.skippedDuplicate).toBe(1);
    expect(result.drafts[0]?.duplicateOf).toMatchObject({ number: 9, reason: "title" });
  });

  it("skips a draft declined by a maintainer-closed wontfix marker regardless of age", async () => {
    const title = "Add retry to the sync job";
    const fingerprint = await issuePlanDraftFingerprint("acme/widgets", "add retry to the sync job");
    const run = vi.fn(async () => issuesResponse([{ title, body: "Retries transient failures." }]));
    const env = baseEnv({ AI: { run } as unknown as Ai });
    const closed: IssueRecord = { ...openIssue(3, "old title", issuePlanDraftMarker(fingerprint)), state: "closed", authorAssociation: "NONE", labels: ["wontfix"], closedAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString() };
    vi.spyOn(repositories, "listOpenIssues").mockResolvedValue([]);
    vi.spyOn(repositories, "listClosedContributorDraftIssues").mockResolvedValue([closed]);
    const result = await generateIssuePlanDrafts(env, "acme/widgets", "goal");
    expect(result.skippedDeclined).toBe(1);
    expect(result.drafts[0]?.declinedBy).toMatchObject({ number: 3, reason: "wontfix" });
  });

  it("skips a recently-declined maintainer-authored draft within the cooldown, but not an untrusted author or a stale one", async () => {
    const title = "Add retry to the sync job";
    const fingerprint = await issuePlanDraftFingerprint("acme/widgets", "add retry to the sync job");
    const run = vi.fn(async () => issuesResponse([{ title, body: "Retries transient failures." }]));
    const env = baseEnv({ AI: { run } as unknown as Ai });
    const recentMaintainer: IssueRecord = { ...openIssue(4, "old title", issuePlanDraftMarker(fingerprint)), state: "closed", authorAssociation: "OWNER", closedAt: new Date().toISOString() };
    vi.spyOn(repositories, "listOpenIssues").mockResolvedValue([]);
    vi.spyOn(repositories, "listClosedContributorDraftIssues").mockResolvedValue([recentMaintainer]);
    const result = await generateIssuePlanDrafts(env, "acme/widgets", "goal");
    expect(result.skippedDeclined).toBe(1);
    expect(result.drafts[0]?.declinedBy).toMatchObject({ reason: "cooldown" });
  });

  it("does not create anything by default even with create requested unless dryRun is explicitly false", async () => {
    const run = vi.fn(async () => issuesResponse([{ title: "Add retry", body: "Body" }]));
    const env = baseEnv({ AI: { run } as unknown as Ai });
    vi.spyOn(repositories, "listOpenIssues").mockResolvedValue([]);
    const result = await generateIssuePlanDrafts(env, "acme/widgets", "goal", { create: true });
    expect(result.dryRun).toBe(true);
    expect(result.created).toBe(0);
    expect(result.proposed).toBe(1);
  });

  it("creates via the installation-token path when dryRun:false and create:true, and records an audit event", async () => {
    const run = vi.fn(async () => issuesResponse([{ title: "Add retry to the sync job", body: "Retries transient failures." }]));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      return Response.json({ number: 900, html_url: "https://github.com/acme/widgets/issues/900" });
    });
    const auditSpy = vi.spyOn(repositories, "recordAuditEvent").mockResolvedValue(undefined);
    vi.spyOn(repositories, "getRepository").mockResolvedValue(installedRepo("acme/widgets"));
    vi.spyOn(repositories, "listOpenIssues").mockResolvedValue([]);
    const env = baseEnv({ AI: { run } as unknown as Ai, GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });

    const result = await generateIssuePlanDrafts(env, "acme/widgets", "goal", { create: true, dryRun: false, requestedBy: "maintainer" });
    expect(result.created).toBe(1);
    expect(result.drafts[0]).toMatchObject({ status: "created", issue: { number: 900, url: "https://github.com/acme/widgets/issues/900" } });
    expect(auditSpy).toHaveBeenCalledWith(env, expect.objectContaining({ eventType: "issue_plan.drafts_created", metadata: expect.objectContaining({ requestedBy: "maintainer", created: 1 }) }));
  });

  it("defaults the audit event's requestedBy to \"mcp\" when the caller omits it", async () => {
    const run = vi.fn(async () => issuesResponse([{ title: "Add retry to the sync job", body: "Retries transient failures." }]));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      return Response.json({ number: 901, html_url: "https://github.com/acme/widgets/issues/901" });
    });
    const auditSpy = vi.spyOn(repositories, "recordAuditEvent").mockResolvedValue(undefined);
    vi.spyOn(repositories, "getRepository").mockResolvedValue(installedRepo("acme/widgets"));
    vi.spyOn(repositories, "listOpenIssues").mockResolvedValue([]);
    const env = baseEnv({ AI: { run } as unknown as Ai, GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    await generateIssuePlanDrafts(env, "acme/widgets", "goal", { create: true, dryRun: false });
    expect(auditSpy).toHaveBeenCalledWith(env, expect.objectContaining({ metadata: expect.objectContaining({ requestedBy: "mcp" }) }));
  });

  it("records skipped_create_failed when there is no installation for this repo", async () => {
    const run = vi.fn(async () => issuesResponse([{ title: "Add retry", body: "Body" }]));
    const env = baseEnv({ AI: { run } as unknown as Ai });
    vi.spyOn(repositories, "getRepository").mockResolvedValue(null);
    vi.spyOn(repositories, "listOpenIssues").mockResolvedValue([]);
    const result = await generateIssuePlanDrafts(env, "acme/widgets", "goal", { create: true, dryRun: false });
    expect(result.skippedCreateFailed).toBe(1);
    expect(result.drafts[0]?.status).toBe("skipped_create_failed");
  });

  it("records skipped_create_failed when GitHub returns a non-2xx response", async () => {
    const run = vi.fn(async () => issuesResponse([{ title: "Add retry", body: "Body" }]));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      return new Response("nope", { status: 403 });
    });
    vi.spyOn(repositories, "getRepository").mockResolvedValue(installedRepo("acme/widgets"));
    vi.spyOn(repositories, "listOpenIssues").mockResolvedValue([]);
    const env = baseEnv({ AI: { run } as unknown as Ai, GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    const result = await generateIssuePlanDrafts(env, "acme/widgets", "goal", { create: true, dryRun: false });
    expect(result.skippedCreateFailed).toBe(1);
  });

  it("does not resolve or create a milestone on a dry run, even when one is requested", async () => {
    const run = vi.fn(async () => issuesResponse([{ title: "Add retry", body: "Body" }]));
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      calls.push(input.toString());
      return new Response("unexpected", { status: 599 });
    });
    const env = baseEnv({ AI: { run } as unknown as Ai });
    vi.spyOn(repositories, "getRepository").mockResolvedValue(installedRepo("acme/widgets"));
    vi.spyOn(repositories, "listOpenIssues").mockResolvedValue([]);
    const result = await generateIssuePlanDrafts(env, "acme/widgets", "goal", { milestone: { title: "Wave 5" } });
    expect(result.milestoneNumber).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("creates a new milestone and assigns it to every created issue when no matching open milestone exists (#7427)", async () => {
    const run = vi.fn(async () => issuesResponse([{ title: "Add retry to the sync job", body: "Retries transient failures." }]));
    const bodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/milestones") && method === "GET") return Response.json([{ number: 9, title: "Unrelated milestone" }]);
      if (url.includes("/milestones") && method === "POST") {
        bodies.push({ url, body: JSON.parse(init?.body as string) });
        return Response.json({ number: 55, title: "Wave 5" });
      }
      if (url.includes("/issues") && method === "POST") {
        bodies.push({ url, body: JSON.parse(init?.body as string) });
        return Response.json({ number: 900, html_url: "https://github.com/acme/widgets/issues/900" });
      }
      return new Response("unexpected", { status: 599 });
    });
    vi.spyOn(repositories, "getRepository").mockResolvedValue(installedRepo("acme/widgets"));
    vi.spyOn(repositories, "listOpenIssues").mockResolvedValue([]);
    const env = baseEnv({ AI: { run } as unknown as Ai, GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });

    const result = await generateIssuePlanDrafts(env, "acme/widgets", "goal", { create: true, dryRun: false, milestone: { title: "Wave 5", description: "the wave", dueOn: "2026-08-01T00:00:00Z" } });
    expect(result.milestoneNumber).toBe(55);
    expect(result.created).toBe(1);
    const milestoneCreate = bodies.find((entry) => entry.url.includes("/milestones"));
    expect(milestoneCreate?.body).toMatchObject({ title: "Wave 5", description: "the wave", due_on: "2026-08-01T00:00:00Z" });
    const issueCreate = bodies.find((entry) => entry.url.includes("/issues"));
    expect(issueCreate?.body).toMatchObject({ milestone: 55 });
  });

  it("reuses an existing open milestone by exact normalized title instead of creating a new one (#7427)", async () => {
    const run = vi.fn(async () => issuesResponse([{ title: "Add retry", body: "Body" }]));
    let milestonePostCalled = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/milestones") && method === "GET") return Response.json([{ number: 7, title: "  Wave   5!!" }]);
      if (url.includes("/milestones") && method === "POST") {
        milestonePostCalled = true;
        return Response.json({ number: 999, title: "Wave 5" });
      }
      if (url.includes("/issues") && method === "POST") return Response.json({ number: 901, html_url: "https://github.com/acme/widgets/issues/901" });
      return new Response("unexpected", { status: 599 });
    });
    vi.spyOn(repositories, "getRepository").mockResolvedValue(installedRepo("acme/widgets"));
    vi.spyOn(repositories, "listOpenIssues").mockResolvedValue([]);
    const env = baseEnv({ AI: { run } as unknown as Ai, GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });

    const result = await generateIssuePlanDrafts(env, "acme/widgets", "goal", { create: true, dryRun: false, milestone: { title: "Wave 5" } });
    expect(result.milestoneNumber).toBe(7);
    expect(milestonePostCalled).toBe(false);
  });

  it("creates directly (skipping the existing-milestone lookup) when the milestone title normalizes to an empty key", async () => {
    const run = vi.fn(async () => issuesResponse([{ title: "Add retry", body: "Body" }]));
    let listCalled = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/milestones") && method === "GET") {
        listCalled = true;
        return Response.json([]);
      }
      if (url.includes("/milestones") && method === "POST") return Response.json({ number: 77, title: "###" });
      if (url.includes("/issues") && method === "POST") return Response.json({ number: 903, html_url: "https://github.com/acme/widgets/issues/903" });
      return new Response("unexpected", { status: 599 });
    });
    vi.spyOn(repositories, "getRepository").mockResolvedValue(installedRepo("acme/widgets"));
    vi.spyOn(repositories, "listOpenIssues").mockResolvedValue([]);
    const env = baseEnv({ AI: { run } as unknown as Ai, GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });

    const result = await generateIssuePlanDrafts(env, "acme/widgets", "goal", { create: true, dryRun: false, milestone: { title: "###" } });
    expect(result.milestoneNumber).toBe(77);
    expect(listCalled).toBe(false);
  });

  it("degrades gracefully (still creates the issues, without a milestone) when milestone resolution fails", async () => {
    const run = vi.fn(async () => issuesResponse([{ title: "Add retry", body: "Body" }]));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/milestones")) return new Response("nope", { status: 500 });
      if (url.includes("/issues") && method === "POST") return Response.json({ number: 902, html_url: "https://github.com/acme/widgets/issues/902" });
      return new Response("unexpected", { status: 599 });
    });
    vi.spyOn(repositories, "getRepository").mockResolvedValue(installedRepo("acme/widgets"));
    vi.spyOn(repositories, "listOpenIssues").mockResolvedValue([]);
    const env = baseEnv({ AI: { run } as unknown as Ai, GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });

    const result = await generateIssuePlanDrafts(env, "acme/widgets", "goal", { create: true, dryRun: false, milestone: { title: "Wave 5" } });
    expect(result.milestoneNumber).toBeUndefined();
    expect(result.created).toBe(1);
    expect(result.drafts[0]?.status).toBe("created");
  });

  it("never attempts milestone resolution when the repo has no installation", async () => {
    const run = vi.fn(async () => issuesResponse([{ title: "Add retry", body: "Body" }]));
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      calls.push(input.toString());
      return new Response("unexpected", { status: 599 });
    });
    vi.spyOn(repositories, "getRepository").mockResolvedValue(null);
    vi.spyOn(repositories, "listOpenIssues").mockResolvedValue([]);
    const env = baseEnv({ AI: { run } as unknown as Ai });
    const result = await generateIssuePlanDrafts(env, "acme/widgets", "goal", { create: true, dryRun: false, milestone: { title: "Wave 5" } });
    expect(result.milestoneNumber).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(result.skippedCreateFailed).toBe(1);
  });

  it("REGRESSION: the global agent brake / freeze overrides {dryRun:false}, so nothing is created", async () => {
    const run = vi.fn(async () => issuesResponse([{ title: "Add retry", body: "Body" }]));
    vi.spyOn(repositories, "getRepository").mockResolvedValue(installedRepo("acme/widgets"));
    vi.spyOn(repositories, "listOpenIssues").mockResolvedValue([]);

    const frozenEnv = baseEnv({ AI: { run } as unknown as Ai });
    await repositories.setGlobalAgentFrozen(frozenEnv, true);
    const frozen = await generateIssuePlanDrafts(frozenEnv, "acme/widgets", "goal", { create: true, dryRun: false });
    expect(frozen.dryRun).toBe(true);
    expect(frozen.created).toBe(0);

    const pausedEnv = baseEnv({ AI: { run } as unknown as Ai, AGENT_ACTIONS_PAUSED: "true" });
    const paused = await generateIssuePlanDrafts(pausedEnv, "acme/widgets", "goal", { create: true, dryRun: false });
    expect(paused.dryRun).toBe(true);
    expect(paused.created).toBe(0);
  });
});

describe("findDuplicateIssuePlanDraft", () => {
  it("returns null for an empty title key or no matches", () => {
    expect(findDuplicateIssuePlanDraft([], { fingerprint: "fp", title: "!!!" })).toBeNull();
    expect(findDuplicateIssuePlanDraft([openIssue(1, "closed one")], { fingerprint: "fp", title: "closed one" })).not.toBeNull();
    expect(findDuplicateIssuePlanDraft([{ ...openIssue(1, "x"), state: "closed" }], { fingerprint: "fp", title: "x" })).toBeNull();
  });

  it("scans past a non-matching open issue's title before concluding there is no duplicate", () => {
    expect(findDuplicateIssuePlanDraft([openIssue(1, "an unrelated open issue")], { fingerprint: "fp", title: "a completely different title" })).toBeNull();
  });
});

describe("findDeclinedIssuePlanDraft", () => {
  it("ignores open issues, missing markers, and other fingerprints", () => {
    const marker = issuePlanDraftMarker("fp");
    expect(findDeclinedIssuePlanDraft([{ ...openIssue(1, "t", marker), state: "open" }], { fingerprint: "fp" })).toBeNull();
    expect(findDeclinedIssuePlanDraft([{ ...openIssue(1, "t", "no marker here"), state: "closed" }], { fingerprint: "fp" })).toBeNull();
    expect(findDeclinedIssuePlanDraft([{ ...openIssue(1, "t", marker), state: "closed", authorAssociation: "NONE", closedAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString() }], { fingerprint: "other" })).toBeNull();
  });

  it("does not suppress an untrusted (non-maintainer) closed issue without a wontfix label", () => {
    const marker = issuePlanDraftMarker("fp");
    const result = findDeclinedIssuePlanDraft([{ ...openIssue(1, "t", marker), state: "closed", authorAssociation: "NONE", closedAt: new Date().toISOString() }], { fingerprint: "fp" });
    expect(result).toBeNull();
  });

  it("treats a missing close timestamp on a trusted maintainer-authored issue as still within cooldown (suppress)", () => {
    const marker = issuePlanDraftMarker("fp");
    const result = findDeclinedIssuePlanDraft([{ ...openIssue(1, "t", marker), state: "closed", authorAssociation: "OWNER", closedAt: undefined }], { fingerprint: "fp" });
    expect(result).toMatchObject({ reason: "cooldown" });
  });

  it("resurfaces after the cooldown window for a maintainer-authored closure without a wontfix label", () => {
    const marker = issuePlanDraftMarker("fp");
    const result = findDeclinedIssuePlanDraft(
      [{ ...openIssue(1, "t", marker), state: "closed", authorAssociation: "OWNER", closedAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(), updatedAt: new Date().toISOString() }],
      { fingerprint: "fp" },
    );
    expect(result).toBeNull();
  });
});
