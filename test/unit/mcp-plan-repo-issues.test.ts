import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { LoopoverMcp } from "../../src/mcp/server";
import { clearInstallationTokenCacheForTest } from "../../src/github/app";
import { upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { generateIssuePlanDrafts } from "../../src/services/issue-plan-draft";
import type { AuthIdentity } from "../../src/auth/security";
import { createTestEnv } from "../helpers/d1";

const REPO = "owner/widgets";
const AI_ENABLED = { AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true" };

function issuesResponse(issues: Array<Record<string, unknown>>): { response: string } {
  return { response: JSON.stringify({ issues }) };
}

function generateRsaPrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}

async function connect(env: Env, identity?: AuthIdentity) {
  const server = (identity ? new LoopoverMcp(env, identity) : new LoopoverMcp(env)).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "loopover-plan-repo-issues-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

async function seedRepo(env: ReturnType<typeof createTestEnv>): Promise<void> {
  await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: REPO, private: false, owner: { login: "owner" }, default_branch: "main" }, 555);
}

// The api static identity is unconditionally trusted (matches mcp-generate-contributor-issue-drafts.test.ts), so
// it exercises the happy path without needing an actuation allowlist.
const API_IDENTITY = { kind: "static", actor: "api" } as AuthIdentity;

describe("MCP loopover_plan_repo_issues (#7426)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearInstallationTokenCacheForTest();
  });

  it("previews drafts on a dry run and returns full draft content (unlike the scrubbed contributor-drafts tool)", async () => {
    const run = async () => issuesResponse([{ title: "Add retry to the sync job", body: "Retries transient failures with backoff." }]);
    const env = createTestEnv({ ...AI_ENABLED, AI: { run } as unknown as Ai });
    await seedRepo(env);
    const client = await connect(env, API_IDENTITY);
    const result = await client.callTool({ name: "loopover_plan_repo_issues", arguments: { owner: "owner", repo: "widgets", goal: "improve sync reliability" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data).toMatchObject({ repoFullName: REPO, status: "ok", dryRun: true, createRequested: false, created: 0 });
    const drafts = data.drafts as Array<{ title: string; body: string }>;
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.title).toBe("Add retry to the sync job");
    expect(drafts[0]?.body).toContain("Retries transient failures");
  });

  it("surfaces the created issue's number and url in the response when create succeeds", async () => {
    const run = async () => issuesResponse([{ title: "Add retry to the sync job", body: "Retries transient failures." }]);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      return Response.json({ number: 42, html_url: "https://github.com/owner/widgets/issues/42" });
    });
    const env = createTestEnv({ ...AI_ENABLED, AI: { run } as unknown as Ai, GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    await seedRepo(env);
    const client = await connect(env, API_IDENTITY);
    const result = await client.callTool({ name: "loopover_plan_repo_issues", arguments: { owner: "owner", repo: "widgets", goal: "improve sync reliability", create: true, dryRun: false } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    const drafts = data.drafts as Array<{ status: string; issueNumber?: number; issueUrl?: string }>;
    expect(drafts[0]).toMatchObject({ status: "created", issueNumber: 42, issueUrl: "https://github.com/owner/widgets/issues/42" });
  });

  it("resolves the requested milestone and surfaces its number when create succeeds (#7427)", async () => {
    const run = async () => issuesResponse([{ title: "Add retry to the sync job", body: "Retries transient failures." }]);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/milestones") && method === "GET") return Response.json([]);
      if (url.includes("/milestones") && method === "POST") return Response.json({ number: 55, title: "Wave 5" });
      return Response.json({ number: 42, html_url: "https://github.com/owner/widgets/issues/42" });
    });
    const env = createTestEnv({ ...AI_ENABLED, AI: { run } as unknown as Ai, GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    await seedRepo(env);
    const client = await connect(env, API_IDENTITY);
    const result = await client.callTool({
      name: "loopover_plan_repo_issues",
      arguments: { owner: "owner", repo: "widgets", goal: "improve sync reliability", create: true, dryRun: false, milestone: { title: "Wave 5" } },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ milestoneNumber: 55 });
  });

  it("REJECTS create without an explicit dryRun:false — the tool can never silently create", async () => {
    const env = createTestEnv({ ...AI_ENABLED });
    await seedRepo(env);
    const client = await connect(env, API_IDENTITY);
    const result = await client.callTool({ name: "loopover_plan_repo_issues", arguments: { owner: "owner", repo: "widgets", goal: "improve sync reliability", create: true } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/explicit_create_requires_dry_run_false/);
  });

  it("rejects a missing or empty goal", async () => {
    const env = createTestEnv({ ...AI_ENABLED });
    await seedRepo(env);
    const client = await connect(env, API_IDENTITY);
    const missing = await client.callTool({ name: "loopover_plan_repo_issues", arguments: { owner: "owner", repo: "widgets" } });
    expect(missing.isError).toBe(true);
    const empty = await client.callTool({ name: "loopover_plan_repo_issues", arguments: { owner: "owner", repo: "widgets", goal: "" } });
    expect(empty.isError).toBe(true);
  });

  it("denies a static MCP-token caller when the repo is not in MCP_ACTUATION_REPO_ALLOWLIST", async () => {
    const env = createTestEnv({ ...AI_ENABLED, MCP_ACTUATION_REPO_ALLOWLIST: "" });
    await seedRepo(env);
    const client = await connect(env); // default identity: { kind: "static", actor: "mcp" }
    const result = await client.callTool({ name: "loopover_plan_repo_issues", arguments: { owner: "owner", repo: "widgets", goal: "improve sync reliability" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/MCP_ACTUATION_REPO_ALLOWLIST/);
  });

  it("allows an operator session and attributes the request to that actor", async () => {
    const env = createTestEnv({ ...AI_ENABLED, ADMIN_GITHUB_LOGINS: "maintainer-login" });
    await seedRepo(env);
    const client = await connect(env, { kind: "session", actor: "maintainer-login" } as AuthIdentity);
    const result = await client.callTool({ name: "loopover_plan_repo_issues", arguments: { owner: "owner", repo: "widgets", goal: "improve sync reliability" } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ repoFullName: REPO, dryRun: true, createRequested: false });
  });

  it("the MCP tool's output mirrors the underlying service for identical input (surface parity)", async () => {
    const env = createTestEnv({ ...AI_ENABLED });
    await seedRepo(env);
    const direct = await generateIssuePlanDrafts(env, REPO, "improve sync reliability", { dryRun: true, limit: 5, requestedBy: "api" });
    const client = await connect(env, API_IDENTITY);
    const result = await client.callTool({ name: "loopover_plan_repo_issues", arguments: { owner: "owner", repo: "widgets", goal: "improve sync reliability", limit: 5 } });
    const data = result.structuredContent as Record<string, unknown>;
    expect(data).toMatchObject({
      repoFullName: direct.repoFullName,
      status: direct.status,
      dryRun: direct.dryRun,
      createRequested: direct.createRequested,
      proposed: direct.proposed,
      skippedDuplicate: direct.skippedDuplicate,
      skippedDeclined: direct.skippedDeclined,
      skippedUnsafe: direct.skippedUnsafe,
      created: direct.created,
      skippedCreateFailed: direct.skippedCreateFailed,
    });
  });
});
