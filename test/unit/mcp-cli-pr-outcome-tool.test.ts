// #6747: the CLI/stdio mirror of loopover_pr_outcome. The MCP tool and GET /v1/contributors/:login/pr-outcomes
// already served this; only the stdio surface was missing. These pin the two things that can silently rot: the
// tool is registered, and it proxies to the SAME route the MCP tool hits, returning that route's payload verbatim
// (so the CLI, the remote tool, and the REST route never drift into three different answers for one login).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeFixtureServer, prOutcomesFixture, startFixtureServer } from "./support/mcp-cli-harness";

const bin = join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.js");

let client: Client;
let transport: StdioClientTransport;
let configDir: string;
let capturedRequests: Array<{ url: string; method: string }>;

async function connect() {
  configDir = mkdtempSync(join(tmpdir(), "loopover-pr-outcome-"));
  capturedRequests = [];
  const apiUrl = await startFixtureServer({
    onApiRequest: (request) => {
      if (request.url && request.url.includes("/pr-outcomes")) {
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
  client = new Client({ name: "pr-outcome-test", version: "0.0.1" });
  await client.connect(transport);
}

async function disconnect() {
  await client.close().catch(() => undefined);
  await closeFixtureServer();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
}

describe("loopover_pr_outcome stdio proxy (#6747)", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("registers the tool in the stdio server tool list", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("loopover_pr_outcome");
  });

  it("proxies login to GET /v1/contributors/:login/pr-outcomes and returns the route's payload", async () => {
    const result = await client.callTool({ name: "loopover_pr_outcome", arguments: { login: "JSONbored" } });
    expect(capturedRequests.length).toBe(1);
    const captured = capturedRequests[0]!;
    expect(captured.url).toContain("/v1/contributors/JSONbored/pr-outcomes");
    expect(captured.method).toBe("GET");
    expect(result.isError).toBeFalsy();
    // PARITY: the stdio tool surfaces exactly the route payload, unmodified.
    expect((result as { structuredContent?: unknown }).structuredContent).toEqual(prOutcomesFixture());
  });

  it("forwards the optional limit as a query parameter", async () => {
    await client.callTool({ name: "loopover_pr_outcome", arguments: { login: "JSONbored", limit: 5 } });
    expect(capturedRequests.length).toBe(1);
    expect(capturedRequests[0]!.url).toContain("/v1/contributors/JSONbored/pr-outcomes?limit=5");
  });
});
