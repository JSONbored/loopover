import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeFixtureServer, run, startFixtureServer } from "./support/mcp-cli-harness";

const bin = join(process.cwd(), "packages/gittensory-mcp/bin/loopover-mcp.js");
const FORBIDDEN_PUBLIC_TERMS = /wallet\s*[:=]\s*\S+|hotkey\s*[:=]\s*\S+|coldkey\s*[:=]\s*\S+|raw trust score is|your trust score|reward estimate is|estimated reward/i;

let client: Client;
let transport: StdioClientTransport;
let configDir: string;
let apiUrl: string;
let capturedRequests: Array<{ url: string; method: string }>;

async function connect() {
  configDir = mkdtempSync(join(tmpdir(), "gittensory-maintainer-noise-"));
  capturedRequests = [];
  apiUrl = await startFixtureServer({
    onApiRequest: (request) => {
      if (request.url && request.url.includes("/maintainer-noise")) {
        capturedRequests.push({ url: request.url ?? "", method: request.method ?? "GET" });
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
  client = new Client({ name: "maintainer-noise-test", version: "0.0.1" });
  await client.connect(transport);
}

async function disconnect() {
  await client.close().catch(() => undefined);
  await closeFixtureServer();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
}

describe("loopover_get_maintainer_noise stdio proxy", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("registers the tool in the stdio server tool list", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("loopover_get_maintainer_noise");
  });

  it("proxies the call to /maintainer-noise via apiGet and returns the payload", async () => {
    const result = await client.callTool({
      name: "loopover_get_maintainer_noise",
      arguments: { owner: "owner", repo: "repo" },
    });
    expect(capturedRequests.length).toBe(1);
    const captured = capturedRequests[0]!;
    expect(captured.url).toContain("/v1/repos/owner/repo/maintainer-noise");
    expect(captured.method).toBe("GET");
    expect(result.isError).toBeFalsy();
    const text = JSON.stringify(result);
    expect(text).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
    expect(text).toContain("owner/repo");
    expect(text).toContain("noiseSources");
    expect(text).toContain("medium");
  });

  it("lists the tool via gittensory-mcp tools", () => {
    const payload = JSON.parse(run(["tools", "--json"])) as {
      tools: Array<{ name: string; description: string }>;
    };
    const tool = payload.tools.find((entry) => entry.name === "loopover_get_maintainer_noise");
    expect(tool?.description).toMatch(/maintainer queue-noise triage report/i);
    expect(tool?.description.trim().length).toBeGreaterThan(0);
  });
});
