import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createSessionForGitHubUser, type AuthIdentity } from "../../src/auth/security";
import {
  markAiReviewPublished,
  putCachedAiReview,
  upsertPullRequestFromGitHub,
  upsertRepositoryFromGitHub,
  upsertRepositorySettings,
} from "../../src/db/repositories";
import { GittensoryMcp } from "../../src/mcp/server";
import { INLINE_FINDINGS_METADATA_KEY } from "../../src/mcp/pr-ai-review-findings";
import { createTestEnv } from "../helpers/d1";

async function connect(env: Env, identity?: AuthIdentity): Promise<Client> {
  const server = (identity ? new GittensoryMcp(env, identity) : new GittensoryMcp(env)).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gittensory-pr-ai-review-findings-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

const inlineFindings = [
  { path: "src/db.ts", line: 12, severity: "blocker" as const, body: "This is vulnerable to SQL injection.", category: "security" as const },
  { path: "src/util.ts", line: 4, severity: "nit" as const, body: "This will throw on an empty array." },
];

async function seedPublishedReview(env: Env): Promise<void> {
  await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: "acme/widgets", private: false, owner: { login: "acme" } });
  await upsertRepositorySettings(env, { repoFullName: "acme/widgets", aiReviewMode: "block" });
  await upsertPullRequestFromGitHub(env, "acme/widgets", {
    number: 42,
    title: "Fix widget cache",
    state: "open",
    user: { login: "miner1" },
    head: { sha: "sha-reviewed" },
    labels: [],
    body: "Fixes #1",
  });
  await putCachedAiReview(env, "acme/widgets", 42, "sha-reviewed", "block", {
    notes: "Two reviewers found issues.",
    reviewerCount: 2,
    metadata: { [INLINE_FINDINGS_METADATA_KEY]: inlineFindings },
  });
  await markAiReviewPublished(env, "acme/widgets", 42, "sha-reviewed");
}

describe("MCP gittensory_get_pr_ai_review_findings (#4519)", () => {
  it("returns structured findings that match the PR comment category counts", async () => {
    const env = createTestEnv();
    await seedPublishedReview(env);
    const result = await (await connect(env)).callTool({
      name: "gittensory_get_pr_ai_review_findings",
      arguments: { login: "miner1", owner: "acme", repo: "widgets", pullNumber: 42 },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as {
      status: string;
      findings: Array<{ category: string; path: string; severity: string; line: number; body: string }>;
      categoryCounts: Record<string, number>;
      headSha: string;
    };
    expect(data.status).toBe("ready");
    expect(data.headSha).toBe("sha-reviewed");
    expect(data.findings).toHaveLength(2);
    expect(data.categoryCounts).toEqual({ security: 1, correctness: 1 });
    expect(data.findings[0]).toMatchObject({ category: "security", path: "src/db.ts", severity: "blocker", line: 12 });
    expect(JSON.stringify(data)).not.toMatch(/wallet|hotkey|reward estimate|trust score/i);
  });

  it("returns not_found when no published AI review exists", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: "acme/widgets", private: false, owner: { login: "acme" } });
    await upsertRepositorySettings(env, { repoFullName: "acme/widgets", aiReviewMode: "block" });
    await upsertPullRequestFromGitHub(env, "acme/widgets", {
      number: 7,
      title: "Draft",
      state: "open",
      user: { login: "miner1" },
      head: { sha: "sha-new" },
      labels: [],
      body: "x",
    });
    const result = await (await connect(env)).callTool({
      name: "gittensory_get_pr_ai_review_findings",
      arguments: { login: "miner1", owner: "acme", repo: "widgets", pullNumber: 7 },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { status: string; findings: unknown[]; categoryCounts: Record<string, never> };
    expect(data.status).toBe("not_found");
    expect(data.findings).toEqual([]);
    expect(data.categoryCounts).toEqual({});
    expect(JSON.stringify(result.content)).toMatch(/No published AI review findings for acme\/widgets#7/i);
  });

  it("returns not_found when the pull request row does not exist", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: "acme/widgets", private: false, owner: { login: "acme" } });
    const result = await (await connect(env)).callTool({
      name: "gittensory_get_pr_ai_review_findings",
      arguments: { login: "miner1", owner: "acme", repo: "widgets", pullNumber: 404 },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { status: string; findings: unknown[] };
    expect(data.status).toBe("not_found");
    expect(data.findings).toEqual([]);
    expect(JSON.stringify(result.content)).toMatch(/No pull request acme\/widgets#404/i);
  });

  it("returns a zero-finding ready summary when the published review has no inline findings", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: "acme/widgets", private: false, owner: { login: "acme" } });
    await upsertRepositorySettings(env, { repoFullName: "acme/widgets", aiReviewMode: "block" });
    await upsertPullRequestFromGitHub(env, "acme/widgets", {
      number: 99,
      title: "Clean",
      state: "open",
      user: { login: "miner1" },
      head: { sha: "sha-clean" },
      labels: [],
      body: "x",
    });
    await putCachedAiReview(env, "acme/widgets", 99, "sha-clean", "block", { notes: "No inline findings.", reviewerCount: 1 });
    await markAiReviewPublished(env, "acme/widgets", 99, "sha-clean");
    const result = await (await connect(env)).callTool({
      name: "gittensory_get_pr_ai_review_findings",
      arguments: { login: "miner1", owner: "acme", repo: "widgets", pullNumber: 99 },
    });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { status: string; findings: unknown[] }).status).toBe("ready");
    expect(JSON.stringify(result.content)).toMatch(/0 AI-review finding\(s\)/i);
  });

  it("returns ai_review_off when the repo has AI review disabled", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: "acme/widgets", private: false, owner: { login: "acme" } });
    await upsertRepositorySettings(env, { repoFullName: "acme/widgets", aiReviewMode: "off" });
    await upsertPullRequestFromGitHub(env, "acme/widgets", {
      number: 8,
      title: "Draft",
      state: "open",
      user: { login: "miner1" },
      head: { sha: "sha-new" },
      labels: [],
      body: "x",
    });
    const result = await (await connect(env)).callTool({
      name: "gittensory_get_pr_ai_review_findings",
      arguments: { login: "miner1", owner: "acme", repo: "widgets", pullNumber: 8 },
    });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { status: string }).status).toBe("ai_review_off");
    expect(JSON.stringify(result.content)).toMatch(/AI review is off for acme\/widgets/i);
  });

  it("forbids reading another contributor's PR findings", async () => {
    const env = createTestEnv();
    await seedPublishedReview(env);
    const result = await (await connect(env)).callTool({
      name: "gittensory_get_pr_ai_review_findings",
      arguments: { login: "other-miner", owner: "acme", repo: "widgets", pullNumber: 42 },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/own pull requests/i);
  });

  it("is self-scoped: a session cannot read findings for another login", async () => {
    const env = createTestEnv();
    await seedPublishedReview(env);
    const { session } = await createSessionForGitHubUser(env, { login: "miner1", id: 1 });
    const result = await (await connect(env, { kind: "session", actor: "miner1", session })).callTool({
      name: "gittensory_get_pr_ai_review_findings",
      arguments: { login: "someone-else", owner: "acme", repo: "widgets", pullNumber: 42 },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/authenticated GitHub login/i);
  });

  it("is repo-scoped: a session cannot read findings from an inaccessible repo", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, {
      name: "private-roadmap",
      full_name: "victimco/private-roadmap",
      private: true,
      owner: { login: "victimco" },
    });
    await upsertRepositorySettings(env, { repoFullName: "victimco/private-roadmap", aiReviewMode: "block" });
    await upsertPullRequestFromGitHub(env, "victimco/private-roadmap", {
      number: 1,
      title: "Secret",
      state: "open",
      user: { login: "miner1" },
      head: { sha: "sha1" },
      labels: [],
      body: "x",
    });
    const { session } = await createSessionForGitHubUser(env, { login: "miner1", id: 1 });
    const result = await (await connect(env, { kind: "session", actor: "miner1", session })).callTool({
      name: "gittensory_get_pr_ai_review_findings",
      arguments: { login: "miner1", owner: "victimco", repo: "private-roadmap", pullNumber: 1 },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/cannot access this repository/i);
  });
});
