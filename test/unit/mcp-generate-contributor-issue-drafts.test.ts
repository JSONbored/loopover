import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { LoopoverMcp } from "../../src/mcp/server";
import type { AuthIdentity } from "../../src/auth/security";
import { createTestEnv } from "../helpers/d1";

const REPO = "JSONbored/gittensory";
const API_IDENTITY: AuthIdentity = { kind: "static", actor: "api" };

async function connect(env: Env, identity?: AuthIdentity) {
  const server = (identity ? new LoopoverMcp(env, identity) : new LoopoverMcp(env)).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gittensory-generate-drafts-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

// #6757 — the MCP mirror of contributor-issue-drafts/generate. The safety guard and dry-run-by-default posture
// are the contract; these tests pin both, plus the manage-access gate and REST parity.
describe("MCP loopover_generate_contributor_issue_drafts (#6757)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("previews contributor issue drafts as a dry run by default (no create, no GitHub write)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = await connect(createTestEnv(), API_IDENTITY);
    const result = await client.callTool({ name: "loopover_generate_contributor_issue_drafts", arguments: { owner: "JSONbored", repo: "gittensory", limit: 2 } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data).toMatchObject({ repoFullName: REPO, dryRun: true, createRequested: false, created: 0 });
    expect(Array.isArray(data.drafts)).toBe(true);
    expect((data.drafts as unknown[]).length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an explicit create that is not paired with dryRun:false (the safety guard is preserved)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = await connect(createTestEnv(), API_IDENTITY);
    const result = await client.callTool({ name: "loopover_generate_contributor_issue_drafts", arguments: { owner: "JSONbored", repo: "gittensory", create: true } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/explicit_create_requires_dry_run_false/);
    // The guard trips before any GitHub write is attempted.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("creates issues when create:true is paired with dryRun:false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ number: 501, html_url: "https://github.com/JSONbored/gittensory/issues/501" })),
    );
    const env = createTestEnv({ LOOPOVER_CONTRIBUTOR_ISSUE_TOKEN: "token" });
    const client = await connect(env, API_IDENTITY);
    const result = await client.callTool({
      name: "loopover_generate_contributor_issue_drafts",
      arguments: { owner: "JSONbored", repo: "gittensory", create: true, dryRun: false, limit: 1 },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data).toMatchObject({ repoFullName: REPO, dryRun: false, createRequested: true });
    expect((result.content as Array<{ text: string }>)[0]?.text).toMatch(/^Generated /);
  });

  it("denies a static MCP-token caller when the repo is not in MCP_ACTUATION_REPO_ALLOWLIST", async () => {
    const client = await connect(createTestEnv({ MCP_ACTUATION_REPO_ALLOWLIST: "" })); // default identity: static mcp
    const result = await client.callTool({ name: "loopover_generate_contributor_issue_drafts", arguments: { owner: "JSONbored", repo: "gittensory" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/MCP_ACTUATION_REPO_ALLOWLIST/);
  });

  it("allows the static MCP-token caller once the repo is explicitly allowlisted", async () => {
    const client = await connect(createTestEnv({ MCP_ACTUATION_REPO_ALLOWLIST: REPO }));
    const result = await client.callTool({ name: "loopover_generate_contributor_issue_drafts", arguments: { owner: "JSONbored", repo: "gittensory", limit: 1 } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ repoFullName: REPO, dryRun: true });
  });

  // The issue's explicit parity requirement: the MCP tool and the REST route are two faces of the same service,
  // so identical input must yield identical output (bar the wall-clock generatedAt stamp).
  it("returns output identical to the REST route for identical input", async () => {
    const env = createTestEnv();
    const args = { owner: "JSONbored", repo: "gittensory", dryRun: true, limit: 3 };

    const client = await connect(env, API_IDENTITY);
    const toolResult = await client.callTool({ name: "loopover_generate_contributor_issue_drafts", arguments: args });
    expect(toolResult.isError).toBeFalsy();
    const toolData = { ...(toolResult.structuredContent as Record<string, unknown>) };

    const app = createApp();
    const response = await app.request(
      `/v1/repos/${REPO}/contributor-issue-drafts/generate`,
      { method: "POST", headers: { authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ dryRun: true, limit: 3 }) },
      env,
    );
    expect(response.status).toBe(200);
    const routeData = (await response.json()) as Record<string, unknown>;

    delete toolData.generatedAt;
    delete routeData.generatedAt;
    expect(toolData).toEqual(routeData);
  });
});
