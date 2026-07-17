import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeFixtureServer, run, startFixtureServer } from "./support/mcp-cli-harness";

const bin = join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.js");
const FORBIDDEN_PUBLIC_TERMS = /wallet\s*[:=]\s*\S+|hotkey\s*[:=]\s*\S+|coldkey\s*[:=]\s*\S+|raw trust score is|your trust score|reward estimate is|estimated reward/i;

let client: Client;
let transport: StdioClientTransport;
let configDir: string;
let apiUrl: string;
let capturedRequests: Array<{ url: string; method: string }>;

async function connect() {
  configDir = mkdtempSync(join(tmpdir(), "loopover-bounty-advisory-"));
  capturedRequests = [];
  apiUrl = await startFixtureServer({
    onApiRequest: (request) => {
      if (request.url && request.url.includes("/bounties/")) {
        capturedRequests.push({ url: request.url ?? "", method: request.method ?? "GET" });
      }
    },
  });
  transport = new StdioClientTransport({
    command: "node",
    args: [bin, "--stdio"],
    env: {
      ...process.env,
      LOOPOVER_CONFIG_DIR: configDir,
      LOOPOVER_API_URL: apiUrl,
      LOOPOVER_TOKEN: "session-token",
      LOOPOVER_API_TIMEOUT_MS: "5000",
    },
  });
  client = new Client({ name: "bounty-advisory-test", version: "0.0.1" });
  await client.connect(transport);
}

async function disconnect() {
  await client.close().catch(() => undefined);
  await closeFixtureServer();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
}

describe("loopover_get_bounty_advisory stdio proxy (#6736)", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("registers the tool in the stdio server tool list", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("loopover_get_bounty_advisory");
  });

  it("proxies the call to /v1/bounties/{id}/advisory via apiGet and returns the payload verbatim", async () => {
    const result = await client.callTool({
      name: "loopover_get_bounty_advisory",
      arguments: { id: "bounty-42" },
    });
    expect(capturedRequests.length).toBe(1);
    const captured = capturedRequests[0]!;
    expect(captured.url).toBe("/v1/bounties/bounty-42/advisory");
    expect(captured.method).toBe("GET");
    expect(result.isError).toBeFalsy();
    // Output parity: the tool returns exactly what GET /v1/bounties/{id}/advisory served, unchanged.
    expect(result.structuredContent).toEqual({
      id: "bounty-42",
      repoFullName: "owner/repo",
      issueNumber: 12,
      status: "open",
      isActiveOpportunity: true,
      fundingStatus: { funded: true },
      consensusRisk: { level: "low" },
      linkedPrs: [],
      findings: [],
    });
    const text = JSON.stringify(result);
    expect(text).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
    expect(text).toContain("LoopOver bounty advisory.");
  });

  it("url-encodes the bounty id in the proxied path", async () => {
    await client.callTool({
      name: "loopover_get_bounty_advisory",
      arguments: { id: "owner/repo#7" },
    });
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]!.url).toBe("/v1/bounties/owner%2Frepo%237/advisory");
  });

  it("lists the tool via loopover-mcp tools", () => {
    const payload = JSON.parse(run(["tools", "--json"])) as {
      tools: Array<{ name: string; description: string; category: string }>;
    };
    const tool = payload.tools.find((entry) => entry.name === "loopover_get_bounty_advisory");
    expect(tool?.description).toMatch(/lifecycle, funding, and consensus-risk context/i);
    expect(tool?.category).toBe("discovery");
    expect(tool?.description.trim().length).toBeGreaterThan(0);
  });
});
