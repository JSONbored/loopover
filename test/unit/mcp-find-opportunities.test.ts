import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
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

async function connect(env: Env) {
  const server = new GittensoryMcp(env).createServer();
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
});
