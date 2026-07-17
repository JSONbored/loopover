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
  configDir = mkdtempSync(join(tmpdir(), "loopover-automation-state-"));
  capturedRequests = [];
  apiUrl = await startFixtureServer({
    onApiRequest: (request) => {
      if (request.url && request.url.includes("/automation-state")) {
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
  client = new Client({ name: "automation-state-test", version: "0.0.1" });
  await client.connect(transport);
}

async function disconnect() {
  await client.close().catch(() => undefined);
  await closeFixtureServer();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
}

describe("loopover_get_automation_state stdio proxy (#6742)", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("registers the tool in the stdio server tool list", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("loopover_get_automation_state");
  });

  it("proxies the call to /automation-state via apiGet and returns the payload", async () => {
    const result = await client.callTool({
      name: "loopover_get_automation_state",
      arguments: { owner: "owner", repo: "repo" },
    });
    expect(capturedRequests.length).toBe(1);
    const captured = capturedRequests[0]!;
    expect(captured.url).toContain("/v1/repos/owner/repo/automation-state");
    expect(captured.method).toBe("GET");
    expect(result.isError).toBeFalsy();
    const text = JSON.stringify(result);
    expect(text).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
    expect(text).toContain("owner/repo");
    expect(text).toContain("permissionReadiness");
    expect(text).toContain("live");
  });

  it("url-encodes an owner/repo with reserved characters before hitting the route", async () => {
    await client.callTool({ name: "loopover_get_automation_state", arguments: { owner: "acme", repo: "widgets 7" } }).catch(() => undefined);
    expect(capturedRequests[0]?.url).toContain("/v1/repos/acme/widgets%207/automation-state");
  });

  it("rejects a missing owner/repo at the input-schema boundary, never issuing a request", async () => {
    const result = await client.callTool({ name: "loopover_get_automation_state", arguments: { owner: "", repo: "repo" } });
    expect(result.isError).toBe(true);
    expect(capturedRequests.length).toBe(0);
  });

  it("lists the tool via loopover-mcp tools", () => {
    const payload = JSON.parse(run(["tools", "--json"])) as {
      tools: Array<{ name: string; description: string }>;
    };
    const tool = payload.tools.find((entry) => entry.name === "loopover_get_automation_state");
    expect(tool?.description).toMatch(/autonomy levels/i);
    expect(tool?.description.trim().length).toBeGreaterThan(0);
  });
});
