import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionForGitHubUser, type AuthIdentity } from "../../src/auth/security";
import { upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { GittensoryMcp } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/ai-policy");

function readFixture(name: string): string {
  return readFileSync(join(fixtureDir, name), "utf8");
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return Response.json(body, {
    ...init,
    headers: {
      "x-ratelimit-remaining": "42",
      "x-ratelimit-reset": "1800000000",
      ...(init.headers ?? {}),
    },
  });
}

function contentResponse(content: string) {
  return jsonResponse({
    type: "file",
    encoding: "base64",
    content: Buffer.from(content, "utf8").toString("base64"),
  });
}

const issue = (number: number) => ({
  number,
  title: `Issue ${number}`,
  labels: ["good first issue"],
  comments: 1,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T01:00:00Z",
  html_url: `https://github.com/acme/allowed/issues/${number}`,
});

async function connect(env: Env, identity?: AuthIdentity) {
  const server = new GittensoryMcp(env, identity).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gittensory-find-opportunities-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MCP gittensory_find_opportunities", () => {
  it("registers the tool and rejects empty requests", async () => {
    const env = createTestEnv();
    const client = await connect(env);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("gittensory_find_opportunities");

    const invalid = await client.callTool({ name: "gittensory_find_opportunities", arguments: {} });
    expect(invalid.isError).toBeFalsy();
    expect(invalid.structuredContent).toMatchObject({
      status: "invalid_request",
      reason: "targets_or_search_query_required",
      ranked: [],
    });
  });

  it("returns a public-safe ranked list and never includes banned repos", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "test-token" });
    const bannedPolicy = readFixture("banned-ai-usage.md");
    const allowedPolicy = readFixture("allowed-silent.md");

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/repos/acme/banned/contents/AI-USAGE.md")) return contentResponse(bannedPolicy);
      if (url.includes("/repos/acme/banned/issues?")) throw new Error("banned repo must be hard-skipped");
      if (url.includes("/repos/acme/allowed/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.includes("/repos/acme/allowed/contents/CONTRIBUTING.md")) return contentResponse(allowedPolicy);
      if (url.includes("/repos/acme/allowed/issues?")) return jsonResponse([issue(11)]);
      return jsonResponse({}, { status: 404 });
    });

    const client = await connect(env);
    const result = await client.callTool({
      name: "gittensory_find_opportunities",
      arguments: {
        targets: [
          { owner: "acme", repo: "banned" },
          { owner: "acme", repo: "allowed" },
        ],
        limit: 2,
      },
    });

    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as {
      status: string;
      ranked: Array<{ owner: string; repo: string; issueNumber: number; rankScore: number; aiPolicyAllowed: true }>;
    };
    expect(data.status).toBe("ok");
    expect(data.ranked.map((entry) => `${entry.owner}/${entry.repo}`)).toEqual(["acme/allowed"]);
    expect(data.ranked[0]?.aiPolicyAllowed).toBe(true);
    expect(JSON.stringify(data)).not.toMatch(/wallet|hotkey|reward estimate|trust score/i);
  });

  it("rejects oversized target lists before authorization", async () => {
    const env = createTestEnv();
    const client = await connect(env);

    const result = await client.callTool({
      name: "gittensory_find_opportunities",
      arguments: { targets: Array.from({ length: 26 }, () => ({ owner: "acme", repo: "allowed" })) },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/Too big|maximum|25/i);
  });

  it("rejects cross-repo search for non-operator sessions", async () => {
    const env = createTestEnv();
    const { session } = await createSessionForGitHubUser(env, { login: "miner1", id: 1 });
    const client = await connect(env, { kind: "session", actor: "miner1", session });

    const result = await client.callTool({
      name: "gittensory_find_opportunities",
      arguments: { searchQuery: "test coverage" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/cross-repo opportunity search/i);
  });

  it("rejects extension-contributor sessions for search and out-of-scope targets", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "private-roadmap", full_name: "victimco/private-roadmap", private: true, owner: { login: "victimco" } });
    const { session } = await createSessionForGitHubUser(env, { login: "contributor-dev", id: 555 }, { scopes: ["extension:contributor_context"] });
    const client = await connect(env, { kind: "session", actor: "contributor-dev", session });

    const search = await client.callTool({
      name: "gittensory_find_opportunities",
      arguments: { searchQuery: "test coverage" },
    });
    expect(search.isError).toBe(true);
    expect(JSON.stringify(search.content)).toMatch(/cross-repo opportunity search/i);

    const targets = await client.callTool({
      name: "gittensory_find_opportunities",
      arguments: { targets: [{ owner: "victimco", repo: "private-roadmap" }] },
    });
    expect(targets.isError).toBe(true);
    expect(JSON.stringify(targets.content)).toMatch(/session cannot access this repository/i);
  });
});
