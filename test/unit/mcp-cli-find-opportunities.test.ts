import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

const bin = join(process.cwd(), "packages/gittensory-mcp/bin/loopover-mcp.js");
const FORBIDDEN_PUBLIC_TERMS = /wallet\s*[:=]\s*\S+|hotkey\s*[:=]\s*\S+|coldkey\s*[:=]\s*\S+|raw trust score is|your trust score|reward estimate is|estimated reward/i;

let client: Client;
let transport: StdioClientTransport;
let configDir: string;
let apiUrl: string;
let capturedRequests: Array<{ url: string; method: string; body: string }>;

async function connect() {
  configDir = mkdtempSync(join(tmpdir(), "gittensory-find-opp-"));
  capturedRequests = [];
  apiUrl = await startFixtureServer({
    onApiRequest: (request) => {
      if (request.url && request.url.includes("/v1/opportunities/find")) {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          capturedRequests.push({
            url: request.url ?? "",
            method: request.method ?? "GET",
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    },
  });
  transport = new StdioClientTransport({
    command: "node",
    args: [bin, "--stdio"],
    env: {
      ...process.env,
      GITTENSORY_CONFIG_DIR: configDir,
      GITTENSORY_API_URL: apiUrl,
      GITTENSORY_TOKEN: "session-token",
      GITTENSORY_API_TIMEOUT_MS: "5000",
    },
  });
  client = new Client({ name: "find-opportunities-test", version: "0.0.1" });
  await client.connect(transport);
}

async function disconnect() {
  await client.close().catch(() => undefined);
  await closeFixtureServer();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
}

describe("loopover_find_opportunities stdio proxy", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("registers the tool in the stdio server's tool list", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("loopover_find_opportunities");
  });

  it("proxies the call to /v1/opportunities/find via apiPost", async () => {
    await client.callTool({
      name: "loopover_find_opportunities",
      arguments: { searchQuery: "test coverage", limit: 3 },
    });
    expect(capturedRequests.length).toBe(1);
    const captured = capturedRequests[0]!;
    expect(captured.url).toContain("/v1/opportunities/find");
    expect(captured.method).toBe("POST");
    const parsedBody = JSON.parse(captured.body) as { searchQuery?: string; limit?: number };
    expect(parsedBody.searchQuery).toBe("test coverage");
    expect(parsedBody.limit).toBe(3);
  });

  it("returns a ranked, public-safe list of opportunities", async () => {
    const result = await client.callTool({
      name: "loopover_find_opportunities",
      arguments: { searchQuery: "scoring", limit: 2 },
    });
    expect(result.isError).toBeFalsy();
    const text = JSON.stringify(result);
    expect(text).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
    expect(text).toContain("rankScore");
    expect(text).toContain("laneFit");
    expect(text).toContain("aiPolicyAllowed");
  });

  it("strips undefined optional fields from the proxied body", async () => {
    await client.callTool({
      name: "loopover_find_opportunities",
      arguments: { searchQuery: "minimum" },
    });
    expect(capturedRequests.length).toBe(1);
    const parsedBody = JSON.parse(capturedRequests[0]!.body) as Record<string, unknown>;
    expect(parsedBody.searchQuery).toBe("minimum");
    expect("targets" in parsedBody).toBe(false);
    expect("goalSpec" in parsedBody).toBe(false);
    expect("limit" in parsedBody).toBe(false);
  });
});