import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

const bin = join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.js");
const FORBIDDEN_PUBLIC_TERMS = /wallet\s*[:=]\s*\S+|hotkey\s*[:=]\s*\S+|coldkey\s*[:=]\s*\S+|raw trust score is|your trust score|reward estimate is|estimated reward/i;

let client: Client;
let transport: StdioClientTransport;
let configDir: string;
let apiUrl: string;
let capturedRequests: Array<{ url: string; method: string }>;

async function connect() {
  configDir = mkdtempSync(join(tmpdir(), "gittensory-bounty-advisory-"));
  capturedRequests = [];
  apiUrl = await startFixtureServer({
    onApiRequest: (request) => {
      if (request.url && request.url.includes("/v1/bounties/")) {
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

describe("loopover_get_bounty_advisory stdio proxy", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("registers the tool in the stdio server tool list", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("loopover_get_bounty_advisory");
  });

  it("proxies the bounty id to the public GET /v1/bounties/:id/advisory route via apiGet", async () => {
    const result = await client.callTool({ name: "loopover_get_bounty_advisory", arguments: { id: "bounty-42" } });
    // The fixture server has no bounties route, so it 404s -- the point of THIS test is the proxy contract
    // (the exact path + verb the remote tool wraps), which the tool computes before any response comes back.
    expect(capturedRequests.length).toBe(1);
    const captured = capturedRequests[0]!;
    expect(captured.url).toContain("/v1/bounties/bounty-42/advisory");
    expect(captured.method).toBe("GET");
    // Never leaks a private/reward term regardless of success or error surfacing.
    expect(JSON.stringify(result)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("url-encodes an id with reserved characters before hitting the route", async () => {
    // The remote tool's bountyShape allows any non-empty string; a slash or space in an id must not break out
    // of the /v1/bounties/:id/advisory path segment.
    await client.callTool({ name: "loopover_get_bounty_advisory", arguments: { id: "acme/bounty 7" } });
    expect(capturedRequests[0]!.url).toContain("/v1/bounties/acme%2Fbounty%207/advisory");
  });

  it("rejects a missing/empty id at the input-schema boundary, never issuing a request", async () => {
    const result = await client.callTool({ name: "loopover_get_bounty_advisory", arguments: { id: "" } });
    expect(result.isError).toBe(true);
    expect(capturedRequests.length).toBe(0);
  });
});
