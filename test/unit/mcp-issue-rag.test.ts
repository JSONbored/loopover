import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionForGitHubUser, type AuthIdentity } from "../../src/auth/security";
import { upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { GittensoryMcp } from "../../src/mcp/server";
import { validateIssueRagInput } from "../../src/mcp/issue-rag";
import { createTestEnv } from "../helpers/d1";

async function connect(env: Env, identity?: AuthIdentity) {
  const server = new GittensoryMcp(env, identity).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gittensory-issue-rag-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("validateIssueRagInput (#4293)", () => {
  it("rejects missing owner/repo/title and oversized fields", () => {
    expect(validateIssueRagInput({ owner: "", repo: "demo", title: "Add observability context for self-hosted review planning failures" }).ok).toBe(false);
    expect(validateIssueRagInput({ owner: "acme", repo: "", title: "Add observability context for self-hosted review planning failures" }).ok).toBe(false);
    expect(validateIssueRagInput({ owner: "acme", repo: "demo", title: "" }).ok).toBe(false);
    expect(validateIssueRagInput({ owner: "a".repeat(40), repo: "demo", title: "Add observability context for self-hosted review planning failures" })).toMatchObject({ ok: false, reason: "owner_too_long" });
    expect(validateIssueRagInput({ owner: "acme", repo: "demo", title: "Add observability context for self-hosted review planning failures", topK: 0 })).toMatchObject({ ok: false, reason: "invalid_top_k" });
  });
});

describe("MCP gittensory_retrieve_issue_context", () => {
  it("registers the tool and rejects invalid requests before authorization", async () => {
    const env = createTestEnv();
    const client = await connect(env);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("gittensory_retrieve_issue_context");

    const invalid = await client.callTool({
      name: "gittensory_retrieve_issue_context",
      arguments: { owner: "acme", repo: "widgets", title: "" },
    });
    expect(invalid.isError).toBeFalsy();
    expect(invalid.structuredContent).toMatchObject({
      status: "invalid_request",
      reason: "title_required",
    });
  });

  it("returns query_too_short for a one-line issue below the retrieval floor", async () => {
    const env = createTestEnv();
    const client = await connect(env);
    const result = await client.callTool({
      name: "gittensory_retrieve_issue_context",
      arguments: { owner: "acme", repo: "widgets", title: "Tiny" },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      status: "query_too_short",
      repoFullName: "acme/widgets",
      reason: "issue_query_below_retrieval_floor",
    });
    expect(JSON.stringify(result.content)).toContain("below the retrieval floor");
  });

  it("returns metadata-only retrieval telemetry and never leaks source text", async () => {
    const env = createTestEnv({ DB: ragDbStub(), VECTORIZE: vectorizeStub() as unknown as Vectorize, AI: aiStub() as unknown as Ai });
    const client = await connect(env);
    const result = await client.callTool({
      name: "gittensory_retrieve_issue_context",
      arguments: {
        owner: "acme",
        repo: "widgets",
        title: "Improve SQLite backup readiness checks",
        body: "Operators need restore guidance tied to the existing self-host backup flow.",
        labels: ["selfhost"],
      },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as {
      status: string;
      telemetry: { retrievedPaths: string[]; injected: boolean };
    };
    expect(data.status).toBe("ok");
    expect(data.telemetry.injected).toBe(true);
    expect(data.telemetry.retrievedPaths).toEqual(["src/helper.ts"]);
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/export function helper|RELEVANT EXISTING CODE|wallet|hotkey|reward/i);
    expect(JSON.stringify(result.content)).toContain("metadata-only context for 1 related path.");
  });

  it("summarizes empty retrieval when the hosted backend is unavailable", async () => {
    const env = createTestEnv();
    const client = await connect(env);
    const result = await client.callTool({
      name: "gittensory_retrieve_issue_context",
      arguments: {
        owner: "acme",
        repo: "widgets",
        title: "Improve SQLite backup readiness checks",
        body: "Operators need restore guidance tied to the existing self-host backup flow.",
      },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      status: "ok",
      telemetry: { injected: false, retrievedPathCount: 0 },
    });
    expect(JSON.stringify(result.content)).toContain("found no issue-centric RAG context");
  });

  it("uses plural path wording when multiple related paths are retrieved", async () => {
    const env = createTestEnv({
      DB: ragDbStub({
        chunkRows: [
          { id: "v1", text: "export function helper() { return 1; }" },
          { id: "v2", text: "export function backup() { return 2; }" },
        ],
      }),
      VECTORIZE: vectorizeStub([
        { id: "v1", score: 0.92, metadata: { path: "src/helper.ts" } },
        { id: "v2", score: 0.88, metadata: { path: "src/backup.ts" } },
      ]) as unknown as Vectorize,
      AI: aiStub() as unknown as Ai,
    });
    const client = await connect(env);
    const result = await client.callTool({
      name: "gittensory_retrieve_issue_context",
      arguments: {
        owner: "acme",
        repo: "widgets",
        title: "Improve SQLite backup readiness checks",
        body: "Operators need restore guidance tied to the existing self-host backup flow.",
      },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      status: "ok",
      telemetry: { injected: true, retrievedPathCount: 2 },
    });
    expect((result.structuredContent as { telemetry: { retrievedPaths: string[] } }).telemetry.retrievedPaths.sort()).toEqual(
      ["src/backup.ts", "src/helper.ts"],
    );
    expect(JSON.stringify(result.content)).toContain("metadata-only context for 2 related paths.");
  });

  it("rejects out-of-scope repo access for extension-contributor sessions", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "private-roadmap", full_name: "victimco/private-roadmap", private: true, owner: { login: "victimco" } });
    const { session } = await createSessionForGitHubUser(env, { login: "contributor-dev", id: 555 }, { scopes: ["extension:contributor_context"] });
    const client = await connect(env, { kind: "session", actor: "contributor-dev", session });

    const result = await client.callTool({
      name: "gittensory_retrieve_issue_context",
      arguments: {
        owner: "victimco",
        repo: "private-roadmap",
        title: "Improve SQLite backup readiness checks",
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/session cannot access this repository/i);
  });
});

const VEC_1024 = Array.from({ length: 1024 }, () => 0.01);

function ragDbStub(opts: { count?: number; chunkRows?: Array<{ id: string; text: string }> } = {}) {
  const count = opts.count ?? 5;
  const chunkRows = opts.chunkRows ?? [{ id: "v1", text: "export function helper() { return 1; }" }];
  const prepared = (sql: string) => ({
    bind: (..._values: unknown[]) => ({
      first: vi.fn(async () => (/COUNT\(\*\)/i.test(sql) ? { n: count } : null)),
      all: vi.fn(async () => ({ results: /SELECT id, text/i.test(sql) ? chunkRows : [] })),
      run: vi.fn(async () => undefined),
    }),
  });
  return { prepare: vi.fn((sql: string) => prepared(sql)), batch: vi.fn(async () => []) } as unknown as D1Database;
}

function vectorizeStub(matches = [{ id: "v1", score: 0.92, metadata: { path: "src/helper.ts" } }]) {
  return {
    upsert: vi.fn(async () => ({ mutationId: "m1" })),
    query: vi.fn(async () => ({ matches })),
    deleteByIds: vi.fn(async () => ({ mutationId: "m2" })),
  };
}

function aiStub() {
  return {
    run: vi.fn(async (model: string) => (model === "@cf/baai/bge-m3" ? { data: [VEC_1024] } : { response: "{}" })),
  };
}
